// FYNX — logique pure (aucun accès réseau, aucune base) : testable hors ligne.

export type Level = 'low' | 'moderate' | 'high' | 'very_high' | 'critical';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type Finding = {
  name: string;
  description: string;
  severity: Severity;
  confidence: 'high' | 'medium' | 'low';
  observed: string;
  source: string;
  detected_at: string;
  points: number;
};
export type RiskResult = { score: number; level: Level; has_critical: boolean; findings: Finding[]; unknown: string[] };

export type RcRisk = { name: string; level?: string; score?: number; description?: string; value?: string };
export type RcSummary = { risks?: RcRisk[]; score?: number; score_normalised?: number; lpLockedPct?: number } | null;
export type RcReport = {
  rugged?: boolean;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  transferFee?: { pct?: number } | null;
  topHolders?: { pct?: number; insider?: boolean }[] | null;
  graphInsidersDetected?: number;
  creatorBalance?: number;
  token?: { supply?: number; decimals?: number } | null;
  markets?: { lp?: { lpLockedPct?: number } }[] | null;
  totalHolders?: number;
} | null;
export type DexPair = {
  priceUsd?: string | null;
  liquidity?: { usd?: number | null } | null;
  volume?: { h24?: number; h1?: number; m5?: number } | null;
  txns?: { h24?: { buys: number; sells: number }; h1?: { buys: number; sells: number }; m5?: { buys: number; sells: number } } | null;
  priceChange?: { h24?: number; h6?: number; h1?: number; m5?: number } | null;
  marketCap?: number | null;
  pairCreatedAt?: number | null;
} | null;

export const UNKNOWN_CATEGORIES = [
  'Presale Scam', 'Drainer', 'Dev Sniping', 'Dev Wallet Manipulation', 'Sniping', 'Jeeting',
  'MEV / Sandwich Attack', 'Front-running', 'Shilling', 'Paper Hands', 'Diamond Hands', 'Bagholding',
  'Slow Rug / Soft Rug', 'CTO (Community Takeover)', 'Aping / Ape In',
];

