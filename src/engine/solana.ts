// FYNX — Solana minimal : clés, chiffrement, signature, transactions, client RPC.
// Aucune dépendance, aucun accès à Deno : le même fichier tourne sous Deno (Supabase) et Node (tests).
// Une copie identique est déployée dans les fonctions `tick` et `wallet` (voir functions/sync.sh).

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const LAMPORTS_PER_SOL = 1_000_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── base58 / base64 / shortvec ─────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map<string, number>([...B58].map((c, i) => [c, i]));

export function b58encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58[d]).join('');
}

export function b58decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    const v = B58_MAP.get(s[i]);
    if (v === undefined) throw new Error('base58 invalide');
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

export function isPubkey(s: unknown): s is string {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return false;
  try { return b58decode(s).length === 32; } catch { return false; }
}

export function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function readShortVec(b: Uint8Array, off: number): [number, number] {
  let len = 0, size = 0;
  for (;;) {
    const byte = b[off + size];
    if (byte === undefined) throw new Error('transaction tronquée');
    len |= (byte & 0x7f) << (size * 7);
    size++;
    if ((byte & 0x80) === 0) break;
    if (size > 2) throw new Error('longueur invalide');
  }
  return [len, off + size];
}
export function shortVec(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const e = v & 0x7f;
    v >>= 7;
    if (v === 0) { out.push(e); break; }
    out.push(e | 0x80);
  }
  return out;
}

// ───────────────────────── Clés Ed25519 ─────────────────────────

const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const ED = { name: 'Ed25519' } as const;

export type Signer = { pubkey: string; sign(msg: Uint8Array): Promise<Uint8Array> };

/** Génère un nouveau portefeuille : la graine (32 octets) ne doit jamais quitter le serveur. */
export async function generateWallet(): Promise<{ pubkey: string; seed: Uint8Array }> {
  const kp = (await crypto.subtle.generateKey(ED, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pk8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  if (pk8.length !== 48) throw new Error('format de clé inattendu');
  return { pubkey: b58encode(raw), seed: pk8.slice(16) };
}

/** Recharge un signataire et prouve que la graine correspond bien à l'adresse publique attendue. */
export async function signerFromSeed(seed: Uint8Array, expectedPubkey: string): Promise<Signer> {
  if (seed.length !== 32) throw new Error('graine invalide');
  const pubBytes = b58decode(expectedPubkey);
  if (pubBytes.length !== 32) throw new Error('adresse publique invalide');
  const pk8 = new Uint8Array(48);
  pk8.set(PKCS8_PREFIX);
  pk8.set(seed, 16);
  const priv = await crypto.subtle.importKey('pkcs8', pk8, ED, false, ['sign']);
  const pub = await crypto.subtle.importKey('raw', pubBytes, ED, false, ['verify']);
  const probe = new TextEncoder().encode('fynx-key-check');
  const sig = new Uint8Array(await crypto.subtle.sign(ED, priv, probe));
  if (!(await crypto.subtle.verify(ED, pub, sig, probe))) throw new Error('la clé du portefeuille ne correspond pas à son adresse');
  return { pubkey: expectedPubkey, sign: async (m) => new Uint8Array(await crypto.subtle.sign(ED, priv, m)) };
}

// ───────────────────────── Chiffrement de la graine (AES-GCM, clé issue d'un secret saisi par l'utilisateur) ─────────────────────────

const keyCache = new Map<string, CryptoKey>();
async function aesKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(passphrase)));
  const id = `${toB64(salt)}:${toB64(digest)}`; // empreinte complète : deux secrets différents ne partagent jamais une clé en cache
  const hit = keyCache.get(id);
  if (hit) return hit;
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 120_000 }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  keyCache.set(id, key);
  return key;
}
export const MIN_PASSPHRASE = 32;

/** `aad` lie le chiffré à l'adresse du portefeuille : impossible de l'échanger avec un autre compte. */
export async function encryptSeed(seed: Uint8Array, passphrase: string, aad: string): Promise<string> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error('secret de chiffrement trop court');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(passphrase, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) }, key, seed));
  return `v1.${toB64(salt)}.${toB64(iv)}.${toB64(ct)}`;
}
export async function decryptSeed(blob: string, passphrase: string, aad: string): Promise<Uint8Array> {
  const [v, s, i, c] = String(blob).split('.');
  if (v !== 'v1' || !s || !i || !c) throw new Error('format de clé chiffrée inconnu');
  const key = await aesKey(passphrase, fromB64(s));
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(i), additionalData: new TextEncoder().encode(aad) }, key, fromB64(c)));
  } catch {
    throw new Error('déchiffrement impossible : le secret de chiffrement a changé ou la donnée est altérée');
  }
}

