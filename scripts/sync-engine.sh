#!/usr/bin/env bash
# Régénère src/engine/ à partir du moteur de référence (fynx/functions/tick). Le moteur n'est JAMAIS modifié à la main ici :
# on change la source, on relance ce script, puis on relance les tests. Usage : bash scripts/sync-engine.sh [dossier-source]
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="${1:-../fynx/functions/tick}"
[ -f "$SRC/index.ts" ] || { echo "Source introuvable : $SRC" >&2; exit 1; }
rm -rf src/engine && mkdir -p src/engine/testkit
for f in lib solana jupiter live livecycle ai aiteam scan scalp; do cp "$SRC/$f.ts" "src/engine/$f.ts"; done
cp "$SRC"/*.test.ts "$SRC"/*.itest.ts src/engine/
cp "$SRC"/testkit/*.mjs src/engine/testkit/
# Les tests remplacent le client Supabase par un faux : on accepte aussi le nom Node (sans « npm: »).
python3 - "$SRC" <<'PY'
import re, sys
src = sys.argv[1]
t = open(src + '/index.ts', encoding='utf-8').read()
t = t.replace("'npm:@supabase/supabase-js@2'", "'@supabase/supabase-js'")
t = re.sub(r"Deno\.env\.get\(('[A-Z_]+')\)", r"process.env[\1]", t)
cut = t.index('Deno.serve(')
t = t[:cut].rstrip() + "\n\n// Ajout du serveur Node : le moteur est le même, seule l'entrée HTTP de la fonction Supabase est retirée.\nexport { ev, flush, makeClient };\n"
assert 'Deno.' not in t, 'Deno.* restant dans le moteur'
open('src/engine/index.ts', 'w', encoding='utf-8').write(t)
h = open('src/engine/testkit/hooks.mjs', encoding='utf-8').read()
h = h.replace("specifier.startsWith('npm:@supabase/supabase-js')", "(specifier.startsWith('npm:@supabase/supabase-js') || specifier === '@supabase/supabase-js')")
open('src/engine/testkit/hooks.mjs', 'w', encoding='utf-8').write(h)
PY
echo "Moteur synchronisé depuis $SRC"
