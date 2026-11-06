#pragma once
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

extern SemaphoreHandle_t f2_app_mutex;
/* api_esp32.c, solo con ALMA_F2_API: Wi-Fi (R15) y SNTP antes de app_init; el servidor HTTP después.
 * f2_net_start devuelve la hora local en segundos desde la medianoche, o −1 si SNTP no respondió en 30 s. */
double f2_net_start(void);
void f2_link_start(void);   /* enlace con el servidor (uplink.h), en su propio hilo */
const char *f2_net_ip(void);   /* "a.b.c.d" o "sin" */
/* ms desde la última señal de vida del hilo del enlace (main.c: si pasa de F2_LINK_STUCK_MS, reinicia) */
#define F2_LINK_STUCK_MS (10 * 60 * 1000)
int64_t f2_link_age_ms(void);