// ───────────────────────── Transactions ─────────────────────────

export type ParsedTx = { sigCount: number; sigOffset: number; msgOffset: number; version: 'legacy' | number; numRequiredSignatures: number; feePayer: string };

export function parseTx(bytes: Uint8Array): ParsedTx {
  const [sigCount, sigOffset] = readShortVec(bytes, 0);
  const msgOffset = sigOffset + 64 * sigCount;
  if (msgOffset >= bytes.length) throw new Error('transaction tronquée');
  let p = msgOffset;
  let version: 'legacy' | number = 'legacy';
  if (bytes[p] & 0x80) {
    version = bytes[p] & 0x7f;
    if (version !== 0) throw new Error(`version de transaction ${version} non prise en charge`);
    p++;
  }
  const numRequiredSignatures = bytes[p];
  const [nKeys, keysOff] = readShortVec(bytes, p + 3);
  if (nKeys < 1 || keysOff + 32 > bytes.length) throw new Error('transaction invalide');
  return { sigCount, sigOffset, msgOffset, version, numRequiredSignatures, feePayer: b58encode(bytes.slice(keysOff, keysOff + 32)) };
}

/** Signe une transaction reçue d'un tiers (Jupiter) : refuse tout ce qui n'est pas « payée et signée par ce seul portefeuille ». */
export async function signTransaction(txB64: string, signer: Signer): Promise<{ b64: string; signature: string }> {
  const bytes = fromB64(txB64);
  const t = parseTx(bytes);
  if (t.sigCount !== 1 || t.numRequiredSignatures !== 1) throw new Error('la transaction demande plusieurs signatures : refusée');
  if (t.feePayer !== signer.pubkey) throw new Error('le payeur de la transaction n’est pas ce portefeuille : refusée');
  const sig = await signer.sign(bytes.slice(t.msgOffset));
  bytes.set(sig, t.sigOffset);
  return { b64: toB64(bytes), signature: b58encode(sig) };
}

export type Meta = { pubkey: string; signer: boolean; writable: boolean };
export type Ix = { program: string; keys: Meta[]; data: Uint8Array };

/** Message « legacy » (sans table d'adresses) : suffisant pour un transfert et la fermeture d'un compte de jeton. */
export function compileLegacyMessage(payer: string, ixs: Ix[], recentBlockhash: string): Uint8Array {
  const flags = new Map<string, { signer: boolean; writable: boolean }>();
  const add = (k: string, signer: boolean, writable: boolean) => {
    const c = flags.get(k);
    if (c) { c.signer = c.signer || signer; c.writable = c.writable || writable; } else flags.set(k, { signer, writable });
  };
  add(payer, true, true);
  for (const ix of ixs) { for (const m of ix.keys) add(m.pubkey, m.signer, m.writable); add(ix.program, false, false); }
  const group = (s: boolean, w: boolean) => [...flags.entries()].filter(([k, v]) => k !== payer && v.signer === s && v.writable === w).map(([k]) => k);
  const sW = group(true, true), sR = group(true, false), nW = group(false, true), nR = group(false, false);
  const keys = [payer, ...sW, ...sR, ...nW, ...nR];
  const index = new Map(keys.map((k, i) => [k, i]));
  const out: number[] = [1 + sW.length + sR.length, sR.length, nR.length, ...shortVec(keys.length)];
  for (const k of keys) out.push(...b58decode(k));
  const bh = b58decode(recentBlockhash);
  if (bh.length !== 32) throw new Error('blockhash invalide');
  out.push(...bh, ...shortVec(ixs.length));
  for (const ix of ixs) {
    out.push(index.get(ix.program)!, ...shortVec(ix.keys.length), ...ix.keys.map((m) => index.get(m.pubkey)!), ...shortVec(ix.data.length), ...ix.data);
  }
  return Uint8Array.from(out);
}

export function ixTransfer(from: string, to: string, lamports: bigint): Ix {
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true);
  dv.setBigUint64(4, lamports, true);
  return { program: SYSTEM_PROGRAM, keys: [{ pubkey: from, signer: true, writable: true }, { pubkey: to, signer: false, writable: true }], data };
}
/** Ferme un compte de jeton vide : récupère les ~0,002 SOL de loyer. */
export function ixCloseTokenAccount(account: string, destination: string, owner: string, program = TOKEN_PROGRAM): Ix {
  return {
    program,
    keys: [{ pubkey: account, signer: false, writable: true }, { pubkey: destination, signer: false, writable: true }, { pubkey: owner, signer: true, writable: false }],
    data: Uint8Array.from([9]),
  };
}
/** Transfert de jeton avec contrôle des décimales (TransferChecked). */
export function ixTransferChecked(source: string, mint: string, dest: string, owner: string, amount: bigint, decimals: number, program = TOKEN_PROGRAM): Ix {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;
  return {
    program,
    keys: [{ pubkey: source, signer: false, writable: true }, { pubkey: mint, signer: false, writable: false }, { pubkey: dest, signer: false, writable: true }, { pubkey: owner, signer: true, writable: false }],
    data,
  };
}

