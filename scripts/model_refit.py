#!/usr/bin/env python3
"""Deterministic joint MAP and full marginal observed-information Laplace refits.

No handcrafted rating changes. Current games are taken exclusively from the
specified league snapshot. Public profile history is a distinct historical
corpus, NOT a substitute league. See docs/DATA-UPDATE.hu.md for assumptions.
"""
from __future__ import annotations
import collections, datetime as dt, hashlib, json, math, pathlib, platform
import numpy as np
import scipy
from scipy import sparse
from scipy.optimize import minimize
from scipy.special import expit, logsumexp, gammaln
from scipy.sparse.linalg import splu

REVISION='joint-map-recovered-history-observed-laplace-v1'
CURRENT_HALF_LIFE=180.0
GH_POINTS=41
UTC=dt.timezone.utc

def sha(path):return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
def pair_key(ids):return '|'.join(sorted(ids))
def date(value):return dt.datetime.fromisoformat(value.replace('Z','+00:00')) if value else None

def history_rows(history):
    out=[];excluded=collections.Counter()
    for record in history['games']:
        g=record['game'];m=g['csb_matches'];season=m['csb_rounds']['csb_divisions']['csb_leagues']['seasons']['name']
        n=2 if g['game_type']=='doubles' else 1
        hp=[g[f'home_player{i}_id'] for i in range(1,n+1)];ap=[g[f'away_player{i}_id'] for i in range(1,n+1)]
        reasons=[]
        if g['is_walkover']:reasons.append('walkover')
        if not all(hp+ap) or len(set(hp+ap))!=2*n:reasons.append('incomplete_or_duplicate_players')
        if max(g['home_sets'] or 0,g['away_sets'] or 0)!=3 or min(g['home_sets'] or 0,g['away_sets'] or 0) not in (0,1,2):reasons.append('not_finished_best_of_five')
        if m['status'] not in ('official','approved'):reasons.append('not_approved')
        if reasons:
            excluded.update(reasons);continue
        sets=sorted(g['csb_match_game_sets'],key=lambda s:s.get('set_number',0))
        # Require complete legal point data, never invent points for an old 3:x.
        points=[]
        for s in sets:
            h=s.get('home_points');a=s.get('away_points')
            if h is not None and a is not None:points.append([h,a])
        if not (len(points)==g['home_sets']+g['away_sets'] and sum(h>a for h,a in points)==g['home_sets'] and all(legal_set(h,a) for h,a in points)):points=[]
        out.append({'key':g['id'],'match_id':m['id'],'home_players':hp,'away_players':ap,
            'home_team':m['home_team']['id'],'away_team':m['away_team']['id'],
            'home_sets':g['home_sets'],'away_sets':g['away_sets'],'sets':points,
            'date':m['match_date'],'season':season,'type':g['game_type'],
            'status':m['status'],'source':'https://csb.asztaliteniszezz.hu/merkozesek/'+m['id'],
            'profile_sources':record['profileSources'],'historical':True})
    return out,dict(excluded)

def legal_set(h,a):
    return isinstance(h,int) and isinstance(a,int) and min(h,a)>=0 and ((max(h,a)==11 and min(h,a)<=9) or (max(h,a)>=12 and abs(h-a)==2))

def observation_weight(game,cutoff,history_half_life):
    half=history_half_life if game.get('historical') else CURRENT_HALF_LIFE
    d=date(game['date']);start=int(game['season'][:4]);lo=dt.datetime(start,7,1,tzinfo=UTC);hi=dt.datetime(start+1,7,1,tzinfo=UTC)
    if d and lo<=d<hi and d<=cutoff:
        return 2.0**(-(cutoff-d).total_seconds()/86400.0/half),False
    if not game.get('historical'):raise ValueError('Unreliable current date: '+game['key'])
    # Weight is analytically averaged over the stated season. This is NOT a
    # fabricated observation date, nor a claim about an unobserved skill path.
    k=math.log(2)/half;length=(hi-lo).total_seconds()/86400.0
    age_hi=(cutoff-hi).total_seconds()/86400.0
    return math.exp(-k*age_hi)*(-math.expm1(-k*length))/(k*length),True

LOG_CHOOSE=np.array([math.log(math.comb(10+k,k)) for k in range(10)])

