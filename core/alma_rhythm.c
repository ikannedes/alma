/* alma_rhythm.c — estados (01), ritmo diario, reflejos (05) y pase nocturno local (04). */
#include <math.h>
#include <string.h>
#include "alma_internal.h"

/* 05: .mot de EV_CLIFF, por dónde está el borde (decisión del dueño, 2026-10-30): alejarse caminando hacia atrás o
   hacia adelante; con un pie entero en el aire, moverse de lado hacia el otro. cliff_L/cliff_R de fábrica inclinan un pie
   hasta 30° y mueven a EMO ~2 cm de lado (medido: "salta hacia un lado"). Hacia qué lado: según el simulador con los
   sentidos de servo medidos, cliff_L a su izquierda y cliff_R a su derecha (DERIVADO; PENDIENTE confirmar en el robot). */
#define REFLEX_CLIFF_FRONT     "explore_back_away"
#define REFLEX_CLIFF_REAR      "explore_foward"
/* MEDIDO 2026-10-30: con el pie derecho en el aire, cliff_L lanzó a EMO hacia la derecha (al vacío): el simulador tenía
   el lado al revés. Se prueba el espejo: pie derecho en el aire → cliff_R. PENDIENTE confirmar que lo lleva a la mesa */
#define REFLEX_CLIFF_FOOT_L    "cliff_L"           /* pie izquierdo en el aire → a la derecha (por confirmar) */
#define REFLEX_CLIFF_FOOT_R    "cliff_R"
#define REFLEX_PUT_DOWN_PREFIX "react_put_down_"  /* 05: .mot de bajada */

int alma_hour(double now_s)
{
    double h = fmod(now_s / 3600.0, 24.0);
    if (h < 0) h += 24.0;
    return (int)h;
}

int alma_in_night_window(const alma_t *a, double now_s)
{
    (void)a;
    return (alma_hour(now_s) - NIGHT_WINDOW_DEFAULT_START + 24) % 24 < NIGHT_WINDOW_H;
}

/* Identifica la noche: constante durante toda la ventana aunque cruce la medianoche */
static int night_key(double now_s)
{
    return (int)floor((now_s - NIGHT_WINDOW_DEFAULT_START * 3600.0) / 86400.0);
}

static int house_inactive(const alma_t *a, double now_s)
{
    /* sin ninguna cara conocida desde el arranque (recién nacida, o la cámara no detecta) cuenta el último estímulo:
       antes la casa salía vacía desde el primer segundo y en el robot descansaba sin parar (2026-10-30) */
    if (a->last_known_face_s < -1e11)
        return a->home_presence_hist[alma_hour(now_s)] <= PRESENCE_AWAKE && now_s - a->last_stimulus_s >= INACTIVE_NO_FACE_S;
    return a->home_presence_hist[alma_hour(now_s)] <= PRESENCE_AWAKE && !alma_any_known_present(a)
           && now_s - a->last_known_face_s >= INACTIVE_NO_FACE_S;
}

void alma_stimulus(alma_t *a, double now_s)
{
    a->last_stimulus_s = now_s;
    if (a->state == ST_RESTING) {
        a->state = ST_AWAKE;
        a->resting_for_rest = 0;
        a->pause_until_s = now_s;
    }
}

void alma_wake(alma_t *a, double now_s, int full_wake)
{
    a->state = ST_AWAKE;
    a->resting_for_rest = 0;
    a->sleep_here = 0;
    a->last_stimulus_s = now_s;
    a->pause_until_s = now_s;
    if (full_wake) {
        a->awake_since_s = now_s;
        alma_force(a, a->ix_stretch, now_s);   /* 04: despertar con bhv_stretch */
    }
}

static int option_with_prefix(alma_t *a, int b, const char *prefix)
{
    if (b < 0) return -1;
    const alma_behavior *x = &a->cat->b[b];
    int ok[ALMA_MAX_OPTIONS], n = 0;
    for (int i = 0; i < x->n_opt; i++)
        if (strncmp(x->opt[i].mot[0], prefix, strlen(prefix)) == 0) ok[n++] = i;
    return n ? ok[(int)(alma_rng_u01(&a->rng) * n)] : -1;
}

