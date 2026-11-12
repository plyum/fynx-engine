// FYNX — mode Scalping (bouton par compte, en plus du bot normal).
// Lancé juste après chaque tour du moteur, dans le même verrou et avec la même session de portefeuille : aucun ordre en parallèle.
// Ce module ne fait que les ENTRÉES : chaque position scalping porte son TP / SL en %, et le moteur normal la vend
// (stop loss / take profit vérifiés à chaque tour rapide, soit toutes les 2 s).
// Sources : tendances GeckoTerminal (pools Solana en tendance) + chiffres DexScreener ; risque : RugCheck (même score que le bot normal).
import { pickBestPairs, riskFromRow, scoreRisk, simulateFill, toStoredFindings, type Pair, type RiskResult } from './lib.ts';
import { buyToken, refreshBalances } from './live.ts';
import { entryGate, liveGate, openSession, secretUsable, type LiveInfo, type Session } from './livecycle.ts';
import type { Ctx } from './index.ts';

const DX = 'https://api.dexscreener.com';
const RC = 'https://api.rugcheck.xyz';
const GT = 'https://api.geckoterminal.com/api/v2';
/** Nouvelle liste de tendances au plus toutes les 30 s (limites des API gratuites). */
export const SCALP_SCAN_MS = 30_000;
const RISK_TTL_MS = 10 * 60_000;
const MAX_DEEP = 3;
const REENTRY_COOLDOWN_MIN = 60;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export type ScalpCfg = {
  tpPct: number; slPct: number; maxPositions: number; sizeUsd: number; mcapMin: number; mcapMax: number; maxRisk: number;
};

const num = (v: unknown, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };

/** Adresses des tokens des pools Solana en tendance (réponse GeckoTerminal). */
export function trendingMints(resp: unknown): string[] {
  const out: string[] = [];
  const data = (resp as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const p of data) {
    const id = (p as { relationships?: { base_token?: { data?: { id?: string } } } })?.relationships?.base_token?.data?.id;
    if (typeof id === 'string' && id.startsWith('solana_')) {
      const m = id.slice(7);
      if (!out.includes(m)) out.push(m);
    }
  }
  return out;
}

/**
 * Tokens tradables en scalping : capitalisation dans la fourchette, liquidité et volume suffisants, élan court (5 min) haussier
 * sans pump extrême, plus d'acheteurs que de vendeurs, paire de plus de 30 min. Classés par volume 1 h.
 */
export function scalpPick(pair: Pair | undefined, cfg: Pick<ScalpCfg, 'mcapMin' | 'mcapMax'>, nowMs: number): { ok: boolean; why: string } {
  if (!pair || !(num(pair.priceUsd) > 0)) return { ok: false, why: 'prix indisponible' };
  const mcap = num(pair.marketCap, NaN);
  if (!Number.isFinite(mcap)) return { ok: false, why: 'capitalisation inconnue' };
  if (mcap < cfg.mcapMin || mcap > cfg.mcapMax) return { ok: false, why: `capitalisation ${Math.round(mcap)} $ hors fourchette` };
  if (num(pair.liquidity?.usd) < 20_000) return { ok: false, why: 'liquidité < 20 000 $' };
  if (num(pair.volume?.h1) < 20_000) return { ok: false, why: 'volume 1 h < 20 000 $' };
  const pc = pair.priceChange ?? {};
  if (!(num(pc.m5) > 0.5)) return { ok: false, why: 'pas d’élan sur 5 min' };
  if (!(num(pc.h1) > 0)) return { ok: false, why: 'tendance 1 h non haussière' };
  if (num(pc.h1) > 100) return { ok: false, why: 'hausse 1 h trop forte (risque de retournement)' };
  const m5 = pair.txns?.m5;
  if (!m5 || m5.buys <= m5.sells) return { ok: false, why: 'pas plus d’acheteurs que de vendeurs sur 5 min' };
  if (pair.pairCreatedAt && nowMs - pair.pairCreatedAt < 30 * 60_000) return { ok: false, why: 'paire de moins de 30 min' };
  return { ok: true, why: `capitalisation ${Math.round(mcap / 1000)} k$, +${num(pc.m5).toFixed(1)} % sur 5 min, volume 1 h ${Math.round(num(pair.volume?.h1) / 1000)} k$` };
}

async function getJson(url: string, timeoutMs = 8_000): Promise<unknown | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

