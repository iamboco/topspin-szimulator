#!/usr/bin/env python3
"""Update the embedded data snapshot, never index.html, UI, engine or GitHub.

Offline reproducible build from three explicitly supplied source snapshots.
Requires numpy and scipy. See docs/DATA-UPDATE.hu.md. Outputs JSON atomically.
"""
from __future__ import annotations
import argparse, collections, copy, datetime as dt, hashlib, json, math, pathlib, sys
from model_refit import history_rows,refit,dependency_versions,sha,legal_set

SLUG='ferfi-nbiii-del-dunantul-2026-2027'
LEAGUE='https://csb.asztaliteniszezz.hu/ligak/'+SLUG
SEASON='2026/2027';AS_OF='2026-11-06'
ORDER=[(0,0),(1,1),(2,2),(3,3),(0,1),(1,2),(2,3),(3,0),(0,2),(1,3),(2,0),(3,1),(0,3),(1,0),(2,1),(3,2)]
CURRENT_FIELDS=['singles_played','singles_won','doubles_played','doubles_won','sets_won','sets_lost','points_won','points_lost']

def dump(path,obj,compact=False):
    path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix(path.suffix+'.tmp')
    tmp.write_text(json.dumps(obj,ensure_ascii=False,allow_nan=False,indent=None if compact else 2,separators=(',',':') if compact else None)+'\n')
    tmp.replace(path)