export function levelOf(score: number): Level {
  if (score <= 20) return 'low';
  if (score <= 40) return 'moderate';
  if (score <= 60) return 'high';
  if (score <= 80) return 'very_high';
  return 'critical';
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const isSet = (v: unknown) => typeof v === 'string' && v.length > 0 && v !== '11111111111111111111111111111111';

export function scoreRisk(
  input: { summary: RcSummary; report: RcReport; pair: DexPair; nowMs: number },
): RiskResult {
  const { summary, report, pair, nowMs } = input;
  const at = new Date(nowMs).toISOString();
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, 'detected_at'>) => findings.push({ ...f, detected_at: at });
  const unknown = [...UNKNOWN_CATEGORIES];

  // 1) Base : score normalisé RugCheck (0-100, plus haut = plus risqué).
  let base: number;
  const rcNorm = summary?.score_normalised ?? (report as { score_normalised?: number } | null)?.score_normalised;
  if (typeof rcNorm === 'number') base = clamp(rcNorm, 0, 100);
  else {
    base = 40;
    add({ name: 'Données RugCheck indisponibles', description: 'Aucun score RugCheck reçu : le risque ne peut pas être vérifié.', severity: 'medium', confidence: 'high', observed: 'UNKNOWN', source: 'FYNX', points: 0 });
  }

  // 2) Risques listés par RugCheck (déjà inclus dans le score de base : points = 0).
  for (const r of summary?.risks ?? []) {
    const critical = r.level === 'danger' && /mint authority|freeze authority|honeypot|rugged/i.test(r.name);
    add({
      name: r.name,
      description: r.description ?? '',
      severity: critical ? 'critical' : r.level === 'danger' ? 'high' : r.level === 'warn' ? 'medium' : 'info',
      confidence: 'high',
      observed: r.value ? `${r.name}: ${r.value}` : r.name,
      source: 'RugCheck',
      points: 0,
    });
  }

  // 3) Contrôles propres à FYNX, uniquement sur des données réellement reçues.
  if (report) {
    if (report.rugged === true) add({ name: 'Hard Rug', description: 'RugCheck marque ce token comme rugged.', severity: 'critical', confidence: 'high', observed: 'rugged=true', source: 'RugCheck', points: 0 });
    if (isSet(report.mintAuthority)) add({ name: 'Mint Exploit', description: 'L’autorité de mint est active : de nouveaux tokens peuvent être créés.', severity: 'critical', confidence: 'high', observed: `mintAuthority=${report.mintAuthority}`, source: 'RugCheck', points: 0 });
    if (isSet(report.freezeAuthority)) add({ name: 'Blacklist / Freeze', description: 'L’autorité de gel est active : des comptes peuvent être bloqués.', severity: 'critical', confidence: 'high', observed: `freezeAuthority=${report.freezeAuthority}`, source: 'RugCheck', points: 0 });
    const fee = report.transferFee?.pct ?? 0;
    if (fee > 5) add({ name: 'Frais de transfert élevés', description: 'Des frais de transfert élevés peuvent empêcher de vendre.', severity: 'high', confidence: 'high', observed: `${fee}%`, source: 'RugCheck', points: 15 });

    const holders = (report.topHolders ?? []).map((h) => h.pct ?? 0);
    if (holders.length) {
      const top1 = holders[0];
      const top10 = holders.slice(0, 10).reduce((a, b) => a + b, 0);
      if (top1 > 30) add({ name: 'Concentration des détenteurs', description: 'Un seul compte détient plus de 30 % (peut inclure un compte de pool).', severity: 'high', confidence: 'medium', observed: `top1=${top1.toFixed(1)}%`, source: 'RugCheck', points: 15 });
      if (top10 > 60) add({ name: 'Concentration des détenteurs', description: 'Les 10 plus gros comptes détiennent plus de 60 %.', severity: 'medium', confidence: 'medium', observed: `top10=${top10.toFixed(1)}%`, source: 'RugCheck', points: 10 });
      const insiderPct = (report.topHolders ?? []).filter((h) => h.insider).reduce((a, h) => a + (h.pct ?? 0), 0);
      if (insiderPct > 20 || (report.graphInsidersDetected ?? 0) >= 10) add({ name: 'Bundling / Cabal (indice)', description: 'Des comptes liés détiennent une part importante : possible bundling ou cabal. Ce n’est pas une preuve de fraude.', severity: 'high', confidence: 'medium', observed: `insiders=${insiderPct.toFixed(1)}% réseau=${report.graphInsidersDetected ?? 0}`, source: 'RugCheck', points: 15 });
    }
    const supply = report.token?.supply, dec = report.token?.decimals ?? 0;
    if (supply && report.creatorBalance !== undefined) {
      const pct = (report.creatorBalance / supply) * 100;
      if (pct > 10) add({ name: 'Dev Dump (risque)', description: 'Le créateur détient plus de 10 % de l’offre : il peut vendre massivement.', severity: 'high', confidence: 'medium', observed: `créateur=${pct.toFixed(1)}%`, source: 'RugCheck', points: 10 });
      void dec;
    }
  }
  const lpLocked = summary?.lpLockedPct ?? report?.markets?.[0]?.lp?.lpLockedPct;
  if (typeof lpLocked === 'number') {
    if (lpLocked < 20) add({ name: 'Liquidity Drain (risque)', description: 'Moins de 20 % de la liquidité est verrouillée : elle peut être retirée.', severity: 'high', confidence: 'medium', observed: `lpLocked=${lpLocked}%`, source: 'RugCheck', points: 15 });
    else if (lpLocked < 80) add({ name: 'Liquidity Drain (risque)', description: 'La liquidité n’est que partiellement verrouillée.', severity: 'low', confidence: 'medium', observed: `lpLocked=${lpLocked}%`, source: 'RugCheck', points: 5 });
  }

  if (pair) {
    const liq = pair.liquidity?.usd;
    if (typeof liq === 'number') {
      if (liq < 5_000) add({ name: 'Liquidité très faible', description: 'Moins de 5 000 $ de liquidité : sortie difficile, fort slippage.', severity: 'high', confidence: 'high', observed: `${Math.round(liq)} $`, source: 'DexScreener', points: 25 });
      else if (liq < 15_000) add({ name: 'Liquidité faible', description: 'Moins de 15 000 $ de liquidité.', severity: 'medium', confidence: 'high', observed: `${Math.round(liq)} $`, source: 'DexScreener', points: 10 });
    }
    const h1 = pair.txns?.h1;
    if (h1 && h1.sells === 0 && h1.buys >= 15) add({ name: 'Honeypot (possible)', description: 'Beaucoup d’achats et aucune vente sur 1 h : il est peut-être impossible de vendre. À confirmer.', severity: 'critical', confidence: 'medium', observed: `h1 buys=${h1.buys} sells=0`, source: 'DexScreener', points: 0 });
    const vol = pair.volume?.h24;
    if (typeof vol === 'number' && typeof liq === 'number' && liq > 0 && vol > 30 * liq) add({ name: 'Wash trading / volume botting (indice)', description: 'Le volume 24 h dépasse 30 fois la liquidité. Comportement de marché, pas une fraude avérée.', severity: 'medium', confidence: 'low', observed: `vol/liq=${(vol / liq).toFixed(0)}`, source: 'DexScreener', points: 10 });
    const pc = pair.priceChange;
    if ((pc?.h1 ?? 0) > 300 || (pc?.h24 ?? 0) > 1000) add({ name: 'Pump (hausse extrême)', description: 'Hausse très forte : risque de Pump and Dump. Comportement de marché, pas une fraude avérée.', severity: 'medium', confidence: 'low', observed: `h1=${pc?.h1}% h24=${pc?.h24}%`, source: 'DexScreener', points: 10 });
    if ((pc?.m5 ?? 0) < -30 || (pc?.h1 ?? 0) < -50) add({ name: 'Dump / Nuke', description: 'Chute très rapide du prix.', severity: 'high', confidence: 'high', observed: `m5=${pc?.m5}% h1=${pc?.h1}%`, source: 'DexScreener', points: 15 });
    if (pair.pairCreatedAt && nowMs - pair.pairCreatedAt < 10 * 60_000) add({ name: 'Paire très récente', description: 'Moins de 10 minutes d’historique.', severity: 'low', confidence: 'high', observed: `${Math.round((nowMs - pair.pairCreatedAt) / 60_000)} min`, source: 'DexScreener', points: 10 });
  } else {
    add({ name: 'Données de marché indisponibles', description: 'Aucune paire DexScreener trouvée.', severity: 'medium', confidence: 'high', observed: 'UNKNOWN', source: 'DexScreener', points: 10 });
  }

  const has_critical = findings.some((f) => f.severity === 'critical');
  let score = clamp(Math.round(base + findings.reduce((a, f) => a + f.points, 0)), 0, 100);
  if (has_critical) score = Math.max(score, 81);
  return { score, level: levelOf(score), has_critical, findings, unknown };
}

