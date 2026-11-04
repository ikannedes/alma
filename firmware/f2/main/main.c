/* alma-f2: firmware de la fase 2 (08). Alma vive sin internet: alma_core, memory_store (solo lectura) y catalog.json
 * sobre hal_k210, perception, motion_player, expression y reflexes (app/). La consola de sesion1 queda como consola
 * de desarrollo (COM9, 115200; tecla h). No inicia NVS ni Wi-Fi (salvo ALMA_F2_API, con R15). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "driver/uart.h"
#include "esp_heap_caps.h"
#include "esp_random.h"
#include "esp_rom_gpio.h"
#include "esp_vfs_dev.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "soc/gpio_periph.h"
#include "soc/gpio_struct.h"

#include "app.h"
#include "cJSON.h"
#include "f2_config.h"
#include "f2_hal.h"
#include "f2_main.h"
#include "hal_esp32.h"
#include "hal_k210.h"
#include "log_util.h"
#include "vivo.h"

#define PWR_EN 23

/* R13: GPIO23 (PWR_EN) en ALTO lo antes posible y nunca se vuelve a tocar. Igual que sesion1/main/main.c. */
__attribute__((constructor(101))) static void pwr_en_early(void)
{
    esp_rom_gpio_pad_select_gpio(PWR_EN);
    GPIO.out_w1ts = 1u << PWR_EN;
    esp_rom_gpio_connect_out_signal(PWR_EN, SIG_GPIO_OUT_IDX, false, false);
    GPIO.enable_w1ts = 1u << PWR_EN;
}

extern const char catalog_json_start[] asm("_binary_catalog_json_start");   /* catalog.json embebido (con \0) */

SemaphoreHandle_t f2_app_mutex;   /* la API local (otra tarea) y el bucle principal no tocan la app a la vez */

/* RAM-PROPUESTA.md, B: los nodos de cJSON (miles de bloques chicos al parsear catalog.json, y los cuerpos de la API)
   van a la PSRAM; con CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL irían primero a la RAM interna. Sin PSRAM, malloc. */
static void *cjson_malloc(size_t n)
{
    void *p = heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    return p ? p : malloc(n);
}

/* RAM-PROPUESTA.md, 3.1: lo mínimo que le quedó libre a cada pila (bytes), "-" si la tarea no existe en esta variante */
static void stacks_line(void)
{
    static const char *const TASKS[] = {"main", "httpd", "wifi", "tiT", "k210_rx", "esp_timer", "sys_evt", "Tmr Svc", "ipc0", "ipc1"};
    char line[256];
    int o = snprintf(line, sizeof line, "ALMA_PILAS");
    for (size_t i = 0; i < sizeof TASKS / sizeof *TASKS; i++) {
        TaskHandle_t t = xTaskGetHandle(TASKS[i]);
        char key[16];
        snprintf(key, sizeof key, "%s", TASKS[i]);
        for (char *k = key; *k; k++) if (*k == ' ') *k = '_';
        if (t) o += snprintf(line + o, sizeof line - o, " %s=%u", key, (unsigned)uxTaskGetStackHighWaterMark(t));
        else o += snprintf(line + o, sizeof line - o, " %s=-", key);
    }
    hal_log("%s", line);
}

void app_main(void)
{
    log_init();
    vivo_boot_line();
    hal_heap_mark("inicio");
    cJSON_InitHooks(&(cJSON_Hooks){cjson_malloc, free});
    /* consola con búfer de salida: un printf largo no detiene el bucle principal */
    ESP_ERROR_CHECK(uart_driver_install(UART_NUM_0, 256, 8192, 0, NULL, 0));
    esp_vfs_dev_uart_use_driver(UART_NUM_0);
    f2_app_mutex = xSemaphoreCreateMutex();
    hal_esp32_legs_enable();
    hal_esp32_sensors_init();
    hal_esp32_servo_init();
    hal_esp32_k210_init();

#if ALMA_F2_API
    double tod = f2_net_start();   /* hueco 16: hora real por SNTP; si no responde, 8:00 como sin red */
    if (tod >= 0) app_preset_clock(tod);
    hal_heap_mark("red");
#endif
    /* alma_catalog ocupa ~215 KB: va en la PSRAM (02: chip de 8 MB, el ESP32 mapea 4 MB).
       PENDIENTE: 02. Que haya PSRAM se ve en la sesión 1 (tecla i de sesion1). */
    alma_catalog *cat = heap_caps_malloc(sizeof *cat, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!cat) hal_log("ERROR: sin PSRAM para el catálogo (%u bytes); solo consola", (unsigned)sizeof *cat);
    int ok = cat && app_init(catalog_json_start, cat, esp_random()) == 0;
    if (!ok) hal_log("ERROR: app_init falló; solo consola");
    hal_heap_mark("app_init");
    app_console_help();
#if ALMA_F2_API
    if (ok) f2_link_start();
    hal_heap_mark("enlace");
#endif
    TickType_t wake = xTaskGetTickCount();
    int64_t last_vivo = hal_now_ms();
    unsigned n_vivo = 0;
    for (;;) {
        uint8_t c;
        xSemaphoreTake(f2_app_mutex, portMAX_DELAY);
        hal_esp32_k210_pump();
        while (uart_read_bytes(UART_NUM_0, &c, 1, 0) == 1) {
            if (ok) app_console_key((char)c);   /* registra cada byte, \r y \n incluidos */
            else hal_log("tecla recibida 0x%02x, sin app (app_init falló)", c);
        }
        if (ok) app_step();
        if (hal_now_ms() - last_vivo >= 60000) {   /* ALMA_VIVO cada 60 s (sesion1a.md) */
            static const char *const ST[] = {"ST_BOOT", "ST_AWAKE", "ST_PERFORMING", "ST_RESTING", "ST_SLEEPING", "ST_LISTENING", "ST_REFLEX"};
            char hora[16] = "sin_hora", f[256];
            time_t now = time(NULL);
            struct tm lt;
            localtime_r(&now, &lt);
            if (lt.tm_year + 1900 >= 2025) strftime(hora, sizeof hora, "%H:%M:%S", &lt);
            /* heap y heap_min de vivo_line siguen como en 1A (MALLOC_CAP_INTERNAL) para comparar; heap8, heap8_min y
               bloque son la medida de la meta (RAM-PROPUESTA.md, C) */
            const uint32_t caps8 = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
            snprintf(f, sizeof f, "estado=%s on_charger=%d wifi=%s hora=%s k210_rx=%lu k210=%s heap8=%u heap8_min=%u bloque=%u",
                     ok ? ST[app_alma()->state] : "-", ok ? app_alma()->on_charger : -1,
#if ALMA_F2_API
                     f2_net_ip(),
#else
                     "-",
#endif
                     hora, (unsigned long)k210_rx_count(), k210_state_name(), (unsigned)heap_caps_get_free_size(caps8),
                     (unsigned)heap_caps_get_minimum_free_size(caps8), (unsigned)heap_caps_get_largest_free_block(caps8));
            vivo_line(f);
            if (n_vivo++ % 10 == 0) stacks_line();   /* con el primer ALMA_VIVO y después cada 10 min */
            last_vivo = hal_now_ms();
        }
        xSemaphoreGive(f2_app_mutex);
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(F2_STEP_MS));
    }
}
