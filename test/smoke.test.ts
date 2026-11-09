// Test de fumée du vrai point d'entrée (server.ts) avec un faux Supabase : démarrage, verrou, santé HTTP, arrêt propre.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const free = () => new Promise<number>((res) => { const s = createServer().listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const entry = new URL('../src/server.ts', import.meta.url).pathname;
const hook = new URL('./fake-register.mjs', import.meta.url).pathname;

test('sans clés Supabase : le serveur refuse de démarrer avec un message clair', async () => {
  const p = spawn('node', ['--import', hook, entry], { env: { PATH: process.env.PATH, PORT: String(await free()) } });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  const code = await new Promise<number | null>((r) => p.on('exit', r));
  assert.equal(code, 1);
  assert.match(err, /SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont obligatoires/);
});

test('démarrage, verrou pris, santé 200, arrêt propre (SIGTERM) avec verrou rendu', async () => {
  const port = await free();
  const p = spawn('node', ['--import', hook, entry], {
    env: { PATH: process.env.PATH, PORT: String(port), SUPABASE_URL: 'http://fake', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40) },
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  let health: { ok: boolean; mode: string; iterations: number } | null = null;
  for (let i = 0; i < 40; i++) {
    await wait(250);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      const j = await r.json() as { ok: boolean; mode: string; iterations: number };
      if (r.status === 200 && j.mode === 'active' && j.iterations >= 1) { health = j; break; }
    } catch { /* pas encore prêt */ }
  }
  assert.ok(health, `santé jamais active. Sortie :\n${out}`);
  assert.equal((await fetch(`http://127.0.0.1:${port}/inconnu`)).status, 404);
  assert.match(out, /RPC acquire_engine_lock \{"p_owner":"render-[^"]+","p_seconds":120\}/);
  assert.doesNotMatch(out, /"p_owner":"edge"/);
  const exit = new Promise<number | null>((r) => p.on('exit', r));
  p.kill('SIGTERM');
  assert.equal(await exit, 0);
  assert.match(out, /RPC release_engine_lock/);
  assert.match(out, /verrou rendu/);
});
