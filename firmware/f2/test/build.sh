#!/usr/bin/env sh
# Compila alma-f2 para la PC con HAL falsos y corre las pruebas. Nada toca el robot.
# Uso (Git Bash): CC="/c/Users/ikann/emo_tools/cc_venv/Scripts/python -m ziglang cc" sh test/build.sh
# Entradas privadas (R5), fuera del repo: storage.bin, assets_inventory.json y los .mot extraídos de emo_backup.
set -e
cd "$(dirname "$0")/.."
CC=${CC:-cc}
PY=${PY:-/c/Users/ikann/emo_tools/venv/Scripts/python}
BK=${BK:-/c/Users/ikann/emo_backup}
EXE=
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) EXE=.exe ;; esac
A=../..                                   # alma/
S1=../sesion1/main                        # se reusan k210_frames.c y mot.c de sesion1 sin cambios
# mbedTLS de ESP-IDF (el mismo código que en el robot) para el enlace cifrado (link.c), con una configuración mínima
MBED=${MBED:-/c/Espressif/frameworks/esp-idf-v5.2.1/components/mbedtls/mbedtls}
MBEDCFG="-I$MBED/include -DMBEDTLS_CONFIG_FILE=\"mbedtls_pc_config.h\""
INC="-Iapp -Itest -I$S1 -I$A/core -I$A/memory_store -I$A/sim -I$A/sim/third_party/cjson $MBEDCFG"
OWN="app/*.c test/hal_fake.c test/test_f2.c"
REUSED="$S1/k210_frames.c $S1/mot.c $A/core/*.c $A/memory_store/alma_mem.c $A/memory_store/alma_mem_flash_file.c $A/sim/catalog_load.c"
mkdir -p test/build/mbed
for f in aes cipher cipher_wrap gcm md sha256 platform platform_util constant_time; do
    [ test/build/mbed/$f.o -nt "$MBED/library/$f.c" ] || $CC -std=c11 -O2 -Itest $MBEDCFG -I"$MBED/library" -c -o test/build/mbed/$f.o "$MBED/library/$f.c"
done
MBEDO="test/build/mbed/*.o"
NETLIB=
[ -n "$EXE" ] && NETLIB=-lws2_32
# el enlace contra el relay real (relay/tests/test_uplink_c.py lo corre)
$CC -std=c11 -O2 -Wall -Wextra -Werror $INC -o test/build/uplink_pc$EXE test/uplink_pc.c app/uplink.c app/ws.c app/link.c $MBEDO $NETLIB
$CC -std=c11 -O2 -Wall -Wextra -Werror $INC -o test/build/test_f2$EXE $OWN $REUSED $A/sim/third_party/cjson/cJSON.c $MBEDO -lm
# variante con la escritura de memoria encendida (06): un día simulado, reinicio y cortes de luz
$CC -std=c11 -O2 -Wall -Wextra -Werror -DALMA_MEM_WRITE_ENABLED=1 $INC -o test/build/test_f2_memw$EXE $OWN $REUSED $A/sim/third_party/cjson/cJSON.c $MBEDO -lm
TMP=$(mktemp -d)
"$PY" -I $A/tools/mot_studio/test/dump_mot_tool.py $A/../alma-spec/tools "$BK/spiffs/mot" "$TMP/mot_tool.json" > /dev/null
# Referencia de la marcha (privada, emo_backup/re/marcha_ref.c): lo que debe dar gait.c, muestra por muestra
REF=
if [ -f "$BK/re/marcha_ref.c" ] && $CC -std=c99 -O2 -o "$TMP/marcha_ref$EXE" "$BK/re/marcha_ref.c" -lm 2> /dev/null; then
    mkdir -p "$TMP/ref"
    for f in "$BK"/spiffs/mot/*.mot; do "$TMP/marcha_ref$EXE" "$f" > "$TMP/ref/$(basename "$f" .mot).txt"; done
    REF="$TMP/ref"
fi
cd test
./build/test_f2$EXE ../$A/catalog/catalog.json "$BK/partitions/storage.bin" "$BK/assets_inventory.json" "$TMP/mot_tool.json" $REF
rc=$?
echo "== variante con escritura de memoria =="
./build/test_f2_memw$EXE ../$A/catalog/catalog.json "$BK/partitions/storage.bin" "$BK/assets_inventory.json" "$TMP/mot_tool.json" || rc=1
rm -rf "$TMP"
exit $rc
