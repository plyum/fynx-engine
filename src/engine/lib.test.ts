import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetExitMemory, EXIT, lockLevel, recentlyFailed, REBUY_BLOCK_MS,
  scoreRisk, levelOf, sizePosition, simulateFill, evaluateExit, evaluateEntry,
  pickBestPairs, choosePair, groupPairs, guardPrice, extractMints, rankCandidates, toStoredFindings, riskFromRow, decideState, mergeAgentUpdates, sellGate, scanIsDue,
  type BotStatus, type Requested,
} from './lib.ts';

const NOW = 1_800_000_000_000;
const goodPair = {
  priceUsd: '0.001', liquidity: { usd: 80_000 }, volume: { h24: 300_000, h1: 20_000, m5: 2_000 },
  txns: { h1: { buys: 120, sells: 80 }, m5: { buys: 30, sells: 20 } }, priceChange: { m5: 1, h1: 12, h24: 40 }, pairCreatedAt: NOW - 5 * 3600_000,
};
const cleanSummary = { risks: [], score: 1, score_normalised: 1, lpLockedPct: 100 };

test('niveaux de risque : bornes exactes', () => {
  assert.equal(levelOf(0), 'low'); assert.equal(levelOf(20), 'low');
  assert.equal(levelOf(21), 'moderate'); assert.equal(levelOf(40), 'moderate');
  assert.equal(levelOf(41), 'high'); assert.equal(levelOf(60), 'high');
  assert.equal(levelOf(61), 'very_high'); assert.equal(levelOf(80), 'very_high');
  assert.equal(levelOf(81), 'critical'); assert.equal(levelOf(100), 'critical');
});

test('token propre : risque faible, pas de signal critique', () => {
  const r = scoreRisk({ summary: cleanSummary, report: null, pair: goodPair, nowMs: NOW });
  assert.equal(r.has_critical, false);
  assert.ok(r.score <= 20, `score=${r.score}`);
  assert.equal(r.level, 'low');
});

test('mint authority active => critique (Mint Exploit)', () => {
  const r = scoreRisk({ summary: cleanSummary, report: { mintAuthority: 'Abc123' }, pair: goodPair, nowMs: NOW });
  assert.equal(r.has_critical, true);
  assert.ok(r.score >= 81);
  assert.ok(r.findings.some((f) => f.name === 'Mint Exploit'));
});

test('freeze authority active => critique ; adresse système ignorée', () => {
  assert.equal(scoreRisk({ summary: cleanSummary, report: { freezeAuthority: 'Abc' }, pair: goodPair, nowMs: NOW }).has_critical, true);
  assert.equal(scoreRisk({ summary: cleanSummary, report: { freezeAuthority: '11111111111111111111111111111111' }, pair: goodPair, nowMs: NOW }).has_critical, false);
  assert.equal(scoreRisk({ summary: cleanSummary, report: { freezeAuthority: null, mintAuthority: '' }, pair: goodPair, nowMs: NOW }).has_critical, false);
});

test('rugged => critique', () => {
  assert.equal(scoreRisk({ summary: cleanSummary, report: { rugged: true }, pair: goodPair, nowMs: NOW }).has_critical, true);
});

test('honeypot possible : achats sans aucune vente', () => {
  const p = { ...goodPair, txns: { h1: { buys: 40, sells: 0 } } };
  const r = scoreRisk({ summary: cleanSummary, report: null, pair: p, nowMs: NOW });
  assert.equal(r.has_critical, true);
  assert.equal(r.findings.find((f) => f.name.startsWith('Honeypot'))?.confidence, 'medium');
});

test('peu d’achats sans vente : pas de faux positif honeypot', () => {
  const p = { ...goodPair, txns: { h1: { buys: 3, sells: 0 } } };
  assert.equal(scoreRisk({ summary: cleanSummary, report: null, pair: p, nowMs: NOW }).has_critical, false);
});

test('données manquantes : jamais présenté comme sûr (UNKNOWN)', () => {
  const r = scoreRisk({ summary: null, report: null, pair: null, nowMs: NOW });
  assert.ok(r.score >= 41, `score=${r.score}`);
  assert.ok(r.findings.some((f) => f.observed === 'UNKNOWN'));
  assert.ok(r.unknown.length > 0);
});

