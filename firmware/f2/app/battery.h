/* battery — tensión y porcentaje de la batería a partir del pin GPIO39 (02, [BOBBY-ARTE]). Portable: se prueba en la PC. */
#pragma once

/* mV en el pin (divisor 1:2) → mV de la batería: 2·mV + 50 sin cargar, 2·mV − 130 cargando */
int battery_mv(int pin_mv, int charging);
/* Porcentaje con las tablas del original (sin cargar 3529/3589/3669/3999 mV → 20/40/60/100 %; cargando, 100 mV más).
   Entre puntos, lineal; por debajo de 20 %, lineal hasta 0 % a 3400 mV (cargando 3500). Ambas cosas son DERIVADO. */
float battery_pct(int bat_mv, int charging);
