/* repertorio.c — ver repertorio.h */
#include "repertorio.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "f2_hal.h"
#include "motion_player.h"
#include "outbox.h"
#include "perception.h"

typedef struct { char name[24]; mot_frame f[REP_FRAMES]; int n, plays; } inv_t;
typedef struct { char id[32], name[24]; mot_frame f[REP_FRAMES]; int n, kept, tries; } trick_t;

static EXT_RAM_BSS_ATTR inv_t inv[REP_INV_MAX];
static EXT_RAM_BSS_ATTR trick_t trick[REP_TRICK_MAX];
static int ninv, ntrick, inv_seq;
/* prueba de un invento: lo que se está midiendo */
static EXT_RAM_BSS_ATTR inv_t cand;
static int cand_on, cand_edge;
static float cand_a0, cand_b0, cand_dev;
/* ventana de reacción a un truco */
static int watch = -1;
static int64_t watch_until;

void repertorio_init(void)
{
    ninv = ntrick = inv_seq = cand_on = 0;
    watch = -1;
}

/* ---- cuadros ---- */
static void pose(mot_frame *f, int s0, int s1, int s2, int s3, int ms)
{
    memset(f, 0, sizeof *f);
    f->mode = MOT_MODE_POSE;
    f->s[0] = (uint8_t)s0; f->s[1] = (uint8_t)s1; f->s[2] = (uint8_t)s2; f->s[3] = (uint8_t)s3;
    f->ms = (uint16_t)ms;
}

static int step_frames(const char *paso, mot_frame *out, int max)
{
    const char *mot = !strcmp(paso, "adelante") ? "explore_foward1" : !strcmp(paso, "atras") || !strcmp(paso, "atrás")
                      ? "explore_back_away1" : !strcmp(paso, "izquierda") ? "explore_turn_left2"
                      : !strcmp(paso, "derecha") ? "explore_turn_right2" : NULL;
    if (!mot) return -1;
    return motion_load(mot, out, max);
}

int repertorio_parse_frames(const char *json_array, mot_frame *out, int max)
{
    cJSON *a = cJSON_Parse(json_array);
    int n = 0, bad = !cJSON_IsArray(a);
    cJSON *it;
    if (!bad)
        cJSON_ArrayForEach(it, a) {
            cJSON *p = cJSON_GetObjectItemCaseSensitive(it, "pose"), *ms = cJSON_GetObjectItemCaseSensitive(it, "ms");
            cJSON *paso = cJSON_GetObjectItemCaseSensitive(it, "paso");
            if (cJSON_IsArray(p) && cJSON_GetArraySize(p) == 4 && cJSON_IsNumber(ms)) {
                int s[4];
                for (int k = 0; k < 4; k++) {
                    cJSON *v = cJSON_GetArrayItem(p, k);
                    s[k] = cJSON_IsNumber(v) ? (int)v->valuedouble : -1;
                    if (!motion_angle_ok(k, s[k])) bad = 1;
                }
                int t = (int)ms->valuedouble;
                if (t < 40 || t > 6400 || n >= max) bad = 1;
                if (bad) break;
                pose(&out[n++], s[0], s[1], s[2], s[3], t);
            } else if (cJSON_IsString(paso)) {
                int k = step_frames(paso->valuestring, out + n, max - n);
                if (k <= 0) { bad = 1; break; }
                n += k;
            } else { bad = 1; break; }
        }
    cJSON_Delete(a);
    return bad || n == 0 ? -1 : n;
}

/* cuadros → alma-anim/1 (para mandar un invento al servidor); solo poses */
static int frames_json(const mot_frame *f, int n, char *out, size_t cap)
{
    size_t o = 0;
    o += (size_t)snprintf(out + o, cap - o, "[");
    for (int k = 0; k < n && o < cap; k++)
        o += (size_t)snprintf(out + o, cap - o, "%s{\"pose\":[%u,%u,%u,%u],\"ms\":%u}", k ? "," : "", f[k].s[0], f[k].s[1],
                              f[k].s[2], f[k].s[3], f[k].ms);
    if (o + 2 > cap) return -1;
    out[o++] = ']';
    out[o] = 0;
    return (int)o;
}

