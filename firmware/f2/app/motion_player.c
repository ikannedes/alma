#include "motion_player.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "f2_config.h"
#include "f2_hal.h"
#include "gait.h"
#include "perception.h"

/* PENDIENTE: 02. Hipótesis DERIVADA del original (sesion1): S0..S3 en el orden interno de los servos. */
int motion_s_to_servo[4] = {0, 1, 2, 3};
/* R10: rango observado por Sn en los 317 .mot (02) */
static const uint8_t MOT_MIN[4] = {40, 53, 0, 30}, MOT_MAX[4] = {160, 130, 150, 180};

static struct {
    int active;
    const alma_motion_opt *opt;
    int chain_i;
    char name[ALMA_MOT_LEN];
    mot_frame f[MOTION_MAX_FRAMES];
    int n, k;
    int held;            /* la pose del cuadro actual ya se mandó exacta y solo se sostiene */
    int64_t frame_t0;
    float from[4];
    gait_state g;        /* primitiva de marcha en curso (gait.c) */
    int gait_on;
    long gait_n;         /* muestras ya mandadas de la primitiva */
} P EXT_RAM_BSS_ATTR;
static float cur[HAL_SERVOS] = {NAN, NAN, NAN, NAN};
static float tempo_next = 1.0f, tempo = 1.0f;
static int gpio26_locked;
static int all_released;   /* motion_release_all: los 4 sin pulsos hasta el siguiente comando */
static uint32_t skipped, gait_frames, gait_stops;
static motion_frame_cb frame_cb;

static int spiffs_rd(void *ctx, uint32_t off, void *buf, size_t n) { (void)ctx; return hal_spiffs_read(off, buf, n); }

void motion_path(const char *name, char out[40])
{
    snprintf(out, 40, "/mot/%s.mot", name);
    if (strlen(out) > 32) out[32] = 0;   /* 02: algunos nombres llenan los 32 bytes sin \0 */
}

/* "<mot>_half" (dueño, 2026-11-02: "la mitad de la rutina del giro, hace 4 pasos el original, puedes hacer sólo 2"):
   el .mot de la SPIFFS con la mitad de los ciclos en cada primitiva de marcha. Se arma aquí, sin escribir la SPIFFS */
#define HALF_SUFFIX "_half"
/* "<mot>_alto" (dueño, 2026-11-03: "no puede subir solo" al empezar la rampa de la base): en cada paso de caminar (marcha
   1) el balanceo de los pies (n8, el que levanta el pie) × 1.5: de 10 a 15, como en otros .mot de fábrica (zombie, obstáculos
   15–16). R10 sigue revisando el rango al reproducirlo */
#define HIGH_SUFFIX "_alto"

static int has_suffix(const char *name, const char *suf, char *base, size_t cap)
{
    size_t ln = strlen(name), ls = strlen(suf);
    if (ln <= ls || ln - ls >= cap || strcmp(name + ln - ls, suf) != 0) return 0;
    memcpy(base, name, ln - ls);
    base[ln - ls] = 0;
    return 1;
}

int motion_load(const char *name, mot_frame *out, int max)
{
    static EXT_RAM_BSS_ATTR uint8_t raw[MOTION_MAX_FRAMES * MOT_FRAME_LEN];
    char path[40], base[40];
    if (has_suffix(name, HIGH_SUFFIX, base, sizeof base)) {
        int n = motion_load(base, out, max);
        for (int k = 0; k < n; k++)
            if (out[k].mode == 1) {
                int b = out[k].gp[6], v = b > 200 ? 200 - b : b;   /* como sgn200 de gait.c */
                v = v * 3 / 2;
                out[k].gp[6] = (uint8_t)(v < 0 ? 200 - v : v);
            }
        return n;
    }
    if (has_suffix(name, HALF_SUFFIX, base, sizeof base)) {
        int n = motion_load(base, out, max);
        for (int k = 0; k < n; k++)
            if (gait_supported(out[k].mode) && out[k].steps10 >= 2) out[k].gp[0] = out[k].steps10 = (uint8_t)(out[k].steps10 / 2);
        return n;
    }
    motion_path(name, path);
    long n = spiffs_find(spiffs_rd, NULL, hal_spiffs_size(), path, raw, sizeof raw);
    if (n <= 0 || n % MOT_FRAME_LEN || n / MOT_FRAME_LEN > max) return -1;
    for (long k = 0; k < n / MOT_FRAME_LEN; k++)
        if (mot_parse_frame(raw + k * MOT_FRAME_LEN, &out[k])) return -1;
    return (int)(n / MOT_FRAME_LEN);
}

#if ALMA_SERVOS_DISABLED
#define servo_cmd(idx, deg) ((void)(idx), (void)(deg))   /* variante remota: sin comandos de servo */
#else
static void servo_cmd(int idx, float deg)
{
    if (idx == HAL_SERVO_GPIO26 && gpio26_locked) {
        /* 04, regla del ejecutor sin excepciones: cortar la grabación y restaurar GPIO26 antes de mover */
        hal_audio_stop();
        hal_servo_restore(HAL_SERVO_GPIO26);
        gpio26_locked = 0;
        hal_log("motion: GPIO26 restaurado antes de mover (regla del ejecutor, 04)");
    }
    all_released = 0;
    hal_servo_set(idx, deg);
    cur[idx] = deg;
}
#endif

