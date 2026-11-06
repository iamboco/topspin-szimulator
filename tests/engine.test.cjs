'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SIM = require('../src/engine.js');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const APP = JSON.parse(process.env.TOPSPIN_DATA_JSON ? fs.readFileSync(process.env.TOPSPIN_DATA_JSON, 'utf8') :
  html.match(/<script type="application\/json" id="app-data">([\s\S]*?)<\/script>/)[1]);
const fixture = APP.fixtures.find(f => !f.known && f.round === 6);
const home = APP.teams.find(t => t.id === fixture.home), away = APP.teams.find(t => t.id === fixture.away);
const clone = x => JSON.parse(JSON.stringify(x));
const scenario = s => ({paths: clone(s.paths), doubles: clone(s.doubles)});
const base = {fixtureId: fixture.id, modelId: APP.selected.current, n: 2000, seed: 20261106,
  formMultiplier: 1, homeScenario: scenario(home.scenarios[0]), awayScenario: scenario(away.scenarios[0])};
const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function checkDistribution(result) {
  for (const [key, size] of [['score', 19], ['away_score', 19], ['joint_score', 361], ['wdl', 3]]) {
    assert.equal(result[key].length, size);
    assert.ok(result[key].every(p => Number.isFinite(p) && p >= 0 && p <= 1));
    close(result[key].reduce((a, b) => a + b, 0), 1);
  }
  const wdl = [0, 0, 0], hm = Array(19).fill(0), am = Array(19).fill(0);
  for (let h = 0; h < 19; h++) for (let a = 0; a < 19; a++) {
    const p = result.joint_score[h * 19 + a];
    if (h + a > 18) assert.equal(p, 0);
    wdl[h > a ? 0 : h === a ? 1 : 2] += p; hm[h] += p; am[a] += p;
  }
  hm.forEach((p, i) => close(p, result.score[i]));
  am.forEach((p, i) => close(p, result.away_score[i]));
  wdl.forEach((p, i) => close(p, result.wdl[i]));
  close(hm.reduce((s, p, i) => s + p * i, 0), result.mean_home);
  close(am.reduce((s, p, i) => s + p * i, 0), result.mean_away);
  assert.equal(result.runtime.other_fixtures_simulated, 0);
  assert.equal(result.runtime.season_recalculated, false);
  assert.deepEqual(result.runtime.evaluated_fixture_ids, [result.fixtureId]);
}

test('one fixture only; unrelated overrides, fixtures, horizon and precomputed data are untouched', async () => {
  const before = JSON.stringify(APP);
  const noisy = {...APP, fixtures: APP.fixtures.concat({id: 'unrelated-invalid-fixture', round: -1})};
  const result = await SIM.runFixture(noisy, {...base, horizon: 9,
    overrides: {'this-must-not-be-compiled': {home: {paths: 'invalid'}}}});
  checkDistribution(result);
  assert.equal(result.runtime.simulated_fixture_count, 1);
  assert.equal(result.runtime.completed, base.n);
  assert.equal(result.runtime.simulated_samples, base.n);
  assert.equal(JSON.stringify(APP), before);
});

test('A → B → A is deterministic and does not mutate public historical lineups', async () => {
  const original = JSON.stringify(home.scenarios);
  const b = clone(base); [b.homeScenario.paths[0], b.homeScenario.paths[1]] = [b.homeScenario.paths[1], b.homeScenario.paths[0]];
  const a1 = await SIM.runFixture(APP, base), b1 = await SIM.runFixture(APP, b), a2 = await SIM.runFixture(APP, base);
  assert.deepEqual(a1, a2);
  checkDistribution(b1);
  assert.notDeepEqual(a1.joint_score, b1.joint_score);
  assert.equal(JSON.stringify(home.scenarios), original);
});

test('all six model families return valid standalone distributions', async () => {
  for (const modelId of Object.keys(APP.models)) {
    checkDistribution(await SIM.runFixture(APP, {...base, modelId, n: 1000}));
  }
});

