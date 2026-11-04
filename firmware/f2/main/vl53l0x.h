/* vl53l0x — distancia de la cara (VL53L0X en 0x29), sobre el bus I2C ya abierto de los sensores. */
#pragma once

#define VL53_FAR 2000   /* sin eco o fuera de alcance: "lejos" */

int vl53_init(int i2c_port);   /* 0 = listo; < 0 = en qué paso falló */
int vl53_step(void);           /* una medición en pasos: mm nuevos o −1 si todavía no */
