// Test d'intégration du vrai point d'entrée (server.ts) avec le VRAI client @supabase/supabase-js, face à un faux serveur d'API local :
// les requêtes HTTP sont réelles (verrou, tour du moteur, santé, arrêt propre). Ignoré si `npm install` n'a pas été fait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttp } from 'node:http';
import { createServer as createNet } from 'node:net';
import { existsSync } from 'node:fs';

const entry = new URL('../src/server.ts', import.meta.url).pathname;
const installed = existsSync(new URL('../node_modules/@supabase/supabase-js/package.json', import.meta.url));
const skip = installed ? false : 'dépendances non installées (npm install)';
const KEY = 'k'.repeat(40);

type Call = { method: string; path: string; body: string; headers: Record<string, string | string[] | undefined> };

const free = () => new Promise<number>((res) => { const s = createNet().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Faux serveur d'API (PostgREST) : base vide ; `lock` = la réponse à acquire_engine_lock. */
async function fakeApi(lock: { status: number; body: unknown }) {
  const calls: Call[] = [];
  const server = createHttp((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://fake').pathname;
      calls.push({ method: req.method ?? '', path, body, headers: req.headers });
      const send = (status: number, payload?: unknown) => {
        res.writeHead(status, payload === undefined ? {} : { 'content-type': 'application/json' });
        res.end(payload === undefined ? undefined : JSON.stringify(payload));
      };
      if (path === '/rest/v1/rpc/acquire_engine_lock') return send(lock.status, lock.body);
      if (path === '/rest/v1/rpc/release_engine_lock') return send(204);
      if (path.startsWith('/rest/v1/')) return req.method === 'GET' ? send(200, []) : send(201);
      send(404, { message: 'inconnu' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { calls, url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function start(supabaseUrl: string) {
  const port = await free();
  const p = spawn('node', [entry], { env: { PATH: process.env.PATH, PORT: String(port), SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: KEY } });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => p.on('exit', (code) => r(code)));
  const running = () => p.exitCode === null && p.signalCode === null;
  const until = async (ok: (j: Record<string, unknown>) => boolean) => {
    for (let i = 0; i < 60 && running(); i++) {
      await wait(250);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        const j = (await r.json()) as Record<string, unknown>;
        if (ok(j)) return { status: r.status, j };
      } catch { /* pas encore prêt */ }
    }
    return null;
  };
  // Si le serveur s'est déjà arrêté (démarrage en échec), on ne l'attend pas : le code de sortie fait échouer le test avec un message clair.
  const stop = async () => { if (running()) p.kill('SIGTERM'); return await exited; };
  return { until, stop, out: () => out };
}

test('vrai client Supabase : verrou pris, un tour complet du moteur, santé 200, arrêt propre avec verrou rendu', { skip }, async () => {
  const api = await fakeApi({ status: 200, body: true });
  const srv = await start(api.url);
  let code: number | null = null;
  try {
    const h = await srv.until((j) => j.mode === 'active' && Number(j.iterations) >= 1);
    assert.ok(h, `jamais actif. Sortie :\n${srv.out()}`);
    assert.equal(h.status, 200);
    assert.equal(h.j.errors, 0, `erreurs : ${String(h.j.last_error)}`);
    assert.equal(h.j.last_error, null);
  } finally {
    code = await srv.stop();
    await api.close();
  }
  assert.equal(code, 0, `arrêt propre. Sortie :\n${srv.out()}`);
  const acq = api.calls.find((c) => c.path === '/rest/v1/rpc/acquire_engine_lock');
  assert.ok(acq, 'verrou demandé');
  assert.equal(acq.method, 'POST');
  const args = JSON.parse(acq.body) as { p_owner: string; p_seconds: number };
  assert.match(args.p_owner, /^render-/);
  assert.equal(args.p_seconds, 120);
  assert.equal(acq.headers['apikey'], KEY);
  assert.equal(acq.headers['authorization'], `Bearer ${KEY}`);
  // un tour complet : lecture des comptes, des positions et des ordres en attente, puis battement de santé du moteur
  for (const t of ['accounts', 'positions', 'orders']) assert.ok(api.calls.some((c) => c.method === 'GET' && c.path === `/rest/v1/${t}`), `lecture de ${t}`);
  const beat = api.calls.find((c) => c.method === 'POST' && c.path === '/rest/v1/api_health');
  assert.ok(beat, 'battement api_health écrit');
  assert.match(beat.body, /"service":"engine_tick"/);
  assert.match(String(beat.headers['prefer']), /resolution=merge-duplicates/);
  const rel = api.calls.find((c) => c.path === '/rest/v1/rpc/release_engine_lock');
  assert.ok(rel, 'verrou rendu à l’arrêt');
  assert.equal((JSON.parse(rel.body) as { p_owner: string }).p_owner, args.p_owner, 'rendu par le même propriétaire');
});

test('vrai client Supabase : verrou détenu par un autre propriétaire → attente, aucune lecture de la base, rien à rendre', { skip }, async () => {
  const api = await fakeApi({ status: 200, body: false });
  const srv = await start(api.url);
  let code: number | null = null;
  try {
    const h = await srv.until((j) => j.mode === 'standby');
    assert.ok(h, `jamais en attente. Sortie :\n${srv.out()}`);
    assert.equal(h.status, 200, 'en attente, le serveur reste en bonne santé pour Render');
    await wait(500);
  } finally {
    code = await srv.stop();
    await api.close();
  }
  assert.equal(code, 0);
  assert.ok(api.calls.some((c) => c.path === '/rest/v1/rpc/acquire_engine_lock'), 'verrou demandé');
  assert.equal(api.calls.filter((c) => c.path === '/rest/v1/accounts').length, 0, 'aucun tour du moteur sans le verrou');
  assert.equal(api.calls.some((c) => c.path === '/rest/v1/rpc/release_engine_lock'), false, 'le verrou n’a jamais été détenu : rien à rendre');
});

test('vrai client Supabase : base indisponible (HTTP 503) → le serveur reste en vie, attend et signale l’erreur', { skip }, async () => {
  const api = await fakeApi({ status: 503, body: { message: 'indisponible' } });
  const srv = await start(api.url);
  let code: number | null = null;
  try {
    const h = await srv.until((j) => j.mode === 'standby' && typeof j.last_error === 'string');
    assert.ok(h, `erreur jamais signalée. Sortie :\n${srv.out()}`);
    assert.match(String(h.j.last_error), /^verrou : indisponible/);
    assert.equal(h.status, 200);
  } finally {
    code = await srv.stop();
    await api.close();
  }
  assert.equal(code, 0);
  assert.equal(api.calls.filter((c) => c.path === '/rest/v1/accounts').length, 0, 'aucun tour du moteur sans le verrou');
});