/* ST_REFLEX: detener servos (la detención no consume presupuesto, 04). Con EV_PICKED_UP, enojo y forcejeo
 * (bhv_reflex_struggle, dueño 2026-10-30); con EV_SHAKEN, solo cara y sonido; con EV_CLIFF, alejarse del borde;
 * bhv_ask_help con EV_TIPPED_OVER (05). */
static void reflex_enter(alma_t *a, alma_ev_type t, int cliff_where, double now_s)
{
    /* levantado: en la mano no se cae de ningún borde, y el forcejeo en curso no se corta ni se reinicia (medido
       2026-10-30: al levantarlo los pies pierden el piso ~0.4 s antes de que el IMU lo note, y siguen llegando bordes) */
    int struggling = a->cur.active && a->cur.behavior == a->ix_struggle;
    if (a->lifted && (t == EV_CLIFF || ((t == EV_PICKED_UP || t == EV_SHAKEN) && struggling))) {
        a->reflex_last_s = now_s;
        return;
    }
    int was = a->state == ST_REFLEX;
    if (a->cur.active) alma_finish(a, now_s, 1);
    a->state = ST_REFLEX;
    a->reflex_last_s = now_s;
    a->put_down_s = -1;
    a->reflex_put_down = 0;
    if (t == EV_PICKED_UP) {
        a->lifted = 1;
        /* decisión del dueño, 2026-10-30: al levantarlo, enojo y forcejeo (struggle_strong_*), después de detener los
           servos, aunque ya estuviera en otro reflejo (el borde que llega justo antes). Sin bhv_reflex_struggle en el
           catálogo, como antes: solo cara */
        if (a->ix_struggle >= 0) { alma_start_opt(a, a->ix_struggle, RUN_REFLEX, now_s, 0, 2, -2); return; }
    }
    if (t == EV_SHAKEN && a->ix_dizzy >= 0) {
        /* dueño, 2026-10-30: sacudida → ojos mareados ya; al terminar, un final de sacudida (reflex_tick) */
        a->shaken_pending = 1;
        if (!was || !a->cur.active) alma_start_opt(a, a->ix_dizzy, RUN_REFLEX, now_s, 0, 2, -1);
        return;
    }
    if (t == EV_TIPPED_OVER) {
        a->tipped = 1;
        if (a->ix_ask_help >= 0) { alma_start_opt(a, a->ix_ask_help, RUN_REFLEX, now_s, 0, 2, -1); return; }
    }
    if (t == EV_CLIFF) {
        const char *p = cliff_where == ALMA_CLIFF_REAR ? REFLEX_CLIFF_REAR : cliff_where == ALMA_CLIFF_FOOT_L ? REFLEX_CLIFF_FOOT_L
                      : cliff_where == ALMA_CLIFF_FOOT_R ? REFLEX_CLIFF_FOOT_R : cliff_where == ALMA_CLIFF_BOTH ? NULL : REFLEX_CLIFF_FRONT;
        int o = p ? option_with_prefix(a, a->ix_reflex, p) : -1;   /* −1: quieto, solo cara */
        alma_start_opt(a, a->ix_reflex, RUN_REFLEX, now_s, 0, 2, o >= 0 ? o : -1);
        return;
    }
    if (!was) alma_start_opt(a, a->ix_reflex, RUN_REFLEX, now_s, 0, 2, -1);
}

void alma_reflex_enter(alma_t *a, alma_ev_type t, double now_s) { reflex_enter(a, t, ALMA_CLIFF_FRONT, now_s); }
void alma_reflex_enter_cliff(alma_t *a, int where, double now_s) { reflex_enter(a, EV_CLIFF, where, now_s); }

