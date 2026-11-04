#include "log_util.h"

#include <stdarg.h>
#include <stdio.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static SemaphoreHandle_t mtx;

void log_init(void) { mtx = xSemaphoreCreateRecursiveMutex(); }
void log_lock(void) { xSemaphoreTakeRecursive(mtx, portMAX_DELAY); }
void log_unlock(void) { fflush(stdout); xSemaphoreGiveRecursive(mtx); }

void log_ts(void)
{
    int64_t t = now_ms();
    printf("[%6lld.%03lld] ", t / 1000, t % 1000);
}

void log_hex(const uint8_t *p, size_t n)
{
    for (size_t i = 0; i < n; i++) printf(" %02x", p[i]);
}

void log_line(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    log_lock();
    log_ts();
    vprintf(fmt, ap);
    printf("\n");
    log_unlock();
    va_end(ap);
}
