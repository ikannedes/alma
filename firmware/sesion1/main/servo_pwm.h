/* Servos por PWM de 50 Hz. DERIVADO del firmware original (ota_0, 2026-10-28): MCPWM a 50 Hz en GPIO 21/25/5/26 y
   µs = 500 + grados · 2000 / 180 (90° = 1500 µs). El protocolo RMT de 02 solo configura y lee el servo.
   PENDIENTE: confirmarlo en la prueba d) de sesion1.md y pasarlo a 02. */
#pragma once
#include <stdbool.h>

#define SERVO_COUNT 4

/* Índice interno = orden del firmware original: 0 GPIO21 pierna izq., 1 GPIO25 pierna der., 2 GPIO5 pie izq., 3 GPIO26 pie der. */
extern const int SERVO_GPIO[SERVO_COUNT];
extern const char *const SERVO_NAME[SERVO_COUNT];

void servo_init(void);                         /* configura el temporizador; ningún pin queda activo */
int servo_index_of_gpio(int gpio);
/* Mueve en rampa de `step_deg` cada `step_ms`. Si el servo no estaba activo, arranca en `deg` directo.
   Devuelve false si se pidió paro. */
bool servo_ramp_to(int idx, float deg, float step_deg, int step_ms);
bool servo_set(int idx, float deg);            /* directo, dentro de los límites */
float servo_get(int idx);
void servo_request_stop(void);                 /* corta cualquier rampa en curso; los servos se quedan donde están */
void servo_clear_stop(void);
bool servo_stop_requested(void);
void servo_release_all(void);                  /* deja de mandar pulsos en los 4 pines */