static void reflex_tick(alma_t *a, double now_s)
{
    if (a->cur.active) {
        /* la detención sin movimiento dura lo que dure la condición; los .mot terminan con EV_BEHAVIOR_DONE */
        if (a->cur.option >= 0) return;
        alma_finish(a, now_s, 0);
    }
    /* volcado: sigue pidiendo ayuda mientras no la levanten (dueño, 2026-11-02: "acostada no hace nada, su cara normal") */
    if (a->tipped && a->ix_ask_help >= 0 && now_s - a->last_exec_t[a->ix_ask_help] >= ASK_HELP_EVERY_S) {
        alma_start_opt(a, a->ix_ask_help, RUN_REFLEX, now_s, 0, 2, -1);
        return;
    }
    if (a->lifted || a->tipped || now_s - a->reflex_last_s < SHAKE_END_S) return;
    if (a->shaken_pending) {   /* terminó la sacudida: mareada (shake_end_*, el de la lengua incluido) */
        a->shaken_pending = 0;
        alma_start_opt(a, a->ix_dizzy, RUN_REFLEX, now_s, 0, 2, -2);
        if (a->cur.option >= 0) return;
        alma_finish(a, now_s, 0);
    }
    if (a->put_down_s >= 0) {
        if (now_s - a->put_down_s < PUT_DOWN_STABLE_S) return;
        if (!a->reflex_put_down) {
            /* 05: EV_PUT_DOWN y 1 s estable en el suelo → react_put_down_1 o _2 */
            a->reflex_put_down = 1;
            int o = option_with_prefix(a, a->ix_reflex, REFLEX_PUT_DOWN_PREFIX);
            if (o >= 0) { alma_start_opt(a, a->ix_reflex, RUN_REFLEX, now_s, 0, 2, o); if (a->cur.option >= 0) return; alma_finish(a, now_s, 0); }
        }
    }
    a->state = ST_AWAKE;
    a->pause_until_s = now_s + PAUSE_MIN_S;
}

void alma_state_tick(alma_t *a, double now_s)
{
    if (a->reminder_pending && a->state != ST_REFLEX && a->state != ST_LISTENING) {   /* alarma pospuesta */
        a->reminder_pending = 0;
        alma_force(a, a->ix_reminder, now_s);
    }
    float need_rest = alma_need(a, NEED_REST);
    int P = alma_P(a);
    switch (a->state) {
    case ST_BOOT:
        a->state = ST_AWAKE;
        break;
    case ST_SLEEPING:
        if (!alma_in_night_window(a, now_s)) alma_wake(a, now_s, 1);
        else if (!a->on_charger && !a->sleep_here) alma_wake(a, now_s, 0);
        break;
    case ST_RESTING:
        /* dueño, 2026-11-01: de 20:00 a 8:00 duerme en la base (o con el USB, donde está); si no está en la base, el
           firmware la lleva sola y, si no llega, duerme ahí (alma_sleep_here) */
        if (alma_in_night_window(a, now_s) && (a->on_charger || a->sleep_here)) {
            a->state = ST_SLEEPING;
            int key = night_key(now_s);
            if (key != a->night_done_for_day) {
                a->night_done_for_day = key;
                alma_night_cycle(a, now_s);
            }
            break;
        }
        if (alma_in_night_window(a, now_s)) break;   /* de noche no se levanta sola: solo un estímulo la despierta */
        if (!(a->resting_for_rest && need_rest >= REST_EXIT) && !house_inactive(a, now_s)) {
            a->state = ST_AWAKE;
            a->resting_for_rest = 0;
            a->pause_until_s = now_s;
        }
        break;
    case ST_AWAKE: {
        /* de noche, tenerla enfrente no la mantiene despierta: solo jugar con ella (3 min tras el último estímulo) */
        int night = alma_in_night_window(a, now_s);
        int sticky = (!night && P >= 0 && a->person[P].facing) || now_s - a->last_stimulus_s < STIMULUS_STICKY_S;
        if (!sticky && (night || need_rest > REST_ENTER || house_inactive(a, now_s))) {
            a->state = ST_RESTING;
            a->resting_for_rest = need_rest > REST_ENTER;
            break;
        }
        if (now_s >= a->pause_until_s) alma_select(a, now_s, RUN_SELECTOR);
        break;
    }
    case ST_PERFORMING:
        if (now_s >= a->next_hyst_s) {
            a->next_hyst_s = now_s + HYST_CHECK_S;
            alma_hysteresis_check(a, now_s);
        }
        break;
    case ST_LISTENING:
        if (now_s - a->listen_since_s > LISTEN_TIMEOUT_S) {
            alma_finish(a, now_s, 0);
            a->state = ST_AWAKE;
            a->pause_until_s = now_s;
        }
        break;
    case ST_REFLEX:
        reflex_tick(a, now_s);
        break;
    }
}

