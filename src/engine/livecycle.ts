// FYNX — cycle de vie d'un compte réel dans le moteur : ouverture d'une session (clé déchiffrée, prix du SOL, réconciliation,
// soldes), règles d'entrée, valorisation, ménage. Aucune dépendance à Deno : testé hors ligne avec un faux client SQL.
import { decryptSeed, signerFromSeed, SOL_MINT, MIN_PASSPHRASE, type Rpc } from './solana.ts';
import type { Jupiter } from './jupiter.ts';
import {
  reconcilePending, refreshBalances, closeEmptyAccounts, MIN_SOL_FOR_BUY, MIN_SOL_FOR_SELL,
  type LiveCtx, type Store, type OrderRow, type Balances, type Reconciled,
} from './live.ts';

export const LIVE_DEADLINE_MS = 95_000;   // budget d'un tick pour les ordres réels (le verrou du moteur dure 120 s)
export const ENTRY_MIN_BUDGET_MS = 45_000; // pas de nouvelle entrée s'il reste moins que ça
export const EXIT_MIN_BUDGET_MS = 12_000;  // pas de nouvelle sortie s'il reste moins que ça

export type LiveInfo = {
  address: string | null; verified: boolean; maxTradeUsd: number; maxExposureUsd: number; maxDailyLossUsd: number;
  maxSlippageBps: number; pausedUntil: string | null; baselineUsd: number; solUsd: number | null;
};

/** Le secret doit être le même que celui vérifié à la création du portefeuille (≥ 32 caractères, assez varié). */
export function secretUsable(s: string | undefined | null): boolean {
  return typeof s === 'string' && s.length >= MIN_PASSPHRASE && new Set(s).size >= 8;
}

/** Un compte réel ne peut trader que s'il est complet, déchiffrable et vérifié par un test réel. */
export function liveGate(info: LiveInfo | null, secretOk: boolean): { ready: boolean; reason?: string } {
  if (!info || !info.address) return { ready: false, reason: 'compte réel incomplet (portefeuille manquant)' };
  if (!secretOk) return { ready: false, reason: 'le secret de chiffrement des portefeuilles (WALLET_ENCRYPTION_KEY) n’est pas configuré' };
  if (!info.verified) return { ready: false, reason: 'le test réel n’a pas encore réussi (obligatoire avant de trader avec de l’argent)' };
  return { ready: true };
}

/** Vue « SQL » minimale : le moteur lui passe son client Supabase (clé de service). */
export interface SbLike {
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: { message: string } | null }>;
}

export function makeStore(sb: SbLike): Store {
  return {
    async rpc(fn, args) {
      const { data, error } = await sb.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    },
    async pendingOrders(accountId) {
      const { data, error } = await sb.from('orders').select('id, account_id, side, mint, tx_signature, created_at, position_id, reason, meta')
        .eq('account_id', accountId).eq('is_paper', false).eq('status', 'pending');
      if (error) throw new Error(error.message);
      return (data ?? []) as OrderRow[];
    },
  };
}

export type Session = {
  L: LiveCtx; info: LiveInfo; solFresh: boolean; bal: Balances & { flowUsd: number };
  reconciled: Reconciled[]; failedSells: Map<string, number[]>;
};
export type OpenDeps = {
  sb: SbLike; secret: string; rpcUrl: string; makeRpc: (url: string) => Rpc; makeJup: () => Jupiter;
  fetchPrice: (mint: string) => Promise<number | null>; log: LiveCtx['log']; deadline: number;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
};
const errMsg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);

export async function openSession(d: OpenDeps, accountId: string, info: LiveInfo): Promise<{ ok: true; S: Session } | { ok: false; error: string }> {
  if (!info.address) return { ok: false, error: 'adresse du portefeuille absente' };
  let signer;
  try {
    const { data, error } = await d.sb.from('live_secrets').select('pubkey, ciphertext').eq('account_id', accountId).maybeSingle();
    if (error || !data) return { ok: false, error: 'portefeuille chiffré introuvable' };
    if (data.pubkey !== info.address) return { ok: false, error: 'l’adresse enregistrée ne correspond pas au portefeuille chiffré : compte bloqué par sécurité' };
    const seed = await decryptSeed(data.ciphertext, d.secret, data.pubkey);
    try { signer = await signerFromSeed(seed, data.pubkey); } finally { seed.fill(0); }
  } catch (e) {
    return { ok: false, error: `clé du portefeuille inutilisable : ${errMsg(e)}` };
  }
  const fresh = await d.fetchPrice(SOL_MINT);
  const solUsd = fresh && fresh > 0 ? fresh : (info.solUsd && info.solUsd > 0 ? info.solUsd : 0);
  const L: LiveCtx = {
    store: makeStore(d.sb), rpc: d.makeRpc(d.rpcUrl), jup: d.makeJup(), signer, accountId, solUsd, log: d.log, deadline: d.deadline,
    now: d.now, sleep: d.sleep,
  };
  let reconciled: Reconciled[] = [];
  try {
    reconciled = await reconcilePending(L);
    for (const r of reconciled) {
      if (r.result === 'settled') d.log('info', 'EXECUTOR', `Ordre ${r.side === 'BUY' ? 'd’achat' : 'de vente'} réglé après confirmation tardive.`);
      else if (r.result === 'failed') d.log('warning', 'EXECUTOR', `Ordre ${r.side === 'BUY' ? 'd’achat' : 'de vente'} non exécuté : ${r.detail ?? 'échec'}.`);
    }
  } catch (e) {
    return { ok: false, error: `réconciliation impossible : ${errMsg(e)}` };
  }
  let bal;
  try { bal = await refreshBalances(L); } catch (e) { return { ok: false, error: `lecture du portefeuille impossible : ${errMsg(e)}` }; }

  // Historique des ventes échouées (3 h) : sert à espacer les nouvelles tentatives et à abandonner une position invendable.
  const failedSells = new Map<string, number[]>();
  try {
    const since = new Date((d.now ?? Date.now)() - 3 * 3600_000).toISOString();
    const { data } = await d.sb.from('orders').select('position_id, created_at').eq('account_id', accountId).eq('is_paper', false)
      .eq('side', 'SELL').eq('status', 'failed').gte('created_at', since);
    for (const r of (data ?? []) as { position_id: string | null; created_at: string }[]) {
      if (!r.position_id) continue;
      failedSells.set(r.position_id, [...(failedSells.get(r.position_id) ?? []), Date.parse(r.created_at)]);
    }
  } catch { /* sans historique : on tente simplement */ }
  return { ok: true, S: { L, info, solFresh: !!(fresh && fresh > 0), bal, reconciled, failedSells } };
}

