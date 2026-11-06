'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SIM = require('../src/engine.js');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const APP = JSON.parse(process.env.TOPSPIN_DATA_JSON ? fs.readFileSync(process.env.TOPSPIN_DATA_JSON, 'utf8') :
  html.match(/<script type="application\/json" id="app-data">([\s\S]*?)<\/script>/)[1]);
const close = (a, b, tol = 1e-8) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test('released dataset has the complete fresh official league schedule and results', () => {
  assert.equal(APP.meta.season, '2026/2027');
  assert.equal(APP.teams.length, 10); assert.equal(APP.fixtures.length, 90);
  assert.equal(new Set(APP.fixtures.map(f => f.id)).size, 90);
  assert.equal(APP.fixtures.filter(f => f.known).length, 25);
  assert.equal(APP.currentGames.length, 450);
  assert.equal(APP.meta.known_fixtures, 25);
  assert.equal(APP.meta.current_games, 450);
  assert.ok(new Date(APP.meta.snapshot_utc) >= new Date('2026-11-06T00:00:00Z'));
  const teams = new Set(APP.teams.map(t => t.id));
  for (let round = 1; round <= 18; round++) {
    const fixtures = APP.fixtures.filter(f => f.round === round);
    assert.equal(fixtures.length, 5);
    assert.equal(new Set(fixtures.flatMap(f => [f.home, f.away])).size, 10);
  }
  for (const f of APP.fixtures) {assert.ok(teams.has(f.home)); assert.ok(teams.has(f.away));}
  for (const f of APP.fixtures.filter(f => f.round >= 10)) assert.equal(f.date, null, 'TBD must not become a fabricated date');
});

test('450 scorecard rows reconcile to 25 immutable team results', () => {
  const players = new Set(APP.players.map(p => p.id));
  const keys = new Set();
  for (const f of APP.fixtures.filter(f => f.known)) {
    const rows = APP.currentGames.filter(g => g.match_id === f.id);
    assert.equal(rows.length, 18);
    assert.equal(new Set(rows.map(g => g.label)).size, 18);
    assert.equal(rows.filter(g => g.winner === 'home' || !g.winner && g.home_sets > g.away_sets).length, f.home_score);
    assert.equal(rows.filter(g => g.winner === 'away' || !g.winner && g.home_sets < g.away_sets).length, f.away_score);
    for (const g of rows) {
      const key = f.id + ':' + g.label; assert.equal(keys.has(key), false); keys.add(key);
      for (const id of [...g.home_players, ...g.away_players].filter(Boolean)) assert.ok(players.has(id), id);
      if (!g.walkover && !g.awarded) {
        assert.ok(Number.isInteger(g.home_sets)); assert.ok(Number.isInteger(g.away_sets));
        assert.equal(g.sets.length, g.home_sets + g.away_sets);
        for (const [h, a] of g.sets) assert.ok(Math.max(h, a) === 11 && Math.min(h, a) <= 9 || Math.max(h, a) >= 12 && Math.abs(h - a) === 2);
      }
    }
  }
  assert.equal(keys.size, 450);
  assert.equal(APP.currentGames.filter(g => !g.walkover && !g.awarded).length, 434);
});

test('official table exactly matches every published result', () => {
  const records = new Map(APP.teams.map(t => [t.id, {played: 0, won: 0, draw: 0, lost: 0, points: 0, rubbers_for: 0, rubbers_against: 0}]));
  for (const f of APP.fixtures.filter(f => f.known)) {
    for (const [id, own, opp, side] of [[f.home, f.home_score, f.away_score, 'home'], [f.away, f.away_score, f.home_score, 'away']]) {
      const r = records.get(id); r.played++; r.rubbers_for += own; r.rubbers_against += opp;
      if (own > opp) {r.won++; r.points += 3;}
      else if (own === opp) {r.draw++; r.points += 2;}
      else {r.lost++; r.points += f.forfeit_team_id === id ? 0 : 1;}
    }
  }
  assert.equal(APP.currentTable.length, 10);
  for (const row of APP.currentTable) for (const [key, value] of Object.entries(records.get(row.id))) assert.equal(row[key], value, row.id + ':' + key);
});

test('all public lineup samples are valid full team patterns and weights sum to one', () => {
  for (const team of APP.teams) {
    assert.ok(team.scenarios.length > 0);
    close(team.scenarios.reduce((sum, s) => sum + s.weight, 0), 1);
    for (const scenario of team.scenarios) SIM._test.validateScenario(APP, team, scenario, true);
  }
});

test('all six model covariance matrices are valid and all released precomputations are fresh 100k runs', () => {
  assert.equal(Object.keys(APP.models).length, 6);
  for (const [id, model] of Object.entries(APP.models)) {
    const prepared = SIM._test.prepareModel(model);
    SIM._test.cholesky(prepared);
    assert.equal(prepared.through, 5);
    const result = APP.precomputed[id];
    assert.ok(result, id); assert.equal(result.n, 100000); assert.equal(result.runtime.completed, 100000);
    assert.equal(result.modelId, id); assert.equal(result.seed, APP.meta.seed);
    assert.equal(result.data_revision, APP.meta.data_revision);
    for (const f of APP.fixtures.filter(f => f.known)) {
      assert.equal(result.fixtures[f.id].known, true);
      assert.equal(result.fixtures[f.id].score[f.home_score], 1);
    }
    for (const horizon of [9, 18]) {
      const rows = result.horizons[horizon].teams;
      assert.equal(rows.length, 10);
      rows.forEach(t => close(t.positions.reduce((a, b) => a + b, 0), 1));
      for (let rank = 0; rank < 10; rank++) close(rows.reduce((s, t) => s + t.positions[rank], 0), 1);
    }
  }
});

test('deployed inline scripts exactly match reviewed source files', () => {
  for (const [id, file] of [['simulation-engine', 'engine.js'], ['club-statistics', 'club-statistics.js'], ['topspin-ui', 'ui.js']]) {
    const match = html.match(new RegExp('<script id="' + id + '">([\\s\\S]*?)<\\/script>'));
    assert.ok(match); assert.equal(match[1].trim(), fs.readFileSync(path.join(root, 'src', file), 'utf8').trim());
  }
});
