/* Pattogó numerical runtime. No network, dependencies, or precomputed-result reuse.
 * Browser: globalThis.SIM. Node (tests): require('./engine.js').
 * Inference is joint MAP / full-covariance Laplace Gaussian, NOT MCMC.
 */
(function (root) {
  'use strict';

  /* This factory is deliberately self-contained: its source is the Blob worker. */
  function createRuntime() {
    'use strict';
    const HOME_SETS = [3, 3, 3, 2, 1, 0, 0];
    const AWAY_SETS = [0, 1, 2, 3, 3, 3, 0];
    const ORDER = [[0, 0], [1, 1], [2, 2], [3, 3],
      [0, 1], [1, 2], [2, 3], [3, 0], [0, 2], [1, 3], [2, 0], [3, 1],
      [0, 3], [1, 0], [2, 1], [3, 2]];
    const HSLOTS = ['A', 'B', 'C', 'D'];
    const ASLOTS = ['V', 'X', 'Y', 'Z'];
    const FLAG_LABELS = {
      1: 'unresolved_sporting_tie',
      2: 'head_to_head_data_missing_or_unplayed',
      4: 'missing_real_rallies_prevent_final_criterion',
      8: 'equal_share_uniform_permutation_assumption',
      16: 'missing_recorded_sets_prevent_set_criterion'
    };
    const GX = [-8.717597678399589, -7.656037955393074, -6.767464963809717,
      -5.966014690606702, -5.218848093644279, -4.508929922967286,
      -3.8259005699724917, -3.1627756793881927, -2.514473303952206,
      -1.8770583699478387, -1.2473119756167892, -0.6224622791860761, 0,
      0.6224622791860761, 1.2473119756167892, 1.8770583699478387,
      2.514473303952206, 3.1627756793881927, 3.8259005699724917,
      4.508929922967286, 5.218848093644279, 5.966014690606702,
      6.767464963809717, 7.656037955393074, 8.717597678399589];
    const GW = [1.5300389979986902e-17, 7.102103037003995e-14,
      3.791150000477195e-11, 5.738023868899384e-9, 3.5301525602455026e-7,
      0.000010672194905202533, 0.0001777669069265264, 0.0017578504052637922,
      0.010856755991462306, 0.043379970167645054, 0.11488092430395157,
      0.20485102565034038, 0.24816935117648545, 0.20485102565034038,
      0.11488092430395157, 0.043379970167645054, 0.010856755991462306,
      0.0017578504052637922, 0.0001777669069265264, 0.000010672194905202533,
      3.5301525602455026e-7, 5.738023868899384e-9, 3.791150000477195e-11,
      7.102103037003995e-14, 1.5300389979986902e-17];
    const CHOOSE = [1, 11, 66, 286, 1001, 3003, 8008, 19448, 43758, 92378];
    const modelCache = new WeakMap();
    const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const pause = () => new Promise(resolve => setTimeout(resolve, 0));
    const now = () => typeof performance !== 'undefined' ? performance.now() : Date.now();
    const pairKey = ids => ids.slice().sort().join('|');
    const sigmoid = z => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
    function finite(value, name) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(name + ': véges szám szükséges.');
      return value;
    }
    function nonnegative(value, name, fallback) {
      if (value == null && fallback != null) value = fallback;
      finite(value, name);
      if (value < 0) throw new Error(name + ': nem lehet negatív.');
      return value;
    }
    function count(value, name) {
      finite(value, name);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(name + ': nemnegatív egész szükséges.');
      return value;
    }
    function hashSeed(value) {
      if (typeof value === 'number') {
        finite(value, 'seed');
        if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) return value >>> 0;
      } else if (typeof value !== 'string') throw new Error('seed: szám vagy szöveg szükséges.');
      const text = String(value);
      let h = 2166136261;
      for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
      return h >>> 0;
    }
    function mix32(x) {
      x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
      x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
      return (x ^ (x >>> 15)) >>> 0;
    }
    function makeRng(seed) {
      // xoshiro128**: long state period matters for 100k whole seasons. Using
      // independent hashed 32-bit starting points of a 32-bit-period generator
      // would risk overlapping per-season streams after hundreds of millions
      // of variates. All four state words are deterministically seeded here.
      let a = mix32(seed ^ 0x9e3779b9), b = mix32(seed ^ 0x243f6a88);
      let c = mix32(seed ^ 0xb7e15162), d = mix32(seed ^ 0x8aed2a6b), spare = null;
      if (!(a | b | c | d)) d = 1;
      function uniform() {
        const x = Math.imul(b, 5), result = Math.imul((x << 7) | (x >>> 25), 9) >>> 0;
        const t = b << 9;
        c ^= a; d ^= b; b ^= c; a ^= d; c ^= t;
        d = (d << 11) | (d >>> 21);
        return (result + 0.5) / 4294967296;
      }
      function normal() {
        if (spare !== null) { const z = spare; spare = null; return z; }
        const r = Math.sqrt(-2 * Math.log(uniform())), a = 2 * Math.PI * uniform();
        spare = r * Math.sin(a);
        return r * Math.cos(a);
      }
      return {uniform, normal};
    }

    // Exact stopped first-to-11, win-by-two formula from models.py (no 11-point cap).
    // Symmetry and Horner evaluation avoid cancellation and repeated powers.
    function setFromPointRaw(p) {
      p = Math.min(1 - 1e-9, Math.max(1e-9, p));
      if (p > 0.5) return 1 - setFromPointRaw(1 - p);
      const r = 1 - p;
      let poly = CHOOSE[9];
      for (let k = 8; k >= 0; k--) poly = poly * r + CHOOSE[k];
      const p2 = p * p, p4 = p2 * p2, p8 = p4 * p4;
      const pr = p * r, pr2 = pr * pr, pr4 = pr2 * pr2, pr8 = pr4 * pr4;
      return p8 * p2 * p * poly + 184756 * pr8 * pr2 * p2 / (p2 + r * r);
    }
    function setFromPoint(p) {
      return Math.min(1 - 1e-12, Math.max(1e-12, setFromPointRaw(p)));
    }
    function pointFromSet(q) {
      q = Math.min(1 - 1e-12, Math.max(1e-12, q));
      if (q === 0.5) return 0.5;
      if (q > 0.5) return 1 - pointFromSet(1 - q);
      let lo = 0, hi = 0.5;
      for (let i = 0; i < 48; i++) {
        const mid = (lo + hi) * 0.5;
        if (setFromPointRaw(mid) < q) lo = mid; else hi = mid;
      }
      return (lo + hi) * 0.5;
    }
    function sixProbs(q) {
      const r = 1 - q, q3 = q * q * q, r3 = r * r * r;
      return [q3, 3 * q3 * r, 6 * q3 * r * r,
        6 * r3 * q * q, 3 * r3 * q, r3];
    }
    function drawCategory(q, u) {
      const r = 1 - q, q3 = q * q * q, r3 = r * r * r;
      let c = q3;
      if (u < c) return 0;
      c += 3 * q3 * r; if (u < c) return 1;
      c += 6 * q3 * r * r; if (u < c) return 2;
      c += 6 * r3 * q * q; if (u < c) return 3;
      c += 3 * r3 * q; return u < c ? 4 : 5;
    }
    function normalizeSix(six) {
      let sum = 0;
      for (let i = 0; i < 6; i++) { six[i] = Math.max(0, six[i]); sum += six[i]; }
      for (let i = 0; i < 6; i++) six[i] /= sum;
      return six;
    }
    // GH25 agrees with the Python prediction rule in its well-resolved range.
    // Wide Gaussian / steep point-model integrands use adaptive vector Simpson,
    // absolute tolerance 2e-10 over N(0,1) on [-10,10] (tail < 2e-23).
    function marginalSix(mean, variance, family) {
      if (variance < 1e-18) return sixProbs(family === 'set' ? sigmoid(mean) : setFromPoint(sigmoid(mean)));
      const sd = Math.sqrt(variance);
      if (variance <= (family === 'set' ? 0.85 : 0.035)) {
        const result = [0, 0, 0, 0, 0, 0];
        for (let k = 0; k < 25; k++) {
          const p = sigmoid(mean + sd * GX[k]);
          const s = sixProbs(family === 'set' ? p : setFromPoint(p));
          for (let c = 0; c < 6; c++) result[c] += GW[k] * s[c];
        }
        return normalizeSix(result);
      }
      function value(x) {
        const p = sigmoid(mean + sd * x), s = sixProbs(family === 'set' ? p : setFromPoint(p));
        const weight = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
        return s.map(y => y * weight);
      }
      function simpson(a, b, fa, fm, fb) {
        const h = (b - a) / 6;
        return fa.map((v, i) => h * (v + 4 * fm[i] + fb[i]));
      }
      function integrate(a, b, fa, fm, fb, whole, tolerance, depth) {
        const m = (a + b) / 2, fl = value((a + m) / 2), fr = value((m + b) / 2);
        const left = simpson(a, m, fa, fl, fm), right = simpson(m, b, fm, fr, fb);
        let error = 0;
        for (let i = 0; i < 6; i++) error = Math.max(error, Math.abs(left[i] + right[i] - whole[i]));
        if (depth <= 0 || error <= 15 * tolerance) {
          return left.map((v, i) => v + right[i] + (v + right[i] - whole[i]) / 15);
        }
        const l = integrate(a, m, fa, fl, fm, left, tolerance / 2, depth - 1);
        const r = integrate(m, b, fm, fr, fb, right, tolerance / 2, depth - 1);
        return l.map((v, i) => v + r[i]);
      }
      const a = value(-10), m = value(0), b = value(10);
      return normalizeSix(integrate(-10, 10, a, m, b, simpson(-10, 10, a, m, b), 2e-10, 22));
    }

    function prepareModel(model) {
      if (!model || typeof model !== 'object') throw new Error('Hiányzó modell.');
      if (modelCache.has(model)) return modelCache.get(model);
      const cfg = model.config || {};
      if (cfg.family !== 'set' && cfg.family !== 'point') throw new Error('Ismeretlen modellcsalád: ' + cfg.family);
      if (!Array.isArray(model.players) || !Array.isArray(model.pairs) || !model.mu) throw new Error('Hiányos modellparaméterek.');
      const P = model.players.length, D = P + model.pairs.length + 1;
      if (model.mu.length !== D) throw new Error('A mu dimenziója nem players + pairs + home.');
      const players = new Map(), pairs = new Map();
      model.players.forEach((id, i) => {
        if (players.has(id)) throw new Error('Duplikált modelljátékos: ' + id);
        players.set(id, i);
      });
      model.pairs.forEach((id, i) => {
        if (pairs.has(id)) throw new Error('Duplikált párosparaméter: ' + id);
        pairs.set(id, P + i);
      });
      const mu = Float64Array.from(model.mu, (x) => finite(x, 'mu'));
      const cov = new Float64Array(D * D), warnings = [];
      if (model.cov != null) {
        if (model.cov.length !== D) throw new Error('Hibás kovarianciamátrix-méret.');
        for (let i = 0; i < D; i++) {
          if (!model.cov[i] || model.cov[i].length !== D) throw new Error('Hibás kovarianciamátrix-sor.');
        }
        for (let i = 0; i < D; i++) for (let j = 0; j <= i; j++) {
          const a = finite(model.cov[i][j], 'cov'), b = finite(model.cov[j][i], 'cov');
          if (Math.abs(a - b) > 1e-7 * Math.max(1, Math.abs(a), Math.abs(b))) {
            throw new Error('A teljes kovarianciamátrix nem szimmetrikus.');
          }
          cov[i * D + j] = cov[j * D + i] = (a + b) / 2;
        }
      } else warnings.push('A modell nem tartalmaz kovarianciát: a globális paraméterek rögzítettek.');
      const out = {model, D, P, players, pairs, mu, cov, warnings,
        family: cfg.family,
        day: nonnegative(cfg.day_sd, 'day_sd', 0),
        rubber: nonnegative(cfg.rubber_sd, 'rubber_sd', 0),
        drift: nonnegative(cfg.drift_sd, 'drift_sd', 0),
        pair: nonnegative(cfg.pair_sd, 'pair_sd', 0),
        tau: nonnegative(cfg.tau, 'tau', cfg.family === 'set' ? 1.35 : 0.38),
        through: count(model.fit && model.fit.through_round != null ? model.fit.through_round : 5, 'through_round')};
      modelCache.set(model, out);
      return out;
    }
    function cholesky(m) {
      const D = m.D, L = new Float64Array(D * D);
      for (let i = 0; i < D; i++) for (let j = 0; j <= i; j++) {
        let v = m.cov[i * D + j];
        for (let k = 0; k < j; k++) v -= L[i * D + k] * L[j * D + k];
        if (i === j) {
          if (v < -1e-9) throw new Error('A teljes kovariancia nem pozitív szemidefinit.');
          if (v < 0 && !m.warnings.includes('Kerekítési negatív Cholesky-pivot nullára igazítva.')) {
            m.warnings.push('Kerekítési negatív Cholesky-pivot nullára igazítva.');
          }
          L[i * D + j] = Math.sqrt(Math.max(0, v));
        } else if (L[j * D + j] > 0) L[i * D + j] = v / L[j * D + j];
        else if (Math.abs(v) > 1e-9) throw new Error('Szinguláris, inkonzisztens teljes kovariancia.');
      }
      return L;
    }
    function validateRubberPlayers(homePlayers, awayPlayers) {
      if (!Array.isArray(homePlayers) || !Array.isArray(awayPlayers)) throw new Error('Játékoslisták szükségesek.');
      const n = Math.max(homePlayers.length, awayPlayers.length);
      if (n < 1 || n > 2 || (homePlayers.length !== n && homePlayers.length !== 0) ||
          (awayPlayers.length !== n && awayPlayers.length !== 0)) throw new Error('Egyénihez 1, pároshoz 2 játékos tartozik.');
      const all = homePlayers.concat(awayPlayers).filter(id => id != null);
      if (all.some(id => typeof id !== 'string') || new Set(all).size !== all.length) {
        throw new Error('Érvénytelen vagy duplikált játékos egy részmeccsben.');
      }
      return {n, h: homePlayers.length === n && homePlayers.every(id => id != null),
        a: awayPlayers.length === n && awayPlayers.every(id => id != null)};
    }
    function awardedPrediction(h, a) {
      const six = [0, 0, 0, 0, 0, 0];
      if (h && !a) six[0] = 1;
      if (a && !h) six[5] = 1;
      const win = h && !a ? 1 : 0;
      return {six, win, mean_eta: null, predictive_eta_var: 0, global_eta_var: 0,
        strength_win90: [win, win], awarded: true, void: !h && !a,
        sets: h && !a ? [3, 0] : a && !h ? [0, 3] : [0, 0],
        approximation: !h && !a ? ['Kettős hiányzás: egyik félnek sincs részgyőzelem; nem hatkimenetelű lejátszott mérkőzés.'] : [],
        sources: ['APP scenario: null means absent, never an unknown-strength substitute']};
    }
    function predict(model, homePlayers, awayPlayers, round, formMultiplier) {
      const availability = validateRubberPlayers(homePlayers, awayPlayers);
      if (!availability.h || !availability.a) return awardedPrediction(availability.h, availability.a);
      const m = prepareModel(model);
      round = round == null ? 5 : count(round, 'round');
      const fm = nonnegative(formMultiplier, 'formMultiplier', 1), design = new Map();
      let extraGlobal = 0;
      function add(i, v) { design.set(i, (design.get(i) || 0) + v); }
      for (const [sign, ids] of [[1, homePlayers], [-1, awayPlayers]]) {
        const coef = sign / ids.length;
        for (const id of ids) {
          if (m.players.has(id)) add(m.players.get(id), coef);
          else extraGlobal += m.tau * m.tau / (ids.length * ids.length);
        }
        if (ids.length === 2) {
          const key = pairKey(ids);
          if (m.pairs.has(key)) add(m.pairs.get(key), sign);
          else extraGlobal += m.pair * m.pair;
        }
      }
      add(m.D - 1, 1);
      let mean = 0, gv = extraGlobal;
      const terms = Array.from(design);
      for (const [i, a] of terms) {
        mean += a * m.mu[i];
        for (const [j, b] of terms) gv += a * b * m.cov[i * m.D + j];
      }
      if (gv < -1e-8) throw new Error('Negatív prediktív globális variancia.');
      gv = Math.max(0, gv);
      const sizes = 1 / homePlayers.length + 1 / awayPlayers.length;
      const day = m.day * m.day * fm * fm * sizes;
      const rubber = m.rubber * m.rubber * fm * fm;
      const drift = m.drift * m.drift * Math.max(0, round - m.through) * sizes;
      const noise = day + rubber + drift, variance = gv + noise;
      const six = marginalSix(mean, variance, m.family);
      const offset = 1.6448536269514722 * Math.sqrt(gv);
      const lo = marginalSix(mean - offset, noise, m.family), hi = marginalSix(mean + offset, noise, m.family);
      return {six, win: six[0] + six[1] + six[2], mean_eta: mean,
        predictive_eta_var: variance, global_eta_var: gv, day_eta_var: day,
        rubber_eta_var: rubber, drift_eta_var: drift,
        strength_win90: [lo[0] + lo[1] + lo[2], hi[0] + hi[1] + hi[2]],
        integration: variance <= (m.family === 'set' ? 0.85 : 0.035) ? 'Gauss-Hermite-25' : 'adaptive-normal-Simpson-2e-10',
        approximation: ['Joint MAP / Fisher-Laplace Gaussian marginal; not MCMC.'].concat(m.warnings),
        sources: ['scripts/model_refit.py + src/engine.js: likelihood, stopped11winby2, six_probs; full global covariance']};
    }

    function currentGames(app) {
      return app.currentGames || app.current_games || (app.knownData && app.knownData.currentGames) || [];
    }
    function resolveScenario(team, scenario) {
      if (typeof scenario === 'string') {
        const found = (team.scenarios || []).find(s => s.id === scenario);
        if (!found) throw new Error('Ismeretlen felállás: ' + scenario);
        return found;
      }
      if (scenario == null) {
        const choices = (team.scenarios || []).filter(s => s.weight == null || s.weight > 0);
        if (!choices.length) throw new Error('Nincs empirikus csapatfelállás: ' + team.name);
        return choices.reduce((a, b) => (a.weight || 1) >= (b.weight || 1) ? a : b);
      }
      return scenario;
    }
    function isEmpiricalScenario(team, value) {
      return value == null || typeof value === 'string' || (team.scenarios || []).some(s =>
        JSON.stringify([s.paths, s.doubles]) === JSON.stringify([value.paths, value.doubles]));
    }
    function validateScenario(app, team, value, empirical) {
      const s = resolveScenario(team, value);
      if (!s || !Array.isArray(s.paths) || s.paths.length !== 4 ||
          s.paths.some(path => !Array.isArray(path) || path.length !== 4)) {
        throw new Error('A felállás paths mezője 4 × 4 játékos/null mátrix legyen (' + team.name + ').');
      }
      if (!Array.isArray(s.doubles) || s.doubles.length !== 2 ||
          s.doubles.some(pair => !Array.isArray(pair) || pair.length !== 2)) {
        throw new Error('Két, egyenként kétszereplős páros szükséges (' + team.name + ').');
      }
      const allowed = new Set(team.roster || []);
      // A historical empirical whole-lineup is public evidence of having played,
      // not a new assertion of present transfer/registration eligibility. Manual
      // selections are ALWAYS restricted to the team's public roster.
      if (empirical) {
        for (const g of currentGames(app)) for (const side of ['home', 'away']) {
          const fixture = g[side + '_team'] == null ? (app.fixtures || []).find(f => f.id === g.match_id) : null;
          if ((g[side + '_team'] || (fixture && fixture[side])) === team.id) {
            for (const id of g[side + '_players'] || []) allowed.add(id);
          }
        }
        for (const p of app.players || []) if ((p.teams || []).includes(team.id)) allowed.add(p.id);
      }
      function check(id) {
        if (id != null && (typeof id !== 'string' || !allowed.has(id))) {
          throw new Error('A játékos nem szerepel a nyilvános csapatkeretben: ' + id + ' (' + team.name + ').');
        }
      }
      let substitutions = 0;
      const initial = s.paths.map(p => p[0]).filter(id => id != null);
      if (new Set(initial).size !== initial.length) throw new Error('Duplikált egyéni kezdőjátékos.');
      for (let slot = 0; slot < 4; slot++) {
        const path = s.paths[slot];
        path.forEach(check);
        for (let k = 1; k < 4; k++) if (path[k] !== path[k - 1]) {
          substitutions++;
          if (path[k] != null && initial.includes(path[k])) throw new Error('Kezdőjátékos nem cserélhet másik egyéni helyre.');
        }
      }
      if (substitutions > 1) throw new Error('Csapatonként legfeljebb egy egyéni csere engedélyezett.');
      for (let k = 0; k < 4; k++) {
        const ids = s.paths.map(path => path[k]).filter(id => id != null);
        if (new Set(ids).size !== ids.length) throw new Error('Duplikált egyéni játékos ugyanabban a körben.');
      }
      const ds = [].concat(s.doubles[0], s.doubles[1]); ds.forEach(check);
      const present = ds.filter(id => id != null);
      if (new Set(present).size !== present.length) throw new Error('A négy pároshelyen négy különböző játékos szükséges.');
      return s;
    }
    function rubberRows(home, away) {
      const out = [], hc = [0, 0, 0, 0], ac = [0, 0, 0, 0];
      for (let i = 0; i < 2; i++) out.push({label: 'P' + (i + 1), type: 'doubles',
        homePlayers: home.doubles[i].slice(), awayPlayers: away.doubles[i].slice(),
        homeSlot: null, awaySlot: null, homeAppearance: null, awayAppearance: null});
      for (let i = 0; i < ORDER.length; i++) {
        const h = ORDER[i][0], a = ORDER[i][1], hApp = hc[h]++, aApp = ac[a]++;
        out.push({label: 'E' + (i + 1), type: 'singles',
          homePlayers: [home.paths[h][hApp]], awayPlayers: [away.paths[a][aApp]],
          homeSlot: HSLOTS[h], awaySlot: ASLOTS[a], homeAppearance: hApp + 1, awayAppearance: aApp + 1,
          slotLabel: HSLOTS[h] + (hApp + 1) + '–' + ASLOTS[a] + (aApp + 1)});
      }
      return out;
    }
    function isKnown(f) {
      // An explicitly recorded team forfeit is a fixed award even if a feed
      // has not populated its numeric score / generic known flag yet.
      if (f.forfeit_team_id === f.home || f.forfeit_team_id === f.away) return true;
      if (f.known != null) return !!f.known;
      return f.home_score != null && f.away_score != null;
    }
    function fixedGamePrediction(g) {
      // The current official feed writes JN. instead of a numeric set score.
      // Its explicit winner is a fixed award, not a played 3:0 observation.
      if (g.home_sets == null || g.away_sets == null) {
        if (!(g.walkover || g.awarded) || !['home', 'away', 'none'].includes(g.winner)) {
          throw new Error('Hiányzó rögzített szetteredmény / JN-nyertes: ' + (g.key || g.label));
        }
        const win = g.winner === 'home' ? 1 : 0;
        return {six: [0, 0, 0, 0, 0, 0], win, mean_eta: null, predictive_eta_var: 0,
          strength_win90: [win, win], fixed: true, awarded: true, void: g.winner === 'none',
          numericScoreUnknown: true, winner: g.winner, sets: [], rallies: [],
          approximation: ['Hivatalos JN-eredmény: megítélt nyertes, nem számszerű lejátszott szetteredmény.'],
          sources: ['APP.currentGames: immutable official JN winner; no invented set score']};
      }
      const h = count(g.home_sets, 'home_sets'), a = count(g.away_sets, 'away_sets');
      const six = [0, 0, 0, 0, 0, 0];
      let category = -1;
      if (h === 3 && a < 3) category = a;
      else if (a === 3 && h < 3) category = 5 - h;
      if (category >= 0) six[category] = 1;
      const win = h > a ? 1 : 0;
      return {six, win, mean_eta: null, predictive_eta_var: 0, strength_win90: [win, win],
        fixed: true, awarded: !!g.walkover, void: h === 0 && a === 0,
        sets: [h, a], rallies: g.sets || [], approximation: [], sources: ['APP.currentGames: immutable recorded result']};
    }
    function preview(app, modelId, fixture, homeScenario, awayScenario, formMultiplier) {
      if (typeof fixture === 'string') fixture = (app.fixtures || []).find(f => f.id === fixture);
      if (!fixture) throw new Error('Ismeretlen csapattalálkozó.');
      const teams = new Map((app.teams || []).map(t => [t.id, t]));
      const ht = teams.get(fixture.home), at = teams.get(fixture.away);
      if (!ht || !at || !app.models || !app.models[modelId]) throw new Error('Hiányzó csapat vagy modell.');
      const recorded = isKnown(fixture) ? currentGames(app).filter(g => g.match_id === fixture.id) : [];
      if (recorded.length === 18) {
        const map = new Map(recorded.map(g => [g.label, g]));
        return ['P1', 'P2'].concat(ORDER.map((_, i) => 'E' + (i + 1))).map(label => {
          const g = map.get(label);
          if (!g) throw new Error('Hiányzó rögzített részmeccscímke: ' + label);
          const row = {label, type: g.type, homePlayers: (g.home_players || []).slice(),
            awayPlayers: (g.away_players || []).slice()};
          if (g.type === 'singles') {
            const k = Number(label.slice(1)) - 1;
            row.homeSlot = HSLOTS[ORDER[k][0]]; row.awaySlot = ASLOTS[ORDER[k][1]];
            row.homeAppearance = Math.floor(k / 4) + 1; row.awayAppearance = Math.floor(k / 4) + 1;
          }
          return Object.assign(row, fixedGamePrediction(g));
        });
      }
      const hs = validateScenario(app, ht, homeScenario, isEmpiricalScenario(ht, homeScenario));
      const as = validateScenario(app, at, awayScenario, isEmpiricalScenario(at, awayScenario));
      return rubberRows(hs, as).map(row => Object.assign(row,
        predict(app.models[modelId], row.homePlayers, row.awayPlayers, fixture.round, formMultiplier),
        {knownTeamResult: isKnown(fixture), fixed: false}));
    }

    // ranking.py port. Counts for ten teams are safely below 2^53; no floating
    // division is used for ratios. Every separated tied subgroup restarts at H2H
    // points. Random keys are consulted ONLY for a finally unresolved subgroup.
    function ratioCompare(an, ad, bn, bd) {
      if (ad === 0) return bd === 0 ? 0 : 1;
      if (bd === 0) return -1;
      const left = an * bd, right = bn * ad;
      return left > right ? 1 : left < right ? -1 : 0;
    }
    function rankOne(points, h2h, rubbers, sets, rallies, keys, missing, ensureRallies, setMissing) {
      const T = points.length, order = Array.from({length: T}, (_, i) => i);
      const nums = new Float64Array(T), dens = new Float64Array(T), stack = [];
      order.sort((a, b) => points[b] - points[a] || a - b);
      for (let start = 0; start < T;) {
        let stop = start + 1;
        while (stop < T && points[order[start]] === points[order[stop]]) stop++;
        if (stop - start > 1) stack.push([start, stop]);
        start = stop;
      }
      let flags = 0;
      const matrices = [h2h, rubbers, sets, rallies];
      while (stack.length) {
        const segment = stack.pop(), start = segment[0], stop = segment[1];
        let empty = true, split = false;
        for (let p = start; p < stop; p++) for (let q = p + 1; q < stop; q++) {
          const i = order[p], j = order[q], ij = i * T + j, ji = j * T + i;
          const pairEmpty = matrices.every(m => m[ij] === 0 && m[ji] === 0);
          if (pairEmpty) flags |= 2; else empty = false;
        }
        if (!empty) for (let criterion = 0; criterion < 4; criterion++) {
          if (criterion === 2 || criterion === 3) {
            const mask = criterion === 3 ? missing : setMissing;
            let hasMissing = false;
            if (mask) for (let p = start; p < stop; p++) for (let q = p + 1; q < stop; q++) {
              const i = order[p], j = order[q];
              if (mask[i * T + j] || mask[j * T + i]) hasMissing = true;
            }
            if (hasMissing) { flags |= criterion === 3 ? 4 : 16; break; }
            if (criterion === 3 && ensureRallies && ensureRallies(order.slice(start, stop)) === false) {
              flags |= 4; break;
            }
          }
          const matrix = matrices[criterion];
          let undefinedRatio = false;
          for (let p = start; p < stop; p++) {
            const i = order[p]; let won = 0, lost = 0;
            for (let q = start; q < stop; q++) {
              const j = order[q];
              if (i !== j) { won += matrix[i * T + j]; if (criterion) lost += matrix[j * T + i]; }
            }
            nums[i] = won; dens[i] = lost;
            if (criterion && won === 0 && lost === 0) undefinedRatio = true;
          }
          if (undefinedRatio) continue;
          const compare = criterion === 0 ? ((a, b) => Math.sign(nums[a] - nums[b])) :
            ((a, b) => ratioCompare(nums[a], dens[a], nums[b], dens[b]));
          for (let p = start + 1; p < stop; p++) {
            const team = order[p]; let q = p;
            while (q > start && compare(team, order[q - 1]) > 0) { order[q] = order[q - 1]; q--; }
            order[q] = team;
          }
          if (compare(order[start], order[stop - 1]) === 0) continue;
          split = true;
          for (let child = start; child < stop;) {
            let end = child + 1;
            while (end < stop && compare(order[child], order[end]) === 0) end++;
            if (end - child > 1) stack.push([child, end]);
            child = end;
          }
          break;
        }
        if (!split) {
          flags |= 1; if (stop - start >= 3) flags |= 8;
          const final = order.slice(start, stop).sort((a, b) => keys[a] - keys[b] || a - b);
          for (let p = start; p < stop; p++) order[p] = final[p - start];
        }
      }
      return {order, flags};
    }

    // Conditional stopped-set points, not an invented mean/rounded tally.
    // Given a home/away set winner, the loser's pre-deuce score is negative
    // binomial; at 10:10 the number of split two-rally cycles is geometric.
    function conditionalSetPoints(p, homeWon, rng) {
      p = Math.min(1 - 1e-9, Math.max(1e-9, p));
      const w = homeWon ? p : 1 - p, l = 1 - w;
      const q = setFromPointRaw(w), u = rng.uniform() * q;
      let mass = Math.pow(w, 11), cumulative = 0;
      for (let k = 0; k < 10; k++) {
        if (k) mass *= l * (10 + k) / k;
        cumulative += mass;
        if (u < cumulative) return homeWon ? [11, k] : [k, 11];
      }
      const reset = 2 * w * l;
      const cycles = reset > 0 ? Math.floor(Math.log(rng.uniform()) / Math.log(reset)) : 0;
      return homeWon ? [12 + cycles, 10 + cycles] : [10 + cycles, 12 + cycles];
    }
    function knownMetrics(f, games) {
      const forfeited = f.forfeit_team_id === f.home || f.forfeit_team_id === f.away;
      const h = count(f.home_score == null && forfeited ? (f.forfeit_team_id === f.home ? 0 : 18) : f.home_score, 'home_score');
      const a = count(f.away_score == null && forfeited ? (f.forfeit_team_id === f.away ? 0 : 18) : f.away_score, 'away_score');
      if (h > 18 || a > 18 || h + a > 18 ||
          (forfeited && ((f.forfeit_team_id === f.home && h >= a) || (f.forfeit_team_id === f.away && a >= h)))) {
        throw new Error('Érvénytelen rögzített csapateredmény / csapatfeladás: ' + f.id);
      }
      const km = f.known_metrics;
      if (km) {
        const hasSets = Array.isArray(km.sets) && km.sets.length === 2;
        const hasRallies = Array.isArray(km.rallies) && km.rallies.length === 2;
        return {h, a, sh: hasSets ? count(km.sets[0], 'known sets') : 0,
          sa: hasSets ? count(km.sets[1], 'known sets') : 0,
          rh: hasRallies ? count(km.rallies[0], 'known rallies') : 0,
          ra: hasRallies ? count(km.rallies[1], 'known rallies') : 0,
          rallyMissing: !!km.rally_missing || !hasRallies,
          setMissing: !!km.set_missing || !hasSets};
      }
      let sh = 0, sa = 0, rh = 0, ra = 0, rallyMissing = false, setMissing = false;
      for (const g of games) {
        if (g.home_sets == null || g.away_sets == null) {
          setMissing = true; rallyMissing = true; continue;
        }
        const hs = count(g.home_sets, 'home_sets'), as = count(g.away_sets, 'away_sets');
        sh += hs; sa += as;
        const lines = g.sets || [];
        for (const line of lines) {
          if (!Array.isArray(line) || line.length !== 2) throw new Error('Hibás rögzített szettpontadat.');
          rh += count(line[0], 'set rallies'); ra += count(line[1], 'set rallies');
        }
        if ((hs + as > 0 && (lines.length !== hs + as || g.walkover))) rallyMissing = true;
      }
      return {h, a, sh, sa, rh, ra, rallyMissing: rallyMissing || games.length !== 18,
        setMissing: setMissing || games.length !== 18};
    }
    function normalizeOptions(app, options) {
      const opts = options || {}, n = opts.n == null ? 10000 : count(opts.n, 'n');
      if (n < 1 || n > 100000) throw new Error('n legyen 1 és 100000 között; a kért mintaszámot nem csökkentjük.');
      const horizon = opts.horizon == null ? 18 : opts.horizon;
      if (horizon !== 9 && horizon !== 18) throw new Error('horizon: csak 9 vagy 18 engedélyezett.');
      const modelId = opts.modelId || (app.selected && app.selected.current) || Object.keys(app.models || {})[0];
      if (!app.models || !app.models[modelId]) throw new Error('Ismeretlen modell: ' + modelId);
      const seed = opts.seed == null ? ((app.meta && app.meta.seed) == null ? 202627 : app.meta.seed) : opts.seed;
      return {modelId, n, seed, seedHash: hashSeed(seed), horizon,
        formMultiplier: nonnegative(opts.formMultiplier, 'formMultiplier', 1),
        overrides: opts.overrides || {}};
    }

    function compile(app, options) {
      const m = prepareModel(app.models[options.modelId]), L = cholesky(m);
      const teams = app.teams || [], T = teams.length;
      if (T < 2 || T > 20) throw new Error('A futtatáshoz 2–20 csapat szükséges.');
      const teamIndex = new Map(teams.map((t, i) => [t.id, i]));
      if (teamIndex.size !== T) throw new Error('Duplikált csapatazonosító.');
      const allFixtures = (app.fixtures || []).slice().sort((a, b) => a.round - b.round || String(a.id).localeCompare(String(b.id)));
      const fixtureIds = new Set();
      for (const f of allFixtures) {
        if (fixtureIds.has(f.id)) throw new Error('Duplikált csapattalálkozó: ' + f.id);
        fixtureIds.add(f.id);
        if (!Number.isInteger(f.round) || f.round < 1 || f.round > 18 || !teamIndex.has(f.home) ||
          !teamIndex.has(f.away) || f.home === f.away) throw new Error('Érvénytelen csapattalálkozó: ' + f.id);
        if (f.forfeit_team_id != null && f.forfeit_team_id !== f.home && f.forfeit_team_id !== f.away) {
          throw new Error('Ismeretlen játék nélküli vesztes csapat: ' + f.forfeit_team_id);
        }
      }
      for (const id of Object.keys(options.overrides)) if (!fixtureIds.has(id)) throw new Error('Ismeretlen felülírt találkozó: ' + id);
      const warnings = [], pIndex = new Map(), pGlobals = [], extras = [], pairIndex = new Map(m.pairs);
      for (const [id, i] of m.players) { pIndex.set(id, i); pGlobals.push(i); }
      let dimensions = m.D;
      function player(id) {
        if (id == null) return -1;
        if (!pIndex.has(id)) {
          pIndex.set(id, pGlobals.length); pGlobals.push(dimensions);
          extras.push({index: dimensions++, sd: m.tau});
        }
        return pIndex.get(id);
      }
      function pair(ids) {
        if (ids.length !== 2 || ids.some(id => id == null)) return -1;
        const key = pairKey(ids);
        if (!pairIndex.has(key)) { pairIndex.set(key, dimensions); extras.push({index: dimensions++, sd: m.pair}); }
        return pairIndex.get(key);
      }
      const nativeCache = new Map();
      function compileScenario(team, scenario, empirical) {
        const s = validateScenario(app, team, scenario, empirical);
        const key = team.id + '|' + JSON.stringify([s.paths, s.doubles]);
        if (nativeCache.has(key)) return nativeCache.get(key);
        const entries = [], appearance = [0, 0, 0, 0];
        const ids = s.doubles.map(x => x.slice());
        for (let k = 0; k < 16; k++) {
          // A side's slot/appearance sequence is the same for home and away:
          // each block has each slot once. Order within away blocks is applied
          // when two sides are combined below, not here.
          const slot = k % 4;
          ids.push([s.paths[slot][appearance[slot]++]]);
        }
        for (const pp of ids) entries.push({ids: pp, players: pp.map(player),
          complete: pp.every(id => id != null), pair: pair(pp)});
        const out = {s, entries}; nativeCache.set(key, out);
        return out;
      }
      function choices(team, override) {
        if (override != null) return [{value: compileScenario(team, override, false), weight: 1}];
        if (!Array.isArray(team.scenarios) || !team.scenarios.length) {
          throw new Error('Hiányzó empirikus, teljes csapatfelállás: ' + team.name);
        }
        const result = [];
        for (const s of team.scenarios) {
          const weight = nonnegative(s.weight, 'scenario.weight', 1);
          if (weight > 0) result.push({value: compileScenario(team, s, true), weight});
        }
        if (!result.length) throw new Error('Minden felállás súlya nulla: ' + team.name);
        return result;
      }
      function combined(hs, as) {
        const rubbers = [], dayPlayers = new Set();
        for (let k = 0; k < 18; k++) {
          let hi = k, ai = k;
          if (k >= 2) {
            const b = Math.floor((k - 2) / 4), o = ORDER[k - 2];
            hi = 2 + b * 4 + o[0]; ai = 2 + b * 4 + o[1];
          }
          const h = hs.entries[hi], a = as.entries[ai];
          for (const p of h.players.concat(a.players)) if (p >= 0) dayPlayers.add(p);
          const allIds = h.ids.concat(a.ids).filter(id => id != null);
          if (new Set(allIds).size !== allIds.length) throw new Error('Ugyanaz a játékos a találkozó két oldalán.');
          const detCat = !h.complete && !a.complete ? 6 : !a.complete ? 0 : !h.complete ? 5 : -1;
          rubbers.push({h0: h.players[0], h1: h.players.length === 2 ? h.players[1] : -1,
            a0: a.players[0], a1: a.players.length === 2 ? a.players[1] : -1,
            hc: 1 / h.players.length, ac: 1 / a.players.length, hp: h.pair, ap: a.pair,
            detCat, walkover: !h.complete || !a.complete});
        }
        return {rubbers, dayPlayers: Array.from(dayPlayers)};
      }
      const games = currentGames(app), byMatch = new Map();
      for (const g of games) { if (!byMatch.has(g.match_id)) byMatch.set(g.match_id, []); byMatch.get(g.match_id).push(g); }
      const fixtures = [], pairFixtures = Array.from({length: T * T}, () => []);
      const matchCounts = new Uint16Array(T);
      for (const f of allFixtures) {
        const h = teamIndex.get(f.home), a = teamIndex.get(f.away), ov = options.overrides[f.id] || {};
        // Invalid edited lineups are rejected even when a fixed result would
        // ignore them. Neither edited scores nor lineups can change real results.
        if (ov.home != null) validateScenario(app, teams[h], ov.home, false);
        if (ov.away != null) validateScenario(app, teams[a], ov.away, false);
        if (f.round > options.horizon) continue;
        matchCounts[h]++; matchCounts[a]++;
        const known = isKnown(f), fixtureGames = byMatch.get(f.id) || [];
        const cf = {f, index: fixtures.length, h, a, ij: h * T + a, ji: a * T + h, known,
          counts: new Uint32Array(19), wdl: new Uint32Array(3)};
        if (known) {
          cf.metrics = knownMetrics(f, fixtureGames);
        } else {
          cf.hChoices = choices(teams[h], ov.home); cf.aChoices = choices(teams[a], ov.away);
          function cumulative(items) {
            let sum = 0; for (const item of items) { sum += item.weight; item.cumulative = sum; }
            if (!Number.isFinite(sum) || sum <= 0) throw new Error('Érvénytelen felállássúlyok.');
            return sum;
          }
          cf.hWeight = cumulative(cf.hChoices); cf.aWeight = cumulative(cf.aChoices);
          cf.templates = [];
          for (const hc of cf.hChoices) for (const ac of cf.aChoices) {
            cf.templates.push(combined(hc.value, ac.value));
          }
        }
        fixtures.push(cf); pairFixtures[cf.ij].push(cf); pairFixtures[cf.ji].push(cf);
      }
      // Disclose public historical participation without claiming eligibility.
      for (const team of teams) {
        const roster = new Set(team.roster || []);
        if ((team.scenarios || []).some(s => [].concat(...s.paths, ...s.doubles).some(id => id != null && !roster.has(id)))) {
          warnings.push('Empirikus múltbeli felállásban nyilvánosan játszott, de a mai keretben nem felsorolt játékos is lehet; jogosultságára nincs új állítás. Kézi felállás csak a nyilvános keretből.');
          break;
        }
      }
      return {m, L, teams, T, fixtures, pairFixtures, matchCounts, pGlobals, extras, dimensions, warnings};
    }
    function selectChoice(choices, total, rng) {
      if (choices.length === 1) return 0;
      const u = rng.uniform() * total;
      for (let i = 0; i < choices.length; i++) if (u < choices[i].cumulative) return i;
      return choices.length - 1;
    }
    function makeAccumulator(T, matchCounts) {
      return {positions: new Uint32Array(T * T),
        points: Array.from({length: T}, (_, i) => new Uint32Array(3 * matchCounts[i] + 1)),
        pointSum: new Float64Array(T), rankSum: new Float64Array(T), flags: new Uint32Array(32)};
    }
    function empiricalQuantile(hist, fraction, n) {
      const target = fraction * n; let c = 0;
      for (let i = 0; i < hist.length; i++) { c += hist[i]; if (c >= target) return i; }
      return hist.length - 1;
    }
    function finishAccumulator(acc, teams, n) {
      const T = teams.length, tieFlags = {tables: n, any_flag: n - acc.flags[0]}, frequencies = {};
      for (const bit of Object.keys(FLAG_LABELS).map(Number)) {
        let k = 0; for (let mask = 0; mask < 32; mask++) if (mask & bit) k += acc.flags[mask];
        tieFlags[FLAG_LABELS[bit]] = k; frequencies[FLAG_LABELS[bit]] = k / n;
      }
      tieFlags.frequencies = frequencies;
      return {teams: teams.map((t, i) => {
        const positions = Array.from(acc.positions.subarray(i * T, (i + 1) * T), x => x / n);
        return {id: t.id, positions, points_mean: acc.pointSum[i] / n,
          points_quantiles: [0.05, 0.5, 0.95].map(p => empiricalQuantile(acc.points[i], p, n)),
          promotion: positions[0], relegation: positions.slice(Math.max(0, T - 2)).reduce((a, b) => a + b, 0),
          last: positions[T - 1], mean_rank: acc.rankSum[i] / n};
      }), tie_flags: tieFlags};
    }
    function report(callback, fraction, text) {
      if (typeof callback === 'function') { try { callback(fraction, text); } catch (_) { /* UI failure must not change the simulation. */ } }
    }

    async function runLocal(app, options, progress, execution) {
      const opts = normalizeOptions(app, options);
      report(progress, 0, 'Monte Carlo előkészítése; a kért ' + opts.n.toLocaleString('hu-HU') + ' szezon mind lefut.');
      await pause();
      const c = compile(app, opts), {m, T, fixtures} = c, n = opts.n;
      const horizons = opts.horizon === 18 ? [9, 18] : [9], accumulators = {};
      for (const h of horizons) accumulators[h] = makeAccumulator(T, c.matchCounts);
      const theta = new Float64Array(c.dimensions), z = new Float64Array(m.D);
      const drift = new Float64Array(c.pGlobals.length), strength = new Float64Array(c.pGlobals.length);
      const day = new Float64Array(c.pGlobals.length), points = new Float64Array(T);
      const hp = new Float64Array(T * T), rubbers = new Float64Array(T * T);
      const sets = new Float64Array(T * T), rallies = new Float64Array(T * T);
      const rallyMissing = new Uint8Array(T * T), setMissing = new Uint8Array(T * T);
      const probs = new Float64Array(fixtures.length * 18), cats = new Uint8Array(fixtures.length * 18);
      const rallyDone = new Uint8Array(fixtures.length), keys = new Float64Array(T);
      let generatedRallyFixtures = 0, generatedRallyRubbers = 0, lastProgress = now(), lastYield = now();
      const ds = m.day * opts.formMultiplier, rs = m.rubber * opts.formMultiplier;
      for (let rep = 0; rep < n; rep++) {
        const repSeed = mix32(opts.seedHash ^ mix32((rep + 0x9e3779b9) >>> 0));
        const rng = makeRng(repSeed);
        // One JOINT draw for all fitted global strengths, synergies and home
        // advantage in the entire season, not independent marginal draws.
        for (let i = 0; i < m.D; i++) z[i] = rng.normal();
        for (let i = 0; i < m.D; i++) {
          let v = m.mu[i], row = i * m.D;
          for (let j = 0; j <= i; j++) v += c.L[row + j] * z[j];
          theta[i] = v;
        }
        for (const extra of c.extras) theta[extra.index] = extra.sd * rng.normal();
        drift.fill(0);
        for (let p = 0; p < strength.length; p++) strength[p] = theta[c.pGlobals[p]];
        points.fill(0); hp.fill(0); rubbers.fill(0); sets.fill(0); rallies.fill(0);
        rallyMissing.fill(0); setMissing.fill(0); rallyDone.fill(0);
        let driftRound = m.through, saved9 = false;
        function ensureRallies(group, horizon) {
          for (let p = 0; p < group.length; p++) for (let q = p + 1; q < group.length; q++) {
            for (const f of c.pairFixtures[group[p] * T + group[q]]) {
              if (f.known || f.f.round > horizon || rallyDone[f.index]) continue;
              const rrng = makeRng(mix32(repSeed ^ mix32(f.index + 0x47b6137b)));
              let rh = 0, ra = 0;
              for (let k = 0; k < 18; k++) {
                const offset = f.index * 18 + k, cat = cats[offset];
                if (cat === 6) continue;
                const rallyP = m.family === 'point' ? probs[offset] : pointFromSet(probs[offset]);
                for (let s = 0; s < HOME_SETS[cat]; s++) {
                  const ps = conditionalSetPoints(rallyP, true, rrng); rh += ps[0]; ra += ps[1];
                }
                for (let s = 0; s < AWAY_SETS[cat]; s++) {
                  const ps = conditionalSetPoints(rallyP, false, rrng); rh += ps[0]; ra += ps[1];
                }
                generatedRallyRubbers++;
              }
              rallies[f.ij] += rh; rallies[f.ji] += ra; rallyDone[f.index] = 1; generatedRallyFixtures++;
            }
          }
          return true;
        }
        function snapshot(horizon) {
          const trng = makeRng(mix32(repSeed ^ (horizon === 9 ? 0x1b873593 : 0x85ebca6b)));
          for (let t = 0; t < T; t++) keys[t] = trng.uniform();
          const ranked = rankOne(points, hp, rubbers, sets, rallies, keys, rallyMissing,
            group => ensureRallies(group, horizon), setMissing);
          const acc = accumulators[horizon]; acc.flags[ranked.flags]++;
          for (let rank = 0; rank < T; rank++) {
            const team = ranked.order[rank]; acc.positions[team * T + rank]++; acc.rankSum[team] += rank + 1;
          }
          for (let t = 0; t < T; t++) { acc.pointSum[t] += points[t]; acc.points[t][points[t]]++; }
        }
        for (const f of fixtures) {
          if (!saved9 && opts.horizon === 18 && f.f.round > 9) { snapshot(9); saved9 = true; }
          // A coherent player random walk, updated ONCE per future round and
          // reused for every fixture/rubber in that round, including doubles.
          while (driftRound < f.f.round) {
            driftRound++;
            for (let p = 0; p < strength.length; p++) {
              if (m.drift) drift[p] += m.drift * rng.normal();
              strength[p] = theta[c.pGlobals[p]] + drift[p];
            }
          }
          let h, a, sh, sa;
          if (f.known) {
            const km = f.metrics; h = km.h; a = km.a; sh = km.sh; sa = km.sa;
            rallies[f.ij] += km.rh; rallies[f.ji] += km.ra;
            if (km.rallyMissing) rallyMissing[f.ij] = rallyMissing[f.ji] = 1;
            if (km.setMissing) setMissing[f.ij] = setMissing[f.ji] = 1;
          } else {
            const hi = selectChoice(f.hChoices, f.hWeight, rng), ai = selectChoice(f.aChoices, f.aWeight, rng);
            const template = f.templates[hi * f.aChoices.length + ai];
            for (const p of template.dayPlayers) day[p] = ds ? ds * rng.normal() : 0;
            h = 0; a = 0; sh = 0; sa = 0;
            for (let k = 0; k < 18; k++) {
              const r = template.rubbers[k], offset = f.index * 18 + k;
              let cat;
              if (r.detCat >= 0) {
                cat = r.detCat; probs[offset] = NaN;
                // Never manufacture actual points for an unplayed walkover.
                if (cat !== 6) rallyMissing[f.ij] = rallyMissing[f.ji] = 1;
              } else {
                let eta = theta[m.D - 1] + (strength[r.h0] + day[r.h0]) * r.hc -
                  (strength[r.a0] + day[r.a0]) * r.ac;
                if (r.h1 >= 0) eta += (strength[r.h1] + day[r.h1]) * r.hc;
                if (r.a1 >= 0) eta -= (strength[r.a1] + day[r.a1]) * r.ac;
                if (r.hp >= 0) eta += theta[r.hp]; if (r.ap >= 0) eta -= theta[r.ap];
                if (rs) eta += rs * rng.normal(); // ONE residual shared by ALL sets of this rubber.
                const p = sigmoid(eta), q = m.family === 'set' ? p : setFromPoint(p);
                probs[offset] = p; cat = drawCategory(q, rng.uniform());
              }
              cats[offset] = cat;
              if (cat < 3) h++; else if (cat < 6) a++;
              sh += HOME_SETS[cat]; sa += AWAY_SETS[cat];
            }
          }
          let ph, pa;
          if (h > a) { ph = 3; pa = f.f.forfeit_team_id === f.f.away ? 0 : 1; }
          else if (h < a) { ph = f.f.forfeit_team_id === f.f.home ? 0 : 1; pa = 3; }
          else { ph = 2; pa = 2; }
          points[f.h] += ph; points[f.a] += pa; hp[f.ij] += ph; hp[f.ji] += pa;
          rubbers[f.ij] += h; rubbers[f.ji] += a; sets[f.ij] += sh; sets[f.ji] += sa;
          f.counts[h]++; f.wdl[h > a ? 0 : h === a ? 1 : 2]++;
        }
        if (opts.horizon === 18) { if (!saved9) snapshot(9); snapshot(18); }
        else snapshot(9);
        // Check the clock frequently, not just after a huge fixed-size batch.
        // No 100k main-thread turn; worker and fallback both genuinely yield.
        if ((rep & 3) === 3 || rep + 1 === n) {
          const time = now();
          if (time - lastProgress >= 125 || rep + 1 === n) {
            report(progress, (rep + 1) / n, 'Monte Carlo: ' + (rep + 1).toLocaleString('hu-HU') + ' / ' + n.toLocaleString('hu-HU') + ' szezon.');
            lastProgress = time;
          }
          if (time - lastYield >= (execution === 'blob_worker' ? 35 : 12)) { await pause(); lastYield = now(); }
        }
      }
      const result = {n, seed: opts.seed, modelId: opts.modelId, horizons: {}, fixtures: {},
        sources: (app.sources || []).concat([
          {title: 'Numerikus modell', note: 'scripts/model_refit.py + src/engine.js: stopped first-to-11/win-by-two, coherent six-score law, full Gaussian covariance; joint MAP/Laplace, not MCMC.'},
          {title: 'Helyezési szabály', note: 'src/engine.js, rankOne: 3–2–1–0; recursive head-to-head points, rubber ratio, set ratio, rally ratio; uniform keys only for unresolved groups.'},
          {title: 'Pontgenerálás', note: 'Exact conditional stopped-set points generated lazily only when the ranking reaches rallies; set-family q is inverted to rally p. Real results are never resampled.'}
        ]),
        approximation: ['A globális paramétereloszlás joint MAP / teljes kovarianciás Laplace Gaussian közelítés, nem MCMC.',
          'A jövőbeli teljes csapatfelállások az empirikus scenarios-súlyokból független találkozónkénti keverékek; a jövőbeli nevezési döntés nincs validálva.',
          'A null hiányzás: teljes ellenféllel szemben játék nélküli 0:3; két hiányzó oldal egyikének sincs részgyőzelem. Játék nélküli részmeccshez nem találunk ki valódi poénokat.',
          'formMultiplier csak a day_sd és rubber_sd szórást skálázza; a fordulónkénti drift_sd változatlan.',
          'Az új párosok pair_sd-priorja és a modellből hiányzó keretjátékosok tau-priorja szezononként egyszer, egymástól függetlenül sorsolt globális hatás.'].concat(m.warnings, c.warnings),
        runtime: {execution: execution || 'yielding_fallback', completed: n, requested: n,
          seed_hash: opts.seedHash, rng: 'xoshiro128starstar_BoxMuller_v1',
          points_quantiles: 'empirical_inverted_cdf_05_50_95',
          parameter_draw: 'one_full_covariance_Gaussian_per_season',
          day_effect: 'shared_player_per_team_fixture', drift: 'coherent_player_random_walk_per_round',
          rubber_effect: 'one_shared_offset_for_all_sets',
          rally_fixtures_generated: generatedRallyFixtures, rally_rubbers_generated: generatedRallyRubbers}};
      for (const horizon of horizons) result.horizons[horizon] = finishAccumulator(accumulators[horizon], c.teams, n);
      for (const f of fixtures) {
        const score = Array.from(f.counts, x => x / n);
        result.fixtures[f.f.id] = {score, wdl: Array.from(f.wdl, x => x / n),
          mean_home: score.reduce((sum, p, h) => sum + p * h, 0), known: f.known};
      }
      for (const h of horizons) {
        const flags = result.horizons[h].tie_flags;
        if (flags[FLAG_LABELS[4]]) result.approximation.push('H' + h + ': ' + flags[FLAG_LABELS[4]] + ' mintában döntő valódi poénadat hiányzott (bit 4); az érintett alcsoporton belül uniform rangsorsolás, kitalált pontok nélkül.');
        if (flags[FLAG_LABELS[8]]) result.approximation.push('H' + h + ': a 3+ csapatos végső holtverseny uniform-permutáció feltételezés, nem a kiírásban meghatározott többes pénzfeldobás.');
        if (flags[FLAG_LABELS[16]]) result.approximation.push('H' + h + ': hiányos rögzített szettadat miatt nem dönthető el a szettarány (bit 16); uniform rangsorsolás.');
      }
      report(progress, 1, 'Kész: mind a(z) ' + n.toLocaleString('hu-HU') + ' szezon újraszámítva.');
      return result;
    }

    const FIXTURE_SAMPLER = 'topspin_fixture_joint_gaussian_v1';
    function normalizeFixtureOptions(app, options) {
      const input = options || {};
      if (typeof input.fixtureId !== 'string' || !(app.fixtures || []).some(f => f.id === input.fixtureId)) {
        throw new Error('Ismeretlen csapattalálkozó: ' + input.fixtureId);
      }
      // A fixture run deliberately ignores season overrides and the displayed
      // season horizon. It must never compile or simulate another fixture.
      const opts = normalizeOptions(app, {...input, horizon: 18, overrides: {}});
      return {...opts, fixtureId: input.fixtureId,
        homeScenario: input.homeScenario == null ? null : input.homeScenario,
        awayScenario: input.awayScenario == null ? null : input.awayScenario};
    }
    function fixtureInput(app, opts) {
      const fixture = (app.fixtures || []).find(f => f.id === opts.fixtureId);
      if (!fixture) throw new Error('Ismeretlen csapattalálkozó.');
      const teams = (app.teams || []).map(team => {
        const side = team.id === fixture.home ? 'home' : team.id === fixture.away ? 'away' : null;
        const value = side && opts[side + 'Scenario'];
        if (!side || value == null || isKnown(fixture)) return team;
        // Only a real, unchanged public historical pattern may use historical
        // participation. A custom lineup remains restricted to the public roster.
        const native = isEmpiricalScenario(team, value);
        const scenario = validateScenario(app, team, value, native);
        return {...team, scenarios: [{...scenario, weight: 1}]};
      });
      return {...app, teams, fixtures: [fixture]};
    }
    async function runFixtureLocal(app, options, progress, execution) {
      const opts = normalizeFixtureOptions(app, options), input = fixtureInput(app, opts);
      report(progress, 0, 'Csak a kiválasztott mérkőzés előkészítése…');
      await pause();
      const c = compile(input, opts), {m} = c, f = c.fixtures[0], n = opts.n;
      if (c.fixtures.length !== 1 || f.f.id !== opts.fixtureId) throw new Error('Az egymeccses futás nem egyetlen meccset tartalmaz.');
      const joint = new Uint32Array(19 * 19), awayCounts = new Uint32Array(19);
      const theta = new Float64Array(c.dimensions), z = new Float64Array(m.D);
      const strength = new Float64Array(c.pGlobals.length), day = new Float64Array(c.pGlobals.length);
      const activePlayers = new Set(), activeGlobals = new Set([m.D - 1]);
      for (const template of f.templates || []) {
        for (const p of template.dayPlayers) { activePlayers.add(p); activeGlobals.add(c.pGlobals[p]); }
        for (const r of template.rubbers) {
          if (r.hp >= 0) activeGlobals.add(r.hp);
          if (r.ap >= 0) activeGlobals.add(r.ap);
        }
      }
      const fittedRows = Array.from(activeGlobals).filter(i => i < m.D).sort((a, b) => a - b);
      const ds = m.day * opts.formMultiplier, rs = m.rubber * opts.formMultiplier;
      // At one future round a coherent Gaussian random walk has this marginal.
      // It is not scaled by formMultiplier, exactly as in the season engine.
      const driftSd = m.drift * Math.sqrt(Math.max(0, f.f.round - m.through));
      const fixtureSeed = hashSeed(FIXTURE_SAMPLER + '|' + opts.fixtureId);
      let lastProgress = now(), lastYield = now();
      if (f.known) {
        const h = f.metrics.h, a = f.metrics.a;
        f.counts[h] = n; awayCounts[a] = n; joint[h * 19 + a] = n;
        f.wdl[h > a ? 0 : h === a ? 1 : 2] = n;
      } else for (let rep = 0; rep < n; rep++) {
        const rng = makeRng(mix32(opts.seedHash ^ fixtureSeed ^ mix32((rep + 0x9e3779b9) >>> 0)));
        // Keep the complete covariance of all relevant global parameters.
        // Drawing just the needed Cholesky rows is an exact Gaussian marginal,
        // not a product of independent player estimates.
        for (let i = 0; i < m.D; i++) z[i] = rng.normal();
        for (const i of fittedRows) {
          let v = m.mu[i], row = i * m.D;
          for (let j = 0; j <= i; j++) v += c.L[row + j] * z[j];
          theta[i] = v;
        }
        for (const extra of c.extras) theta[extra.index] = extra.sd * rng.normal();
        for (const p of activePlayers) strength[p] = theta[c.pGlobals[p]] + (driftSd ? driftSd * rng.normal() : 0);
        const hi = selectChoice(f.hChoices, f.hWeight, rng), ai = selectChoice(f.aChoices, f.aWeight, rng);
        const template = f.templates[hi * f.aChoices.length + ai];
        for (const p of template.dayPlayers) day[p] = ds ? ds * rng.normal() : 0;
        let h = 0, a = 0;
        for (const r of template.rubbers) {
          let cat = r.detCat;
          if (cat < 0) {
            let eta = theta[m.D - 1] + (strength[r.h0] + day[r.h0]) * r.hc -
              (strength[r.a0] + day[r.a0]) * r.ac;
            if (r.h1 >= 0) eta += (strength[r.h1] + day[r.h1]) * r.hc;
            if (r.a1 >= 0) eta -= (strength[r.a1] + day[r.a1]) * r.ac;
            if (r.hp >= 0) eta += theta[r.hp];
            if (r.ap >= 0) eta -= theta[r.ap];
            if (rs) eta += rs * rng.normal();
            const p = sigmoid(eta), q = m.family === 'set' ? p : setFromPoint(p);
            cat = drawCategory(q, rng.uniform());
          }
          if (cat < 3) h++; else if (cat < 6) a++;
        }
        f.counts[h]++; awayCounts[a]++; joint[h * 19 + a]++;
        f.wdl[h > a ? 0 : h === a ? 1 : 2]++;
        if ((rep & 63) === 63 || rep + 1 === n) {
          const time = now();
          if (time - lastProgress >= 125 || rep + 1 === n) {
            report(progress, (rep + 1) / n, 'Csak ez a meccs: ' + (rep + 1).toLocaleString('hu-HU') + ' / ' + n.toLocaleString('hu-HU') + ' minta.');
            lastProgress = time;
          }
          if (time - lastYield >= (execution === 'blob_worker' ? 35 : 12)) { await pause(); lastYield = now(); }
        }
      }
      const score = Array.from(f.counts, x => x / n), awayScore = Array.from(awayCounts, x => x / n);
      const result = {schemaVersion: 1, fixtureId: opts.fixtureId, modelId: opts.modelId,
        n, seed: opts.seed, formMultiplier: opts.formMultiplier, known: f.known,
        score, away_score: awayScore, joint_score: Array.from(joint, x => x / n),
        wdl: Array.from(f.wdl, x => x / n),
        mean_home: score.reduce((sum, p, h) => sum + p * h, 0),
        mean_away: awayScore.reduce((sum, p, a) => sum + p * a, 0),
        lineup_mode: {home: opts.homeScenario == null ? 'empirical_mixture' : 'fixed',
          away: opts.awayScenario == null ? 'empirical_mixture' : 'fixed'},
        runtime: {execution: execution || 'yielding_fallback', sampler: FIXTURE_SAMPLER,
          completed: n, requested: n, simulated_samples: f.known ? 0 : n,
          simulated_fixture_count: f.known ? 0 : 1, evaluated_fixture_ids: [opts.fixtureId],
          other_fixtures_simulated: 0, season_recalculated: false,
          parameter_draw: 'full_covariance_Gaussian_marginal',
          day_effect: 'shared_player_per_team_fixture',
          drift: 'exact_single_round_random_walk_marginal',
          rubber_effect: 'one_shared_offset_for_all_sets'},
        approximation: ['Önálló, a kiválasztott mérkőzésre és felállásokra feltételes Monte Carlo-becslés.',
          'A megőrzött szezon- és más mérkőzéseredmények változatlanok; a teljes tabellához külön szezonfutás szükséges.',
          'Teljes Gaussian paraméterkovariancia, közös játékosnapi forma, párosszinergia és jövőbeli drift; nem független részmeccsek összeadása.',
          'Játék nélküli és kettős hiányzásnál a két oldal tényleges részgyőzelmeit számoljuk.'].concat(m.warnings, c.warnings)};
      report(progress, 1, f.known ? 'Rögzített eredmény: nincs újraszimulálás.' : 'Kész: csak a kiválasztott mérkőzés számítása frissült.');
      return result;
    }

    function workerPayload(app, opts) {
      // Do not clone precomputed runs, validation reports or all other models.
      return {meta: app.meta || {}, teams: app.teams, players: (app.players || []).map(p => ({id: p.id, teams: p.teams})),
        fixtures: opts.fixtureId ? app.fixtures.filter(f => f.id === opts.fixtureId) : app.fixtures, currentGames: currentGames(app), models: {[opts.modelId]: app.models[opts.modelId]},
        selected: {current: opts.modelId}, sources: app.sources || []};
    }
    async function run(app, options) {
      return executeInWorker(app, normalizeOptions(app, options), options && options.onProgress, 'season');
    }
    async function runFixture(app, options) {
      return executeInWorker(app, normalizeFixtureOptions(app, options), options && options.onProgress, 'fixture');
    }
    async function executeInWorker(app, opts, progress, task) {
      const local = task === 'fixture' ? runFixtureLocal : runLocal;
      if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
        return local(app, opts, progress, 'yielding_fallback');
      }
      let worker, url;
      try {
        const source = '"use strict"; const runtime = (' + createRuntime.toString() + ')();\n' +
          'self.onmessage = async function(e) { self.postMessage({type:"started"}); try {' +
          'const method=e.data.task==="fixture"?"_runFixtureLocal":"_runLocal";const result=await runtime[method](e.data.app,e.data.options,function(fraction,text){self.postMessage({type:"progress",fraction,text});},"blob_worker");' +
          'self.postMessage({type:"result",result});' +
          '}catch(error){self.postMessage({type:"error",message:error.message,stack:error.stack});} };';
        url = URL.createObjectURL(new Blob([source], {type: 'application/javascript'}));
        worker = new Worker(url);
      } catch (_) {
        if (url) URL.revokeObjectURL(url);
        report(progress, 0, 'A Blob worker nem engedélyezett; ütemezetten, rövid lépésekben számolunk.');
        return local(app, opts, progress, 'yielding_fallback');
      }
      return new Promise((resolve, reject) => {
        let settled = false, started = false;
        const timer = setTimeout(() => { if (!started) fallback(); }, 5000);
        function cleanup() { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); }
        function fallback() {
          if (settled) return; settled = true; cleanup();
          report(progress, 0, 'A worker indítása sikertelen; ugyanaz a kért számítás ütemezett fallback módban indul.');
          local(app, opts, progress, 'yielding_fallback').then(resolve, reject);
        }
        worker.onmessage = e => {
          const data = e.data || {};
          if (data.type === 'started') { started = true; clearTimeout(timer); }
          else if (data.type === 'progress') report(progress, data.fraction, data.text);
          else if (data.type === 'result') { if (!settled) { settled = true; cleanup(); resolve(data.result); } }
          else if (data.type === 'error') {
            if (!settled) { settled = true; cleanup(); const error = new Error(data.message); error.workerStack = data.stack; reject(error); }
          }
        };
        worker.onerror = e => {
          if (e.preventDefault) e.preventDefault();
          if (!started) fallback();
          else if (!settled) { settled = true; cleanup(); reject(new Error(e.message || 'A Monte Carlo worker hibával leállt.')); }
        };
        try { worker.postMessage({app: workerPayload(app, opts), options: opts, task}); }
        catch (_) { fallback(); }
      });
    }
    const api = {predict, preview, run, runFixture};
    Object.defineProperty(api, '_runFixtureLocal', {value: runFixtureLocal});
    Object.defineProperty(api, '_runLocal', {value: runLocal});
    Object.defineProperty(api, '_test', {value: {setFromPoint, setFromPointRaw, pointFromSet, sixProbs,
      marginalSix, rankOne, ratioCompare, conditionalSetPoints, makeRng, prepareModel, cholesky,
      validateScenario, rubberRows, knownMetrics, normalizeOptions, normalizeFixtureOptions, isKnown, FIXTURE_SAMPLER, FLAG_LABELS}});
    return api;
  }
  const SIM = createRuntime();
  root.SIM = SIM;
  if (typeof module !== 'undefined' && module.exports) module.exports = SIM;
})(typeof globalThis !== 'undefined' ? globalThis : this);
