/* sim_main.c — simulador de días para alma_core (04 "Pruebas del núcleo", 08 F2).
 *
 * Mundo: un dueño (person_id 1, registrado en el K210 desde el día 0) con horarios de semana y
 * fin de semana según el perfil; visitas con caras desconocidas; ruidos; base de carga. El dueño
 * acomoda a Alma en la base al acostarse, con EV_BATTERY_LOW si está presente, y la saca para
 * jugar. Sin dueño, Alma vive en la base (decisión del dueño, 2026-10-27).
 *
 * Uso: sim <catalog.json> <assets_inventory.json> <dir_salida> [días=90] [semillas=6]
 * SIM_MEM=1: además corre memory_store (06) sobre una flash en RAM con su calendario de guardado, y cada noche
 * restaura el estado guardado sobre una copia con los campos persistentes borrados; escribe <dir_salida>/memoria.md.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "alma_core.h"
#include "alma_params.h"
#include "alma_mem.h"
#include "catalog_load.h"

#define DAY 86400.0
#define HR 3600.0
#define MAX_Q 128
#define MAX_SEQ 4000
#define MAX_IV 8

/* variable (dueño, 2026-10-30): cada lunes sortea la semana: 35 % atento, 35 % ausente entre semana, 20 % brusco,
   10 % de viaje (sin dueño esa semana). Va al final para no mover los pares de A2.9 */
typedef enum { PROF_ATENTO, PROF_AUSENTE, PROF_BRUSCO, PROF_SIN_DUENO, PROF_VARIABLE, PROF_COUNT } profile_id;
static const char *const PROF_NAME[PROF_COUNT] = {"atento", "ausente_entre_semana", "brusco", "sin_dueno", "variable"};

typedef struct {               /* tasas por minuto mientras el dueño está cerca */
    float pet, tap, praise, scold, cmd, pick, shake, drop_after_pick, resp, loud_per_day, visit_weekend_p;
    int has_owner;
    float resp_refractory_s;   /* tras responder, el dueño no vuelve a responder hasta pasado este tiempo */
} profile;

static const profile PROFILES[PROF_COUNT] = {
    /*            pet   tap   praise scold  cmd   pick  shake  drop  resp  loud  visit owner refractario */
    [PROF_ATENTO]  = {0.25f, 0.10f, 0.06f, 0.005f, 0.02f, 0.01f, 0.0f, 0.0f, 0.50f, 1.0f, 0.3f, 1, 180},
    [PROF_AUSENTE] = {0.15f, 0.05f, 0.03f, 0.010f, 0.01f, 0.005f, 0.0f, 0.0f, 0.35f, 0.5f, 0.3f, 1, 300},
    [PROF_BRUSCO]  = {0.06f, 0.15f, 0.01f, 0.050f, 0.03f, 0.05f, 0.015f, 0.15f, 0.20f, 4.0f, 0.3f, 1, 600},
    [PROF_SIN_DUENO] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 2.0f, 0, 0, 0},
    [PROF_VARIABLE] = {0.25f, 0.10f, 0.06f, 0.005f, 0.02f, 0.01f, 0.0f, 0.0f, 0.50f, 1.0f, 0.3f, 1, 180},   /* la semana 0 */
};

typedef struct { double a, b; } iv;
typedef struct {               /* plan de un día, en segundos desde la medianoche */
    iv near[MAX_IV]; int n_near;
    iv play[MAX_IV]; int n_play;
    iv away[MAX_IV]; int n_away;
    iv visit; int has_visit;
    double bed, wake;
    double loud[8]; int n_loud;
} day_plan;

typedef struct { double t; alma_ev ev; } qev;

typedef struct {
    /* entrada */
    const alma_catalog *cat;
    profile p;
    profile_id prof, week_prof;   /* week_prof: el de esta semana (variable) o el mismo prof */
    alma_rng rng;
    int days;
    /* mundo */
    alma_t alma;
    double t;
    day_plan plan;
    int day;
    float soc;
    int on_charger, low_sent, visible, facing, unknown_visible, lifted;
    double vis_until, last_face_ev, last_unknown_ev, done_t, last_resp_t;
    int done_b;
    qev q[MAX_Q]; int nq;
    /* métricas del día */
    int seq[MAX_SEQ], n_seq;
    unsigned char seq_fb[MAX_SEQ];
    int null_dagger, null_budget, null_charger, budget_violations;
    float servo_max_ratio;
    double state_s[8];
    FILE *csv;
    FILE *hist;
    /* resultados */
    double sum_H, sum_top;
    float H_day[400], top_day[400]; int rep_day[400], n_exec_day[400], n_days_done;
    float H2_day[400], top2_day[400]; int rep2_day[400], n2_exec_day[400];
    char top_id_day[400][ALMA_ID_LEN];
    float last_traits[TRAIT_COUNT], birth[TRAIT_COUNT], attach_end, mood_end;
    alma_counters night_counts;   /* contadores del último pase nocturno */
    long exec_by_kind[6];
    /* memory_store (SIM_MEM=1) */
    int use_mem, mem_age;
    alma_mem_file mf;
    alma_mem_flash mfl;
    alma_mem mem;
    uint32_t writes_mark, writes_day[400], erase_max[ALMA_MEM_BLOCKS];   /* borrados del sector más usado de cada bloque */
    int restores, restore_mismatch;
} sim;

static float u01(sim *s) { return alma_rng_u01(&s->rng); }
static float urange(sim *s, float a, float b) { return a + (b - a) * u01(s); }
static double gauss_min(sim *s, double mean_min, double sd_min) { /* aproximación con 3 uniformes */
    return 60.0 * (mean_min + sd_min * (u01(s) + u01(s) + u01(s) - 1.5) * 2.0);
}