/* ---- inventos (vía 2) ---- */
static int rnd(alma_rng *r, int lo, int hi) { return lo + (int)(alma_rng_u01(r) * (float)(hi - lo + 1)); }

/* 3–6 poses seguras y de vuelta a 90: caderas ±35 alrededor de 90, pies ±15 (los pies inclinan todo el cuerpo), entre
   250 y 700 ms. A veces simétrica (como espejo de sí misma), que se ve más "baile" */
static int make(alma_rng *r, mot_frame *out)
{
    int n = rnd(r, 3, 6), sym = alma_rng_u01(r) < 0.5f, k = 0;
    for (; k < n; k++) {
        int s[4];
        do {
            s[0] = 90 + rnd(r, -35, 35);
            s[1] = sym ? 180 - s[0] : 90 + rnd(r, -35, 35);
            s[2] = 90 + rnd(r, -15, 15);
            s[3] = sym ? 180 - s[2] : 90 + rnd(r, -15, 15);
        } while (!motion_angle_ok(0, s[0]) || !motion_angle_ok(1, s[1]) || !motion_angle_ok(2, s[2]) || !motion_angle_ok(3, s[3]));
        pose(&out[k], s[0], s[1], s[2], s[3], rnd(r, 250, 700));
    }
    pose(&out[k++], 90, 90, 90, 90, 400);
    return k;
}

/* ---- ondas (vía 4; dueño, 2026-11-06) ----
   Cada servo sigue su onda: ángulo = 90 + O + A·sin(2π·i/WAVE_SPC + φ), las mismas cuentas que las primitivas de marcha
   del original (gait.c), pero con amplitud, centro y desfase propios por servo: meneos, vaivenes y balanceos suaves. Se
   muestrea en WAVE_SPC poses por ciclo (entre poses la transición es lineal). Caderas hasta ±28 con centro ±8 (S1 no baja
   de 53), pies hasta ±10 y centrados (inclinan todo el cuerpo). */
#define WAVE_SPC 8
int repertorio_make_wave(alma_rng *r, mot_frame *out)
{
    static const float Q[4] = {0.0f, 1.5707963f, 3.1415927f, 4.712389f};
    int A[4], O[4], period = rnd(r, 8, 20) * 80, cycles = rnd(r, 2, 3), k = 0;   /* 640–1600 ms por ciclo */
    float ph[4];
    A[0] = rnd(r, 8, 28);
    A[1] = alma_rng_u01(r) < 0.6f ? A[0] : rnd(r, 8, 28);
    A[2] = rnd(r, 0, 10);
    A[3] = alma_rng_u01(r) < 0.6f ? A[2] : rnd(r, 0, 10);
    O[0] = rnd(r, -8, 8);
    O[1] = alma_rng_u01(r) < 0.5f ? -O[0] : rnd(r, -8, 8);
    O[2] = O[3] = 0;
    ph[0] = 0;
    ph[1] = Q[rnd(r, 0, 2)];   /* caderas juntas, a un cuarto o opuestas */
    ph[2] = Q[rnd(r, 0, 3)];
    ph[3] = ph[2] + (alma_rng_u01(r) < 0.5f ? 0 : Q[2]);
    for (int c = 0; c < cycles; c++)
        for (int i = 0; i < WAVE_SPC; i++) {
            int s[4];
            for (int j = 0; j < 4; j++) {
                s[j] = 90 + O[j] + (int)lroundf((float)A[j] * sinf(6.2831853f * (float)i / WAVE_SPC + ph[j]));
                if (!motion_angle_ok(j, s[j])) return -1;
            }
            pose(&out[k++], s[0], s[1], s[2], s[3], period / WAVE_SPC);
        }
    pose(&out[k++], 90, 90, 90, 90, 400);
    return k;
}

