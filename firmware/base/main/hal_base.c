/* hal_base.c — lo del HAL del robot (f2_hal.h) que usan los módulos compartidos (enlace, OTA, registro), en la base:
 * reloj, registro (consola + Wi-Fi) y la escritura del firmware nuevo con su arranque a prueba. Lo de la OTA es el mismo
 * esquema del robot (main/hal_esp32.c): el bootloader de fábrica no tiene rollback, así que la partición anterior se
 * deja en RAM RTC y, si la nueva no llega al servidor en OTA_TRIAL_MS, vuelve a la anterior. */
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "esp_attr.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"

#include "f2_hal.h"
#include "rlog.h"

static SemaphoreHandle_t log_mx;

int64_t hal_now_ms(void) { return esp_timer_get_time() / 1000; }

/* consola y, siempre, por Wi-Fi (rlog): la base no tiene USB y su registro es lo único que se ve de ella */
void hal_log(const char *fmt, ...)
{
    static char line[384];
    if (!log_mx) log_mx = xSemaphoreCreateMutex();
    va_list ap;
    va_start(ap, fmt);
    xSemaphoreTake(log_mx, portMAX_DELAY);
    int o = snprintf(line, sizeof line, "[%10.3f] ", hal_now_ms() / 1000.0);
    vsnprintf(line + o, sizeof line - (size_t)o, fmt, ap);
    printf("%s\n", line);
    rlog_push(line);
    xSemaphoreGive(log_mx);
    va_end(ap);
}

long hal_rlog_take(char *out, size_t cap)
{
    if (!log_mx) return 0;
    xSemaphoreTake(log_mx, portMAX_DELAY);
    long n = rlog_take(out, cap);
    xSemaphoreGive(log_mx);
    return n;
}

/* ota.c para los servos del robot mientras llega el firmware; la base no tiene */
void motion_stop_now(void) {}

#define OTA_TRIAL_MAGIC 0xA1A0BA5Eu
static RTC_NOINIT_ATTR uint32_t ota_trial_magic, ota_trial_prev;
static esp_ota_handle_t ota_h;
static const esp_partition_t *ota_part, *ota_done;
static size_t ota_size;

int hal_ota_begin(size_t size)
{
    hal_ota_abort();
    ota_done = NULL;
    const esp_partition_t *p = esp_ota_get_next_update_partition(NULL);
    if (!p || size > p->size) return -1;
    if (esp_ota_begin(p, OTA_WITH_SEQUENTIAL_WRITES, &ota_h) != ESP_OK) return -1;
    ota_part = p;
    ota_size = size;
    return 0;
}

int hal_ota_write(const uint8_t *buf, size_t n) { return ota_part && esp_ota_write(ota_h, buf, n) == ESP_OK ? 0 : -1; }

void hal_ota_abort(void)
{
    if (ota_part) esp_ota_abort(ota_h);
    ota_part = NULL;
}

int hal_ota_end_and_check(const char *sha256_hex)
{
    const esp_partition_t *p = ota_part;
    ota_part = NULL;
    if (!p || esp_ota_end(ota_h) != ESP_OK) return -1;
    static uint8_t rb[2048];   /* el SHA-256 de lo que quedó en la flash, leído de vuelta */
    uint8_t sum[32];
    mbedtls_sha256_context c;
    mbedtls_sha256_init(&c);
    mbedtls_sha256_starts(&c, 0);
    for (size_t off = 0; off < ota_size; off += sizeof rb) {
        size_t k = ota_size - off < sizeof rb ? ota_size - off : sizeof rb;
        if (esp_partition_read(p, off, rb, k) != ESP_OK) { mbedtls_sha256_free(&c); return -1; }
        mbedtls_sha256_update(&c, rb, k);
    }
    mbedtls_sha256_finish(&c, sum);
    mbedtls_sha256_free(&c);
    char hex[65];
    for (int i = 0; i < 32; i++) snprintf(hex + 2 * i, 3, "%02x", sum[i]);
    if (strcmp(hex, sha256_hex)) return -1;
    ota_done = p;
    return 0;
}

void hal_ota_set_boot_and_restart(void)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    if (!ota_done || esp_ota_set_boot_partition(ota_done) != ESP_OK) { hal_log("ota: no se pudo cambiar el arranque"); return; }
    ota_trial_prev = run->address;
    ota_trial_magic = OTA_TRIAL_MAGIC;
    vTaskDelay(pdMS_TO_TICKS(300));
    esp_restart();
}

const char *hal_ota_running_label(void) { return esp_ota_get_running_partition()->label; }

static const esp_partition_t *ota_prev(void)
{
    esp_partition_iterator_t it = esp_partition_find(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_ANY, NULL);
    const esp_partition_t *r = NULL;
    for (; it && !r; it = esp_partition_next(it)) {
        const esp_partition_t *p = esp_partition_get(it);
        if (p->address == ota_trial_prev) r = p;
    }
    esp_partition_iterator_release(it);
    return r;
}

int hal_ota_trial(char *prev, size_t cap)
{
    if (ota_trial_magic != OTA_TRIAL_MAGIC) return 0;
    const esp_partition_t *p = ota_prev();
    if (!p || p->address == esp_ota_get_running_partition()->address) { ota_trial_magic = 0; return 0; }
    snprintf(prev, cap, "%s", p->label);
    return 1;
}

void hal_ota_trial_confirm(void) { ota_trial_magic = 0; }

void hal_ota_trial_revert(void)
{
    const esp_partition_t *p = ota_prev();
    ota_trial_magic = 0;
    if (!p || esp_ota_set_boot_partition(p) != ESP_OK) { hal_log("ota: no se pudo volver a la anterior; se queda"); return; }
    vTaskDelay(pdMS_TO_TICKS(300));
    esp_restart();
}