static void push(sim *s, double t, alma_ev_type type, int person, int action, float value)
{
    if (s->nq >= MAX_Q) return;
    alma_ev e = {type, person, action, -1, 0, 0, 0, value};
    s->q[s->nq++] = (qev){t, e};
}

static void add_iv(iv *arr, int *n, double a, double b) { if (*n < MAX_IV && b > a) arr[(*n)++] = (iv){a, b}; }
static int in_ivs(const iv *arr, int n, double x) { for (int i = 0; i < n; i++) if (x >= arr[i].a && x < arr[i].b) return 1; return 0; }

/* Horarios realistas por perfil; el día 0 es lunes */
static void plan_day(sim *s, int day)
{
    day_plan *d = &s->plan;
    memset(d, 0, sizeof *d);
    int weekend = day % 7 >= 5;
    if (s->prof == PROF_VARIABLE && day % 7 == 0) {
        float r = u01(s);
        s->week_prof = r < 0.35f ? PROF_ATENTO : r < 0.70f ? PROF_AUSENTE : r < 0.90f ? PROF_BRUSCO : PROF_SIN_DUENO;
        s->p = PROFILES[s->week_prof];
    }
    profile_id who = s->week_prof;
    if (who == PROF_SIN_DUENO) {
        d->bed = d->wake = -1;
    } else if (!weekend && who == PROF_AUSENTE) {
        d->wake = 6 * HR + gauss_min(s, 0, 10);
        if (u01(s) < 0.4f) add_iv(d->near, &d->n_near, 6 * HR + 600, 6 * HR + 2400);
        add_iv(d->away, &d->n_away, 6 * HR + 3000, 21 * HR + gauss_min(s, 0, 30));
        if (u01(s) < 0.7f) add_iv(d->near, &d->n_near, 21 * HR + 1200, 22.5 * HR);
        if (u01(s) < 0.2f) add_iv(d->play, &d->n_play, 21 * HR + 2400, 21 * HR + 3300);
        d->bed = 23.5 * HR + gauss_min(s, 0, 20);
    } else if (!weekend) {   /* atento y brusco entre semana */
        d->wake = 6.75 * HR + gauss_min(s, 0, 15);
        add_iv(d->near, &d->n_near, 6.9 * HR, 7.6 * HR);
        add_iv(d->away, &d->n_away, 8.33 * HR + gauss_min(s, 0, 10), 17.83 * HR + gauss_min(s, 0, 20));
        double e1 = 18 * HR + gauss_min(s, 0, 10);
        add_iv(d->near, &d->n_near, e1, e1 + gauss_min(s, 60, 15));
        double e2 = 20 * HR + gauss_min(s, 0, 20);
        add_iv(d->near, &d->n_near, e2, e2 + gauss_min(s, 120, 30));
        if (u01(s) < 0.8f) add_iv(d->play, &d->n_play, e2 + 1800, e2 + 3000);
        d->bed = 23 * HR + gauss_min(s, 0, 20);
    } else {                 /* fin de semana, los tres perfiles con dueño */
        d->wake = 8.25 * HR + gauss_min(s, 0, 30);
        add_iv(d->near, &d->n_near, 8.5 * HR, 10 * HR);
        add_iv(d->near, &d->n_near, 11 * HR, 12.5 * HR);
        if (u01(s) < 0.5f) add_iv(d->away, &d->n_away, 13 * HR, 16 * HR);
        add_iv(d->near, &d->n_near, 16.5 * HR, 18 * HR);
        add_iv(d->near, &d->n_near, 20 * HR, 22.5 * HR);
        if (u01(s) < 0.9f) add_iv(d->play, &d->n_play, 9.25 * HR, 9.25 * HR + 1200);
        if (u01(s) < 0.9f) add_iv(d->play, &d->n_play, 17 * HR, 17 * HR + 1500);
        if (u01(s) < s->p.visit_weekend_p) { d->has_visit = 1; d->visit = (iv){15 * HR, 17 * HR}; }
        d->bed = 23.5 * HR + gauss_min(s, 0, 20);
    }
    /* ruidos fuertes: número esperado por día, en horas de casa (o de 8 a 22 sin dueño) */
    float lam = s->p.loud_per_day;
    while (lam > 0 && d->n_loud < 8) {
        if (u01(s) < (lam >= 1 ? 1.0f : lam)) d->loud[d->n_loud++] = urange(s, 8 * HR, 22 * HR);
        lam -= 1;
    }
}

static int owner_home(const sim *s, double tod)
{
    if (!s->p.has_owner) return 0;
    return !in_ivs(s->plan.away, s->plan.n_away, tod);
}
static int owner_near(const sim *s, double tod) { return s->p.has_owner && in_ivs(s->plan.near, s->plan.n_near, tod); }

/* ---- ganchos del núcleo ---- */
static void on_exec(void *user, const alma_exec_info *e)
{
    sim *s = user;
    s->done_t = e->t_start + e->planned_s;
    s->done_b = e->behavior;
    s->exec_by_kind[e->kind]++;
    if (e->motion_null_reason == 1) s->null_dagger++;
    if (e->motion_null_reason == 2) s->null_budget++;
    if (e->motion_null_reason == 3) s->null_charger++;
    const alma_behavior *b = &s->cat->b[e->behavior];
    /* métricas: decisiones (no relleno de pausas, no reflejos, no bhv_sleep_cycle) — aprobado */
    if (e->kind != RUN_REFLEX && strcmp(b->id, "bhv_sleep_cycle") != 0 && s->n_seq < MAX_SEQ) {
        s->seq_fb[s->n_seq] = e->kind == RUN_FALLBACK;
        s->seq[s->n_seq++] = e->behavior;
    }
    /* el dueño responde a lo que hace Alma, solo si la está mirando y no respondió hace poco */
    double tod = fmod(e->t_start, DAY);
    if (e->kind != RUN_REFLEX && e->person >= 0 && owner_near(s, tod) && s->facing
        && e->t_start - s->last_resp_t >= s->p.resp_refractory_s) {
        float p = s->p.resp * ((b->tags & (TAG_ATTENTION | TAG_PLAY)) ? 1.3f : 1.0f) * (e->kind == RUN_COMMAND ? 1.2f : 1.0f);
        if (u01(s) < p) s->last_resp_t = e->t_start, push(s, e->t_start + urange(s, 1.0f, e->planned_s + 4.0f), u01(s) < 0.7f ? EV_TOUCH_PET : EV_PRAISE, 1, -1, 0);
    }
}

