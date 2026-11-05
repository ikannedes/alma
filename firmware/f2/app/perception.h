/* perception — traduce frames crudos del K210 y lecturas de sensores a eventos EV_* (01, 03).
 * La tabla de frames es configurable; todo frame que no esté en ella se registra con marca de tiempo. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "alma_core.h"
#include "f2_hal.h"
#include "k210_frames.h"

typedef enum {
    PERC_KNOWN,      /* conocido, sin evento (p. ej. 0x47: lo usa hal_k210) */
    PERC_EVENT,      /* produce `ev` */
} perc_action;

typedef struct {
    uint8_t cmd;             /* byte CMD del frame corto 55 AA CMD D0 D1 D2 CS */
    perc_action action;
    alma_ev_type ev;
    const char *status;      /* CONFIRMADO, CANDIDATO o PENDIENTE (03) */
    const char *what;
} perc_rule;

typedef void (*perc_emit_fn)(const alma_ev *ev);

/* Respuesta de cara del K210 (03, "Caras" [BOBBY-ARTE]): 55 AA FF 7C 00 0A CS + 124 bytes, enteros de 32 bits LE */
#define PERC_FACE_UNKNOWN_ID 255
typedef struct {
    int x, y, w, h;          /* esquina superior izquierda y tamaño, en píxeles de la cámara */
    int has_face;            /* +16: 1 = hay cara */
    int person_id;           /* +20: id del K210; 255 = desconocida */
    char name[32];           /* +24: nombre (solo para el registro) */
} perc_face;

/* 0 si p es el extendido 0x0A con al menos 24 bytes de carga; −1 si no */
int perception_parse_face(const uint8_t *p, size_t n, perc_face *out);

void perception_init(perc_emit_fn emit);
/* Cambia la tabla (por ejemplo, con lo que dé la sesión A1.3). n = 0 vuelve a la de omisión. */
void perception_set_table(const perc_rule *rules, int n);
/* Para k210_set_rx_handler */
void perception_on_frame(void *user, k210_rx_kind kind, const uint8_t *p, size_t n, int flags);
/* Flancos de los sensores; también deja la lectura para alma_tick */
void perception_poll_sensors(alma_sensors *for_tick);
/* el cargador es el USB (no la Home Station); lo da la última lectura de sensores */
int  perception_on_usb(void);
/* distancia de la cara (VL53L0X, mm; −1 sin sensor) */
int  perception_front_mm(void);
int  perception_tilt(float *a, float *b);   /* inclinación del IMU en grados (f2_hal.h); 0 si aún no hay lectura */

uint32_t perception_unknown_frames(void);
/* Bordes (regla del dueño, 2026-10-29): la marcha no debe avanzar hacia un lado bloqueado. */
int perception_forward_blocked(void);
int perception_backward_blocked(void);
void perception_leaving_base(int on);   /* bajándose de la base: la orilla de enfrente no frena (app.c) */
/* La marcha avisa: dir +1 de frente, −1 en reversa, 0 quieto; swing = pie en el aire (HAL_FOOT_L/R) o −1 */
void perception_set_gait(int dir, int swing);
uint32_t perception_face_changes(void);   /* cambios de quién está frente a la cámara */
int perception_edges_now(void);          /* bit 0 borde adelante, bit 1 atrás */
/* No avisar de bordes hasta until_ms; después se vuelve a evaluar desde cero (la app lo renueva durante cada
   movimiento de reflejo: hasta 500 ms después de que termine) */
void perception_hold_edges(int64_t until_ms);
uint32_t perception_gestures(int *last);   /* 3F recibidos (piedra-papel-tijera) y la clase del último */
/* El robot se está moviendo solo: hasta 700 ms después no avisa de sacudidas (salvo levantado). La app la llama en
   cada vuelta mientras motion_active() */
void perception_moving(int64_t now_ms);
uint32_t perception_face_hits(void);      /* respuestas de cara con "hay cara" */
int64_t perception_last_face(perc_face *out);   /* la última con cara y su hora (ms); −1 si ninguna */
/* La última respuesta real del K210 con cara (no las repetidas entre vistazos): *who = id conocido (≥ 0) o −2
   desconocida, ya con el seguimiento de la misma cara en el mismo lugar. Hora en ms, o −1 si ninguna */
int64_t perception_last_who(int *who);