int repertorio_invent(alma_rng *r, int on_charger)
{
    if (cand_on || motion_active()) return -1;
    if (ninv >= 3 && alma_rng_u01(r) < 0.4f) {   /* a veces repite su favorito, con variación */
        int best = 0;
        for (int i = 1; i < ninv; i++) if (inv[i].plays > inv[best].plays) best = i;
        inv[best].plays++;
        motion_set_variation(0.85f + 0.3f * alma_rng_u01(r), 1.0f, alma_rng_u01(r) < 0.5f);
        hal_log("invento: repite su favorito %s (%d veces)", inv[best].name, inv[best].plays);
        return motion_play_frames(inv[best].name, inv[best].f, inv[best].n, on_charger) == MOTION_OK ? 0 : -1;
    }
    int wave = alma_rng_u01(r) < 0.5f;   /* mitad poses sueltas, mitad ondas */
    snprintf(cand.name, sizeof cand.name, "%s_%d", wave ? "onda" : "invento", ++inv_seq);
    cand.n = wave ? repertorio_make_wave(r, cand.f) : -1;
    if (cand.n < 0) cand.n = make(r, cand.f);
    cand.plays = 0;
    if (!perception_tilt(&cand_a0, &cand_b0)) cand_a0 = cand_b0 = 0;
    cand_dev = 0;
    cand_edge = 0;
    if (motion_play_frames(cand.name, cand.f, cand.n, on_charger) != MOTION_OK) return -1;
    cand_on = 1;
    hal_log("invento: prueba %s (%d poses)", cand.name, cand.n);
    return 0;
}

static void keep_invention(void)
{
    int at = ninv;
    if (ninv == REP_INV_MAX) {   /* lleno: se va el menos usado */
        at = 0;
        for (int i = 1; i < ninv; i++) if (inv[i].plays < inv[at].plays) at = i;
    } else ninv++;
    inv[at] = cand;
    static char fr[1400], j[1600];   /* outbox_event arma 256 bytes: el invento va completo con outbox_put */
    if (frames_json(cand.f, cand.n, fr, sizeof fr) > 0) {
        snprintf(j, sizeof j, "{\"t\":\"event\",\"ev\":\"invento\",\"nombre\":\"%s\",\"cuadros\":%s}", cand.name, fr);
        outbox_put(j);
    }
}

int repertorio_invent_msg(const char *json)
{
    cJSON *j = cJSON_Parse(json);
    cJSON *nm = cJSON_GetObjectItemCaseSensitive(j, "nombre"), *fr = cJSON_GetObjectItemCaseSensitive(j, "cuadros");
    int ok = -1;
    if (cJSON_IsString(nm) && fr && ninv < REP_INV_MAX) {
        char *txt = cJSON_PrintUnformatted(fr);
        inv_t *v = &inv[ninv];
        int n = txt ? repertorio_parse_frames(txt, v->f, REP_FRAMES) : -1;
        if (n > 0) {
            snprintf(v->name, sizeof v->name, "%s", nm->valuestring);
            v->n = n;
            v->plays = 1;
            ninv++;
            ok = 0;
        }
        cJSON_free(txt);
    }
    cJSON_Delete(j);
    return ok;
}

int repertorio_inventions(void) { return ninv; }

/* ---- trucos (vía 3) ---- */
static int find_trick(const char *id)
{
    for (int i = 0; i < ntrick; i++) if (!strcmp(trick[i].id, id)) return i;
    return -1;
}

int repertorio_trick_msg(const char *json)
{
    cJSON *j = cJSON_Parse(json);
    cJSON *id = cJSON_GetObjectItemCaseSensitive(j, "id"), *nm = cJSON_GetObjectItemCaseSensitive(j, "nombre");
    cJSON *st = cJSON_GetObjectItemCaseSensitive(j, "estado"), *fr = cJSON_GetObjectItemCaseSensitive(j, "cuadros");
    int ok = -1;
    if (cJSON_IsString(id) && cJSON_IsString(st) && fr) {
        int i = find_trick(id->valuestring);
        if (!strcmp(st->valuestring, "olvidado")) {   /* el servidor lo quitó */
            if (i >= 0) trick[i] = trick[--ntrick];
            ok = 0;
        } else {
            int fresh = 0;
            if (i < 0 && ntrick < REP_TRICK_MAX) { i = ntrick++; fresh = 1; memset(&trick[i], 0, sizeof trick[i]); }
            if (i >= 0) {
                trick_t *t = &trick[i];
                char *txt = cJSON_PrintUnformatted(fr);
                int n = txt ? repertorio_parse_frames(txt, t->f, REP_FRAMES) : -1;
                cJSON_free(txt);
                if (n > 0) {
                    snprintf(t->id, sizeof t->id, "%s", id->valuestring);
                    snprintf(t->name, sizeof t->name, "%s", cJSON_IsString(nm) ? nm->valuestring : "truco");
                    t->n = n;
                    t->kept = !strcmp(st->valuestring, "aprendido");
                    t->tries = 0;
                    ok = 0;
                    hal_log("truco: %s \"%s\" (%d cuadros, %s)", t->id, t->name, n, t->kept ? "aprendido" : "nuevo");
                } else {
                    hal_log("truco: %s no se entiende o sale del rango seguro; no se guarda", id->valuestring);
                    if (fresh) ntrick--;   /* el lugar que se apartó para él */
                }
            }
        }
    }
    cJSON_Delete(j);
    return ok;
}

