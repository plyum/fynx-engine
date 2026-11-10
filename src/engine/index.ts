// FYNX — moteur « tick » : appelé toutes les 30 s par pg_cron. Chaque appel reste éveillé ~26 s et enchaîne un tour de
// surveillance toutes les 5 s (voir runLoop). Sans état : tout est dans Postgres, donc un redémarrage ou un crash ne perd
// rien (reprise au tour suivant). Le verrou Postgres (acquire_tick_lock) interdit à deux appels de tourner en même temps.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  decideState, evaluateEntry, evaluateExit, extractMints, mergeAgentUpdates, pickBestPairs, rankCandidates,
  riskFromRow, scanIsDue, scoreRisk, sellGate, simulateFill, sizePosition, toStoredFindings,
  type AgentUpdate, type BotStatus, type Pair, type Requested, type RiskResult,
} from './lib.ts';
import { buildScanRow, type ScanAi, type ScanItem } from './scan.ts';
import { makeRpc, SOL_MINT, type Rpc } from './solana.ts';
import { makeJupiter, type Jupiter } from './jupiter.ts';
import { aiConfigFromEnv, buildAiInput, createAiGate, type AiGate, type AiInput, type GateResult } from './ai.ts';
import {
  AGENT_BUYER, AGENT_CHART, AGENT_CONTRACT, AGENT_MARKET, AGENT_SELLER, TEAM_AGENTS, TEAM_KEYS, TEAM_LABELS, noteOf,
  type AgentStats, type Held, type Note, type Prepared, type Team,
} from './aiteam.ts';
import { buyToken, fetchUsdPrice, refreshBalances, sellPosition } from './live.ts';
import {
  LIVE_DEADLINE_MS, canSell, entryGate, exitSlippageBps, liveGate, liveValue, openSession, secretUsable, tidyUp,
  type LiveInfo, type Session,
} from './livecycle.ts';

const DX = 'https://api.dexscreener.com';
const RC = 'https://api.rugcheck.xyz';
const RISK_TTL_MS = 10 * 60_000;
const MAX_DEEP_CHECKS = 4;
const MAX_ENTRIES_PER_TICK = 2;
const MAX_CANDIDATES = 12;
/** Temps maximal d'attente de l'IA par tour : un modèle lent ne doit jamais retarder les stops (le tour est séquentiel). */
export const AI_TICK_BUDGET_MS = 12_000;
// Garde-fou contre deux déclenchements quasi simultanés : très court, car le verrou Postgres protège déjà du chevauchement
// et un appel du cron ne doit jamais être refusé parce que le précédent vient de finir.
const MIN_TICK_GAP_MS = 1_000;
/** Un tour de surveillance (sorties, prix) toutes les 5 s à l'intérieur d'un même appel. */
export const FAST_GAP_MS = 5_000;
/** Un appel enchaîne des tours pendant cette durée (le cron le relance toutes les 30 s : pas de trou entre deux appels). */
export const LOOP_SPAN_MS = 26_000;
const REENTRY_COOLDOWN_MIN = 60;
const ENTRY_AGENTS = ['scanner', 'rugcheck', 'analyst', 'sizer', 'executor'] as const;

type Health1 = { ok: boolean; latency_ms: number; http_status: number | null; error: string | null };
type EventRow = { account_id: string | null; kind: string; agent: string | null; message: string; data?: unknown };
type Settings = {
  position_size_pct: number; max_trade_usd: number; max_daily_loss_pct: number; max_positions: number;
  stop_loss_pct: number; take_profit_pct: number; trailing_stop_pct: number | null; max_risk_score: number;
  scan_interval_seconds: number; caution_level: 'low' | 'medium' | 'high'; agents_enabled: Record<string, boolean>;
};
type Bot = { status: BotStatus; requested_status: Requested; started_at: string | null };
type Acct = { id: string; label: string; mode: 'paper' | 'live'; initial: number; bot: Bot; set: Settings; live: LiveInfo | null };
type Pos = {
  id: string; account_id: string; mint: string; status: 'open' | 'closing'; entry_price: number; qty: number; size_usd: number;
  stop_price: number | null; take_profit_price: number | null; trailing_pct: number | null; peak_price: number | null;
  risk_score: number | null; opened_at: number | null;
};
type Plan = { a: Acct; prev: BotStatus; next: BotStatus; resetRequested?: Requested; pending?: boolean };
type Cand = { mint: string; pair: Pair; rank: number };
export type Ctx = {
  sb: SupabaseClient;
  health: Record<string, Health1>;
  events: EventRow[];
  agents: Map<string, AgentUpdate[]>;
  pairsAt: number;
  symbols: Map<string, string>;
  env: { secret: string; rpcUrl: string; jupKey: string | undefined };
  deadline: number;
  live: Map<string, { S: Session } | { error: string }>;
  solPrice?: Promise<number | null>;
  /** Agent « Analyste IA » (veto sur les entrées déjà acceptées par les règles) ; absent = règles seules. */
  ai?: AiGate | null;
  /** Temps déjà passé à attendre l'IA pendant ce tour (ms) : au-delà de AI_TICK_BUDGET_MS, on n'attend plus (les règles décident seules). */
  aiMs?: number;
  /** Équipe IA (analystes Graphique et Marché, contrôleurs d'achat et de vente) ; absente = Analyste Contrat seul. */
  team?: Team | null;
  /** Accès réseau du compte réel, injectables pour les tests. */
  deps: { makeRpc: (url: string) => Rpc; makeJup: (apiKey?: string) => Jupiter; fetchPrice: (mint: string) => Promise<number | null> };
};

