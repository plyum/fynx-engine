// Test de fumée du vrai point d'entrée (server.ts) avec un faux Supabase : démarrage, verrou, santé HTTP, arrêt propre.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';

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

// Régression constatée sur Render : avec « npm start », SIGTERM tue npm mais pas node (processus orphelin) → le verrou n'est jamais
// rendu et la surveillance s'arrête ~2 min à chaque mise à jour. On exécute donc la VRAIE commande de démarrage de render.yaml.
test('render.yaml : la commande de démarrage transmet SIGTERM à node (verrou rendu, arrêt propre)', async () => {
  const yml = readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');
  const m = yml.match(/^\s*startCommand:\s*(.+?)\s*$/m);
  assert.ok(m, 'startCommand introuvable dans render.yaml');
  const port = await free();
  const p = spawn('sh', ['-c', m[1]!], {
    cwd: new URL('..', import.meta.url).pathname, detached: true,
    env: { PATH: process.env.PATH, PORT: String(port), SUPABASE_URL: 'http://fake', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40), NODE_OPTIONS: `--import ${hook}` },
  });
  let out = '';
  p.stdout!.on('data', (d) => (out += d));
  p.stderr!.on('data', (d) => (out += d));
  const exited = new Promise<void>((r) => p.on('exit', () => r()));
  try {
    for (let i = 0; i < 40 && !/verrou obtenu/.test(out); i++) await wait(100);
    assert.match(out, /verrou obtenu/, `le serveur n'a pas démarré avec « ${m[1]} ». Sortie :\n${out}`);
    p.kill('SIGTERM'); // comme Render : le signal n'est envoyé qu'au processus de la commande de démarrage
    await exited;
    for (let i = 0; i < 40 && !/verrou rendu/.test(out); i++) await wait(100);
    assert.match(out, /verrou rendu/, `SIGTERM n'a pas atteint node avec « ${m[1]} » (verrou jamais rendu). Sortie :\n${out}`);
  } finally {
    try { process.kill(-p.pid!, 'SIGKILL'); } catch { /* déjà terminé */ }
  }
});

async function bootAndRead(extra: Record<string, string>): Promise<string> {
  const port = await free();
  const p = spawn('node', ['--import', hook, entry], {
    env: { PATH: process.env.PATH, PORT: String(port), SUPABASE_URL: 'http://fake', SUPABASE_SERVICE_ROLE_KEY: 'x'.repeat(40), ...extra },
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const exit = new Promise<number | null>((r) => p.on('exit', r));
  for (let i = 0; i < 40 && !/serveur de santé/.test(out); i++) await wait(100);
  p.kill('SIGTERM');
  assert.equal(await exit, 0, out);
  return out;
}

test('agent IA : sans clé Anthropic → inactif, journalisé, le moteur démarre normalement', async () => {
  const out = await bootAndRead({});
  assert.match(out, /Agent IA inactif \(ANTHROPIC_API_KEY absent\)/);
});

test('agent IA : avec clé → actif (modèle, veto, budget par défaut) ; la clé n’apparaît jamais dans les journaux', async () => {
  const KEY = 'sk-ant-api03-SECRETSECRETSECRET';
  const out = await bootAndRead({ ANTHROPIC_API_KEY: KEY });
  assert.match(out, /Agent IA actif : claude-haiku-5-5, veto actif \(confiance ≥ 60 %\), budget 8 \$\/mois\./);
  assert.doesNotMatch(out, /SECRETSECRET/);
});

test('agent IA : réglages par variables (veto coupé, budget, seuil) pris en compte', async () => {
  const out = await bootAndRead({ ANTHROPIC_API_KEY: 'sk-ant-x', AI_VETO: 'off', AI_MONTHLY_BUDGET_USD: '4', AI_MODEL: 'claude-haiku-5-5' });
  assert.match(out, /Agent IA actif : claude-haiku-5-5, veto coupé \(avis seulement\), budget 4 \$\/mois\./);
  const out2 = await bootAndRead({ ANTHROPIC_API_KEY: 'sk-ant-x', AI_MIN_CONFIDENCE: '80' });
  assert.match(out2, /veto actif \(confiance ≥ 80 %\)/);
});