test('liquidité faible et LP non verrouillée augmentent le score', () => {
  const p = { ...goodPair, liquidity: { usd: 3_000 } };
  const r = scoreRisk({ summary: { ...cleanSummary, lpLockedPct: 0 }, report: null, pair: p, nowMs: NOW });
  assert.ok(r.score >= 41, `score=${r.score}`);
});

test('concentration + insiders', () => {
  const report = { topHolders: [{ pct: 35, insider: true }, { pct: 10, insider: true }, { pct: 5 }] };
  const r = scoreRisk({ summary: cleanSummary, report, pair: goodPair, nowMs: NOW });
  assert.ok(r.findings.some((f) => f.name.startsWith('Bundling')));
  assert.ok(r.findings.some((f) => f.name === 'Concentration des détenteurs'));
});

test('score borné entre 0 et 100', () => {
  const r = scoreRisk({ summary: { score_normalised: 100, risks: [] }, report: { mintAuthority: 'x', rugged: true }, pair: { ...goodPair, liquidity: { usd: 100 } }, nowMs: NOW });
  assert.ok(r.score <= 100 && r.score >= 0);
});

test('taille de position : plafonds respectés', () => {
  assert.equal(sizePosition({ equity: 1000, cash: 1000, sizePct: 5, maxTradeUsd: 20, openCount: 0, maxPositions: 3 }), 20);
  assert.equal(sizePosition({ equity: 1000, cash: 1000, sizePct: 5, maxTradeUsd: 100, openCount: 0, maxPositions: 3 }), 50);
  assert.equal(sizePosition({ equity: 1000, cash: 30, sizePct: 5, maxTradeUsd: 100, openCount: 0, maxPositions: 3 }), 29.4);
  assert.equal(sizePosition({ equity: 1000, cash: 1000, sizePct: 5, maxTradeUsd: 100, openCount: 3, maxPositions: 3 }), 0);
  assert.equal(sizePosition({ equity: 10, cash: 0.5, sizePct: 5, maxTradeUsd: 100, openCount: 0, maxPositions: 3 }), 0);
});

test('simulation : achat plus cher, vente moins chère, frais positifs', () => {
  const b = simulateFill('BUY', 1, 100, 100_000);
  const s = simulateFill('SELL', 1, 100, 100_000);
  assert.ok(b.fillPrice > 1 && s.fillPrice < 1);
  assert.ok(b.feeUsd > 0);
  assert.ok(simulateFill('BUY', 1, 100, 1_000).slippagePct > b.slippagePct);
  assert.ok(simulateFill('BUY', 1, 100, 10).slippagePct <= 20);
});

test('sorties : stop loss, take profit, hold, stale ; le verrou de gain passe avant le trailing', () => {
  _resetExitMemory();
  const pos = { entry_price: 1, stop_price: 0.85, take_profit_price: 1.3, trailing_pct: null, peak_price: 1 };
  assert.equal(evaluateExit(pos, 0.84, 1000).reason, 'Stop Loss atteint');
  assert.equal(evaluateExit(pos, 1.31, 1000).reason, 'Take Profit atteint');
  assert.equal(evaluateExit(pos, 1.0, 1000).action, 'hold');
  assert.equal(evaluateExit(pos, 0.5, 10 * 60_000).action, 'stale');
  const tr = { ...pos, take_profit_price: null, trailing_pct: 10, peak_price: 1.5 };
  assert.match(evaluateExit(tr, 1.34, 1000).reason!, /^Prise de profit : \+34\.0 % \(sommet \+50\.0 %\)/); // garde 85 % de +50 % = +42,5 %
  assert.equal(evaluateExit(tr, 1.43, 1000).action, 'hold');
  assert.equal(evaluateExit(tr, 1.6, 1000).peak, 1.6);
});