static void on_night(void *user, const alma_day_summary *d)
{
    sim *s = user;
    memcpy(s->last_traits, d->traits, sizeof s->last_traits);
    s->attach_end = d->attachment[0];
    s->mood_end = d->mood_end;
    s->night_counts = d->counts;
}

/* ---- métricas de A2.1 y A2.2 ---- */
typedef struct { int n, top_b, maxrep; double H; float top; int counts[ALMA_MAX_BEHAVIORS]; } seq_stats;

/* skip_fb = 1: las elecciones de la regla 6 (RUN_FALLBACK) cuentan como relleno */
static void seq_metrics(const sim *s, int skip_fb, seq_stats *st)
{
    static int tri[ALMA_MAX_BEHAVIORS * ALMA_MAX_BEHAVIORS * ALMA_MAX_BEHAVIORS];
    int v[MAX_SEQ];
    memset(st, 0, sizeof *st);
    st->top_b = -1;
    for (int i = 0; i < s->n_seq; i++)
        if (!(skip_fb && s->seq_fb[i])) v[st->n++] = s->seq[i];
    for (int i = 0; i < st->n; i++) st->counts[v[i]]++;
    int top = 0;
    for (int b = 0; b < s->cat->n; b++) {
        if (!st->counts[b]) continue;
        double p = (double)st->counts[b] / st->n;
        st->H -= p * log2(p);
        /* A2.1: el 15% excluye bhv_blink_idle y bhv_sleep_cycle (este último nunca entra a la secuencia) */
        if (strcmp(s->cat->b[b].id, "bhv_blink_idle") && st->counts[b] > top) { top = st->counts[b]; st->top_b = b; }
    }
    st->top = st->n ? (float)top / st->n : 0;
    /* A2.2: máximo de veces que aparece una misma terna en el día */
    const int M = ALMA_MAX_BEHAVIORS;
    for (int i = 0; i + 2 < st->n; i++) {
        int c = ++tri[(v[i] * M + v[i + 1]) * M + v[i + 2]];
        if (c > st->maxrep) st->maxrep = c;
    }
    for (int i = 0; i + 2 < st->n; i++) tri[(v[i] * M + v[i + 1]) * M + v[i + 2]] = 0;
}

static void day_metrics(sim *s)
{
    seq_stats A, B;
    seq_metrics(s, 0, &A);
    seq_metrics(s, 1, &B);
    /* depuración: SIM_SEQ=<día> vuelca a stdout la secuencia de decisiones (variante B) de ese día */
    if (getenv("SIM_SEQ") && s->day == atoi(getenv("SIM_SEQ"))) {
        fprintf(stdout, "## %s\n", PROF_NAME[s->prof]);
        for (int i = 0; i < s->n_seq; i++)
            if (!s->seq_fb[i]) fprintf(stdout, "%s\n", s->cat->b[s->seq[i]].id);
    }
    if (s->hist) {
        fprintf(s->hist, "%d", s->day);
        for (int b = 0; b < s->cat->n; b++) fprintf(s->hist, ",%d", A.counts[b]);
        for (int b = 0; b < s->cat->n; b++) fprintf(s->hist, ",%d", B.counts[b]);
        fprintf(s->hist, "\n");
    }
    int d = s->n_days_done++;
    if (s->use_mem) { s->writes_day[d] = s->mem.writes - s->writes_mark; s->writes_mark = s->mem.writes; }
    s->H_day[d] = (float)A.H;
    s->top_day[d] = A.top;
    s->rep_day[d] = A.maxrep;
    s->n_exec_day[d] = A.n;
    s->H2_day[d] = (float)B.H;
    s->top2_day[d] = B.top;
    s->rep2_day[d] = B.maxrep;
    s->n2_exec_day[d] = B.n;
    snprintf(s->top_id_day[d], ALMA_ID_LEN, "%s", A.top_b >= 0 ? s->cat->b[A.top_b].id : "-");
    if (s->csv)
        fprintf(s->csv, "%d,%d,%.3f,%.3f,%s,%d,%d,%.3f,%.3f,%d,%.0f,%.3f,%d,%d,%d,%.0f,%.0f,%.0f,%.0f,%.3f,%.3f,%.3f,%.3f,%.3f,%.3f,"
                "%d,%d,%d,%d,%d,%d,%d,%d,%d,%.3f,%.3f,%.3f,%.3f,%.3f,%d,%.1f,%d\n",
                s->day, A.n, A.H, A.top, s->top_id_day[d], A.maxrep, B.n, B.H, B.top, B.maxrep,
                s->alma.servo_active_s_today, s->servo_max_ratio,
                s->null_dagger, s->null_budget, s->budget_violations, s->state_s[ST_AWAKE] + s->state_s[ST_PERFORMING],
                s->state_s[ST_RESTING], s->state_s[ST_SLEEPING], s->state_s[ST_REFLEX],
                s->alma.trait[0], s->alma.trait[1], s->alma.trait[2], s->alma.trait[3], s->alma.trait[4],
                s->alma.person[0].used ? s->alma.person[0].attachment : 0,
                s->night_counts.pets, s->night_counts.praises, s->night_counts.scolds, s->night_counts.shakes,
                s->night_counts.play_done, s->night_counts.play_ignored, s->night_counts.scares, s->night_counts.novel_ok,
                s->night_counts.explore_ok, s->alma.trait_learned[0], s->alma.trait_learned[1], s->alma.trait_learned[2],
                s->alma.trait_learned[3], s->alma.trait_learned[4], s->null_charger, s->alma.wellbeing, (int)s->week_prof);
    s->n_seq = 0;
    s->null_dagger = s->null_budget = s->null_charger = 0;
    s->servo_max_ratio = 0;
    memset(s->state_s, 0, sizeof s->state_s);
}