// Mémoire du processus : liste de tendances (rafraîchie toutes les 30 s).
let lastScan = 0;
let ranked: { mint: string; pair: Pair; why: string }[] = [];
/** Comptes qui ont parcouru la liste actuelle sans rien acheter (valeur = lastScan de cette liste). */
const exhausted = new Map<string, number>();

async function refreshTrending(nowMs: number, cfgs: ScalpCfg[]) {
  if (nowMs - lastScan < SCALP_SCAN_MS) return;
  lastScan = nowMs;
  const pages = await Promise.all([1, 2].map((p) => getJson(`${GT}/networks/solana/trending_pools?page=${p}`)));
  const mints = [...new Set(pages.flatMap((p) => trendingMints(p)))].slice(0, 60);
  if (!mints.length) { ranked = []; return; }
  const pairs = new Map<string, Pair>();
  for (let i = 0; i < mints.length; i += 30) {
    const arr = await getJson(`${DX}/tokens/v1/solana/${mints.slice(i, i + 30).join(',')}`);
    for (const [m, p] of pickBestPairs(arr)) pairs.set(m, p);
  }
  const lo = Math.min(...cfgs.map((c) => c.mcapMin)), hi = Math.max(...cfgs.map((c) => c.mcapMax));
  ranked = mints.map((m) => ({ mint: m, pair: pairs.get(m)!, r: scalpPick(pairs.get(m), { mcapMin: lo, mcapMax: hi }, nowMs) }))
    .filter((x) => x.r.ok).map((x) => ({ mint: x.mint, pair: x.pair, why: x.r.why }))
    .sort((a, b) => num(b.pair.volume?.h1) - num(a.pair.volume?.h1));
}

async function riskOf(ctx: Ctx, mint: string, pair: Pair, budget: { n: number; fresh: number }): Promise<RiskResult | null> {
  const since = new Date(Date.now() - RISK_TTL_MS).toISOString();
  const { data } = await ctx.sb.from('risk_reports').select('score,level,has_critical,findings').eq('mint', mint).gte('created_at', since)
    .order('created_at', { ascending: false }).limit(1);
  if (data?.[0]) return riskFromRow(data[0]);
  if (budget.n <= 0) return null;
  budget.n--;
  const [summary, report] = await Promise.all([getJson(`${RC}/v1/tokens/${mint}/report/summary`), getJson(`${RC}/v1/tokens/${mint}/report`, 15_000)]);
  if (!summary && !report) return null; // RugCheck muet : jamais d'achat sans contrôle de risque
  const risk = scoreRisk({ summary: summary as never, report: report as never, pair, nowMs: Date.now() });
  await ctx.sb.from('tokens').upsert({ mint, symbol: pair.baseToken?.symbol ?? null, name: pair.baseToken?.name ?? null, logo_url: pair.info?.imageUrl ?? null }, { onConflict: 'mint' });
  await ctx.sb.from('risk_reports').insert({ mint, score: risk.score, level: risk.level, has_critical: risk.has_critical, findings: toStoredFindings(risk) });
  return risk;
}

type ScalpAcct = { id: string; label: string; mode: 'paper' | 'live'; cfg: ScalpCfg; live: LiveInfo | null };

async function loadScalpAccounts(ctx: Ctx): Promise<ScalpAcct[]> {
  const { data, error } = await ctx.sb.from('accounts')
    .select('id,label,mode,public_address,bot_state(status),settings!inner(scalping_enabled,scalp_tp_pct,scalp_sl_pct,scalp_max_positions,scalp_size_usd,scalp_mcap_min,scalp_mcap_max,max_risk_score),live_state(verified_at,baseline_usd,max_trade_usd,max_exposure_usd,max_daily_loss_usd,max_slippage_bps,paused_until,sol_usd)')
    .eq('settings.scalping_enabled', true);
  if (error || !data) return [];
  const one = <T>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? (x[0] ?? null) : (x ?? null));
  const out: ScalpAcct[] = [];
  for (const a of data as Record<string, unknown>[]) {
    const r = one(a.settings as Record<string, unknown> | null);
    if (!r || r.scalping_enabled !== true) continue;
    const bot = one(a.bot_state as { status?: string } | null);
    if (bot?.status !== 'running') continue; // le scalping suit l'état du bot : seulement quand il est en marche
    const ls = one(a.live_state as Record<string, unknown> | null);
    const live: LiveInfo | null = a.mode === 'live' && ls ? {
      address: (a.public_address as string | null) ?? null, verified: !!ls.verified_at, maxTradeUsd: num(ls.max_trade_usd, 10),
      maxExposureUsd: num(ls.max_exposure_usd, 30), maxDailyLossUsd: num(ls.max_daily_loss_usd, 15), maxSlippageBps: num(ls.max_slippage_bps, 500),
      pausedUntil: (ls.paused_until as string | null) ?? null, baselineUsd: num(ls.baseline_usd), solUsd: ls.sol_usd === null || ls.sol_usd === undefined ? null : num(ls.sol_usd),
    } : null;
    out.push({
      id: String(a.id), label: String(a.label), mode: a.mode === 'live' ? 'live' : 'paper', live,
      cfg: {
        tpPct: num(r.scalp_tp_pct, 5), slPct: num(r.scalp_sl_pct, 3), maxPositions: num(r.scalp_max_positions, 2), sizeUsd: num(r.scalp_size_usd, 13),
        mcapMin: num(r.scalp_mcap_min, 30_000), mcapMax: num(r.scalp_mcap_max, 10_000_000), maxRisk: num(r.max_risk_score, 40),
      },
    });
  }
  return out;
}