test('sorties : un prix aberrant isolé ne fixe pas un faux sommet (cas BULLHARIS ×4,95)', () => {
  _resetExitMemory();
  const pos = { entry_price: 1, stop_price: 0.7, take_profit_price: null, trailing_pct: 10, peak_price: 1 };
  const spike = evaluateExit(pos, 4.95, 1000);
  assert.equal(spike.peak, 1.15); // plafonné à +15 % du dernier sommet, pas ×4,95
  assert.equal(spike.action, 'hold');
  // tick suivant au prix réel : le sommet retenu est 1,15 (pas 4,95) ; à 1,13 le gain reste au-dessus du verrou (80 % de +15 % = +12 %)
  assert.equal(evaluateExit({ ...pos, peak_price: spike.peak }, 1.13, 1000).action, 'hold');
  // et une vente au verrou se fait au vrai prix, en gain (+4 %), jamais sur le faux sommet
  assert.match(evaluateExit({ ...pos, peak_price: spike.peak }, 1.04, 1000).reason!, /^Prise de profit : \+4\.0 %/);
});

test('conscience : verrou de gain — l’exemple +0,64 $ → +0,44 $ vend', () => {
  _resetExitMemory();
  // 13 $ achetés à 1 : +0,64 $ = +4,92 % ; +0,44 $ = +3,38 % (sous 70 % de +4,92 % = +3,45 %)
  const pos = { entry_price: 1, stop_price: null, take_profit_price: null, trailing_pct: null, peak_price: 1.0492 };
  assert.equal(evaluateExit(pos, 1.0492, 1000).action, 'hold');
  assert.equal(evaluateExit(pos, 1.04, 1000).action, 'hold'); // +0,52 $ : encore au-dessus du verrou (+3,83 % brut)
  const d = evaluateExit(pos, 1.0338, 1000);
  assert.equal(d.action, 'sell');
  assert.match(d.reason!, /le gain recule/);
  // Le verrou raisonne en gain NET (brut − 1,3 % de coût d'aller-retour) : une prise de profit ne finit jamais en perte.
  const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);
  assert.equal(lockLevel(1.5), null);   // net +0,2 % : rien à protéger
  assert.equal(lockLevel(2), null);     // net +0,7 % : pas encore armé
  near(lockLevel(2.5), 2.14);           // net +1,2 % → garde 70 % = +0,84 % net, soit +2,14 % brut
  near(lockLevel(20), 1.3 + 18.7 * 0.8);
  near(lockLevel(40), 1.3 + 38.7 * 0.85);
  // Régression du 12/11 : « Prise de profit : +0.8 % » finissait à −0,48 % après frais. Un sommet à +2 % ne déclenche plus rien,
  // et le seuil de vente reste toujours au-dessus du coût de sortie, quel que soit le sommet.
  _resetExitMemory();
  assert.equal(evaluateExit({ ...pos, peak_price: 1.017 }, 1.008, 1000).action, 'hold'); // sommet +1,7 % : rien d'armé
  for (let peak = 0; peak <= 200; peak += 0.1) {
    const l = lockLevel(peak);
    if (l !== null) assert.ok(l >= EXIT.costPct + EXIT.floorNetPct - 1e-9 && l < peak, `sommet ${peak} → seuil ${l}`);
  }
});

test('conscience : perte coupée dès −2,5 %, pas d’élan après 6 min, mémoire anti-rachat', () => {
  _resetExitMemory();
  const pos = { id: 'p1', mint: 'MintA', entry_price: 1, stop_price: 0.7, take_profit_price: null, trailing_pct: null, peak_price: 1 };
  assert.equal(evaluateExit(pos, 0.98, 1000, 0).action, 'hold');
  const cut = evaluateExit(pos, 0.975, 1000, 1000);
  assert.equal(cut.action, 'sell');
  assert.match(cut.reason!, /^Perte coupée tout de suite \(−2\.5 %\)/);
  assert.equal(recentlyFailed('MintA', 2000), true);          // vendu en perte : pas de rachat
  assert.equal(recentlyFailed('MintA', 2000 + REBUY_BLOCK_MS), false);
  // pas d'élan : vu pour la première fois à t=0, toujours sous le seuil d'armement après 6 min
  const flat = { ...pos, id: 'p2', mint: 'MintB' };
  assert.equal(evaluateExit(flat, 1.01, 1000, 0).action, 'hold');
  assert.equal(evaluateExit(flat, 1.01, 1000, 5 * 60_000).action, 'hold');
  const nm = evaluateExit(flat, 1.01, 1000, 6 * 60_000);
  assert.equal(nm.action, 'sell');
  assert.match(nm.reason!, /^Pas d’élan en 6 min/);
  // un token qui a armé le verrou n'est jamais vendu pour « pas d'élan »
  const up = { ...pos, id: 'p3', mint: 'MintC', peak_price: 1.05 };
  assert.equal(evaluateExit(up, 1.045, 1000, 0).action, 'hold');
  assert.equal(evaluateExit(up, 1.045, 1000, 30 * 60_000).action, 'hold');
  // gros gain vendu au verrou : rachat autorisé (le token a payé)
  assert.equal(evaluateExit({ ...up, peak_price: 1.2 }, 1.1, 1000, 0).action, 'sell');
  assert.equal(recentlyFailed('MintC', 1000), false);
});

