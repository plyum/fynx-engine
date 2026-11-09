# FYNX — serveur du moteur

Moteur de trading autonome de memecoins Solana (paper trading et compte réel via Jupiter). Ce dépôt fait tourner **le même moteur**
que la fonction Supabase `tick`, mais **en boucle continue** (un tour toutes les 5 s) sur un serveur toujours allumé (Render).
La base de données, la connexion et les portefeuilles chiffrés restent dans Supabase.

## Comment ça marche
- `src/engine/` : le moteur, **copié tel quel** depuis la fonction Supabase `tick` du projet FYNX (seule l'entrée HTTP de la fonction est retirée). Ne pas le modifier ici à la main : on change la source du projet FYNX puis on recopie.
- `src/service.ts` : la boucle. Un tour toutes les 5 s, un tour complet (analyse, valorisation) toutes les 30 s.
- `src/server.ts` : démarre la boucle, expose `GET /health`, s'arrête proprement sur SIGTERM (rend le verrou).
- **Verrou Postgres** (`acquire_engine_lock`, renouvelé à chaque tour) : un seul moteur tourne à la fois. La fonction Supabase `tick`
  (déclenchée par pg_cron toutes les 30 s) reste en **secours** : si ce serveur tombe, elle reprend au bout de 120 s au plus.

## Variables d'environnement (à saisir dans Render → Environment, jamais dans le code ni dans le chat)
| Nom | Obligatoire | Rôle |
|---|---|---|
| `SUPABASE_URL` | oui | adresse du projet Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | oui | clé secrète du projet (Supabase → Réglages → clés d'API) |
| `WALLET_ENCRYPTION_KEY` | pour le compte réel | **la même valeur** que dans les secrets des fonctions Supabase |
| `SOLANA_RPC_URL` | non | RPC Solana dédié (recommandé) ; par défaut le RPC public |
| `JUPITER_API_KEY` | non | clé Jupiter gratuite |
| `PORT` | non | fourni par Render |

## Tests
`npm test` (Node ≥ 22.18) : tests de la boucle (horloge simulée) et test de fumée du vrai point d'entrée avec un faux Supabase.
Les 117 tests du moteur lui-même sont dans le projet FYNX (ils passent aussi sur cette copie).

## Limites connues
- Le trading réel n'a jamais été exécuté avec de l'argent réel ; il n'est vérifié que contre de faux serveurs.
- Les tests n'utilisent pas le vrai client `@supabase/supabase-js` : il est installé par `npm install` au déploiement.
