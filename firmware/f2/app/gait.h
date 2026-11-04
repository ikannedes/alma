/* gait — primitivas de marcha de los .mot: 1 caminar, 2 girar en el sitio, 14 balanceo (HALLAZGOS §5 [BOBBY-ARTE]).
 * Son osciladores: ángulo = 90 + round(A · sin(fase + φ) + O), una muestra cada GAIT_TS_MS, fase += 2π / N con
 * N = T / 20. Portable: se prueba en la PC contra la referencia. */
#pragma once
#include <stdint.h>

#include "mot.h"

#define GAIT_TS_MS 20

typedef struct {
    double phase[4];          /* fase de cada oscilador (rad); sigue de un registro al siguiente */
    int A[4], O[4];
    double ph[4];
    unsigned N;               /* muestras por ciclo */
    long total, done;         /* muestras del registro y las ya dadas (sin la vuelta a 90) */
    int home_n, home_k;       /* vuelta a 90/90/90/90 en T/2 (direcciones 101/102) */
    float home_step[4];
    int home_start[4], last[4];
    int dir;                  /* +1 adelante, −1 atrás, 0 en el sitio */
} gait_state;

/* 1 si el tipo de cuadro es una primitiva que gait sabe ejecutar */
int  gait_supported(uint8_t type);
/* Prepara un registro; cur = ángulos actuales S0..S3 (para la vuelta a 90). 0 si se puede, −1 si no. */
int  gait_begin(gait_state *g, const mot_frame *f, const int cur[4]);
/* Siguiente muestra: deja S0..S3 en out y devuelve 1; 0 si el registro terminó. */
int  gait_next(gait_state *g, int out[4]);
/* Pie en el aire en la muestra actual: 0 izquierdo, 1 derecho, −1 los dos apoyados. PENDIENTE: 02. Qué signo del
   balanceo levanta cada pie se confirma viendo a EMO; si fuera al revés, la regla del borde se detiene de más. */
int  gait_swing_foot(const gait_state *g);
