// FYNX — état du dernier scan (affichage « analyse en cours »). Logique pure, sans réseau ni base : testable hors ligne.
// Le moteur note, à chaque scan et pour chaque compte, le sort de chaque jeton examiné : où il s'est arrêté et pourquoi.
// Une seule ligne par compte, réécrite à chaque scan (aucune croissance de la base). Purement informatif : jamais lu par le moteur.
// Ordre réel des étapes : règles → taille → avis de l'IA → achat.

export type ScanStop = 'rules' | 'size' | 'ai' | 'buy' | 'skip';
export type ScanAi = { s: 'ok' | 'unsure' | 'avoid' | 'veto' | 'down'; c?: number };
export type ScanItem = { mint: string; sym: string; score: number | null; stop: ScanStop | null; note: string; ai?: ScanAi };
export type ScanStats = { discovered: number; candidates: number; deep: number; deepFailed: number };
export const SCAN_ITEMS_MAX = 12;

const SCAN_STOPS: readonly string[] = ['rules', 'size', 'ai', 'buy', 'skip'];
const SCAN_AI: readonly string[] = ['ok', 'unsure', 'avoid', 'veto', 'down'];
/** Contrôles, DEL et séparateurs de ligne Unicode (U+2028 / U+2029) : un texte venant d'une source externe n'en garde aucun. */
const CTRL = new RegExp(`[\\x00-\\x1f\\x7f${String.fromCharCode(0x2028, 0x2029)}]+`, 'g');
/** Texte court et sûr : sans retour à la ligne ni caractère de contrôle, borné. */
export function scanText(v: unknown, max: number): string {
  return String(v ?? '').replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
const scanInt = (v: unknown, lo: number, hi: number): number | null => {
  const x = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, Math.round(x))) : null;
};

export function cleanScanItem(i: ScanItem): ScanItem | null {
  const mint = scanText(i.mint, 64);
  if (!mint) return null;
  const o: ScanItem = {
    mint, sym: scanText(i.sym, 24) || `${mint.slice(0, 4)}…${mint.slice(-4)}`, score: scanInt(i.score, 0, 100),
    // Un arrêt inconnu ne devient jamais « a tout passé » (null) : il est affiché comme ignoré.
    stop: i.stop === null ? null : SCAN_STOPS.includes(i.stop) ? i.stop : 'skip', note: scanText(i.note, 140),
  };
  if (i.ai && SCAN_AI.includes(i.ai.s)) { o.ai = { s: i.ai.s }; const c = scanInt(i.ai.c, 0, 100); if (c !== null) o.ai.c = c; }
  return o;
}

/** Ligne `scan_state` d'un compte : valeurs bornées (le texte vient en partie de sources externes). */
export function buildScanRow(accountId: string, stats: ScanStats, items: ScanItem[], blocked: string | null, nowIso: string) {
  const n = (v: number) => scanInt(v, 0, 100_000) ?? 0;
  return {
    account_id: accountId, scanned_at: nowIso, updated_at: nowIso,
    discovered: n(stats.discovered), candidates: n(stats.candidates), deep_checked: n(stats.deep), deep_failed: n(stats.deepFailed),
    blocked: blocked ? scanText(blocked, 200) : null,
    items: items.map(cleanScanItem).filter((x): x is ScanItem => x !== null).slice(0, SCAN_ITEMS_MAX),
  };
}