static float clip1(float v) { return alma_clampf(v, -1, 1); }

void alma_sleep_here(alma_t *a) { a->sleep_here = 1; }

/* trait_learned con tope ±TRAIT_LEARNED_MAX; el valor efectivo se recorta a [0, 1] (04, "Plasticidad") */
static void trait_learn(alma_t *a, int k, float d)
{
    a->trait_learned[k] = alma_clampf(a->trait_learned[k] + d, -TRAIT_LEARNED_MAX, TRAIT_LEARNED_MAX);
    a->trait[k] = alma_clampf(a->trait_base[k] + a->trait_learned[k], 0, 1);
}

/* 07: cada nudge en [−0.01, 0.01], × plasticity (× 0.1 más en impulsivity); la suma con el cambio local
 * de la noche no supera max_delta_por_noche; y suma a trait_learned con el mismo tope */
void alma_trait_nudges(alma_t *a, const float nudges[TRAIT_COUNT])
{
    float plasticity = (a->age_days - 1) < TRAIT_PLASTIC_AGE_DAYS ? TRAIT_PLASTICITY_YOUNG : TRAIT_PLASTICITY_ADULT;
    for (int k = 0; k < TRAIT_COUNT; k++) {
        float n = alma_clampf(nudges[k], -TRAIT_NUDGE_MAX, TRAIT_NUDGE_MAX) * plasticity;
        if (k == TRAIT_IMPULSIVITY) n *= TRAIT_IMPULSIVITY_PLASTICITY;
        float m = a->night_maxd[k], sum = alma_clampf(a->night_delta[k] + n, -m, m);
        n = sum - a->night_delta[k];
        a->night_delta[k] = sum;
        trait_learn(a, k, n);
    }
}

void alma_traits_export(const alma_t *a, float base[TRAIT_COUNT], float learned[TRAIT_COUNT])
{
    memcpy(base, a->trait_base, sizeof a->trait_base);
    memcpy(learned, a->trait_learned, sizeof a->trait_learned);
}

void alma_traits_import(alma_t *a, const float base[TRAIT_COUNT], const float learned[TRAIT_COUNT])
{
    memcpy(a->trait_base, base, sizeof a->trait_base);
    for (int k = 0; k < TRAIT_COUNT; k++) { a->trait_learned[k] = 0; trait_learn(a, k, learned[k]); }
}

static float capf(float v, float cap) { return v < cap ? v : cap; }

/* Bienestar (04; dueño, 2026-10-30): lo bueno y lo malo del día, cada parte con tope; total ±WB_DAY_MAX */
int alma_wellbeing_day_points(const alma_t *a, int *absent_days_out)
{
    const alma_counters *c = &a->counts;
    int seen_h = 0;
    for (int h = 0; h < 24; h++) seen_h += a->hour_seen[h] > 0;
    int absent = seen_h ? 0 : a->absent_days + 1;
    float p = capf(WB_PLAY_PTS * c->play_done, WB_PLAY_CAP) + capf((float)(c->pets + c->praises), WB_PET_CAP)
              + capf((float)seen_h, WB_SEEN_CAP) + capf(WB_EXPLORE_PTS * c->explore_ok, WB_EXPLORE_CAP)
              - capf(WB_SCARE_PTS * c->scares, WB_SCARE_CAP) - capf(WB_LIFT_PTS * c->lifts, WB_LIFT_CAP)
              - capf(WB_SHAKE_PTS * c->shakes, WB_SHAKE_CAP) - capf(WB_SCOLD_PTS * c->scolds, WB_SCOLD_CAP);
    if (absent) p -= capf(WB_ABSENT_PTS + WB_ABSENT_STEP * (absent - 1), WB_ABSENT_CAP);
    /* tamagotchi y juegos desde la app (dueño, 2026-10-30) */
    p += capf(WB_MEAL_PTS * c->meals, WB_MEAL_CAP) - capf(WB_STARVE_PTS_PER_30MIN * c->starve_min / 30.0f, WB_STARVE_CAP)
         + alma_remote_play_points(c->remote_play_s);
    if (absent_days_out) *absent_days_out = absent;
    int r = (int)lroundf(p);
    return r > WB_DAY_MAX ? WB_DAY_MAX : r < -WB_DAY_MAX ? -WB_DAY_MAX : r;
}