async function session(ctx: Ctx, a: ScalpAcct): Promise<Session | null> {
  const hit = ctx.live.get(a.id);
  if (hit) return 'S' in hit ? hit.S : null;
  if (!a.live || !liveGate(a.live, secretUsable(ctx.env.secret)).ready) return null;
  const res = await openSession({
    sb: ctx.sb, secret: ctx.env.secret, rpcUrl: ctx.env.rpcUrl, makeRpc: (u) => ctx.deps.makeRpc(u), makeJup: () => ctx.deps.makeJup(ctx.env.jupKey),
    fetchPrice: (m) => (m === SOL_MINT ? (ctx.solPrice ??= ctx.deps.fetchPrice(m)) : ctx.deps.fetchPrice(m)), log: (kind, agent, message, data) => ctx.events.push({ account_id: a.id, kind, agent, message, data }), deadline: ctx.deadline,
  }, a.id, a.live);
  ctx.live.set(a.id, res.ok ? { S: res.S } : { error: res.error });
  return res.ok ? res.S : null;
}

/** Un passage du scalping (après le tour normal). Une seule entrée par compte et par passage. */
export async function runScalp(ctx: Ctx): Promise<void> {
  const accts = await loadScalpAccounts(ctx);
  if (!accts.length) return;
  const now = Date.now();
  await refreshTrending(now, accts.map((a) => a.cfg));
  if (!ranked.length) return;
  const budget = { n: MAX_DEEP, fresh: 4 };
  for (const a of accts) {
    if (exhausted.get(a.id) === lastScan) continue; // liste déjà parcourue sans achat possible : on attend la prochaine
    try { if (await scalpAccount(ctx, a, budget) === 'none') exhausted.set(a.id, lastScan); } catch (e) {
      ctx.events.push({ account_id: a.id, kind: 'error', agent: 'EXECUTOR', message: `Scalping : erreur ${String((e as Error)?.message ?? e).slice(0, 200)}` });
    }
  }
}