const num = (v: unknown, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const one = <T>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? (x[0] ?? null) : (x ?? null));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chunk = <T>(a: T[], n: number) => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}`;
const fmtPrice = (p: number) => (p >= 1 ? p.toFixed(4) : p.toPrecision(4));
const short = (m: string) => `${m.slice(0, 4)}…${m.slice(-4)}`;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function ev(ctx: Ctx, accountId: string | null, kind: string, agent: string | null, message: string, data?: unknown) {
  ctx.events.push({ account_id: accountId, kind, agent, message, data });
}
function ag(ctx: Ctx, accountId: string, u: AgentUpdate) {
  const l = ctx.agents.get(accountId) ?? [];
  l.push(u);
  ctx.agents.set(accountId, l);
}

const aiOn = (a: Acct, agent: string) => a.set.agents_enabled?.[TEAM_KEYS[agent]] !== false;

/** Attend un avis de l'IA sans dépasser le temps d'attente du tour (AI_TICK_BUDGET_MS) ; au-delà : « pas d'avis ». */
async function aiWait<T extends { ok: boolean }>(ctx: Ctx, p: Promise<T>): Promise<T | { ok: false; reason: 'paused'; detail: string }> {
  const left = AI_TICK_BUDGET_MS - (ctx.aiMs ?? 0);
  const late = { ok: false as const, reason: 'paused' as const, detail: `temps d’attente de l’IA épuisé pour ce tour (${AI_TICK_BUDGET_MS / 1000} s)` };
  if (left <= 0) return late;
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<typeof late>((res) => { timer = setTimeout(() => res(late), left); })]);
  } finally {
    clearTimeout(timer);
    ctx.aiMs = (ctx.aiMs ?? 0) + (Date.now() - t0);
  }
}

// ───────────────────────── Réseau (avec mesure de santé des API) ─────────────────────────

async function getJson(ctx: Ctx, service: string, url: string, timeoutMs = 10_000): Promise<unknown | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = performance.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
      const text = await r.text();
      const latency = Math.round(performance.now() - t0);
      // 404 = token inconnu de la source : ce n'est pas une panne.
      if (r.ok || r.status === 404) {
        const prev = ctx.health[service];
        if (!prev || prev.ok) ctx.health[service] = { ok: true, latency_ms: Math.max(latency, prev?.latency_ms ?? 0), http_status: r.status, error: null };
        return r.ok ? JSON.parse(text) : null;
      }
      ctx.health[service] = { ok: false, latency_ms: latency, http_status: r.status, error: text.slice(0, 200) };
      if (r.status < 500) return null; // 429 / 4xx : pas de nouvel essai immédiat
    } catch (e) {
      ctx.health[service] = { ok: false, latency_ms: Math.round(performance.now() - t0), http_status: null, error: String(e).slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
    if (attempt === 0) await sleep(500);
  }
  return null;
}

async function fetchPairs(ctx: Ctx, mints: string[]): Promise<Map<string, Pair>> {
  const out = new Map<string, Pair>();
  const results = await Promise.all(chunk(mints, 30).map((c) => getJson(ctx, 'dexscreener_tokens', `${DX}/tokens/v1/solana/${c.join(',')}`)));
  ctx.pairsAt = Date.now();
  for (const arr of results) for (const [m, p] of pickBestPairs(arr)) {
    const prev = out.get(m);
    if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) out.set(m, p);
  }
  return out;
}

// ───────────────────────── Chargement ─────────────────────────

async function loadAccounts(ctx: Ctx): Promise<Acct[]> {
  const { data, error } = await ctx.sb.from('accounts')
    .select('id,label,mode,paper_initial_capital,public_address,bot_state(status,requested_status,started_at),settings(*),live_state(verified_at,baseline_usd,max_trade_usd,max_exposure_usd,max_daily_loss_usd,max_slippage_bps,paused_until,sol_usd)');
  if (error) throw new Error(`accounts: ${error.message}`);
  const out: Acct[] = [];
  for (const r of data ?? []) {
    const bot = one(r.bot_state as Bot | Bot[] | null);
    const set = one(r.settings as Settings | Settings[] | null);
    if (!bot || !set) continue;
    const ls = one(r.live_state as Record<string, unknown> | Record<string, unknown>[] | null);
    const live: LiveInfo | null = r.mode === 'live' && ls ? {
      address: (r.public_address as string | null) ?? null, verified: !!ls.verified_at, maxTradeUsd: num(ls.max_trade_usd, 10),
      maxExposureUsd: num(ls.max_exposure_usd, 30), maxDailyLossUsd: num(ls.max_daily_loss_usd, 15), maxSlippageBps: num(ls.max_slippage_bps, 500),
      pausedUntil: (ls.paused_until as string | null) ?? null, baselineUsd: num(ls.baseline_usd), solUsd: ls.sol_usd === null ? null : num(ls.sol_usd),
    } : null;
    out.push({
      id: r.id, label: r.label, mode: r.mode, initial: num(r.paper_initial_capital), bot, live,
      set: {
        ...set,
        position_size_pct: num(set.position_size_pct), max_trade_usd: num(set.max_trade_usd), max_daily_loss_pct: num(set.max_daily_loss_pct),
        max_positions: num(set.max_positions), stop_loss_pct: num(set.stop_loss_pct), take_profit_pct: num(set.take_profit_pct),
        trailing_stop_pct: set.trailing_stop_pct === null ? null : num(set.trailing_stop_pct), max_risk_score: num(set.max_risk_score),
        scan_interval_seconds: num(set.scan_interval_seconds, 60),
      },
    });
  }
  return out;
}

function toPos(r: Record<string, unknown>): Pos {
  return {
    id: String(r.id), account_id: String(r.account_id), mint: String(r.mint), status: r.status === 'closing' ? 'closing' : 'open',
    entry_price: num(r.entry_price), qty: num(r.qty),
    size_usd: num(r.size_usd), stop_price: r.stop_price === null ? null : num(r.stop_price),
    take_profit_price: r.take_profit_price === null ? null : num(r.take_profit_price),
    trailing_pct: r.trailing_pct === null ? null : num(r.trailing_pct), peak_price: r.peak_price === null ? null : num(r.peak_price),
    risk_score: r.risk_score === null ? null : num(r.risk_score),
    opened_at: typeof r.opened_at === 'string' && Number.isFinite(Date.parse(r.opened_at)) ? Date.parse(r.opened_at) : null,
  };
}

async function loadOpenPositions(ctx: Ctx, accountId?: string): Promise<Map<string, Pos[]>> {
  let q = ctx.sb.from('positions').select('*').in('status', ['open', 'closing']);
  if (accountId) q = q.eq('account_id', accountId);
  const { data, error } = await q;
  if (error) throw new Error(`positions: ${error.message}`);
  const m = new Map<string, Pos[]>();
  for (const r of data ?? []) {
    const p = toPos(r as Record<string, unknown>);
    m.set(p.account_id, [...(m.get(p.account_id) ?? []), p]);
  }
  return m;
}

async function recentlyLogged(ctx: Ctx, accountId: string, kind: string, prefix: string, minutes: number): Promise<boolean> {
  const since = new Date(Date.now() - minutes * 60_000).toISOString();
  const { data } = await ctx.sb.from('events').select('id').eq('account_id', accountId).eq('kind', kind)
    .like('message', `${prefix}%`).gte('created_at', since).limit(1);
  return (data?.length ?? 0) > 0;
}

// ───────────────────────── Découverte + analyse de risque ─────────────────────────

async function discover(ctx: Ctx): Promise<{ mints: string[]; feedsOk: number }> {
  const [rcNew, boosts, profiles] = await Promise.all([
    getJson(ctx, 'rugcheck_new_tokens', `${RC}/v1/stats/new_tokens`),
    getJson(ctx, 'dexscreener_boosts', `${DX}/token-boosts/latest/v1`),
    getJson(ctx, 'dexscreener_profiles', `${DX}/token-profiles/latest/v1`),
  ]);
  const feedsOk = [rcNew, boosts, profiles].filter((x) => Array.isArray(x)).length;
  return { mints: extractMints({ boosts, profiles, rcNew }), feedsOk };
}

async function deepCheck(ctx: Ctx, mint: string, pair: Pair): Promise<{ risk: RiskResult; holders: number | null } | null> {
  const [summary, report] = await Promise.all([
    getJson(ctx, 'rugcheck_summary', `${RC}/v1/tokens/${mint}/report/summary`),
    getJson(ctx, 'rugcheck_report', `${RC}/v1/tokens/${mint}/report`, 20_000),
  ]);
  // RugCheck muet : aucune décision d'achat sur ce token (jamais de « risque inconnu = sûr »).
  if (!summary && !report) return null;
  const risk = scoreRisk({ summary: summary as never, report: report as never, pair, nowMs: Date.now() });
  const holders = num((report as { totalHolders?: number } | null)?.totalHolders, -1);
  return { risk, holders: holders >= 0 ? holders : null };
}

// ───────────────────────── Comptabilité d'un compte ─────────────────────────

type AState = { cash: number; equity: number; openValue: number; unpriced: number; drawdown: number; realized24: number };

async function lastKnownPrices(ctx: Ctx, mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!mints.length) return out;
  const { data } = await ctx.sb.from('token_snapshots').select('mint,price_usd,fetched_at').in('mint', mints)
    .not('price_usd', 'is', null).order('fetched_at', { ascending: false }).limit(mints.length * 5);
  for (const r of data ?? []) if (!out.has(r.mint)) out.set(r.mint, num(r.price_usd));
  return out;
}

async function accountState(ctx: Ctx, a: Acct, positions: Pos[], pairs: Map<string, Pair>, live: Session | null = null): Promise<AState> {
  const { data, error } = await ctx.sb.rpc('account_stats', { p_account: a.id });
  if (error || !data) throw new Error(`account_stats: ${error?.message ?? 'vide'}`);
  const s = data as { initial: number; realized_total: number; realized_24h: number; open_size: number; peak_equity: number };
  // Papier : liquidités simulées. Réel : les VRAIS soldes du portefeuille (USDC + SOL), jamais un calcul.
  let cash = num(s.initial) + num(s.realized_total) - num(s.open_size);
  const missing = positions.filter((p) => !(num(pairs.get(p.mint)?.priceUsd) > 0)).map((p) => p.mint);
  const last = await lastKnownPrices(ctx, missing);
  let openValue = 0, unpriced = 0;
  for (const p of positions) {
    let px = num(pairs.get(p.mint)?.priceUsd);
    if (!(px > 0)) px = last.get(p.mint) ?? 0;
    if (!(px > 0)) { px = p.entry_price; unpriced++; }
    openValue += p.qty * px;
  }
  let equity = cash + openValue;
  if (live) {
    const v = liveValue(live.bal, live.L.solUsd, openValue);
    cash = v.cash;
    equity = v.equity;
  }
  const peak = Math.max(num(s.peak_equity), equity);
  return { cash, equity, openValue, unpriced, drawdown: peak > 0 ? Math.max(0, ((peak - equity) / peak) * 100) : 0, realized24: num(s.realized_24h) };
}

const symOf = (ctx: Ctx, mint: string, pair?: Pair | null) => pair?.baseToken?.symbol ?? ctx.symbols.get(mint) ?? short(mint);

// ───────────────────────── Ordres papier ─────────────────────────

async function sell(ctx: Ctx, a: Acct, pos: Pos, pair: Pair, reason: string): Promise<boolean> {
  const price = num(pair.priceUsd);
  const f = simulateFill('SELL', price, pos.qty * price, pair.liquidity?.usd ?? null);
  const sym = symOf(ctx, pos.mint, pair);
  const { data, error } = await ctx.sb.rpc('paper_close_position', {
    p_position: pos.id, p_exit_price: f.fillPrice, p_fee: f.feeUsd, p_slip: f.slippagePct, p_reason: reason,
  });
  if (error) {
    ev(ctx, a.id, 'error', 'EXECUTOR', `Vente ${sym} échouée : ${error.message}`, { mint: pos.mint, position_id: pos.id, reason });
    ag(ctx, a.id, { agent: 'EXECUTOR', status: 'ERROR', err: error.message.slice(0, 200) });
    return false;
  }
  const r = data as { pnl_usd: number; pnl_pct: number; order_id: string };
  ev(ctx, a.id, 'sell', 'EXECUTOR',
    `VENTE ${sym} — ${reason} | sortie ${fmtPrice(f.fillPrice)} $ (slippage ${f.slippagePct.toFixed(2)} %, frais ${f.feeUsd.toFixed(2)} $) | PnL ${signed(num(r.pnl_usd))} $ (${signed(num(r.pnl_pct))} %)`,
    { step: 'SELL', mint: pos.mint, position_id: pos.id, order_id: r.order_id, price: f.fillPrice, pnl_usd: r.pnl_usd, pnl_pct: r.pnl_pct, reason, paper: true });
  ag(ctx, a.id, { agent: 'EXECUTOR', status: 'RUNNING', n: 1 });
  return true;
}

async function buy(
  ctx: Ctx, a: Acct, c: Cand, risk: RiskResult, usd: number, why: string,
): Promise<{ ok: boolean; qty?: number; fillPrice?: number }> {
  const price = num(c.pair.priceUsd);
  const f = simulateFill('BUY', price, usd, c.pair.liquidity?.usd ?? null);
  const qty = (usd - f.feeUsd) / f.fillPrice;
  const s = a.set;
  const sym = symOf(ctx, c.mint, c.pair);
  const { data, error } = await ctx.sb.rpc('paper_open_position', {
    p_account: a.id, p_mint: c.mint, p_entry_price: f.fillPrice, p_qty: qty, p_size_usd: usd,
    p_fee: f.feeUsd, p_slip: f.slippagePct,
    p_stop: f.fillPrice * (1 - s.stop_loss_pct / 100), p_tp: f.fillPrice * (1 + s.take_profit_pct / 100),
    p_trailing: s.trailing_stop_pct, p_risk: risk.score, p_reason: why, p_max_positions: s.max_positions,
  });
  if (error) {
    const known = /insufficient_cash|max_positions_reached/.test(error.message);
    ev(ctx, a.id, known ? 'warning' : 'error', 'EXECUTOR', `Achat ${sym} refusé : ${error.message}`, { mint: c.mint });
    if (!known) ag(ctx, a.id, { agent: 'EXECUTOR', status: 'ERROR', err: error.message.slice(0, 200) });
    return { ok: false };
  }
  ev(ctx, a.id, 'buy', 'EXECUTOR',
    `ACHAT ${sym} — ${usd.toFixed(2)} $ à ${fmtPrice(f.fillPrice)} $ (slippage ${f.slippagePct.toFixed(2)} %, frais ${f.feeUsd.toFixed(2)} $) | SL ${fmtPrice(f.fillPrice * (1 - s.stop_loss_pct / 100))} $ · TP ${fmtPrice(f.fillPrice * (1 + s.take_profit_pct / 100))} $${s.trailing_stop_pct ? ` · trailing ${s.trailing_stop_pct} %` : ''}`,
    { step: 'BUY', mint: c.mint, position_id: data, price: f.fillPrice, usd, qty, risk_score: risk.score, reason: why, paper: true });
  ag(ctx, a.id, { agent: 'EXECUTOR', status: 'RUNNING', n: 1 });
  return { ok: true, qty, fillPrice: f.fillPrice };
}

// ───────────────────────── Ordres réels (Jupiter, compte réel) ─────────────────────────

async function getLive(ctx: Ctx, a: Acct): Promise<Session | null> {
  const hit = ctx.live.get(a.id);
  if (hit) return 'S' in hit ? hit.S : null;
  let res: { ok: true; S: Session } | { ok: false; error: string };
  if (!a.live) res = { ok: false, error: 'état du compte réel introuvable' };
  else if (!secretUsable(ctx.env.secret)) res = { ok: false, error: 'le secret de chiffrement des portefeuilles (WALLET_ENCRYPTION_KEY) n’est pas configuré' };
  else {
    res = await openSession({
      sb: ctx.sb, secret: ctx.env.secret, rpcUrl: ctx.env.rpcUrl, makeRpc: (u) => ctx.deps.makeRpc(u), makeJup: () => ctx.deps.makeJup(ctx.env.jupKey),
      fetchPrice: (m) => (m === SOL_MINT ? (ctx.solPrice ??= ctx.deps.fetchPrice(m)) : ctx.deps.fetchPrice(m)),
      log: (kind, agent, message, data) => ev(ctx, a.id, kind, agent, message, data), deadline: ctx.deadline,
    }, a.id, a.live);
  }
  if (!res.ok) {
    ctx.live.set(a.id, { error: res.error });
    ag(ctx, a.id, { agent: 'EXECUTOR', status: 'ERROR', err: `Moteur réel indisponible : ${res.error}`.slice(0, 200) });
    if (!(await recentlyLogged(ctx, a.id, 'error', 'Moteur réel indisponible', 10))) {
      ev(ctx, a.id, 'error', 'EXECUTOR', `Moteur réel indisponible : ${res.error}. Aucun achat ni vente tant que ce n’est pas réglé (les positions restent en place).`);
    }
    return null;
  }
  ctx.live.set(a.id, { S: res.S });
  return res.S;
}

/** Relit les vrais soldes après un ordre : sans cela l'équité compterait deux fois l'argent investi. */
async function refreshLive(ctx: Ctx, a: Acct, S: Session) {
  try { S.bal = await refreshBalances(S.L); } catch (e) {
    ev(ctx, a.id, 'warning', 'EQUITY', `Soldes non relus après l’ordre : ${String((e as Error)?.message ?? e).slice(0, 160)}`);
  }
}

async function abandonPosition(ctx: Ctx, a: Acct, pos: Pos, sym: string, why: string) {
  const { error } = await ctx.sb.rpc('live_abandon_position', { p_position: pos.id, p_reason: why });
  if (error) {
    ev(ctx, a.id, 'error', 'EXECUTOR', `${sym} : abandon impossible (${error.message})`, { position_id: pos.id });
    return;
  }
  ev(ctx, a.id, 'warning', 'EXECUTOR', `${sym} : ${why}`, { position_id: pos.id, mint: pos.mint, abandoned: true });
  ag(ctx, a.id, { agent: 'EXECUTOR', status: 'WARNING', n: 0, err: `${sym} abandonné : jetons invendables.` });
}

/** Vente réelle. true = vendue et réglée ; false = non vendue (attente, échec, confirmation en cours ou abandon). */
async function liveSell(ctx: Ctx, a: Acct, pos: Pos, pair: Pair | null, reason: string, S: Session): Promise<boolean> {
  const sym = symOf(ctx, pos.mint, pair);
  const gate = sellGate(S.failedSells.get(pos.id) ?? [], Date.now());
  if (gate.action === 'abandon') {
    await abandonPosition(ctx, a, pos, sym, `invendable : ${gate.n} ventes échouées en 3 h, position abandonnée (les jetons restent dans le portefeuille, la valeur n’est plus comptée).`);
    return false;
  }
  if (gate.action === 'wait') return false;
  const can = canSell(S, ctx.deadline - Date.now());
  if (!can.ok) {
    if (!(await recentlyLogged(ctx, a.id, 'warning', 'Vente reportée', 10))) ev(ctx, a.id, 'warning', 'EXECUTOR', `Vente reportée : ${can.reason}.`);
    return false;
  }
  const price = num(pair?.priceUsd);
  const r = await sellPosition(S.L, {
    position: { id: pos.id, mint: pos.mint, qty: pos.qty, size_usd: pos.size_usd, entry_price: pos.entry_price },
    reason, refPrice: price > 0 ? price : null, slippageBps: exitSlippageBps(S.info.maxSlippageBps), level: 'veryHigh',
  });
  if (r.ok) {
    ev(ctx, a.id, 'sell', 'EXECUTOR',
      `VENTE ${sym} — ${reason} | sortie ${fmtPrice(r.price)} $ (slippage ${r.slipPct.toFixed(2)} %, frais ${r.feeUsd.toFixed(3)} $) | PnL ${signed(r.pnlUsd)} $ (${signed(r.pnlPct)} %) | tx ${r.signature.slice(0, 8)}…`,
      { step: 'SELL', mint: pos.mint, position_id: pos.id, price: r.price, usd: r.usd, qty: r.qty, pnl_usd: r.pnlUsd, pnl_pct: r.pnlPct, reason, paper: false, signature: r.signature });
    ag(ctx, a.id, { agent: 'EXECUTOR', status: 'RUNNING', n: 1 });
    return true;
  }
  if (r.code === 'empty') {
    await abandonPosition(ctx, a, pos, sym, 'aucun jeton de cette position dans le portefeuille : position clôturée sans vente.');
    return false;
  }
  if (r.pending) {
    ev(ctx, a.id, 'warning', 'EXECUTOR', `Vente ${sym} envoyée, confirmation en attente (${r.error}) : réglée au prochain tick, aucune nouvelle vente d’ici là.`, { position_id: pos.id, signature: r.signature ?? null });
    return false;
  }
  // 'swap' et 'quote' ont écrit un ordre « échoué » en base : ils comptent pour l'espacement des tentatives.
  if (r.code === 'swap' || r.code === 'quote') S.failedSells.set(pos.id, [...(S.failedSells.get(pos.id) ?? []), Date.now()]);
  ev(ctx, a.id, 'error', 'EXECUTOR', `Vente ${sym} échouée : ${r.error} (nouvel essai espacé automatiquement)`, { mint: pos.mint, position_id: pos.id, reason, code: r.code });
  ag(ctx, a.id, { agent: 'EXECUTOR', status: 'ERROR', err: `Vente ${sym} : ${r.error}`.slice(0, 200) });
  return false;
}

/** Achat réel. `halt` : ne pas tenter d'autre achat ce tick. */
async function liveBuy(
  ctx: Ctx, a: Acct, c: Cand, risk: RiskResult, usd: number, why: string, S: Session,
): Promise<{ ok: boolean; halt: boolean; usd?: number }> {
  const s = a.set;
  const sym = symOf(ctx, c.mint, c.pair);
  const r = await buyToken(S.L, {
    mint: c.mint, symbol: sym, usd, refPrice: num(c.pair.priceUsd), risk: risk.score, reason: why, stopPct: s.stop_loss_pct,
    tpPct: s.take_profit_pct, trailingPct: s.trailing_stop_pct, maxPositions: s.max_positions, slippageBps: S.info.maxSlippageBps,
  });
  if (r.ok) {
    const f = (p: number) => fmtPrice(p);
    ev(ctx, a.id, 'buy', 'EXECUTOR',
      `ACHAT ${sym} — ${r.usd.toFixed(2)} $ à ${f(r.price)} $ (slippage ${r.slipPct.toFixed(2)} %, frais ${r.feeUsd.toFixed(3)} $) | SL ${f(r.price * (1 - s.stop_loss_pct / 100))} $ · TP ${f(r.price * (1 + s.take_profit_pct / 100))} $${s.trailing_stop_pct ? ` · trailing ${s.trailing_stop_pct} %` : ''} | tx ${r.signature.slice(0, 8)}…`,
      { step: 'BUY', mint: c.mint, position_id: r.positionId, price: r.price, usd: r.usd, qty: r.qty, risk_score: risk.score, reason: why, paper: false, signature: r.signature });
    ag(ctx, a.id, { agent: 'EXECUTOR', status: 'RUNNING', n: 1 });
    return { ok: true, halt: false, usd: r.usd };
  }
  // Refus de garde avant tout ordre (jeton gelable, prix décalé, revente impossible…) : on essaie le candidat suivant.
  if (r.code === 'mint' || r.code === 'guard') {
    ev(ctx, a.id, 'filtered', 'EXECUTOR', `REJETÉ ${sym} — ${r.error}`, { step: 'GARDE', mint: c.mint, code: r.code });
    return { ok: false, halt: false };
  }
  if (r.pending) {
    ev(ctx, a.id, 'warning', 'EXECUTOR', `Achat ${sym} envoyé, confirmation en attente (${r.error}) : réglé au prochain tick.`, { mint: c.mint, signature: r.signature ?? null });
  } else {
    ev(ctx, a.id, r.code === 'limit' || r.code === 'price' ? 'warning' : 'error', 'EXECUTOR', `Achat ${sym} refusé : ${r.error}`, { mint: c.mint, code: r.code });
    if (r.code !== 'limit' && r.code !== 'price') ag(ctx, a.id, { agent: 'EXECUTOR', status: 'ERROR', err: `Achat ${sym} : ${r.error}`.slice(0, 200) });
  }
  return { ok: false, halt: true };
}

// ───────────────────────── Un tick complet ─────────────────────────

/**
 * Un tour du moteur. `full: false` = tour rapide (toutes les 5 s) : prix des positions, sorties (stop loss / take profit /
 * trailing / arrêt demandé), ordres en attente, état du bot. Le portefeuille réel n'est ouvert (clé déchiffrée, soldes relus
 * sur le réseau) que si un ordre doit partir ou être réconcilié. Valorisation, graphique d'équité, état des agents et
 * instantanés de prix restent au rythme d'un tour complet (~30 s). Un tour où la recherche de tokens est due est toujours complet.
 */
export async function runTick(ctx: Ctx, opts: { full?: boolean } = {}) {
  const { sb } = ctx;
  const t0 = Date.now();
  const nowIso = new Date().toISOString();
  const accts = await loadAccounts(ctx);
  const open = await loadOpenPositions(ctx);

  // Comptes réels : ordres encore « en attente » (à réconcilier même si le bot est arrêté)
  const { data: pend } = await sb.from('orders').select('account_id').eq('is_paper', false).eq('status', 'pending');
  const livePending = new Set<string>((pend ?? []).map((r: { account_id: string }) => r.account_id));
  const secretOk = secretUsable(ctx.env.secret);

  // 1) Machine d'état
  const plans: Plan[] = [];
  for (const a of accts) {
    const d = decideState({
      mode: a.mode, status: a.bot.status, requested: a.bot.requested_status, openCount: (open.get(a.id) ?? []).length,
      liveGate: a.mode === 'live' ? liveGate(a.live, secretOk) : undefined,
    });
    if (d.event) ev(ctx, a.id, d.level === 'warning' ? 'warning' : 'state', 'SYSTEM', d.event, { from: a.bot.status, to: d.next });
    plans.push({ a, prev: a.bot.status, next: d.next, resetRequested: d.resetRequested, pending: livePending.has(a.id) });
  }
  const active = plans.filter((p) => p.next !== 'stopped');
  const runners = plans.filter((p) => p.next === 'running');

  // Les agents d'entrée désactivés bloquent les nouvelles entrées (les sorties restent toujours actives par sécurité).
  const entryBlockedBy = new Map<string, string>();
  for (const p of runners) {
    const off = ENTRY_AGENTS.find((k) => p.a.set.agents_enabled?.[k] === false);
    if (off) entryBlockedBy.set(p.a.id, off.toUpperCase());
  }
  const scanners = runners.filter((p) => !entryBlockedBy.has(p.a.id));

  // 2) Faut-il scanner maintenant ?
  let scanDue = false;
  if (scanners.length) {
    const minInt = Math.min(...scanners.map((p) => p.a.set.scan_interval_seconds));
    const { data: ls } = await sb.from('api_health').select('checked_at').eq('service', 'engine_scan').maybeSingle();
    const age = ls ? Date.now() - Date.parse(ls.checked_at) : Infinity;
    scanDue = scanIsDue(age, minInt);
  }
  const full = opts.full !== false || scanDue;

  // 3) Prix des positions ouvertes + candidats
  const posMints = new Set<string>();
  for (const p of active) for (const pos of open.get(p.a.id) ?? []) posMints.add(pos.mint);
  let discovered: string[] = [];
  let feedsOk = 3;
  if (scanDue) ({ mints: discovered, feedsOk } = await discover(ctx));
  const allMints = [...new Set([...posMints, ...discovered])];
  const pairs = allMints.length ? await fetchPairs(ctx, allMints) : new Map<string, Pair>();

  if (posMints.size) {
    const { data: toks } = await sb.from('tokens').select('mint,symbol').in('mint', [...posMints]);
    for (const t of toks ?? []) if (t.symbol) ctx.symbols.set(t.mint, t.symbol);
  }

  const cands: Cand[] = scanDue ? rankCandidates(pairs, discovered).slice(0, MAX_CANDIDATES) : [];

  // 4) Risque : rapports récents (≤ 10 min) réutilisés, sinon analyse complète (limitée par tick)
  const riskMap = new Map<string, { risk: RiskResult; fresh: boolean }>();
  let deepAttempts = 0, deepFailures = 0;
  if (cands.length) {
    const since = new Date(Date.now() - RISK_TTL_MS).toISOString();
    const { data: rows } = await sb.from('risk_reports').select('mint,score,level,has_critical,findings,created_at')
      .in('mint', cands.map((c) => c.mint)).gte('created_at', since).order('created_at', { ascending: false });
    for (const r of rows ?? []) if (!riskMap.has(r.mint)) riskMap.set(r.mint, { risk: riskFromRow(r), fresh: false });

    const toCheck = cands.filter((c) => !riskMap.has(c.mint)).slice(0, MAX_DEEP_CHECKS);
    deepAttempts = toCheck.length;
    const results = await Promise.all(toCheck.map((c) => deepCheck(ctx, c.mint, c.pair)));
    const reports: Record<string, unknown>[] = [];
    const tokenRows: Record<string, unknown>[] = [];
    const snaps: Record<string, unknown>[] = [];
    toCheck.forEach((c, i) => {
      const r = results[i];
      if (!r) { deepFailures++; return; }
      riskMap.set(c.mint, { risk: r.risk, fresh: true });
      reports.push({ mint: c.mint, score: r.risk.score, level: r.risk.level, has_critical: r.risk.has_critical, findings: toStoredFindings(r.risk) });
      tokenRows.push({ mint: c.mint, symbol: c.pair.baseToken?.symbol ?? null, name: c.pair.baseToken?.name ?? null, logo_url: c.pair.info?.imageUrl ?? null });
      ctx.symbols.set(c.mint, c.pair.baseToken?.symbol ?? short(c.mint));
      snaps.push({
        mint: c.mint, price_usd: num(c.pair.priceUsd), market_cap: c.pair.marketCap ?? null, volume_24h: c.pair.volume?.h24 ?? null,
        liquidity_usd: c.pair.liquidity?.usd ?? null, holders: r.holders, source: 'dexscreener',
      });
    });
    // Le token doit exister avant son rapport (clé étrangère éventuelle) : on l'enregistre d'abord.
    if (tokenRows.length) {
      const { error } = await sb.from('tokens').upsert(tokenRows, { onConflict: 'mint' });
      if (error) ev(ctx, null, 'error', 'LOGGER', `tokens: ${error.message}`);
    }
    if (reports.length) {
      const { error } = await sb.from('risk_reports').insert(reports);
      if (error) ev(ctx, null, 'error', 'LOGGER', `risk_reports: ${error.message}`);
    }
    if (snaps.length) await sb.from('token_snapshots').insert(snaps);
  }

  // 4 bis) Équipe IA : les analystes lisent, une fois par scan et pour tous les comptes, les jetons que les règles d'au moins un compte
  // acceptent — AVANT la taille de position, donc même si les positions sont pleines. Rien n'est attendu ici : les appels tournent
  // pendant que les sorties sont traitées, et l'achat lit leurs avis plus bas.
  const pre = new Map<string, { prepared: Prepared; ai: AiInput; price: number }>();
  if (ctx.team && cands.length) {
    for (const c of cands) {
      if (pre.size >= ctx.team.cfg.maxPerScan) break;
      const rk = riskMap.get(c.mint);
      if (!rk) continue;
      const fans = scanners.filter((p) => evaluateEntry(c.pair, rk.risk, { max_risk_score: p.a.set.max_risk_score, caution_level: p.a.set.caution_level }, Date.now() - ctx.pairsAt).ok
        && !(open.get(p.a.id) ?? []).some((x) => x.mint === c.mint));
      if (!fans.length) continue;
      const on = { contract: !!ctx.ai && fans.some((p) => aiOn(p.a, AGENT_CONTRACT)), chart: fans.some((p) => aiOn(p.a, AGENT_CHART)), market: fans.some((p) => aiOn(p.a, AGENT_MARKET)) };
      const ai = buildAiInput(c.mint, c.pair, rk.risk, Date.now());
      const gate = ctx.ai;
      pre.set(c.mint, { ai, price: num(c.pair.priceUsd), prepared: ctx.team.analyze({ mint: c.mint, pair: c.pair, ai }, on, gate ? () => gate.review(ai) : null) });
    }
  }
  const teamStats = ctx.team && full ? ctx.team.drainStats() : null;

  // Instantanés de prix des positions ouvertes (historique réel pour la fiche token)
  const posSnaps: Record<string, unknown>[] = [];
  for (const m of posMints) {
    const pr = pairs.get(m);
    if (pr) posSnaps.push({ mint: m, price_usd: num(pr.priceUsd), market_cap: pr.marketCap ?? null, volume_24h: pr.volume?.h24 ?? null, liquidity_usd: pr.liquidity?.usd ?? null, holders: null, source: 'dexscreener' });
  }
  if (posSnaps.length && full) await sb.from('token_snapshots').insert(posSnaps);

  // 5) Traitement par compte
  let orders = 0;
  const perAccount: Record<string, unknown>[] = [];
  for (const p of plans) {
    const a = p.a;
    if (p.next === 'stopped' && p.prev === 'stopped' && !p.resetRequested && !livePending.has(a.id)) continue;
    try {
      const info = await processAccount(ctx, p, open.get(a.id) ?? [], pairs, {
        scanDue, full, cands, riskMap, discoveredCount: discovered.length, feedsOk, deepAttempts, deepFailures,
        blockedBy: entryBlockedBy.get(a.id) ?? null, pairsFailed: ctx.health['dexscreener_tokens']?.ok === false, pre, teamStats,
      });
      orders += Number(info.orders ?? 0);
      perAccount.push({ account: a.label, ...info });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      ev(ctx, a.id, 'error', 'SYSTEM', `Erreur du moteur : ${msg}`);
      ag(ctx, a.id, { agent: 'EXECUTOR', status: 'ERROR', err: msg });
      perAccount.push({ account: a.label, error: msg });
    }
  }

  // 5 bis) Contrôleur de vente : avis en arrière-plan sur les positions PAPIER ouvertes (jamais le compte réel) ; le tour n'attend pas.
  if (ctx.team) {
    const byMint = new Map<string, { list: Pos[]; set: Settings }>();
    for (const p of plans) {
      if (p.a.mode !== 'paper' || (p.next !== 'running' && p.next !== 'paused') || !aiOn(p.a, AGENT_SELLER)) continue;
      for (const pos of open.get(p.a.id) ?? []) {
        if (pos.status !== 'open') continue;
        const e = byMint.get(pos.mint) ?? { list: [], set: p.a.set };
        e.list.push(pos);
        byMint.set(pos.mint, e);
      }
    }
    const held: Held[] = [];
    for (const [mint, { list, set }] of byMint) {
      const pair = pairs.get(mint);
      const price = num(pair?.priceUsd);
      const size = list.reduce((s, x) => s + x.size_usd, 0);
      const qty = list.reduce((s, x) => s + x.qty, 0);
      if (!pair || !(price > 0) || !(qty > 0)) continue;
      held.push({
        mint, symbol: symOf(ctx, mint, pair), pairAddress: pair.pairAddress ?? null, positions: list.length, entry_price: size / qty, price_usd: price,
        held_min: Math.max(0, ...list.map((x) => (x.opened_at ? (Date.now() - x.opened_at) / 60_000 : 0))), peak_price: Math.max(...list.map((x) => x.peak_price ?? x.entry_price)),
        stop_loss_pct: set.stop_loss_pct, take_profit_pct: set.take_profit_pct, trailing_pct: set.trailing_stop_pct,
        liquidity_usd: pair.liquidity?.usd ?? null, volume_24h: pair.volume?.h24 ?? null,
        txns: { m5: pair.txns?.m5, h1: pair.txns?.h1, h24: pair.txns?.h24 },
        price_change_pct: { m5: pair.priceChange?.m5, h1: pair.priceChange?.h1, h6: pair.priceChange?.h6, h24: pair.priceChange?.h24 },
      });
    }
    ctx.team.watchPositions(held);
  }

  // 6) Santé des API + horloges du moteur
  const rows = Object.entries(ctx.health).map(([service, h]) => ({ service, ...h, checked_at: nowIso }));
  if (scanDue) rows.push({ service: 'engine_scan', ok: feedsOk > 0, latency_ms: Date.now() - t0, http_status: 200, error: null, checked_at: nowIso });
  rows.push({ service: 'engine_tick', ok: true, latency_ms: Date.now() - t0, http_status: 200, error: null, checked_at: new Date().toISOString() });
  const { error: he } = await sb.from('api_health').upsert(rows);
  if (he) ev(ctx, null, 'error', 'LOGGER', `api_health: ${he.message}`);

  return { accounts: accts.length, active: active.length, scanned: scanDue, discovered: discovered.length, candidates: cands.length, deep_checked: deepAttempts, orders, perAccount };
}

const verdictFr = (v: string) => (v === 'ok' ? 'rien d’anormal' : v === 'avoid' ? 'prudence' : v === 'sell' ? 'vendre' : v === 'hold' ? 'garder' : 'incertain');

/** Raison courte d'un veto de l'IA pour l'affichage (le texte complet reste dans le journal). */
function scanVetoNote(reasons: string, flags: string[]): string {
  return reasons || (flags.length ? flags.join(' ; ') : 'Risque jugé trop élevé');
}

/** Note le sort des jetons du dernier scan. Informatif : une panne ici ne touche jamais le trading. */
async function recordScan(ctx: Ctx, a: Acct, sh: Shared, items: ScanItem[], blocked: string | null) {
  try {
    const row = buildScanRow(a.id, { discovered: sh.discoveredCount, candidates: sh.cands.length, deep: sh.deepAttempts, deepFailed: sh.deepFailures }, items, blocked, new Date().toISOString());
    const { error } = await ctx.sb.from('scan_state').upsert(row, { onConflict: 'account_id' });
    if (error) console.warn(`scan_state: ${error.message}`);
  } catch (e) {
    console.warn(`scan_state: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}

