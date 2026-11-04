#!/usr/bin/env sh
# Pruebas en la PC de lo portable de alma-sesion1. CC por omisión: cc. En esta PC:
#   CC="/c/Users/ikann/emo_tools/cc_venv/Scripts/python -m ziglang cc" sh test/build.sh
# Con el respaldo: test/build/test_sesion1 <storage.bin> <dir con los .mot extraídos>
set -e
cd "$(dirname "$0")/.."
CC=${CC:-cc}
mkdir -p test/build
$CC -std=c11 -O2 -Wall -Wextra -Werror -Imain -o test/build/test_sesion1 test/test_sesion1.c main/k210_frames.c main/mot.c
echo "ok: test/build/test_sesion1"