def log_setwin(eta):
    """log g(sigmoid eta), and its first/second eta derivatives, stably.
    g is exact stopped first-to-11 win-by-two (unbounded deuce).
    """
    p=expit(eta);r=1-p;lp=-np.logaddexp(0,-eta);lr=-np.logaddexp(0,eta)
    z=expit(2*eta)
    shape=eta.shape+(11,)
    terms=np.empty(shape);d1=np.empty(shape);d2=np.empty(shape)
    k=np.arange(10)
    terms[...,:10]=LOG_CHOOSE+11*lp[...,None]+k*lr[...,None]
    d1[...,:10]=11-(11+k)*p[...,None]
    d2[...,:10]=-(11+k)*(p*r)[...,None]
    terms[...,10]=math.log(math.comb(20,10))+12*lp+10*lr-np.logaddexp(2*lp,2*lr)
    d1[...,10]=12-20*p-2*z
    d2[...,10]=-20*p*r-4*z*(1-z)
    lq=logsumexp(terms,axis=-1);prob=np.exp(terms-lq[...,None])
    a=np.sum(prob*d1,axis=-1)
    b=np.sum(prob*(d2+d1*d1),axis=-1)-a*a
    return lq,a,b

class Likelihood:
    def __init__(self,games,family,rubber_sd,quadrature=GH_POINTS):
        self.family=family;self.rubber_sd=rubber_sd;self.games=games
        self.hs=np.array([g['home_sets'] for g in games],dtype=float)
        self.as_=np.array([g['away_sets'] for g in games],dtype=float)
        self.hp=np.array([sum(s[0] for s in g['sets']) for g in games],dtype=float)
        self.ap=np.array([sum(s[1] for s in g['sets']) for g in games],dtype=float)
        self.point=np.array([family=='point' and bool(g['sets']) for g in games])
        x,w=np.polynomial.hermite.hermgauss(quadrature)
        self.nodes=math.sqrt(2)*rubber_sd*x;self.logw=np.log(w/math.sqrt(math.pi))
    def evaluate(self,eta,curvature=True):
        e=eta[:,None]+self.nodes[None,:]
        p=expit(e);lp=-np.logaddexp(0,-e);lr=-np.logaddexp(0,e)
        l=np.empty_like(e);a=np.empty_like(e);b=np.empty_like(e)
        if self.family=='set':
            h=self.hs[:,None];n=(self.hs+self.as_)[:,None]
            l=h*lp+self.as_[:,None]*lr;a=h-n*p;b=-n*p*(1-p)
        else:
            if self.point.any():
                ix=self.point;h=self.hp[ix,None];n=(self.hp[ix]+self.ap[ix])[:,None]
                l[ix]=h*lp[ix]+self.ap[ix,None]*lr[ix];a[ix]=h-n*p[ix];b[ix]=-n*p[ix]*(1-p[ix])
            ix=~self.point
            if ix.any():
                lq,aq,bq=log_setwin(e[ix]);lqc,ac,bc=log_setwin(-e[ix])
                h=self.hs[ix,None];v=self.as_[ix,None]
                l[ix]=h*lq+v*lqc;a[ix]=h*aq-v*ac;b[ix]=h*bq+v*bc
        total=logsumexp(l+self.logw[None,:],axis=1)
        posterior=np.exp(l+self.logw[None,:]-total[:,None])
        slope=np.sum(posterior*a,axis=1)
        info=-(np.sum(posterior*(b+a*a),axis=1)-slope*slope) if curvature else None
        return total,slope,info