type Shared = {
  scanDue: boolean; full: boolean; cands: Cand[]; riskMap: Map<string, { risk: RiskResult; fresh: boolean }>;
  discoveredCount: number; feedsOk: number; deepAttempts: number; deepFailures: number;
  blockedBy: string | null; pairsFailed: boolean;
  /** Avis des analystes lancés pour ce scan (équipe IA), par jeton. */
  pre?: Map<string, { prepared: Prepared; ai: AiInput; price: number }>;
  /** Compteurs de l'équipe IA depuis le dernier tour complet. */
  teamStats?: Record<string, AgentStats> | null;
};

async function processAccount(ctx: Ctx, p: Plan, openStart: Pos[], pairs: Map<string, Pair>, sh: Shared) {
  const { sb } = ctx;
  const a = p.a;
  const s = a.set;
  let status: BotStatus = p.next;
  let orders = 0, entries = 0, stale = 0, stuck = 0, evaluated = 0, sized = 0;
  // Sort de chaque jeton examiné pendant ce scan (affichage « analyse en cours », jamais relu par le moteur).
  const scanItems: ScanItem[] = [];
  let scanBlocked: string | null = null;

  // Compte réel : session (clé déchiffrée, réconciliation des ordres en attente, vrais soldes). Sans session, aucun ordre n'est tenté.
  // Pas de session (donc aucun accès réseau) pour un compte réel arrêté sans ordre en attente : seul l'état du bot est mis à jour.
  const needSession = a.mode === 'live' && (status !== 'stopped' || p.prev !== 'stopped' || !!p.pending);
  // Tour rapide : la session n'est ouverte tout de suite que si un ordre est en attente, si une fermeture est en cours ou si
  // l'état change. Sinon elle s'ouvre à la demande, au moment précis où une vente doit partir (ensureLive).
  const eager = needSession && (sh.full || !!p.pending || status === 'closing' || status !== p.prev);
  let live: Session | null = eager ? await getLive(ctx, a) : null;
  let liveTried = eager;
  const ensureLive = async (): Promise<Session | null> => {
    if (!live && needSession && !liveTried) { liveTried = true; live = await getLive(ctx, a); }
    return live;
  };
  const liveDown = a.mode === 'live' && (eager ? !live : !needSession);
  // La réconciliation a pu clore ou rouvrir des positions : on repart de la base.
  const startPositions = live ? [...(await loadOpenPositions(ctx, a.id)).values()].flat() : openStart;

  if (status !== 'stopped' && !liveDown) {
    // ── Sorties (toujours actives : running, paused, closing)
    const priceAge = Date.now() - ctx.pairsAt;
    for (const pos of startPositions) {
      if (pos.status !== 'open') continue; // vente réelle en cours de confirmation : la réconciliation tranchera
      const pair = pairs.get(pos.mint);
      const price = num(pair?.priceUsd);
      const hasPrice = !!pair && price > 0;
      if (status === 'closing') {
        if (live) {
          // Arrêt demandé : on vend même sans prix de référence (le prix réel est celui de Jupiter, glissement borné).
          if (await liveSell(ctx, a, pos, hasPrice ? pair! : null, 'Arrêt demandé : fermeture de la position', live)) orders++;
          continue;
        }
        if (!hasPrice) { stuck++; continue; }
        if (await sell(ctx, a, pos, pair!, 'Arrêt demandé : fermeture de la position')) orders++;
        continue;
      }
      const ex = evaluateExit(pos, hasPrice ? price : pos.entry_price, hasPrice ? priceAge : Infinity);
      if (ex.action === 'sell') {
        // Compte réel : la session (clé, soldes) peut n'être ouverte qu'à cet instant ; sans elle, rien n'est vendu à l'aveugle.
        const S = a.mode === 'live' ? await ensureLive() : null;
        if (a.mode === 'live' && !S) continue;
        const done = S ? await liveSell(ctx, a, pos, pair!, ex.reason!, S) : await sell(ctx, a, pos, pair!, ex.reason!);
        if (done) orders++;
      }
      else if (ex.action === 'stale') stale++;
      else {
        if (ex.peak > (pos.peak_price ?? pos.entry_price)) await sb.from('positions').update({ peak_price: ex.peak }).eq('id', pos.id);
        // Contrôleur de vente IA : comptes PAPIER uniquement, avis récent et prix proche de celui de l'avis. Les stops restent prioritaires.
        const sig = ctx.team && a.mode === 'paper' && hasPrice && aiOn(a, AGENT_SELLER) ? ctx.team.sellSignal(pos.mint, price) : null;
        if (sig?.act) {
          const why = `Contrôleur de vente IA : ${(sig.reasons || sig.red_flags.join(' ; ') || 'retournement repéré').slice(0, 160)} (confiance ${sig.confidence} %)`;
          if (await sell(ctx, a, pos, pair!, why)) { orders++; ag(ctx, a.id, { agent: AGENT_SELLER, status: 'RUNNING' }); }
        }
      }
    }
    if (stale > 0 && !(await recentlyLogged(ctx, a.id, 'warning', 'Prix indisponible', 10))) {
      ev(ctx, a.id, 'warning', 'EXECUTOR', `Prix indisponible pour ${stale} position(s) : stop loss / take profit non évaluables ce tick (la position n’est PAS vendue à l’aveugle).`);
    }
    if (stuck > 0 && !(await recentlyLogged(ctx, a.id, 'warning', 'Fermeture en attente', 10))) {
      ev(ctx, a.id, 'warning', 'EXECUTOR', `Fermeture en attente : ${stuck} position(s) sans prix disponible, nouvel essai au prochain tick.`);
    }
    if (live && orders > 0) await refreshLive(ctx, a, live);
  }

  // ── Fin d'un arrêt : plus aucune position ouverte (ni ordre réel en attente) → arrêté
  let positions = [...(await loadOpenPositions(ctx, a.id)).values()].flat();
  if (status === 'closing' && positions.length === 0) {
    let pendingLeft = 0;
    if (a.mode === 'live') {
      const { count } = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('account_id', a.id).eq('is_paper', false).eq('status', 'pending');
      pendingLeft = count ?? 0;
    }
    if (pendingLeft === 0) {
      status = 'stopped';
      ev(ctx, a.id, 'state', 'SYSTEM', 'Bot arrêté : toutes les positions sont fermées.', { from: 'closing', to: 'stopped' });
    }
  }

  // ── État du compte (cash, équité) puis entrées
  let st: AState | null = null;
  if (!liveDown && sh.full) {
    st = await accountState(ctx, a, positions, pairs, live);

    if (status === 'running') {
      const lossBase = Math.max(st.equity + Math.max(0, -st.realized24), 1);
      const lossPct = (Math.max(0, -st.realized24) / lossBase) * 100;
      const dailyBlocked = lossPct >= s.max_daily_loss_pct;
      if (dailyBlocked && !(await recentlyLogged(ctx, a.id, 'warning', 'Limite de perte journalière', 360))) {
        ev(ctx, a.id, 'warning', 'SIZER', `Limite de perte journalière atteinte (${lossPct.toFixed(1)} % ≥ ${s.max_daily_loss_pct} % sur 24 h glissantes) : nouvelles entrées bloquées, positions ouvertes toujours surveillées.`);
      }
      if (sh.blockedBy && !(await recentlyLogged(ctx, a.id, 'warning', 'Entrées désactivées', 360))) {
        ev(ctx, a.id, 'warning', 'SYSTEM', `Entrées désactivées : l’agent ${sh.blockedBy} est désactivé dans les réglages (les sorties restent actives).`);
      }
      // Règles propres au réel : plafonds du compte, pause après échecs, frais en SOL, prix du SOL.
      const gate = live ? entryGate(live, positions.reduce((n, x) => n + x.size_usd, 0), st.realized24, Date.now(), ctx.deadline - Date.now()) : null;
      if (gate && !gate.ok && !gate.quiet && !(await recentlyLogged(ctx, a.id, 'warning', 'Entrées réelles suspendues', 30))) {
        ev(ctx, a.id, 'warning', 'SIZER', `Entrées réelles suspendues : ${gate.reason}.`);
      }

      if (sh.scanDue) {
        scanBlocked = sh.blockedBy ? `Entrées désactivées : l’agent ${sh.blockedBy} est désactivé dans les réglages`
          : dailyBlocked ? `Limite de perte journalière atteinte (${lossPct.toFixed(1)} %) : aucun nouvel achat`
          : gate && !gate.ok ? `Entrées réelles suspendues : ${gate.reason}`
          : positions.length >= s.max_positions ? `Positions pleines (${positions.length}/${s.max_positions}) : aucun nouvel achat`
          : null;
      }

      if (sh.scanDue && !sh.blockedBy && !dailyBlocked && (!gate || gate.ok)) {
        let cash = st.cash, equity = st.equity, openCount = positions.length;
        const maxEntries = live ? 1 : MAX_ENTRIES_PER_TICK;       // réel : un achat à la fois (chaque ordre attend sa confirmation)
        const maxTrade = gate && gate.ok ? Math.min(s.max_trade_usd, gate.maxUsd) : s.max_trade_usd;
        let liveOrders = 0;
        // Pas de rachat d'un token que ce compte vient de fermer (évite le « churn » après un stop loss).
        const { data: recentClosed } = await sb.from('positions').select('mint').eq('account_id', a.id).eq('status', 'closed')
          .gte('closed_at', new Date(Date.now() - REENTRY_COOLDOWN_MIN * 60_000).toISOString());
        const cooldown = new Set((recentClosed ?? []).map((r: { mint: string }) => r.mint));
        for (const c of sh.cands) {
          if (entries >= maxEntries || openCount >= s.max_positions) break;
          const rk = sh.riskMap.get(c.mint);
          const sym = symOf(ctx, c.mint, c.pair);
          if (!rk) { scanItems.push({ mint: c.mint, sym, score: null, stop: 'skip', note: 'Rapport de risque pas encore disponible (quelques analyses par tour)' }); continue; }
          if (cooldown.has(c.mint)) { scanItems.push({ mint: c.mint, sym, score: rk.risk.score, stop: 'skip', note: `Fermé il y a moins de ${REENTRY_COOLDOWN_MIN} min : pas de rachat immédiat` }); continue; }
          if (positions.some((x) => x.mint === c.mint)) { scanItems.push({ mint: c.mint, sym, score: rk.risk.score, stop: 'skip', note: 'Déjà en portefeuille' }); continue; }
          evaluated++;
          const dec = evaluateEntry(c.pair, rk.risk, { max_risk_score: s.max_risk_score, caution_level: s.caution_level }, Date.now() - ctx.pairsAt);
          if (!dec.ok) {
            scanItems.push({ mint: c.mint, sym, score: rk.risk.score, stop: 'rules', note: dec.reasons[0] ?? 'Refusé par les règles' });
            if (rk.fresh) ev(ctx, a.id, 'filtered', 'ANALYST', `REJETÉ ${sym} — ${dec.reasons.join(' ; ')}`, { step: 'ANALYSE', mint: c.mint, risk_score: rk.risk.score, level: rk.risk.level, reasons: dec.reasons });
            continue;
          }
          const usd = sizePosition({ equity, cash, sizePct: s.position_size_pct, maxTradeUsd: maxTrade, openCount, maxPositions: s.max_positions });
          sized++;
          if (usd <= 0) {
            const raw = Math.min((equity * s.position_size_pct) / 100, maxTrade, cash * 0.98);
            scanItems.push({ mint: c.mint, sym, score: rk.risk.score, stop: 'size', note: raw <= 1 ? `Position de ${Math.max(0, raw).toFixed(2)} $ : sous le minimum de 1 $` : 'Plafond de positions atteint' });
            if (!(await recentlyLogged(ctx, a.id, 'warning', 'Entrée impossible', 30))) ev(ctx, a.id, 'warning', 'SIZER', `Entrée impossible sur ${sym} : liquidités insuffisantes ou plafond atteint (cash ${cash.toFixed(2)} $).`);
            break;
          }
          // Agent IA : il ne peut que bloquer. Toute panne (clé, réseau, budget, réponse illisible) = pas d'avis, les règles décident seules.
          let aiNote = '';
          let aiData: Record<string, unknown> | undefined;
          let aiScan: ScanAi | undefined;
          let contractNote: Note | null = null;
          if (ctx.ai) {
            let r: GateResult;
            if ((ctx.aiMs ?? 0) >= AI_TICK_BUDGET_MS) r = { ok: false, reason: 'paused', detail: `temps d’attente de l’IA épuisé pour ce tour (${AI_TICK_BUDGET_MS / 1000} s)` };
            else {
              const t0 = Date.now();
              r = await ctx.ai.review(buildAiInput(c.mint, c.pair, rk.risk, t0))
                .catch((e): GateResult => ({ ok: false, reason: 'error', detail: String((e as Error)?.message ?? e).slice(0, 160) }));
              ctx.aiMs = (ctx.aiMs ?? 0) + (Date.now() - t0);
            }
            if (r.ok) {
              const v = r.review;
              contractNote = noteOf(v);
              aiData = { verdict: v.verdict, confidence: v.confidence, red_flags: v.red_flags, cached: v.cached, model: v.model };
              aiScan = { s: v.veto ? 'veto' : v.verdict, c: v.confidence };
              if (v.veto) {
                scanItems.push({ mint: c.mint, sym, score: rk.risk.score, stop: 'ai', note: scanVetoNote(v.reasons, v.red_flags), ai: aiScan });
                if (!(await recentlyLogged(ctx, a.id, 'filtered', `VETO IA ${sym} —`, 15))) {
                  ev(ctx, a.id, 'filtered', 'ANALYST', `VETO IA ${sym} — ${v.reasons || v.red_flags.join(' ; ') || 'risque jugé trop élevé'} (confiance ${v.confidence} %)`, { step: 'IA', mint: c.mint, ...aiData, reasons: v.reasons, vetoed: true });
                }
                continue;
              }
              aiNote = ` · IA : ${v.verdict === 'ok' ? 'rien d’anormal' : v.verdict === 'avoid' ? 'prudence (non bloquant)' : 'avis incertain'} (${v.confidence} %)`;
            } else {
              aiScan = { s: 'down' };
              if (!(await recentlyLogged(ctx, a.id, 'warning', 'Agent IA indisponible', 30))) {
                ev(ctx, a.id, 'warning', 'ANALYST', `Agent IA indisponible : ${r.detail}. Les règles habituelles s’appliquent seules.`);
              }
            }
          }
          // Équipe IA : avis des analystes Graphique et Marché (lancés au début du scan), puis le contrôleur d'achat. Ils ne peuvent que bloquer.
          const prep = ctx.team ? sh.pre?.get(c.mint) : undefined;
          if (ctx.team && prep) {
            const notes: { contract: Note | null; chart: Note | null; market: Note | null } = { contract: contractNote, chart: null, market: null };
            const said: string[] = [];
            let veto: { agent: string; v: { verdict: string; confidence: number; reasons: string; red_flags: string[] } } | null = null;
            for (const [agent, k, pr] of [[AGENT_CHART, 'chart', prep.prepared.chart], [AGENT_MARKET, 'market', prep.prepared.market]] as const) {
              if (!pr || !aiOn(a, agent)) continue;
              const r = await aiWait(ctx, pr);
              if (!r.ok) continue;                     // pas d'avis : rien n'est bloqué
              notes[k] = noteOf(r.review);
              said.push(`${TEAM_LABELS[agent].replace('Analyste ', '')} : ${verdictFr(r.review.verdict)} (${r.review.confidence} %)`);
              if (r.review.act && !veto) veto = { agent, v: r.review };
            }
            if (!veto && aiOn(a, AGENT_BUYER)) {
              const px = num(c.pair.priceUsd), at = ctx.team.analysisPrice(c.mint), liq = num(c.pair.liquidity?.usd);
              const r = await aiWait(ctx, ctx.team.controlBuy({
                mint: c.mint, symbol: prep.ai.symbol,
                order: { usd: Number(usd.toFixed(2)), pct_of_equity: s.position_size_pct, positions_after: openCount + 1, max_positions: s.max_positions, stop_loss_pct: s.stop_loss_pct, take_profit_pct: s.take_profit_pct, order_vs_liquidity_pct: liq > 0 ? Number(((usd / liq) * 100).toFixed(3)) : null },
                rules: { risk_score: rk.risk.score, level: rk.risk.level, accepted_because: dec.reasons[0] ?? '' },
                now: { price_usd: px > 0 ? px : null, liquidity_usd: liq > 0 ? liq : null, price_change_pct: prep.ai.price_change_pct, price_move_since_analysis_pct: at && px > 0 ? Number((((px / at) - 1) * 100).toFixed(1)) : null },
                analysts: notes, risk_score: rk.risk.score,
              }));
              if (r.ok) {
                said.push(`Contrôle : ${verdictFr(r.review.verdict)} (${r.review.confidence} %)`);
                if (r.review.act) veto = { agent: AGENT_BUYER, v: r.review };
                else if (!aiScan) aiScan = { s: r.review.verdict, c: r.review.confidence };
              }
            }
            if (veto) {
              const label = TEAM_LABELS[veto.agent];
              scanItems.push({ mint: c.mint, sym, score: rk.risk.score, stop: 'ai', note: `${label} : ${scanVetoNote(veto.v.reasons, veto.v.red_flags)}`, ai: { s: 'veto', c: veto.v.confidence } });
              if (!(await recentlyLogged(ctx, a.id, 'filtered', `VETO IA ${sym} —`, 15))) {
                ev(ctx, a.id, 'filtered', veto.agent, `VETO IA ${sym} — ${label} : ${veto.v.reasons || veto.v.red_flags.join(' ; ') || 'risque jugé trop élevé'} (confiance ${veto.v.confidence} %)`,
                  { step: 'IA', mint: c.mint, agent: veto.agent, verdict: veto.v.verdict, confidence: veto.v.confidence, red_flags: veto.v.red_flags, reasons: veto.v.reasons, vetoed: true });
              }
              continue;
            }
            if (said.length) aiNote += ` · ${said.join(' · ')}`;
          }
          ev(ctx, a.id, 'info', 'ANALYST', `ANALYSE ${sym} — ${dec.reasons[0]}${aiNote}`, { step: 'ANALYSE', mint: c.mint, risk_score: rk.risk.score, ...(aiData ? { ai: aiData } : {}) });
          ev(ctx, a.id, 'info', 'SIZER', `TAILLE ${sym} — ${usd.toFixed(2)} $ (${s.position_size_pct} % de l’équité, plafond ${maxTrade} $, ${openCount + 1}/${s.max_positions} positions)`, { step: 'SIZE', mint: c.mint, usd });
          if (live) {
            liveOrders++;
            const r = await liveBuy(ctx, a, c, rk.risk, usd, dec.reasons[0], live);
            if (r.ok) { entries++; orders++; cash -= r.usd ?? usd; openCount++; }
            scanItems.push({ mint: c.mint, sym, score: rk.risk.score, stop: r.ok ? null : 'buy', note: r.ok ? `Acheté ${(r.usd ?? usd).toFixed(2)} $` : 'Achat non exécuté', ai: aiScan });
            if (r.halt) break;
          } else {
            const r = await buy(ctx, a, c, rk.risk, usd, dec.reasons[0]);
            if (r.ok) { entries++; orders++; cash -= usd; openCount++; }
            scanItems.push({ mint: c.mint, sym, score: rk.risk.score, stop: r.ok ? null : 'buy', note: r.ok ? `Acheté ${usd.toFixed(2)} $` : 'Achat non exécuté', ai: aiScan });
          }
        }
        if (entries > 0 || liveOrders > 0) positions = [...(await loadOpenPositions(ctx, a.id)).values()].flat();
        if (live && liveOrders > 0) await refreshLive(ctx, a, live);
        st = await accountState(ctx, a, positions, pairs, live);
      }
      if (sh.scanDue) await recordScan(ctx, a, sh, scanItems, scanBlocked);
    }
  }

  // ── Ménage du portefeuille réel : loyer des comptes de jeton vides (toutes les ~10 min, jamais pendant un arrêt)
  if (sh.full && live && (status === 'running' || status === 'paused') && orders === 0 && new Date().getUTCMinutes() % 10 === 0 && ctx.deadline - Date.now() > 30_000) {
    await tidyUp(live, live.L.log);
  }

  // ── Instantané d'équité (historique réel pour le graphique)
  if (st) {
    const { error } = await sb.from('equity_snapshots').insert({
      account_id: a.id, equity_usd: st.equity, cash_usd: st.cash, open_positions: positions.length, drawdown_pct: st.drawdown,
    });
    if (error) ev(ctx, a.id, 'error', 'EQUITY', `equity_snapshots: ${error.message}`);
  }

  // ── Agents (tour rapide : inchangés, sauf changement d'état ou ordre passé — ce qui est mis à jour ici, pas le reste)
  const touchAgents = sh.full || status !== p.prev;
  const scanned = status === 'running' && sh.scanDue && !sh.blockedBy;
  if (!touchAgents) {
    // rien à recalculer ce tour
  } else if (status === 'running') {
    const off = (k: string) => s.agents_enabled?.[k] === false;
    ag(ctx, a.id, { agent: 'SCANNER', status: off('scanner') ? 'IDLE' : 'RUNNING', n: scanned ? sh.discoveredCount : 0, err: null });
    ag(ctx, a.id, { agent: 'RUGCHECK', status: off('rugcheck') ? 'IDLE' : 'RUNNING', n: scanned ? sh.deepAttempts - sh.deepFailures : 0, err: null });
    ag(ctx, a.id, { agent: 'ANALYST', status: off('analyst') ? 'IDLE' : 'RUNNING', n: evaluated, err: null });
    ag(ctx, a.id, { agent: 'SIZER', status: off('sizer') ? 'IDLE' : 'RUNNING', n: sized, err: null });
    ag(ctx, a.id, { agent: 'EXECUTOR', status: off('executor') ? 'IDLE' : 'RUNNING', n: 0, err: null });
    if (scanned && sh.feedsOk === 0) ag(ctx, a.id, { agent: 'SCANNER', status: 'ERROR', err: 'Aucune source de découverte ne répond.' });
    else if (scanned && sh.feedsOk < 3) ag(ctx, a.id, { agent: 'SCANNER', status: 'WARNING', err: `${3 - sh.feedsOk} source(s) de découverte sur 3 indisponible(s).` });
    if (scanned && sh.deepAttempts > 0 && sh.deepFailures === sh.deepAttempts) ag(ctx, a.id, { agent: 'RUGCHECK', status: 'ERROR', err: 'RugCheck ne répond pas : aucun achat tant que le risque est inconnu.' });
    else if (scanned && sh.deepFailures > 0) ag(ctx, a.id, { agent: 'RUGCHECK', status: 'WARNING', err: `${sh.deepFailures} analyse(s) sans réponse RugCheck (token ignoré).` });
    // Équipe IA : partagée entre les comptes, chaque compte affiche ses compteurs (appels facturés, dernière erreur).
    for (const agent of TEAM_AGENTS) {
      const on = aiOn(a, agent) && (agent === AGENT_CONTRACT ? !!ctx.ai : !!ctx.team) && (agent !== AGENT_SELLER || a.mode === 'paper');
      const st = sh.teamStats?.[agent];
      ag(ctx, a.id, { agent, status: !on ? 'IDLE' : st?.err ? 'WARNING' : 'RUNNING', n: on ? st?.ops ?? 0 : 0, err: on && st ? st.err : on ? undefined : null });
    }
  } else if (status === 'paused' || status === 'closing') {
    for (const k of ['SCANNER', 'RUGCHECK', 'ANALYST', 'SIZER', ...TEAM_AGENTS]) ag(ctx, a.id, { agent: k, status: 'IDLE', err: null });
    ag(ctx, a.id, { agent: 'EXECUTOR', status: 'RUNNING', err: null });
    // Pause : plus d'entrées, mais les sorties continuent, y compris l'avis du contrôleur de vente (papier).
    if (status === 'paused' && ctx.team && a.mode === 'paper' && aiOn(a, AGENT_SELLER)) ag(ctx, a.id, { agent: AGENT_SELLER, status: 'RUNNING', n: sh.teamStats?.[AGENT_SELLER]?.ops ?? 0 });
  } else if (p.prev !== 'stopped') {
    for (const k of ['SCANNER', 'RUGCHECK', 'ANALYST', 'SIZER', 'EXECUTOR', ...TEAM_AGENTS]) ag(ctx, a.id, { agent: k, status: 'IDLE', err: null });
  }
  if (touchAgents && (status !== 'stopped' || p.prev !== 'stopped')) {
    if (st && (sh.pairsFailed || st.unpriced > 0) && status !== 'stopped') ag(ctx, a.id, { agent: 'EQUITY', status: 'WARNING', n: 1, err: 'Certains prix en direct sont indisponibles : valorisation au dernier prix connu.' });
    else ag(ctx, a.id, { agent: 'EQUITY', status: status === 'stopped' ? 'IDLE' : 'RUNNING', n: st ? 1 : 0, err: null });
    ag(ctx, a.id, { agent: 'LOGGER', status: status === 'stopped' ? 'IDLE' : 'RUNNING', n: ctx.events.filter((e) => e.account_id === a.id).length, err: null });
  }
  if (touchAgents || ctx.agents.has(a.id)) {
    const merged = mergeAgentUpdates(ctx.agents.get(a.id) ?? []);
    if (status === 'stopped') for (const u of merged) if (u.status !== 'ERROR') u.status = 'IDLE';
    const { error: ae } = await sb.rpc('bump_agents', { p_account: a.id, p_updates: merged });
    if (ae) ev(ctx, a.id, 'error', 'LOGGER', `bump_agents: ${ae.message}`);
  }

  // ── État du bot
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = { status, last_tick_at: nowIso, updated_at: nowIso };
  if (p.prev === 'stopped' && status === 'running') patch.started_at = nowIso;
  if (status === 'stopped') patch.started_at = null;
  if (p.resetRequested) patch.requested_status = p.resetRequested;
  const { error: be } = await sb.from('bot_state').update(patch).eq('account_id', a.id);
  if (be) throw new Error(`bot_state: ${be.message}`);

  return { status, orders, entries, open: positions.length, equity: st ? Number(st.equity.toFixed(2)) : null, cash: st ? Number(st.cash.toFixed(2)) : null, stale, stuck };
}