export function sizePosition(p: { equity: number; cash: number; sizePct: number; maxTradeUsd: number; openCount: number; maxPositions: number }): number {
  if (p.openCount >= p.maxPositions) return 0;
  const usd = Math.min((p.equity * p.sizePct) / 100, p.maxTradeUsd, p.cash * 0.98);
  return usd > 1 ? Math.floor(usd * 100) / 100 : 0;
}

// Hypothèses de simulation (documentées dans l'application) : frais 0,5 %, slippage ≈ 2 × (taille / liquidité).
export const PAPER_FEE_PCT = 0.5;
export function simulateFill(side: 'BUY' | 'SELL', price: number, usd: number, liquidityUsd: number | null) {
  const slip = clamp(liquidityUsd && liquidityUsd > 0 ? (usd / liquidityUsd) * 100 * 2 : 5, 0.3, 20);
  const fill = side === 'BUY' ? price * (1 + slip / 100) : price * (1 - slip / 100);
  const fee = (usd * PAPER_FEE_PCT) / 100;
  return { fillPrice: fill, slippagePct: slip, feeUsd: fee };
}

export type OpenPos = {
  entry_price: number; stop_price: number | null; take_profit_price: number | null; trailing_pct: number | null; peak_price: number | null;
  id?: string; mint?: string;
};
/** Hausse maximale du pic par tick : un prix isolé bien au-dessus du dernier sommet connu est un prix aberrant (mauvais pool, tick erroné),
 *  pas un vrai sommet. Un vrai pump reste suivi : le pic monte de +15 % à chaque tour (toutes les 1 à 2 s). */
export const MAX_PEAK_JUMP = 1.15;

