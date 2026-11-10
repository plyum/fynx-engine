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
| `ANTHROPIC_API_KEY` | non | active l'agent « Analyste IA » (Claude Haiku). Sans elle, les règles décident seules |
| `AI_VETO` | non | `off` = l'IA donne son avis mais ne bloque plus rien (par défaut : veto actif) |
| `AI_MIN_CONFIDENCE` | non | confiance minimale (0-100) d'un « avoid » pour bloquer un achat (60 par défaut) |
| `AI_MONTHLY_BUDGET_USD` | non | plafond de dépense IA par mois civil UTC (8 par défaut) ; atteint = plus d'appels, les règles continuent |
| `AI_MODEL` | non | modèle utilisé (`claude-haiku-5-5` par défaut) |
| `PORT` | non | fourni par Render |

## Agent IA (« Analyste IA »)
Pour chaque jeton que les règles ont **déjà accepté**, juste avant l'achat, un appel à Claude Haiku relit les données de marché et le rapport de risque
et répond `avoid`, `ok` ou `unsure` avec une confiance et des raisons en français.
- **Il ne peut que bloquer** : un `avoid` assez sûr (≥ 60 % par défaut) annule l'achat (événement « VETO IA … »). Il ne déclenche jamais d'achat, ne change ni la taille ni les plafonds, et n'intervient pas sur les sorties (stop loss, take profit).
- **Panne = pas d'avis** : clé absente, réseau, quota, réponse illisible, budget du mois atteint, coupe-circuit après 3 échecs, ou plus de 12 s d'attente cumulée dans un tour (un modèle lent ne retarde jamais les stops) → les règles décident seules (avertissement affiché, jamais de blocage général).
- **Données non fiables** : noms et textes de jetons sont nettoyés, bornés et déclarés « non fiables » dans l'invite ; la réponse est forcée en JSON strict à trois valeurs.
- **Cache et coût** : un avis par jeton pour 15 min (partagé entre comptes), historique dans la table `ai_verdicts` (jetons, coût, entrée) pour évaluer l'agent après coup ; le budget du mois est la somme de cette table (fonction SQL `ai_month_spend`). Environ 0,0001 $ par avis.

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