// ───────────────────────── Adresses dérivées (PDA) : compte de jeton « associé » ─────────────────────────

export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const P25519 = (1n << 255n) - 19n;
function powMod(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n, b = base % mod, e = exp;
  while (e > 0n) { if (e & 1n) r = (r * b) % mod; b = (b * b) % mod; e >>= 1n; }
  return r;
}
const D25519 = ((P25519 - 121665n) * powMod(121666n, P25519 - 2n, P25519)) % P25519;

/** Vrai si les 32 octets décrivent un point de la courbe Ed25519 (même règle que la décompression de curve25519-dalek). */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y %= P25519;
  const y2 = (y * y) % P25519;
  const u = (y2 + P25519 - 1n) % P25519;           // y² − 1
  const v = (D25519 * y2 + 1n) % P25519;           // d·y² + 1
  const z = (u * powMod(v, P25519 - 2n, P25519)) % P25519; // x² = u / v
  return z === 0n || powMod(z, (P25519 - 1n) / 2n, P25519) === 1n; // x² doit être un carré
}

export async function findProgramAddress(seeds: Uint8Array[], programId: string): Promise<{ address: string; bump: number }> {
  for (const s of seeds) if (s.length > 32) throw new Error('graine PDA trop longue');
  const prog = b58decode(programId);
  const tail = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), prog, tail];
    const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    if (!isOnCurve(h)) return { address: b58encode(h), bump };
  }
  throw new Error('aucune adresse dérivée valide');
}

/** Adresse du compte de jeton associé (le compte « normal » d'un portefeuille pour un jeton). */
export async function ataAddress(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM): Promise<string> {
  return (await findProgramAddress([b58decode(owner), b58decode(tokenProgram), b58decode(mint)], ATA_PROGRAM)).address;
}

/** Crée le compte de jeton associé s'il n'existe pas (sans erreur s'il existe déjà). */
export function ixCreateAtaIdempotent(payer: string, ata: string, owner: string, mint: string, tokenProgram = TOKEN_PROGRAM): Ix {
  return {
    program: ATA_PROGRAM,
    keys: [
      { pubkey: payer, signer: true, writable: true }, { pubkey: ata, signer: false, writable: true }, { pubkey: owner, signer: false, writable: false },
      { pubkey: mint, signer: false, writable: false }, { pubkey: SYSTEM_PROGRAM, signer: false, writable: false }, { pubkey: tokenProgram, signer: false, writable: false },
    ],
    data: Uint8Array.of(1),
  };
}

/** Transaction à signature vide, uniquement pour la simulation (jamais envoyée telle quelle). */
export function unsignedLegacy(message: Uint8Array): string {
  const tx = new Uint8Array(1 + 64 + message.length);
  tx[0] = 1;
  tx.set(message, 65);
  return toB64(tx);
}

export async function signLegacy(message: Uint8Array, signer: Signer): Promise<{ b64: string; signature: string }> {
  const sig = await signer.sign(message);
  const tx = new Uint8Array(1 + 64 + message.length);
  tx[0] = 1;
  tx.set(sig, 1);
  tx.set(message, 65);
  return { b64: toB64(tx), signature: b58encode(sig) };
}

// ───────────────────────── Client RPC ─────────────────────────

