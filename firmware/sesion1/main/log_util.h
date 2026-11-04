/* Consola de la sesión: cada línea lleva [segundos.ms] desde el arranque; un mutex evita líneas mezcladas. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "esp_timer.h"

static inline int64_t now_ms(void) { return esp_timer_get_time() / 1000; }

void log_init(void);
void log_lock(void);
void log_unlock(void);
void log_ts(void);                               /* imprime "[   12.345] " (llamar con el mutex tomado) */
void log_hex(const uint8_t *p, size_t n);        /* " 55 aa ..." (llamar con el mutex tomado) */
void log_line(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