def design(games,cohort,config):
    players=sorted(set(cohort)|{p for g in games for side in ('home_players','away_players') for p in g[side]})
    pairs=sorted({pair_key(g[s]) for g in games for s in ('home_players','away_players') if len(g[s])==2})
    day_keys=sorted({g['match_id']+'|'+g[side+'_team']+'|'+p for g in games for side in ('home','away') for p in g[side+'_players']})
    P=len(players);Q=len(pairs);G=P+Q+1
    pi={p:i for i,p in enumerate(players)};qi={q:P+i for i,q in enumerate(pairs)};di={d:G+i for i,d in enumerate(day_keys)}
    sd=np.array([config['tau']]*P+[config['pair_sd']]*Q+[config['home_sd']]+[config['day_sd']]*len(day_keys))
    row=[];col=[];vals=[]
    for i,g in enumerate(games):
        for side,sign in [('home',1),('away',-1)]:
            ids=g[side+'_players'];co=sign/len(ids)
            for pid in ids:
                row.extend((i,i));col.extend((pi[pid],di[g['match_id']+'|'+g[side+'_team']+'|'+pid]));vals.extend((co,co))
            if len(ids)==2:row.append(i);col.append(qi[pair_key(ids)]);vals.append(sign)
        row.append(i);col.append(G-1);vals.append(1.0)
    X=sparse.csr_matrix((vals,(row,col)),shape=(len(games),len(sd)))
    X=X.multiply(sd[None,:]).tocsr() # whitened Gaussian N(0,I) prior
    serial_players=list(cohort)
    serial_pairs=[p for p in pairs if all(x in cohort for x in p.split('|'))]
    selected=np.array([pi[p] for p in serial_players]+[qi[p] for p in serial_pairs]+[G-1])
    return X,sd,selected,serial_players,serial_pairs,{'all_players':P,'all_pairs':Q,'nuisance_player_day_effects':len(day_keys),'joint_dimensions':len(sd)}

