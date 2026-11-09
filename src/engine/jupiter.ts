// FYNX — client Jupiter Swap V1 (devis + construction de la transaction). Sans dépendance.
// Sans clé d'API : environ 1 requête toutes les 2 s ; avec JUPITER_API_KEY : plus rapide. Les 429 sont rejoués avec attente.

export type Quote = {
  inputMint: string; inAmount: string; outputMint: string; outAmount: string; otherAmountThreshold: string;
  slippageBps: number; priceImpactPct?: string; routePlan: unknown[]; [k: string]: unknown;
};
export type Built = { swapTransaction: string; lastValidBlockHeight: number; prioritizationFeeLamports?: number };
export type Level = 'high' | 'veryHigh';

export type JupiterOpts = { fetchFn?: typeof fetch; apiKey?: string; base?: string; minGapMs?: number; sleepFn?: (ms: number) => Promise<void> };

export class JupiterError extends Error {
  status?: number;
  constructor(message: string, status?: number) { super(message); this.status = status; }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let lastCallAt = 0; // partagé par toutes les requêtes de l'instance : respecte la cadence sans clé

export function makeJupiter(opts: JupiterOpts = {}) {
  const f = opts.fetchFn ?? fetch;
  const base = opts.base ?? 'https://api.jup.ag/swap/v1';
  const sleep = opts.sleepFn ?? defaultSleep;
  const gap = opts.minGapMs ?? (opts.apiKey ? 1_100 : 2_100);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.apiKey) headers['x-api-key'] = opts.apiKey;

  async function call<T>(path: string, init?: { method: string; body: string }): Promise<T> {
    let last: unknown = new JupiterError('Jupiter sans réponse');
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = lastCallAt + gap - Date.now();
      if (wait > 0) await sleep(wait);
      lastCallAt = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15_000);
      try {
        const r = await f(`${base}${path}`, {
          method: init?.method ?? 'GET', signal: ac.signal, body: init?.body,
          headers: init ? { ...headers, 'content-type': 'application/json' } : headers,
        });
        const text = await r.text();
        if (r.status === 429) { last = new JupiterError('Jupiter : trop de requêtes (429)', 429); await sleep(1_500 * (attempt + 1)); continue; }
        if (r.status >= 500) { last = new JupiterError(`Jupiter indisponible (HTTP ${r.status})`, r.status); await sleep(600); continue; }
        let j: Record<string, unknown> = {};
        try { j = JSON.parse(text); } catch { /* corps non JSON */ }
        if (!r.ok) {
          const msg = String(j.error ?? j.message ?? text).slice(0, 200);
          throw new JupiterError(`Jupiter : ${msg}`, r.status);
        }
        return j as T;
      } catch (e) {
        if (e instanceof JupiterError && e.status && e.status < 500 && e.status !== 429) throw e;
        last = e;
        await sleep(400);
      } finally {
        clearTimeout(timer);
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  return {
    async quote(p: { inputMint: string; outputMint: string; amount: bigint; slippageBps: number }): Promise<Quote> {
      if (p.amount <= 0n) throw new JupiterError('Montant nul');
      const qs = new URLSearchParams({
        inputMint: p.inputMint, outputMint: p.outputMint, amount: p.amount.toString(), slippageBps: String(Math.round(p.slippageBps)),
        restrictIntermediateTokens: 'true', swapMode: 'ExactIn',
      });
      const q = await call<Quote>(`/quote?${qs}`);
      if (!q || typeof q.outAmount !== 'string' || !Array.isArray(q.routePlan) || q.routePlan.length === 0) throw new JupiterError('Jupiter : aucune route');
      if (q.inputMint !== p.inputMint || q.outputMint !== p.outputMint || q.inAmount !== p.amount.toString()) throw new JupiterError('Jupiter : devis incohérent');
      return q;
    },
    async swap(quote: Quote, userPublicKey: string, prioMaxLamports: number, level: Level = 'high'): Promise<Built> {
      const body = JSON.stringify({
        quoteResponse: quote, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: Math.round(prioMaxLamports), priorityLevel: level } },
      });
      const r = await call<Built>('/swap', { method: 'POST', body });
      if (!r || typeof r.swapTransaction !== 'string' || !(Number(r.lastValidBlockHeight) > 0)) throw new JupiterError('Jupiter : transaction invalide');
      return { swapTransaction: r.swapTransaction, lastValidBlockHeight: Number(r.lastValidBlockHeight), prioritizationFeeLamports: r.prioritizationFeeLamports };
    },
  };
}
export type Jupiter = ReturnType<typeof makeJupiter>;