// ───────────────────────── Entrée HTTP ─────────────────────────

function makeClient(): SupabaseClient | null {
  const keys = process.env['SUPABASE_SECRET_KEYS'];
  const secret = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? (keys ? JSON.parse(keys)['default'] : undefined);
  const url = process.env['SUPABASE_URL'];
  if (!secret || !url) return null;
  return createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function flush(ctx: Ctx) {
  if (!ctx.events.length) return;
  const rows = ctx.events.map((e) => ({ account_id: e.account_id, kind: e.kind, agent: e.agent, message: e.message, data: e.data ?? null }));
  const { error } = await ctx.sb.from('events').insert(rows);
  if (error) console.error('flush events failed', error.message);
}

export type LoopDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
  /** Contexte neuf pour un tour ; `start` = début de l'appel (la date limite des ordres réels en part). */
  makeCtx: (start: number) => Ctx;
  tick: (ctx: Ctx, opts: { full: boolean }) => Promise<Record<string, unknown>>;
  flush: (ctx: Ctx) => Promise<void>;
  gapMs?: number;
  spanMs?: number;
};

/**
 * Enchaîne des tours à l'intérieur d'un même appel : un tour toutes les `gapMs` (5 s) tant que le prochain commencerait avant
 * `spanMs` (26 s). Le premier tour est complet, les suivants sont rapides. Un tour long (ordre réel qui attend sa confirmation)
 * décale simplement les suivants ; au-delà de la fenêtre on s'arrête et le cron relance un nouvel appel. Une erreur arrête la
 * boucle (journalisée) : le cron réessaie 30 s plus tard, comme avant.
 */
