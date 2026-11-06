/* CLUBSTATS v3 — descriptive statistics over the verified, possibly partial club archive.
 *
 * Public API: rows(archive, playerId, filters), profile(...), memberMatrix(archive,
 * filters), summary(archive, filters). Accepts the documented APP.clubStats shape;
 * a full APP or a {games: APP.currentGames, members, teams} adapter also works.
 * Canonical camelCase fields take precedence over currentGames' snake_case fields.
 * No membership is inferred from opponents, names or a hardcoded player/team ID.
 *
 * Defaults: season=all, type=all, scope=club, location=all. Invalid filter values
 * select nothing rather than silently broadening a query. Only completed best-of-
 * five results (3:0..3:2 or their inverse) are played. Walkovers, awarded results,
 * explicit invalid/unplayed records and reliable dates after meta.cutoffUtc are
 * excluded. An anomalous/invalid date stays null, with rawDate retained, not fixed.
 *
 * Rates are fractions in [0,1], not percentages or skill ratings. Point totals
 * and pointRate describe ONLY validated observed setpoints; pointGames counts
 * games with any such points, completePointGames counts fully scored games.
 * Partial ordered point data is a validated prefix, never reconstructed from a
 * terminal score. Comebacks require a COMPLETE validated ordered point sequence.
 * All five heatmap cells are null for order-unknown historic games, even 3:2.
 *
 * Rolling form: the current game and up to 19 preceding eligible FILTERED games
 * (window=20), crossing seasons. Ordering is season, round, reliable date, fixture,
 * known rubber number, stable ID. Unknown rounds/dates sort last within their
 * respective group; this is not a claim of precise chronology for missing dates.
 * Matrix gaps are unobserved (played=0, winRate=null), not known zero performance.
 *
 * Every call builds one O(n) ID/participant index (plus O(n log n) stable sorting).
 * summary/matrix reuse it for all members, not an O(members * archive) scan. There
 * is deliberately no persistent cache: callers may replace/edit an archive, and
 * returned objects never alias it or another result. No DOM, network or packages.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CLUBSTATS = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ROLLING_WINDOW = 20;
  var DEFAULT_FILTERS = Object.freeze({season: 'all', type: 'all', scope: 'club', location: 'all'});
  var SCORES = ['3:0', '3:1', '3:2', '2:3', '1:3', '0:3'];
  var ORDERING = 'season, round (unknown last), valid date (unknown last), matchId, gameNumber, id';
  var OWN = Object.prototype.hasOwnProperty;

  function array(value) { return Array.isArray(value) ? value : []; }
  function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  function text(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
  function id(value) {
    if (value && typeof value === 'object') return id(value.id);
    if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null;
    return text(value);
  }
  function field(value, canonical, legacy) {
    return OWN.call(value, canonical) ? value[canonical] : legacy ? value[legacy] : undefined;
  }
  function integer(value) {
    if (typeof value === 'string' && /^-?\d+$/.test(value)) value = Number(value);
    return Number.isSafeInteger(value) ? value : null;
  }
  function positiveInteger(value) { var n = integer(value); return n !== null && n > 0 ? n : null; }
  function flag(value) { return value === true || value === 1 || value === 'true'; }
  function fraction(n, d) { return d > 0 ? n / d : null; }
  function compareText(a, b) { a = a || ''; b = b || ''; return a < b ? -1 : a > b ? 1 : 0; }
  function seasonInfo(value) {
    if (typeof value !== 'string') return null;
    var m = /^(\d{4})\/(\d{4})$/.exec(value);
    if (!m) return null;
    var start = Number(m[1]), end = Number(m[2]);
    return start >= 1000 && start <= 9998 && end === start + 1 ? {season: value, start: start} : null;
  }
  function year(value) {
    if (typeof value === 'string' && !/^\d{4}$/.test(value)) return null;
    var n = integer(value);
    return n !== null && n >= 1000 && n <= 9998 ? n : null;
  }
  function seasonCompare(a, b) {
    var sa = seasonInfo(a), sb = seasonInfo(b);
    if (sa && sb) return sa.start - sb.start;
    if (sa || sb) return sa ? -1 : 1;
    return compareText(a, b);
  }

  // Date.parse alone silently normalizes impossible calendar dates in some engines.
  function validDate(value) {
    if (typeof value !== 'string') return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
    if (!m) return null;
    var y = Number(m[1]), mo = Number(m[2]), day = Number(m[3]);
    var leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    var days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (y < 1000 || mo < 1 || mo > 12 || day < 1 || day > days[mo - 1]) return null;
    if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] || 0) > 59)) return null;
    if (m[8] && m[8] !== 'Z') {
      var oh = Number(m[8].slice(1, 3)), om = Number(m[8].slice(4, 6));
      if (oh > 14 || om > 59 || (oh === 14 && om !== 0)) return null;
    }
    var time = Date.parse(value);
    return Number.isFinite(time) ? {value: value, time: time, year: y} : null;
  }

  function filtersOf(value) {
    value = object(value);
    var f = {}, valid = true;
    ['season', 'type', 'scope', 'location'].forEach(function (key) {
      f[key] = value[key] === undefined ? DEFAULT_FILTERS[key] : value[key];
    });
    if (f.season !== 'all' && !seasonInfo(f.season)) valid = false;
    if (['all', 'singles', 'doubles'].indexOf(f.type) < 0) valid = false;
    if (['club', 'all'].indexOf(f.scope) < 0) valid = false;
    if (['all', 'home', 'away'].indexOf(f.location) < 0) valid = false;
    return {values: f, valid: valid};
  }
  function identities(value) { return array(value).map(id); }
  function uniquePlayers(players) {
    return players.length > 0 && players.every(function (p) { return p !== null; }) && new Set(players).size === players.length;
  }
  function rubberNumber(g, type) {
    var direct = positiveInteger(field(g, 'gameNumber', 'game_number'));
    if (direct !== null) return direct;
    var label = text(g.label), m = label && /^P([12])$/i.exec(label);
    if (m) return Number(m[1]);
    m = label && /^E([1-9]|1[0-6])$/i.exec(label);
    if (m) return Number(m[1]) + 2;
    var n = positiveInteger(g.number);
    if (n !== null && type === 'doubles' && n <= 2) return n;
    if (n !== null && type === 'singles' && n <= 16) return n + 2;
    return null;
  }

  function emptyPoints(status, issue) {
    return {pairs: [], ordered: false, complete: false, status: status, issues: issue ? [issue] : []};
  }
  function placeholder(pair) {
    return pair == null || (Array.isArray(pair) && (pair.length === 0 ||
      (pair.length === 2 && pair[0] === 0 && pair[1] === 0)));
  }
  function validPointPair(pair) {
    if (!Array.isArray(pair) || pair.length !== 2) return false;
    var a = pair[0], b = pair[1];
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 0 || b < 0 || a === b) return false;
    var hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi === 11 && lo <= 9) || (hi > 11 && hi - lo === 2);
  }
  function pointData(g, hs, as, completeScore) {
    var supplied = g.sets;
    if (supplied == null || (Array.isArray(supplied) && supplied.length === 0)) return emptyPoints('missing');
    if (!Array.isArray(supplied)) return emptyPoints('invalid', 'sets-not-array');
    if (!completeScore) return emptyPoints('invalid', 'incomplete-terminal-score');
    var total = hs + as;
    var ordered = field(g, 'setsOrdered', 'sets_ordered') !== false && g.orderedPoints !== false;
    var active = supplied.slice(0, total), pairs = [], missingSeen = false, hw = 0, aw = 0;
    for (var i = 0; i < active.length; i++) {
      var pair = active[i];
      if (placeholder(pair)) { missingSeen = true; continue; }
      // A missing slot followed by points is not a reliable ordered prefix.
      if ((ordered && missingSeen) || !validPointPair(pair)) return emptyPoints('invalid', 'invalid-or-gapped-setpoints');
      pairs.push([pair[0], pair[1]]);
      if (pair[0] > pair[1]) hw++; else aw++;
      if (hw > hs || aw > as) return emptyPoints('invalid', 'setpoints-disagree-with-score');
      if (ordered && (hw === 3 || aw === 3) && i !== total - 1) return emptyPoints('invalid', 'points-after-early-finish');
    }
    for (var j = total; j < supplied.length; j++) {
      if (!placeholder(supplied[j])) return emptyPoints('invalid', 'points-after-finish');
    }
    if (pairs.length === 0) return emptyPoints('missing');
    var complete = pairs.length === total;
    if (complete && (hw !== hs || aw !== as)) return emptyPoints('invalid', 'setpoints-disagree-with-score');
    return {pairs: pairs, ordered: ordered, complete: complete,
      status: ordered ? (complete ? 'complete' : 'partial') : 'unordered', issues: []};
  }

  function normalizeGame(raw, teams, cutoff) {
    var g = object(raw);
    var hp = identities(field(g, 'homePlayers', 'home_players'));
    var ap = identities(field(g, 'awayPlayers', 'away_players'));
    var derivedType = hp.length === 1 && ap.length === 1 ? 'singles' : hp.length === 2 && ap.length === 2 ? 'doubles' : null;
    var suppliedType = text(g.type);
    var type = derivedType || suppliedType;
    var matchId = id(field(g, 'matchId', 'match_id'));
    var gameNumber = rubberNumber(g, type), label = text(g.label);
    var gameId = id(g.id) || id(g.key);
    if (!gameId && matchId && label && /^(P[12]|E([1-9]|1[0-6]))$/i.test(label)) gameId = matchId + ':' + label.toUpperCase();
    if (!gameId && matchId && gameNumber !== null) gameId = matchId + ':game:' + gameNumber;
    var homeTeam = id(field(g, 'homeTeam', 'home_team'));
    var awayTeam = id(field(g, 'awayTeam', 'away_team'));
    var hs = integer(field(g, 'homeSets', 'home_sets')), as = integer(field(g, 'awaySets', 'away_sets'));
    var completeScore = hs !== null && as !== null && ((hs === 3 && as >= 0 && as <= 2) || (as === 3 && hs >= 0 && hs <= 2));
    var scoreInvalid = hs === null || as === null ?
      (field(g, 'homeSets', 'home_sets') != null || field(g, 'awaySets', 'away_sets') != null) :
      hs < 0 || as < 0 || hs > 3 || as > 3 || (hs === 3 && as === 3);
    var identityValid = !!homeTeam && !!awayTeam && homeTeam !== awayTeam && !!derivedType &&
      (!suppliedType || suppliedType === derivedType) && uniquePlayers(hp) && uniquePlayers(ap) &&
      hp.every(function (p) { return ap.indexOf(p) < 0; });
    var season = text(g.season), si = seasonInfo(season);
    var sourceStart = field(g, 'seasonStart', 'season_start');
    var seasonAnomaly = sourceStart != null && (!si || year(sourceStart) !== si.start);
    var rawDate = text(g.date), parsed = validDate(rawDate);
    var anomaly = flag(field(g, 'dateAnomaly', 'date_anomaly')) ||
      (g.date != null && !parsed) || (!!parsed && !!si && parsed.year !== si.start && parsed.year !== si.start + 1);
    var date = anomaly ? null : parsed;
    var status = (text(g.status) || '').toLowerCase();
    var walkover = flag(g.walkover) || flag(g.awarded) || flag(g.forfeit);
    var explicitInvalid = g.valid === false || flag(g.invalid) || ['invalid', 'void', 'deleted'].indexOf(status) >= 0;
    var explicitUnplayed = g.played === false || g.completed === false || g.known === false ||
      ['unplayed', 'not_played', 'notplayed', 'pending', 'scheduled', 'cancelled', 'canceled', 'postponed'].indexOf(status) >= 0;
    var future = !!date && !!cutoff && date.time > cutoff.time;
    var baseReason = !identityValid || scoreInvalid ? 'invalid' : !completeScore ? 'unplayed' : null;
    var points = pointData(g, hs, as, completeScore);
    // Player order within a pair is not an identity or priority distinction.
    hp = hp.slice().sort(compareText); ap = ap.slice().sort(compareText);
    var result = {id: gameId, matchId: matchId, label: label, gameNumber: gameNumber,
      homeTeam: homeTeam, awayTeam: awayTeam, homePlayers: hp, awayPlayers: ap,
      homeClub: teams.has(homeTeam), awayClub: teams.has(awayTeam),
      homeSets: hs, awaySets: as, type: type, season: season, seasonStart: si ? si.start : null,
      seasonAnomaly: seasonAnomaly, round: positiveInteger(g.round), rawDate: rawDate,
      date: date ? date.value : null, dateTime: date ? date.time : null, dateAnomaly: anomaly,
      source: text(g.source), walkover: walkover, explicitInvalid: explicitInvalid,
      explicitUnplayed: explicitUnplayed, future: future, baseReason: baseReason, points: points,
      core: identityValid && completeScore ? JSON.stringify([matchId, season, homeTeam, awayTeam, hp, ap, hs, as]) : null};
    result.quality = (identityValid && completeScore ? 10000 : 0) +
      (points.complete ? 100 : 0) + points.pairs.length * 10 + (points.ordered ? 8 : 0) + (date ? 4 : 0) +
      (result.round !== null ? 2 : 0) + (si ? 1 : 0);
    result.tie = JSON.stringify([result.date, result.round, result.source, result.label, points.pairs, points.ordered]);
    return result;
  }

  function gameCompare(a, b) {
    var s = seasonCompare(a.season, b.season);
    if (s) return s;
    var ar = a.round === null ? Infinity : a.round, br = b.round === null ? Infinity : b.round;
    if (ar !== br) return ar - br;
    var ad = a.dateTime === null ? Infinity : a.dateTime, bd = b.dateTime === null ? Infinity : b.dateTime;
    if (ad !== bd) return ad - bd;
    var match = compareText(a.matchId, b.matchId);
    if (match) return match;
    var an = a.gameNumber === null ? Infinity : a.gameNumber, bn = b.gameNumber === null ? Infinity : b.gameNumber;
    return an !== bn ? an - bn : compareText(a.id, b.id);
  }
  function pointConflict(a, b) {
    if (a.pairs.length === 0 || b.pairs.length === 0) return false;
    if (a.ordered && b.ordered) {
      var n = Math.min(a.pairs.length, b.pairs.length);
      for (var i = 0; i < n; i++) if (a.pairs[i][0] !== b.pairs[i][0] || a.pairs[i][1] !== b.pairs[i][1]) return true;
      return false;
    }
    // Unordered duplicates can be compared as multisets, not as positional claims.
    if (a.complete && b.complete) {
      var aa = a.pairs.map(function (p) { return p.join(':'); }).sort();
      var bb = b.pairs.map(function (p) { return p.join(':'); }).sort();
      return JSON.stringify(aa) !== JSON.stringify(bb);
    }
    return false;
  }

  function buildIndex(input) {
    input = object(input);
    var archive = input.clubStats && typeof input.clubStats === 'object' ? object(input.clubStats) : input;
    var source = Array.isArray(archive.games) ? 'archive' : Array.isArray(archive.currentGames) ? 'currentGames' : 'empty';
    var games = source === 'archive' ? archive.games : source === 'currentGames' ? archive.currentGames : [];
    var meta = object(archive.meta), cutoffText = text(field(meta, 'cutoffUtc', 'cutoff_utc'));
    var cutoff = validDate(cutoffText), teams = new Set(), names = new Map();
    array(archive.teams).forEach(function (t) { if (t && t.isSiofok === true && id(t.id)) teams.add(id(t.id)); });
    array(archive.players).forEach(function (p) { if (p && id(p.id)) names.set(id(p.id), text(p.name) || id(p.id)); });
    var memberMap = new Map();
    array(archive.members).forEach(function (m) {
      if (!m || !id(m.id)) return;
      var pid = id(m.id), current = m.current === true || (m.current == null && m.status === 'current');
      var candidate = {id: pid, name: text(m.name) || names.get(pid) || pid, current: current,
        observedSeasons: array(m.observedSeasons).filter(function (s) { return !!seasonInfo(s); })};
      if (memberMap.has(pid)) {
        var prev = memberMap.get(pid);
        candidate.current = candidate.current || prev.current;
        candidate.name = compareText(candidate.name, prev.name) < 0 ? candidate.name : prev.name;
        candidate.observedSeasons = Array.from(new Set(prev.observedSeasons.concat(candidate.observedSeasons)));
      }
      memberMap.set(pid, candidate); names.set(pid, candidate.name);
    });
    var members = Array.from(memberMap.values()).sort(function (a, b) {
      return a.name.localeCompare(b.name, 'hu') || compareText(a.id, b.id);
    });
    var groups = new Map(), missingIds = 0;
    games.forEach(function (raw) {
      var g = normalizeGame(raw, teams, cutoff);
      if (!g.id) { missingIds++; return; }
      var group = groups.get(g.id);
      if (!group) { group = {best: g, candidates: [], players: new Set(), core: null, conflict: false}; groups.set(g.id, group); }
      group.candidates.push(g);
      g.homePlayers.concat(g.awayPlayers).forEach(function (p) { if (p !== null) group.players.add(p); });
      if (g.core) { if (group.core !== null && group.core !== g.core) group.conflict = true; group.core = g.core; }
      if (g.quality > group.best.quality || (g.quality === group.best.quality && compareText(g.tie, group.best.tie) < 0)) group.best = g;
    });
    var entries = [], duplicateIds = 0, conflicts = 0, pointConflicts = 0, dateConflicts = 0, roundConflicts = 0;
    groups.forEach(function (group) {
      var best = group.best, cs = group.candidates, pc = false;
      // A richer duplicate may supply points, but must not erase uncertainty in
      // source chronology. Missing dates can be enriched; contradictory/flagged
      // dates and contradictory rounds remain explicitly unknown.
      var dateTimes = new Set(), rounds = new Set(), flaggedDate = false;
      cs.forEach(function (g) {
        if (g.dateTime !== null) dateTimes.add(g.dateTime);
        if (g.round !== null) rounds.add(g.round);
        if (g.dateAnomaly) flaggedDate = true;
      });
      if (dateTimes.size > 1 || (cs.length > 1 && flaggedDate && dateTimes.size > 0)) {
        best.date = null; best.dateTime = null; best.dateAnomaly = true; dateConflicts++;
      }
      if (rounds.size > 1) { best.round = null; best.roundAnomaly = true; roundConflicts++; }
      if (cs.length > 1) duplicateIds++;
      if (group.conflict) conflicts++;
      for (var i = 0; i < cs.length; i++) {
        if (cs[i].core === best.core && pointConflict(cs[i].points, best.points)) pc = true;
      }
      if (pc) { pointConflicts++; best.points = emptyPoints('invalid', 'conflicting-duplicate-setpoints'); }
      var reason = group.conflict ? 'duplicateConflict' :
        cs.some(function (g) { return g.walkover; }) ? 'walkover' :
        cs.some(function (g) { return g.explicitInvalid; }) ? 'invalid' :
        cs.some(function (g) { return g.explicitUnplayed; }) ? 'unplayed' :
        cs.some(function (g) { return g.future; }) ? 'future' : best.baseReason;
      entries.push({game: best, candidates: cs, players: group.players, reason: reason, pointConflict: pc});
    });
    entries.sort(function (a, b) { return gameCompare(a.game, b.game); });
    var byPlayer = new Map();
    entries.forEach(function (entry) {
      entry.players.forEach(function (pid) {
        if (!byPlayer.has(pid)) byPlayer.set(pid, []);
        byPlayer.get(pid).push(entry);
      });
    });
    return {archive: archive, meta: meta, source: source, cutoff: cutoff ? cutoff.value : null,
      entries: entries, byPlayer: byPlayer, members: members, names: names,
      counts: {inputRecords: games.length, uniqueGameIds: groups.size, missingIdRecords: missingIds,
        duplicateRecords: games.length - missingIds - groups.size, duplicateGameIds: duplicateIds,
        conflictingGameIds: conflicts, conflictingPointGameIds: pointConflicts,
        conflictingDateGameIds: dateConflicts, conflictingRoundGameIds: roundConflicts}};
  }

  function sideOf(g, pid) {
    var h = g.homePlayers.indexOf(pid) >= 0, a = g.awayPlayers.indexOf(pid) >= 0;
    return h === a ? null : h ? 0 : 1;
  }
  function matches(g, pid, filter) {
    if (!filter.valid) return false;
    var f = filter.values, side = sideOf(g, pid);
    if (side === null) return false;
    return (f.season === 'all' || g.season === f.season) &&
      (f.type === 'all' || g.type === f.type) &&
      (f.scope === 'all' || (side === 0 ? g.homeClub : g.awayClub)) &&
      (f.location === 'all' || (f.location === 'home' ? side === 0 : side === 1));
  }
  function rowOf(g, pid) {
    var home = sideOf(g, pid) === 0, own = home ? g.homePlayers : g.awayPlayers;
    var pairs = g.points.pairs.map(function (p) { return home ? p.slice() : [p[1], p[0]]; });
    var scored = pairs.length, total = g.homeSets + g.awaySets, knownOrder = g.points.ordered ? scored : 0;
    var label = [g.season || 'Ismeretlen idény', g.round !== null ? g.round + '. forduló' : null, g.label || g.id].filter(Boolean).join(' · ');
    return {id: g.id, matchId: g.matchId, date: g.date, dateAnomaly: g.dateAnomaly,
      season: g.season, seasonStart: g.seasonStart, round: g.round, type: g.type,
      teamId: home ? g.homeTeam : g.awayTeam, opponentTeamId: home ? g.awayTeam : g.homeTeam,
      inClub: home ? g.homeClub : g.awayClub, home: home,
      opponents: (home ? g.awayPlayers : g.homePlayers).slice(),
      partner: own.length === 2 ? own[0] === pid ? own[1] : own[0] : null,
      won: home ? g.homeSets > g.awaySets : g.awaySets > g.homeSets,
      setsFor: home ? g.homeSets : g.awaySets, setsAgainst: home ? g.awaySets : g.homeSets,
      pointsFor: scored ? pairs.reduce(function (s, p) { return s + p[0]; }, 0) : null,
      pointsAgainst: scored ? pairs.reduce(function (s, p) { return s + p[1]; }, 0) : null,
      sets: pairs, setOutcomes: g.points.ordered ? pairs.map(function (p) { return p[0] > p[1] ? 1 : -1; }) : [], source: g.source,
      label: label, gameNumber: g.gameNumber, rawDate: g.rawDate, seasonAnomaly: g.seasonAnomaly, roundAnomaly: !!g.roundAnomaly,
      totalSets: total, scoredSets: scored, pointCoverage: fraction(scored, total),
      pointsComplete: g.points.complete, orderedPoints: g.points.ordered && scored > 0,
      orderedPointsComplete: g.points.ordered && g.points.complete,
      knownOrderSets: knownOrder, unknownOrderSets: total - knownOrder,
      pointDataStatus: g.points.status, pointDataIssues: g.points.issues.slice()};
  }
  function selection(index, pid, filter) {
    pid = id(pid);
    var entries = index.byPlayer.get(pid) || [], rows = [];
    var excluded = {walkover: 0, invalid: 0, unplayed: 0, future: 0, duplicateConflict: 0};
    var matchingGames = 0;
    entries.forEach(function (entry) {
      var match = entry.reason ? entry.candidates.some(function (g) { return matches(g, pid, filter); }) : matches(entry.game, pid, filter);
      if (!match) return;
      matchingGames++;
      if (entry.reason) excluded[entry.reason]++;
      else rows.push(rowOf(entry.game, pid));
    });
    return {rows: rows, available: entries.length, matching: matchingGames, excluded: excluded};
  }

  function totalsOf(rows) {
    var t = {played: 0, won: 0, lost: 0, winRate: null, singlesPlayed: 0, singlesWon: 0,
      doublesPlayed: 0, doublesWon: 0, setsFor: 0, setsAgainst: 0, setRate: null,
      pointsFor: null, pointsAgainst: null, pointRate: null, pointGames: 0, scoredSets: 0,
      decidersPlayed: 0, decidersWon: 0, deciderRate: null};
    rows.forEach(function (r) {
      t.played++; if (r.won) t.won++; else t.lost++;
      t[r.type + 'Played']++; if (r.won) t[r.type + 'Won']++;
      t.setsFor += r.setsFor; t.setsAgainst += r.setsAgainst;
      if (r.pointsFor !== null) {
        t.pointGames++; t.scoredSets += r.scoredSets;
        t.pointsFor = (t.pointsFor === null ? 0 : t.pointsFor) + r.pointsFor;
        t.pointsAgainst = (t.pointsAgainst === null ? 0 : t.pointsAgainst) + r.pointsAgainst;
      }
      if (r.totalSets === 5) { t.decidersPlayed++; if (r.won) t.decidersWon++; }
    });
    t.winRate = fraction(t.won, t.played); t.setRate = fraction(t.setsFor, t.setsFor + t.setsAgainst);
    t.pointRate = t.pointsFor === null ? null : fraction(t.pointsFor, t.pointsFor + t.pointsAgainst);
    t.deciderRate = fraction(t.decidersWon, t.decidersPlayed);
    return t;
  }
  function sample(map, pid, r, withSets) {
    if (!map.has(pid)) map.set(pid, {id: pid, played: 0, won: 0, winRate: null, setsFor: 0, setsAgainst: 0, singlesPlayed: 0, doublesPlayed: 0});
    var s = map.get(pid); s.played++; if (r.won) s.won++;
    s[r.type + 'Played']++;
    if (withSets) { s.setsFor += r.setsFor; s.setsAgainst += r.setsAgainst; }
  }
  function sampleRows(map, names, withSets) {
    return Array.from(map.values()).map(function (s) {
      s.winRate = fraction(s.won, s.played); s.sampleSize = s.played; s.name = names.get(s.id) || s.id;
      if (!withSets) { delete s.setsFor; delete s.setsAgainst; }
      return s;
    }).sort(function (a, b) { return b.played - a.played || a.name.localeCompare(b.name, 'hu') || compareText(a.id, b.id); });
  }
  function coverageOf(index, selected, filter, totals) {
    var rs = selected.rows, full = 0, partial = 0, invalid = 0, unordered = 0;
    var ordered = 0, completeOrdered = 0, knownOrderSets = 0, knownDates = 0, anomalies = 0, unknownSeasons = 0;
    rs.forEach(function (r) {
      if (r.pointsComplete) full++;
      if (r.scoredSets > 0 && !r.pointsComplete) partial++;
      if (r.pointDataStatus === 'invalid') invalid++;
      if (r.scoredSets > 0 && !r.orderedPoints) unordered++;
      if (r.orderedPoints) ordered++;
      if (r.orderedPointsComplete) completeOrdered++;
      knownOrderSets += r.knownOrderSets;
      if (r.date !== null) knownDates++;
      if (r.dateAnomaly) anomalies++;
      if (r.seasonStart === null) unknownSeasons++;
    });
    var totalSets = totals.setsFor + totals.setsAgainst;
    return {source: index.source, archive: Object.assign({}, index.counts), cutoffUtc: index.cutoff,
      filters: Object.assign({}, filter.values), filtersValid: filter.valid,
      availablePlayerGames: selected.available, matchingGames: selected.matching,
      filteredOutGames: selected.available - selected.matching, exclusions: Object.assign({}, selected.excluded),
      excludedGames: selected.matching - rs.length, played: rs.length,
      pointGames: totals.pointGames, completePointGames: full, partialPointGames: partial,
      missingPointGames: rs.length - totals.pointGames - invalid, invalidPointGames: invalid, unorderedPointGames: unordered,
      pointGameRate: fraction(totals.pointGames, rs.length), completePointGameRate: fraction(full, rs.length),
      totalSets: totalSets, scoredSets: totals.scoredSets, pointSetRate: fraction(totals.scoredSets, totalSets),
      orderedGames: ordered, completeOrderedGames: completeOrdered, orderUnknownGames: rs.length - ordered,
      knownOrderSets: knownOrderSets, unknownOrderSets: totalSets - knownOrderSets,
      knownDateGames: knownDates, unknownDateGames: rs.length - knownDates, anomalousDateGames: anomalies,
      unknownSeasonGames: unknownSeasons, rollingWindow: ROLLING_WINDOW, rollingAcrossSeasons: true,
      rollingBasis: 'Current and previous eligible filtered games; up to 20, not calendar days.',
      ordering: ORDERING, unknownDateOrdering: 'After known dates within the same season and round; anomalous rawDate is never a playing date.',
      pointsBasis: 'Observed validated setpoints only. pointGames includes partial games; completePointGames and pointSetRate give full coverage.',
      setOrderBasis: 'Supplied ordered point pairs only; terminal set scores never create set positions.',
      comebackBasis: 'Complete validated ordered point sequence only.',
      countingUnit: 'Player appearances. A doubles rubber is one game for each partner; do not sum member totals as team rubber wins.',
      winRateMeaning: 'Descriptive observed opponent-dependent win rate, not an adjusted skill rating.',
      missingSeasonMeaning: 'No eligible observed games is unknown history, not evidence of no play or zero ability.',
      membershipCriteria: text(index.meta.membershipCriteria),
      coverageNotes: array(index.meta.coverageNotes).filter(function (n) { return typeof n === 'string'; }).slice()};
  }

  function rows(archive, playerId, filters) {
    return selection(buildIndex(archive), playerId, filtersOf(filters)).rows;
  }
  function profile(archive, playerId, filters) {
    var index = buildIndex(archive), filter = filtersOf(filters), selected = selection(index, playerId, filter);
    var rs = selected.rows, totals = totalsOf(rs), seasons = new Map(), opponents = new Map(), partners = new Map();
    var hist = new Map(SCORES.map(function (s) { return [s, 0]; }));
    var positions = Array.from({length: 5}, function (_, i) { return {set: i + 1, played: 0, won: 0, winRate: null, possiblePlayed: 0, unknown: 0, coverage: null}; });
    var comebacks = {eligible: 0, from02Attempts: 0, from02Wins: 0, lost20Attempts: 0, lost20Losses: 0};
    var form = [], heatmap = [], rollingWon = 0;
    rs.forEach(function (r, i) {
      if (!seasons.has(r.season)) seasons.set(r.season, []);
      seasons.get(r.season).push(r);
      r.opponents.forEach(function (pid) { sample(opponents, pid, r, true); });
      if (r.partner !== null) sample(partners, r.partner, r, false);
      var score = r.setsFor + ':' + r.setsAgainst;
      hist.set(score, hist.get(score) + 1);
      rollingWon += Number(r.won);
      if (i >= ROLLING_WINDOW) rollingWon -= Number(rs[i - ROLLING_WINDOW].won);
      var rollingPlayed = Math.min(i + 1, ROLLING_WINDOW);
      form.push({id: r.id, label: r.label, season: r.season, date: r.date, won: r.won,
        rollingPlayed: rollingPlayed, rollingWinRate: fraction(rollingWon, rollingPlayed),
        rollingWon: rollingWon, rollingWindow: ROLLING_WINDOW, rollingStartId: rs[Math.max(0, i - ROLLING_WINDOW + 1)].id});
      var cells = Array(5).fill(null);
      r.setOutcomes.forEach(function (outcome, j) {
        cells[j] = {outcome: outcome, ownPoints: r.sets[j][0], opponentPoints: r.sets[j][1]};
        positions[j].played++; if (outcome === 1) positions[j].won++;
      });
      for (var j = 0; j < r.totalSets; j++) positions[j].possiblePlayed++;
      heatmap.push({id: r.id, label: r.label, season: r.season, opponents: r.opponents.slice(), score: score, cells: cells,
        playedSets: r.totalSets, scoredSets: r.scoredSets, knownOrderSets: r.knownOrderSets,
        unknownOrderSets: r.unknownOrderSets, unplayedSets: 5 - r.totalSets,
        orderKnown: r.orderedPointsComplete, pointDataStatus: r.pointDataStatus});
      if (r.orderedPointsComplete) {
        comebacks.eligible++;
        if (r.setOutcomes[0] === -1 && r.setOutcomes[1] === -1) { comebacks.from02Attempts++; if (r.won) comebacks.from02Wins++; }
        if (r.setOutcomes[0] === 1 && r.setOutcomes[1] === 1) { comebacks.lost20Attempts++; if (!r.won) comebacks.lost20Losses++; }
      }
    });
    positions.forEach(function (p) { p.winRate = fraction(p.won, p.played); p.unknown = p.possiblePlayed - p.played; p.coverage = fraction(p.played, p.possiblePlayed); });
    var bySeason = Array.from(seasons.keys()).sort(seasonCompare).map(function (s) {
      var seasonRows = seasons.get(s), t = totalsOf(seasonRows);
      return {season: s, played: t.played, won: t.won, winRate: t.winRate, setsFor: t.setsFor, setsAgainst: t.setsAgainst,
        pointGames: t.pointGames, scoredSets: t.scoredSets, completePointGames: seasonRows.filter(function (r) { return r.pointsComplete; }).length,
        pointCoverage: fraction(t.scoredSets, t.setsFor + t.setsAgainst)};
    });
    return {totals: totals, bySeason: bySeason, opponents: sampleRows(opponents, index.names, true),
      partners: sampleRows(partners, index.names, false), form: form, setHeatmap: heatmap,
      scoreDistribution: SCORES.map(function (s) { return {score: s, count: hist.get(s), probability: fraction(hist.get(s), rs.length)}; }),
      setPositions: positions, comebacks: comebacks, rows: rs, coverage: coverageOf(index, selected, filter, totals)};
  }
  function matrixSeasons(index, filter) {
    if (!filter.valid) return [];
    if (filter.values.season !== 'all') return [filter.values.season];
    var starts = [];
    function add(s) { var si = seasonInfo(s); if (si) starts.push(si.start); }
    index.entries.forEach(function (entry) { add(entry.game.season); });
    index.members.forEach(function (m) { m.observedSeasons.forEach(add); });
    add(index.meta.season);
    if (starts.length === 0) return [];
    var min = Infinity, max = -Infinity;
    starts.forEach(function (s) { min = Math.min(min, s); max = Math.max(max, s); });
    var seasons = [];
    for (var y = min; y <= max; y++) seasons.push(y + '/' + (y + 1));
    return seasons;
  }
  function memberMatrix(archive, filters) {
    var index = buildIndex(archive), filter = filtersOf(filters), seasons = matrixSeasons(index, filter);
    return {seasons: seasons, rows: index.members.map(function (m) {
      var observed = new Map();
      selection(index, m.id, filter).rows.forEach(function (r) {
        if (!observed.has(r.season)) observed.set(r.season, {played: 0, won: 0});
        var s = observed.get(r.season); s.played++; if (r.won) s.won++;
      });
      return {id: m.id, name: m.name, current: m.current, cells: seasons.map(function (s) {
        var cell = observed.get(s) || {played: 0, won: 0};
        return {season: s, played: cell.played, won: cell.won, winRate: fraction(cell.won, cell.played)};
      })};
    })};
  }
  function summary(archive, filters) {
    var index = buildIndex(archive), filter = filtersOf(filters);
    return index.members.map(function (m) {
      return Object.assign({id: m.id, name: m.name, current: m.current}, totalsOf(selection(index, m.id, filter).rows));
    });
  }

  return Object.freeze({rows: rows, profile: profile, memberMatrix: memberMatrix, summary: summary,
    ROLLING_WINDOW: ROLLING_WINDOW, DEFAULT_FILTERS: DEFAULT_FILTERS, version: '3.0.0'});
}));
