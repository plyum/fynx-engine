// FYNX — fermeture manuelle d'une position (bouton « Fermer » de l'appli).
// L'appli pose `positions.close_requested_at` (RPC request_close_position, propriétaire vérifié) ; ce module vend la position au
// tour suivant (toutes les 2 s), avant le tour normal, avec la même session de portefeuille. Fonctionne que le bot soit en marche,
// en pause ou arrêté. Papier : vente simulée au prix frais. Réel : vraie vente Jupiter (même chemin et mêmes gardes que les autres
// ventes réelles : espacement après échec, abandon d'un jeton invendable, temps de calcul suffisant).
import { pickBestPairs, sellGate, simulateFill, type Pair } from './lib.ts';
import { refreshBalances, sellPosition } from './live.ts';
import { canSell, exitSlippageBps, liveGate, openSession, secretUsable, type LiveInfo, type Session } from './livecycle.ts';
import type { Ctx } from './index.ts';

export const MANUAL_REASON = 'Fermeture manuelle';
const DX = 'https://api.dexscreener.com';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const num = (v: unknown, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const one = <T>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? (x[0] ?? null) : (x ?? null));
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;
const fmtPrice = (p: number) => (p >= 1 ? p.toFixed(4) : p.toPrecision(4));

type MPos = { id: string; account_id: string; mint: string; qty: number; size_usd: number; entry_price: number };
type MAcct = { id: string; mode: 'paper' | 'live'; live: LiveInfo | null };

async function getJson(url: string, timeoutMs = 8_000): Promise<unknown | null> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

async function loadAccounts(ctx: Ctx, ids: string[]): Promise<Map<string, MAcct>> {
  const { data } = await ctx.sb.from('accounts')
    .select('id,mode,public_address,live_state(verified_at,baseline_usd,max_trade_usd,max_exposure_usd,max_daily_loss_usd,max_slippage_bps,paused_until,sol_usd)')
    .in('id', ids);
  const out = new Map<string, MAcct>();
  for (const a of (data ?? []) as Record<string, unknown>[]) {
    const ls = one(a.live_state as Record<string, unknown> | null);
    out.set(String(a.id), {
      id: String(a.id), mode: a.mode === 'live' ? 'live' : 'paper',
      live: a.mode === 'live' && ls ? {
        address: (a.public_address as string | null) ?? null, verified: !!ls.verified_at, maxTradeUsd: num(ls.max_trade_usd, 10),
        maxExposureUsd: num(ls.max_exposure_usd, 30), maxDailyLossUsd: num(ls.max_daily_loss_usd, 15), maxSlippageBps: num(ls.max_slippage_bps, 500),
        pausedUntil: (ls.paused_until as string | null) ?? null, baselineUsd: num(ls.baseline_usd), solUsd: ls.sol_usd === null || ls.sol_usd === undefined ? null : num(ls.sol_usd),
      } : null,
    });
  }
  return out;
}

async function session(ctx: Ctx, a: MAcct): Promise<{ S: Session } | { error: string }> {
  const hit = ctx.live.get(a.id);
  if (hit) return hit;
  if (!a.live) return { error: 'état du compte réel introuvable' };
  const g = liveGate(a.live, secretUsable(ctx.env.secret));
  if (!g.ready) return { error: g.reason ?? 'compte réel non prêt' };
  const res = await openSession({
    sb: ctx.sb, secret: ctx.env.secret, rpcUrl: ctx.env.rpcUrl, makeRpc: (u) => ctx.deps.makeRpc(u), makeJup: () => ctx.deps.makeJup(ctx.env.jupKey),
    fetchPrice: (m) => (m === SOL_MINT ? (ctx.solPrice ??= ctx.deps.fetchPrice(m)) : ctx.deps.fetchPrice(m)),
    log: (kind, agent, message, data) => ctx.events.push({ account_id: a.id, kind, agent, message, data }), deadline: ctx.deadline,
  }, a.id, a.live);
  const v = res.ok ? { S: res.S } : { error: res.error };
  ctx.live.set(a.id, v);
  return v;
}