/* Puntos del día ponderados por dónde está (04, "Bienestar"): hacia el extremo, menos; hacia 0, más */
float alma_wellbeing_step(float base, float points)
{
    float x = fabsf(base) / WB_MAX;
    int outward = points * base >= 0;   /* desde 0, cualquier dirección es "hacia afuera" */
    float k = outward ? (fabsf(base) <= WB_OUT_KNEE ? 1.0f
                         : 1.0f - (1.0f - WB_OUT_MIN) * (fabsf(base) - WB_OUT_KNEE) / (WB_MAX - WB_OUT_KNEE))
                      : 1.0f + WB_IN_GAIN * x * x;
    return alma_clampf(base + points * k, -WB_MAX, WB_MAX);
}

void alma_wellbeing_adjust(alma_t *a, int adjust)
{
    if (adjust > WB_CLOUD_ADJ_MAX) adjust = WB_CLOUD_ADJ_MAX;
    if (adjust < -WB_CLOUD_ADJ_MAX) adjust = -WB_CLOUD_ADJ_MAX;
    int total = a->wb_day_points + adjust;
    if (total > WB_DAY_MAX) total = WB_DAY_MAX;
    if (total < -WB_DAY_MAX) total = -WB_DAY_MAX;
    a->wb_day_adjust = total - a->wb_day_points;   /* el ajuste efectivo, después de los topes */
    a->wellbeing = alma_wellbeing_step(a->wb_base, (float)total);
}

int alma_forget_unseen(alma_t *a, double now_s)
{
    if (!a->forget_enabled) return 0;
    int n = 0;
    for (int i = 0; i < ALMA_MAX_PERSONS; i++) {
        alma_person *p = &a->person[i];
        if (!p->used || p->id == ALMA_OWNER_ID || p->present || p->last_seen_s < -1e11) continue;
        if (now_s - p->last_seen_s < FORGET_DAYS * 86400.0) continue;
        int id = p->id;
        memset(p, 0, sizeof *p);   /* lugar libre en bonds: apego, preferencias y fechas se van con ella */
        n++;
        if (a->hooks.on_forget) a->hooks.on_forget(a->hooks.user, id);
    }
    return n;
}