/* ---- un segundo del mundo ---- */
static void world_second(sim *s)
{
    double t = s->t, tod = fmod(t, DAY);
    alma_t *a = &s->alma;
    /* el ejecutor termina la conducta en curso a la hora exacta, antes que el resto del segundo */
    if (a->cur.active && a->cur.behavior == s->done_b && t >= s->done_t) {
        alma_ev e = {EV_BEHAVIOR_DONE, -1, -1, s->done_b, 0, 0, 0, 0};
        alma_event(a, &e, s->done_t);
    }
    int near = owner_near(s, tod), home = owner_home(s, tod);
    int playing = s->p.has_owner && in_ivs(s->plan.play, s->plan.n_play, tod) && near;

    /* base de carga: fuera solo mientras juegan; de vuelta al acostarse o con batería baja */
    int want_off = playing && !s->lifted;
    if (!s->p.has_owner) want_off = 0;
    if (s->soc <= 20.0f && near) want_off = 0;
    if (want_off != !s->on_charger) {
        s->on_charger = !want_off;
        push(s, t, s->on_charger ? EV_CHARGING_ON : EV_CHARGING_OFF, -1, -1, 0);
    }
    /* batería: ~1.5 h moviéndose, ~3 h despierta, ~8 h en reposo; carga en ~2.5 h (02) */
    if (s->on_charger) s->soc = fminf(100.0f, s->soc + 100.0f / (2.5f * 3600.0f));
    else {
        float drain = a->state == ST_PERFORMING && a->cur.motion_played ? 1.5f : (a->state == ST_RESTING || a->state == ST_SLEEPING ? 8.0f : 3.0f);
        s->soc = fmaxf(0.0f, s->soc - 100.0f / (drain * 3600.0f));
    }
    if (s->soc <= 20.0f && !s->low_sent) { s->low_sent = 1; push(s, t, EV_BATTERY_LOW, -1, -1, s->soc); }
    if (s->soc > 30.0f) s->low_sent = 0;

    /* caras del dueño: ráfagas visibles (media 90 s) y ocultas (media 40 s) mientras está cerca */
    if (near) {
        if (t >= s->vis_until) {
            s->visible = !s->visible;
            s->facing = s->visible && u01(s) < 0.6f;
            s->vis_until = t - (s->visible ? 90.0 : 40.0) * log(1.0 - u01(s) + 1e-9);
            if (!s->visible) push(s, t + FACE_LOST_S, EV_FACE_LOST, 1, -1, 0);
        }
    } else if (s->visible) {
        s->visible = 0;
        push(s, t + FACE_LOST_S, EV_FACE_LOST, 1, -1, 0);
    }
    if (s->visible && t - s->last_face_ev >= 2.0) {
        s->last_face_ev = t;
        alma_ev e = {EV_FACE_SEEN, 1, -1, -1, s->facing ? urange(s, 120, 200) : (u01(s) < 0.5f ? urange(s, 10, 80) : urange(s, 240, 310)),
                     120, s->facing ? urange(s, 55, 95) : urange(s, 25, 50), 0};
        alma_event(a, &e, t);
    }
    /* visita con caras desconocidas */
    int visiting = s->plan.has_visit && tod >= s->plan.visit.a && tod < s->plan.visit.b;
    if (visiting && t - s->last_unknown_ev >= 2.0 && u01(s) < 0.5f) {
        s->last_unknown_ev = t;
        alma_ev e = {EV_FACE_UNKNOWN, -1, -1, -1, urange(s, 60, 260), 120, urange(s, 30, 80), 0};
        alma_event(a, &e, t);
    }
    /* interacción del dueño (tasas por minuto) */
    if (near && !s->lifted) {
        float k = playing ? 2.0f : 1.0f;
        if (u01(s) < s->p.pet * k / 60.0f) push(s, t, EV_TOUCH_PET, 1, -1, 1500);
        if (u01(s) < s->p.tap / 60.0f) push(s, t, EV_TOUCH_TAP, 1, -1, 0);
        if (u01(s) < s->p.praise / 60.0f) push(s, t, EV_PRAISE, 1, -1, 0);
        if (u01(s) < s->p.scold / 60.0f) push(s, t, EV_SCOLD, 1, -1, 0);
        if (u01(s) < s->p.cmd / 60.0f) {
            static const float W[ACT_COUNT] = {0.15f, 0.15f, 0.10f, 0.05f, 0.03f, 0.15f, 0.15f, 0.05f, 0.10f, 0.07f};
            float r = u01(s), acc = 0;
            int act = 0;
            for (; act < ACT_COUNT - 1; act++) { acc += W[act]; if (r < acc) break; }
            /* grabación de 1.5 a 3 s + respuesta de la nube de 0.8 a 3 s (07), desde la palabra de activación */
            push(s, t, EV_WAKE_WORD, -1, -1, 0);
            double reply = t + urange(s, 1.5f, 3.0f) + urange(s, 0.8f, 3.0f);
            if (u01(s) < 0.85f) push(s, reply, EV_VOICE_COMMAND, 1, act, 0);
            else push(s, reply, EV_VOICE_FAILED, -1, -1, 0);
        }
        if (playing && u01(s) < 0.1f / 60.0f) push(s, t, EV_OBSTACLE, -1, -1, urange(s, 50, 200));
        if (u01(s) < s->p.pick / 60.0f) {
            /* levantar: a veces sacude, a veces lo deja caer (perfil brusco) */
            s->lifted = 1;
            double hold = urange(s, 5, 20);
            push(s, t, EV_PICKED_UP, 1, -1, 0);
            if (u01(s) < s->p.shake * 20.0f) push(s, t + urange(s, 1, (float)hold - 1), EV_SHAKEN, 1, -1, urange(s, 0.5f, 1));
            if (u01(s) < s->p.drop_after_pick) {
                push(s, t + hold, EV_TIPPED_OVER, -1, -1, 0);
                push(s, t + hold + urange(s, 10, 40), EV_PUT_DOWN, -1, -1, 0);
            } else {
                push(s, t + hold, EV_PUT_DOWN, -1, -1, 0);
            }
        }
        if (u01(s) < s->p.shake / 60.0f) push(s, t, EV_SHAKEN, 1, -1, urange(s, 0.5f, 1));
    }
    for (int i = 0; i < s->plan.n_loud; i++)
        if (s->plan.loud[i] >= tod && s->plan.loud[i] < tod + 1 && (home || !s->p.has_owner)) push(s, t, EV_LOUD_SOUND, -1, -1, 0);

    /* entregar eventos vencidos */
    for (int i = 0; i < s->nq;) {
        if (s->q[i].t <= t) {
            alma_ev e = s->q[i].ev;
            if (e.type == EV_PUT_DOWN) s->lifted = 0;
            s->q[i] = s->q[--s->nq];
            alma_event(a, &e, t);
            if (s->use_mem) alma_mem_on_event(&s->mem, a, e.type);
        } else i++;
    }
    alma_sensors sens = {s->soc, s->on_charger};
    alma_tick(a, t, &sens);
    if (s->use_mem) {
        alma_mem_tick(&s->mem, a, t);
        if (a->age_days != s->mem_age) {   /* pase nocturno: ya se guardó; se restaura como tras un reinicio */
            static alma_mem m2;
            static alma_t r;
            s->mem_age = a->age_days;
            r = *a;
            alma_mem_scrub(&m2, &r);
            if (alma_mem_open(&m2, &s->mfl) || alma_mem_load(&m2, &r) || memcmp(&r, a, sizeof r)) s->restore_mismatch++;
            s->restores++;
            *a = r;
        }
    }

    float ratio = a->servo_active_s_today / alma_budget_s(a);
    if (ratio > s->servo_max_ratio) s->servo_max_ratio = ratio;
    if (a->servo_active_s_today > alma_budget_s(a) + 1e-3f) {
        if (!s->budget_violations && getenv("SIM_DEBUG"))
            fprintf(stderr, "exceso: día %d %.0f s, servo %.1f / %.1f, en curso %s opción %d tipo %d desde %.0f s (plan %.1f s), estado %d\n",
                    s->day, fmod(t, DAY), a->servo_active_s_today, alma_budget_s(a), a->cur.active ? s->cat->b[a->cur.behavior].id : "-",
                    a->cur.option, a->cur.kind, t - a->cur.t_start, a->cur.planned_s, a->state);
        s->budget_violations++;
    }
    s->state_s[a->state] += 1;
}

