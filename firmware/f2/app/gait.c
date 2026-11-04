#include "gait.h"

#include <math.h>
#include <string.h>

/* El original trabaja en simple precisión: π = 3.1415925f y 2π = (double)(float)0x40c90fda (HALLAZGOS §5) */
static double deg2rad(int deg) { return (double)((float)deg * 3.1415925f / 180.0f); }
static double two_pi(void)
{
    uint32_t b = 0x40c90fdau;
    float f;
    memcpy(&f, &b, 4);
    return (double)f;
}
static int sgn200(int b) { return b > 200 ? 200 - b : b; }   /* un byte > 200 significa negativo (200 − x) */

/* +1 si un balanceo positivo de los pies levanta el pie derecho (ver gait.h). −1: DERIVADO en el robot, 2026-10-30:
   W, S, A y D van a donde dicen y explore_foward1 levanta primero el pie derecho; con los cuatro servos invertidos
   respecto al simulador (mot_studio_3d), un balanceo positivo levanta el izquierdo. Falta verlo con los sensores de piso. */
#define GAIT_POSITIVE_LIFTS_RIGHT -1
/* El pie cuenta "en el aire" cuando el balanceo pasa la mitad de su amplitud (DERIVADO) */
#define GAIT_SWING_FRACTION 0.5

int gait_supported(uint8_t type) { return type == 1 || type == 2 || type == 14; }

static void set_phase_all(gait_state *g, int deg)
{
    double p = (double)deg / 360.0 * two_pi();
    for (int i = 0; i < 4; i++) g->phase[i] = p;
}

int gait_begin(gait_state *g, const mot_frame *f, const int cur[4])
{
    if (!gait_supported(f->mode)) return -1;
    unsigned N = (unsigned)f->ms / GAIT_TS_MS;
    if (N == 0) return -1;   /* el original dividiría por cero; ningún .mot real lo tiene */
    const uint8_t *p = f->gp;   /* bytes 6..12 del registro */
    float steps = (float)p[0] / 10.0f;
    int n3 = p[1], n4 = p[2], n5 = p[3], dir = p[4], n7 = sgn200(p[5]), n8 = sgn200(p[6]);
    memset(g->A, 0, sizeof g->A);
    memset(g->O, 0, sizeof g->O);
    memset(g->ph, 0, sizeof g->ph);
    g->dir = 0;
    switch (f->mode) {
    case 1:   /* caminar */
        set_phase_all(g, n4);
        g->A[0] = g->A[1] = n7;
        g->A[2] = g->A[3] = n8;
        g->O[2] = n3;
        g->O[3] = -n3;
        if (dir == 1 || dir == 101) { g->ph[2] = g->ph[3] = deg2rad(-90); g->dir = 1; }    /* probable: adelante */
        if (dir == 2 || dir == 102) { g->ph[2] = g->ph[3] = deg2rad(90); g->dir = -1; }    /* probable: atrás */
        break;
    case 2:   /* girar en el sitio */
        set_phase_all(g, n4);
        g->A[0] = g->A[1] = 30;
        g->A[2] = g->A[3] = n5;
        g->O[2] = n3;
        g->O[3] = -n3;
        g->ph[2] = g->ph[3] = deg2rad(-90);
        if (dir == 1 || dir == 101) { g->A[0] = n7; g->A[1] = n8; }
        if (dir == 2 || dir == 102) { g->A[0] = n8; g->A[1] = n7; }
        break;
    case 14:  /* balanceo: solo los pies */
        set_phase_all(g, n4);
        g->A[2] = g->A[3] = n3;
        g->O[2] = n3 / 2;
        g->O[3] = -(n3 / 2);
        break;
    }
    g->N = N;
    /* como el original: ciclos enteros de N muestras y, si sobra fracción, las muestras i con i < fracción · N */
    int cycles = (int)steps;
    float frac = steps - (float)cycles;
    long extra = 0;
    if (frac > 0.0f)
        while ((double)extra < (double)frac * (double)N) extra++;
    g->total = (long)cycles * N + extra;
    g->done = 0;
    g->home_n = (f->mode != 14 && (dir == 101 || dir == 102)) ? (f->ms / 2) / GAIT_TS_MS : 0;
    g->home_k = 0;
    memcpy(g->last, cur, sizeof g->last);
    return 0;
}

int gait_next(gait_state *g, int out[4])
{
    if (g->done < g->total) {
        double inc = two_pi() / (double)g->N;
        for (int s = 0; s < 4; s++) {
            double v = (double)(float)g->A[s] * sin(g->phase[s] + g->ph[s]) + (double)g->O[s];
            g->last[s] = (int)round(v) + 90;
            g->phase[s] += inc;
        }
        g->done++;
        memcpy(out, g->last, sizeof g->last);
        return 1;
    }
    if (g->home_k < g->home_n) {   /* vuelta a 90 en T/2, lineal, como una pose */
        if (g->home_k == 0)
            for (int s = 0; s < 4; s++) {
                g->home_start[s] = g->last[s];
                g->home_step[s] = (float)((double)(90 - g->home_start[s]) / (double)g->home_n);
            }
        g->home_k++;
        for (int s = 0; s < 4; s++) g->last[s] = (int)((float)g->home_start[s] + (float)g->home_k * g->home_step[s]);
        memcpy(out, g->last, sizeof g->last);
        return 1;
    }
    return 0;
}

int gait_swing_foot(const gait_state *g)
{
    if (g->done == 0 || g->home_k > 0 || g->A[2] == 0) return -1;
    /* balanceo de los pies en la última muestra: los dos pies comparten amplitud y fase; solo cambia el desvío */
    double roll = (double)(g->last[2] - 90 - g->O[2]);
    if (fabs(roll) < GAIT_SWING_FRACTION * fabs((double)g->A[2])) return -1;
    int right = (roll > 0) == (GAIT_POSITIVE_LIFTS_RIGHT > 0);
    return right ? 1 : 0;
}
