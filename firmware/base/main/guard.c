/* guard.c — la NVS de la base no se borra nunca (tiene el Wi-Fi de la casa; dueño, 2026-11-06). El enlazador manda aquí
 * cualquier llamada a nvs_flash_erase* (main/CMakeLists.txt, --wrap) y se detiene en vez de borrar. */
#include <stdlib.h>

#include "esp_partition.h"
#include "f2_hal.h"

static void no(const char *f)
{
    hal_log("ERROR: %s está prohibido en alma-base (la NVS tiene el Wi-Fi de la casa)", f);
    abort();
}

int __wrap_nvs_flash_erase(void) { no("nvs_flash_erase"); return -1; }
int __wrap_nvs_flash_erase_partition(const char *p) { (void)p; no("nvs_flash_erase_partition"); return -1; }
int __wrap_nvs_flash_erase_partition_ptr(const esp_partition_t *p) { (void)p; no("nvs_flash_erase_partition_ptr"); return -1; }
