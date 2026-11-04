/* sense — de lecturas crudas a estados, cada SENSE_TICK_MS, como el firmware original (HALLAZGOS §3 y §4 [BOBBY-ARTE]).
 * Piso (sensores de los pies 0x40/0x41), IMU (levantado, dejado, volcado, sacudido) y toque (3 pads). Portable: la
 * plataforma pone las lecturas y lee los resultados; se prueba en la PC con señales armadas. */
#pragma once
#include <stdint.h>

#define SENSE_TICK_MS 10

/* ---- piso: 4 canales, en el orden del original: A y B de 0x41, A y B de 0x40 ---- */
enum { SENSE_A41, SENSE_B41, SENSE_A40, SENSE_B40 };
typedef struct {
    int v[4];                 /* filtrado: v = 0.8·v + 0.2·nuevo; 0x7FF al arrancar */
    int fails[4];             /* lecturas fallidas seguidas */
    int thr[4];               /* "sin piso" si v < thr; 0 = todavía no se aprendió la línea base */
    int last[4], n[4], total[4];
    long sum[4];
    int learn_ms;
} sense_floor;

void sense_floor_init(sense_floor *f);
/* raw = A41, B41, A40, B40 (−1 si el chip no contestó); feet_flat = los dos pies cerca de 90° (solo así se aprende) */
void sense_floor_update(sense_floor *f, const int raw[4], int feet_flat);
/* floor[pie][HAL_FLOOR_FRONT/REAR] como en f2_hal.h: 1 hay piso, 0 no, −1 sin dato */
void sense_floor_out(const sense_floor *f, int floor[2][2]);
/* 1 si los 4 canales tienen dato y todos ≤ lim (o todos > lim con above = 1) */
int  sense_floor_all(const sense_floor *f, int lim, int above);

/* ---- IMU (acelerómetro ±8 g, 4096 por g; eje Y vertical con EMO de pie) ---- */
typedef enum { SENSE_STAND, SENSE_AIR, SENSE_TIPPED } sense_pose;
typedef struct {
    float g[3];               /* gravedad estimada, 1/1024 g (filtro paso bajo) */
    int have_g;
    float win[3][20];         /* ventana de 20 muestras por eje */
    int wi;
    float dev[3];             /* suma de desviaciones absolutas en la última ventana (1/1024 g) */
    float resid;              /* |a_n × g_n|: 0 si la aceleración es solo gravedad */
    int A, B;                 /* inclinaciones en grados */
    sense_pose pose;
    int c_air, c_tip, c_ground, c_shake;
    int shaken;
} sense_imu;

void sense_imu_init(sense_imu *m);
/* acc = x, y, z crudos; ok = 0 si la lectura falló (no cambia nada) */
void sense_imu_update(sense_imu *m, const int16_t acc[3], int ok, const sense_floor *fl);

/* ---- toque: T7, T8, T9 ---- */
#define SENSE_PET_MS 1500     /* 01: EV_TOUCH_PET = toque sostenido ≥ 1500 ms */
#define SENSE_STROKE_TAPS 3   /* dueño, 2026-10-30: 3 pasadas en 4 s también son caricia (la mano entra y sale del pad) */
#define SENSE_STROKE_MS 4000
typedef struct {
    double base[3];
    int init, held_ms[3], pet_sent[3];
    int clock_ms, stroke_t[SENSE_STROKE_TAPS];   /* hora de los últimos golpecitos */
    int taps, pets;           /* contadores: la plataforma los convierte en flancos */
} sense_touch;

void sense_touch_init(sense_touch *t);
void sense_touch_update(sense_touch *t, const int raw[3]);   /* raw < 0 = sin lectura */
