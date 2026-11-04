#include "sense.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "f2_hal.h"

/* ---- piso (HALLAZGOS §2, "Sensores de pie" [BOBBY-ARTE]) ---- */
#define FLOOR_INIT       0x7FF
#define FLOOR_MAX_FAILS  5        /* el original acepta la lectura a la 5.ª; después, Alma da "sin dato" */
#define FLOOR_LEARN_MS   100      /* la línea base se aprende cada 100 ms, con los pies planos */
#define FLOOR_STABLE     14       /* una lectura que se mueve más que esto reinicia el aprendizaje */
#define FLOOR_SAMPLES    30       /* 30 lecturas estables (~3 s) fijan el umbral */
/* 0x41 = pie izquierdo y 0x40 = derecho es INFERIDO (cliff_L / cliff_R). A41 y B40 son el mismo extremo de cada pie
   (el orden A/B está espejado entre chips). MEDIDO en el robot, 2026-10-30: de frente al borde (puntas fuera) pierden el
   piso B41 y A40; de espaldas, A41 y B40. Adelante es B41/A40. */
#define FLOOR_A41_IS_FRONT 0

void sense_floor_init(sense_floor *f)
{
    memset(f, 0, sizeof *f);
    for (int i = 0; i < 4; i++) f->v[i] = FLOOR_INIT;
}

void sense_floor_update(sense_floor *f, const int raw[4], int feet_flat)
{
    for (int i = 0; i < 4; i++) {
        if (raw[i] < 0) { f->fails[i]++; continue; }
        f->fails[i] = 0;
        f->v[i] = 80 * f->v[i] / 100 + raw[i] / 5;
    }
    if ((f->learn_ms += SENSE_TICK_MS) < FLOOR_LEARN_MS) return;
    f->learn_ms = 0;
    if (!feet_flat) return;
    for (int i = 0; i < 4; i++) {
        int v = f->v[i];
        if (f->fails[i] || v <= 50 || v > FLOOR_INIT) continue;   /* sin reflejo o inválida: no se aprende */
        if (f->n[i] == 0 || abs(v - f->last[i]) > FLOOR_STABLE) {
            f->sum[i] = v; f->n[i] = 1; f->total[i] = 0;
        } else {
            f->sum[i] += v; f->n[i]++;
            if (++f->total[i] >= FLOOR_SAMPLES) {
                int mean = (int)(f->sum[i] / f->n[i]);
                f->thr[i] = mean > 1200 ? mean * 65 / 100 : mean * 3 / 10;
                f->sum[i] = v; f->n[i] = 1; f->total[i] = 0;
            }
        }
        f->last[i] = v;
    }
}

static int chan(const sense_floor *f, int i)
{
    if (f->fails[i] >= FLOOR_MAX_FAILS || f->v[i] > FLOOR_INIT || f->thr[i] == 0) return -1;
    return f->v[i] >= f->thr[i];
}

void sense_floor_out(const sense_floor *f, int floor[2][2])
{
    int front_l = FLOOR_A41_IS_FRONT ? SENSE_A41 : SENSE_B41, rear_l = FLOOR_A41_IS_FRONT ? SENSE_B41 : SENSE_A41;
    int front_r = FLOOR_A41_IS_FRONT ? SENSE_B40 : SENSE_A40, rear_r = FLOOR_A41_IS_FRONT ? SENSE_A40 : SENSE_B40;
    floor[HAL_FOOT_L][HAL_FLOOR_FRONT] = chan(f, front_l);
    floor[HAL_FOOT_L][HAL_FLOOR_REAR] = chan(f, rear_l);
    floor[HAL_FOOT_R][HAL_FLOOR_FRONT] = chan(f, front_r);
    floor[HAL_FOOT_R][HAL_FLOOR_REAR] = chan(f, rear_r);
}

int sense_floor_all(const sense_floor *f, int lim, int above)
{
    for (int i = 0; i < 4; i++) {
        if (f->fails[i] >= FLOOR_MAX_FAILS || f->v[i] > FLOOR_INIT) return 0;
        if (above ? f->v[i] <= lim : f->v[i] > lim) return 0;
    }
    return 1;
}

