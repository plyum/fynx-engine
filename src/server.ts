// FYNX — serveur du moteur (Render). Même moteur que la fonction Supabase `tick`, mais en boucle continue.
// Variables d'environnement : SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (obligatoires) ; WALLET_ENCRYPTION_KEY (comptes réels) ;
// SOLANA_RPC_URL, JUPITER_API_KEY (facultatives) ; ANTHROPIC_API_KEY (équipe IA, facultative ; réglages AI_VETO, AI_MIN_CONFIDENCE,
// AI_MONTHLY_BUDGET_USD, AI_MODEL, AI_TEAM, AI_SELL_MIN_CONFIDENCE, AI_SELL_REVIEW_MIN, AI_SELL_BUDGET_SHARE, AI_MAX_PER_SCAN) ;
// PORT (fourni par Render). Aucun secret n'est jamais journalisé.
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { flush, runTick, type Ctx } from './engine/index.ts';
import { runScalp } from './engine/scalp.ts';
import { makeRpc } from './engine/solana.ts';
import { makeJupiter } from './engine/jupiter.ts';
import { fetchUsdPrice } from './engine/live.ts';
import { LIVE_DEADLINE_MS } from './engine/livecycle.ts';
import { aiConfigFromEnv, createAiGate } from './engine/ai.ts';
import { createCandleSource, createTeam, teamConfigFromEnv } from './engine/aiteam.ts';
import { newState, runService, type Lock } from './service.ts';

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

const url = process.env['SUPABASE_URL'];
const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];
if (!url || !key) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont obligatoires : le moteur ne démarre pas.');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
if (!process.env['WALLET_ENCRYPTION_KEY']) log('WALLET_ENCRYPTION_KEY absent : les comptes réels resteront en pause (les comptes papier fonctionnent).');

// Agent IA : une seule instance pour tout le processus (son cache et son compteur de budget doivent survivre d'un tour à l'autre).
const aiCfg = aiConfigFromEnv({
  ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'], AI_MODEL: process.env['AI_MODEL'], ANTHROPIC_VERSION: process.env['ANTHROPIC_VERSION'],
  AI_VETO: process.env['AI_VETO'], AI_MIN_CONFIDENCE: process.env['AI_MIN_CONFIDENCE'], AI_MONTHLY_BUDGET_USD: process.env['AI_MONTHLY_BUDGET_USD'],
  AI_PRICE_IN_PER_MTOK: process.env['AI_PRICE_IN_PER_MTOK'], AI_PRICE_OUT_PER_MTOK: process.env['AI_PRICE_OUT_PER_MTOK'],
});
const aiGate = aiCfg ? createAiGate(sb, aiCfg, { fetch: (u, i) => fetch(u, i) }) : null;
// Équipe IA (Graphique, Marché, contrôleurs d'achat et de vente) : même socle que l'Analyste Contrat (budget et coupe-circuit communs).
const teamCfg = teamConfigFromEnv({
  AI_TEAM: process.env['AI_TEAM'], AI_SELL_MIN_CONFIDENCE: process.env['AI_SELL_MIN_CONFIDENCE'], AI_SELL_REVIEW_MIN: process.env['AI_SELL_REVIEW_MIN'],
  AI_SELL_BUDGET_SHARE: process.env['AI_SELL_BUDGET_SHARE'], AI_MAX_PER_SCAN: process.env['AI_MAX_PER_SCAN'],
});
const aiTeam = aiGate && teamCfg.enabled ? createTeam(aiGate.core, teamCfg, createCandleSource((u, i) => fetch(u, i), Date.now, { minGapMs: 2_500 })) : null;
log(aiCfg
  ? `Agent IA actif : ${aiCfg.model}, veto ${aiCfg.veto ? `actif (confiance ≥ ${aiCfg.minConfidence} %)` : 'coupé (avis seulement)'}, budget ${aiCfg.monthlyBudgetUsd} $/mois. `
    + (aiTeam ? `Équipe IA active : 3 analystes + 2 contrôleurs (vente papier si confiance ≥ ${teamCfg.sellMinConfidence} %).` : 'Équipe IA coupée (AI_TEAM=off) : Analyste Contrat seul.')
  : 'Agent IA inactif (ANTHROPIC_API_KEY absent) : les règles décident seules.');