async function scalpAccount(ctx: Ctx, a: ScalpAcct, budget: { n: number; fresh: number }): Promise<'bought' | 'blocked' | 'none'> {
  const { data: openRows } = await ctx.sb.from('positions').select('mint,size_usd,strategy').eq('account_id', a.id).in('status', ['open', 'closing']);
  const open = openRows ?? [];
  if (open.filter((p) => p.strategy === 'scalp').length >= a.cfg.maxPositions) return 'blocked';
  const since = new Date(Date.now() - REENTRY_COOLDOWN_MIN * 60_000).toISOString();
  const { data: recent } = await ctx.sb.from('positions').select('mint').eq('account_id', a.id).eq('status', 'closed').gte('closed_at', since);
  const busy = new Set([...open.map((p) => p.mint), ...(recent ?? []).map((p) => p.mint)]);

  for (const c of ranked) {
    if (busy.has(c.mint)) continue;
    if (!scalpPick(c.pair, a.cfg, Date.now()).ok) continue;
    const risk = await riskOf(ctx, c.mint, c.pair, budget);
    if (!risk || risk.has_critical || risk.score > a.cfg.maxRisk) continue;
    // Chiffres frais juste avant l'achat (la liste des tendances peut dater de 30 s).
    if (budget.fresh <= 0) return 'blocked';
    budget.fresh--;
    const fresh = pickBestPairs(await getJson(`${DX}/tokens/v1/solana/${c.mint}`)).get(c.mint);
    if (!fresh) continue;
    c.pair = fresh;
    const pick = scalpPick(fresh, a.cfg, Date.now());
    if (!pick.ok) continue;
    const sym = c.pair.baseToken?.symbol ?? `${c.mint.slice(0, 4)}…`;
    const why = `Scalping : ${pick.why}, risque ${risk.score}/100`;
    const price = num(c.pair.priceUsd);
    if (a.mode === 'paper') {
      const { data: st } = await ctx.sb.rpc('account_stats', { p_account: a.id });
      const s = (st ?? {}) as { initial?: number; realized_total?: number; open_size?: number };
      const cash = num(s.initial) + num(s.realized_total) - num(s.open_size);
      const usd = Math.floor(Math.min(a.cfg.sizeUsd, cash * 0.98) * 100) / 100;
      if (!(usd > 1)) return 'none';
      const f = simulateFill('BUY', price, usd, c.pair.liquidity?.usd ?? null);
      const { data: pid, error } = await ctx.sb.rpc('paper_open_position', {
        p_account: a.id, p_mint: c.mint, p_entry_price: f.fillPrice, p_qty: (usd - f.feeUsd) / f.fillPrice, p_size_usd: usd, p_fee: f.feeUsd, p_slip: f.slippagePct,
        p_stop: f.fillPrice * (1 - a.cfg.slPct / 100), p_tp: f.fillPrice * (1 + a.cfg.tpPct / 100), p_trailing: null, p_risk: risk.score, p_reason: why,
        p_max_positions: open.length + 1,
      });
      if (error) { ctx.events.push({ account_id: a.id, kind: 'warning', agent: 'EXECUTOR', message: `Scalping ${sym} refusé : ${error.message}` }); return 'none'; }
      ctx.events.push({ account_id: a.id, kind: 'buy', agent: 'EXECUTOR', message: `ACHAT SCALPING ${sym} — ${usd.toFixed(2)} $ | TP +${a.cfg.tpPct} % · SL −${a.cfg.slPct} % | ${pick.why}`, data: { step: 'BUY', mint: c.mint, position_id: pid, price: f.fillPrice, usd, paper: true, strategy: 'scalp' } });
      return 'bought';
    }
    const S = await session(ctx, a);
    if (!S) return 'none'; // moteur réel indisponible : déjà signalé par le bot normal
    const { data: st } = await ctx.sb.rpc('account_stats', { p_account: a.id });
    const openSize = open.reduce((t, p) => t + num(p.size_usd), 0);
    const gate = entryGate(S, openSize, num((st as { realized_24h?: number } | null)?.realized_24h), Date.now(), ctx.deadline - Date.now());
    if (!gate.ok) return 'none'; // limites du compte réel (exposition, perte du jour, SOL…) : le bot normal les signale déjà
    const usd = Math.floor(Math.min(a.cfg.sizeUsd, gate.maxUsd) * 100) / 100;
    if (!(usd >= 2)) return 'none';
    const r = await buyToken(S.L, {
      mint: c.mint, symbol: sym, usd, refPrice: price, risk: risk.score, reason: why, stopPct: a.cfg.slPct, tpPct: a.cfg.tpPct, trailingPct: null,
      maxPositions: open.length + 1, slippageBps: S.info.maxSlippageBps,
    });
    if (r.ok) {
      ctx.events.push({ account_id: a.id, kind: 'buy', agent: 'EXECUTOR', message: `ACHAT SCALPING ${sym} — ${r.usd.toFixed(2)} $ | TP +${a.cfg.tpPct} % · SL −${a.cfg.slPct} % | tx ${r.signature.slice(0, 8)}…`, data: { step: 'BUY', mint: c.mint, position_id: r.positionId, price: r.price, usd: r.usd, paper: false, strategy: 'scalp', signature: r.signature } });
      try { S.bal = await refreshBalances(S.L); } catch { /* relu au prochain tour */ }
      return 'bought';
    }
    if (r.code === 'mint' || r.code === 'guard') { busy.add(c.mint); continue; } // jeton refusé par les gardes : candidat suivant
    ctx.events.push({ account_id: a.id, kind: 'warning', agent: 'EXECUTOR', message: r.pending
      ? `Scalping ${sym} : achat envoyé, confirmation en attente (${r.error}) : réglé au prochain tour.`
      : `Scalping ${sym} : achat refusé (${r.error})`, data: { mint: c.mint, code: r.code, signature: r.signature ?? null } });
    return 'none';
  }
  return 'none';
}

/** Tests uniquement : remet à zéro la mémoire du processus. */
export function _resetScalp() { lastScan = 0; ranked = []; exhausted.clear(); }