// ───────────────────────── Conscience de sortie ─────────────────────────
// Le bot ne se contente plus du TP / SL : il laisse courir tant que ça monte, encaisse dès que le gain recule, coupe vite une
// perte et libère la place quand un token ne bouge pas. Toutes les positions (papier, réel, scalping), à chaque tour rapide.
export const EXIT = {
  /** Perte maximale tolérée depuis le prix d'achat (glissement d'entrée compris) : au-delà, vente immédiate. */
  lossCutPct: 2.5,
  /** Coût estimé de la sortie, en % du prix d'achat : frais papier 0,5 % à l'achat + 0,5 % à la vente + glissement de vente ≥ 0,3 %
   *  (en réel : glissement Jupiter + frais réseau, du même ordre). Un « gain » brut plus petit que ça est une perte une fois vendu. */
  costPct: 1.3,
  /** Le verrou de gain s'arme quand le gain NET (brut − coût) au sommet atteint ce niveau. */
  armNetPct: 1.2,
  /** Gain NET plancher une fois armé : une prise de profit ne doit jamais finir en perte. */
  floorNetPct: 0.5,
  /** Protection du prix de revient : dès que le sommet a dépassé +0,5 % net (≈ +1,8 % brut), on ne laisse plus la position
   *  repasser en perte ; vente si le gain retombe à +0,1 % net (≈ +1,4 % brut). Vu le 12-13/11 : des sommets à +2 % revendus à −2,6 %. */
  breakevenArmNetPct: 0.5,
  breakevenExitNetPct: 0.1,
  /** Un token qui n'a jamais armé le verrou après ce délai est vendu : la place sert à un token qui monte. */
  noMomentumMin: 6,
};
/** Part du gain net au sommet que le verrou garde : plus le gain est gros, plus on serre (on ne rend pas un gros pump). */
export function keepShare(peakNetPct: number): number {
  return peakNetPct >= 30 ? 0.85 : peakNetPct >= 10 ? 0.8 : 0.7;
}
/** Seuil de vente du verrou, en % de gain BRUT (celui que l'on compare au prix), pour un sommet brut donné ; null s'il n'est pas armé.
 *  Le calcul se fait sur le gain net : on garde une part du gain net du sommet, jamais moins que le plancher net, puis on rajoute le coût. */
export function lockLevel(peakGainPct: number): number | null {
  const net = peakGainPct - EXIT.costPct;
  if (net < EXIT.armNetPct) return null;
  return EXIT.costPct + Math.max(EXIT.floorNetPct, net * keepShare(net));
}
/** Mémoire du processus : quand le moteur a vu chaque position pour la première fois (pour la règle « pas d'élan »). */
const firstSeen = new Map<string, number>();
/** Mémoire des dernières sorties par token (gain au moment de la décision) : pas de rachat d'un token qui n'a pas payé. */
export const exitMemory = new Map<string, { at: number; gainPct: number }>();
export const REBUY_BLOCK_MS = 6 * 60 * 60_000;
export const REBUY_MIN_GAIN_PCT = 3;
/** Un token récemment vendu sans vrai gain ne doit pas être racheté (6 h). */
export function recentlyFailed(mint: string | undefined, nowMs = Date.now()): boolean {
  const m = mint ? exitMemory.get(mint) : undefined;
  return !!m && nowMs - m.at < REBUY_BLOCK_MS && m.gainPct < REBUY_MIN_GAIN_PCT;
}
/** Tests uniquement. */
export function _resetExitMemory() { firstSeen.clear(); exitMemory.clear(); }

