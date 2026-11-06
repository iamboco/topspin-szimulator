#!/usr/bin/env python3
"""Read-only public player-profile archive for reproducible historical refits.
Current-season rows are never imported from profiles; update_data.py uses the
explicitly designated league snapshot for those. No authentication or writes.
"""
from __future__ import annotations
import argparse, concurrent.futures, datetime as dt, hashlib, json, pathlib, re, urllib.request

def parse_rsc(html):
    chunks=[]
    for script in re.findall(r'<script[^>]*>(.*?)</script>',html,re.S):
        match=re.fullmatch(r'self\.__next_f\.push\((.*)\)',script,re.S)
        if match:
            obj=json.loads(match.group(1))
            if obj[0]==1 and isinstance(obj[1],str): chunks.append(obj[1])
    out={}
    for line in ''.join(chunks).splitlines():
        if ':' not in line: continue
        key,val=line.split(':',1)
        try: out[key]=json.loads(val)
        except json.JSONDecodeError: pass
    return out

def walk(value):
    yield value
    if isinstance(value,dict):
        for v in value.values(): yield from walk(v)
    elif isinstance(value,list):
        for v in value: yield from walk(v)

def profile_games(records):
    matches=[v[3] for v in walk(records) if isinstance(v,list) and len(v)==4 and isinstance(v[3],dict) and 'games' in v[3] and 'playerId' in v[3]]
    if len(matches)!=1: raise ValueError(f'Expected one profile games component, found {len(matches)}')
    return matches[0]

def dump(path,obj):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(obj,ensure_ascii=False,indent=2)+'\n')

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--original',type=pathlib.Path,required=True)
    p.add_argument('--output',type=pathlib.Path,required=True)
    p.add_argument('--fetch',action='store_true',help='Fetch missing pages only; default parses an existing snapshot offline')
    p.add_argument('--workers',type=int,default=3)
    args=p.parse_args();old=json.loads(args.original.read_text());root=args.output;root.mkdir(parents=True,exist_ok=True)
    def collect(player):
        license=player.get('license')
        if not license: raise ValueError('No original public license for '+player['id'])
        url='https://csb.asztaliteniszezz.hu/jatekosok/'+str(license)
        raw=root/'raw'/(str(license)+'.html');meta=raw.with_suffix('.meta.json')
        if not raw.exists():
            if not args.fetch: raise FileNotFoundError(raw)
            at=dt.datetime.now(dt.timezone.utc).isoformat()
            req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 (read-only official sports data audit)'})
            with urllib.request.urlopen(req,timeout=90) as response:
                data=response.read();status=response.status;final=response.url
            raw.parent.mkdir(parents=True,exist_ok=True);raw.write_bytes(data)
            dump(meta,{'url':url,'retrievedAt':at,'httpStatus':status,'finalUrl':final,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)})
        data=raw.read_bytes();provenance=json.loads(meta.read_text())
        assert hashlib.sha256(data).hexdigest()==provenance['sha256']
        pg=profile_games(parse_rsc(data.decode('utf-8')))
        assert pg['playerId']==player['id'],(player['id'],pg['playerId'])
        print(player['name'],len(pg['games']),flush=True)
        return {'playerId':player['id'],'license':license,'source':provenance,'games':pg['games']}
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        results=list(pool.map(collect,old['players']))
    games={};conflicts=[]
    for result in results:
        for game in result['games']:
            if game['id'] in games and games[game['id']]['game']!=game: conflicts.append(game['id'])
            record=games.setdefault(game['id'],{'game':game,'profileSources':[]})
            record['profileSources'].append(result['source']['url'])
    if conflicts: raise ValueError('Conflicting duplicate profile games: '+str(conflicts[:10]))
    hist=[];seasons={}
    for record in games.values():
        g=record['game']
        try: s=g['csb_matches']['csb_rounds']['csb_divisions']['csb_leagues']['seasons']['name']
        except (KeyError,TypeError): s='unknown'
        seasons[s]=seasons.get(s,0)+1
        if s in [f'{year}/{year+1}' for year in range(2021,2026)]: hist.append(record)
    hist.sort(key=lambda x:x['game']['id'])
    output={'scope':'Original 66-player public profile union; historical seasons 2021/2022–2025/2026 only; current league NEVER replaced from profiles',
      'sources':[r['source']|{'playerId':r['playerId'],'license':r['license'],'profileGameCount':len(r['games'])} for r in results],
      'counts':{'profiles':len(results),'allProfileGameRows':sum(len(r['games'])for r in results),'uniqueGamesAllSeasons':len(games),'uniqueGamesBySeason':seasons,'historicalGames':len(hist),'conflicts':len(conflicts)},'games':hist}
    dump(root/'training-history.json',output);print(json.dumps(output['counts'],ensure_ascii=False,indent=2),flush=True)
if __name__=='__main__':main()