static void run(sim *s, const alma_catalog *cat, profile_id prof, uint32_t seed, int days, const char *outdir)
{
    memset(s, 0, sizeof *s);
    s->cat = cat;
    s->p = PROFILES[prof];
    s->prof = s->week_prof = prof;
    if (prof == PROF_VARIABLE) s->week_prof = PROF_ATENTO;
    s->days = days;
    alma_rng_seed(&s->rng, 0xA11A0000ULL + seed * 7919ULL + (uint64_t)prof * 104729ULL);
    s->soc = 100;
    s->on_charger = 1;
    s->done_b = -1;
    s->last_resp_t = -1e12;
    char path[512];
    snprintf(path, sizeof path, "%s/%s_s%u.csv", outdir, PROF_NAME[prof], seed);
    s->csv = fopen(path, "w");
    if (s->csv)
        fprintf(s->csv, "day,n_exec,entropy_bits,top_share,top_behavior,max_seq3_rep,n_exec_nofb,entropy_nofb,top_share_nofb,max_seq3_rep_nofb,"
                        "servo_s,servo_max_ratio,null_dagger,null_budget,"
                        "budget_violations,awake_s,resting_s,sleeping_s,reflex_s,boldness,energy,sociability,playfulness,impulsivity,attachment,"
                        "n_pets,n_praises,n_scolds,n_shakes,n_play_done,n_play_ignored,n_scares,n_novel_ok,n_explore_ok,"
                        "learned_boldness,learned_energy,learned_sociability,learned_playfulness,learned_impulsivity,null_charger,"
                        "wellbeing,week_profile\n");
    snprintf(path, sizeof path, "%s/%s_s%u_hist.csv", outdir, PROF_NAME[prof], seed);
    s->hist = fopen(path, "w");
    if (s->hist) {
        fprintf(s->hist, "day");
        for (int b = 0; b < cat->n; b++) fprintf(s->hist, ",%s", cat->b[b].id);
        for (int b = 0; b < cat->n; b++) fprintf(s->hist, ",B:%s", cat->b[b].id);
        fprintf(s->hist, "\n");
    }
    alma_hooks hooks = {on_exec, on_night, s, NULL, NULL};
    double t0 = 8 * HR;                     /* sale de la caja el lunes a las 8:00 */
    alma_init(&s->alma, cat, seed, t0, hooks);
    s->use_mem = getenv("SIM_MEM") && atoi(getenv("SIM_MEM"));
    if (s->use_mem) {
        alma_mem_file_open(&s->mf, &s->mfl, NULL, 512u * 1024u);
        alma_mem_open(&s->mem, &s->mfl);
        alma_mem_load(&s->mem, &s->alma);   /* flash vacía: no cambia nada */
        s->mem_age = s->alma.age_days;
    }
    memcpy(s->birth, s->alma.trait_base, sizeof s->birth);
    if (!s->p.has_owner) s->alma.has_home_station = 1;
    s->day = 0;
    plan_day(s, 0);
    for (s->t = t0; s->t < days * DAY; s->t += 1.0) {
        int day = (int)(s->t / DAY);
        if (day != s->day) {
            day_metrics(s);
            s->day = day;
            plan_day(s, day);
        }
        world_second(s);
    }
    day_metrics(s);
    memcpy(s->last_traits, s->alma.trait, sizeof s->last_traits);
    if (s->use_mem) {
        for (int b = 0; b < ALMA_MEM_BLOCKS; b++) {
            s->erase_max[b] = 0;
            for (int k = 0; k < alma_mem_slot_count(b); k++) {
                uint32_t a0 = alma_mem_slot_off(b, k) / ALMA_MEM_SECTOR, a1 = alma_mem_slot_off(b, k + 1) / ALMA_MEM_SECTOR;
                for (uint32_t q = a0; q < a1; q++) if (s->mf.erase_count[q] > s->erase_max[b]) s->erase_max[b] = s->mf.erase_count[q];
            }
        }
        alma_mem_file_close(&s->mf);
    }
    if (s->csv) fclose(s->csv);
    if (s->hist) fclose(s->hist);
}

