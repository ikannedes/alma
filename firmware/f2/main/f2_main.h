#pragma once
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

extern SemaphoreHandle_t f2_app_mutex;
/* api_esp32.c, solo con ALMA_F2_API: Wi-Fi (R15) y SNTP antes de app_init; el servidor HTTP después.
 * f2_net_start devuelve la hora local en segundos desde la medianoche, o −1 si SNTP no respondió en 30 s. */
double f2_net_start(void);
void f2_link_start(void);   /* enlace con el servidor (uplink.h), en su propio hilo */
const char *f2_net_ip(void);   /* "a.b.c.d" o "sin" */
