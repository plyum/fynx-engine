// Faux client Supabase pour le test de fumée : base vide, chaque appel de verrou est écrit sur la sortie standard.
const chain = () => new Proxy(function () {}, {
  get: (_t, prop) => (prop === 'then' ? (res) => res({ data: [], error: null, count: 0 }) : () => chain()),
  apply: () => chain(),
});
export const createClient = () => ({
  from: () => chain(),
  rpc: async (fn, args) => {
    if (fn.endsWith('_engine_lock')) console.log(`RPC ${fn} ${JSON.stringify(args)}`);
    return { data: true, error: null };
  },
});
