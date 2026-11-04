#include "vivo.h"

#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_ota_ops.h"
#include "esp_psram.h"
#include "esp_system.h"
#include "esp_timer.h"

#include "log_util.h"

const char *vivo_reset_name(void)
{
    switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "POWERON";      /* encendido, o el pulso de EN (RTS) de esptool y sesion_term */
    case ESP_RST_EXT: return "EXT";
    case ESP_RST_SW: return "SW";
    case ESP_RST_PANIC: return "PANIC";
    case ESP_RST_INT_WDT: return "INT_WDT";
    case ESP_RST_TASK_WDT: return "TASK_WDT";
    case ESP_RST_WDT: return "WDT";
    case ESP_RST_DEEPSLEEP: return "DEEPSLEEP";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_SDIO: return "SDIO";
    default: return "UNKNOWN";
    }
}

/* VIVO_ELF_SHA_FULL=1 (alma-f2): los 64 caracteres, desde app_elf_sha256 de la descripción de la app.
 * Sin ella (alma-sesion1, tal como quedó escrita en la sesión 1A): esp_app_get_elf_sha256(), que entrega solo
 * CONFIG_APP_RETRIEVE_LEN_ELF_SHA caracteres (9 por omisión). */
#ifndef VIVO_ELF_SHA_FULL
#define VIVO_ELF_SHA_FULL 0
#endif

void vivo_boot_line(void)
{
    const esp_app_desc_t *app = esp_app_get_description();
    const esp_partition_t *run = esp_ota_get_running_partition();
    char sha[65];
#if VIVO_ELF_SHA_FULL
    static const char HEX[] = "0123456789abcdef";
    for (int i = 0; i < 32; i++) {
        sha[2 * i] = HEX[app->app_elf_sha256[i] >> 4];
        sha[2 * i + 1] = HEX[app->app_elf_sha256[i] & 0xF];
    }
    sha[64] = 0;
#else
    esp_app_get_elf_sha256(sha, sizeof sha);
#endif
    log_line("ALMA_BOOT app=%s ver=%s elf_sha256=%s part=%s reset=%s psram=%u", app->project_name, app->version, sha,
             run ? run->label : "?", vivo_reset_name(), (unsigned)esp_psram_get_size());
}

void vivo_line(const char *app_fields)
{
    log_line("ALMA_VIVO uptime_s=%lld heap=%u heap_min=%u psram_libre=%u %s", (long long)(esp_timer_get_time() / 1000000),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM), app_fields);
}
