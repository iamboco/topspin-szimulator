'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SIM = require('../src/engine.js');
const CLUBSTATS = require('../src/club-statistics.js');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const dataText = process.env.TOPSPIN_DATA_JSON ? fs.readFileSync(process.env.TOPSPIN_DATA_JSON, 'utf8') :
  html.match(/<script type="application\/json" id="app-data">([\s\S]*?)<\/script>/)[1];
function boot() {
  const elements = new Map(), handlers = new Map(), storage = new Map();
  const node = id => {
    if (!elements.has(id)) elements.set(id, {id, hidden: id === 'fatal', innerHTML: '', textContent: '', disabled: false,
      open: false, value: '', dataset: {}, addEventListener() {}, querySelector() {return null;},
      querySelectorAll() {return [];}, setAttribute() {}, removeAttribute() {}, focus() {}, scrollIntoView() {}});
    return elements.get(id);
  };
  node('app-data').textContent = dataText;
  const document = {getElementById: node, activeElement: null, querySelectorAll() {return [];}, querySelector: node,
    addEventListener(name, handler) {handlers.set(name, handler);}, body: {appendChild() {}},
    createElement() {return {click() {}, remove() {}};}};
  let calls = 0;
  const sim = {...SIM, async runFixture(...args) { calls++; return SIM.runFixture(...args); }};
  const context = {document, SIM: sim, CLUBSTATS, console, URL, Blob,
    setTimeout(fn, ms) {const t = setTimeout(fn, ms); t.unref(); return t;}, clearTimeout, setInterval, clearInterval,
    localStorage: {getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k)}};
  context.window = context; context.__topspinEarlyErrors = [];
  context.matchMedia = () => ({matches: false, addEventListener() {}});
  let source = fs.readFileSync(path.join(root, 'src/ui.js'), 'utf8');
  // Expose closure state only in this in-memory test copy, never in production.
  source = source.replace('\ntry{if(state.result)', '\nglobalThis.__ui={state,APP,fixtureRuns,runFixtureSimulation,fixtureRunConfig,fixtureRunKey,currentFixtureRun,restoreFixtureRun,fixtureSavedResult,chooseFixture,validateFixtureResult,resetLocal};\ntry{if(state.result)');
  vm.runInNewContext(source, context);
  assert.equal(node('fatal').hidden, true, node('fatal').innerHTML);
  return {ui: context.__ui, node, context, handlers, calls: () => calls};
}
const clone = x => JSON.parse(JSON.stringify(x));
const setLineup = (ui, side, scenario) => {ui.state.lineups[ui.state.fixtureId][side] = {mode: 'imported', scenario: clone(scenario), manual: null};};

test('UI caches N lineups per fixture and restores A without another Monte Carlo run', async () => {
  const {ui, node, calls} = boot();
  await Promise.resolve();
  ui.state.tab = 'fixtures'; ui.state.n = 1000;
  const season = JSON.stringify(ui.state.result), embedded = JSON.stringify(ui.APP.precomputed);
  await ui.runFixtureSimulation();
  assert.equal(ui.state.error, ''); assert.equal(calls(), 1);
  const f = ui.APP.fixtures.find(f => f.id === ui.state.fixtureId), a = clone(ui.fixtureRunConfig().homeScenario), recordA = ui.currentFixtureRun(f);
  assert.ok(recordA);
  const b = clone(a); [b.paths[0], b.paths[1]] = [b.paths[1], b.paths[0]];
  setLineup(ui, 'home', b);
  assert.equal(ui.currentFixtureRun(f), null);
  assert.match(ui.fixtureSavedResult(f), /eltérő beállítás/);
  await ui.runFixtureSimulation(); assert.equal(calls(), 2);
  const recordB = ui.currentFixtureRun(f);
  assert.ok(recordB && recordB !== recordA);
  setLineup(ui, 'home', a);
  assert.equal(ui.currentFixtureRun(f), recordA);
  await ui.runFixtureSimulation(); assert.equal(calls(), 2);
  assert.match(node('toast').textContent, /gyorsítótárból/);
  ui.restoreFixtureRun(recordB.id);
  assert.equal(ui.currentFixtureRun(f), recordB); assert.equal(calls(), 2);
  assert.equal(JSON.stringify(ui.state.result), season);
  assert.equal(JSON.stringify(ui.APP.precomputed), embedded);
  assert.equal(ui.fixtureRuns.size, 2);
});

test('cache includes model, seed, sample count, form and lineup content, but not other fixtures or horizon', async () => {
  const {ui} = boot(); await Promise.resolve(); ui.state.n = 200;
  await ui.runFixtureSimulation();
  const f = ui.APP.fixtures.find(f => f.id === ui.state.fixtureId), original = ui.currentFixtureRun(f);
  assert.ok(original);
  for (const [field, value] of [['modelId', ui.APP.selected.history], ['seed', '123'], ['n', 1000], ['formMultiplier', 2]]) {
    const saved = ui.state[field]; ui.state[field] = value;
    assert.equal(ui.currentFixtureRun(f), null, field); ui.state[field] = saved;
  }
  ui.state.horizon = ui.state.horizon === 9 ? 18 : 9;
  assert.equal(ui.currentFixtureRun(f), original);
  const another = ui.APP.fixtures.find(x => !x.known && x.id !== f.id);
  ui.state.overrides[another.id] = {home: {invalid: 'unrelated draft'}};
  await ui.runFixtureSimulation();
  assert.equal(ui.state.error, '');
  assert.equal(ui.currentFixtureRun(f), original);
});