/* ---- IMU (HALLAZGOS §4, "IMU" [BOBBY-ARTE]). Ventanas, umbrales y máquinas como el original. DERIVADO: la
   inclinación sale de la gravedad medida (el acelerómetro sin paso alto), no de la fusión con el giróscopo. ---- */
#define IMU_LP          0.2f      /* filtro de la gravedad: ~50 ms */
#define SHAKE_ON        8000.0f   /* desviación de una ventana (≈ 0.39 g por muestra) */
#define SHAKE_OFF       3000.0f
#define SHAKE_TICKS     50        /* 500 ms */
#define AIR_TICKS       20        /* 200 ms */
#define TIP_TICKS       20
#define GROUND_TICKS    30        /* 300 ms */

void sense_imu_init(sense_imu *m) { memset(m, 0, sizeof *m); }

static int feet_known(const sense_floor *fl)
{
    for (int i = 0; i < 4; i++) if (fl->fails[i] >= FLOOR_MAX_FAILS || fl->v[i] > FLOOR_INIT) return 0;
    return 1;
}

void sense_imu_update(sense_imu *m, const int16_t acc[3], int ok, const sense_floor *fl)
{
    if (!ok) return;
    float a[3] = {(float)(acc[0] >> 2), (float)(acc[1] >> 2), (float)(acc[2] >> 2)};   /* 1/1024 g */
    if (!m->have_g) { memcpy(m->g, a, sizeof a); m->have_g = 1; }
    for (int i = 0; i < 3; i++) m->g[i] += IMU_LP * (a[i] - m->g[i]);
    float na = sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]), ng = sqrtf(m->g[0] * m->g[0] + m->g[1] * m->g[1] + m->g[2] * m->g[2]);
    if (na > 1 && ng > 1) {
        float cx = a[1] * m->g[2] - a[2] * m->g[1], cy = a[2] * m->g[0] - a[0] * m->g[2], cz = a[0] * m->g[1] - a[1] * m->g[0];
        m->resid = sqrtf(cx * cx + cy * cy + cz * cz) / (na * ng);
        float s = m->g[2] / ng;
        if (s > 1) s = 1;
        if (s < -1) s = -1;
        m->A = (int)lroundf(asinf(s) * 57.29578f);                       /* adelante/atrás (eje del chip por confirmar) */
        m->B = (int)lroundf(atan2f(m->g[0], m->g[1]) * 57.29578f);       /* de lado; boca abajo da ±180 */
    }
    for (int i = 0; i < 3; i++) m->win[i][m->wi] = a[i];
    if (++m->wi == 20) {
        m->wi = 0;
        for (int i = 0; i < 3; i++) {
            float mean = 0, d = 0;
            for (int k = 0; k < 20; k++) mean += m->win[i][k];
            mean /= 20;
            for (int k = 0; k < 20; k++) d += fabsf(m->win[i][k] - mean);
            m->dev[i] = d;
        }
    }
    /* sacudido */
    int hi = m->dev[0] > SHAKE_ON || m->dev[1] > SHAKE_ON || m->dev[2] > SHAKE_ON;
    int lo = m->dev[0] < SHAKE_OFF && m->dev[1] < SHAKE_OFF && m->dev[2] < SHAKE_OFF;
    if (!m->shaken) { m->c_shake = hi ? m->c_shake + 1 : 0; if (m->c_shake >= SHAKE_TICKS) { m->shaken = 1; m->c_shake = 0; } }
    else if (lo) m->shaken = 0;
    /* levantado, volcado y dejado */
    int absA = abs(m->A), absB = abs(m->B);
    if (m->pose == SENSE_STAND) {
        int air = feet_known(fl) && sense_floor_all(fl, 99, 0) && absA <= 69 && absB <= 69;
        if (air) {
            m->c_tip = 0;
            if (++m->c_air >= AIR_TICKS) { m->c_air = m->c_ground = 0; m->pose = SENSE_AIR; }
        } else {
            m->c_air = 0;
            if (absA > 70 || absB > 70) {
                if (++m->c_tip >= TIP_TICKS) {
                    m->c_tip = 0;
                    /* con los pies sin dato no se puede exigir "pies ≤ 499": se acepta igual (DERIVADO) */
                    if (!feet_known(fl) || sense_floor_all(fl, 499, 0)) { m->pose = SENSE_TIPPED; m->c_ground = 0; }
                }
            } else m->c_tip = 0;
        }
    } else {
        int ground = feet_known(fl) && sense_floor_all(fl, 100, 1);
        int quiet = m->dev[0] < 50 && m->dev[1] < 50 && m->dev[2] < 50 && m->resid < 0.05f;
        int still = quiet && absA <= 9 && absB <= 9;
        /* dueño, 2026-10-30: levantado y luego dejado acostado (de lado o boca abajo) no pasaba nunca a volcado. Quieto
           y con más de 70° durante 200 ms, es volcado; quieto exige que no sea la mano que lo sostiene */
        if (m->pose == SENSE_AIR && quiet && (absA > 70 || absB > 70)) {
            if (++m->c_tip >= TIP_TICKS) { m->c_tip = m->c_ground = 0; m->pose = SENSE_TIPPED; return; }
        } else if (m->pose == SENSE_AIR) m->c_tip = 0;
        if (ground || still) {
            if (++m->c_ground >= GROUND_TICKS) { m->c_ground = m->c_air = m->c_tip = 0; m->pose = SENSE_STAND; }
        } else m->c_ground = 0;
    }
}

