#!/usr/bin/env sh
# Prueba el motor de mot_studio_3d contra la referencia privada (emo_backup/re/marcha_ref.c). Nada sale de la PC.
# Uso (Git Bash): sh test/test.sh
set -e
cd "$(dirname "$0")/.."
BK=${BK:-/c/Users/ikann/emo_backup}
CC=${CC:-"/c/Users/ikann/emo_tools/cc_venv/Scripts/python -m ziglang cc"}
TMP=$(mktemp -d)
$CC -std=c99 -O2 -o "$TMP/marcha_ref.exe" "$BK/re/marcha_ref.c" -lm
mkdir -p "$TMP/ref"
for f in "$BK"/spiffs/mot/*.mot "$BK"/spiffs/mot/*.mo "$BK"/spiffs/mot/*.m; do
    [ -f "$f" ] || continue
    b=$(basename "$f"); b=${b%.mot}; b=${b%.mo}; b=${b%.m}
    "$TMP/marcha_ref.exe" "$f" > "$TMP/ref/$b.txt"
done
node test/engine.test.mjs "$BK/spiffs/mot" "$TMP/ref"
rc=$?
rm -rf "$TMP"
exit $rc
