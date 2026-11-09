// FYNX — exécution réelle sur Solana via Jupiter. Toutes les entrées/sorties sont injectées (Store, Rpc, Jupiter, Signer)
// pour que la logique soit testée sans réseau. Principe : un ordre est TOUJOURS écrit « en attente » avant d'être signé,
// sa signature est enregistrée AVANT l'envoi, et un ordre jamais confirmé est tranché par la réconciliation (jamais deviné).
import {
  SOL_MINT, USDC_MINT, TOKEN_PROGRAM, TOKEN_2022_PROGRAM,
  signTransaction, signLegacy, compileLegacyMessage, ixCloseTokenAccount, RpcError, waitConfirmed,
  type Rpc, type Signer, type ChainTx, type TokenAccount,
} from './solana.ts';
import type { Jupiter, Quote, Level } from './jupiter.ts';

export const MAX_BUY_DEVIATION = 0.12;     // prix exécutable max. au-dessus du prix de marché
export const MAX_ROUNDTRIP_LOSS = 0.25;    // perte max. d'un aller-retour simulé (jeton taxé ou sans liquidité)
export const MIN_SOL_FOR_BUY = 20_000_000n; // 0,02 SOL : frais + loyer des comptes de jeton
export const MIN_SOL_FOR_SELL = 3_000_000n; // 0,003 SOL
export const BUY_PRIO = 400_000;            // plafond des frais de priorité (lamports)
export const SELL_PRIO = 1_000_000;
const BAD_EXTENSIONS = new Set(['permanentDelegate', 'transferHook', 'nonTransferable', 'defaultAccountState', 'transferFeeConfig', 'pausableConfig']);

export type OrderRow = {
  id: string; account_id: string; side: 'BUY' | 'SELL'; mint: string; tx_signature: string | null; created_at: string;
  position_id: string | null; reason: string | null; meta: Record<string, unknown> | null;
};
export interface Store {
  /** Appelle une fonction SQL ; lève une Error (message = erreur SQL) en cas d'échec. */
  rpc(fn: string, args: Record<string, unknown>): Promise<unknown>;
  pendingOrders(accountId: string): Promise<OrderRow[]>;
}
export type LiveCtx = {
  store: Store; rpc: Rpc; jup: Jupiter; signer: Signer; accountId: string; solUsd: number;
  log: (kind: 'info' | 'warning' | 'error' | 'buy' | 'sell', agent: string, message: string, data?: unknown) => void;
  deadline?: number; now?: () => number; sleep?: (ms: number) => Promise<void>;
};

const nowOf = (L: LiveCtx) => (L.now ?? Date.now)();
const sleepOf = (L: LiveCtx) => L.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
const errMsg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 240);
const usd2 = (x: number) => x.toFixed(2);

export function explainDb(message: string): string {
  const m = /not_verified|limit_trade|limit_exposure|limit_daily_loss|max_positions_reached|pending_order_exists|entries_paused|position_not_open|position_not_found|invalid_order/.exec(message)?.[0];
  switch (m) {
    case 'not_verified': return 'compte réel pas encore vérifié (test réel obligatoire)';
    case 'limit_trade': return 'plafond par trade du compte réel atteint';
    case 'limit_exposure': return 'plafond d’exposition totale du compte réel atteint';
    case 'limit_daily_loss': return 'plafond de perte journalière du compte réel atteint';
    case 'max_positions_reached': return 'nombre maximum de positions atteint';
    case 'pending_order_exists': return 'un autre ordre réel est encore en cours de confirmation';
    case 'entries_paused': return 'entrées suspendues 15 min après des échecs répétés';
    case 'position_not_open': return 'position déjà fermée';
    default: return message.slice(0, 200);
  }
}

