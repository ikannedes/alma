/* Señales de arranque y de vida (sesion1a.md), compartidas por alma-sesion1 y alma-f2. Líneas fijas, fáciles de buscar:
 *   ALMA_BOOT app=<nombre> ver=<versión> elf_sha256=<64 hex> part=<partición> reset=<causa> psram=<bytes>
 *   ALMA_VIVO uptime_s=<s> heap=<libre interna> heap_min=<mínimo histórico> psram_libre=<bytes> <campos de la app>
 * sesion_term.py las vigila: arranque con el ELF esperado, ALMA_VIVO cada 60 s, reinicios y heap. */
#pragma once

void vivo_boot_line(void);                 /* llamar al principio de app_main */
void vivo_line(const char *app_fields);    /* app_fields: "estado=… on_charger=… wifi=… hora=… k210_rx=… k210=…" */
const char *vivo_reset_name(void);
