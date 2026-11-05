/* hal_esp32.h — arranque de los periféricos del ESP32 que usa hal_esp32.c */
#pragma once
#include <stdint.h>

void hal_esp32_k210_init(void);
void ble_base_start(void);   /* ble_base.c, solo con ALMA_F2_BLE: escuchar a la Home Station */
void hal_esp32_k210_pump(void);       /* bytes del K210 → parser; en el bucle principal */
uint32_t hal_esp32_k210_overflow(void);
#include "f2_config.h"
void hal_esp32_sensors_init(void);   /* batería (GPIO39) y cargador (GPIO36) */
void hal_esp32_legs_enable(void);   /* GPIO0 en alto: habilitación de las patas (02, "new servo") */
#if ALMA_SERVOS_DISABLED
#define hal_esp32_servo_init() ((void)0)   /* variante remota: nada que iniciar */
#else
void hal_esp32_servo_init(void);
#endif