const pct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} %`;

export function evaluateExit(pos: OpenPos, price: number, priceAgeMs: number, nowMs = Date.now()): { action: 'hold' | 'sell' | 'stale'; reason?: string; peak: number } {
  const prevPeak = pos.peak_price ?? pos.entry_price;
  const peak = Math.max(prevPeak, Math.min(price, prevPeak * MAX_PEAK_JUMP));
  if (priceAgeMs > 5 * 60_000) return { action: 'stale', peak: pos.peak_price ?? pos.entry_price };
  if (pos.id && !firstSeen.has(pos.id)) firstSeen.set(pos.id, nowMs);
  const sell = (reason: string) => {
    if (pos.mint && pos.entry_price > 0) exitMemory.set(pos.mint, { at: nowMs, gainPct: (price / pos.entry_price - 1) * 100 });
    if (pos.id) firstSeen.delete(pos.id);
    return { action: 'sell' as const, reason, peak };
  };
  if (pos.stop_price !== null && price <= pos.stop_price) return sell('Stop Loss atteint');
  if (pos.take_profit_price !== null && price >= pos.take_profit_price) return sell('Take Profit atteint');
  if (!(pos.entry_price > 0)) return { action: 'hold', peak };
  const gain = (price / pos.entry_price - 1) * 100;
  const peakGain = (peak / pos.entry_price - 1) * 100;
  if (gain <= -EXIT.lossCutPct) return sell(`Perte coupée tout de suite (${pct(gain)})`);
  const lock = lockLevel(peakGain);
  if (lock !== null && gain <= lock) return sell(`Prise de profit : ${pct(gain)} (sommet ${pct(peakGain)}), le gain recule`);
  if (lock === null && peakGain - EXIT.costPct >= EXIT.breakevenArmNetPct && gain - EXIT.costPct <= EXIT.breakevenExitNetPct) {
    return sell(`Protection : retour vers le prix de revient (${pct(gain)}, sommet ${pct(peakGain)}), on sort avant la perte`);
  }
  if (pos.trailing_pct !== null && price <= peak * (1 - pos.trailing_pct / 100) && peak > pos.entry_price) return sell('Trailing Stop atteint');
  const seen = pos.id ? firstSeen.get(pos.id) : undefined;
  if (lock === null && seen !== undefined && nowMs - seen >= EXIT.noMomentumMin * 60_000) {
    return sell(`Pas d’élan en ${EXIT.noMomentumMin} min (${pct(gain)}) : place à un token qui monte`);
  }
  return { action: 'hold', peak };
}

/** Marge sur l'intervalle de scan : les tours sont espacés de 5 s, un tour ne tombe presque jamais pile à l'heure. */
export const SCAN_SLACK_MS = 2_500;
/** Faut-il relancer la recherche de nouveaux tokens ? (âge de la dernière recherche vs fréquence réglée, en secondes) */
export function scanIsDue(ageMs: number, intervalSeconds: number): boolean {
  return ageMs >= intervalSeconds * 1000 - SCAN_SLACK_MS;
}

export type EntrySettings = { max_risk_score: number; caution_level: 'low' | 'medium' | 'high' };
export function evaluateEntry(pair: DexPair, risk: RiskResult, s: EntrySettings, priceAgeMs: number): { ok: boolean; reasons: string[] } {
  const why: string[] = [];
  if (!pair || !pair.priceUsd) return { ok: false, reasons: ['Aucune donnée de prix'] };
  if (priceAgeMs > 2 * 60_000) why.push('Données de prix périmées');
  if (risk.has_critical) why.push('Signal critique détecté');
  if (risk.score > s.max_risk_score) why.push(`Score de risque ${risk.score} > limite ${s.max_risk_score}`);
  const minLiq = s.caution_level === 'high' ? 25_000 : s.caution_level === 'medium' ? 15_000 : 8_000;
  const liq = pair.liquidity?.usd ?? 0;
  if (liq < minLiq) why.push(`Liquidité ${Math.round(liq)} $ < minimum ${minLiq} $`);
  if ((pair.volume?.h1 ?? 0) < 2_000) why.push('Volume 1 h trop faible');
  const h1 = pair.txns?.h1;
  if (!h1 || h1.buys < h1.sells * 1.1) why.push('Pression acheteuse insuffisante');
  const pc = pair.priceChange;
  if ((pc?.h1 ?? 0) <= 0) why.push('Tendance 1 h non haussière');
  if ((pc?.h1 ?? 0) > 150) why.push('Hausse 1 h trop forte (risque de poursuite du pump)');
  if ((pc?.m5 ?? 0) <= 0) why.push('Ne monte pas en ce moment (5 min)');
  const m5 = pair.txns?.m5;
  if (!m5 || m5.buys <= m5.sells) why.push('Pas plus d’acheteurs que de vendeurs sur 5 min');
  if ((pair.volume?.m5 ?? 0) < 1_000) why.push('Volume 5 min trop faible : le prix ne bouge pas');
  if (recentlyFailed((pair as { baseToken?: { address?: string } }).baseToken?.address)) why.push('Déjà vendu il y a peu sans vrai gain : on passe à un token qui monte');
  return why.length ? { ok: false, reasons: why } : { ok: true, reasons: [`Score ${risk.score} (${risk.level}), liquidité ${Math.round(liq)} $, en hausse (+${pc?.m5} % sur 5 min, +${pc?.h1} % sur 1 h), acheteurs > vendeurs`] };
}

// ───────────────────────── Données de marché ─────────────────────────

export type Pair = NonNullable<DexPair> & {
  chainId?: string;
  baseToken?: { address: string; name?: string; symbol?: string };
  info?: { imageUrl?: string };
  pairAddress?: string;
};

export const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const EXCLUDED_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

// ───────────────────────── Prix fiables (anti-prix aberrants) ─────────────────────────
// DexScreener renvoie toutes les paires d'un token. Une paire secondaire (liquidité gonflée, prix faux) apparaît parfois
// pendant un seul tour : vu le 11/11 sur BULLHARIS, ×5 puis ×2,5 pendant 5 s, ce qui a faussé l'équité et le trailing stop.

/** Garde la paire déjà suivie tant qu'elle figure dans la réponse ; sinon la plus liquide. */
export function choosePair(all: Pair[], prevPair: string | undefined): Pair | null {
  let best: Pair | null = null;
  for (const p of all) {
    if (prevPair && p.pairAddress === prevPair) return p;
    if (!best || (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
  }
  return best;
}

/** Toutes les paires valides par token (token de base, Solana, prix > 0). */
export function groupPairs(arr: unknown): Map<string, Pair[]> {
  const out = new Map<string, Pair[]>();
  if (!Array.isArray(arr)) return out;
  for (const raw of arr) {
    const p = raw as Pair;
    const m = p?.baseToken?.address;
    if (!m || (p.chainId && p.chainId !== 'solana')) continue;
    const price = Number(p.priceUsd);
    if (!Number.isFinite(price) || price <= 0) continue;
    const l = out.get(m);
    if (l) l.push(p); else out.set(m, [p]);
  }
  return out;
}

export type PxMem = { px: number; at: number; pend?: number };
/** Écart (en multiple) au-delà duquel un prix doit être confirmé au tour suivant avant d'être utilisé. */
export const SPIKE_X = 1.5;
/** Au-delà de cette ancienneté, le dernier prix validé n'est plus une référence : le nouveau prix est accepté tel quel. */
export const PX_MEM_TTL_MS = 120_000;
/**
 * Filtre anti-pic : un prix qui saute de plus de ×1,5 (ou chute sous ÷1,5) d'un tour à l'autre est retenu une fois ;
 * il n'est accepté que s'il se confirme au tour suivant (à ±15 % près). Sinon le dernier prix validé est conservé.
 * Vaut dans les deux sens : un faux plongeon ne déclenche pas non plus de stop loss.
 */
export function guardPrice(mem: PxMem | undefined, raw: number, now: number): { px: number; mem: PxMem; held: boolean } {
  if (!mem || !(mem.px > 0) || now - mem.at > PX_MEM_TTL_MS) return { px: raw, mem: { px: raw, at: now }, held: false };
  const r = raw / mem.px;
  if (r <= SPIKE_X && r >= 1 / SPIKE_X) return { px: raw, mem: { px: raw, at: now }, held: false };
  if (mem.pend && Math.abs(raw / mem.pend - 1) <= 0.15) return { px: raw, mem: { px: raw, at: now }, held: false };
  return { px: mem.px, mem: { px: mem.px, at: mem.at, pend: raw }, held: true };
}

/** Mémoire anti-prix aberrants (paire suivie + dernier prix validé par token). Vit le temps du processus du moteur. */
export type PairMemory = { pair: Map<string, string>; px: Map<string, PxMem> };
export const pairMemory: PairMemory = { pair: new Map(), px: new Map() };

/**
 * Pour chaque token (en tant que token de base), la paire à utiliser : la paire déjà suivie si elle est encore là, sinon la plus
 * liquide ; son prix passe par le filtre anti-pic. `mem = null` : choix pur (la plus liquide, aucun filtre).
 */
export function pickBestPairs(arr: unknown, mem: PairMemory | null = pairMemory, now = Date.now()): Map<string, Pair> {
  const out = new Map<string, Pair>();
  for (const [m, l] of groupPairs(arr)) {
    const p = choosePair(l, mem?.pair.get(m));
    if (!p) continue;
    if (!mem) { out.set(m, p); continue; }
    if (p.pairAddress) mem.pair.set(m, p.pairAddress);
    const g = guardPrice(mem.px.get(m), Number(p.priceUsd), now);
    mem.px.set(m, g.mem);
    out.set(m, g.held ? { ...p, priceUsd: String(g.px) } : p);
  }
  if (mem && mem.px.size > 3000) for (const [m, v] of mem.px) if (now - v.at > 30 * 60_000) { mem.px.delete(m); mem.pair.delete(m); }
  return out;
}

// Extrait les adresses Solana des 3 flux (boosts + profils DexScreener, nouveaux tokens RugCheck).
export function extractMints(src: { boosts: unknown; profiles: unknown; rcNew: unknown }, cap = 90): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (m: unknown) => {
    if (typeof m !== 'string' || !MINT_RE.test(m) || EXCLUDED_MINTS.has(m) || seen.has(m)) return;
    seen.add(m);
    out.push(m);
  };
  for (const list of [src.boosts, src.profiles]) {
    if (!Array.isArray(list)) continue;
    for (const it of list) if (it && (it as { chainId?: string }).chainId === 'solana') push((it as { tokenAddress?: string }).tokenAddress);
  }
  if (Array.isArray(src.rcNew)) for (const it of src.rcNew.slice(0, 40)) push((it as { mint?: string })?.mint);
  return out.slice(0, cap);
}

const NEUTRAL_RISK: RiskResult = { score: 0, level: 'low', has_critical: false, findings: [], unknown: [] };

// Pré-filtre sans risque (gratuit) : ne garde que les tokens qui pourraient passer les critères de marché.
/** Candidats à l'achat : filtrés par les règles de marché, puis classés par élan (ce qui monte vite en ce moment). */
export function rankCandidates(pairs: Map<string, Pair>, mints: string[]): { mint: string; pair: Pair; rank: number }[] {
  const out: { mint: string; pair: Pair; rank: number }[] = [];
  for (const mint of mints) {
    const pair = pairs.get(mint);
    if (!pair) continue;
    if (!evaluateEntry(pair, NEUTRAL_RISK, { max_risk_score: 100, caution_level: 'low' }, 0).ok) continue;
    // Les tokens qui bougent le plus MAINTENANT d'abord : volume des 5 dernières minutes × hausse sur 5 min ; liquidité pour départager.
    out.push({ mint, pair, rank: (pair.volume?.m5 ?? 0) * (1 + Math.max(0, pair.priceChange?.m5 ?? 0) / 10) });
  }
  return out.sort((a, b) => b.rank - a.rank || (b.pair.liquidity?.usd ?? 0) - (a.pair.liquidity?.usd ?? 0));
}

// Les catégories non vérifiables sont stockées avec le rapport, marquées UNKNOWN (jamais « sûr »).
export function toStoredFindings(r: RiskResult): Finding[] {
  const at = r.findings[0]?.detected_at ?? new Date().toISOString();
  const unk: Finding[] = r.unknown.map((name) => ({
    name,
    description: 'Non vérifiable avec les sources gratuites disponibles : affiché UNKNOWN, jamais considéré comme sûr.',
    severity: 'info',
    confidence: 'low',
    observed: 'UNKNOWN',
    source: 'FYNX',
    detected_at: at,
    points: 0,
  }));
  return [...r.findings, ...unk];
}

export function riskFromRow(row: { score: number; level: string; has_critical: boolean; findings: unknown }): RiskResult {
  const all = Array.isArray(row.findings) ? (row.findings as Finding[]) : [];
  const isUnk = (f: Finding) => f.observed === 'UNKNOWN' && f.severity === 'info' && f.source === 'FYNX';
  return {
    score: row.score,
    level: row.level as Level,
    has_critical: row.has_critical,
    findings: all.filter((f) => !isUnk(f)),
    unknown: all.filter(isUnk).map((f) => f.name),
  };
}

// ───────────────────────── Machine d'état du bot ─────────────────────────

export type BotStatus = 'stopped' | 'running' | 'paused' | 'closing';
export type Requested = 'running' | 'paused' | 'stopped';
export type Decision = { next: BotStatus; resetRequested?: Requested; event?: string; level?: 'info' | 'warning' };

export function decideState(
  p: { mode: 'paper' | 'live'; status: BotStatus; requested: Requested; openCount: number; liveGate?: { ready: boolean; reason?: string } },
): Decision {
  const { mode, status, requested, openCount } = p;
  if (mode === 'live' && !p.liveGate?.ready) {
    // Un compte réel ne démarre jamais sans portefeuille, secret de chiffrement et test réel réussi (refus explicite, jamais en silence).
    const why = p.liveGate?.reason ?? 'compte réel non prêt';
    if (status === 'stopped') {
      if (requested !== 'stopped') return { next: 'stopped', resetRequested: 'stopped', level: 'warning', event: `Démarrage refusé : ${why}. Le bot reste arrêté.` };
      return { next: 'stopped' };
    }
    // Déjà actif mais devenu inutilisable : on ne peut plus signer, donc on suspend (les positions sont conservées, rien n’est perdu).
    if (requested === 'stopped' && openCount === 0) return { next: 'stopped', event: 'Bot arrêté.' };
    if (status === 'running') return { next: 'paused', level: 'warning', event: `Bot mis en pause automatiquement : ${why}.` };
    return { next: status };
  }
  if (requested === 'running') {
    if (status === 'running') return { next: 'running' };
    if (status === 'paused') return { next: 'running', event: 'Bot repris.' };
    if (status === 'closing') return { next: 'running', event: 'Arrêt annulé : le trading reprend (positions restantes conservées).' };
    return { next: 'running', event: 'Bot démarré.' };
  }
  if (requested === 'paused') {
    if (status === 'running') return { next: 'paused', event: 'Bot en pause : aucune nouvelle entrée ; stop loss, take profit et trailing restent actifs.' };
    if (status === 'paused') return { next: 'paused' };
    if (status === 'closing') return { next: 'closing', resetRequested: 'stopped' };
    return { next: 'stopped', resetRequested: 'stopped', event: 'Pause ignorée : le bot est arrêté.' };
  }
  // requested === 'stopped'
  if (status === 'stopped') return { next: 'stopped' };
  if (openCount > 0) {
    return { next: 'closing', event: status === 'closing' ? undefined : `Arrêt demandé : fermeture de ${openCount} position(s) ouverte(s).` };
  }
  return { next: 'stopped', event: 'Bot arrêté.' };
}

// ───────────────────────── Ventes réelles : espacement et abandon ─────────────────────────

export const SELL_ABANDON_AFTER = 8; // échecs de vente en 3 h au-delà desquels la position est déclarée invendable

/** Après chaque vente échouée : attente 30 s, 1 min, 2 min, 4 min puis 5 min ; au 8e échec la position est abandonnée (jamais de boucle infinie). */
export function sellGate(failedAtMs: number[], nowMs: number): { action: 'try' | 'wait' | 'abandon'; n: number; waitMs: number } {
  const recent = failedAtMs.filter((t) => nowMs - t < 3 * 3600_000).sort((a, b) => b - a);
  const n = recent.length;
  if (n >= SELL_ABANDON_AFTER) return { action: 'abandon', n, waitMs: 0 };
  if (n === 0) return { action: 'try', n, waitMs: 0 };
  const left = recent[0] + Math.min(30_000 * 2 ** (n - 1), 300_000) - nowMs;
  return left > 0 ? { action: 'wait', n, waitMs: left } : { action: 'try', n, waitMs: 0 };
}

// ───────────────────────── Agents ─────────────────────────

export type AgentStatus = 'RUNNING' | 'IDLE' | 'ERROR' | 'WARNING';
export type AgentUpdate = { agent: string; status?: AgentStatus; n?: number; err?: string | null };
const RANK: Record<AgentStatus, number> = { IDLE: 0, RUNNING: 1, WARNING: 2, ERROR: 3 };

export function mergeAgentUpdates(list: AgentUpdate[]): AgentUpdate[] {
  const m = new Map<string, AgentUpdate>();
  for (const u of list) {
    const cur = m.get(u.agent);
    if (!cur) { m.set(u.agent, { ...u }); continue; }
    if (u.status && (!cur.status || RANK[u.status] > RANK[cur.status])) cur.status = u.status;
    cur.n = (cur.n ?? 0) + (u.n ?? 0);
    if (typeof u.err === 'string') cur.err = u.err;
    else if (u.err === null && typeof cur.err !== 'string') cur.err = null;
  }
  return [...m.values()];
}