void alma_night_cycle(alma_t *a, double now_s)
{
    /* 0. bienestar: deriva hacia 0 y puntos del día ponderados (antes de borrar los contadores) */
    a->wb_day_points = alma_wellbeing_day_points(a, &a->absent_days);
    a->wb_day_adjust = 0;
    a->wb_base = a->wellbeing * (1.0f - WB_DRIFT);
    a->wellbeing = alma_wellbeing_step(a->wb_base, (float)a->wb_day_points);
    /* 1. cerrar contadores y entregar el resumen */
    if (a->hooks.on_night) {
        alma_day_summary s;
        memset(&s, 0, sizeof s);
        s.age_days = a->age_days;
        memcpy(s.traits, a->trait, sizeof s.traits);
        s.mood_end = a->mood;
        s.counts = a->counts;
        for (int i = 0; i < ALMA_MAX_PERSONS; i++) s.attachment[i] = a->person[i].used ? a->person[i].attachment : -1;
        s.servo_active_s = a->servo_active_s_today;
        s.wellbeing = a->wellbeing;
        s.day_points = a->wb_day_points;
        s.absent_days = a->absent_days;
        a->hooks.on_night(a->hooks.user, &s);
    }
    /* 1b. olvidar a quien no se ve en 4 semanas (06), después del resumen: el de hoy aún la incluye */
    alma_forget_unseen(a, now_s);
    /* 2. ánimo */
    a->mood *= NIGHT_MOOD_FACTOR;
    /* 3. rasgos con plasticidad: los cambios van a trait_learned, nunca a trait_base */
    const alma_counters *c = &a->counts;
    float plasticity = a->age_days < TRAIT_PLASTIC_AGE_DAYS ? TRAIT_PLASTICITY_YOUNG : TRAIT_PLASTICITY_ADULT;
    float maxd = TRAIT_MAX_DELTA_NIGHT * plasticity;
    float d_soc = clip1((c->pets + c->praises + c->play_done - NIGHT_DSOC_SCOLD_W * c->scolds - NIGHT_DSOC_SHAKE_W * c->shakes) / NIGHT_DSOC_DIV);
    float d_bold = clip1((c->novel_ok + c->explore_ok - NIGHT_DBOLD_SCARE_W * c->scares) / NIGHT_DBOLD_DIV);
    float d_play = clip1((c->play_done - c->play_ignored / NIGHT_DPLAY_IGNORED_DIV
                          - NIGHT_DPLAY_SCOLD_W * c->scolds - NIGHT_DPLAY_SHAKE_W * c->shakes) / NIGHT_DPLAY_DIV);
    float delta[TRAIT_COUNT] = {0};
    delta[TRAIT_SOCIABILITY] = maxd * d_soc;
    delta[TRAIT_BOLDNESS] = maxd * d_bold;
    delta[TRAIT_PLAYFULNESS] = maxd * d_play;
    /* trait_energy: después del día 60, −0.0005 por día hasta −0.1 (cuenta dentro de trait_learned) */
    if (a->age_days >= TRAIT_ENERGY_DECLINE_DAY && a->trait_learned[TRAIT_ENERGY] > -TRAIT_ENERGY_DECLINE_MAX) {
        float room = a->trait_learned[TRAIT_ENERGY] + TRAIT_ENERGY_DECLINE_MAX;
        delta[TRAIT_ENERGY] = -(TRAIT_ENERGY_DECLINE_PER_DAY < room ? TRAIT_ENERGY_DECLINE_PER_DAY : room);
    }
    for (int k = 0; k < TRAIT_COUNT; k++) {
        a->night_delta[k] = delta[k];
        a->night_maxd[k] = maxd * (k == TRAIT_IMPULSIVITY ? TRAIT_IMPULSIVITY_PLASTICITY : 1.0f);
        trait_learn(a, k, delta[k]);
    }
    /* 4. ausencias: −1% por día sobre el piso */
    for (int i = 0; i < ALMA_MAX_PERSONS; i++) {
        alma_person *p = &a->person[i];
        if (!p->used) continue;
        if (!p->seen_today) p->attachment = p->floor + (p->attachment - p->floor) * ATTACH_ABSENCE_DECAY;
        p->seen_today = 0;
    }
    /* 5. interés */
    for (int b = 0; b < a->cat->n; b++) a->interest[b] += INTEREST_NIGHT_RESTORE * (1.0f - a->interest[b]);
    /* 6. presencia por hora y ventana nocturna */
    for (int h = 0; h < 24; h++) {
        a->home_presence_hist[h] += PRESENCE_ALPHA * ((float)a->hour_seen[h] - a->home_presence_hist[h]);
        a->hour_seen[h] = 0;
    }
    a->night_start_h = NIGHT_WINDOW_DEFAULT_START;   /* fija (2026-11-01); ya no se aprende de la presencia */
    /* 7-8. edad (libera conductas por unlock_day) y presupuesto */
    a->age_days++;
    a->servo_active_s_today = 0;
    memset(&a->counts, 0, sizeof a->counts);
    /* 9-10: persistencia (memory_store, 06) y nube (07) quedan fuera del núcleo */
}
