# FYNX — serveur du moteur

Moteur de trading autonome de memecoins Solana (paper trading et compte réel via Jupiter). Ce dépôt fait tourner **le même moteur**
que la fonction Supabase `tick`, mais **en boucle continue** (un tour toutes les 5 s) sur un serveur toujours allumé (Render).
La base de données, la connexion et les portefeuilles chiffrés restent dans Supabase.

## Comment ça marche
- `src/engine/` : le moteur, **copié depuis le projet principal** (`fynx/functions/tick`) par `bash scripts/sync-engine.sh`.
  Ne jamais le modifier ici à la main : on change la source, on relance le script, on relance les tests du projet principal, puis on pousse ici.
- `src/service.ts` : la boucle. Un tour toutes les 5 s, un tour complet (analyse, valorisation) toutes les 30 s.
- `src/server.ts` : démarre la boucle, expose `GET /health`, s'arrête proprement sur SIGTERM (rend le verrou).
- **Verrou Postgres** (`acquire_engine_lock`, renouvelé à chaque tour) : un seul moteur tourne à la fois. La fonction Supabase `tick`
  (déclenchée par pg_cron toutes les 30 s) reste en **secours** : si ce serveur tombe, elle reprend au bout de 120 s au plus.

## Variables d'environnement (à saisir dans Render → Environment, jamais dans le code ni dans le chat)
À la création par Blueprint (`render.yaml`), Render ne demande que les deux secrets indispensables (`SUPABASE_SERVICE_ROLE_KEY`,
`WALLET_ENCRYPTION_KEY`). `SOLANA_RPC_URL` et `JUPITER_API_KEY` s'ajoutent ensuite dans Render → Environment (le service redémarre).

| Nom | Obligatoire | Rôle |
|---|---|---|
| `SUPABASE_URL` | oui | adresse du projet Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | oui | clé secrète du projet (Supabase → Réglages → clés d'API) |
| `WALLET_ENCRYPTION_KEY` | pour le compte réel | **la même valeur** que dans les secrets des fonctions Supabase |
| `SOLANA_RPC_URL` | non | RPC Solana dédié (recommandé) ; par défaut le RPC public |
| `JUPITER_API_KEY` | non | clé Jupiter gratuite |
| `PORT` | non | fourni par Render |

## Node
Le serveur exécute les fichiers `.ts` directement, sans compilation : Node ≥ 22.18. La version exacte (22.23.4, celle des tests)
est fixée dans `.node-version` et dans `render.yaml`. Les dépendances sont figées par `package-lock.json`.

## Tests
`npm test` lance :
- `test/service.test.ts` : la boucle avec une horloge simulée (cadence 5 s, tour complet toutes les 30 s, verrou, pannes, arrêt) ;
- `test/smoke.test.ts` : le vrai point d'entrée `src/server.ts` avec un faux Supabase (démarrage, prise du verrou, `/health`, arrêt propre) ;
- `test/real-client.test.ts` : le même point d'entrée avec le **vrai** `@supabase/supabase-js` (après `npm install`) face à un faux serveur d'API local
  (requêtes HTTP réelles, verrou, tour du moteur, `/health`, arrêt propre). Ignoré si les dépendances ne sont pas installées.

Les tests du moteur lui-même vivent dans le projet principal (`fynx/functions/tick`), là où le moteur est modifié.

## Limites connues
- Le trading réel n'a jamais été exécuté avec de l'argent réel ; il n'est vérifié que contre de faux serveurs.
- Aucun test ne parle à la vraie base Supabase ni aux vraies API (DexScreener, RugCheck, Jupiter, Solana) : ils sont simulés.
