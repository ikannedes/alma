/* test_core.c — pruebas unitarias de alma_core (fórmulas y constantes de 04).
 * Uso: test_core [catalog.json inventory.json]   (con archivos, también valida el catálogo real) */
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "alma_internal.h"
#include "catalog_load.h"

static int fails, checks;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { fails++; printf("FALLA %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)
#define NEAR(a, b, tol) (fabs((double)(a) - (double)(b)) <= (tol))

static alma_catalog cat;

/* Catálogo mínimo: lo justo para que el núcleo encuentre sus índices fijos */
static int add_b(const char *id, alma_category c, float base, float cooldown)
{
    alma_behavior *b = &cat.b[cat.n];
    memset(b, 0, sizeof *b);
    snprintf(b->id, ALMA_ID_LEN, "%s", id);
    b->category = c;
    b->base = base;
    b->cooldown_s = cooldown;
    for (int i = 0; i < SM_COUNT; i++) b->mood_fit[i] = 1;
    b->dur_min_s = b->dur_max_s = 2;
    return cat.n++;
}

static void add_opt(int b, const char *mot, float dur, int gait)
{
    alma_motion_opt *o = &cat.b[b].opt[cat.b[b].n_opt++];
    memset(o, 0, sizeof *o);
    snprintf(o->mot[0], ALMA_MOT_LEN, "%s", mot);
    o->n = 1;
    o->dur_s = dur;
    o->gait = gait;
    if (dur > cat.b[b].servo_cost_s) cat.b[b].servo_cost_s = dur;
}

static int B_BLINK, B_LOOK, B_TOY, B_GAIT, B_REFLEX, B_STARTLE, B_ENJOY, B_LISTEN, B_CONFUSED;

static void build_catalog(void)
{
    cat.n = 0;
    B_BLINK = add_b("bhv_blink_idle", CAT_IDLE, 0.01f, 5);
    B_LOOK = add_b("bhv_look_around", CAT_IDLE, 0.01f, 30);
    B_TOY = add_b("bhv_toy", CAT_PLAY, 1.0f, 0);
    add_opt(B_TOY, "toy_a", 10, 0);
    B_GAIT = add_b("bhv_explore", CAT_EXPLORE, 0.01f, 0);
    add_opt(B_GAIT, "walk_a", 4, 1);
    add_opt(B_GAIT, "walk_b", 6, 1);
    B_REFLEX = add_b("bhv_reflex_freeze", CAT_REFLEX, 1, 0);
    add_opt(B_REFLEX, "explore_back_away1", 2, 1);
    add_opt(B_REFLEX, "react_put_down_1", 2, 0);
    B_STARTLE = add_b("bhv_startle", CAT_EMOTION, 1, 10);
    add_opt(B_STARTLE, "loud_sound1", 3, 0);
    B_ENJOY = add_b("bhv_enjoy_pet", CAT_SOCIAL, 1, 3);
    add_opt(B_ENJOY, "touch_get_in", 4, 0);
    B_LISTEN = add_b("bhv_listen", CAT_COMMAND, 1, 0);
    cat.b[B_LISTEN].dur_min_s = cat.b[B_LISTEN].dur_max_s = 8;
    B_CONFUSED = add_b("bhv_confused", CAT_EMOTION, 1, 5);
    add_opt(B_CONFUSED, "dont_understand", 1, 0);
}

static alma_t A;
static void fresh(double now) { alma_init(&A, &cat, 1234, now, (alma_hooks){0}); }
static alma_ev ev(alma_ev_type t) { alma_ev e = {t, -1, -1, -1, 0, 0, 0, 0}; return e; }
static void ticks(double *t, int n) { alma_sensors s = {100, 1}; for (int i = 0; i < n; i++) { *t += 1; alma_tick(&A, *t, &s); } }
static void ticks_off(double *t, int n) { alma_sensors s = {100, 0}; for (int i = 0; i < n; i++) { *t += 1; alma_tick(&A, *t, &s); } }   /* fuera de la base */

static void test_rng(void)
{
    alma_rng r;
    alma_rng_seed(&r, 7);
    double m = 0, v = 0;
    const int N = 200000;
    for (int i = 0; i < N; i++) { double x = alma_rng_beta22(&r); m += x; v += x * x; }
    m /= N; v = v / N - m * m;
    CHECK(NEAR(m, 0.5, 0.005), "Beta(2,2) media %.4f", m);
    CHECK(NEAR(v, 0.05, 0.002), "Beta(2,2) varianza %.4f (esperada 1/20)", v);
}

static void test_emotions(void)
{
    double t = 0;
    fresh(t);
    A.trait[TRAIT_BOLDNESS] = A.trait_base[TRAIT_BOLDNESS] = 0.5f;
    A.state = ST_RESTING;   /* sin selección: solo dinámica */
    alma_add_fear(&A, 0.8f, t);
    ticks(&t, 20);
    CHECK(NEAR(A.emo_fear, 0.4, 0.01), "miedo a los 20 s = %.3f (media vida 20 s)", A.emo_fear);
    ticks(&t, 40);
    CHECK(A.emo_fear == 0, "miedo a los 60 s = %.3f (debe ser 0)", A.emo_fear);

    alma_add_joy(&A, 0.5f, t);
    double t0 = t;
    alma_emotions_at(&A, t0 + 10); CHECK(NEAR(A.emo_joy, 0.5, 1e-4), "joy a 10 s %.3f", A.emo_joy);
    alma_emotions_at(&A, t0 + 30); CHECK(NEAR(A.emo_joy, 0.45, 1e-4), "joy a 30 s %.3f", A.emo_joy);
    alma_emotions_at(&A, t0 + 75); CHECK(NEAR(A.emo_joy, 0.30, 1e-4), "joy a 75 s %.3f", A.emo_joy);
    alma_emotions_at(&A, t0 + 150); CHECK(NEAR(A.emo_joy, 0, 1e-4), "joy a 150 s %.3f", A.emo_joy);

    alma_add_frust(&A, 0.7f, t0);
    alma_emotions_at(&A, t0 + 35); CHECK(NEAR(A.emo_frustration, 0.35, 1e-4), "frustración a 35 s %.3f", A.emo_frustration);
    alma_emotions_at(&A, t0 + 70); CHECK(NEAR(A.emo_frustration, 0, 1e-4), "frustración a 70 s %.3f", A.emo_frustration);
}

static void test_event_gain_and_repeat(void)
{
    double t = 1000;
    fresh(t);
    A.trait[TRAIT_BOLDNESS] = A.trait_base[TRAIT_BOLDNESS] = 0.5f;
    A.state = ST_RESTING;
    alma_ev e = ev(EV_LOUD_SOUND);
    alma_event(&A, &e, t);
    CHECK(NEAR(A.emo_fear, 0.5, 1e-4), "EV_LOUD_SOUND con boldness 0.5: miedo %.3f (0.5 × (1.5 − 0.5))", A.emo_fear);

    fresh(t);
    A.trait[TRAIT_SOCIABILITY] = A.trait_base[TRAIT_SOCIABILITY] = 0.5f;
    A.state = ST_RESTING;
    alma_ev p = ev(EV_TOUCH_PET);
    alma_event(&A, &p, t);
    float j1 = A.emo_joy;
    CHECK(NEAR(j1, 0.4 * (0.7 + 0.6 * 0.5), 1e-4), "caricia: joy %.3f (0.4 × ganancia social)", j1);
    alma_event(&A, &p, t + 0.3);
    CHECK(A.counts.pets == 1, "caricia repetida en < 0.5 s no tiene efecto (pets = %d)", A.counts.pets);
    float s0 = A.stim;
    alma_event(&A, &p, t + 0.3 + 5.0);
    CHECK(NEAR(A.stim - s0, 0.1 * 0.5, 1e-3), "a los 5 s el efecto es 50%%: Δstim %.3f", A.stim - s0);
}

static void test_needs(void)
{
    double t = 0;
    fresh(t);
    A.state = ST_RESTING;
    A.stim = 0.5f;
    A.need_social = 0.3f;
    A.trait[TRAIT_SOCIABILITY] = A.trait_base[TRAIT_SOCIABILITY] = 0.5f;
    alma_sensors s = {100, 1};
    for (int i = 0; i < 60; i++) { t += 1; alma_tick(&A, t, &s); }
    CHECK(NEAR(A.stim, 0.5 - 0.12, 2e-3), "stim tras 1 min en tramo medio %.3f", A.stim);
    for (int i = 0; i < 3600 - 60; i++) { t += 1; alma_tick(&A, t, &s); }
    CHECK(NEAR(A.need_social, 0.3 + 0.1, 2e-3), "need_social tras 1 h sin compañía %.3f", A.need_social);
    A.need_social = 0.89f;
    for (int i = 0; i < 3600; i++) { t += 1; alma_tick(&A, t, &s); }
    CHECK(A.need_social <= 0.9f + 1e-6f, "techo de need_social 0.9 (%.3f)", A.need_social);

    fresh(0);
    A.t_now = 8 * 3600;
    A.awake_since_s = 0;
    A.soc_pct = 40;
    CHECK(NEAR(alma_need(&A, NEED_REST), 0.6, 1e-4), "need_rest por batería 40%% = %.3f", alma_need(&A, NEED_REST));
    A.soc_pct = 100;
    CHECK(NEAR(alma_need(&A, NEED_REST), 0.5, 1e-4), "need_rest por 8 h despierta = %.3f", alma_need(&A, NEED_REST));
    A.trait[TRAIT_ENERGY] = A.trait_base[TRAIT_ENERGY] = 0.5f;
    A.servo_active_s_today = 0.9f * alma_budget_s(&A);
    CHECK(NEAR(alma_budget_s(&A), 5400, 1e-3), "budget_s con energy 0.5 = %.0f", alma_budget_s(&A));
    CHECK(NEAR(alma_need(&A, NEED_REST), 0.9, 1e-4), "need_rest por servo 90%% = %.3f", alma_need(&A, NEED_REST));
}

static void test_mood(void)
{
    /* valencia fija −0.2·0.5 = −0.1: tras τ = 3 h el ánimo llega a −0.1·(1 − e⁻¹) */
    fresh(0);
    A.mood = 0;
    for (int i = 1; i <= 10800; i++) {
        A.need_social = 0.5f; A.boredom = 0; A.stim = 0.5f;
        alma_affect_tick(&A, 1.0f, i);
    }
    CHECK(NEAR(A.mood, -0.1 * (1 - exp(-1.0)), 2e-4), "ánimo tras 3 h con valencia −0.1: %.4f", A.mood);

    fresh(0);
    A.emo_fear = 0.6f; A.fear_t = 0;
    A.soc_pct = 10;   /* need_rest 0.9 */
    alma_affect_tick(&A, 0, 0);
    CHECK(A.simple_mood == SM_SCARED, "SM_SCARED tiene prioridad sobre SM_SLEEPY");
    A.emo_fear = 0;
    alma_affect_tick(&A, 0, 0);
    CHECK(A.simple_mood == SM_SLEEPY, "SM_SLEEPY con need_rest 0.9");
}

static void test_attachment(void)
{
    double t = 0;
    fresh(t);
    A.trait[TRAIT_SOCIABILITY] = A.trait_base[TRAIT_SOCIABILITY] = 0.5f;
    alma_ev f = {EV_FACE_SEEN, 1, -1, -1, 160, 120, 80, 0};
    alma_event(&A, &f, t);
    int s = alma_slot_of(&A, 1);
    A.person[s].attachment = 0;
    for (int i = 0; i < 30; i++) alma_attach(&A, s, 1.0f);   /* A4.3: 3 sesiones de 10 min, w ≈ 1 por minuto */
    float a30 = A.person[s].attachment;
    /* forma cerrada de dA/du = K·(1 − A)^(1+γ): (1 − A)^(−γ) = 1 + γ·K·u */
    double closed = 1 - pow(1 + ATTACH_GAMMA * K_ATTACH * 30.0, -1.0 / ATTACH_GAMMA);
    CHECK(a30 >= 0.4f, "A4.3: 30 unidades de buena interacción → A %.3f (≥ 0.4)", a30);
    CHECK(NEAR(a30, closed, 0.01), "rendimientos decrecientes: A %.3f ≈ forma cerrada %.3f", a30, closed);
    CHECK(A.person[s].floor == 0, "sin piso antes de pasar 0.5");
    float a_prev = a30, step_low = 0, step_high = 0;
    alma_attach(&A, s, 1.0f); step_low = A.person[s].attachment - a_prev;
    for (int i = 0; i < 2000; i++) alma_attach(&A, s, 1.0f);
    a_prev = A.person[s].attachment;
    alma_attach(&A, s, 1.0f); step_high = A.person[s].attachment - a_prev;
    CHECK(step_high < step_low * 0.05f, "cada unidad aporta mucho menos con A alto (%.5f frente a %.5f)", step_high, step_low);
    CHECK(A.person[s].attachment < 0.95f, "2000 unidades no saturan el apego (%.3f)", A.person[s].attachment);
    CHECK(A.person[s].floor == ATTACH_FLOOR, "piso 0.3 al pasar 0.5");
    alma_attach_drop(&A, s, -1.0f);
    CHECK(NEAR(A.person[s].attachment, 0.3, 1e-6), "las bajadas no pasan del piso (%.3f)", A.person[s].attachment);

    A.person[s].attachment = 0.8f;
    A.person[s].seen_today = 0;
    for (int d = 0; d < 30; d++) { A.person[s].seen_today = 0; alma_night_cycle(&A, t); }
    CHECK(NEAR(A.person[s].attachment, 0.3 + 0.5 * pow(0.99, 30), 1e-3), "30 días sin verla: A %.3f", A.person[s].attachment);

    /* saludo: sat(20 min) = 0.2; sat(1 h) = 0.3 + 0.7·(1800/5400); sat(3 h) = 1 */
    A.person[s].attachment = 0.5f;
    float k = (0.4f + 0.6f * 0.5f) * (0.5f + 0.5f * A.trait[TRAIT_SOCIABILITY]);
    A.person[s].absence_s = 1200; CHECK(NEAR(alma_greet_intensity(&A, s, 0), 0.2 * k, 1e-4), "greet a 20 min");
    A.person[s].absence_s = 3600; CHECK(NEAR(alma_greet_intensity(&A, s, 0), (0.3 + 0.7 * 1800.0 / 5400.0) * k, 1e-4), "greet a 1 h");
    A.person[s].absence_s = 10800; CHECK(NEAR(alma_greet_intensity(&A, s, 0), k, 1e-4), "greet a 3 h");
}

static void test_obedience(void)
{
    fresh(0);
    alma_ev f = {EV_FACE_SEEN, 1, -1, -1, 160, 120, 80, 0};
    alma_event(&A, &f, 0);
    int s = alma_slot_of(&A, 1);
    A.person[s].attachment = 1; A.mood = 1; A.trained[ACT_DANCE] = 1;
    CHECK(NEAR(alma_p_obey(&A, s, ACT_DANCE, 0), 0.98, 1e-6), "p_obey se recorta a 0.98");
    A.emo_fear = 1; A.emo_frustration = 1; A.person[s].attachment = 0; A.mood = -1; A.trained[ACT_DANCE] = 0;
    CHECK(NEAR(alma_p_obey(&A, s, ACT_DANCE, 0), 0.05, 1e-6), "p_obey se recorta a 0.05");
    A.emo_fear = 0; A.emo_frustration = 0; A.mood = 0; A.person[s].attachment = 0.5f;
    A.t_now = 0; A.awake_since_s = 0; A.soc_pct = 100;
    float p = alma_p_obey(&A, s, ACT_DANCE, 0);
    A.person[s].wary_until_s = 1e9;
    CHECK(NEAR(p, 0.35 + 0.40 * 0.5, 1e-5) && NEAR(alma_p_obey(&A, s, ACT_DANCE, 0), 0.35 + 0.40 * 0.25, 1e-5),
          "wary usa A × 0.5 (%.3f → %.3f)", p, alma_p_obey(&A, s, ACT_DANCE, 0));
}

static void test_habituation_and_score(void)
{
    double t = 0;
    fresh(t);
    A.interest[B_TOY] = 1;
    alma_start(&A, B_TOY, RUN_SELECTOR, t, 1, 0);
    CHECK(NEAR(A.interest[B_TOY], 0.6, 1e-6), "al ejecutar: interest × 0.6");
    alma_finish(&A, t + 1, 0);
    alma_interest_tick(&A, 14400);
    CHECK(NEAR(A.interest[B_TOY], 0.8, 1e-4), "media vida de 4 h: %.3f", A.interest[B_TOY]);

    /* score = base · (1 + Σ need_w·need) · mood_fit · (1 + Σ trait_w·(trait − 0.5)) · interest */
    alma_behavior *b = &cat.b[B_TOY];
    b->need_w[NEED_SOCIAL] = 1.5f;
    b->trait_w[TRAIT_PLAYFULNESS] = 1.0f;
    b->mood_fit[SM_CALM] = 1.3f;
    fresh(10000);
    A.need_social = 0.4f;
    A.trait[TRAIT_PLAYFULNESS] = A.trait_base[TRAIT_PLAYFULNESS] = 0.7f;
    A.simple_mood = SM_CALM;
    A.soc_pct = 100;
    A.last_fall_or_shake_s = -1e12;
    float exp = 1.0f * (1 + 1.5f * 0.4f + 0 * 0) * 1.3f * (1 + 1.0f * 0.2f) * 1.0f;
    /* need_stimulation = 1 − stim = 0.5 y need_rest = 0 tienen peso 0 aquí */
    CHECK(NEAR(alma_score(&A, B_TOY, 0), exp, 1e-4), "score %.4f (esperado %.4f)", alma_score(&A, B_TOY, 0), exp);
    b->need_w[NEED_SOCIAL] = 0; b->trait_w[TRAIT_PLAYFULNESS] = 0; b->mood_fit[SM_CALM] = 1;
}

static void test_dagger_and_budget(void)
{
    double t = 0;
    fresh(t);
    int got_reason = -1;
    /* dueño, 2026-10-30: GAIT_MODE_AVAILABLE = 1. Fuera de la base y sin borde reciente, la marcha se sortea */
    alma_start(&A, B_GAIT, RUN_SELECTOR, t, 1, 0);
    CHECK(A.cur.option >= 0 && A.cur.motion_played, "marcha disponible: lejos de bordes camina");
    alma_finish(&A, t + 5, 0);
    fresh(t);
    A.last_cliff_s = t - 10;   /* "explorar con cuidado": con un borde reciente no camina */
    alma_start(&A, B_GAIT, RUN_SELECTOR, t, 1, 0);
    got_reason = A.cur.option;
    CHECK(got_reason == -1 && !A.cur.motion_played, "regla †: borde reciente y solo opciones con marcha → sin movimiento");
    CHECK(A.cur.planned_s >= 4 / SPEED_MAX - 1e-3 && A.cur.planned_s <= 6 / SPEED_MIN + 1e-3, "regla †: dura lo que habría durado (%.2f s)", A.cur.planned_s);
    alma_finish(&A, t + 5, 0);
    CHECK(A.servo_active_s_today == 0, "sin movimiento no consume presupuesto");

    A.trait[TRAIT_ENERGY] = A.trait_base[TRAIT_ENERGY] = 0;   /* budget 3600 s */
    A.servo_active_s_today = 3600 - 10 * 1.3f + 0.5f;   /* no alcanza para 10 s × 1.3 */
    alma_start(&A, B_TOY, RUN_SELECTOR, t, 1, 0);
    CHECK(A.cur.option == -1, "presupuesto: sin movimiento si servo + cost × 1.3 > budget");
    alma_finish(&A, t + 10, 0);
    A.servo_active_s_today = 3600 - 10 * 1.3f - 0.5f;
    alma_start(&A, B_TOY, RUN_SELECTOR, t, 1, 0);
    CHECK(A.cur.option == 0, "presupuesto: con movimiento si alcanza");
    alma_finish(&A, t + A.cur.planned_s, 0);
    CHECK(A.servo_active_s_today <= alma_budget_s(&A), "servo_active_s_today ≤ budget_s (%.1f)", A.servo_active_s_today);
}

static void test_still_on_charger(void)
{
    double t = 0;
    fresh(t);
    alma_ev e = ev(EV_CHARGING_ON);
    alma_event(&A, &e, t);
    alma_start(&A, B_TOY, RUN_SELECTOR, t, 1, 0);
    CHECK(A.cur.option == -1 && !A.cur.motion_played, "cargando: solo cara, sin servos");
    alma_finish(&A, t + 10, 0);
    CHECK(A.servo_active_s_today == 0, "cargando: no consume presupuesto");

    e = ev(EV_CHARGING_OFF);
    alma_event(&A, &e, t);
    alma_start(&A, B_TOY, RUN_SELECTOR, t, 1, 0);
    CHECK(A.cur.motion_played, "fuera de la base: con movimiento");
    e = ev(EV_CHARGING_ON);
    alma_event(&A, &e, t + 4);
    CHECK(!A.cur.motion_played && A.cur.active, "al ponerlo en la base: paran los servos y la conducta sigue");
    alma_finish(&A, t + 8, 0);
    CHECK(NEAR(A.servo_active_s_today, 4, 1e-3), "solo cuentan los 4 s con movimiento (%.2f)", A.servo_active_s_today);
}

static void test_req_parse(void)
{
    alma_req r;
    CHECK(alma_req_parse("battery>=30", &r) == 0 && r.n_alt == 1 && r.kind[0] == REQ_BATTERY_GE && r.arg[0] == 30, "battery>=30");
    CHECK(alma_req_parse("greet_intensity>=0.15", &r) == 0 && NEAR(r.arg[0], 0.15, 1e-6), "greet_intensity>=0.15");
    CHECK(alma_req_parse("unknown_face_present|wary_of_P", &r) == 0 && r.n_alt == 2 && r.kind[1] == REQ_WARY_OF_P, "alternativas con |");
    CHECK(alma_req_parse("no_existe", &r) != 0, "precondición desconocida se rechaza");
    CHECK(alma_req_parse("no_face_extra", &r) != 0, "nombre con sufijo no coincide");
}

static void test_night_cycle(void)
{
    fresh(0);
    A.age_days = 10;
    for (int k = 0; k < TRAIT_COUNT; k++) A.trait[k] = A.trait_base[k] = 0.5f;
    A.counts.pets = 30;                  /* d_soc = clip(30/20) = 1 */
    A.counts.scares = 2;                 /* d_bold = clip(−6/10) = −0.6 */
    A.counts.play_done = 1; A.counts.play_ignored = 4;   /* d_play = clip((1 − 2)/5) = −0.2; d_soc = (30 + 1)/20 → 1 */
    A.mood = 0.6f;
    A.interest[B_TOY] = 0.2f;
    A.servo_active_s_today = 100;
    alma_night_cycle(&A, 0);
    CHECK(NEAR(A.trait[TRAIT_SOCIABILITY], 0.52, 1e-5), "joven: sociability + 0.02 (%.4f)", A.trait[TRAIT_SOCIABILITY]);
    CHECK(NEAR(A.trait[TRAIT_BOLDNESS], 0.5 - 0.012, 1e-5), "joven: boldness − 0.012 (%.4f)", A.trait[TRAIT_BOLDNESS]);
    CHECK(NEAR(A.trait[TRAIT_PLAYFULNESS], 0.5 - 0.004, 1e-5), "joven: playfulness − 0.004 (%.4f)", A.trait[TRAIT_PLAYFULNESS]);
    {   /* el maltrato resta juego: d_play = clip((play_done − ignored/2 − 3·scolds − 5·shakes) / 5) */
        alma_t save = A;
        A.counts.play_done = 14; A.counts.play_ignored = 4; A.counts.scolds = 1; A.counts.shakes = 1;   /* (14 − 2 − 3 − 5)/5 = 0.8 */
        float l0 = A.trait_learned[TRAIT_PLAYFULNESS];
        alma_night_cycle(&A, 0);
        CHECK(NEAR(A.trait_learned[TRAIT_PLAYFULNESS] - l0, 0.02 * 0.8, 1e-5), "d_play con 1 regaño y 1 sacudida = 0.8");
        A.counts.play_done = 14; A.counts.play_ignored = 4; A.counts.scolds = 13; A.counts.shakes = 7;   /* perfil brusco */
        l0 = A.trait_learned[TRAIT_PLAYFULNESS];
        alma_night_cycle(&A, 0);
        CHECK(NEAR(A.trait_learned[TRAIT_PLAYFULNESS] - l0, -0.02, 1e-5), "noche de maltrato: playfulness baja el máximo");
        A = save;
    }
    CHECK(NEAR(A.mood, 0.3, 1e-6), "mood × 0.5");
    CHECK(NEAR(A.interest[B_TOY], 0.6, 1e-6), "interest + 0.5·(1 − i)");
    CHECK(A.age_days == 11 && A.servo_active_s_today == 0 && A.counts.pets == 0, "edad, presupuesto y contadores");

    A.age_days = 60;
    A.counts.pets = 30;
    float s0 = A.trait[TRAIT_SOCIABILITY];
    A.trait_base[TRAIT_ENERGY] = 0.6f; A.trait[TRAIT_ENERGY] = 0.6f; A.trait_learned[TRAIT_ENERGY] = 0;
    alma_night_cycle(&A, 0);
    CHECK(NEAR(A.trait[TRAIT_SOCIABILITY] - s0, 0.002, 1e-5), "adulto: plasticidad 0.1 (Δ %.4f)", A.trait[TRAIT_SOCIABILITY] - s0);
    CHECK(NEAR(A.trait[TRAIT_ENERGY], 0.5995, 1e-5), "energy −0.0005 por día desde el día 60");
    CHECK(NEAR(A.trait_learned[TRAIT_ENERGY], -0.0005, 1e-6), "la caída de energy cuenta en trait_learned");
    A.trait_learned[TRAIT_ENERGY] = -0.1f; A.trait[TRAIT_ENERGY] = 0.5f;
    alma_night_cycle(&A, 0);
    CHECK(NEAR(A.trait[TRAIT_ENERGY], 0.5, 1e-6), "energy no baja de nacimiento − 0.1");

    /* ventana nocturna fija de 20:00 a 8:00 (dueño, 2026-11-01): la presencia ya no la mueve */
    for (int h = 0; h < 24; h++) A.home_presence_hist[h] = (h >= 2 && h < 9) ? 0 : 1;
    for (int h = 0; h < 24; h++) A.hour_seen[h] = (h >= 2 && h < 9) ? 0 : 1;
    alma_night_cycle(&A, 0);
    CHECK(A.night_start_h == 20, "la ventana sigue desde las 20:00 (%d)", A.night_start_h);
    CHECK(alma_in_night_window(&A, 20 * 3600.0) && alma_in_night_window(&A, 7 * 3600.0 + 3599)
          && !alma_in_night_window(&A, 8 * 3600.0) && !alma_in_night_window(&A, 19 * 3600.0 + 3599),
          "noche de 20:00 a 8:00");
}

/* dueño, 2026-11-01: a las 20:00 se va a dormir; en la base (o con USB) duerme ahí; fuera de la base descansa hasta que
   el firmware la lleve o le diga que duerma donde está; a las 8:00 despierta */
static void test_bedtime(void)
{
    double t = 20 * 3600.0 - 10;
    fresh(t);
    for (int h = 0; h < 24; h++) A.home_presence_hist[h] = 1;   /* casa con gente: de día no descansaría */
    A.state = ST_AWAKE;
    A.last_stimulus_s = -1e9;
    ticks_off(&t, 5);
    CHECK(A.state != ST_RESTING && A.state != ST_SLEEPING, "19:59: todavía despierta (estado %d)", A.state);
    if (A.cur.active) alma_finish(&A, t, 0);   /* la conducta de las 19:59 termina (aquí no hay ejecutor) */
    A.state = ST_AWAKE;
    ticks_off(&t, 20);
    CHECK(A.state == ST_RESTING, "20:00 fuera de la base: a descansar (estado %d)", A.state);
    ticks_off(&t, 60);
    CHECK(A.state == ST_RESTING, "de noche no se levanta sola (estado %d)", A.state);
    alma_sleep_here(&A);
    ticks_off(&t, 2);
    CHECK(A.state == ST_SLEEPING, "no llegó a la base: duerme donde está (estado %d)", A.state);
    ticks_off(&t, 60);
    CHECK(A.state == ST_SLEEPING, "sigue dormida fuera de la base");
    alma_ev bang = ev(EV_LOUD_SOUND);
    alma_event(&A, &bang, t);
    CHECK(A.state != ST_SLEEPING && !A.sleep_here, "un ruido la despierta");
    A.last_stimulus_s = t - STIMULUS_STICKY_S - 1;
    if (A.cur.active) alma_finish(&A, t, 1);
    A.state = ST_AWAKE;
    ticks(&t, 3);
    CHECK(A.state == ST_SLEEPING, "con la base, a dormir otra vez (estado %d)", A.state);
    t = 32 * 3600.0;
    ticks(&t, 2);
    CHECK(A.state != ST_SLEEPING && A.state != ST_RESTING, "8:00: despierta (estado %d)", A.state);
}

/* lo que vio de cerca (dueño, 2026-11-01): la conducta de Haiku si se puede; si no, la de la reacción */
static void test_vision_event(void)
{
    double t = 50000;
    fresh(t);
    A.state = ST_AWAKE;
    int bow = B_TOY, struggle = B_REFLEX;   /* catálogo de prueba: una de juego y un reflejo */
    alma_vision_event(&A, VIS_CONTENTA, bow, t);
    CHECK(A.cur.active && A.cur.behavior == bow && A.counts.novel_ok == 1, "contenta + una conducta de juego: la hace");
    alma_finish(&A, t, 0);
    A.state = ST_AWAKE;
    t += 600;
    alma_vision_event(&A, VIS_ASUSTADA, struggle, t);
    CHECK(A.cur.active && A.cur.behavior == A.ix_startle && A.counts.novel_ok == 1,
          "un reflejo no se puede pedir: hace la de la reacción (sobresalto), y asustada no cuenta como novedad");
}

static void test_reflex_and_forced(void)
{
    double t = 50000;
    fresh(t);
    A.state = ST_AWAKE;
    alma_start(&A, B_TOY, RUN_SELECTOR, t, 1, 0);
    alma_ev up = ev(EV_PICKED_UP);
    alma_event(&A, &up, t);
    CHECK(A.state == ST_REFLEX && A.cur.option == -1, "EV_PICKED_UP → ST_REFLEX sin movimiento");
    ticks_off(&t, 3);
    CHECK(A.state == ST_REFLEX, "sigue en el reflejo mientras está levantado");
    alma_ev down = ev(EV_PUT_DOWN);
    alma_event(&A, &down, t);
    ticks_off(&t, 2);
    CHECK(A.cur.active && A.cur.option >= 0 && strncmp(cat.b[B_REFLEX].opt[A.cur.option].mot[0], "react_put_down_", 15) == 0,
          "EV_PUT_DOWN y 1 s estable → react_put_down");

    fresh(t);
    A.state = ST_AWAKE;
    alma_ev loud = ev(EV_LOUD_SOUND);
    alma_event(&A, &loud, t);
    CHECK(A.cur.active && A.cur.behavior == B_STARTLE && A.cur.kind == RUN_FORCED, "EV_LOUD_SOUND fuerza bhv_startle");

    fresh(t);
    A.state = ST_PERFORMING;
    alma_start(&A, B_TOY, RUN_SELECTOR, t, 0.2f, 0);
    alma_ev pet = ev(EV_TOUCH_PET);
    alma_event(&A, &pet, t + 1);
    CHECK(A.window_until[B_ENJOY] > t + 1, "EV_TOUCH_PET abre la ventana de bhv_enjoy_pet");
    CHECK(alma_in_free_pool(&A, B_ENJOY, t + 2) && !alma_in_free_pool(&A, B_ENJOY, t + 7), "ventana de 5 s");
}

/* 04 "Plasticidad": rasgo = clamp(trait_base + trait_learned, 0, 1), |trait_learned| ≤ 0.25 */
static int traits_consistent(const alma_t *a, const float base0[TRAIT_COUNT])
{
    for (int k = 0; k < TRAIT_COUNT; k++) {
        if (a->trait_base[k] != base0[k]) return 0;
        if (fabsf(a->trait_learned[k]) > TRAIT_LEARNED_MAX + 1e-6f) return 0;
        float eff = a->trait_base[k] + a->trait_learned[k];
        eff = eff < 0 ? 0 : (eff > 1 ? 1 : eff);
        if (fabsf(a->trait[k] - eff) > 1e-6f) return 0;
    }
    return 1;
}

static void test_trait_learned_cap(void)
{
    static const alma_ev_type EVS[] = {EV_TOUCH_PET, EV_PRAISE, EV_SCOLD, EV_SHAKEN, EV_LOUD_SOUND, EV_FACE_UNKNOWN,
                                       EV_CLIFF, EV_TIPPED_OVER, EV_PICKED_UP, EV_PUT_DOWN, EV_OBSTACLE, EV_TOUCH_TAP};
    alma_rng r;
    alma_rng_seed(&r, 99);
    for (int run = 0; run < 4; run++) {
        double t = 1000;
        fresh(t);
        float base0[TRAIT_COUNT];
        memcpy(base0, A.trait_base, sizeof base0);
        int ok = 1, hit_cap = 0;
        for (int night = 0; night < 400 && ok; night++) {
            /* eventos reales al azar */
            for (int i = 0; i < 30; i++) {
                alma_ev e = ev(EVS[(int)(alma_rng_u01(&r) * 12)]);
                t += 0.2 + 20 * alma_rng_u01(&r);
                alma_event(&A, &e, t);
            }
            /* y contadores extremos en las dos direcciones */
            int up = run % 2 == 0 ? alma_rng_u01(&r) < 0.8f : alma_rng_u01(&r) < 0.2f;
            A.counts.pets += up ? (int)(200 * alma_rng_u01(&r)) : 0;
            A.counts.play_done += up ? (int)(20 * alma_rng_u01(&r)) : 0;
            A.counts.shakes += up ? 0 : (int)(20 * alma_rng_u01(&r));
            A.counts.scares += up ? 0 : (int)(30 * alma_rng_u01(&r));
            A.counts.novel_ok += up ? (int)(30 * alma_rng_u01(&r)) : 0;
            A.counts.play_ignored += up ? 0 : (int)(30 * alma_rng_u01(&r));
            if (alma_rng_u01(&r) < 0.3f) A.age_days = (int)(120 * alma_rng_u01(&r));
            alma_night_cycle(&A, t);
            float nudges[TRAIT_COUNT];
            for (int k = 0; k < TRAIT_COUNT; k++) nudges[k] = (alma_rng_u01(&r) - 0.5f) * 0.2f;   /* ±0.1, fuera de rango a propósito */
            alma_trait_nudges(&A, nudges);
            ok = traits_consistent(&A, base0);
            for (int k = 0; k < TRAIT_COUNT; k++) hit_cap |= fabsf(A.trait_learned[k]) >= TRAIT_LEARNED_MAX - 1e-6f;
        }
        CHECK(ok, "corrida %d: tope ±0.25, trait_base fijo y trait = clamp(base + learned) en 400 noches", run);
        CHECK(hit_cap, "corrida %d: la secuencia sí llega al tope (la prueba no es trivial)", run);
    }

    /* maltrato sostenido: sociability baja exactamente 0.25 y no más */
    fresh(0);
    float b = A.trait_base[TRAIT_SOCIABILITY];
    for (int d = 0; d < 90; d++) { A.counts.shakes = 10; alma_night_cycle(&A, 0); }
    CHECK(NEAR(A.trait_learned[TRAIT_SOCIABILITY], -0.25, 1e-6), "90 noches de sacudidas: learned = −0.25 (%.3f)", A.trait_learned[TRAIT_SOCIABILITY]);
    CHECK(NEAR(A.trait[TRAIT_SOCIABILITY], b - 0.25 < 0 ? 0 : b - 0.25, 1e-6), "sociability = base − 0.25, recortado a [0, 1]");

    /* nudges de 07: [−0.01, 0.01] × plasticity y la suma con lo local ≤ max_delta_por_noche */
    fresh(0);
    A.age_days = 10;
    A.counts.pets = 100;                       /* d_soc = 1 → +0.02, ya en max_delta */
    alma_night_cycle(&A, 0);
    float l0 = A.trait_learned[TRAIT_SOCIABILITY], p0 = A.trait_learned[TRAIT_PLAYFULNESS];
    float nud[TRAIT_COUNT] = {0, 0, 0.5f, 0.5f, 0};
    alma_trait_nudges(&A, nud);
    CHECK(NEAR(A.trait_learned[TRAIT_SOCIABILITY], l0, 1e-6), "nudge no pasa max_delta_por_noche (local ya en +0.02)");
    CHECK(NEAR(A.trait_learned[TRAIT_PLAYFULNESS] - p0, 0.01, 1e-6), "nudge se recorta a +0.01 (%.4f)", A.trait_learned[TRAIT_PLAYFULNESS] - p0);
    A.age_days = 80;
    alma_night_cycle(&A, 0);
    p0 = A.trait_learned[TRAIT_PLAYFULNESS];
    float nud2[TRAIT_COUNT] = {0, 0, 0, 0.01f, 0.01f};
    float i0 = A.trait_learned[TRAIT_IMPULSIVITY];
    alma_trait_nudges(&A, nud2);
    CHECK(NEAR(A.trait_learned[TRAIT_PLAYFULNESS] - p0, 0.001, 1e-6), "adulto: nudge × plasticity 0.1");
    CHECK(NEAR(A.trait_learned[TRAIT_IMPULSIVITY] - i0, 0.0001, 1e-6), "impulsivity: × plasticity × 0.1");

    /* export/import (06, bloque identity): base y learned por separado */
    fresh(0);
    for (int d = 0; d < 40; d++) { A.counts.pets = 50; A.counts.scares = 5; alma_night_cycle(&A, 0); }
    float eb[TRAIT_COUNT], el[TRAIT_COUNT], et[TRAIT_COUNT];
    alma_traits_export(&A, eb, el);
    memcpy(et, A.trait, sizeof et);
    static alma_t B2;
    alma_init(&B2, &cat, 4321, 0, (alma_hooks){0});
    int differ = memcmp(B2.trait_base, eb, sizeof eb) != 0;
    alma_traits_import(&B2, eb, el);
    CHECK(differ && memcmp(B2.trait_base, eb, sizeof eb) == 0 && memcmp(B2.trait_learned, el, sizeof el) == 0,
          "import restaura trait_base y trait_learned por separado");
    CHECK(memcmp(B2.trait, et, sizeof et) == 0, "import reproduce el valor efectivo");
    float fb[TRAIT_COUNT], fl[TRAIT_COUNT];
    alma_traits_export(&B2, fb, fl);
    CHECK(memcmp(fb, eb, sizeof eb) == 0 && memcmp(fl, el, sizeof el) == 0, "export → import → export idéntico");
    float big[TRAIT_COUNT] = {0.9f, -0.9f, 0.3f, -0.3f, 0};
    alma_traits_import(&B2, eb, big);
    CHECK(traits_consistent(&B2, eb), "import también respeta el tope");
}

/* 04 "Escucha": durante bhv_listen solo un reflejo la interrumpe */
static void start_listening(double t)
{
    fresh(t);
    A.state = ST_AWAKE;
    alma_ev w = ev(EV_WAKE_WORD);
    alma_event(&A, &w, t);
}

static void test_listen_only_reflex(void)
{
    double t = 70000;
    start_listening(t);
    CHECK(A.state == ST_LISTENING && A.cur.active && A.cur.behavior == B_LISTEN, "EV_WAKE_WORD → ST_LISTENING con bhv_listen");

    alma_ev loud = ev(EV_LOUD_SOUND);
    alma_event(&A, &loud, t + 1);
    CHECK(A.state == ST_LISTENING && A.cur.behavior == B_LISTEN, "EV_LOUD_SOUND no interrumpe la escucha");
    CHECK(A.last_exec_t[B_STARTLE] < 0, "EV_LOUD_SOUND durante la escucha no dispara bhv_startle");
    CHECK(A.counts.scares == 1 && A.emo_fear > 0, "EV_LOUD_SOUND se registra (scares %d, miedo %.2f)", A.counts.scares, A.emo_fear);

    alma_force(&A, B_CONFUSED, t + 2);
    CHECK(A.state == ST_LISTENING && A.cur.behavior == B_LISTEN, "una conducta forzada no interrumpe la escucha");
    alma_ev w = ev(EV_WAKE_WORD);
    alma_event(&A, &w, t + 3);
    CHECK(A.cur.behavior == B_LISTEN && NEAR(A.cur.t_start, t, 1e-6), "otra EV_WAKE_WORD no reinicia la escucha");
    alma_ev pet = ev(EV_TOUCH_PET);
    alma_event(&A, &pet, t + 4);
    CHECK(A.state == ST_LISTENING && A.cur.behavior == B_LISTEN, "EV_TOUCH_PET (ventana) no interrumpe la escucha");

    static const alma_ev_type REFLEXES[] = {EV_CLIFF, EV_PICKED_UP, EV_SHAKEN, EV_TIPPED_OVER};
    for (int i = 0; i < 4; i++) {
        start_listening(t);
        alma_ev r = ev(REFLEXES[i]);
        alma_event(&A, &r, t + 1);
        CHECK(A.state == ST_REFLEX && A.cur.behavior != B_LISTEN, "el reflejo %d saca a Alma de la escucha", (int)REFLEXES[i]);
    }

    /* la escucha termina con EV_VOICE_FAILED o por tiempo */
    start_listening(t);
    alma_ev f = ev(EV_VOICE_FAILED);
    alma_event(&A, &f, t + 2);
    CHECK(A.state != ST_LISTENING && A.cur.behavior == B_CONFUSED, "EV_VOICE_FAILED cierra la escucha y luego bhv_confused");
    start_listening(t);
    double tt = t;
    alma_sensors s = {100, 1};
    for (int i = 0; i < (int)LISTEN_TIMEOUT_S + 2; i++) { tt += 1; alma_tick(&A, tt, &s); }
    CHECK(A.state != ST_LISTENING, "la escucha termina por tiempo");
    CHECK(LISTEN_TIMEOUT_S >= 3.0f + 6.0f, "timeout ≥ grabación máx. (3 s) + espera de la nube (6 s)");
    start_listening(t);
    tt = t;
    for (int i = 0; i < 8; i++) { tt += 1; alma_tick(&A, tt, &s); }
    CHECK(A.state == ST_LISTENING, "a los 8 s sigue escuchando (espera de la nube)");
    alma_ev cmd = {EV_VOICE_COMMAND, -1, ACT_STOP, -1, 0, 0, 0, 0};
    alma_event(&A, &cmd, tt + 0.5);
    CHECK(A.state != ST_LISTENING, "una orden a los 8.5 s se recibe y cierra la escucha");
}

static void test_real_catalog(const char *catp, const char *invp)
{
    static alma_catalog real;
    int n = catalog_load(catp, invp, &real, 0);
    CHECK(n == 47, "catálogo real: 47 conductas válidas, con bhv_trick y bhv_nap (%d)", n);
    int g = alma_find(&real, "bhv_greet");
    CHECK(g >= 0 && NEAR(real.b[g].servo_cost_s, 8.0, 1e-3), "servo_cost_s de bhv_greet = 8 s (Good_morning)");
    int e = alma_find(&real, "bhv_enjoy_pet");
    CHECK(e >= 0 && real.b[e].opt[0].n == 3, "cadena touch_get_in → touch_loop → touch_get_out1");
    int f = alma_find(&real, "bhv_follow_face"), gait = 1;
    for (int i = 0; f >= 0 && i < real.b[f].n_opt; i++) gait &= real.b[f].opt[i].gait;
    CHECK(f >= 0 && gait, "bhv_follow_face: todas sus opciones tienen †");

    /* recordatorio del calendario (07; dueño, 2026-10-30): forzado aunque duerma; un reflejo lo pospone */
    static alma_t R;
    alma_init(&R, &real, 5, 3 * 3600.0, (alma_hooks){0});
    R.state = ST_SLEEPING;
    alma_ev rem = {EV_REMINDER, -1, -1, -1, 0, 0, 0, 0};
    alma_event(&R, &rem, 3 * 3600.0 + 1);
    int ir = alma_find(&real, "bhv_reminder");
    CHECK(ir >= 0 && R.cur.active && R.cur.behavior == ir && R.cur.kind == RUN_FORCED, "EV_REMINDER dormida: bhv_reminder forzada");
    alma_init(&R, &real, 5, 3 * 3600.0, (alma_hooks){0});
    R.state = ST_REFLEX;
    alma_event(&R, &rem, 3 * 3600.0 + 1);
    CHECK(!(R.cur.active && R.cur.behavior == ir), "durante un reflejo no interrumpe");
    R.state = ST_AWAKE;
    alma_state_tick(&R, 3 * 3600.0 + 2);
    CHECK(R.cur.active && R.cur.behavior == ir, "al terminar el reflejo, la alarma pospuesta suena");

    /* tamagotchi (dueño, 2026-10-30): comida real, ella decide */
    double t = 10 * 3600.0;
    alma_init(&R, &real, 5, t, (alma_hooks){0});
    int ie = alma_find(&real, "bhv_eat"), idr = alma_find(&real, "bhv_drink"), ia = alma_find(&real, "bhv_ask_food");
    CHECK(ie >= 0 && idr >= 0 && ia >= 0 && alma_find(&real, "bhv_sick") >= 0, "catálogo: bhv_eat, bhv_drink, bhv_ask_food, bhv_sick");
    CHECK(!alma_in_free_pool(&R, ie, t) && !alma_in_free_pool(&R, idr, t) && !alma_in_free_pool(&R, alma_find(&real, "bhv_reminder"), t),
          "comer, tomar y la alarma nunca se eligen solas (solo forzadas)");
    CHECK(alma_food_of("pizza") == FOOD_PIZZA && alma_food_of("tornillo") < 0 && strcmp(alma_food_id(FOOD_TE), "te") == 0, "ids de comida");
    int acc = 0, nt = 200;
    for (int i = 0; i < nt; i++) {
        R.state = ST_AWAKE; R.cur.active = 0; R.hunger = 0.9f; R.food_like[FOOD_PIZZA] = 0.9f; R.last_food = -1;
        acc += alma_feed(&R, FOOD_PIZZA, t + i).accepted;
    }
    CHECK(acc > 0.85 * nt, "con hambre y su comida favorita casi siempre acepta (%d de %d)", acc, nt);
    R.state = ST_AWAKE; R.cur.active = 0; R.hunger = 0.9f; R.last_food = -1;
    alma_feed_result fr = alma_feed(&R, FOOD_PIZZA, t);
    CHECK(fr.accepted && R.hunger < 0.3f && R.cur.behavior == ie && fr.why == FEED_LOVED, "acepta: baja el hambre y come (bhv_eat), le encanta");
    acc = 0;
    for (int i = 0; i < nt; i++) {
        R.state = ST_AWAKE; R.cur.active = 0; R.hunger = 0.05f; R.food_like[FOOD_BROCOLI] = -0.8f; R.last_food = -1;
        acc += alma_feed(&R, FOOD_BROCOLI, t + i).accepted;
    }
    CHECK(acc < 0.1 * nt, "llena y algo que no le gusta: casi nunca (%d de %d)", acc, nt);
    R.state = ST_AWAKE; R.cur.active = 0; R.hunger = 0.05f; R.food_like[FOOD_BROCOLI] = -0.8f;
    fr = alma_feed(&R, FOOD_BROCOLI, t);
    CHECK(!fr.accepted && (fr.why == FEED_FULL || fr.why == FEED_DISLIKE) && R.cur.behavior == alma_find(&real, "bhv_refuse"),
          "rechaza (%s) con bhv_refuse", alma_feed_why_id(fr.why));
    R.state = ST_AWAKE; R.cur.active = 0; R.sick = 0;
    fr = alma_feed(&R, FOOD_MEDICINA, t);
    CHECK(!fr.accepted && fr.why == FEED_NOT_SICK, "medicina sin estar enferma: no");
    R.counts.treats = 0;
    int sick = 0;
    for (int i = 0; i < 40 && !sick; i++) {
        R.state = ST_AWAKE; R.cur.active = 0; R.hunger = 0.5f; R.food_like[FOOD_HELADO] = 0.9f;
        sick = alma_feed(&R, FOOD_HELADO, t + i).got_sick;
    }
    CHECK(sick && R.sick && R.counts.treats > TREATS_BEFORE_SICK, "muchas golosinas: empacho (%d golosinas)", R.counts.treats);
    R.state = ST_AWAKE; R.cur.active = 0;
    fr = alma_feed(&R, FOOD_MEDICINA, t);
    CHECK(fr.accepted && !R.sick && R.cur.behavior == idr, "la medicina la cura (de mala gana, con bhv_drink)");
    R.state = ST_AWAKE; R.cur.active = 0; R.hunger = 0.9f;
    fr = alma_feed(&R, FOOD_TE, t);
    CHECK(!fr.accepted || R.cur.behavior == idr, "bebidas: bhv_drink");
    R.state = ST_REFLEX;
    CHECK(alma_feed(&R, FOOD_PIZZA, t).why == FEED_BUSY, "en un reflejo no come");

    /* el hambre sube solo con care_enabled (el robot con enlace); 5 h ≈ 1 comida */
    alma_init(&R, &real, 5, t, (alma_hooks){0});
    alma_sensors ss = {90, 0};
    float h0 = R.hunger;
    for (double u = t; u < t + 3600; u += 1) alma_tick(&R, u, &ss);
    CHECK(R.hunger == h0, "sin enlace (care_enabled = 0) no le da hambre");
    R.care_enabled = 1;
    for (double u = t + 3600; u < t + 3600 * 4; u += 1) alma_tick(&R, u, &ss);
    CHECK(R.hunger > h0 + 0.45f && R.hunger < h0 + 0.8f, "3 h despierta: el hambre sube (%.2f → %.2f)", h0, R.hunger);
    R.hunger = 1.0f;
    float v0 = R.affect_valence;
    for (double u = t + 3600 * 4; u < t + 3600 * 5; u += 1) alma_tick(&R, u, &ss);
    CHECK(R.counts.starve_min >= 59 && R.affect_valence < v0 + 1e-3f, "muerta de hambre una hora: %d min contados", R.counts.starve_min);

    /* plan v2 (dueño, 2026-10-31): el servidor lleva comida, peso y salud; el robot lo vive */
    double u0 = t + 3600 * 6;
    alma_init(&R, &real, 5, u0, (alma_hooks){0});
    R.care_enabled = 1;
    alma_care_apply_state(&R, 0.5f, SICK_NONE, WB_SANO, 1.0f, u0);
    for (double u = u0; u < u0 + 3600; u += 1) alma_tick(&R, u, &ss);
    CHECK(R.care_remote && NEAR(R.hunger, 0.5, 1e-6), "con el servidor al mando el robot no sube el hambre (%.3f)", R.hunger);
    u0 += 3600;
    int dance = alma_find(&real, "bhv_dance"), iex = alma_find(&real, "bhv_explore"), isk = alma_find(&real, "bhv_sick");
    R.soc_pct = 90; R.on_charger = 0; R.emo_fear = 0; R.last_fall_or_shake_s = R.last_cliff_s = -1e9;
    R.last_exec_t[dance] = -1e9; R.state = ST_AWAKE; R.cur.active = 0;
    float s_full = alma_score(&R, dance, 0);
    R.care_energy = 0.5f;
    float s_half = alma_score(&R, dance, 0);
    CHECK(s_full > 0 && NEAR(s_half, 0.5f * s_full, 1e-4), "con media energía baila la mitad (%.3f → %.3f)", s_full, s_half);
    alma_care_apply_state(&R, 0.5f, SICK_EMPACHO, WB_SOBREPESO, 0.35f, u0);
    CHECK(R.sick && R.sick_cause == SICK_EMPACHO && R.weight_band == WB_SOBREPESO && R.cur.active && R.cur.behavior == isk,
          "al enfermarse hace bhv_sick en ese momento");
    CHECK(alma_score(&R, dance, 0) == 0, "enferma no baila ni juega");
    int zombie = 0, other = 0;
    for (int pass = 0; pass < 2; pass++) {
        for (int i = 0; i < 40; i++) {
            R.cur.active = 0; R.servo_active_s_today = 0;
            alma_start(&R, iex, RUN_SELECTOR, u0 + 10 * i, 0, 0);
            if (R.cur.option < 0) continue;
            if (strncmp(real.b[iex].opt[R.cur.option].mot[0], "zombie", 6) == 0) zombie++; else other++;
        }
        if (pass == 0) {
            CHECK(zombie > 0 && other == 0, "enferma explora caminando como zombie (%d zombie, %d otras)", zombie, other);
            alma_care_apply_state(&R, 0.5f, SICK_NONE, WB_SANO, 1.0f, u0 + 500);
            zombie = other = 0;
        } else CHECK(zombie == 0 && other > 0, "sana ya no camina como zombie (%d zombie, %d otras)", zombie, other);
    }
    int ie2 = alma_find(&real, "bhv_eat"), irf = alma_find(&real, "bhv_refuse");
    memset(&R.counts, 0, sizeof R.counts);
    R.cur.active = 0; R.hunger = 0.8f;
    float j0 = R.emo_joy;
    alma_care_apply_feed(&R, FOOD_PIZZA, 1, 0.4f, 0.01f, 0, u0 + 600);
    CHECK(R.cur.behavior == ie2 && R.counts.meals == 1 && R.emo_joy > j0, "el servidor dice que la come: come y se alegra");
    R.cur.active = 0;
    float f0 = R.emo_frustration;
    alma_care_apply_feed(&R, FOOD_BROCOLI, 1, -0.08f, -0.01f, 0, u0 + 700);
    CHECK(R.cur.behavior == ie2 && R.emo_frustration > f0, "verdura que no le gusta: la come, pero se desanima un poco");
    R.cur.active = 0;
    alma_care_apply_feed(&R, FOOD_HELADO, 0, 0, 0, 0.1f, u0 + 800);
    CHECK(R.cur.behavior == irf && R.counts.refused == 1, "si el servidor dice que no: bhv_refuse");
    R.cur = (alma_current){0};
    R.cur.active = 1; R.cur.behavior = dance; R.cur.motion_played = 1;
    alma_exercise_tick(&R, 2);
    R.cur.behavior = iex;
    alma_exercise_tick(&R, 3);
    R.cur.motion_played = 0;
    alma_exercise_tick(&R, 3);
    CHECK(NEAR(R.ex_s[EX_DANCE], 2, 1e-6) && NEAR(R.ex_s[EX_EXPLORE], 3, 1e-6), "ejercicio: solo cuenta lo que se mueve (%.0f, %.0f)",
          R.ex_s[EX_DANCE], R.ex_s[EX_EXPLORE]);
    R.hunger = 1.0f; R.counts.starve_min = 0; R.cur.active = 0;
    for (double u = u0 + 1000; u < u0 + 1000 + 600; u += 1) alma_tick(&R, u, &ss);
    CHECK(R.counts.starve_min >= 9, "con el servidor al mando, el hambre extrema sigue contando en el bienestar (%d min)", R.counts.starve_min);

    /* juegos de la app (PLAN-JUEGOS, 2026-10-31): reacciones con cooldown, y cuenta como jugar con el dueño */
    double g0 = u0 + 5000;
    alma_init(&R, &real, 5, g0, (alma_hooks){0});
    int iw = alma_find(&real, "bhv_happy_wiggle"), isu = alma_find(&real, "bhv_sulk");
    CHECK(alma_game_ev_of("gana_alma") == GEV_GANA && alma_game_ev_of("farol_descubierto") == GEV_FAROL
          && alma_game_ev_of("trampa") < 0, "ids de los eventos de juego");
    R.state = ST_AWAKE; R.cur.active = 0;
    int pd = R.counts.play_done;
    float jw = R.emo_joy;
    alma_game_event(&R, GEV_GANA, g0);
    CHECK(R.counts.play_done == pd + 1 && R.emo_joy > jw && R.cur.active && R.cur.behavior == iw,
          "gana: cuenta como jugar con el dueño, se alegra y se menea");
    R.cur.active = 0;
    alma_game_event(&R, GEV_PIERDE, g0 + 10);
    CHECK(R.cur.active && R.cur.behavior == isu && R.counts.play_done == pd + 2, "pierde: se enfurruña (bhv_sulk)");
    R.cur.active = 0;
    alma_game_event(&R, GEV_PIERDE, g0 + 20);
    CHECK(!R.cur.active, "otra derrota enseguida: respeta el cooldown de bhv_sulk");
    R.state = ST_SLEEPING; R.cur.active = 0;
    alma_game_event(&R, GEV_GANA, g0 + 2000);
    CHECK(!R.cur.active, "dormida no reacciona");
    R.state = ST_AWAKE; R.sick = 1; R.cur.active = 0;
    alma_game_event(&R, GEV_GANA, g0 + 4000);
    CHECK(!(R.cur.active && R.cur.behavior == iw), "enferma no hace la conducta de juego");
    R.sick = 0;

    /* bienestar: comidas, hambre extrema y juegos a distancia (curva aprobada) */
    CHECK(NEAR(alma_remote_play_points(3600), 11.8, 0.2) && NEAR(alma_remote_play_points(7200), 19.0, 0.2)
          && alma_remote_play_points(0) == 0 && alma_remote_play_points(14400) < 30, "curva de juegos: 1 h ≈ 12, 2 h ≈ 19, tope 30");
    memset(&R.counts, 0, sizeof R.counts);
    int p0 = alma_wellbeing_day_points(&R, NULL);
    R.counts.meals = 3;
    int p1 = alma_wellbeing_day_points(&R, NULL);
    R.counts.starve_min = 120;
    int p2 = alma_wellbeing_day_points(&R, NULL);
    R.counts.starve_min = 0; R.counts.meals = 0; R.counts.remote_play_s = 7200;
    int p3 = alma_wellbeing_day_points(&R, NULL);
    CHECK(p1 == p0 + 6 && p2 == p1 - 4 && p3 == p0 + 19, "puntos del día: 3 comidas +6, 2 h de hambre −4, 2 h de juegos +19 (%d %d %d %d)",
          p0, p1, p2, p3);
}

/* Bienestar (04; dueño, 2026-10-30): ±1023, 0 al nacer; puntos del día ±30, Haiku ±10, deriva 1 % a 0 */
static void test_wellbeing(void)
{
    fresh(0);
    CHECK(A.wellbeing == 0, "bienestar: 0 al nacer");
    A.counts.play_done = 20; A.counts.pets = 10; A.hour_seen[18] = A.hour_seen[19] = 1; A.counts.explore_ok = 4;
    alma_night_cycle(&A, 0);
    CHECK(A.wb_day_points == 30 && NEAR(A.wellbeing, 30, 1e-4), "día de mucho juego: +30 (tope; %d)", A.wb_day_points);
    alma_wellbeing_adjust(&A, 25);
    CHECK(NEAR(A.wellbeing, 30, 1e-4) && A.wb_day_adjust == 0, "Haiku no pasa el tope del día (±30)");
    alma_wellbeing_adjust(&A, -25);
    CHECK(NEAR(A.wellbeing, 20, 1e-4) && A.wb_day_adjust == -10, "Haiku: ajuste recortado a −10 (%.1f)", A.wellbeing);
    alma_wellbeing_adjust(&A, -4);
    CHECK(NEAR(A.wellbeing, 26, 1e-4), "otro ajuste la misma noche reemplaza al anterior (%.1f)", A.wellbeing);

    /* ponderación (dueño): hasta 500 cuenta todo; hacia el extremo cada vez menos; hacia 0 cada vez más */
    CHECK(NEAR(alma_wellbeing_step(300, 10), 310, 1e-3), "en 300, +10 cuenta completo");
    CHECK(NEAR(alma_wellbeing_step(700, 10), 700 + 10 * (1 - 0.75f * 200 / 523), 1e-3), "en 700, +10 cuenta el 71 %%");
    CHECK(NEAR(alma_wellbeing_step(1023, 10), 1023, 1e-3), "en el tope no pasa de 1023");
    CHECK(NEAR(alma_wellbeing_step(1023, -5), 1023 - 5 * 4.0f, 1e-3), "en el tope, una falta de −5 quita 20 (×4)");
    CHECK(NEAR(alma_wellbeing_step(-900, 30), -900 + 30 * (1 + 3 * (900 / 1023.0f) * (900 / 1023.0f)), 1e-2),
          "muy triste, un día feliz (+30) sube ×3.3");
    CHECK(NEAR(alma_wellbeing_step(-700, -10), -700 - 10 * (1 - 0.75f * 200 / 523), 1e-3), "del lado triste, hundirse también cuesta");

    fresh(0);
    A.counts.play_done = 2; A.hour_seen[10] = 1;
    alma_night_cycle(&A, 0);
    CHECK(A.wb_day_points == 5, "jugó poco: +5 (%d)", A.wb_day_points);
    fresh(0);
    alma_night_cycle(&A, 0);
    int p1 = A.wb_day_points;
    alma_night_cycle(&A, 0);
    int p2 = A.wb_day_points;
    CHECK(p1 == -5 && p2 == -7 && A.absent_days == 2, "sin verte: −5 y luego −7 (%d, %d)", p1, p2);
    for (int d = 0; d < 10; d++) alma_night_cycle(&A, 0);
    CHECK(A.wb_day_points == -15, "muchos días sin verte: tope −15 (%d)", A.wb_day_points);
    fresh(0);
    A.counts.scares = 3; A.counts.lifts = 4; A.counts.shakes = 1; A.hour_seen[9] = 1;
    alma_night_cycle(&A, 0);
    CHECK(A.wb_day_points == 1 - 6 - 4 - 3, "sustos, levantadas y sacudida restan (%d)", A.wb_day_points);

    fresh(0);
    A.wellbeing = 1000;
    A.hour_seen[9] = 1;
    alma_night_cycle(&A, 0);
    CHECK(NEAR(A.wellbeing, alma_wellbeing_step(1000 * (1 - WB_DRIFT), 1), 1e-3), "deriva: %.1f %% hacia 0 cada noche (%.2f)",
          WB_DRIFT * 100, A.wellbeing);
    A.wellbeing = 1020; A.counts.play_done = 20; A.counts.pets = 10; A.hour_seen[9] = 1;
    alma_night_cycle(&A, 0);
    CHECK(A.wellbeing <= WB_MAX, "tope +1023 (%.1f)", A.wellbeing);

    /* efectos: el juego pesa menos y las pausas son más largas deprimido */
    fresh(0);
    A.soc_pct = 100;
    float s0 = alma_score(&A, B_TOY, 0);
    A.wellbeing = -WB_MAX;
    float s1 = alma_score(&A, B_TOY, 0);
    CHECK(s0 > 0 && NEAR(s1, s0 * (1 - WB_PLAY_W), 1e-4), "deprimido: juego × %.2f (%.3f → %.3f)", 1 - WB_PLAY_W, s0, s1);
    A.wellbeing = WB_MAX;
    CHECK(NEAR(alma_score(&A, B_TOY, 0), s0 * (1 + WB_PLAY_W), 1e-4), "radiante: juego × %.2f", 1 + WB_PLAY_W);
}

static int forgot[ALMA_MAX_PERSONS], n_forgot;
static void on_forget(void *u, int id) { (void)u; forgot[n_forgot++] = id; }

/* 06 (dueño, 2026-10-30): quien no se ve en 28 días se olvida; el dueño (id 0) nunca */
static void test_forget(void)
{
    double t = 1e6;
    alma_init(&A, &cat, 1234, t, (alma_hooks){NULL, NULL, NULL, on_forget, NULL});
    n_forgot = 0;
    for (int id = 0; id <= 2; id++) {
        alma_ev f = {EV_FACE_SEEN, id, -1, -1, 160, 120, 80, 0};
        alma_event(&A, &f, t);
        alma_face_lost(&A, id);
        A.person[alma_slot_of(&A, id)].attachment = 0.6f;
    }
    alma_ev f2 = {EV_FACE_SEEN, 2, -1, -1, 160, 120, 80, 0};
    alma_event(&A, &f2, t + 20 * 86400.0);   /* la 2 vuelve a los 20 días */
    alma_face_lost(&A, 2);
    CHECK(alma_forget_unseen(&A, t + 27.9 * 86400) == 0, "27.9 días: nadie se olvida");
    CHECK(alma_forget_unseen(&A, t + 28.1 * 86400) == 1 && n_forgot == 1 && forgot[0] == 1,
          "28 días sin ver a la persona 1: se olvida y se avisa al HAL");
    CHECK(alma_slot_of(&A, 1) < 0 && alma_slot_of(&A, 0) >= 0 && alma_slot_of(&A, 2) >= 0, "su lugar queda libre; el dueño y la 2 siguen");
    CHECK(alma_forget_unseen(&A, t + 400 * 86400) == 1 && forgot[1] == 2 && alma_slot_of(&A, 0) >= 0,
          "el dueño (id 0) nunca se olvida, ni al año");
    alma_ev f1 = {EV_FACE_SEEN, 1, -1, -1, 160, 120, 80, 0};
    alma_event(&A, &f1, t + 401 * 86400);
    int s1 = alma_slot_of(&A, 1);
    CHECK(s1 >= 0 && A.person[s1].attachment < 0.6f, "si vuelve, empieza de cero (apego %.2f)", s1 >= 0 ? A.person[s1].attachment : -1);
    A.forget_enabled = 0;
    alma_face_lost(&A, 1);
    CHECK(alma_forget_unseen(&A, t + 900 * 86400) == 0, "sin reloj real (forget_enabled = 0): no se olvida a nadie");
}


/* despedida solo si de verdad se fue; la caricia de noche la despierta un rato (dueño, 2026-11-05) */
static void test_goodbye_and_night_pet(void)
{
    double t = 15 * 3600.0;
    fresh(t);
    alma_ev f = {EV_FACE_SEEN, 1, -1, -1, 160, 120, 80, 0};
    alma_sensors off = {100, 0};
    for (int i = 0; i < 200; i++) { t += 2; alma_event(&A, &f, t); alma_tick(&A, t, &off); }
    int s = alma_slot_of(&A, 1);
    A.person[s].greeted_this_visit = 1;
    alma_ev lost = {EV_FACE_LOST, 1, -1, -1, 0, 0, 0, 0};
    t += 5;
    alma_event(&A, &lost, t);
    CHECK(A.bye_slot == s && NEAR(A.bye_due_s - t, GOODBYE_GONE_S, 1e-6), "cara perdida: la despedida espera %.0f s", GOODBYE_GONE_S);
    t += 30;
    alma_event(&A, &f, t);
    CHECK(A.bye_slot == -1, "volvió a verlo a los 30 s: no hay despedida");

    t = 23 * 3600.0;
    fresh(t);
    alma_sensors on = {100, 1};
    alma_tick(&A, t, &on);
    A.state = ST_SLEEPING;
    alma_ev pet = {EV_TOUCH_PET, 1, -1, -1, 0, 0, 0, 1500};
    alma_event(&A, &pet, t + 1);
    CHECK(A.state != ST_SLEEPING, "de noche, una caricia la despierta (estado %d)", A.state);
    t += 1;
    for (int i = 0; i < 600; i++) {   /* el ejecutor termina cada conducta a su hora */
        t += 1;
        if (A.cur.active && t >= A.cur.t_start + A.cur.planned_s) {
            alma_ev d = {EV_BEHAVIOR_DONE, -1, -1, A.cur.behavior, 0, 0, 0, 0};
            alma_event(&A, &d, t);
        }
        alma_tick(&A, t, &on);
    }
    CHECK(A.state == ST_SLEEPING || A.state == ST_RESTING, "sin más estímulos vuelve a dormirse sola (estado %d)", A.state);
}

/* ---- la red (alma_brain.c; dueño, 2026-11-04) ---- */
static int brain_execs, brain_last;
static void brain_on_exec(void *u, const alma_exec_info *e) { (void)u; if (e->kind == RUN_SELECTOR) brain_execs++, brain_last = e->behavior; }
static int pol_seguir(void *u, const float *x, const unsigned char *m, float *p)
{
    (void)u; (void)x; (void)m;
    memset(p, 0, ALMA_BRAIN_OUT * sizeof *p);
    p[0] = 1;
    return 0;
}
static int pol_out;
static int pol_one(void *u, const float *x, const unsigned char *m, float *p)
{
    (void)u; (void)x;
    memset(p, 0, ALMA_BRAIN_OUT * sizeof *p);
    if (m[pol_out]) p[pol_out] = 1; else p[0] = 1;
    return 0;
}

static void test_brain(void)
{
    CHECK(BF_COUNT == ALMA_BRAIN_IN, "entradas: el enum (%d) y ALMA_BRAIN_IN (%d) coinciden", BF_COUNT, ALMA_BRAIN_IN);
    double t = 10 * 3600.0;
    alma_init(&A, &cat, 1234, t, (alma_hooks){brain_on_exec, NULL, NULL, NULL, NULL});
    float x[ALMA_BRAIN_IN];
    alma_brain_features(&A, t, x);
    int finite = 1;
    for (int i = 0; i < ALMA_BRAIN_IN; i++) finite &= isfinite(x[i]) && fabsf(x[i]) <= 1.5f;
    CHECK(finite, "entradas finitas y acotadas al nacer");
    /* "seguir" siempre: sin pausa ni fórmula, no empieza nada por su cuenta */
    alma_brain_set_policy(&A, pol_seguir, NULL);
    brain_execs = 0;
    ticks_off(&t, 900);
    CHECK(brain_execs == 0, "con la red diciendo seguir no hay conductas del selector (%d)", brain_execs);
    /* una salida que no existe en el catálogo (bhv_nap) queda tachada; una que existe se hace */
    unsigned char mk[ALMA_BRAIN_OUT];
    alma_brain_mask(&A, t, mk);
    int k_nap = -1, k_blink = -1;
    for (int k = 0; k < ALMA_BRAIN_OUT; k++) {
        if (!strcmp(ALMA_BRAIN_OUT_ID[k], "bhv_nap")) k_nap = k;
        if (!strcmp(ALMA_BRAIN_OUT_ID[k], "bhv_blink_idle")) k_blink = k;
    }
    CHECK(mk[0] && k_nap > 0 && !mk[k_nap] && k_blink > 0 && mk[k_blink], "máscara: seguir siempre, bhv_nap sin catálogo no, parpadear sí");
    pol_out = k_blink;
    alma_brain_set_policy(&A, pol_one, NULL);
    brain_execs = 0;
    ticks_off(&t, 3);
    CHECK(brain_execs >= 1 && brain_last == B_BLINK, "la red elige parpadear y el núcleo lo hace (%d)", brain_execs);
    /* sin política vuelve la fórmula */
    alma_brain_set_policy(&A, NULL, NULL);
    CHECK(A.policy == NULL, "sin política, alma_select de siempre");

    /* bloque ALMB: se carga, y un byte cambiado o un nombre ajeno lo invalidan */
    enum { H = 2 };
    static uint32_t blob[(32 + 32 * ALMA_BRAIN_OUT) / 4 + 2 * ALMA_BRAIN_IN + H * ALMA_BRAIN_IN + H + H * H + H + ALMA_BRAIN_OUT * H + ALMA_BRAIN_OUT + 1];
    memset(blob, 0, sizeof blob);
    uint32_t hdr[8] = {0x424D4C41u, 1, ALMA_BRAIN_FEAT_VERSION, ALMA_BRAIN_IN, H, H, ALMA_BRAIN_OUT, 20261104};
    memcpy(blob, hdr, sizeof hdr);
    char *ids = (char *)blob + 32;
    for (int k = 0; k < ALMA_BRAIN_OUT; k++) strncpy(ids + 32 * k, ALMA_BRAIN_OUT_ID[k], 32);
    float *f = (float *)(ids + 32 * ALMA_BRAIN_OUT);
    for (int i = 0; i < ALMA_BRAIN_IN; i++) f[ALMA_BRAIN_IN + i] = 1;   /* sd = 1 */
    float *b3 = f + 2 * ALMA_BRAIN_IN + H * ALMA_BRAIN_IN + H + H * H + H + ALMA_BRAIN_OUT * H;
    b3[0] = 5;                                                         /* casi siempre "seguir" */
    uint32_t size = sizeof blob;
    uint32_t crc = alma_brain_crc32(blob, size - 4);
    memcpy((char *)blob + size - 4, &crc, 4);
    alma_mlp m;
    CHECK(alma_mlp_load(&m, blob, size) == 0 && m.h1 == H && m.model_version == 20261104, "ALMB válido se carga");
    float p[ALMA_BRAIN_OUT];
    unsigned char all[ALMA_BRAIN_OUT];
    memset(all, 1, sizeof all);
    all[3] = 0;
    CHECK(alma_mlp_policy(&m, x, all, p) == 0 && p[0] > 0.8f && p[3] == 0, "MLP: seguir %.2f, la tachada en 0", p[0]);
    ((char *)blob)[40] ^= 1;
    CHECK(alma_mlp_load(&m, blob, size) == -5, "un byte cambiado: CRC");
    ((char *)blob)[40] ^= 1;
    CHECK(alma_mlp_load(&m, blob, size - 4) == -3, "tamaño que no cuadra");
    ids[0] = 'X';
    crc = alma_brain_crc32(blob, size - 4);
    memcpy((char *)blob + size - 4, &crc, 4);
    CHECK(alma_mlp_load(&m, blob, size) == -4, "salidas con otro nombre");
}

int main(int argc, char **argv)
{
    build_catalog();
    test_rng();
    test_emotions();
    test_event_gain_and_repeat();
    test_needs();
    test_mood();
    test_attachment();
    test_obedience();
    test_habituation_and_score();
    test_dagger_and_budget();
    test_still_on_charger();
    test_req_parse();
    test_night_cycle();
    test_bedtime();
    test_vision_event();
    test_reflex_and_forced();
    test_listen_only_reflex();
    test_trait_learned_cap();
    test_wellbeing();
    test_forget();
    test_brain();
    test_goodbye_and_night_pet();
    if (argc >= 3) test_real_catalog(argv[1], argv[2]);
    printf("%d comprobaciones, %d fallas\n", checks, fails);
    return fails != 0;
}