export function describeChainError(err: unknown): string {
  const s = typeof err === 'string' ? err : JSON.stringify(err);
  if (/0x1771|"Custom":6001|Custom\(6001\)/.test(s)) return 'slippage dépassé : le prix a bougé pendant l’exécution';
  if (/InsufficientFundsForRent/i.test(s)) return 'montant trop faible : un compte neuf doit recevoir au moins 0,00089 SOL (ou garder ce minimum)';
  if (/InsufficientFunds|insufficient funds|0x1\b/i.test(s)) return 'solde insuffisant pour cette transaction';
  if (/BlockhashNotFound|blockhash/i.test(s)) return 'transaction expirée';
  return `refusée par le réseau : ${s.slice(0, 160)}`;
}

/** Prix en dollars du jeton (paire la plus liquide de DexScreener) ; null si inconnu, jamais une valeur inventée. */
export async function fetchUsdPrice(mint: string, fetchFn: typeof fetch = fetch): Promise<number | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8_000);
  try {
    const r = await fetchFn(`https://api.dexscreener.com/tokens/v1/solana/${mint}`, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const list = (await r.json()) as { baseToken?: { address?: string }; priceUsd?: string | null; liquidity?: { usd?: number | null } | null }[];
    if (!Array.isArray(list)) return null;
    let best: { px: number; liq: number } | null = null;
    for (const p of list) {
      if (p?.baseToken?.address !== mint) continue;
      const px = Number(p.priceUsd);
      if (!(px > 0) || !Number.isFinite(px)) continue;
      const liq = Number(p.liquidity?.usd ?? 0);
      if (!best || liq > best.liq) best = { px, liq };
    }
    return best ? best.px : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────── Lecture de la chaîne ─────────────────────────

export type Balances = { sol: bigint; usdc: bigint; accounts: TokenAccount[] };
export async function getBalances(rpc: Rpc, owner: string): Promise<Balances> {
  const [sol, accounts] = await Promise.all([rpc.balance(owner), rpc.tokenAccountsAll(owner)]);
  const usdc = accounts.filter((a) => a.mint === USDC_MINT).reduce((s, a) => s + a.raw, 0n);
  return { sol, usdc, accounts };
}

/** Lit les soldes réels et détecte dépôts / retraits (ajuste le capital net déposé côté SQL). */
export async function refreshBalances(L: LiveCtx): Promise<Balances & { flowUsd: number }> {
  const b = await getBalances(L.rpc, L.signer.pubkey);
  let flowUsd = 0;
  try {
    const r = (await L.store.rpc('live_apply_flow', {
      p_account: L.accountId, p_usdc_raw: Number(b.usdc), p_sol_lamports: Number(b.sol), p_sol_usd: L.solUsd > 0 ? L.solUsd : null,
    })) as { flow_usd?: number } | null;
    flowUsd = Number(r?.flow_usd ?? 0);
  } catch (e) {
    L.log('warning', 'EQUITY', `Synchronisation des soldes impossible : ${errMsg(e)}`);
  }
  if (flowUsd >= 0.25) L.log('info', 'EQUITY', `Dépôt détecté : +${usd2(flowUsd)} $ — capital net déposé mis à jour.`, { flow_usd: flowUsd });
  else if (flowUsd <= -0.25) L.log('info', 'EQUITY', `Retrait détecté : −${usd2(-flowUsd)} $ — capital net déposé mis à jour.`, { flow_usd: flowUsd });
  return { ...b, flowUsd };
}

export type MintCheck = { ok: true; decimals: number; program: string } | { ok: false; reason: string };
export async function checkMint(rpc: Rpc, mint: string): Promise<MintCheck> {
  const info = await rpc.mintInfo(mint);
  if (!info) return { ok: false, reason: 'jeton introuvable sur la chaîne' };
  if (info.owner !== TOKEN_PROGRAM && info.owner !== TOKEN_2022_PROGRAM) return { ok: false, reason: 'programme de jeton inconnu' };
  if (info.freezeAuthority) return { ok: false, reason: 'le créateur peut geler les comptes (autorité de gel active)' };
  const bad = info.extensions.find((e) => BAD_EXTENSIONS.has(e));
  if (bad) return { ok: false, reason: `extension Token-2022 dangereuse (${bad})` };
  if (!(info.decimals >= 0 && info.decimals <= 12)) return { ok: false, reason: 'décimales invalides' };
  return { ok: true, decimals: info.decimals, program: info.owner };
}

// ───────────────────────── Lecture d'une transaction confirmée ─────────────────────────

export function ownerDeltas(tx: ChainTx, owner: string): { sol: bigint; fee: bigint; tok: Map<string, bigint> } {
  const m = tx.meta;
  if (!m) throw new Error('détails de transaction absents');
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const i = keys.indexOf(owner);
  if (i < 0) throw new Error('portefeuille absent de la transaction');
  const tok = new Map<string, bigint>();
  const add = (list: { mint: string; owner?: string; uiTokenAmount: { amount: string } }[] | undefined, sign: bigint) => {
    for (const b of list ?? []) if (b.owner === owner) tok.set(b.mint, (tok.get(b.mint) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
  };
  add(m.postTokenBalances, 1n);
  add(m.preTokenBalances, -1n);
  return { sol: BigInt(m.postBalances[i]) - BigInt(m.preBalances[i]), fee: BigInt(m.fee), tok };
}

async function fetchTx(L: LiveCtx, signature: string): Promise<ChainTx | null> {
  for (let i = 0; i < 4; i++) {
    try { const tx = await L.rpc.transaction(signature); if (tx?.meta) return tx; } catch { /* nouvel essai */ }
    if (i < 3) await sleepOf(L)(1_000);
  }
  return null;
}

// ───────────────────────── Exécution d'un échange ─────────────────────────

export type SwapRun =
  | { ok: true; signature: string; tx: ChainTx }
  | { ok: false; pending: boolean; signature?: string; error: string; stage: string };

export async function runSwap(L: LiveCtx, a: { quote: Quote; prio: number; level?: Level; orderId?: string; confirmMs?: number }): Promise<SwapRun> {
  let built;
  try { built = await L.jup.swap(a.quote, L.signer.pubkey, a.prio, a.level ?? 'high'); }
  catch (e) { return { ok: false, pending: false, error: `construction impossible : ${errMsg(e)}`, stage: 'build' }; }
  let signed;
  try { signed = await signTransaction(built.swapTransaction, L.signer); }
  catch (e) { return { ok: false, pending: false, error: `transaction refusée : ${errMsg(e)}`, stage: 'sign' }; }
  if (a.orderId) {
    try {
      await L.store.rpc('live_attach_signature', { p_order: a.orderId, p_signature: signed.signature, p_meta: { last_valid_block_height: built.lastValidBlockHeight, quote_out: a.quote.outAmount } });
    } catch (e) { return { ok: false, pending: false, error: `signature non enregistrée, envoi annulé : ${errMsg(e)}`, stage: 'persist' }; }
  }
  try { await L.rpc.send(signed.b64); }
  catch (e) {
    if (e instanceof RpcError) return { ok: false, pending: false, signature: signed.signature, error: describeChainError(`${e.message} ${JSON.stringify(e.data ?? '')}`), stage: 'send' };
    return { ok: false, pending: true, signature: signed.signature, error: `envoi sans réponse (${errMsg(e)})`, stage: 'send' };
  }
  const budget = Math.max(5_000, Math.min(a.confirmMs ?? 25_000, (L.deadline ?? Infinity) - nowOf(L)));
  const w = await waitConfirmed(L.rpc, signed.signature, { timeoutMs: budget, rebroadcast: () => L.rpc.send(signed.b64) });
  if (w.state === 'failed') return { ok: false, pending: false, signature: signed.signature, error: describeChainError(w.err), stage: 'chain' };
  if (w.state === 'timeout') return { ok: false, pending: true, signature: signed.signature, error: 'pas encore confirmée', stage: 'confirm' };
  const tx = await fetchTx(L, signed.signature);
  if (!tx) return { ok: false, pending: true, signature: signed.signature, error: 'confirmée mais détails indisponibles', stage: 'details' };
  if (tx.meta?.err) return { ok: false, pending: false, signature: signed.signature, error: describeChainError(tx.meta.err), stage: 'chain' };
  return { ok: true, signature: signed.signature, tx };
}

// ───────────────────────── Règlement (SQL) d'un ordre confirmé ─────────────────────────

export type Settled =
  | { ok: true; side: 'BUY'; positionId: string; qty: number; price: number; usd: number; feeUsd: number; slipPct: number }
  | { ok: true; side: 'SELL'; pnlUsd: number; pnlPct: number; qty: number; price: number; usd: number; feeUsd: number; slipPct: number }
  | { ok: false; error: string };

export async function settleOrder(L: LiveCtx, row: OrderRow, tx: ChainTx): Promise<Settled> {
  const m = row.meta ?? {};
  const dec = Number(m.decimals);
  const ref = Number(m.ref_price);
  const solUsd = Number(m.sol_usd) > 0 ? Number(m.sol_usd) : L.solUsd;
  if (!(dec >= 0 && dec <= 12)) return { ok: false, error: 'décimales du jeton inconnues pour ce règlement' };
  let d;
  try { d = ownerDeltas(tx, L.signer.pubkey); } catch (e) { return { ok: false, error: errMsg(e) }; }
  const usdc = d.tok.get(USDC_MINT) ?? 0n;
  const tk = d.tok.get(row.mint) ?? 0n;
  const feeUsd = (Number(d.fee) / 1e9) * (solUsd > 0 ? solUsd : 0);
  try {
    if (row.side === 'BUY') {
      if (!(usdc < 0n && tk > 0n)) return { ok: false, error: 'la transaction confirmée ne contient pas l’achat attendu' };
      const usd = Number(-usdc) / 1e6, qty = Number(tk) / 10 ** dec, price = usd / qty;
      const slip = ref > 0 ? (price / ref - 1) * 100 : 0;
      const positionId = (await L.store.rpc('live_settle_buy', {
        p_order: row.id, p_price: price, p_qty: qty, p_usd: usd, p_fee_usd: feeUsd, p_slip: slip, p_usdc_delta: Number(usdc), p_sol_delta: Number(d.sol),
      })) as string;
      return { ok: true, side: 'BUY', positionId, qty, price, usd, feeUsd, slipPct: slip };
    }
    if (!(usdc > 0n && tk < 0n)) return { ok: false, error: 'la transaction confirmée ne contient pas la vente attendue' };
    const usd = Number(usdc) / 1e6, qty = Number(-tk) / 10 ** dec, price = usd / qty;
    const slip = ref > 0 ? (1 - price / ref) * 100 : 0;
    const r = (await L.store.rpc('live_settle_sell', {
      p_order: row.id, p_price: price, p_qty: qty, p_usd: usd, p_fee_usd: feeUsd, p_slip: slip, p_usdc_delta: Number(usdc), p_sol_delta: Number(d.sol),
      p_reason: String(m.reason_close ?? row.reason ?? ''),
    })) as { pnl_usd: number; pnl_pct: number };
    return { ok: true, side: 'SELL', pnlUsd: Number(r.pnl_usd), pnlPct: Number(r.pnl_pct), qty, price, usd, feeUsd, slipPct: slip };
  } catch (e) {
    return { ok: false, error: `règlement SQL impossible : ${errMsg(e)}` };
  }
}

// ───────────────────────── Achat ─────────────────────────

export type BuyReq = {
  mint: string; symbol: string; usd: number; refPrice: number; risk: number; reason: string;
  stopPct: number; tpPct: number; trailingPct: number | null; maxPositions: number; slippageBps: number; test?: boolean;
};
export type BuyResult =
  | { ok: true; positionId: string; qty: number; price: number; usd: number; feeUsd: number; slipPct: number; signature: string }
  | { ok: false; code: string; error: string; pending?: boolean; signature?: string };

const bad = (code: string, error: string, extra: { pending?: boolean; signature?: string } = {}) => ({ ok: false as const, code, error, ...extra });

export async function buyToken(L: LiveCtx, r: BuyReq): Promise<BuyResult> {
  if (!(r.usd > 0) || !(r.refPrice > 0)) return bad('invalid', 'montant ou prix de référence invalide');
  if (!(L.solUsd > 0)) return bad('price', 'prix du SOL indisponible : achat reporté');
  let mc: MintCheck;
  try { mc = await checkMint(L.rpc, r.mint); } catch (e) { return bad('rpc', `lecture du jeton impossible : ${errMsg(e)}`); }
  if (!mc.ok) return bad('mint', mc.reason);
  const amount = BigInt(Math.round(r.usd * 1e6));
  let q: Quote;
  try { q = await L.jup.quote({ inputMint: USDC_MINT, outputMint: r.mint, amount, slippageBps: r.slippageBps }); }
  catch (e) { return bad('quote', `devis d’achat impossible : ${errMsg(e)}`); }
  const outRaw = BigInt(q.outAmount);
  const outUi = Number(outRaw) / 10 ** mc.decimals;
  if (!(outUi > 0)) return bad('quote', 'devis d’achat vide');
  const exec = r.usd / outUi;
  const dev = exec / r.refPrice - 1;
  if (dev > MAX_BUY_DEVIATION) return bad('guard', `prix exécutable ${(dev * 100).toFixed(1)} % au-dessus du prix de marché : achat refusé`);
  try {
    const back = await L.jup.quote({ inputMint: r.mint, outputMint: USDC_MINT, amount: outRaw, slippageBps: Math.min(2_000, r.slippageBps * 2) });
    const backUsd = Number(back.outAmount) / 1e6;
    if (backUsd < r.usd * (1 - MAX_ROUNDTRIP_LOSS)) return bad('guard', `revente simulée à ${usd2(backUsd)} $ pour ${usd2(r.usd)} $ achetés (jeton trop peu liquide ou taxé) : achat refusé`);
  } catch (e) { return bad('guard', `aucune route de revente (${errMsg(e)}) : achat refusé`); }

  const meta = {
    decimals: mc.decimals, program: mc.program, ref_price: r.refPrice, slippage_bps: r.slippageBps, stop_pct: r.stopPct, tp_pct: r.tpPct,
    trailing_pct: r.trailingPct, sol_usd: L.solUsd, symbol: r.symbol, test: r.test === true,
  };
  let orderId: string;
  try {
    orderId = (await L.store.rpc('live_begin_order', {
      p_account: L.accountId, p_side: 'BUY', p_mint: r.mint, p_position: null, p_usd: r.usd, p_price: r.refPrice, p_qty: r.usd / r.refPrice,
      p_reason: r.reason, p_risk: r.risk, p_max_positions: r.maxPositions, p_meta: meta,
    })) as string;
  } catch (e) { return bad('limit', explainDb(errMsg(e))); }

  const sw = await runSwap(L, { quote: q, prio: BUY_PRIO, level: 'high', orderId });
  if (!sw.ok) {
    if (sw.pending) return bad('pending', sw.error, { pending: true, signature: sw.signature });
    await L.store.rpc('live_fail_order', { p_order: orderId, p_error: sw.error }).catch(() => {});
    return bad('swap', sw.error, { signature: sw.signature });
  }
  const row: OrderRow = { id: orderId, account_id: L.accountId, side: 'BUY', mint: r.mint, tx_signature: sw.signature, created_at: new Date(nowOf(L)).toISOString(), position_id: null, reason: r.reason, meta };
  const s = await settleOrder(L, row, sw.tx);
  if (!s.ok || s.side !== 'BUY') return bad('settle', s.ok ? 'règlement inattendu' : s.error, { pending: true, signature: sw.signature });
  return { ok: true, positionId: s.positionId, qty: s.qty, price: s.price, usd: s.usd, feeUsd: s.feeUsd, slipPct: s.slipPct, signature: sw.signature };
}

// ───────────────────────── Vente ─────────────────────────

export type SellReq = {
  position: { id: string; mint: string; qty: number; size_usd: number; entry_price: number };
  reason: string; refPrice: number | null; slippageBps: number; level?: Level; accounts?: TokenAccount[];
};
export type SellResult =
  | { ok: true; pnlUsd: number; pnlPct: number; qty: number; price: number; usd: number; feeUsd: number; slipPct: number; signature: string }
  | { ok: false; code: string; error: string; pending?: boolean; signature?: string };

export async function sellPosition(L: LiveCtx, r: SellReq): Promise<SellResult> {
  if (!(L.solUsd > 0)) return bad('price', 'prix du SOL indisponible : vente reportée');
  let accounts: TokenAccount[];
  try { accounts = r.accounts ?? (await L.rpc.tokenAccountsAll(L.signer.pubkey)); } catch (e) { return bad('rpc', `lecture du portefeuille impossible : ${errMsg(e)}`); }
  const mine = accounts.filter((a) => a.mint === r.position.mint);
  const raw = mine.reduce((s, a) => s + a.raw, 0n);
  if (raw <= 0n) return bad('empty', 'aucun jeton de cette position dans le portefeuille');
  const decimals = mine[0].decimals;
  const ref = r.refPrice && r.refPrice > 0 ? r.refPrice : r.position.entry_price;
  const estUsd = Math.max(0.000001, (Number(raw) / 10 ** decimals) * ref);

  const meta = { decimals, ref_price: ref, slippage_bps: r.slippageBps, sol_usd: L.solUsd, reason_close: r.reason };
  let orderId: string;
  try {
    orderId = (await L.store.rpc('live_begin_order', {
      p_account: L.accountId, p_side: 'SELL', p_mint: r.position.mint, p_position: r.position.id, p_usd: estUsd, p_price: ref,
      p_qty: Number(raw) / 10 ** decimals, p_reason: r.reason, p_risk: null, p_max_positions: 999, p_meta: meta,
    })) as string;
  } catch (e) { return bad('limit', explainDb(errMsg(e))); }

  const fail = async (code: string, error: string) => {
    await L.store.rpc('live_fail_order', { p_order: orderId, p_error: error }).catch(() => {});
    return bad(code, error);
  };
  let q: Quote;
  try { q = await L.jup.quote({ inputMint: r.position.mint, outputMint: USDC_MINT, amount: raw, slippageBps: r.slippageBps }); }
  catch (e) { return await fail('quote', `devis de vente impossible : ${errMsg(e)}`); }

  const sw = await runSwap(L, { quote: q, prio: SELL_PRIO, level: r.level ?? 'veryHigh', orderId });
  if (!sw.ok) {
    if (sw.pending) return bad('pending', sw.error, { pending: true, signature: sw.signature });
    return await fail('swap', sw.error);
  }
  const row: OrderRow = { id: orderId, account_id: L.accountId, side: 'SELL', mint: r.position.mint, tx_signature: sw.signature, created_at: new Date(nowOf(L)).toISOString(), position_id: r.position.id, reason: r.reason, meta };
  const s = await settleOrder(L, row, sw.tx);
  if (!s.ok || s.side !== 'SELL') return bad('settle', s.ok ? 'règlement inattendu' : s.error, { pending: true, signature: sw.signature });
  return { ok: true, pnlUsd: s.pnlUsd, pnlPct: s.pnlPct, qty: s.qty, price: s.price, usd: s.usd, feeUsd: s.feeUsd, slipPct: s.slipPct, signature: sw.signature };
}

// ───────────────────────── Réconciliation des ordres restés « en attente » ─────────────────────────

export type Reconciled = { id: string; side: 'BUY' | 'SELL'; result: 'settled' | 'failed' | 'waiting'; detail?: string };

export async function reconcilePending(L: LiveCtx): Promise<Reconciled[]> {
  const out: Reconciled[] = [];
  const rows = await L.store.pendingOrders(L.accountId);
  const fail = async (row: OrderRow, why: string) => {
    await L.store.rpc('live_fail_order', { p_order: row.id, p_error: why });
    out.push({ id: row.id, side: row.side, result: 'failed', detail: why });
  };
  for (const row of rows) {
    const age = nowOf(L) - Date.parse(row.created_at);
    try {
      if (!row.tx_signature) {
        // Jamais signé/envoyé (arrêt du moteur entre l'écriture et la signature) : sans risque de le clore.
        if (age > 90_000) await fail(row, 'ordre abandonné avant signature'); else out.push({ id: row.id, side: row.side, result: 'waiting' });
        continue;
      }
      const settle = async () => {
        const tx = await fetchTx(L, row.tx_signature!);
        if (!tx) { out.push({ id: row.id, side: row.side, result: 'waiting', detail: 'détails indisponibles' }); return; }
        if (tx.meta?.err) { await fail(row, describeChainError(tx.meta.err)); return; }
        const s = await settleOrder(L, row, tx);
        if (s.ok) out.push({ id: row.id, side: row.side, result: 'settled' });
        else out.push({ id: row.id, side: row.side, result: 'waiting', detail: s.error });
      };
      const st = await L.rpc.status(row.tx_signature);
      if (st?.err) { await fail(row, describeChainError(st.err)); continue; }
      if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) { await settle(); continue; }
      const lv = Number(row.meta?.last_valid_block_height);
      const expired = lv > 0 ? (await L.rpc.blockHeight()) > lv + 10 : age > 5 * 60_000;
      if (!expired) { out.push({ id: row.id, side: row.side, result: 'waiting' }); continue; }
      // Dernier contrôle après expiration : si elle a atterri entre-temps, on la règle ; sinon elle ne pourra plus jamais passer.
      const st2 = await L.rpc.status(row.tx_signature);
      if (st2?.err) await fail(row, describeChainError(st2.err));
      else if (st2 && (st2.confirmationStatus === 'confirmed' || st2.confirmationStatus === 'finalized')) await settle();
      else await fail(row, 'transaction expirée sans confirmation (rien n’a été échangé)');
    } catch (e) {
      out.push({ id: row.id, side: row.side, result: 'waiting', detail: errMsg(e) });
    }
  }
  return out;
}

// ───────────────────────── Ménage : récupérer le loyer des comptes de jeton vides ─────────────────────────

export async function closeEmptyAccounts(L: LiveCtx, accounts: TokenAccount[], max = 6): Promise<number> {
  const empty = accounts.filter((a) => a.raw === 0n && a.mint !== USDC_MINT).slice(0, max);
  if (!empty.length) return 0;
  const owner = L.signer.pubkey;
  try {
    const { blockhash } = await L.rpc.latestBlockhash();
    const msg = compileLegacyMessage(owner, empty.map((a) => ixCloseTokenAccount(a.address, owner, owner, a.program)), blockhash);
    const { b64, signature } = await signLegacy(msg, L.signer);
    await L.rpc.send(b64);
    const w = await waitConfirmed(L.rpc, signature, { timeoutMs: 15_000, rebroadcast: () => L.rpc.send(b64) });
    if (w.state === 'confirmed') { L.log('info', 'EXECUTOR', `Ménage : ${empty.length} compte(s) de jeton vide(s) fermé(s), loyer récupéré.`); return empty.length; }
    return 0;
  } catch {
    return 0; // sans conséquence : réessayé plus tard
  }
}

export { SOL_MINT };
