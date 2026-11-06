/* battery — tensión y porcentaje de la batería a partir del pin GPIO39 (02, [BOBBY-ARTE]). Portable: se prueba en la PC. */
#pragma once
#include <stdint.h>

/* mV en el pin (divisor 1:2) → mV de la batería: 2·mV + 50 sin cargar, 2·mV − 130 cargando */
int battery_mv(int pin_mv, int charging);
/* Porcentaje con las tablas del original (sin cargar 3529/3589/3669/3999 mV → 20/40/60/100 %; cargando, 100 mV más).
   Entre puntos, lineal; por debajo de 20 %, lineal hasta 0 % a 3400 mV (cargando 3500). Ambas cosas son DERIVADO. */
float battery_pct(int bat_mv, int charging);

/* ¿Qué cargador es? (dueño, 2026-11-06: "que lo sepa al 100 %"). present: GPIO36 dice que hay corriente; rx0: RX0 en
 * alto (con el cable USB, pero en la Home Station también); base: lo que anuncia alma-base (1 = EMO se carga en ella,
 * 0 = no, −1 = no sé); present_ms: desde cuándo hay corriente. Devuelve 0 nada, 1 Home Station, 2 USB, o −1 = espera
 * (hay corriente, la base dice que no, pero su anuncio puede venir atrasado: se decide hasta BASE_LAG_MS). */
#define BASE_LAG_MS 6000
int battery_charger_kind(int present, int rx0, int base, int64_t present_ms);