export class RpcError extends Error {
  code?: number;
  data?: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export type TokenAccount = { address: string; mint: string; raw: bigint; decimals: number; ui: number; program: string };
export type MintInfo = { owner: string; decimals: number; mintAuthority: string | null; freezeAuthority: string | null; extensions: string[] };
export type SigStatus = { confirmationStatus?: string; err: unknown; slot?: number } | null;

export function makeRpc(url: string, fetchFn: typeof fetch = fetch) {
  async function call<T = unknown>(method: string, params: unknown[] = [], tries = 3): Promise<T> {
    let last: unknown = new Error(`RPC ${method} sans réponse`);
    for (let i = 0; i < tries; i++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 12_000);
      try {
        const r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ac.signal });
        const text = await r.text();
        if (r.status === 429 || r.status >= 500) last = new Error(`RPC ${method} : HTTP ${r.status}`);
        else {
          const j = JSON.parse(text);
          if (j.error) throw new RpcError(String(j.error.message ?? 'erreur RPC'), j.error.code, j.error.data);
          return j.result as T;
        }
      } catch (e) {
        if (e instanceof RpcError) throw e;
        last = e;
      } finally {
        clearTimeout(timer);
      }
      if (i < tries - 1) await sleep(300 * (i + 1) ** 2);
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  const api = {
    call,
    async balance(owner: string): Promise<bigint> {
      const r = await call<{ value: number }>('getBalance', [owner, { commitment: 'confirmed' }]);
      return BigInt(r.value);
    },
    async blockHeight(): Promise<number> { return await call<number>('getBlockHeight', [{ commitment: 'confirmed' }]); },
    async latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
      return (await call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
    },
    async tokenAccounts(owner: string, program = TOKEN_PROGRAM): Promise<TokenAccount[]> {
      type Item = { pubkey: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number; uiAmountString?: string } } } } } };
      const r = await call<{ value: Item[] }>('getTokenAccountsByOwner', [owner, { programId: program }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      return r.value.map((v) => {
        const i = v.account.data.parsed.info;
        return { address: v.pubkey, mint: i.mint, raw: BigInt(i.tokenAmount.amount), decimals: i.tokenAmount.decimals, ui: Number(i.tokenAmount.uiAmountString ?? 0), program };
      });
    },
    /** Les deux programmes de jetons (classique et Token-2022). */
    async tokenAccountsAll(owner: string): Promise<TokenAccount[]> {
      const [a, b] = await Promise.all([api.tokenAccounts(owner, TOKEN_PROGRAM), api.tokenAccounts(owner, TOKEN_2022_PROGRAM)]);
      return [...a, ...b];
    },
    async mintInfo(mint: string): Promise<MintInfo | null> {
      type Acc = { value: { owner: string; data: { parsed?: { info?: { decimals: number; mintAuthority: string | null; freezeAuthority: string | null; extensions?: { extension: string }[] } } } } | null };
      const r = await call<Acc>('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const info = r.value?.data?.parsed?.info;
      if (!r.value || !info) return null;
      return { owner: r.value.owner, decimals: info.decimals, mintAuthority: info.mintAuthority ?? null, freezeAuthority: info.freezeAuthority ?? null, extensions: (info.extensions ?? []).map((e) => String(e.extension)) };
    },
    async send(txB64: string): Promise<string> {
      return await call<string>('sendTransaction', [txB64, { encoding: 'base64', skipPreflight: false, preflightCommitment: 'processed', maxRetries: 0 }], 2);
    },
    async status(sig: string): Promise<SigStatus> {
      const r = await call<{ value: SigStatus[] }>('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
      return r.value[0] ?? null;
    },
    async transaction(sig: string): Promise<ChainTx | null> {
      return await call<ChainTx | null>('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
    },
    /** Simule sans signature ; renvoie l'erreur éventuelle et le solde (lamports) de `owner` APRÈS la transaction. */
    async simulate(txB64: string, owner: string): Promise<{ err: unknown; lamportsAfter: bigint | null; logs: string[] }> {
      type Sim = { value: { err: unknown; logs?: string[]; accounts?: ({ lamports: number } | null)[] } };
      const r = await call<Sim>('simulateTransaction', [txB64, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', accounts: { encoding: 'base64', addresses: [owner] } }], 2);
      const acc = r.value.accounts?.[0];
      return { err: r.value.err, lamportsAfter: acc ? BigInt(acc.lamports) : null, logs: r.value.logs ?? [] };
    },
  };
  return api;
}
export type Rpc = ReturnType<typeof makeRpc>;

export type TokenBal = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number; uiAmountString?: string } };
export type ChainTx = {
  slot?: number;
  meta: { err: unknown; fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null;
  transaction: { message: { accountKeys: ({ pubkey: string } | string)[] } };
};

/** Attend la confirmation (re-diffuse la même transaction signée : sans risque, la signature est identique). */
export async function waitConfirmed(
  rpc: Rpc, signature: string, opts: { timeoutMs?: number; rebroadcast?: () => Promise<unknown>; pollMs?: number } = {},
): Promise<{ state: 'confirmed' } | { state: 'failed'; err: unknown } | { state: 'timeout' }> {
  const end = Date.now() + (opts.timeoutMs ?? 25_000);
  let lastSend = Date.now();
  while (Date.now() < end) {
    let st: SigStatus = null;
    try { st = await rpc.status(signature); } catch { /* nouvel essai */ }
    if (st) {
      if (st.err) return { state: 'failed', err: st.err };
      if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') return { state: 'confirmed' };
    }
    if (opts.rebroadcast && Date.now() - lastSend > 4_000) { lastSend = Date.now(); try { await opts.rebroadcast(); } catch { /* ignoré */ } }
    await sleep(opts.pollMs ?? 1_500);
  }
  return { state: 'timeout' };
}