test('invalid or failed runs preserve season and previous fixture result', async () => {
  const {ui, context, calls} = boot(); await Promise.resolve(); ui.state.n = 200;
  await ui.runFixtureSimulation();
  const previous = JSON.stringify(ui.state.result), size = ui.fixtureRuns.size;
  ui.state.seed = 'invalid'; await ui.runFixtureSimulation();
  assert.equal(calls(), 1); assert.equal(ui.fixtureRuns.size, size);
  assert.equal(JSON.stringify(ui.state.result), previous);
  ui.state.seed = '123';
  context.SIM.runFixture = async () => {throw new Error('test failure');};
  await ui.runFixtureSimulation();
  assert.match(ui.state.error, /test failure/);
  assert.equal(ui.state.running, false); assert.equal(ui.fixtureRuns.size, size);
  assert.equal(JSON.stringify(ui.state.result), previous);
});

test('changing fixtures does not discard other cached results or season data', async () => {
  const {ui} = boot(); await Promise.resolve(); ui.state.n = 200;
  await ui.runFixtureSimulation();
  const firstId = ui.state.fixtureId, first = ui.currentFixtureRun(ui.APP.fixtures.find(f => f.id === firstId));
  const other = ui.APP.fixtures.find(f => !f.known && f.id !== firstId);
  ui.chooseFixture(other.id); await ui.runFixtureSimulation();
  assert.equal(ui.fixtureRuns.size, 2);
  ui.chooseFixture(firstId);
  assert.equal(ui.currentFixtureRun(ui.APP.fixtures.find(f => f.id === firstId)), first);
  ui.resetLocal(); assert.equal(ui.fixtureRuns.size, 0);
});

test('invalid result shape cannot overwrite a valid match estimate', async () => {
  const {ui} = boot(); await Promise.resolve(); ui.state.n = 100;
  await ui.runFixtureSimulation();
  const r = [...ui.fixtureRuns.values()][0], broken = clone(r.data);
  broken.wdl = [1, 1, 1]; assert.throws(() => ui.validateFixtureResult(broken, r.config));
  const other = clone(r.data); other.runtime.other_fixtures_simulated = 2;
  assert.throws(() => ui.validateFixtureResult(other, r.config));
});

test('official nonnumeric JN preview is rendered as an award, not an invented 3:0', async () => {
  const {ui, node} = boot(); await Promise.resolve();
  const known = ui.APP.fixtures.find(f => f.known && ui.APP.currentGames.some(g => g.match_id === f.id && g.walkover));
  for (const g of ui.APP.currentGames.filter(g => g.match_id === known.id && g.walkover)) {
    g.winner ||= g.home_sets > g.away_sets ? 'home' : 'away'; g.home_sets = null; g.away_sets = null;
  }
  ui.chooseFixture(known.id); await Promise.resolve(); await Promise.resolve();
  assert.equal(ui.state.preview.error, null);
  assert.match(node('fixture-content').innerHTML, /JN\./);
  assert.doesNotMatch(node('fixture-content').innerHTML, /Az előnézet nem érhető el/);
});

test('restoring a genuine historical pattern with a non-roster participant keeps its preview valid', async () => {
  const {ui} = boot(); await Promise.resolve();
  const team = ui.APP.teams.find(t => t.scenarios.some(s => [...s.paths.flat(), ...s.doubles.flat()].some(id => id && !t.roster.includes(id))));
  assert.ok(team);
  const pattern = team.scenarios.find(s => [...s.paths.flat(), ...s.doubles.flat()].some(id => id && !team.roster.includes(id)));
  const fixture = ui.APP.fixtures.find(f => !f.known && (f.home === team.id || f.away === team.id));
  ui.chooseFixture(fixture.id); await Promise.resolve();
  const side = fixture.home === team.id ? 'home' : 'away';
  ui.state.lineups[fixture.id][side] = {mode: 'history', scenarioId: pattern.id, manual: null};
  ui.state.n = 100; await ui.runFixtureSimulation();
  const record = ui.currentFixtureRun(fixture); assert.ok(record, ui.state.error);
  ui.restoreFixtureRun(record.id); await Promise.resolve(); await Promise.resolve();
  assert.equal(ui.state.preview.error, null);
  assert.equal(ui.currentFixtureRun(fixture), record);
});

test('typing a different seed immediately marks the fixture chart stale, before blur', async () => {
  const {ui, node, handlers} = boot(); await Promise.resolve(); ui.state.tab = 'fixtures'; ui.state.n = 100;
  await ui.runFixtureSimulation();
  assert.match(node('fixture-content').innerHTML, /Csak ez a meccs · kiválasztott felállások/);
  const el = node('seed-input'); el.value = String(Number(ui.state.seed) + 1);
  handlers.get('input')({target: el});
  assert.match(node('fixture-content').innerHTML, /Korábbi egymeccses futás · eltérő beállítás/);
});

test('every retained variant is reachable, including more than eight lineups', async () => {
  const {ui, node} = boot(); await Promise.resolve(); ui.state.tab = 'fixtures'; ui.state.n = 50;
  for (let i = 0; i < 9; i++) {ui.state.seed = String(100 + i); await ui.runFixtureSimulation();}
  assert.equal(ui.fixtureRuns.size, 9);
  const first = [...ui.fixtureRuns.values()][0];
  const content = node('fixture-content').innerHTML;
  assert.equal((content.match(/data-restore-fixture-run=/g) || []).length, 9);
  assert.ok(content.includes('data-restore-fixture-run="' + first.id + '"'));
});
