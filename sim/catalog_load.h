/* catalog_load.h — carga y valida catalog.json contra assets_inventory.json (05). */
#ifndef CATALOG_LOAD_H
#define CATALOG_LOAD_H

#include "alma_core.h"

/* Devuelve el número de conductas aceptadas o −1 si no pudo leer los archivos.
 * Las conductas inválidas (asset fuera del inventario, precondición desconocida) se
 * descartan con un aviso en stderr: el firmware no se detiene (05, "Regla de assets"). */
int catalog_load(const char *catalog_path, const char *inventory_path, alma_catalog *out, int verbose);
/* Igual, con el texto de los dos JSON ya en memoria (firmware: catalog.json embebido e inventario de la SPIFFS). */
int catalog_load_text(const char *catalog_text, const char *inventory_text, alma_catalog *out, int verbose);

#endif