int repertorio_new_tricks(void)
{
    int k = 0;
    for (int i = 0; i < ntrick; i++) k += !trick[i].kept;
    return k;
}

int repertorio_show_trick(int on_charger)
{
    if (watch >= 0 || motion_active()) return -1;
    for (int i = 0; i < ntrick; i++)
        if (!trick[i].kept) {
            trick[i].tries++;
            hal_log("truco: enseña \"%s\" (intento %d); mira tu reacción %d s", trick[i].name, trick[i].tries, REP_WATCH_MS / 1000);
            if (motion_play_frames(trick[i].name, trick[i].f, trick[i].n, on_charger) != MOTION_OK) return -1;
            watch = i;
            watch_until = hal_now_ms() + REP_WATCH_MS;
            return 0;
        }
    return -1;
}

static void trick_result(const char *res)
{
    trick_t *t = &trick[watch];
    char j[160];
    snprintf(j, sizeof j, ",\"id\":\"%s\",\"res\":\"%s\",\"intento\":%d", t->id, res, t->tries);
    outbox_event("truco_res", j);
    hal_log("truco: \"%s\" → %s", t->name, res);
    if (!strcmp(res, "gusta")) t->kept = 1;
    else if (!strcmp(res, "regaño") || t->tries >= REP_TRICK_TRIES) {   /* se borra (o se olvida) */
        hal_log("truco: \"%s\" %s", t->name, !strcmp(res, "regaño") ? "se borra" : "se olvida (tres veces sin reacción)");
        trick[watch] = trick[--ntrick];
    }
    watch = -1;
}

void repertorio_event(alma_ev_type t)
{
    if (watch < 0) return;
    if (t == EV_TOUCH_PET || t == EV_PRAISE) trick_result("gusta");
    else if (t == EV_SCOLD) trick_result("regaño");
}

int repertorio_play_own(alma_rng *r, int on_charger)
{
    int nk = 0;
    for (int i = 0; i < ntrick; i++) nk += trick[i].kept;
    int tot = ninv + nk;
    if (!tot || motion_active()) return -1;
    int pick = (int)(alma_rng_u01(r) * (float)tot);
    if (pick < ninv) {
        inv[pick].plays++;
        hal_log("juega con su invento %s", inv[pick].name);
        return motion_play_frames(inv[pick].name, inv[pick].f, inv[pick].n, on_charger) == MOTION_OK ? 0 : -1;
    }
    pick -= ninv;
    for (int i = 0; i < ntrick; i++)
        if (trick[i].kept && pick-- == 0) {
            hal_log("juega con su truco \"%s\"", trick[i].name);
            return motion_play_frames(trick[i].name, trick[i].f, trick[i].n, on_charger) == MOTION_OK ? 0 : -1;
        }
    return -1;
}

void repertorio_step(int64_t now)
{
    if (watch >= 0 && now >= watch_until) trick_result("nada");
    if (!cand_on) return;
    float a, b;
    if (perception_tilt(&a, &b)) {
        float d = fmaxf(fabsf(a - cand_a0), fabsf(b - cand_b0));
        if (d > cand_dev) cand_dev = d;
    }
    if (perception_edges_now()) cand_edge = 1;
    if (motion_active()) return;
    cand_on = 0;
    int stable = cand_dev <= INV_MAX_DEV_DEG && !cand_edge;
    hal_log("invento: %s %s (se ladeó hasta %.0f°%s)", cand.name, stable ? "estable: se queda" : "inestable: se descarta", cand_dev,
            cand_edge ? ", borde" : "");
    if (stable) keep_invention();
}
