#!/usr/bin/env python3
"""Independent offline consistency and numerical regression tests.
This is NOT predictive model calibration or a new holdout backtest.
"""
from __future__ import annotations
import argparse, collections, json, math, pathlib, sys, unittest
import numpy as np
from scipy.integrate import quad
from scipy.special import expit
from model_refit import log_setwin,Likelihood,observation_weight,date

ROOT=pathlib.Path(__file__).resolve().parents[2]
parser=argparse.ArgumentParser();parser.add_argument('--original',type=pathlib.Path,default=ROOT/'inspection/app-data.json')
parser.add_argument('--updated',type=pathlib.Path,default=ROOT/'inspection/app-data.updated.json')
parser.add_argument('--source',type=pathlib.Path,default=ROOT/'league-source/league-data.json')
args,unused=parser.parse_known_args()
OLD=json.loads(args.original.read_text());NEW=json.loads(args.updated.read_text());SRC=json.loads(args.source.read_text())

class DataUpdateTests(unittest.TestCase):
    def test_counts_and_only_official_source_current(self):
        self.assertEqual(len(NEW['currentGames']),450)
        self.assertEqual(sum(not g['walkover'] for g in NEW['currentGames']),434)
        self.assertEqual(sum(len(g['sets']) for g in NEW['currentGames'] if not g['walkover']),1674)
        self.assertEqual(sum(len(g['sets']) for g in NEW['currentGames']),1692)
        self.assertEqual({g['id'] for g in NEW['currentGames']},{g['id'] for g in SRC['games']})
        self.assertEqual(len({g['id'] for g in NEW['currentGames']}),450)
        self.assertEqual(len({g['key'] for g in NEW['currentGames']}),450)
    def test_known_outcomes_and_table(self):
        gg=collections.defaultdict(list)
        for g in NEW['currentGames']:gg[g['match_id']].append(g)
        for f in NEW['fixtures']:
            self.assertEqual(f['known'],f['status']=='official')
            if f['known']:
                self.assertEqual(len(gg[f['id']]),18)
                self.assertEqual(sum(g['winner']=='home' for g in gg[f['id']]),f['home_score'])
                self.assertEqual(sum(g['winner']=='away' for g in gg[f['id']]),f['away_score'])
        p=next(f for f in NEW['fixtures'] if f['id']=='8400489b-bb6d-426e-82e5-02999706fa14')
        self.assertEqual((p['home_score'],p['away_score']),(14,4))
        self.assertEqual(sum(f['date'] is None for f in NEW['fixtures']),45)
        self.assertEqual(next(f for f in NEW['fixtures'] if f['id']=='fcba06c3-bd88-48a4-b11a-574c3db053fa')['date'],'2026-11-22T10:00:00+00:00')
        self.assertEqual([(t['id'],t['rank'],t['points']) for t in NEW['currentTable']],[(t['team_id'],t['position'],t['points']) for t in SRC['standings']['rows']])
        self.assertTrue(all(not t['provisional'] for t in NEW['currentTable']))
    def test_jn_not_synthetic_sets(self):
        jn=[g for g in NEW['currentGames'] if g['walkover']]
        self.assertEqual(len(jn),16)
        self.assertTrue(all(g['home_sets'] is None and g['away_sets'] is None for g in jn))
        self.assertTrue(all(g['winner']=='home' and g['awarded'] for g in jn))
        self.assertEqual(sum(bool(g['sets']) for g in jn),6)
    def test_public_rosters_separate_from_appearances(self):
        self.assertEqual(sum(len(t['roster']) for t in NEW['teams']),53)
        self.assertEqual(len(NEW['players']),66)
        self.assertEqual(sum(p['current']['total_played']>0 for p in NEW['players']),63)
        self.assertEqual(sum(not p['published_roster_member'] for p in NEW['players']),13)
    def test_lineups_all_closed_games(self):
        counts=collections.Counter()
        for t in NEW['teams']:
            self.assertAlmostEqual(sum(s['weight'] for s in t['scenarios']),1.,places=12)
            for s in t['scenarios']:
                self.assertEqual([len(p) for p in s['paths']],[4]*4)
                self.assertEqual([len(p) for p in s['doubles']],[2]*2)
                for mid in s['source_matches']:counts[mid]+=1
        self.assertEqual(set(counts),{f['id'] for f in NEW['fixtures'] if f['known']})
        self.assertTrue(all(c==2 for c in counts.values()))
    def test_archive_complete_historical_preservation(self):
        original=[g for g in OLD['clubStats']['games'] if g['season']!='2026/2027']
        updated=[g for g in NEW['clubStats']['games'] if g['season']!='2026/2027']
        self.assertEqual(original,updated)
        self.assertEqual(len(original),5808)
        self.assertEqual(len(NEW['clubStats']['games']),6258)
        self.assertEqual(len({g['id'] for g in NEW['clubStats']['games']}),6258)
        self.assertEqual(len({(g['matchId'],g['gameNumber']) for g in NEW['clubStats']['games']}),6258)
        self.assertEqual(NEW['clubStats']['meta']['cutoffUtc'],NEW['meta']['cutoff_utc'])
    def test_original_posteriors_and_validation_preserved(self):
        self.assertEqual(set(NEW['models']),set(OLD['models']))
        for name,m in NEW['models'].items():
            for k,v in OLD['models'][name].items():self.assertEqual(m['originalSnapshot'][k],v)
        self.assertEqual(NEW['validation']['reports'],OLD['validation']['reports'])
        self.assertFalse(NEW['validation']['current_models_validated'])
        self.assertEqual(NEW['precomputed'],{})
    def test_new_fit_and_full_covariances(self):
        for name,m in NEW['models'].items():
            d=len(m['players'])+len(m['pairs'])+1
            mu=np.asarray(m['mu']);cov=np.asarray(m['cov'])
            self.assertEqual(mu.shape,(d,));self.assertEqual(cov.shape,(d,d))
            self.assertTrue(np.isfinite(mu).all() and np.isfinite(cov).all())
            self.assertLess(np.max(np.abs(cov-cov.T)),1e-12)
            self.assertGreater(np.linalg.eigvalsh(cov).min(),0)
            self.assertEqual(m['fit']['current_games'],434)
            self.assertTrue(m['fit']['converged'])
            self.assertLess(m['fit']['gradient_max'],.005)
            self.assertEqual(m['fit']['through_round'],5)
            self.assertEqual(m['fit']['training_cutoff_utc'],NEW['meta']['cutoff_utc'])
            audit=m['fit']['audit']
            self.assertLess(audit['quadrature_max_loglik_abs_difference'],2e-6)
            self.assertLess(audit['hessian_vector_relative_error'],2e-5)
            self.assertLess(audit['full_inverse_selected_columns_max_residual'],1e-7)
            for player in NEW['players']:
                i=m['players'].index(player['id'])
                self.assertAlmostEqual(player['models'][name]['mean'],mu[i],places=12)
                self.assertAlmostEqual(player['models'][name]['sd'],math.sqrt(cov[i,i]),places=12)
    def test_exact_stopped_set_probability_and_derivatives(self):
        eta=np.linspace(-6,6,31);logq,a,b=log_setwin(eta);h=1e-5
        self.assertLess(np.max(abs(np.exp(logq)+np.exp(log_setwin(-eta)[0])-1)),3e-14)
        self.assertLess(np.max(abs(a-(log_setwin(eta+h)[0]-log_setwin(eta-h)[0])/(2*h))),2e-8)
        self.assertLess(np.max(abs(b-(log_setwin(eta+h)[1]-log_setwin(eta-h)[1])/(2*h))),2e-8)
        self.assertAlmostEqual(math.exp(log_setwin(np.array([0.]))[0][0]),.5,places=14)
    def test_residual_integrated_per_rubber_against_adaptive_quad(self):
        game={'home_sets':3,'away_sets':1,'sets':[[11,8],[9,11],[11,5],[11,7]]}
        for family,sd in [('set',.55),('point',.16)]:
            likelihood=Likelihood([game],family,sd)
            for eta in [-.5,0.,.5]:
                answer=likelihood.evaluate(np.array([eta]))[0][0]
                hp=sum(s[0] for s in game['sets']);ap=sum(s[1] for s in game['sets'])
                h,a=(3,1) if family=='set' else (hp,ap)
                center=likelihood.evaluate(np.array([eta]))[0][0]
                def integrand(z):
                    e=eta+sd*z;lp=-np.logaddexp(0,-e);lr=-np.logaddexp(0,e)
                    return math.exp(h*lp+a*lr-center-z*z/2)/math.sqrt(2*math.pi)
                integral,error=quad(integrand,-11,11,epsabs=1e-12,epsrel=1e-12)
                self.assertLess(abs(math.log(integral)),3e-10)
    def test_no_imputed_historical_date(self):
        game={'historical':True,'season':'2022/2023','date':'2022-05-31T22:00:00+00:00','key':'date-anomaly'}
        cutoff=date(NEW['meta']['cutoff_utc']);weight,anomaly=observation_weight(game,cutoff,730)
        self.assertTrue(anomaly)
        lo=date('2022-07-01T00:00:00+00:00');hi=date('2023-07-01T00:00:00+00:00')
        wlo=2**(-(cutoff-lo).total_seconds()/86400/730);whi=2**(-(cutoff-hi).total_seconds()/86400/730)
        self.assertGreater(weight,wlo);self.assertLess(weight,whi)
        self.assertEqual(game['date'],'2022-05-31T22:00:00+00:00')

if __name__=='__main__':unittest.main(argv=[sys.argv[0]]+unused,verbosity=2)