test('conscience : protection du prix de revient (sommet ≥ +1,8 % brut → sortie vers +1,4 % au lieu de laisser filer en perte)', () => {
  _resetExitMemory();
  // cas réel du 12/11 : sommet +2,05 %, revendu à −2,57 % par « pas d'élan » ; il doit sortir dès le retour vers +1,4 %
  const pos = { id: 'b1', mint: 'MintBE', entry_price: 1, stop_price: 0.7, take_profit_price: null, trailing_pct: null, peak_price: 1.0205 };
  assert.equal(evaluateExit(pos, 1.019, 1000, 0).action, 'hold');   // +1,9 % : on laisse courir
  assert.equal(evaluateExit(pos, 1.015, 1000, 0).action, 'hold');   // +1,5 % : encore au-dessus du prix de revient + 0,1 % net
  const be = evaluateExit(pos, 1.0138, 1000, 0);
  assert.equal(be.action, 'sell');
  assert.match(be.reason!, /^Protection : retour vers le prix de revient \(\+1\.4 %, sommet \+2\.\d %\)/);
  // sommet trop petit (+1,7 %) : la protection ne s'arme pas (le bruit ne déclenche rien)
  assert.equal(evaluateExit({ ...pos, id: 'b2', peak_price: 1.017 }, 1.012, 1000, 0).action, 'hold');
  // une fois le verrou de gain armé, c'est lui qui décide (pas la protection)
  const big = evaluateExit({ ...pos, id: 'b3', peak_price: 1.05 }, 1.03, 1000, 0);
  assert.match(big.reason!, /^Prise de profit/);
  // la perte coupée reste prioritaire en cas de trou de prix
  assert.match(evaluateExit({ ...pos, id: 'b4' }, 0.97, 1000, 0).reason!, /^Perte coupée/);
});

test('entrée : acceptée si tout est bon, refusée sinon avec raisons', () => {
  const risk = scoreRisk({ summary: cleanSummary, report: null, pair: goodPair, nowMs: NOW });
  const s = { max_risk_score: 40, caution_level: 'high' as const };
  const ok = evaluateEntry(goodPair, risk, s, 1000);
  assert.equal(ok.ok, true);
  const bad = evaluateEntry({ ...goodPair, liquidity: { usd: 5000 } }, risk, s, 1000);
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.some((r) => r.startsWith('Liquidité')));
  assert.equal(evaluateEntry(goodPair, risk, s, 5 * 60_000).ok, false);
  assert.equal(evaluateEntry(null, risk, s, 0).ok, false);
  const crit = scoreRisk({ summary: cleanSummary, report: { mintAuthority: 'x' }, pair: goodPair, nowMs: NOW });
  assert.equal(evaluateEntry(goodPair, crit, s, 1000).ok, false);
});

test('entrée : seulement les tokens qui montent maintenant ; pas de rachat d’un token qui n’a pas payé', () => {
  _resetExitMemory();
  const risk = scoreRisk({ summary: cleanSummary, report: null, pair: goodPair, nowMs: NOW });
  const s = { max_risk_score: 40, caution_level: 'high' as const };
  const why = (p: unknown) => evaluateEntry(p as never, risk, s, 1000).reasons.join(' | ');
  assert.match(why({ ...goodPair, priceChange: { ...goodPair.priceChange, m5: 0 } }), /Ne monte pas en ce moment/);
  assert.match(why({ ...goodPair, txns: { ...goodPair.txns, m5: { buys: 10, sells: 12 } } }), /acheteurs que de vendeurs sur 5 min/);
  assert.match(why({ ...goodPair, volume: { ...goodPair.volume, m5: 300 } }), /Volume 5 min trop faible/);
  const withMint = { ...goodPair, baseToken: { address: 'MintZ' } };
  assert.equal(evaluateEntry(withMint as never, risk, s, 1000).ok, true);
  evaluateExit({ mint: 'MintZ', entry_price: 1, stop_price: 0.9, take_profit_price: null, trailing_pct: null, peak_price: 1 }, 0.95, 1000); // vendu en perte
  assert.match(why(withMint), /Déjà vendu il y a peu sans vrai gain/);
});