test('fixture mean agrees with integrated 18-rubber preview; global/day correlations are retained', async () => {
  const prediction = SIM.preview(APP, base.modelId, fixture, base.homeScenario, base.awayScenario, 1);
  const result = await SIM.runFixture(APP, {...base, n: 20000});
  close(result.mean_home, prediction.reduce((sum, r) => sum + r.win, 0), .16);
  // It would be incorrect to convolve 18 independent marginal Bernoullis.
  const independentVariance = prediction.reduce((sum, r) => sum + r.win * (1 - r.win), 0);
  const jointVariance = result.score.reduce((sum, p, h) => sum + p * (h - result.mean_home) ** 2, 0);
  assert.ok(jointVariance > independentVariance * 1.1);
});

test('fixed results are immutable, including known forfeit without numeric score', async () => {
  const known = APP.fixtures.find(f => f.known), result = await SIM.runFixture(APP, {...base, fixtureId: known.id});
  checkDistribution(result);
  assert.equal(result.score[known.home_score], 1);
  assert.equal(result.away_score[known.away_score], 1);
  assert.equal(result.runtime.simulated_samples, 0);
  const fixed = {...fixture, known: false, forfeit_team_id: fixture.home, home_score: null, away_score: null};
  const forfeit = await SIM.runFixture({...APP, fixtures: [fixed]}, {...base, homeScenario: null, awayScenario: null});
  checkDistribution(forfeit);
  assert.equal(forfeit.joint_score[18], 1); // h=0, a=18
  assert.equal(forfeit.wdl[2], 1);
});

test('one-sided and double absences use actual two-sided wins, not 18 minus home', async () => {
  const absent = {paths: Array.from({length: 4}, () => [null, null, null, null]), doubles: [[null, null], [null, null]]};
  const one = await SIM.runFixture(APP, {...base, homeScenario: absent});
  assert.equal(one.mean_home, 0); assert.equal(one.mean_away, 18); assert.equal(one.wdl[2], 1);
  const both = await SIM.runFixture(APP, {...base, homeScenario: absent, awayScenario: absent});
  checkDistribution(both);
  assert.equal(both.joint_score[0], 1); assert.equal(both.wdl[1], 1);
  assert.equal(both.mean_away, 0);
});

test('empirical mixtures, new doubles, substitutions and horizon-independent future fixtures', async () => {
  checkDistribution(await SIM.runFixture(APP, {...base, homeScenario: null, awayScenario: null}));
  const custom = clone(base.homeScenario), roster = home.roster;
  if (roster.length >= 4) custom.doubles = [[roster[0], roster[2]], [roster[1], roster[3]]];
  checkDistribution(await SIM.runFixture(APP, {...base, homeScenario: custom}));
  const future = APP.fixtures.find(f => !f.known && f.round === 18);
  const opts = {...base, fixtureId: future.id, homeScenario: null, awayScenario: null};
  const first = await SIM.runFixture(APP, {...opts, horizon: 9}), second = await SIM.runFixture(APP, {...opts, horizon: 18});
  assert.deepEqual(first, second);
  const zeroForm = await SIM.runFixture(APP, {...base, formMultiplier: 0});
  checkDistribution(zeroForm);
  assert.ok(zeroForm.score.filter(p => p > 0).length > 2);
});

test('invalid inputs fail rather than silently changing the sample count or roster', async () => {
  await assert.rejects(SIM.runFixture(APP, {...base, n: 100001}));
  await assert.rejects(SIM.runFixture(APP, {...base, fixtureId: 'missing'}));
  await assert.rejects(SIM.runFixture(APP, {...base, formMultiplier: -1}));
  const invalid = clone(base.homeScenario); invalid.paths[0][0] = 'not-in-public-roster';
  await assert.rejects(SIM.runFixture(APP, {...base, homeScenario: invalid}));
  const duplicate = clone(base.homeScenario); duplicate.paths[1] = duplicate.paths[0].slice();
  await assert.rejects(SIM.runFixture(APP, {...base, homeScenario: duplicate}));
});

