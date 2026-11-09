// Tests de la boucle continue (service.ts) avec une horloge simulée : cadence, tours complets, verrou, échecs, arrêt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, newState, runService, type EvCtx, type Lock } from '../src/service.ts';

type Ctx = EvCtx & { start: number };

function harness(over: {
  tickCostMs?: number;
  tick?: (ctx: Ctx, opts: { full: boolean }, now: () => number) => Promise<unknown>;
  acquire?: (n: number, ttl: number) => Promise<boolean>;
  flush?: (ctx: Ctx) => Promise<void>;
  stopAfterMs?: number;
  tickTimeoutMs?: number;
} = {}) {
  let clock = 1_000_000;
  const t0 = clock;
  const now = () => clock;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); clock += ms; };
  const ticks: { at: number; full: boolean }[] = [];
  const flushed: Ctx[] = [];
  const events: string[] = [];
  const log: string[] = [];
  let acquireCalls = 0, released = 0;
  const ttls: number[] = [];
  const lock: Lock = {
    async acquire(ttl) { ttls.push(ttl); return (over.acquire ?? (async () => true))(++acquireCalls, ttl); },
    async release() { released++; },
  };
  const state = newState(clock);
  const stopAt = t0 + (over.stopAfterMs ?? 70_000);
  const deps = {
    now, sleep, state, lock, log: (m: string) => log.push(m),
    makeCtx: (start: number): Ctx => ({ events: [], start }),
    tick: async (ctx: Ctx, opts: { full: boolean }) => {
      ticks.push({ at: clock - t0, full: opts.full });
      if (over.tick) return over.tick(ctx, opts, now);
      clock += over.tickCostMs ?? 800;
    },
    flush: async (ctx: Ctx) => { flushed.push(ctx); for (const e of ctx.events) events.push(e.message); if (over.flush) await over.flush(ctx); },
    shouldStop: () => clock >= stopAt,
    tickTimeoutMs: over.tickTimeoutMs,
  };
  return { run: () => runService<Ctx>(deps), state, ticks, sleeps, flushed, events, log, ttls, get released() { return released; }, get acquireCalls() { return acquireCalls; }, t0, now };
}

test('cadence : un tour toutes les 5 s, un tour complet toutes les 30 s', async () => {
  const h = harness({ stopAfterMs: 61_000 });
  await h.run();
  const starts = h.ticks.map((t) => t.at);
  // chaque tour dure 0,8 s puis on attend jusqu'à 5 s après son début
  assert.deepEqual(starts.slice(0, 4), [0, 5000, 10000, 15000]);
  assert.ok(starts.every((s, i) => i === 0 || s - starts[i - 1] === 5000), `écarts réguliers de 5 s : ${starts.join(',')}`);
  assert.deepEqual(h.ticks.filter((t) => t.full).map((t) => t.at), [0, 30000, 60000]);
  assert.equal(h.ticks.filter((t) => !t.full).length, h.ticks.length - 3);
  assert.equal(h.state.mode, 'stopping');
  assert.equal(h.state.errors, 0);
});

test('un tour lent décale les suivants sans rafale', async () => {
  const h = harness({ tickCostMs: 7_000, stopAfterMs: 30_000 });
  await h.run();
  const starts = h.ticks.map((t) => t.at);
  assert.deepEqual(starts.slice(0, 3), [0, 7000, 14000]); // pas d'attente : le tour a déjà pris plus de 5 s
  assert.ok(h.sleeps.every((s) => s > 0), 'aucune attente nulle ou négative');
});

test('le verrou est renouvelé à chaque tour pour une durée supérieure au délai maximum d\'un tour', async () => {
  const h = harness({ stopAfterMs: 21_000 });
  await h.run();
  assert.equal(h.acquireCalls, h.ticks.length);
  assert.ok(h.ttls.every((t) => t === DEFAULTS.lockTtlSec));
  assert.ok(DEFAULTS.lockTtlSec * 1000 > DEFAULTS.tickTimeoutMs, 'le verrou survit à un tour abandonné');
  assert.ok(DEFAULTS.tickTimeoutMs > 95_000, 'laisse la place à la date limite des ordres réels (95 s)');
});