/** Valeur du portefeuille : USDC + SOL (au prix du jour) + positions ouvertes. */
export function liveValue(bal: { usdc: bigint; sol: bigint }, solUsd: number, openValue: number) {
  const usdc = Number(bal.usdc) / 1e6;
  const solValue = (Number(bal.sol) / 1e9) * (solUsd > 0 ? solUsd : 0);
  return { cash: usdc, solValue, equity: usdc + solValue + openValue };
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/** Règles propres au réel avant toute nouvelle entrée ; renvoie le montant maximum autorisé pour un achat. */
export function entryGate(
  S: Pick<Session, 'info' | 'solFresh' | 'bal'>, openSizeUsd: number, realized24: number, nowMs: number, budgetLeftMs: number,
): { ok: true; maxUsd: number } | { ok: false; reason: string; quiet?: boolean } {
  const i = S.info;
  if (budgetLeftMs < ENTRY_MIN_BUDGET_MS) return { ok: false, reason: 'temps de calcul du tick presque épuisé : entrée reportée', quiet: true };
  if (i.pausedUntil && Date.parse(i.pausedUntil) > nowMs) return { ok: false, reason: `entrées suspendues jusqu’à ${fmtTime(i.pausedUntil)} après des échecs répétés` };
  if (!S.solFresh) return { ok: false, reason: 'prix du SOL indisponible : achat reporté' };
  if (S.bal.sol < MIN_SOL_FOR_BUY) return { ok: false, reason: `SOL insuffisant pour les frais (${(Number(S.bal.sol) / 1e9).toFixed(4).replace('.', ',')} SOL, minimum ${(Number(MIN_SOL_FOR_BUY) / 1e9).toFixed(2).replace('.', ',')} SOL)` };
  if (realized24 < 0 && -realized24 >= i.maxDailyLossUsd) return { ok: false, reason: `plafond de perte journalière du compte réel atteint (${(-realized24).toFixed(2)} $ ≥ ${i.maxDailyLossUsd} $)` };
  const room = i.maxExposureUsd - openSizeUsd;
  if (room < 1) return { ok: false, reason: `plafond d’exposition totale atteint (${openSizeUsd.toFixed(2)} $ sur ${i.maxExposureUsd} $)` };
  return { ok: true, maxUsd: Math.min(i.maxTradeUsd, room) };
}

export function canSell(S: Pick<Session, 'bal'>, budgetLeftMs: number): { ok: true } | { ok: false; reason: string } {
  if (budgetLeftMs < EXIT_MIN_BUDGET_MS) return { ok: false, reason: 'temps de calcul du tick presque épuisé : vente reportée au prochain tick' };
  if (S.bal.sol < MIN_SOL_FOR_SELL) return { ok: false, reason: `SOL insuffisant pour payer les frais d’une vente (${(Number(S.bal.sol) / 1e9).toFixed(4).replace('.', ',')} SOL) : déposez un peu de SOL sur l’adresse du compte` };
  return { ok: true };
}

/** Glissement toléré à la vente : plus large qu'à l'achat, car sortir vite d'un jeton qui chute prime sur le prix. */
export const exitSlippageBps = (maxSlippageBps: number) => Math.min(2_000, Math.max(1_000, maxSlippageBps * 2));

/** Ménage : récupère le loyer des comptes de jeton vides et l'ignore dans le calcul des dépôts (sinon pris pour un dépôt). */
export async function tidyUp(S: Session, log: LiveCtx['log']): Promise<number> {
  const empties = S.bal.accounts.filter((a) => a.raw === 0n);
  if (empties.length < 3) return 0;
  const before = await S.L.rpc.balance(S.L.signer.pubkey);
  const n = await closeEmptyAccounts(S.L, S.bal.accounts, 6);
  if (n === 0) return 0;
  try {
    const after = await S.L.rpc.balance(S.L.signer.pubkey);
    await S.L.store.rpc('live_note_swap', { p_account: S.L.accountId, p_usdc_delta: 0, p_sol_delta: Number(after - before) });
  } catch (e) {
    log('warning', 'EQUITY', `Ménage effectué mais comptabilité non synchronisée : ${errMsg(e)}`);
  }
  return n;
}
