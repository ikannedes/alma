/* r15_guard.c — candado de R15 (09; 06, "La partición nvs original"): el firmware Alma nunca inicializa, escribe
 * ni borra la nvs original. main/CMakeLists.txt enlaza con -Wl,--wrap= para estas funciones: cualquier llamada,
 * de Alma o de un componente de ESP-IDF, cae aquí y detiene el programa en la primera prueba.
 * Si algún día hace falta NVS, se usa una propia en la zona libre con nvs_flash_init_partition_ptr (06). */
#include <stdlib.h>

#include "esp_err.h"
#include "esp_log.h"
#include "esp_partition.h"

static void r15_violation(const char *fn)
{
    ESP_LOGE("R15", "%s: el firmware Alma no toca la nvs original (09, R15). Se detiene.", fn);
    abort();
}

esp_err_t __wrap_nvs_flash_init(void);
esp_err_t __wrap_nvs_flash_init(void) { r15_violation("nvs_flash_init"); return ESP_FAIL; }
esp_err_t __wrap_nvs_flash_erase(void);
esp_err_t __wrap_nvs_flash_erase(void) { r15_violation("nvs_flash_erase"); return ESP_FAIL; }
esp_err_t __wrap_nvs_flash_erase_partition(const char *part_name);
esp_err_t __wrap_nvs_flash_erase_partition(const char *part_name) { (void)part_name; r15_violation("nvs_flash_erase_partition"); return ESP_FAIL; }
esp_err_t __wrap_nvs_flash_erase_partition_ptr(const esp_partition_t *partition);
esp_err_t __wrap_nvs_flash_erase_partition_ptr(const esp_partition_t *partition) { (void)partition; r15_violation("nvs_flash_erase_partition_ptr"); return ESP_FAIL; }