test('verrou détenu par un autre : aucun tour, attente, puis tour complet dès que le verrou est libre', async () => {
  const h = harness({ acquire: async (n) => n > 4, stopAfterMs: 40_000 });
  await h.run();
  assert.equal(h.state.iterations > 0, true);
  assert.equal(h.ticks[0].full, true, 'le premier tour après la prise du verrou est complet');
  assert.equal(h.ticks[0].at, 4 * DEFAULTS.standbyMs, 'quatre refus de 5 s avant de commencer');
  assert.ok(h.log.some((l) => l.includes('verrou obtenu')));
});

test('verrou perdu en cours de route : le moteur se met en attente puis reprend avec un tour complet', async () => {
  const h = harness({ acquire: async (n) => !(n >= 4 && n <= 6), stopAfterMs: 60_000 });
  await h.run();
  assert.ok(h.log.some((l) => l.includes('verrou perdu')));
  const afterLoss = h.ticks.filter((t) => t.at > 3 * 5000);
  assert.equal(afterLoss[0].full, true);
});

test('erreur d\'accès au verrou : traitée comme « attente », message conservé, la boucle continue', async () => {
  const h = harness({ acquire: async (n) => { if (n <= 2) throw new Error('réseau coupé'); return true; }, stopAfterMs: 30_000 });
  await h.run();
  assert.ok(h.ticks.length > 0);
  assert.equal(h.ticks[0].at, 2 * DEFAULTS.standbyMs);
  assert.equal(h.state.mode, 'stopping');
});

test('échec d\'un tour : compté, journalisé une seule fois par minute, la boucle ralentit puis reprend', async () => {
  let fail = true;
  const h = harness({
    stopAfterMs: 130_000,
    tick: async (_ctx, _o, now) => { if (fail && now() - 1_000_000 < 60_000) throw new Error('Supabase indisponible'); },
  });
  await h.run();
  assert.ok(h.state.errors >= 3);
  const logged = h.events.filter((m) => m.includes('Supabase indisponible'));
  assert.ok(logged.length >= 1 && logged.length <= 2, `journalisé ${logged.length} fois en 60 s`);
  // ralentissement : les attentes augmentent (5, 10, 15 s…) tant que l'échec dure
  assert.ok(h.sleeps.slice(0, 3).every((s, i, a) => i === 0 || s > a[i - 1]), `attentes croissantes : ${h.sleeps.slice(0, 4).join(',')}`);
  assert.ok(h.sleeps.every((s) => s <= 30_000), 'attente plafonnée à 30 s');
  fail = false;
  assert.equal(h.state.lastError, null, 'l\'erreur est effacée après la reprise');
  assert.ok(h.state.iterations > 0);
});

test('un tour qui ne répond jamais est abandonné (délai) et la boucle continue', async () => {
  let n = 0;
  const h = harness({ stopAfterMs: 20_000, tickTimeoutMs: 25, tick: async () => { if (++n === 1) await new Promise(() => {}); } });
  await h.run();
  assert.ok(h.state.errors >= 1);
  assert.ok(h.events.some((m) => m.includes('abandonné')));
  assert.ok(h.state.iterations >= 1, 'les tours suivants s\'exécutent');
});

test('échec du journal (flush) : la boucle continue', async () => {
  const h = harness({ stopAfterMs: 20_000, flush: async () => { throw new Error('events indisponible'); } });
  await h.run();
  assert.ok(h.ticks.length >= 3);
  assert.ok(h.log.some((l) => l.includes('journal non enregistré')));
});

test('arrêt demandé : le verrou est rendu une seule fois', async () => {
  const h = harness({ stopAfterMs: 12_000 });
  await h.run();
  assert.equal(h.released, 1);
  assert.equal(h.state.mode, 'stopping');
});

test('arrêt demandé sans avoir jamais eu le verrou : rien à rendre', async () => {
  const h = harness({ acquire: async () => false, stopAfterMs: 12_000 });
  await h.run();
  assert.equal(h.released, 0);
  assert.equal(h.ticks.length, 0);
  assert.equal(h.state.mode, 'stopping');
});

test('battement de santé : mis à jour même en attente', async () => {
  const h = harness({ acquire: async () => false, stopAfterMs: 12_000 });
  const before = h.state.lastBeatAt;
  await h.run();
  assert.ok(h.state.lastBeatAt > before);
});