static int cmpf(const void *x, const void *y) { float a = *(const float *)x, b = *(const float *)y; return (a > b) - (a < b); }
static float median(const float *v, int n) { static float tmp[16 * 400]; memcpy(tmp, v, n * sizeof *v); qsort(tmp, n, sizeof *tmp, cmpf); return n ? tmp[n / 2] : 0; }

#define AGG_MAX (16 * 400)
typedef struct {
    float H[AGG_MAX], top[AGG_MAX], rep[AGG_MAX], n[AGG_MAX], H17[16 * 7];
    int k, k17, pass1, pass2, worstRep;
    float worstH, worstTop;
} agg;

static float mediani(const int *v, int n) { float tmp[400]; for (int i = 0; i < n; i++) tmp[i] = (float)v[i]; return median(tmp, n); }

static void agg_add(agg *g, const float *H, const float *top, const int *rep, const int *nexec, int days)
{
    if (g->k == 0) g->worstH = 99;
    for (int d = 0; d < days && g->k < AGG_MAX; d++) {
        g->H[g->k] = H[d]; g->top[g->k] = top[d]; g->rep[g->k] = (float)rep[d]; g->n[g->k] = (float)nexec[d];
        g->pass1 += H[d] >= 3.0f && top[d] <= 0.15f;   /* A2.1 */
        g->pass2 += rep[d] <= 3;                        /* A2.2 */
        if (H[d] < g->worstH) g->worstH = H[d];
        if (top[d] > g->worstTop) g->worstTop = top[d];
        if (rep[d] > g->worstRep) g->worstRep = rep[d];
        if (d < 7) g->H17[g->k17++] = H[d];
        g->k++;
    }
}