const M1 = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const M2 = '5gqiRdCWHX8gtijXBqNX9Y8262U7iSAGdj9rgJN3stay';
const M3 = 'CosTTUkbt6aNxovq4in2XocHcq6DQFxFpofuYhYbpump';

test('pickBestPairs : paire la plus liquide, ignore prix invalides et autres chaînes', () => {
  const arr = [
    { chainId: 'solana', baseToken: { address: M1, symbol: 'A' }, priceUsd: '1', liquidity: { usd: 100 } },
    { chainId: 'solana', baseToken: { address: M1, symbol: 'A' }, priceUsd: '2', liquidity: { usd: 900 } },
    { chainId: 'solana', baseToken: { address: M2 }, priceUsd: '0', liquidity: { usd: 5000 } },
    { chainId: 'ethereum', baseToken: { address: M3 }, priceUsd: '3', liquidity: { usd: 5000 } },
    { chainId: 'solana', baseToken: { address: M3 }, priceUsd: 'abc', liquidity: { usd: 5000 } },
  ];
  const m = pickBestPairs(arr, null);
  assert.equal(m.size, 1);
  assert.equal(m.get(M1)?.priceUsd, '2');
  assert.equal(pickBestPairs(null).size, 0);
  assert.equal(pickBestPairs({ error: 'x' }).size, 0);
});

test('extractMints : solana seulement, dédoublonné, adresses valides, SOL/USDC exclus', () => {
  const out = extractMints({
    boosts: [{ chainId: 'solana', tokenAddress: M1 }, { chainId: 'bsc', tokenAddress: M2 }],
    profiles: [{ chainId: 'solana', tokenAddress: M1 }, { chainId: 'solana', tokenAddress: M3 }, { chainId: 'solana', tokenAddress: 'pas-une-adresse' }],
    rcNew: [{ mint: M2 }, { mint: 'So11111111111111111111111111111111111111112' }, { mint: '' }],
  });
  assert.deepEqual(out, [M1, M3, M2]);
  assert.deepEqual(extractMints({ boosts: null, profiles: undefined, rcNew: 'x' }), []);
  const many = Array.from({ length: 200 }, (_, i) => ({ chainId: 'solana', tokenAddress: M1.slice(0, 30) + String(i).padStart(3, '1') }));
  assert.ok(extractMints({ boosts: many, profiles: [], rcNew: [] }, 90).length <= 90);
});

test('rankCandidates : filtre le marché puis classe par liquidité × volume', () => {
  const pairs = new Map();
  pairs.set(M1, { ...goodPair, baseToken: { address: M1 } });
  pairs.set(M2, { ...goodPair, liquidity: { usd: 200_000 }, baseToken: { address: M2 } });
  pairs.set(M3, { ...goodPair, liquidity: { usd: 1_000 }, baseToken: { address: M3 } }); // trop peu liquide
  const r = rankCandidates(pairs, [M1, M2, M3, 'inconnu']);
  assert.deepEqual(r.map((c) => c.mint), [M2, M1]); // même élan : le plus liquide d'abord
  pairs.set(M1, { ...goodPair, volume: { ...goodPair.volume, m5: 9_000 }, priceChange: { ...goodPair.priceChange, m5: 6 }, baseToken: { address: M1 } });
  assert.deepEqual(rankCandidates(pairs, [M1, M2, M3]).map((c) => c.mint), [M1, M2]); // celui qui monte vite passe devant
});

test('findings stockés : UNKNOWN conservés et reconstruction fidèle', () => {
  const risk = scoreRisk({ summary: cleanSummary, report: null, pair: goodPair, nowMs: NOW });
  const stored = toStoredFindings(risk);
  assert.equal(stored.filter((f) => f.observed === 'UNKNOWN').length, risk.unknown.length);
  assert.ok(risk.unknown.length >= 12);
  const back = riskFromRow({ score: risk.score, level: risk.level, has_critical: risk.has_critical, findings: JSON.parse(JSON.stringify(stored)) });
  assert.equal(back.unknown.length, risk.unknown.length);
  assert.equal(back.findings.length, risk.findings.length);
  assert.equal(back.score, risk.score);
});