export async function runLoop(d: LoopDeps): Promise<{ iterations: number; events: number; last: Record<string, unknown> | null; error: string | null }> {
  const gap = d.gapMs ?? FAST_GAP_MS, span = d.spanMs ?? LOOP_SPAN_MS;
  const t0 = d.now();
  let i = 0, events = 0;
  let last: Record<string, unknown> | null = null;
  for (;;) {
    const start = d.now();
    const ctx = d.makeCtx(t0);
    try {
      last = await d.tick(ctx, { full: i === 0 });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      ev(ctx, null, 'error', 'SYSTEM', `Tick échoué : ${msg}`);
      events += ctx.events.length;
      await d.flush(ctx);
      return { iterations: i + 1, events, last, error: msg };
    }
    events += ctx.events.length;
    await d.flush(ctx);
    i++;
    if (start - t0 + gap >= span) break;           // le prochain tour tomberait hors de la fenêtre
    const wait = gap - (d.now() - start);
    if (wait > 0) await d.sleep(wait);
    if (d.now() - t0 >= span) break;               // un tour long a consommé la fenêtre
  }
  return { iterations: i, events, last, error: null };
}

// Ajout du serveur Node : le moteur est le même, seule l'entrée HTTP de la fonction Supabase est retirée.
export { ev, flush, makeClient };