test('Blob worker executes the same code as the yielding fallback', async () => {
  const nodeVm = require('node:vm');
  const blobs = new Map(); let counter = 0;
  class FakeBlob { constructor(parts) { this.source = parts.join(''); } }
  class FakeWorker {
    constructor(url) { this.scope = {setTimeout, clearTimeout, performance, console};
      this.scope.self = {postMessage: data => queueMicrotask(() => this.onmessage?.({data}))};
      vm.createContext(this.scope); vm.runInContext(blobs.get(url).source, this.scope); }
    postMessage(data) { queueMicrotask(() => this.scope.self.onmessage({data})); }
    terminate() {}
  }
  const context = {module: {exports: {}}, console, setTimeout, clearTimeout, performance,
    Worker: FakeWorker, Blob: FakeBlob, URL: {createObjectURL(blob) { const id = 'blob:' + ++counter; blobs.set(id, blob); return id; }, revokeObjectURL(url) { blobs.delete(url); }}};
  nodeVm.runInNewContext(fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8'), context);
  const worker = await context.module.exports.runFixture(APP, base), fallback = await SIM.runFixture(APP, base);
  assert.equal(worker.runtime.execution, 'blob_worker');
  for (const field of ['score', 'away_score', 'joint_score', 'wdl', 'mean_home', 'mean_away']) assert.deepEqual(clone(worker[field]), fallback[field]);
  assert.equal(blobs.size, 0);
});

test('blocked Blob worker uses the same deterministic fallback', async () => {
  const context = {module: {exports: {}}, console, setTimeout, clearTimeout, performance,
    Worker: class {constructor() {throw new Error('blocked');}}, Blob: class {}, URL: {createObjectURL() {return 'blob:test';}, revokeObjectURL() {}}};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8'), context);
  const blocked = await context.module.exports.runFixture(APP, base), fallback = await SIM.runFixture(APP, base);
  assert.equal(blocked.runtime.execution, 'yielding_fallback');
  assert.deepEqual(clone(blocked.score), fallback.score);
});

test('full season API remains deterministic and fixes every recorded game', async () => {
  const opts = {modelId: base.modelId, n: 100, seed: base.seed, horizon: 18};
  const first = await SIM.run(APP, opts), second = await SIM.run(APP, opts);
  assert.deepEqual(first, second);
  for (const known of APP.fixtures.filter(f => f.known)) assert.equal(first.fixtures[known.id].score[known.home_score], 1);
  for (const horizon of [9, 18]) for (const team of first.horizons[horizon].teams) close(team.positions.reduce((a, b) => a + b, 0), 1);
});

test('official nonnumeric JN rows stay fixed without inventing a numeric set result', () => {
  const known = APP.fixtures.find(f => f.known && APP.currentGames.some(g => g.match_id === f.id && g.walkover));
  const currentGames = APP.currentGames.map(g => g.match_id === known.id && g.walkover ? {...g,
    winner: g.winner || (g.home_sets > g.away_sets ? 'home' : 'away'), home_sets: null, away_sets: null} : g);
  const rows = SIM.preview({...APP, currentGames}, base.modelId, known);
  assert.equal(rows.length, 18);
  for (const row of rows.filter(r => r.numericScoreUnknown)) {
    assert.equal(row.fixed, true); assert.equal(row.awarded, true);
    assert.deepEqual(row.sets, []); assert.deepEqual(row.six, [0, 0, 0, 0, 0, 0]);
    assert.ok(row.win === 0 || row.win === 1);
  }
  const withoutMetrics = {...known}; delete withoutMetrics.known_metrics;
  const metrics = SIM._test.knownMetrics(withoutMetrics, currentGames.filter(g => g.match_id === known.id));
  assert.equal(metrics.setMissing, true); assert.equal(metrics.rallyMissing, true);
});