test('machine d’état : démarrage, pause, reprise, arrêt avec fermeture', () => {
  const d = (status: any, requested: any, openCount = 0, mode: any = 'paper') => decideState({ mode, status, requested, openCount });
  assert.equal(d('stopped', 'running').next, 'running');
  assert.equal(d('running', 'running').event, undefined);
  assert.equal(d('running', 'paused').next, 'paused');
  assert.equal(d('paused', 'running').next, 'running');
  assert.equal(d('paused', 'paused').event, undefined);
  assert.equal(d('running', 'stopped', 2).next, 'closing');
  assert.match(d('running', 'stopped', 2).event!, /2 position/);
  assert.equal(d('closing', 'stopped', 1).next, 'closing');
  assert.equal(d('closing', 'stopped', 1).event, undefined);
  assert.equal(d('running', 'stopped', 0).next, 'stopped');
  assert.equal(d('paused', 'stopped', 0).next, 'stopped');
  assert.equal(d('stopped', 'stopped').event, undefined);
  assert.equal(d('closing', 'running', 1).next, 'running');
  assert.equal(d('stopped', 'paused').next, 'stopped');
  assert.equal(d('stopped', 'paused').resetRequested, 'stopped');
});

test('compte réel non prêt : démarrage refusé avec la raison, jamais en silence', () => {
  const gate = { ready: false, reason: 'le test réel n’a pas encore réussi' };
  const r = decideState({ mode: 'live', status: 'stopped', requested: 'running', openCount: 0, liveGate: gate });
  assert.equal(r.next, 'stopped');
  assert.equal(r.resetRequested, 'stopped');
  assert.equal(r.level, 'warning');
  assert.match(r.event ?? '', /Démarrage refusé : le test réel/);
  // sans information de préparation : refus aussi (valeur par défaut sûre)
  assert.equal(decideState({ mode: 'live', status: 'stopped', requested: 'running', openCount: 0 }).next, 'stopped');
  assert.equal(decideState({ mode: 'live', status: 'stopped', requested: 'stopped', openCount: 0, liveGate: gate }).event, undefined);
});

test('compte réel devenu inutilisable en cours de route : pause (positions conservées), jamais d’arrêt silencieux', () => {
  const gate = { ready: false, reason: 'le secret de chiffrement n’est pas configuré' };
  const run = decideState({ mode: 'live', status: 'running', requested: 'running', openCount: 2, liveGate: gate });
  assert.equal(run.next, 'paused');
  assert.equal(run.level, 'warning');
  assert.equal(run.resetRequested, undefined);
  // déjà en pause : état conservé sans répéter l’avertissement à chaque tick
  const paused = decideState({ mode: 'live', status: 'paused', requested: 'running', openCount: 2, liveGate: gate });
  assert.equal(paused.next, 'paused');
  assert.equal(paused.event, undefined);
  // arrêt demandé avec positions : la fermeture reste en cours
  assert.equal(decideState({ mode: 'live', status: 'closing', requested: 'stopped', openCount: 1, liveGate: gate }).next, 'closing');
  // arrêt demandé sans position : arrêté
  assert.equal(decideState({ mode: 'live', status: 'paused', requested: 'stopped', openCount: 0, liveGate: gate }).next, 'stopped');
});

test('compte réel prêt : même machine d’état que le papier (démarrer, pause, arrêt = fermer toutes les positions)', () => {
  const g = { ready: true };
  const d = (status: BotStatus, requested: Requested, openCount = 0) => decideState({ mode: 'live', status, requested, openCount, liveGate: g });
  assert.equal(d('stopped', 'running').next, 'running');
  assert.equal(d('running', 'paused').next, 'paused');
  assert.equal(d('paused', 'running').next, 'running');
  assert.equal(d('running', 'stopped', 3).next, 'closing');
  assert.match(d('running', 'stopped', 3).event ?? '', /fermeture de 3 position/);
  assert.equal(d('closing', 'stopped', 1).next, 'closing');
  assert.equal(d('running', 'stopped', 0).next, 'stopped');
});

