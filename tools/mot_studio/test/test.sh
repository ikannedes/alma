#!/usr/bin/env sh
# Pruebas de mot-studio. Uso (Git Bash): sh test/test.sh [carpeta_mot]
# Por omisión lee los .mot extraídos del respaldo; lo exportado va a una carpeta temporal fuera del repo (R5).
set -e
cd "$(dirname "$0")"
MOT=${1:-/c/Users/ikann/emo_backup/spiffs/mot}
SPEC=../../../../alma-spec/tools
PY=${PY:-/c/Users/ikann/emo_tools/venv/Scripts/python}
TMP=$(mktemp -d)
"$PY" -I dump_mot_tool.py "$SPEC" "$MOT" "$TMP/mot_tool.json"
node test_mot_studio.js "$MOT" "$TMP/mot_tool.json" "$TMP"
for f in "$TMP"/editado_*.mot; do
    "$PY" -I "$SPEC/mot_tool.py" "$f" > /dev/null && echo "mot_tool.py valida $(basename "$f")"
done
rm -rf "$TMP"