/* R10 también para las primitivas: se simula cada una y ningún ángulo puede salir del rango observado */
static int gait_in_range(const mot_frame *f, int *bad_s, int *bad_v)
{
    static gait_state g;
    int c[4] = {90, 90, 90, 90}, a[4];
    if (gait_begin(&g, f, c)) return 1;
    while (gait_next(&g, a))
        for (int s = 0; s < 4; s++)
            if (a[s] < MOT_MIN[s] || a[s] > MOT_MAX[s]) { *bad_s = s; *bad_v = a[s]; return 0; }
    return 1;
}

static int load_current(void)
{
    snprintf(P.name, sizeof P.name, "%s", P.opt->mot[P.chain_i]);
    P.n = motion_load(P.name, P.f, MOTION_MAX_FRAMES);
    if (P.n <= 0) { hal_log("motion: no pude leer %s", P.name); return MOTION_REFUSED_FILE; }
    for (int k = 0; k < P.n; k++)
        if (P.f[k].mode == MOT_MODE_POSE)
            for (int s = 0; s < 4; s++)
                if (P.f[k].s[s] < MOT_MIN[s] || P.f[k].s[s] > MOT_MAX[s]) {
                    hal_log("motion: %s cuadro %d S%d=%u fuera del rango observado (R10): no se reproduce", P.name, k, s, P.f[k].s[s]);
                    return MOTION_REFUSED_RANGE;
                }
    for (int k = 0; k < P.n; k++) {
        int s, v;
        if (gait_supported(P.f[k].mode) && !gait_in_range(&P.f[k], &s, &v)) {
            hal_log("motion: %s cuadro %d (marcha %02x) llevaría S%d a %d, fuera del rango observado (R10): no se reproduce",
                    P.name, k, P.f[k].mode, s, v);
            return MOTION_REFUSED_RANGE;
        }
    }
    P.k = 0;
    P.gait_on = 0;
    P.held = 0;
    P.frame_t0 = hal_now_ms();
    for (int s = 0; s < 4; s++) {
        float c = cur[motion_s_to_servo[s]];
        P.from[s] = isnan(c) ? 90.0f : c;   /* un servo nunca mandado parte de 90° (neutro, 02) */
    }
    return MOTION_OK;
}

motion_result motion_play(const alma_motion_opt *o, int on_charger, int over_budget)
{
    motion_stop_now();
    tempo = tempo_next;   /* se gasta aunque se rechace */
    tempo_next = 1.0f;
#if ALMA_SERVOS_DISABLED
    (void)o; (void)on_charger; (void)over_budget;
    hal_log("motion: servos deshabilitados al compilar (variante remota)");
    return MOTION_REFUSED_DISABLED;
#endif
    /* R14. Con ALMA_DEV_MOTION_ON_USB la app ya pasa on_charger = 0 con el USB (app.c); en la Home Station no se mueve:
       moverse ahí soltaba los contactos (2026-11-03, gohome_connect tras una caricia: "cargador: USB", "sin cargador") */
    if (on_charger) { hal_log("motion: cargando, sin servos (R14)"); return MOTION_REFUSED_CHARGING; }
    if (over_budget) { hal_log("motion: presupuesto de servos agotado (budget_s)"); return MOTION_REFUSED_BUDGET; }
    P.opt = o;
    P.chain_i = 0;
    int r = load_current();
    if (r) return (motion_result)r;
    P.active = 1;
    hal_log("motion: %s (%d cuadros)%s", P.name, P.n, o->n > 1 ? " en cadena" : "");
    return MOTION_OK;
}