/** Les avertissements d'échec ne sont écrits qu'une fois par minute et par position (le bouton reste « en cours » dans l'appli). */
const lastWarn = new Map<string, number>();
function warnOnce(ctx: Ctx, accountId: string, posId: string, message: string, data?: unknown) {
  const now = Date.now();
  if (now - (lastWarn.get(posId) ?? 0) < 60_000) return;
  lastWarn.set(posId, now);
  ctx.events.push({ account_id: accountId, kind: 'warning', agent: 'EXECUTOR', message, data });
}

/** Vend toutes les positions dont la fermeture a été demandée dans l'appli. Appelé avant chaque tour du moteur. */
export async function runManualCloses(ctx: Ctx): Promise<number> {
  const { data, error } = await ctx.sb.from('positions').select('*').eq('status', 'open').not('close_requested_at', 'is', null);
  if (error || !data) return 0;
  const wanted: MPos[] = (data as Record<string, unknown>[]).filter((r) => r.status === 'open' && r.close_requested_at)
    .map((r) => ({ id: String(r.id), account_id: String(r.account_id), mint: String(r.mint), qty: num(r.qty), size_usd: num(r.size_usd), entry_price: num(r.entry_price) }));
  if (!wanted.length) return 0;
  const accts = await loadAccounts(ctx, [...new Set(wanted.map((p) => p.account_id))]);
  const pairs = pickBestPairs(await getJson(`${DX}/tokens/v1/solana/${[...new Set(wanted.map((p) => p.mint))].slice(0, 30).join(',')}`));
  let done = 0;
  for (const pos of wanted) {
    const a = accts.get(pos.account_id);
    if (!a) continue;
    try {
      if (await closeOne(ctx, a, pos, pairs.get(pos.mint) ?? null)) done++;
    } catch (e) {
      warnOnce(ctx, a.id, pos.id, `Fermeture manuelle : erreur ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
  return done;
}

async function closeOne(ctx: Ctx, a: MAcct, pos: MPos, pair: Pair | null): Promise<boolean> {
  const sym = pair?.baseToken?.symbol ?? ctx.symbols.get(pos.mint) ?? `${pos.mint.slice(0, 4)}…`;
  const price = num(pair?.priceUsd);
  if (a.mode === 'paper') {
    if (!(price > 0)) { warnOnce(ctx, a.id, pos.id, `Fermeture manuelle de ${sym} en attente : prix indisponible, nouvel essai dans 2 s.`); return false; }
    const f = simulateFill('SELL', price, pos.qty * price, pair?.liquidity?.usd ?? null);
    const { data, error } = await ctx.sb.rpc('paper_close_position', { p_position: pos.id, p_exit_price: f.fillPrice, p_fee: f.feeUsd, p_slip: f.slippagePct, p_reason: MANUAL_REASON });
    if (error) { warnOnce(ctx, a.id, pos.id, `Fermeture manuelle de ${sym} refusée : ${error.message}`); return false; }
    const r = data as { pnl_usd: number; pnl_pct: number; order_id: string };
    ctx.events.push({ account_id: a.id, kind: 'sell', agent: 'EXECUTOR',
      message: `VENTE ${sym} — ${MANUAL_REASON} | sortie ${fmtPrice(f.fillPrice)} $ (slippage ${f.slippagePct.toFixed(2)} %, frais ${f.feeUsd.toFixed(2)} $) | PnL ${signed(num(r.pnl_usd))} $ (${signed(num(r.pnl_pct))} %)`,
      data: { step: 'SELL', mint: pos.mint, position_id: pos.id, order_id: r.order_id, price: f.fillPrice, pnl_usd: r.pnl_usd, pnl_pct: r.pnl_pct, reason: MANUAL_REASON, paper: true } });
    return true;
  }
  // Réel : la vraie vente se fait au prix de Jupiter (glissement borné), même si DexScreener n'a pas de prix à cet instant.
  const s = await session(ctx, a);
  if ('error' in s) { warnOnce(ctx, a.id, pos.id, `Fermeture manuelle de ${sym} en attente : moteur réel indisponible (${s.error}).`); return false; }
  const S = s.S;
  const gate = sellGate(S.failedSells.get(pos.id) ?? [], Date.now());
  if (gate.action === 'wait') return false;
  if (gate.action === 'abandon') {
    const why = `invendable : ${gate.n} ventes échouées en 3 h, position abandonnée (les jetons restent dans le portefeuille, la valeur n’est plus comptée).`;
    const { error } = await ctx.sb.rpc('live_abandon_position', { p_position: pos.id, p_reason: why });
    ctx.events.push({ account_id: a.id, kind: error ? 'error' : 'warning', agent: 'EXECUTOR', message: error ? `${sym} : abandon impossible (${error.message})` : `${sym} : ${why}`, data: { position_id: pos.id, mint: pos.mint, abandoned: !error } });
    return false;
  }
  const can = canSell(S, ctx.deadline - Date.now());
  if (!can.ok) { warnOnce(ctx, a.id, pos.id, `Fermeture manuelle de ${sym} reportée : ${can.reason}.`); return false; }
  const r = await sellPosition(S.L, {
    position: { id: pos.id, mint: pos.mint, qty: pos.qty, size_usd: pos.size_usd, entry_price: pos.entry_price },
    reason: MANUAL_REASON, refPrice: price > 0 ? price : null, slippageBps: exitSlippageBps(S.info.maxSlippageBps), level: 'veryHigh',
  });
  if (r.ok) {
    ctx.events.push({ account_id: a.id, kind: 'sell', agent: 'EXECUTOR',
      message: `VENTE ${sym} — ${MANUAL_REASON} | sortie ${fmtPrice(r.price)} $ (slippage ${r.slipPct.toFixed(2)} %, frais ${r.feeUsd.toFixed(3)} $) | PnL ${signed(r.pnlUsd)} $ (${signed(r.pnlPct)} %) | tx ${r.signature.slice(0, 8)}…`,
      data: { step: 'SELL', mint: pos.mint, position_id: pos.id, price: r.price, usd: r.usd, qty: r.qty, pnl_usd: r.pnlUsd, pnl_pct: r.pnlPct, reason: MANUAL_REASON, paper: false, signature: r.signature } });
    try { S.bal = await refreshBalances(S.L); } catch { /* relu au prochain tour */ }
    return true;
  }
  if (r.code === 'empty') {
    const why = 'aucun jeton de cette position dans le portefeuille : position clôturée sans vente.';
    const { error } = await ctx.sb.rpc('live_abandon_position', { p_position: pos.id, p_reason: why });
    ctx.events.push({ account_id: a.id, kind: error ? 'error' : 'warning', agent: 'EXECUTOR', message: error ? `${sym} : abandon impossible (${error.message})` : `${sym} : ${why}`, data: { position_id: pos.id, mint: pos.mint, abandoned: !error } });
    return false;
  }
  if (r.pending) {
    ctx.events.push({ account_id: a.id, kind: 'warning', agent: 'EXECUTOR', message: `Vente ${sym} envoyée, confirmation en attente (${r.error}) : réglée au prochain tour, aucune nouvelle vente d’ici là.`, data: { position_id: pos.id, signature: r.signature ?? null } });
    return false;
  }
  if (r.code === 'swap' || r.code === 'quote') S.failedSells.set(pos.id, [...(S.failedSells.get(pos.id) ?? []), Date.now()]);
  ctx.events.push({ account_id: a.id, kind: 'error', agent: 'EXECUTOR', message: `Vente ${sym} échouée : ${r.error} (nouvel essai espacé automatiquement)`, data: { mint: pos.mint, position_id: pos.id, reason: MANUAL_REASON, code: r.code } });
  return false;
}

/** Tests uniquement. */
export function _resetManual() { lastWarn.clear(); }