/* ---- toque (HALLAZGOS §3, "Toque" [BOBBY-ARTE]) ---- */
static const double TOUCH_THR[3] = {50, 30, 30};   /* T7: tou_lev de NVS, 50 si no está (Alma no lee la NVS); T8, T9: 30 */
static const int TOUCH_MIN_MS[3] = {150, 200, 200};

void sense_touch_init(sense_touch *t) { memset(t, 0, sizeof *t); }

void sense_touch_update(sense_touch *t, const int raw[3])
{
    if (!t->init) {
        for (int i = 0; i < 3; i++) if (raw[i] < 0) return;
        for (int i = 0; i < 3; i++) t->base[i] = raw[i];   /* base inicial = primera lectura */
        t->init = 1;
        return;
    }
    t->clock_ms += SENSE_TICK_MS;
    for (int i = 0; i < 3; i++) {
        if (raw[i] < 0) continue;
        int touched = (double)raw[i] < t->base[i] - TOUCH_THR[i];
        if (!touched) {
            t->base[i] = (49.0 * t->base[i] + raw[i]) / 50.0;   /* la base solo sigue sin tocar */
            /* soltado: un toque confirmado que no llegó a caricia es un golpecito (DERIVADO: el original no los distingue) */
            if (t->held_ms[i] >= TOUCH_MIN_MS[i] && !t->pet_sent[i]) {
                t->taps++;
                for (int k = SENSE_STROKE_TAPS - 1; k > 0; k--) t->stroke_t[k] = t->stroke_t[k - 1];
                t->stroke_t[0] = t->clock_ms;
                if (t->taps >= SENSE_STROKE_TAPS && t->clock_ms - t->stroke_t[SENSE_STROKE_TAPS - 1] <= SENSE_STROKE_MS) {
                    t->pets++;   /* pasadas seguidas: caricia, y la ventana empieza de nuevo */
                    for (int k = 0; k < SENSE_STROKE_TAPS; k++) t->stroke_t[k] = -SENSE_STROKE_MS - 1;
                }
            }
            t->held_ms[i] = 0;
            t->pet_sent[i] = 0;
            continue;
        }
        t->held_ms[i] += SENSE_TICK_MS;
        if (t->held_ms[i] >= SENSE_PET_MS && !t->pet_sent[i]) { t->pets++; t->pet_sent[i] = 1; }
    }
}
