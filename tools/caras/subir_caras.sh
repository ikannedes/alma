#!/usr/bin/env bash
# Copia las caras de festividades (AVI de generar_cara.py / fiestas.py) al servidor, donde las toma relay fiestas.py
# (/var/lib/alma-relay/caras/<nombre>.avi). Solo con confirmación del dueño.
# Uso: bash subir_caras.sh [carpeta con los .avi]   (por omisión, emo_backup/caras/20261102)
set -euo pipefail
SRC=${1:-/c/Users/ikann/emo_backup/caras/20261102}
K=~/.ssh/alma_droplet
H=root@165.227.29.235
ssh -i "$K" "$H" 'mkdir -p /tmp/caras && rm -f /tmp/caras/*.avi'
scp -q -i "$K" "$SRC"/*.avi "$H":/tmp/caras/
ssh -i "$K" "$H" 'D=/var/lib/alma-relay/caras; install -d -o alma -g alma -m 755 $D; install -o alma -g alma -m 644 /tmp/caras/*.avi $D/; ls $D | wc -l'
