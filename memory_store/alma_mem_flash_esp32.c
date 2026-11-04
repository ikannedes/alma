/* alma_mem_flash_esp32.c — región de memory_store en el flash del ESP32 (06, "Dónde se guarda", opción a).
 *
 * Registra en tiempo de ejecución una partición sobre la zona libre que deja la tabla original (0xB60000–0x1000000,
 * toda en 0xFF; 02), sin reescribir la tabla. esp_partition_register_external rechaza regiones que se encimen con la
 * tabla (ESP_ERR_INVALID_ARG), y la escritura pasa por la protección de esp_flash (no deja escribir en la tabla ni
 * en la app en ejecución).
 *
 * ALMA_MEM_WRITE_ENABLED = 0 (por omisión): lee y valida, pero write y erase devuelven error sin tocar el flash.
 * La primera escritura en la región tendrá su propio plan de sesión (06). No probado todavía en el robot.
 */
#include "alma_mem_flash.h"

#ifdef ESP_PLATFORM
#include "esp_flash.h"
#include "esp_log.h"
#include "esp_partition.h"
#endif

#ifndef ALMA_MEM_WRITE_ENABLED
#define ALMA_MEM_WRITE_ENABLED 0
#endif

#define ALMA_MEM_ESP32_OFFSET  0xB60000u   /* fin de la tabla original (02) */
#define ALMA_MEM_ESP32_SIZE    0x80000u    /* 512 KB */
#define ALMA_MEM_ESP32_SUBTYPE 0x40        /* subtipo de datos que ESP-IDF no usa */

#ifdef ESP_PLATFORM
static const esp_partition_t *part;

static int rd(void *ctx, uint32_t off, void *buf, uint32_t n)
{
    (void)ctx;
    return esp_partition_read(part, off, buf, n) == ESP_OK ? 0 : -1;
}

static int wr(void *ctx, uint32_t off, const void *buf, uint32_t n)
{
    (void)ctx;
#if ALMA_MEM_WRITE_ENABLED
    return esp_partition_write(part, off, buf, n) == ESP_OK ? 0 : -1;
#else
    (void)off; (void)buf; (void)n;
    return -1;   /* escritura deshabilitada al compilar */
#endif
}

static int er(void *ctx, uint32_t off, uint32_t n)
{
    (void)ctx;
#if ALMA_MEM_WRITE_ENABLED
    return esp_partition_erase_range(part, off, n) == ESP_OK ? 0 : -1;
#else
    (void)off; (void)n;
    return -1;
#endif
}

int alma_mem_esp32_open(alma_mem_flash *out)
{
    if (!part) {
        esp_err_t e = esp_partition_register_external(esp_flash_default_chip, ALMA_MEM_ESP32_OFFSET, ALMA_MEM_ESP32_SIZE, "alma",
                                                      ESP_PARTITION_TYPE_DATA, ALMA_MEM_ESP32_SUBTYPE, &part);
        if (e != ESP_OK) { ESP_LOGE("alma_mem", "no pude registrar la región 0x%x: %s", (unsigned)ALMA_MEM_ESP32_OFFSET, esp_err_to_name(e)); return -1; }
    }
    *out = (alma_mem_flash){rd, wr, er, ALMA_MEM_ESP32_SIZE, NULL};
    return 0;
}
#else
int alma_mem_esp32_open(alma_mem_flash *out)
{
    (void)out;
    return -1;   /* solo existe en el ESP32 */
}
#endif
