// FYNX — boucle continue du serveur : un tour toutes les 5 s, 24 h/24, tant que le serveur tient le verrou du moteur.
// Le verrou (Postgres) est renouvelé à chaque tour ; s'il est détenu par un autre (la fonction Supabase de secours, ou une autre
// copie du serveur), on attend sans rien exécuter : jamais deux moteurs en même temps. Sans état : tout est dans Postgres.

export type EvCtx = { events: { account_id: string | null; kind: string; agent: string | null; message: string; data?: unknown }[] };

export type Lock = {
  /** Prend ou renouvelle le verrou pour `ttlSec` secondes ; false si un autre propriétaire le détient. */
  acquire(ttlSec: number): Promise<boolean>;
  release(): Promise<void>;
};

export type ServiceState = {
  mode: 'starting' | 'active' | 'standby' | 'stopping';
  /** Tours réussis depuis le démarrage. */
  iterations: number;
  errors: number;
  /** Dernier passage dans la boucle (même en attente) : sert à la vérification de santé. */
  lastBeatAt: number;
  lastTickAt: number | null;
  lastFullAt: number | null;
  lastError: string | null;
};

export const newState = (now: number): ServiceState => ({
  mode: 'starting', iterations: 0, errors: 0, lastBeatAt: now, lastTickAt: null, lastFullAt: null, lastError: null,
});

export type ServiceDeps<C extends EvCtx> = {
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
  /** Contexte neuf pour un tour ; `start` = début du tour (la date limite des ordres réels en part). */
  makeCtx: (start: number) => C;
  tick: (ctx: C, opts: { full: boolean }) => Promise<unknown>;
  flush: (ctx: C) => Promise<void>;
  lock: Lock;
  state: ServiceState;
  shouldStop: () => boolean;
  log?: (message: string) => void;
  /** Écart entre deux tours (5 s). */
  gapMs?: number;
  /** Un tour complet (analyse, valorisation, courbe de capital) au plus toutes les `fullEveryMs` (30 s) ; les autres sont rapides. */
  fullEveryMs?: number;
  /** Durée du verrou : plus long qu'un tour (la date limite des ordres réels est de 95 s). */
  lockTtlSec?: number;
  /** Attente entre deux essais de verrou quand un autre le détient. */
  standbyMs?: number;
  /** Un tour qui dépasse cette durée est abandonné (< durée du verrou). */
  tickTimeoutMs?: number;
};

export const DEFAULTS = { gapMs: 5_000, fullEveryMs: 30_000, lockTtlSec: 120, standbyMs: 5_000, tickTimeoutMs: 100_000 } as const;
const ERROR_LOG_EVERY_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`tour abandonné après ${Math.round(ms / 1000)} s sans réponse`)), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(timer); }
}

export async function runService<C extends EvCtx>(d: ServiceDeps<C>): Promise<void> {
  const gap = d.gapMs ?? DEFAULTS.gapMs, fullEvery = d.fullEveryMs ?? DEFAULTS.fullEveryMs, ttl = d.lockTtlSec ?? DEFAULTS.lockTtlSec;
  const standby = d.standbyMs ?? DEFAULTS.standbyMs, tickTimeout = d.tickTimeoutMs ?? DEFAULTS.tickTimeoutMs;
  const st = d.state;
  let lastFull = -Infinity, lastErrLog = -Infinity, errStreak = 0, holding = false;

  while (!d.shouldStop()) {
    const start = d.now();
    st.lastBeatAt = start;

    let got = false;
    try { got = await d.lock.acquire(ttl); } catch (e) { st.lastError = `verrou : ${errText(e)}`; }
    if (!got) {
      if (holding) d.log?.('verrou perdu : le moteur se met en attente');
      holding = false;
      st.mode = 'standby';
      if (!d.shouldStop()) await d.sleep(standby);
      continue;
    }
    if (!holding) { holding = true; lastFull = -Infinity; d.log?.('verrou obtenu : le moteur est actif'); }
    st.mode = 'active';

    const full = start - lastFull >= fullEvery;
    if (full) lastFull = start; // même si le tour échoue : pas de rafale de tours complets
    const ctx = d.makeCtx(start);
    try {
      await withTimeout(d.tick(ctx, { full }), tickTimeout);
      st.iterations++; st.lastTickAt = d.now(); if (full) st.lastFullAt = start;
      st.lastError = null; errStreak = 0;
    } catch (e) {
      errStreak++; st.errors++; st.lastError = errText(e);
      d.log?.(`tour échoué : ${st.lastError}`);
      if (start - lastErrLog >= ERROR_LOG_EVERY_MS) {
        lastErrLog = start;
        ctx.events.push({ account_id: null, kind: 'error', agent: 'SYSTEM', message: `Tick échoué : ${st.lastError}` });
      }
    }
    try { await d.flush(ctx); } catch (e) { d.log?.(`journal non enregistré : ${errText(e)}`); }
    st.lastBeatAt = d.now();

    let wait = gap - (d.now() - start);
    if (errStreak > 0) wait = Math.max(wait, Math.min(gap * errStreak, MAX_BACKOFF_MS)); // l'échec se répète : on ralentit
    if (wait > 0 && !d.shouldStop()) await d.sleep(wait);
  }

  st.mode = 'stopping';
  if (holding) { try { await d.lock.release(); d.log?.('verrou rendu'); } catch (e) { d.log?.(`verrou non rendu : ${errText(e)}`); } }
}
