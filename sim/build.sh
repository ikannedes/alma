#!/usr/bin/env sh
# Compila el simulador y las pruebas de alma_core en la PC.
# CC por omisión: cc. En esta PC: CC="python -m ziglang cc" (paquete ziglang de PyPI).
set -e
cd "$(dirname "$0")"
CC=${CC:-cc}
EXE=${EXE:-}
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE=.exe ;; esac
CFLAGS="-std=c11 -O2 -Wall -Wextra -I../core -I../memory_store -Ithird_party/cjson"
CORE="../core/alma_core.c ../core/alma_emotion.c ../core/alma_bonds.c ../core/alma_select.c ../core/alma_rhythm.c ../core/alma_rng.c ../core/alma_care.c ../core/alma_brain.c"
MEM="../memory_store/alma_mem.c ../memory_store/alma_mem_flash_file.c"
COMMON="catalog_load.c third_party/cjson/cJSON.c"
mkdir -p build
$CC $CFLAGS -o build/sim$EXE $CORE $MEM $COMMON sim_main.c -lm
if [ -f test_core.c ]; then $CC $CFLAGS -o build/test_core$EXE $CORE $COMMON test_core.c -lm; fi
$CC $CFLAGS -o build/test_memory$EXE $CORE $MEM $COMMON test_memory.c -lm
# cuerpo de Alma para la fase 0 del reloj (relay/tests/test_mudanza_caos.py lo carga con ctypes)
case "$EXE" in .exe) LIB=alma_body.dll ;; *) LIB=libalma_body.so ;; esac
$CC $CFLAGS -shared -fPIC -o build/$LIB $CORE $MEM $COMMON body_lib.c -lm
$CC $CFLAGS -o build/brain_gen$EXE $CORE $COMMON brain_gen.c -lm
echo "ok: build/sim$EXE"