// Propriétaire du verrou : unique pour cette copie du serveur (jamais « edge », réservé à la fonction Supabase de secours).
const owner = `render-${hostname()}-${process.pid}-${Date.now().toString(36)}`;
const lock: Lock = {
  async acquire(ttlSec) {
    const { data, error } = await sb.rpc('acquire_engine_lock', { p_owner: owner, p_seconds: ttlSec });
    if (error) throw new Error(error.message);
    return data === true;
  },
  async release() {
    const { error } = await sb.rpc('release_engine_lock', { p_owner: owner });
    if (error) throw new Error(error.message);
  },
};

const makeCtx = (start: number): Ctx => ({
  sb, health: {}, events: [], agents: new Map(), pairsAt: Date.now(), symbols: new Map(),
  env: {
    secret: process.env['WALLET_ENCRYPTION_KEY'] ?? '',
    rpcUrl: process.env['SOLANA_RPC_URL'] || 'https://api.mainnet-beta.solana.com',
    jupKey: process.env['JUPITER_API_KEY'] || undefined,
  },
  deadline: start + LIVE_DEADLINE_MS, live: new Map(), ai: aiGate, team: aiTeam,
  deps: { makeRpc: (u) => makeRpc(u), makeJup: (k) => makeJupiter({ apiKey: k }), fetchPrice: (m) => fetchUsdPrice(m) },
});

const stop = new AbortController();
const sleep = (ms: number) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  stop.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

const startedAt = Date.now();
const state = newState(startedAt);

// Vérification de santé de Render : 200 tant que la boucle tourne (même en attente), 503 si elle est bloquée depuis 3 min.
const HEALTH_STALE_MS = 180_000;
const server = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    const idleMs = Date.now() - state.lastBeatAt;
    const ok = idleMs < HEALTH_STALE_MS;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok, mode: state.mode, iterations: state.iterations, errors: state.errors, uptime_s: Math.round((Date.now() - startedAt) / 1000),
      last_tick_at: state.lastTickAt ? new Date(state.lastTickAt).toISOString() : null,
      last_full_at: state.lastFullAt ? new Date(state.lastFullAt).toISOString() : null,
      last_error: state.lastError, idle_s: Math.round(idleMs / 1000),
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"ok":false}');
});
server.listen(Number(process.env['PORT'] ?? 10000), '0.0.0.0', () => log(`serveur de santé sur le port ${(server.address() as { port: number }).port}`));

// Un tour rapide (prix des positions, stop loss / take profit) toutes les 2 s pour le scalping ; réglable par TICK_GAP_MS (1 à 10 s).
const gapEnv = Number(process.env['TICK_GAP_MS']);
const gapMs = Number.isFinite(gapEnv) && gapEnv >= 1_000 && gapEnv <= 10_000 ? gapEnv : 2_000;
log(`tour rapide toutes les ${gapMs / 1000} s`);

// Un tour = le bot normal, puis le mode Scalping (même verrou, même session de portefeuille, mêmes événements). Une erreur du
// scalping ne casse jamais le tour normal.
async function tickAll(ctx: Ctx, opts: { full: boolean }) {
  const r = await runTick(ctx, opts);
  try { await runScalp(ctx); } catch (e) { log(`scalping : ${String((e as Error)?.message ?? e).slice(0, 200)}`); }
  return r;
}
const done = runService<Ctx>({
  now: Date.now, sleep, makeCtx, tick: (ctx, opts) => tickAll(ctx, opts), flush, lock, state, shouldStop: () => stop.signal.aborted, log, gapMs,
});

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log(`${signal} reçu : arrêt propre (le tour en cours se termine, puis le verrou est rendu)`);
  stop.abort();
  const timer = setTimeout(() => { log('arrêt forcé après 25 s'); process.exit(0); }, 25_000);
  await done.catch(() => {});
  clearTimeout(timer);
  server.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log(`promesse rejetée non gérée : ${String((e as Error)?.message ?? e).slice(0, 300)}`));

done.then(() => log('boucle terminée')).catch((e) => { log(`boucle arrêtée sur erreur : ${String((e as Error)?.message ?? e)}`); process.exit(1); });