test('ventes réelles échouées : attente croissante puis abandon au 8e échec', () => {
  const now = 10_000_000;
  assert.deepEqual(sellGate([], now), { action: 'try', n: 0, waitMs: 0 });
  // 1 échec il y a 10 s : attendre 20 s de plus ; il y a 31 s : réessayer
  assert.deepEqual(sellGate([now - 10_000], now), { action: 'wait', n: 1, waitMs: 20_000 });
  assert.equal(sellGate([now - 31_000], now).action, 'try');
  // 3 échecs, le dernier il y a 60 s : l’attente est de 2 min
  const three = [now - 600_000, now - 300_000, now - 60_000];
  assert.deepEqual(sellGate(three, now), { action: 'wait', n: 3, waitMs: 60_000 });
  // l’attente plafonne à 5 min
  const six = Array.from({ length: 6 }, (_, i) => now - 4_000_000 + i * 100_000);
  assert.equal(sellGate(six, now).action, 'try');
  assert.equal(sellGate([...six.slice(0, 5), now - 60_000], now).waitMs, 240_000);
  // 8 échecs en 3 h : abandon
  const eight = Array.from({ length: 8 }, (_, i) => now - 3_000_000 + i * 60_000);
  assert.equal(sellGate(eight, now).action, 'abandon');
  // les échecs de plus de 3 h ne comptent plus
  const old = Array.from({ length: 8 }, (_, i) => now - 4 * 3600_000 + i * 1000);
  assert.deepEqual(sellGate(old, now), { action: 'try', n: 0, waitMs: 0 });
});

test('fusion des mises à jour d’agents : pire statut gagne, compteurs additionnés, erreur conservée', () => {
  const m = mergeAgentUpdates([
    { agent: 'SCANNER', status: 'RUNNING', n: 5, err: null },
    { agent: 'SCANNER', status: 'WARNING', n: 0, err: 'flux en panne' },
    { agent: 'EXECUTOR', status: 'RUNNING', n: 1 },
    { agent: 'EXECUTOR', status: 'ERROR', err: 'rpc' },
    { agent: 'LOGGER', status: 'RUNNING', n: 2, err: null },
  ]);
  const by = Object.fromEntries(m.map((u) => [u.agent, u]));
  assert.equal(by.SCANNER.status, 'WARNING');
  assert.equal(by.SCANNER.n, 5);
  assert.equal(by.SCANNER.err, 'flux en panne');
  assert.equal(by.EXECUTOR.status, 'ERROR');
  assert.equal(by.EXECUTOR.n, 1);
  assert.equal(by.LOGGER.err, null);
});

test('recherche de tokens : due dès que l’âge atteint l’intervalle moins la marge de 2,5 s (tours espacés de 5 s)', () => {
  assert.equal(scanIsDue(Infinity, 30), true);
  assert.equal(scanIsDue(30_000, 30), true);
  assert.equal(scanIsDue(27_500, 30), true);
  assert.equal(scanIsDue(27_499, 30), false);
  assert.equal(scanIsDue(25_000, 30), false, 'un tour à 25 s ne relance pas la recherche (avant : toutes les 25 s)');
  assert.equal(scanIsDue(57_000, 60), false);
  assert.equal(scanIsDue(57_500, 60), true);
});

// ───────── Prix aberrants : rejeu de l'incident BULLHARIS du 11/11 (prix DexScreener réels enregistrés) ─────────
const BH = '6mwuYnY3fHdxed9GnrdY5BkXhJwMi1uz39MPsYUcpump';
const bhPair = (addr: string, px: string, liq: number) => ({ chainId: 'solana', pairAddress: addr, baseToken: { address: BH }, priceUsd: px, liquidity: { usd: liq } });

test('paires : la paire suivie est conservée même si une autre annonce plus de liquidité', () => {
  const all = [bhPair('VRAIE', '0.0005023', 53659), bhPair('FAUSSE', '0.001259', 95227)];
  assert.equal(choosePair(all, 'VRAIE')?.pairAddress, 'VRAIE');
  assert.equal(choosePair(all, undefined)?.pairAddress, 'FAUSSE'); // premier passage : la plus liquide
  assert.equal(choosePair([bhPair('FAUSSE', '0.001259', 95227)], 'VRAIE')?.pairAddress, 'FAUSSE'); // la paire suivie a disparu
  assert.equal(choosePair([], 'VRAIE'), null);
  const g = groupPairs([...all, { chainId: 'bsc', baseToken: { address: BH }, priceUsd: '1' }, bhPair('ZERO', '0', 1)]);
  assert.equal(g.get(BH)?.length, 2);
});

