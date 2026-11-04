/* motion_player — reproduce los .mot leídos de la SPIFFS en crudo (como sesion1): poses y las primitivas de marcha
 * 1, 2 y 14 (gait.c). Los demás tipos de primitiva no se ejecutan: se registran y la pose se sostiene esa duración.
 * Reglas: R10 (rango observado), R14 (sin servos cargando, salvo ALMA_DEV_MOTION_ON_USB), budget_s, y la regla
 * del ejecutor de 04 (antes de cualquier comando a un servo, cortar la grabación y restaurar GPIO26). */
#pragma once
#include <stdint.h>

#include "alma_core.h"
#include "mot.h"

#define MOTION_MAX_FRAMES 320   /* el .mot más largo del respaldo tiene 314 */

/* "/mot/<nombre>.mot", recortado a los 32 bytes de nombre de la SPIFFS (02) */
void motion_path(const char *name, char out[40]);
/* Lee y valida un .mot. Devuelve el número de cuadros, o −1 si no está o tiene un cuadro inválido. */
int  motion_load(const char *name, mot_frame *out, int max);

typedef enum { MOTION_OK = 0, MOTION_REFUSED_CHARGING, MOTION_REFUSED_BUDGET, MOTION_REFUSED_FILE, MOTION_REFUSED_RANGE, MOTION_REFUSED_DISABLED } motion_result;

/* Empieza una opción (un .mot o una cadena). on_charger y over_budget los da el ejecutor desde alma_t. */
motion_result motion_play(const alma_motion_opt *o, int on_charger, int over_budget);
/* Correr (dueño, 2026-10-30): el siguiente motion_play da los pasos y giros (1 y 2) con el periodo × tempo, sin bajar
 * de MOTION_RUN_MIN_MS (el original ya usa pasos de 100–300 ms en react_back_* y struggle_*). Vuelve a 1 después. */
#define MOTION_RUN_MIN_MS 300
void motion_set_tempo(float tempo);
void motion_step(void);            /* llamar cada F2_MOTION_STEP_MS o más seguido */
void motion_stop_now(void);        /* reflejo: corta y deja cada servo donde está */
/* En la base (dueño, 2026-11-03): los 4 servos sin fuerza, para que el cuerpo se asiente sobre la base inalámbrica. El
   siguiente comando a un servo los vuelve a activar. No hace nada si hay un movimiento en curso */
void motion_release_all(void);
int  motion_all_released(void);
void motion_boot(void);            /* al arrancar la app (servos activos otra vez) */
int  motion_active(void);

/* Escucha (04): GPIO26 bloqueado mientras dure ST_LISTENING */
void motion_lock_gpio26(int locked);
int  motion_gpio26_locked(void);

/* Pruebas: se llama al completar cada cuadro (pose alcanzada o paso/giro saltado) */
typedef void (*motion_frame_cb)(const char *mot, int frame, const mot_frame *f, int executed);
void motion_set_frame_cb(motion_frame_cb cb);

/* PENDIENTE: 02 (sesión 1, prueba d). Qué servo es cada Sn del .mot; índice de servo de f2_hal.h */
extern int motion_s_to_servo[4];
uint32_t motion_skipped_gait_frames(void);   /* cuadros de marcha de tipos sin implementar (pose sostenida) */
uint32_t motion_gait_frames(void);           /* primitivas 1, 2 y 14 ejecutadas (gait.c) */
uint32_t motion_gait_stops(void);            /* marchas detenidas por un borde (regla del dueño) */