int main(int argc, char **argv)
{
    if (argc < 4) { fprintf(stderr, "uso: %s <catalog.json> <inventory.json> <dir_salida> [días] [semillas]\n", argv[0]); return 2; }
    static alma_catalog cat;
    if (catalog_load(argv[1], argv[2], &cat, 1) <= 0) return 1;
    int days = argc > 4 ? atoi(argv[4]) : 90, seeds = argc > 5 ? atoi(argv[5]) : 6;
    if (days > 399) days = 399;
    char path[512];
    snprintf(path, sizeof path, "%s/resumen.md", argv[3]);
    FILE *md = fopen(path, "w");
    if (!md) { fprintf(stderr, "no pude escribir %s\n", path); return 1; }
    fprintf(md, "# Resumen del simulador (%d días, %d semillas por perfil)\n\n", days, seeds);
    fprintf(md, "Métricas sobre decisiones: sin relleno de pausas (regla 5), sin reflejos y sin `bhv_sleep_cycle`. "
                "Por perfil: mediana de todos los días de todas las semillas, peor día y mediana de los días 1 a 7.\n\n"
                "- **A**: definición aprobada; las elecciones de la regla 6 (`bhv_blink_idle` o `bhv_look_around` cuando nada supera 0.05) cuentan.\n"
                "- **B**: igual, pero las elecciones de la regla 6 cuentan como relleno.\n\n");

    static sim s;
    static agg ag[PROF_COUNT][2];
    float traits_end[PROF_COUNT][16][TRAIT_COUNT], traits_birth[PROF_COUNT][16][TRAIT_COUNT], attach[PROF_COUNT][16];
    int viol[PROF_COUNT] = {0};
    static float wd[PROF_COUNT][16 * 400];
    int nwd[PROF_COUNT] = {0}, rest[PROF_COUNT] = {0}, rest_bad[PROF_COUNT] = {0};
    uint32_t werr[PROF_COUNT] = {0};
    double blk_total[PROF_COUNT][ALMA_MEM_BLOCKS] = {{0}};
    uint32_t erase_worst[PROF_COUNT][ALMA_MEM_BLOCKS] = {{0}};
    for (int prof = 0; prof < PROF_COUNT; prof++) {
        for (int sd = 1; sd <= seeds && sd <= 16; sd++) {
            run(&s, &cat, (profile_id)prof, (uint32_t)sd, days, argv[3]);
            agg_add(&ag[prof][0], s.H_day, s.top_day, s.rep_day, s.n_exec_day, s.n_days_done);
            agg_add(&ag[prof][1], s.H2_day, s.top2_day, s.rep2_day, s.n2_exec_day, s.n_days_done);
            viol[prof] += s.budget_violations;
            memcpy(traits_end[prof][sd - 1], s.last_traits, sizeof s.last_traits);
            memcpy(traits_birth[prof][sd - 1], s.birth, sizeof s.birth);
            attach[prof][sd - 1] = s.alma.person[0].used ? s.alma.person[0].attachment : 0;
            if (s.use_mem) {
                /* días completos: el día 0 empieza a las 8:00 */
                for (int d = 1; d < s.n_days_done && nwd[prof] < 16 * 400; d++) wd[prof][nwd[prof]++] = (float)s.writes_day[d];
                for (int b = 0; b < ALMA_MEM_BLOCKS; b++) {
                    blk_total[prof][b] += s.mem.writes_by_block[b];
                    if (s.erase_max[b] > erase_worst[prof][b]) erase_worst[prof][b] = s.erase_max[b];
                }
                rest[prof] += s.restores;
                rest_bad[prof] += s.restore_mismatch;
                werr[prof] += s.mem.write_errors;
            }
            fprintf(stderr, "%-22s semilla %d: A: H med %.2f top %.2f terna %.0f n %.0f | B: H med %.2f top %.2f terna %.0f n %.0f | apego %.2f | bienestar %.0f\n",
                    PROF_NAME[prof], sd, median(s.H_day, s.n_days_done), median(s.top_day, s.n_days_done),
                    mediani(s.rep_day, s.n_days_done), mediani(s.n_exec_day, s.n_days_done),
                    median(s.H2_day, s.n_days_done), median(s.top2_day, s.n_days_done),
                    mediani(s.rep2_day, s.n_days_done), mediani(s.n2_exec_day, s.n_days_done), attach[prof][sd - 1],
                    s.alma.wellbeing);
        }
    }
    for (int v = 0; v < 2; v++) {
        fprintf(md, "## Variante %c\n\n", v ? 'B' : 'A');
        fprintf(md, "| Perfil | Decisiones/día (med.) | Entropía med. (bits) | Peor entropía | Entropía días 1-7 | Conducta top med. | Peor top | Días que cumplen A2.1 | Terna más repetida (med. / peor) | Días que cumplen A2.2 | Excesos de presupuesto (A2.7) |\n");
        fprintf(md, "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");
        for (int prof = 0; prof < PROF_COUNT; prof++) {
            agg *g = &ag[prof][v];
            fprintf(md, "| %s | %.0f | %.2f | %.2f | %.2f | %.0f%% | %.0f%% | %.0f%% | %.0f / %d | %.0f%% | %d |\n", PROF_NAME[prof],
                    median(g->n, g->k), median(g->H, g->k), g->worstH, median(g->H17, g->k17), 100 * median(g->top, g->k),
                    100 * g->worstTop, 100.0 * g->pass1 / g->k, median(g->rep, g->k), g->worstRep, 100.0 * g->pass2 / g->k, viol[prof]);
        }
        fprintf(md, "\n");
    }
    /* A2.3: dos semillas con el mismo dueño difieren ≥ 0.1 en al menos 2 de 5 rasgos a los 90 días */
    fprintf(md, "\n## A2.3: divergencia de rasgos entre semillas (día %d)\n\n", days);
    fprintf(md, "| Perfil | Pares que cumplen | Cambio medio desde el nacimiento por rasgo (bold, energy, soc, play, imp) | Apego final medio |\n| --- | --- | --- | --- |\n");
    int a23_ok[PROF_COUNT] = {0};
    for (int prof = 0; prof < PROF_COUNT; prof++) {
        int pairs = 0, ok = 0;
        for (int i = 0; i < seeds; i++)
            for (int j = i + 1; j < seeds; j++) {
                int k = 0;
                for (int t = 0; t < TRAIT_COUNT; t++) k += fabsf(traits_end[prof][i][t] - traits_end[prof][j][t]) >= 0.1f;
                pairs++;
                ok += k >= 2;
            }
        float dm[TRAIT_COUNT] = {0}, am = 0;
        for (int i = 0; i < seeds; i++) {
            for (int t = 0; t < TRAIT_COUNT; t++) dm[t] += (traits_end[prof][i][t] - traits_birth[prof][i][t]) / seeds;
            am += attach[prof][i] / seeds;
        }
        fprintf(md, "| %s | %d / %d | %+.3f, %+.3f, %+.3f, %+.3f, %+.3f | %.2f |\n", PROF_NAME[prof], ok, pairs,
                dm[0], dm[1], dm[2], dm[3], dm[4], am);
        a23_ok[prof] = 2 * ok > pairs;   /* 08: más de la mitad de los pares */
    }
    /* Veredicto con los métodos de 08: A2.1 y A2.2 sobre el día típico (mediana, variante A); A2.3 por mayoría de pares */
    fprintf(md, "\n## Veredicto (08, F2)\n\n| Perfil | A2.1 | A2.2 | A2.3 | A2.7 |\n| --- | --- | --- | --- | --- |\n");
    for (int prof = 0; prof < PROF_COUNT; prof++) {
        agg *g = &ag[prof][0];
        int a21 = median(g->H, g->k) >= 3.0f && median(g->top, g->k) <= 0.15f, a22 = median(g->rep, g->k) <= 3.0f;
        fprintf(md, "| %s | %s | %s | %s | %s |\n", PROF_NAME[prof], a21 ? "cumple" : "no cumple", a22 ? "cumple" : "no cumple",
                a23_ok[prof] ? "cumple" : "no cumple", viol[prof] ? "no cumple" : "cumple");
    }
    fprintf(md, "\nA2.1 se define para el dueño atento; los demás perfiles se muestran como referencia.\n");

    /* A2.9: misma semilla, dueño atento frente a brusco → al menos 2 rasgos difieren ≥ 0.1 a los 90 días */
    fprintf(md, "\n## A2.9: la crianza deja huella (misma semilla, atento frente a brusco, día %d)\n\n", days);
    fprintf(md, "| Semilla | Δ boldness | Δ energy | Δ sociability | Δ playfulness | Δ impulsivity | Rasgos con Δ ≥ 0.1 | Cumple |\n");
    fprintf(md, "| --- | --- | --- | --- | --- | --- | --- | --- |\n");
    int a29 = 0;
    for (int i = 0; i < seeds && i < 16; i++) {
        int k = 0;
        fprintf(md, "| %d |", i + 1);
        for (int t = 0; t < TRAIT_COUNT; t++) {
            float d = traits_end[PROF_ATENTO][i][t] - traits_end[PROF_BRUSCO][i][t];
            k += fabsf(d) >= 0.1f;
            fprintf(md, " %+.3f |", d);
        }
        fprintf(md, " %d | %s |\n", k, k >= 2 ? "sí" : "no");
        a29 += k >= 2;
    }
    fprintf(md, "\nA2.9 (mayoría de semillas, 08): %d de %d semillas cumplen → **%s**\n", a29, seeds, 2 * a29 > seeds ? "cumple" : "no cumple");
    fclose(md);
    fprintf(stderr, "resumen: %s\n", path);
    if (s.use_mem) {   /* aparte, para que resumen.md se pueda comparar byte por byte con una corrida sin memoria */
        snprintf(path, sizeof path, "%s/memoria.md", argv[3]);
        FILE *mm = fopen(path, "w");
        if (!mm) return 1;
        fprintf(mm, "# memory_store en el simulador (%d días, %d semillas por perfil)\n\n", days, seeds);
        fprintf(mm, "Escritura = una ranura escrita (borrar, payload, encabezado). Días completos: sin el día 0, que empieza a las 8:00.\n\n");
        fprintf(mm, "| Perfil | Escrituras/día (mediana) | Peor día | Restauraciones nocturnas | Distintas del estado | Errores de escritura |\n"
                    "| --- | --- | --- | --- | --- | --- |\n");
        for (int prof = 0; prof < PROF_COUNT; prof++) {
            float mx = 0;
            for (int i = 0; i < nwd[prof]; i++) if (wd[prof][i] > mx) mx = wd[prof][i];
            fprintf(mm, "| %s | %.0f | %.0f | %d | %d | %u |\n", PROF_NAME[prof], median(wd[prof], nwd[prof]), mx, rest[prof], rest_bad[prof], werr[prof]);
        }
        fprintf(mm, "\n## Escrituras por día y por bloque (media de todos los días)\n\n| Perfil |");
        for (int b = 0; b < MEM_JOURNAL; b++) fprintf(mm, " %s |", alma_mem_block_name(b));
        fprintf(mm, "\n| --- |");
        for (int b = 0; b < MEM_JOURNAL; b++) fprintf(mm, " --- |");
        fprintf(mm, "\n");
        for (int prof = 0; prof < PROF_COUNT; prof++) {
            fprintf(mm, "| %s |", PROF_NAME[prof]);
            for (int b = 0; b < MEM_JOURNAL; b++) fprintf(mm, " %.1f |", blk_total[prof][b] / (seeds * (days - 8.0 / 24)));
            fprintf(mm, "\n");
        }
        /* desgaste: borrados del sector más usado de cada bloque, peor semilla */
        double run_days = days - 8.0 / 24;
        fprintf(mm, "\n## Desgaste: sector más usado (peor semilla), a 100 000 ciclos\n\n"
                    "| Perfil | Bloque del sector más usado | Borrados en %d días | Borrados por día | Vida estimada (años) |\n"
                    "| --- | --- | --- | --- | --- |\n", days);
        for (int prof = 0; prof < PROF_COUNT; prof++) {
            int wb = 0;
            for (int b = 1; b < ALMA_MEM_BLOCKS; b++) if (erase_worst[prof][b] > erase_worst[prof][wb]) wb = b;
            double per_day = erase_worst[prof][wb] / run_days;
            fprintf(mm, "| %s | %s | %u | %.1f | %.1f |\n", PROF_NAME[prof], alma_mem_block_name(wb), erase_worst[prof][wb], per_day,
                    per_day > 0 ? 100000.0 / per_day / 365.25 : 0);
        }
        fprintf(mm, "\nBorrados por día del sector más usado de cada bloque:\n\n| Perfil |");
        for (int b = 0; b < MEM_JOURNAL; b++) fprintf(mm, " %s |", alma_mem_block_name(b));
        fprintf(mm, "\n| --- |");
        for (int b = 0; b < MEM_JOURNAL; b++) fprintf(mm, " --- |");
        fprintf(mm, "\n");
        for (int prof = 0; prof < PROF_COUNT; prof++) {
            fprintf(mm, "| %s |", PROF_NAME[prof]);
            for (int b = 0; b < MEM_JOURNAL; b++) fprintf(mm, " %.1f |", erase_worst[prof][b] / run_days);
            fprintf(mm, "\n");
        }
        fclose(mm);
        fprintf(stderr, "memoria: %s\n", path);
    }
    return 0;
}