def refit(old_model,current,historical,cohort,cutoff,original_meta):
    cfg=dict(old_model['config']);window=cfg['window']
    hist=[g for g in historical if int(g['season'][:4])>=2026-window] if window else []
    games=sorted([dict(g,historical=False) for g in current if not g['walkover']]+hist,key=lambda g:(g['date'] or '',g['match_id'],g['key']))
    assert len({g['key'] for g in games})==len(games)
    cutoff=date(cutoff);weighted=[observation_weight(g,cutoff,cfg['half_life']) for g in games]
    weights=np.array([a for a,b in weighted]);anomalous=sum(b for a,b in weighted)
    X,sd,selected,players,pairs,dimensions=design(games,cohort,cfg)
    likelihood=Likelihood(games,cfg['family'],cfg['rubber_sd'])
    def objective(z):
        ll,d1,_=likelihood.evaluate(X@z,False)
        return float(.5*np.dot(z,z)-np.dot(weights,ll)),z-X.T@(weights*d1)
    zero=np.zeros(X.shape[1]);f0,g0=objective(zero)
    # Prior whitening avoids the severe point/pair/day precision scale disparity.
    result=minimize(objective,zero,jac=True,method='L-BFGS-B',options={'ftol':1e-14,'gtol':2e-7,'maxiter':2500,'maxls':50,'maxcor':30})
    z=result.x;f,gradient=objective(z);eta=X@z;ll,d1,info=likelihood.evaluate(eta)
    if not result.success or np.max(np.abs(gradient))>0.005:raise RuntimeError(f'{cfg["id"]}: failed convergence: {result.message}; gradient {np.max(np.abs(gradient))}')
    H=(sparse.eye(X.shape[1],format='csc')+X.T@sparse.diags(weights*info)@X).tocsc()
    factor=splu(H)
    rhs=np.zeros((X.shape[1],len(selected)));rhs[selected,np.arange(len(selected))]=1
    invcols=factor.solve(rhs);covz=invcols[selected,:]
    covariance=(covz+covz.T)/2*sd[selected,None]*sd[selected][None,:]
    mu=z[selected]*sd[selected]
    eigen=np.linalg.eigvalsh(covariance)
    if eigen.min()<=0:raise RuntimeError('Non-positive marginal covariance '+cfg['id'])
    # Numerical checks are training/computation audits, NOT new predictive validation.
    rng=np.random.default_rng(20261106)
    direction=rng.normal(size=len(z));direction/=np.linalg.norm(direction)
    step=1e-4
    directional_fd=(objective(z+step*direction)[0]-objective(z-step*direction)[0])/(2*step)
    directional=np.dot(gradient,direction)
    # Check full Hessian-vector product by finite differences of analytic gradients.
    hv=H@direction
    hfd=(objective(z+step*direction)[1]-objective(z-step*direction)[1])/(2*step)
    check=Likelihood(games,cfg['family'],cfg['rubber_sd'],81)
    ll81,d81,i81=check.evaluate(eta)
    integration_diff=float(np.max(np.abs(ll81-ll)))
    if integration_diff>2e-6:raise RuntimeError('Insufficient residual quadrature '+cfg['id']+' '+str(integration_diff))
    residual=H@invcols-rhs
    audit={
        'training_only_not_predictive_validation':True,'method':REVISION,'optimizer_success':bool(result.success),
        'objective_at_zero':f0,'objective_at_map':f,'objective_decreased':bool(f<f0),
        'gradient_max_whitened':float(np.max(np.abs(gradient))),
        'directional_gradient_analytic':float(directional),'directional_gradient_finite_difference':float(directional_fd),
        'directional_gradient_abs_error':float(abs(directional_fd-directional)),
        'hessian_vector_relative_error':float(np.linalg.norm(hfd-hv)/max(1.,np.linalg.norm(hv))),
        'quadrature_nodes':GH_POINTS,'quadrature_check_nodes':81,
        'quadrature_max_loglik_abs_difference':integration_diff,
        'quadrature_max_score_abs_difference':float(np.max(np.abs(d81-d1))),
        'quadrature_max_information_abs_difference':float(np.max(np.abs(i81-info))),
        'minimum_rubber_observed_information':float(info.min()),
        'negative_rubber_information_count':int(np.sum(info<0)),
        'full_inverse_selected_columns_max_residual':float(np.max(np.abs(residual))),
        'marginal_covariance_min_eigenvalue':float(eigen.min()),
        'marginal_covariance_max_eigenvalue':float(eigen.max()),
        'marginal_covariance_symmetry_error':float(np.max(np.abs(covariance-covariance.T))),
        'all_finite':bool(np.isfinite(mu).all() and np.isfinite(covariance).all()),
    }
    if audit['hessian_vector_relative_error']>2e-5 or audit['directional_gradient_abs_error']>2e-5:raise RuntimeError('Derivative audit failure '+cfg['id'])
    current_count=sum(not g.get('historical') for g in games)
    fit={
        'games':len(games),'current_games':current_count,'historical_games':len(hist),
        'effective_games':float(weights.sum()),**dimensions,
        'converged':bool(result.success),'message':str(result.message),'gradient_max':float(np.max(np.abs(gradient))),
        'iterations':int(result.nit),'through_round':max(g['round'] for g in current),
        'objective':f,'training_cutoff_utc':cutoff.isoformat(),'data_as_of':'2026-11-06',
        'current_half_life_days':CURRENT_HALF_LIFE,'historical_half_life_days':cfg['half_life'],
        'historical_approved_nonofficial_games':sum(g['status']=='approved' for g in hist),
        'historical_unreliable_dates':anomalous,
        'historical_point_games':sum(bool(g['sets']) for g in hist),
        'historical_scored_sets':sum(len(g['sets']) for g in hist),
        'serial_dimensions':len(selected),'serialized_pairs_both_in_current_cohort':True,
        'prior':'independent zero-mean Gaussians using original config; full refit, NOT old posterior added again',
        'method':REVISION,'rubber_integration':f'Gauss-Hermite-{GH_POINTS}, one common residual per rubber',
        'covariance':'Full selected inverse of the sparse observed negative joint log-posterior Hessian; all nuisance/global opponents marginalized; no diagonal-only substitution',
        'historical_date_policy':'raw dates preserved; reliable in-season dates weighted exactly; out-of-season dates use analytically season-averaged discount, no imputed date',
        'reconstruction_limit':'Original training code/raw historical snapshot unavailable. This is a complete reproducible refit of the documented model from newly archived public history, NOT a claim of bitwise original refit or a new predictive validation.',
        'audit':audit,
    }
    original={k:v for k,v in old_model.items() if k not in ('originalSnapshot',)}
    original['snapshot_utc']=original_meta['snapshot_utc'];original['training_cutoff_utc']=original_meta['cutoff_utc']
    return {'config':cfg,'players':players,'pairs':pairs,'mu':mu.tolist(),'cov':covariance.tolist(),'fit':fit,
        'inference':'time-discounted joint MAP; shared player/team-match Gaussian effects; residual-integrated actual likelihood; full observed-information Laplace marginal (not MCMC, not new calibration)',
        'originalSnapshot':original},audit

def dependency_versions():
    return {'python':platform.python_version(),'numpy':np.__version__,'scipy':scipy.__version__}