void motion_step(void)
{
    if (!P.active) return;
    int64_t now = hal_now_ms();
    while (P.active) {
        const mot_frame *f = &P.f[P.k];
        int64_t dt = now - P.frame_t0;
        int pose = f->mode == MOT_MODE_POSE;
        /* [BOBBY-ARTE] (HALLAZGOS §5): la pose se alcanza en `ms` (transición lineal) y pasa al siguiente cuadro; 90 es
           un ángulo. Las primitivas 1, 2 y 14 corren en gait.c, una muestra cada 20 ms */
        if (gait_supported(f->mode)) {
            if (!P.gait_on) {
                int c[4];
                for (int s = 0; s < 4; s++) c[s] = (int)lroundf(P.from[s]);
                mot_frame t = *f;
                if (tempo < 1.0f && (f->mode == 1 || f->mode == 2) && f->ms > MOTION_RUN_MIN_MS) {
                    long ms = lroundf(f->ms * tempo);
                    t.ms = (uint16_t)(ms < MOTION_RUN_MIN_MS ? MOTION_RUN_MIN_MS : ms);
                }
                gait_begin(&P.g, &t, c);   /* ya validada al cargar; el periodo no cambia los ángulos */
                P.gait_on = 1;
                P.gait_n = 0;
                gait_frames++;
            }
            int a[4], more = 1;
            while (P.gait_n * GAIT_TS_MS <= dt && (more = gait_next(&P.g, a))) {
                P.gait_n++;
                perception_set_gait(P.g.dir, gait_swing_foot(&P.g));
                /* regla del dueño (2026-10-29): con borde hacia donde va, se detiene en el acto; se puede caer */
                if ((P.g.dir > 0 && perception_forward_blocked()) || (P.g.dir < 0 && perception_backward_blocked())) {
                    gait_stops++;
                    hal_log("motion: %s cuadro %d: %s, la marcha se detiene", P.name, P.k, P.g.dir > 0 ? "borde u obstáculo adelante" : "borde atrás");
                    motion_stop_now();
                    return;
                }
                for (int s = 0; s < 4; s++) servo_cmd(motion_s_to_servo[s], (float)a[s]);
            }
            if (more) return;   /* faltan muestras */
            for (int s = 0; s < 4; s++) P.from[s] = (float)P.g.last[s];
            perception_set_gait(0, -1);
            P.gait_on = 0;
            if (frame_cb) frame_cb(P.name, P.k, f, 1);
            P.frame_t0 += P.gait_n * GAIT_TS_MS;
            P.held = 0;
            if (++P.k < P.n) continue;
            if (++P.chain_i < P.opt->n) {
                int64_t t0 = P.frame_t0;
                if (load_current()) { P.active = 0; return; }
                P.frame_t0 = t0;
                continue;
            }
            P.active = 0;
            return;
        }
        int64_t len = mot_frame_ms(f);   /* pose: se mueve en ms y pasa al siguiente (282/290 .mot = su .avi) */
        if (dt < len) {
            if (pose && dt < f->ms) {
                float u = (float)dt / f->ms;
                for (int s = 0; s < 4; s++) servo_cmd(motion_s_to_servo[s], P.from[s] + (f->s[s] - P.from[s]) * u);
            } else if (pose && !P.held) {   /* llegó: la pose exacta una sola vez; después solo se sostiene */
                for (int s = 0; s < 4; s++) servo_cmd(motion_s_to_servo[s], f->s[s]);
                P.held = 1;
            }
            return;
        }
        if (pose) {
            for (int s = 0; s < 4; s++) {
                if (!P.held) servo_cmd(motion_s_to_servo[s], f->s[s]);   /* cuadro más corto que un paso del bucle */
                P.from[s] = f->s[s];
            }
        } else {
            skipped++;   /* tipos sin implementar (10, 11, 15…): se sostiene la pose */
            hal_log("motion: %s cuadro %d (modo %02x) sin implementar: se sostiene la pose %lu ms", P.name, P.k, f->mode,
                    (unsigned long)mot_frame_ms(f));
        }
        if (frame_cb) frame_cb(P.name, P.k, f, pose);
        P.frame_t0 += len;
        P.held = 0;
        if (++P.k < P.n) continue;
        if (++P.chain_i < P.opt->n) {
            int64_t t0 = P.frame_t0;
            if (load_current()) { P.active = 0; return; }
            P.frame_t0 = t0;   /* la cadena sigue sin hueco */
            continue;
        }
        P.active = 0;
    }
}

void motion_stop_now(void)
{
    if (P.active) hal_servo_hold_all();
    P.active = 0;
    if (P.gait_on) perception_set_gait(0, -1);
    P.gait_on = 0;
}

int motion_active(void) { return P.active; }

void motion_lock_gpio26(int locked)
{
    if (locked && !gpio26_locked) {
        if (P.active) motion_stop_now();
        hal_servo_release(HAL_SERVO_GPIO26);
        gpio26_locked = 1;
        hal_log("motion: GPIO26 bloqueado mientras escucha (04)");
    } else if (!locked && gpio26_locked) {
        hal_audio_stop();
        if (!all_released) hal_servo_restore(HAL_SERVO_GPIO26);   /* en la base sigue suelto */
        gpio26_locked = 0;
        hal_log("motion: GPIO26 restaurado");
    }
}

int motion_gpio26_locked(void) { return gpio26_locked; }

void motion_release_all(void)
{
    if (P.active || all_released) return;
    for (int i = 0; i < HAL_SERVOS; i++) hal_servo_release(i);
    all_released = 1;
    hal_log("motion: servos sueltos (en la base)");
}

int motion_all_released(void) { return all_released; }
void motion_boot(void) { all_released = 0; }
void motion_set_frame_cb(motion_frame_cb cb) { frame_cb = cb; }
void motion_set_tempo(float t) { tempo_next = t > 0 && t < 1.0f ? t : 1.0f; }
uint32_t motion_skipped_gait_frames(void) { return skipped; }
uint32_t motion_gait_frames(void) { return gait_frames; }
uint32_t motion_gait_stops(void) { return gait_stops; }