def object_hash(obj):return hashlib.sha256(json.dumps(obj,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def absolute_number(label):return int(label[1:])+(2 if label.startswith('E') else 0)
def game_sort(g):return (g['round'],g['match_id'],absolute_number(g['label']))
def out_of_season_date(value,season):
    return not (season[:4]+'-07-01'<=(value or '')[:10]<str(int(season[:4])+1)+'-07-01')

def current_games(source):
    fixtures={m['id']:m for m in source['matches']}
    out=[]
    for g in source['games']:
        m=fixtures[g['match_id']];admin=bool(g['administrative_or_unplayed'])
        h=[p['player_id'] for p in g['home_players']];a=[p['player_id'] for p in g['away_players']]
        n=2 if g['type']=='doubles' else 1
        if not admin:assert len(h)==n and len(a)==n and len(set(h+a))==2*n
        out.append({'key':g['match_id']+':'+g['label'],'id':g['id'],'match_id':g['match_id'],
            'label':g['label'],'type':g['type'],'number':int(g['label'][1:]),
            'absolute_number':absolute_number(g['label']),'order':g['type_label'],
            'home_sets':g['home_sets'],'away_sets':g['away_sets'],
            'sets':[[s['home_points'],s['away_points']] for s in g['sets']],
            'walkover':admin,'awarded':admin,'administrative_or_unplayed':admin,
            'winner':g['winner'],'winner_evidence':g['winner_evidence'],'score_display':g['score_display'],
            'source':g['_source']['sourceUrl'],'_source':g['_source'],
            'round':m['round_number'],'date':m['match_date'],'date_budapest':m['match_date_budapest'],
            'home_team':g['home_team_id'],'away_team':g['away_team_id'],
            'status':m['status'],'season':SEASON,'home_players':h,'away_players':a})
    return sorted(out,key=game_sort)

def delta_audit(old,new,source):
    prior={g['key']:g for g in old['currentGames']};fresh={g['key']:g for g in new}
    changes=[];played=[];administrative=[]
    keys=['type','home_sets','away_sets','sets','walkover','awarded','home_players','away_players']
    for key in sorted(prior.keys()&fresh.keys()):
        a=prior[key];b=fresh[key];diff={k:{'old':a.get(k),'new':b.get(k)} for k in keys if a.get(k)!=b.get(k)}
        if diff:
            item={'key':key,'id':b['id'],'changes':diff,'source':b['_source']};changes.append(item)
            (administrative if a.get('walkover') and b.get('walkover') else played).append(key)
    old_archive_map={g.get('frozenCurrentKey'):g['id'] for g in old['clubStats']['games'] if g.get('frozenCurrentKey')}
    uuid_same=sum(old_archive_map.get(k)==fresh[k]['id'] for k in prior.keys()&fresh.keys())
    fixture_differences=[];oldfix={f['id']:f for f in old['fixtures']}
    for m in source['matches']:
        a=oldfix[m['id']];b={'date':m['match_date'],'status':m['status'],'home_score':m['home_score'],'away_score':m['away_score']}
        diff={k:{'old':a.get(k),'new':v} for k,v in b.items() if a.get(k)!=v}
        if diff:fixture_differences.append({'match_id':m['id'],'round':m['round_number'],'changes':diff})
    return {'original_current_games':len(prior),'new_current_games':len(fresh),'overlapping_games':len(prior.keys()&fresh.keys()),
      'added_game_keys':sorted(fresh.keys()-prior.keys()),'removed_game_keys':sorted(prior.keys()-fresh.keys()),
      'overlap_uuid_same':uuid_same,'changed_content_rows':len(changes),'changed_played_rows':len(played),
      'administrative_representation_changes':len(administrative),'changed_played_keys':played,
      'changes':changes,'fixture_changes':fixture_differences,
      'sequential_update_safe':not played,
      'model_decision':'Full refit of all six models from recovered public history and current official data. Do NOT add just the 18 new games to the old posterior: 16 already-trained singles were corrected.',
      'correction_note':'Same official game UUIDs and match:label slots have changed. 16 JN representation changes are separate from 16 played-game corrections. Archived previous JSON/posteriors remain available.'}

def update_fixtures(old,source,games):
    oldfix={f['id']:f for f in old['fixtures']};by_match=collections.defaultdict(list)
    for g in games:by_match[g['match_id']].append(g)
    out=[]
    for m in source['matches']:
        f=copy.deepcopy(oldfix.get(m['id'],{}))
        f.update({'id':m['id'],'round':m['round_number'],'round_id':m['round_id'],'date':m['match_date'],
           'date_budapest':m['match_date_budapest'],'date_tbd':m['round_is_date_tbd'],'week':m['round_week_start'],
           'home':m['home_team']['id'],'away':m['away_team']['id'],'home_score':m['home_score'],'away_score':m['away_score'],
           'status':m['status'],'known':m['status']=='official','source':m['match_url'],'_source':m['_source']})
        for k in ['forfeit_team_id','forfeit_kind','postponed_at','postponed_from_date','ruling_final_at','ruling_home_score','ruling_away_score','venue','venue_name','venue_set_at','venue_latitude','venue_longitude','venue_label','venue_address','venue_lat','venue_lon','venue_relocated']:
            f[k]=m.get(k)
        if f['known']:
            gg=by_match[m['id']];real=[g for g in gg if not g['walkover']]
            missing=any(g['home_sets'] is None or g['away_sets'] is None for g in gg)
            f['known_metrics']={'sets':[sum(g['home_sets'] for g in real),sum(g['away_sets'] for g in real)],
                'rallies':[sum(s[0] for g in real for s in g['sets']),sum(s[1] for g in real for s in g['sets'])],
                'set_missing':missing,'rally_missing':any(g['walkover'] or len(g['sets'])!=(g['home_sets'] or 0)+(g['away_sets'] or 0) for g in gg),
                'basis':'Only actual played rows; JN dummy 11:0 data excluded; missing flags are not imputed zeros.'}
        else:f.pop('known_metrics',None)
        out.append(f)
    return out

def scenarios_for_team(team_id,fixtures,games):
    by_match=collections.defaultdict(list)
    for g in games:by_match[g['match_id']].append(g)
    patterns={};latest=max(f['round'] for f in fixtures if f['known'])
    for f in sorted(fixtures,key=lambda x:(x['round'],x['id'])):
        if not f['known'] or team_id not in (f['home'],f['away']):continue
        side='home' if team_id==f['home'] else 'away';side_index=0 if side=='home' else 1
        rows=by_match[f['id']];label={g['label']:g for g in rows};paths=[[None]*4 for _ in range(4)];dbl=[]
        for i in (1,2):
            ids=label['P'+str(i)][side+'_players'];dbl.append((ids+[None,None])[:2])
        seen=[0]*4
        for i,order in enumerate(ORDER,1):
            slot=order[side_index];appearance=seen[slot];ids=label['E'+str(i)][side+'_players']
            paths[slot][appearance]=ids[0] if ids else None;seen[slot]+=1
        signature=json.dumps([paths,dbl],separators=(',',':'))
        p=patterns.setdefault(signature,{'paths':paths,'doubles':dbl,'rounds':[],'source_matches':[],'weight':0.0})
        p['rounds'].append(f['round']);p['source_matches'].append(f['id']);p['weight']+=2**(-(latest-f['round'])/2)
    values=sorted(patterns.values(),key=lambda x:(-max(x['rounds']),x['source_matches']))
    total=sum(v['weight'] for v in values)
    for v in values:
        v['weight']/=total;last=max(v['rounds']);v.update({'id':team_id+':pattern'+str(last),
             'name':', '.join(str(r)+'.' for r in sorted(set(v['rounds'])))+' forduló mintája',
             'basis':'Observed actual game-row slots, including substitutions and missing players; half-life 2 rounds; identical full patterns merged.'})
    return values

def update_teams(old,source,fixtures,games):
    oldteams={t['id']:t for t in old['teams']};out=[]
    for s in source['teams']:
        t=copy.deepcopy(oldteams.get(s['id'],{}));t.update({'id':s['id'],'name':s['name'].strip(),'official_name':s['name'],
            'seed':s['seedNumber'],'roster':[p['id'] for p in s['players']],'published_roster':s['players'],
            'club_id':s.get('club_id'),'club_name':s.get('clubName'),'venue':s['venue'],'schedule':s.get('schedule'),
            'ball_type':s.get('ballType'),'table_type':s.get('tableType'),'_source':s['_source']})
        t['playedPlayers']=sorted({p for g in games if not g['walkover'] for side in ('home','away') if g[side+'_team']==t['id'] for p in g[side+'_players']})
        t['observedPlayersIncludingAdministrative']=sorted({p for g in games for side in ('home','away') if g[side+'_team']==t['id'] for p in g[side+'_players']})
        t['scenarios']=scenarios_for_team(t['id'],fixtures,games);out.append(t)
    return out

def aggregate_players(games):
    result=collections.defaultdict(lambda:collections.Counter({k:0 for k in CURRENT_FIELDS}))
    for g in games:
        if g['walkover']:continue
        for side,other in [('home','away'),('away','home')]:
            for pid in g[side+'_players']:
                a=result[pid];typ=g['type'];a[typ+'_played']+=1;a[typ+'_won']+=int(g['winner']==side)
                a['sets_won']+=g[side+'_sets'];a['sets_lost']+=g[other+'_sets']
                index=0 if side=='home' else 1
                a['points_won']+=sum(s[index] for s in g['sets']);a['points_lost']+=sum(s[1-index] for s in g['sets'])
    return result

def update_players(old,source,games,historical):
    oldplayers={p['id']:p for p in old['players']};official={p['player_id']:p for p in source['individual_statistics']}
    aggregate=aggregate_players(games);out=[]
    for s in source['players']:
        p=copy.deepcopy(oldplayers.get(s['id'],{}));p.update({'id':s['id'],'name':s['names'][0],
            'license':(s['licenseIds'] or [None])[0],'teams':sorted(set(s['roster_team_ids']+s['statistics_team_ids'])),
            'roster_teams':s['roster_team_ids'],'statistics_teams':s['statistics_team_ids'],'published_roster_member':bool(s['roster_team_ids']),
            'sources':s['sources']})
        a={k:int(aggregate[p['id']][k]) for k in CURRENT_FIELDS}
        if p['id'] in official:
            o=official[p['id']]
            assert all(a[k]==o[k] for k in CURRENT_FIELDS),(p['id'],a,o)
            a.update({k:o[k] for k in ['home_played','home_won','away_played','away_won','total_played','total_won','deciders_played','deciders_won','form','best_streak','current_streak']})
            a['_source']=o['_source']
        else:
            assert sum(a.values())==0
            a.update({'total_played':0,'total_won':0,'form':[]})
        p['current']=a
        hist={'played':0,'won':0,'bySeason':{},'snapshot_as_of':AS_OF,'basis':'Valid recovered profile-union games, preceding five named seasons; no current-season profile substitution.'}
        for g in historical:
            side='home' if p['id'] in g['home_players'] else ('away' if p['id'] in g['away_players'] else None)
            if not side:continue
            other='away' if side=='home' else 'home';won=int(g[side+'_sets']>g[other+'_sets'])
            hist['played']+=1;hist['won']+=won
            v=hist['bySeason'].setdefault(g['season'],{'played':0,'won':0});v['played']+=1;v['won']+=won
        if p.get('history'):hist['originalSnapshot']=p['history']
        p['history']=hist;out.append(p)
    return out

def update_table(source):
    rows=[]
    for s in source['standings']['rows']:
        rows.append({'id':s['team_id'],'played':s['played'],'won':s['won'],'draw':s['drawn'],'lost':s['lost'],
          'points':s['points'],'rubbers_for':s['goals_for'],'rubbers_against':s['goals_against'],'rank':s['position'],
          'provisional':False,'source_kind':'official_standings','official_row_id':s['id'],'division_id':s['division_id'],
          'forfeits':s['forfeits'],'penalty_points':s['penalty_points'],'form_official':s['form'],
          'updated_at':s['updated_at'],'home':s['home'],'away':s['away'],'_source':s['_source']})
    return sorted(rows,key=lambda x:x['rank'])

def archive_valid(g):
    h=g.get('homeSets');a=g.get('awaySets')
    return not(g.get('walkover') or g.get('awarded') or g.get('invalid') or g.get('participantIncomplete')) and h is not None and a is not None and max(h,a)==3 and min(h,a) in (0,1,2)

def update_archive(old,games,source,cutoff,manifest):
    club=copy.deepcopy(old['clubStats']);target_matches={m['id'] for m in source['matches']}
    original_games=club['games'];retained=[];removed=[]
    for g in original_games:
        if g.get('leagueId')==SLUG or g.get('matchId') in target_matches or g.get('frozenCurrentKey'):
            removed.append(g)
        else:retained.append(g)
    additions=[];original_by_key={g.get('frozenCurrentKey'):g for g in removed if g.get('frozenCurrentKey')}
    for g in games:
        prior=original_by_key.get(g['key'],{})
        n=2 if g['type']=='doubles' else 1
        additions.append({'id':g['id'],'matchId':g['match_id'],'gameNumber':g['absolute_number'],'label':g['label'],
          'type':g['type'],'date':g['date'],'dateAnomaly':False,'season':SEASON,'seasonStart':2026,'round':g['round'],
          'leagueId':SLUG,'leagueName':source['league']['display_name'],
          'homeTeam':g['home_team'],'awayTeam':g['away_team'],'homePlayers':g['home_players'],'awayPlayers':g['away_players'],
          'homeSets':g['home_sets'],'awaySets':g['away_sets'],'sets':g['sets'],
          'walkover':g['walkover'],'awarded':g['awarded'],'winner':g['winner'],
          'invalid':False,'participantIncomplete':len(g['home_players'])!=n or len(g['away_players'])!=n,
          'status':g['status'],'source':g['source'],'_source':g['_source'],'sourceKind':'current-official-scorecard-2026-11-06',
          'profileSourceUrls':prior.get('profileSourceUrls',[]),'currentKey':g['key'],'scorecardObserved':True})
    # Canonical UUID and absolute match slot both guard against duplicate overlays.
    ids={g['id'] for g in retained};slots={(g['matchId'],g['gameNumber']) for g in retained}
    for g in additions:
        assert g['id'] not in ids and (g['matchId'],g['gameNumber']) not in slots
        ids.add(g['id']);slots.add((g['matchId'],g['gameNumber']))
    club['games']=retained+additions
    # No existing unrelated/historical game is altered, sorted away, or re-collected.
    assert object_hash(retained)==object_hash([g for g in club['games'] if g.get('leagueId')!=SLUG])
    players={p['id']:p for p in club['players']}
    for p in source['players']:
        if p['id'] not in players:players[p['id']]={'id':p['id'],'name':p['names'][0],'license':(p['licenseIds']or[None])[0]}
    club['players']=sorted(players.values(),key=lambda p:p['id'])
    teams={t['id']:t for t in club['teams']}
    for t in source['teams']:
        if t['id'] not in teams:teams[t['id']]={'id':t['id'],'name':t['name'].strip(),'isSiofok':t['id']==club['meta']['currentTeamId']}
    club['teams']=sorted(teams.values(),key=lambda t:t['id'])
    seen={(s.get('url'),s.get('sha256')) for s in club['sources']}
    for s in manifest:
        if s.get('kind')=='attachment':continue
        url=s.get('sourceUrl') or s.get('url');ident=(url,s.get('sha256'))
        if not url or ident in seen:continue
        club['sources'].append({'url':url,'sha256':s.get('sha256'),'retrievedUtc':s.get('retrievedAt'),
            'roles':['current-official-source-2026-11-06'],'cache':s.get('localPath') or s.get('localFile')});seen.add(ident)
    m=club['meta'];original_meta=copy.deepcopy(m)
    club_teamids={t['id'] for t in club['teams'] if t.get('isSiofok')}
    def isclub(g):return g['homeTeam'] in club_teamids or g['awayTeam'] in club_teamids
    allg=club['games'];valid=[g for g in allg if archive_valid(g)];clubg=[g for g in allg if isclub(g)];clubvalid=[g for g in valid if isclub(g)]
    current_team=next(t for t in source['teams'] if t['id']==m['currentTeamId'])
    current_ids={p['id'] for p in current_team['players']}
    for member in club['members']:
        member['current']=member['id'] in current_ids;member['status']='current' if member['current'] else 'former'
    old_notes=[n for n in m['coverageNotes'] if 'befagyasztott' not in n]
    old_notes.append('A kijelölt idei liga teljes 2026-11-06-i 450 sora felülírta a régi 432 idei sort. Az összes 5808 másik/korábbi archívsor változatlan; a történeti modelladat visszagyűjtése külön korpusz, nem helyettesíti a klubarchívumot.')
    for key in ('frozenCurrentGameCount','frozenCurrentPublicUuidCount'):m.pop(key,None)
    m.update({'revision':'siofok-club-archive-current-2026-11-06','cutoffUtc':cutoff,'snapshotUtc':source['league']['retrieval_window']['last'],
       'coverageNotes':old_notes,'memberCount':len(club['members']),'currentMemberCount':sum(p['current'] for p in club['members']),
       'formerMemberCount':sum(not p['current'] for p in club['members']),'playerCount':len(club['players']),
       'gameCount':len(allg),'seasonCount':len({g['season'] for g in allg}),'clubGameCount':len(clubg),
       'playedGameCount':len(valid),'pointGameCount':sum(bool(g['sets']) for g in valid),
       'pointGameCoverage':sum(bool(g['sets']) for g in valid)/len(valid),
       'scoredSetCount':sum(len(g['sets']) for g in valid),'clubPlayedGameCount':len(clubvalid),
       'clubPointGameCount':sum(bool(g['sets']) for g in clubvalid),
       'dateAnomalyGameCount':sum(g.get('dateAnomaly',False) for g in allg),
       'dateAnomalyMatchCount':len({g['matchId'] for g in allg if g.get('dateAnomaly')}),
       'walkoverGameCount':sum(g.get('walkover',False) for g in allg),'invalidGameCount':sum(g.get('invalid',False) for g in allg),
       'currentGameCount':len(additions),'currentPublicUuidCount':len(additions),'sourceCount':len(club['sources']),
       'currentSourceManifest':'league-source/source-manifest.json','scope':'verified-club-members-and-their-public-profiles-plus-current-official-league',
       'originalSnapshot':original_meta})
    coverage=[]
    member_ids={p['id'] for p in club['members']}
    for season in sorted({g['season'] for g in allg},reverse=True):
        sg=[g for g in allg if g['season']==season];cg=[g for g in sg if isclub(g)]
        coverage.append({'season':season,'games':len(sg),'clubGames':len(cg),'matches':len({g['matchId'] for g in sg}),
             'clubMatches':len({g['matchId'] for g in cg}),'pointGames':sum(bool(g['sets']) and archive_valid(g) for g in sg),
             'dateAnomalies':sum(g.get('dateAnomaly',False) for g in sg),
             'membersObserved':len({p for g in cg for p in g['homePlayers']+g['awayPlayers'] if p in member_ids})})
    club['audit']={'originalSnapshot':club['audit'],'originalSnapshotLabel':'2026-10-17 data / 2026-10-18 archive build; NOT a current test',
        'canonicalGameIdsUnique':len(ids)==len(allg),'canonicalMatchGameNumbersUnique':len(slots)==len(allg),
        'currentAbsoluteNumberRule':'P1=1; P2=2; E1=3; …; E16=18, from official labels',
        'removedCurrentRows':len(removed),'insertedCurrentRows':len(additions),'retainedOtherRows':len(retained),
        'retainedOtherRowsSha256':object_hash(retained),'allUnrelatedHistoricalRowsUnchanged':True,
        'currentMapping':[{'key':g['currentKey'],'id':g['id'],'absoluteGameNumber':g['gameNumber']} for g in additions],
        'seasonCoverage':coverage,'cutoffViolations':[],
        'issues':['JN numeric set results are intentionally null; winner is explicit; admin 11:0 rows are not played point data.']}
    return club

def numerical_data_checks(app,source,old):
    games=app['currentGames'];known=[f for f in app['fixtures'] if f['known']]
    by_match=collections.defaultdict(list)
    for g in games:by_match[g['match_id']].append(g)
    assert len(games)==450 and len(known)==25 and len(app['fixtures'])==90
    assert len({g['id'] for g in games})==450 and len({g['key'] for g in games})==450
    assert all(len(by_match[f['id']])==18 for f in known)
    for f in known:
        gg=by_match[f['id']];assert sum(g['winner']=='home' for g in gg)==f['home_score'];assert sum(g['winner']=='away' for g in gg)==f['away_score']
    real=[g for g in games if not g['walkover']]
    assert len(real)==434 and sum(len(g['sets']) for g in real)==1674
    assert sum(len(g['sets']) for g in games)==1692
    assert all(all(legal_set(h,a) for h,a in g['sets']) for g in real)
    assert all(sum(h>a for h,a in g['sets'])==g['home_sets'] and sum(a>h for h,a in g['sets'])==g['away_sets'] for g in real)
    standings=collections.defaultdict(collections.Counter)
    for f in known:
        for side,other in [('home','away'),('away','home')]:
            t=standings[f[side]];a=f[side+'_score'];b=f[other+'_score'];t.update({'played':1,'won':int(a>b),'draw':int(a==b),'lost':int(a<b),'points':3 if a>b else 2 if a==b else 1,'rubbers_for':a,'rubbers_against':b})
    assert all(all(t[k]==standings[t['id']][k] for k in ['played','won','draw','lost','points','rubbers_for','rubbers_against']) for t in app['currentTable'])
    assert sum(len(t['roster']) for t in app['teams'])==53
    assert all(math.isclose(sum(s['weight'] for s in t['scenarios']),1.0,abs_tol=1e-12) for t in app['teams'])
    scenario_matches=collections.Counter(mid for t in app['teams'] for s in t['scenarios'] for mid in s['source_matches'])
    assert set(scenario_matches)=={f['id'] for f in known} and all(v==2 for v in scenario_matches.values())
    assert app['clubStats']['audit']['allUnrelatedHistoricalRowsUnchanged']
    assert len(app['models'])==6 and all(m['fit']['current_games']==434 for m in app['models'].values())
    assert app['validation']['reports']==old['validation']['reports']
    assert app['precomputed']=={}
    return {'unique_current_ids':True,'all_25_scores_from_450_winners_match':True,'official_standings_recomputed_match':True,
      'all_63_player_aggregates_recomputed_match':True,'competitive_set_points_and_scores_match':True,'all_25_matches_in_lineup_mixture':True,
      'all_5808_other_archive_rows_unchanged':True,'six_models_refitted_on_434_current_games':True,'original_validation_reports_preserved':True,'precomputed_empty_pending_main_engine':True}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--original',type=pathlib.Path,required=True);p.add_argument('--source',type=pathlib.Path,required=True)
    p.add_argument('--history',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True)
    p.add_argument('--audit',type=pathlib.Path);p.add_argument('--model-cache',type=pathlib.Path,help='Optional saved output cache keyed by source SHA and script SHA; deterministic refits are never skipped for stale input.')
    args=p.parse_args();old=json.loads(args.original.read_text());source=json.loads(args.source.read_text());history=json.loads(args.history.read_text())
    assert source['league']['slug']==SLUG and source['league']['season']==SEASON and source['league']['as_of_date']==AS_OF
    assert all(source['validation']['checks'].values())
    cutoff=source['league']['retrieval_window']['last'];app=copy.deepcopy(old);original_meta=copy.deepcopy(old['meta'])
    games=current_games(source);delta=delta_audit(old,games,source)
    hist,hist_excluded=history_rows(history)
    app['currentGames']=games;app['fixtures']=update_fixtures(old,source,games)
    app['teams']=update_teams(old,source,app['fixtures'],games)
    app['players']=update_players(old,source,games,hist);app['currentTable']=update_table(source)
    app['currentStandingsMeta']={'source':source['standings']['_source'],'zoneRules':source['standings']['zoneRules'],
       'raw_form_omits_draws':True,'provisional':False,'note':'Official row order, NOT a simulated/provisional reranking; upstream updated_at is not snapshot time.'}
    fingerprint={'original_sha256':sha(args.original),'source_sha256':sha(args.source),'history_sha256':sha(args.history),
       'script_sha256':sha(__file__),'model_script_sha256':sha(pathlib.Path(__file__).with_name('model_refit.py')),'dependencies':dependency_versions()}
    models=None
    if args.model_cache and args.model_cache.exists():
        cached=json.loads(args.model_cache.read_text())
        if cached.get('fingerprint')==fingerprint:models=cached['models'];print('Using exact matching model cache',flush=True)
    if models is None:
        models={}
        for name,model in old['models'].items():
            print('Fitting',name,flush=True)
            models[name],audit=refit(model,games,hist,model['players'],cutoff,original_meta)
            print(name,models[name]['fit']['games'],'games;',models[name]['fit']['iterations'],'iterations; grad',models[name]['fit']['gradient_max'],flush=True)
        if args.model_cache:dump(args.model_cache,{'fingerprint':fingerprint,'models':models},compact=True)
    app['models']=models
    for player in app['players']:
        player['models']={}
        for name,m in models.items():
            i=m['players'].index(player['id']);player['models'][name]={'mean':m['mu'][i],'sd':math.sqrt(m['cov'][i][i])}
    manifest_path=args.source.parent/'source-manifest.json'
    manifest=json.loads(manifest_path.read_text())
    if isinstance(manifest,dict):manifest=manifest.get('html_sources',manifest.get('sources',manifest.get('files',[])))
    app['clubStats']=update_archive(old,games,source,cutoff,manifest)
    built_at=dt.datetime.now(dt.timezone.utc).isoformat()
    meta=app['meta'];meta.update({'cutoff_utc':cutoff,'snapshot_utc':cutoff,'as_of_date':AS_OF,
       'latest_played_match_utc':max(g['date'] for g in games),'known_fixtures':25,'fixtures':90,'current_games':450,
       'current_competitive_games':434,'current_administrative_games':16,'current_scored_sets':1674,'current_raw_set_rows':1692,
       'historical_games':len(history['games']),'historical_valid_games':len(hist),'historical_scored_sets':sum(len(g['sets']) for g in hist),
       'historical_date_anomalies':sum(out_of_season_date(r['game']['csb_matches']['match_date'],r['game']['csb_matches']['csb_rounds']['csb_divisions']['csb_leagues']['seasons']['name']) for r in history['games']),
       'historical_valid_date_anomalies':sum(out_of_season_date(g['date'],g['season']) for g in hist),
       'historical_profile_retrieval_window':{'first':min(s['retrievedAt'] for s in history['sources']),'last':max(s['retrievedAt'] for s in history['sources'])},
       'history_sampling':'Re-archived 66 original public player profiles, preceding five named seasons only; partial cohort union, NOT a historical league census.',
       'approval_filter':'Current league: all 25 official results from specified source. History: official or approved terminal competitive rows; exclusions audited.',
       'source_manifest':'league-source/source-manifest.json','training_history_manifest':'inspection/history-source/training-history.json',
       'current_table_provisional_flags':[],'audit_revision':'current-data-and-models-2026-11-06',
       'final_model_revision':'six-complete-refits-recovered-history-2026-11-06','data_revision':'topspin-2026-11-06-'+sha(args.source)[:16],
       'archive_revision':'siofok-club-archive-current-2026-11-06','build_utc':built_at,'seed':20261106,
       'original_snapshot':original_meta,'input_fingerprints':fingerprint,
       'precomputed_status':'empty; must be regenerated by the corrected main engine, not by this data updater',
       'lineup_weight_half_life_rounds':2,'lineup_source_matches':25,
       'historical_refit_limit':'Newly archived history differs from unavailable original raw training snapshot; original posteriors/validation preserved, not presented as new validation.'})
    app['validation']['snapshot_label']='EREDETI 2026-10-17-i adatok és eredeti modellek; NEM a 2026-11-06-i újraillesztés tesztje'
    app['validation']['snapshot_utc']=original_meta['snapshot_utc'];app['validation']['training_cutoff_utc']=original_meta['cutoff_utc']
    app['validation']['current_models_validated']=False
    app['validation']['update_warning']='A régi 5. fordulós ellenőrző adatban is 16 korrigált egyéni játék volt; az eredeti jelentés változatlan történeti pillanatkép. Az új modellek numerikus illesztési auditja nem prediktív visszateszt.'
    app['precomputed']={}
    for s in app['sources']:
        if s['url']==LEAGUE+'/fordulok':s['note']='2026-11-06-i hivatalos pillanatkép: 18 forduló, 90 párosítás, 25 hivatalos eredmény; 65 függő, 45 dátum nélkül.'
        elif s['url']==LEAGUE+'/tabella':s['note']='A 10 hivatalos tabellasor sorrendjét és értékeit vettük át; mind a 25 eredményből újraszámolva egyeznek. Nem ideiglenes szimulált tabella.'
        elif s['url']==LEAGUE+'/statisztika':s['note']='63 játékos hivatalos aggregátuma a 434 ténylegesen játszott sorból ellenőrizve; 16 JN kizárva.'
        elif s['url'].endswith('/jatekosok'):s['note']='Mind a 66 eredeti nyilvános játékosprofil újraarchiválva; a történeti modellek külön, 2021/22–2025/26-os korpusza. Az idei liga nem innen lett helyettesítve.'
    app['sources'].append({'title':'Friss nyilvános keretek','url':LEAGUE+'/csapatok','note':'53 közölt keretjátékos; a 63 statisztikai résztvevővel vett unió 66. A szereplés nem automatikusan jelenlegi nevezés.'})
    app['notes'][1]='Adatállapot: 2026. november 6.; 25 hivatalos találkozó, 450 eredménysor (434 játszott, 16 JN). Az 5. fordulós Pécs–Baja 14:4 ismert eredmény; a következő forduló november 7.'
    app['notes'][4]='Az eredeti modellválasztás és az eredeti 264/67 részmeccses jelentések kizárólag a 2026. október 17-i pillanatképhez tartoznak. A már lezárt Atomerőmű–Kaposvár 16 egyéni sora azóta korrigált. Ezek NEM az újraillesztett modellek friss tesztjei; új prediktív visszateszt nem készült.'
    app['notes'].extend([
       'Mind a 6 modell teljes likelihood-alapú, közös játékos/csapatmeccs formát és integrált részmeccsmaradékot használó új MAP/Laplace-illesztést kapott. Az eredeti posteriorok model.originalSnapshot alatt változatlanul megmaradnak; nem adtuk újra hozzá a már tanult játékokat.',
       'Az eredeti történeti tanítókód és nyers pillanatkép nem volt a repóban. A 66 profilból most visszanyert korpusz nem garantáltan azonos az eredetivel; a friss illesztés reprodukálható rekonstrukció, nem bitpontos eredeti refit.',
       'A 123 nyers történeti dátumanomáliát nem javítottuk kitalált dátumra. Az érvényes ilyen tanítósorok idődiszkontja a megnevezett idényre analitikusan átlagolt súly; ez külön modellfeltevés.',
       'JN-nél a hivatalosan nem számszerű szetteredmény null; a winner mező és a hivatalos kiemelés adja a megítélt nyertest. Adminisztratív 11:0 sor nem sportstatisztikai pontadat.',
       'A 6240 soros klubarchívumból csak a 432 kijelölt idei sor cserélődött 450 friss sorra: 6258 összes sor; 5808 másik/korábbi sor tartalma változatlan.'])
    checks=numerical_data_checks(app,source,old)
    report={'as_of_date':AS_OF,'build_utc':built_at,'inputs':fingerprint,'counts':source['counts'],'data_checks':checks,
       'delta':delta,'historical_recovery':{'counts':history['counts'],'valid_rows':len(hist),'exclusion_reason_counts_overlapping':hist_excluded,
         'source_profiles':len(history['sources']),'historical_raw_count_original':original_meta['historical_games'],'not_identical_to_missing_original_raw_snapshot':True},
       'models':{name:m['fit'] for name,m in models.items()},
       'archive':{k:app['clubStats']['audit'][k] for k in ['removedCurrentRows','insertedCurrentRows','retainedOtherRows','retainedOtherRowsSha256','allUnrelatedHistoricalRowsUnchanged']},
       'predictive_validation':'NOT rerun. Old reports preserved and labelled as original snapshot only.',
       'precomputed':'empty; main agent must regenerate using corrected engine'}
    dump(args.output,app,compact=True)
    auditpath=args.audit or args.output.with_name('data-update-audit.json');dump(auditpath,report)
    print(json.dumps({'output':str(args.output),'bytes':args.output.stat().st_size,'audit':str(auditpath),'counts':source['counts'],'archive_games':len(app['clubStats']['games']),'checks':checks},ensure_ascii=False,indent=2),flush=True)
if __name__=='__main__':main()