test('prix : le pic isolé de 10:26:48 (×2,5 pendant un tour) est ignoré, le prix réel reprend ensuite', () => {
  let mem = guardPrice(undefined, 0.0005023, 0).mem;
  const spike = guardPrice(mem, 0.001259, 5_000);
  assert.equal(spike.held, true);
  assert.equal(spike.px, 0.0005023);            // l'équité et le trailing ne voient pas le faux prix
  mem = spike.mem;
  const back = guardPrice(mem, 0.0005023, 11_000);
  assert.equal(back.held, false);
  assert.equal(back.px, 0.0005023);
  assert.equal(back.mem.pend, undefined);
});

test('prix : le pic ×5 de 05:06:39 ne gonfle pas le sommet du trailing stop', () => {
  const pos = { entry_price: 0.000354185, stop_price: 0.000247929, take_profit_price: null, trailing_pct: 20, peak_price: 0.000354185 };
  const g = guardPrice({ px: 0.000347, at: 0 }, 0.001754, 5_000);
  assert.equal(evaluateExit(pos, g.px, 1000).peak, 0.000354185);
});

test('prix : une vraie hausse (ou chute) confirmée au tour suivant est acceptée', () => {
  const up1 = guardPrice({ px: 1, at: 0 }, 2.2, 5_000);
  assert.equal(up1.held, true);
  const up2 = guardPrice(up1.mem, 2.3, 10_000);
  assert.equal(up2.held, false);
  assert.equal(up2.px, 2.3);
  const dn1 = guardPrice({ px: 1, at: 0 }, 0.2, 5_000); // faux plongeon : pas de stop loss sur un seul tour
  assert.equal(dn1.px, 1);
  const dn2 = guardPrice(dn1.mem, 0.21, 10_000);       // rug réel : confirmé au tour suivant, le stop loss peut agir
  assert.equal(dn2.px, 0.21);
});

test('prix : variations normales acceptées directement, référence périmée remplacée', () => {
  assert.equal(guardPrice({ px: 1, at: 0 }, 1.4, 5_000).held, false);
  assert.equal(guardPrice({ px: 1, at: 0 }, 0.7, 5_000).held, false);
  const old = guardPrice({ px: 1, at: 0 }, 3, 200_000);
  assert.equal(old.held, false);
  assert.equal(old.px, 3);
  // deux pics successifs qui ne se confirment pas entre eux : toujours retenus
  const a = guardPrice({ px: 1, at: 0 }, 5, 5_000);
  const b = guardPrice(a.mem, 2.5, 10_000);
  assert.equal(b.held, true);
  assert.equal(b.px, 1);
});

test('pickBestPairs avec mémoire : rejeu de 10:26 (vraie paire, puis la fausse seule, puis la vraie)', () => {
  const mem = { pair: new Map<string, string>(), px: new Map() };
  const t1 = pickBestPairs([bhPair('VRAIE', '0.0005023', 53659)], mem, 0);
  assert.equal(t1.get(BH)?.priceUsd, '0.0005023');
  // la réponse contient les deux paires : la paire suivie gagne malgré sa liquidité plus faible
  const t2 = pickBestPairs([bhPair('VRAIE', '0.0005023', 53659), bhPair('FAUSSE', '0.001259', 95227)], mem, 6_000);
  assert.equal(t2.get(BH)?.pairAddress, 'VRAIE');
  // la réponse ne contient que la fausse paire : son prix ×2,5 est retenu, l'ancien prix est conservé
  const t3 = pickBestPairs([bhPair('FAUSSE', '0.001259', 95227)], mem, 12_000);
  assert.equal(Number(t3.get(BH)?.priceUsd), 0.0005023);
  const t4 = pickBestPairs([bhPair('VRAIE', '0.0005023', 53659)], mem, 18_000);
  assert.equal(t4.get(BH)?.pairAddress, 'VRAIE');
  assert.equal(Number(t4.get(BH)?.priceUsd), 0.0005023);
});
