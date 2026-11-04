/* alma_care.c — tamagotchi (dueño, 2026-10-30): hambre, comida real desde la app, gustos propios, ella decide si
 * acepta, golosinas de más empachan y la medicina cura. Cuenta en el bienestar del día (04) y en el diario (07). */
#include <math.h>
#include <string.h>

#include "alma_internal.h"

typedef struct { const char *id; float nutrition, appeal; int sweet, drink; } food_def;

/* nutrition: cuánta hambre quita; appeal: el gusto promedio (los de cada Alma salen alrededor de este) */
static const food_def FOOD[FOOD_COUNT] = {
    [FOOD_MANZANA] = {"manzana", 0.35f, 0.10f, 0, 0},     [FOOD_PLATANO] = {"platano", 0.40f, 0.10f, 0, 0},
    [FOOD_ZANAHORIA] = {"zanahoria", 0.30f, -0.10f, 0, 0}, [FOOD_BROCOLI] = {"brocoli", 0.35f, -0.30f, 0, 0},
    [FOOD_PIZZA] = {"pizza", 0.70f, 0.40f, 0, 0},          [FOOD_HAMBURGUESA] = {"hamburguesa", 0.75f, 0.35f, 0, 0},
    [FOOD_TACOS] = {"tacos", 0.70f, 0.35f, 0, 0},          [FOOD_SUSHI] = {"sushi", 0.55f, 0.10f, 0, 0},
    [FOOD_SOPA] = {"sopa", 0.50f, 0.00f, 0, 0},            [FOOD_GALLETA] = {"galleta", 0.15f, 0.40f, 1, 0},
    [FOOD_HELADO] = {"helado", 0.15f, 0.50f, 1, 0},        [FOOD_PASTEL] = {"pastel", 0.25f, 0.45f, 1, 0},
    [FOOD_LECHE] = {"leche", 0.20f, 0.00f, 0, 1},          [FOOD_JUGO] = {"jugo", 0.15f, 0.25f, 1, 1},
    [FOOD_TE] = {"te", 0.05f, 0.00f, 0, 1},                [FOOD_MEDICINA] = {"medicina", 0.0f, -0.6f, 0, 1},
};
static const char *const WHY[FEED_WHY_COUNT] = {"ok", "le_encanta", "llena", "no_le_gusta", "otra_vez_lo_mismo",
                                                "berrinche", "no_esta_enferma", "medicina", "ocupada"};

const char *alma_food_id(int f) { return f >= 0 && f < FOOD_COUNT ? FOOD[f].id : "?"; }
const char *alma_feed_why_id(alma_feed_why w) { return w < FEED_WHY_COUNT ? WHY[w] : "?"; }

int alma_food_of(const char *id)
{
    for (int f = 0; id && f < FOOD_COUNT; f++)
        if (strcmp(id, FOOD[f].id) == 0) return f;
    return -1;
}

void alma_food_prefs_init(alma_t *a)
{
    int any = 0;
    for (int f = 0; f < FOOD_COUNT; f++) any |= a->food_like[f] != 0;
    if (any) return;
    alma_rng r;   /* otra secuencia: no mueve la del resto de Alma (la misma semilla da los mismos rasgos) */
    alma_rng_seed(&r, (uint64_t)a->seed ^ 0xF00DF00Dull);
    for (int f = 0; f < FOOD_COUNT; f++)
        a->food_like[f] = alma_clampf(FOOD[f].appeal + 1.2f * (alma_rng_u01(&r) - 0.5f), -1, 1);
    a->food_like[FOOD_MEDICINA] = -0.6f;   /* a nadie le gusta */
    a->last_food = -1;
}

float alma_remote_play_points(int seconds)
{
    return WB_REMOTE_MAX * (1.0f - expf(-(seconds / 60.0f) / WB_REMOTE_TAU_MIN));
}

void alma_care_tick(alma_t *a, float dt, double now_s)
{
    if (!a->care_remote) {   /* plan v2: con el servidor al mando, el hambre y la cura las manda él */
        float k = HUNGER_RISE_PER_H * (0.8f + 0.4f * a->trait[TRAIT_ENERGY]);
        if (a->state == ST_SLEEPING) k *= HUNGER_SLEEP_F;
        if (a->sick) k *= 0.5f;
        a->hunger = alma_clampf(a->hunger + k * dt / 3600.0f, 0, 1);
        if (a->sick && now_s - a->sick_since_s > SICK_CURE_S) a->sick = 0;   /* se le pasó sola */
    }
    if (a->hunger >= STARVING_AT) {   /* los minutos de hambre extrema cuentan en el bienestar del día (04) */
        a->starve_acc_s += dt;
        while (a->starve_acc_s >= 60) { a->starve_acc_s -= 60; a->counts.starve_min++; }
    }
}

static float rnd(alma_t *a) { return alma_rng_u01(&a->rng); }

alma_feed_result alma_feed(alma_t *a, int food, double now_s)
{
    alma_feed_result r = {0, FEED_OK, 0, 0};
    if (food < 0 || food >= FOOD_COUNT) { r.why = FEED_DISLIKE; return r; }
    const food_def *d = &FOOD[food];
    float like = r.like = a->food_like[food];
    if (a->state == ST_REFLEX || a->state == ST_LISTENING) { r.why = FEED_BUSY; return r; }

    if (food == FOOD_MEDICINA) {
        if (!a->sick) { r.why = FEED_NOT_SICK; a->counts.refused++; alma_force(a, a->ix_refuse, now_s); return r; }
        a->sick = 0;   /* la toma de mala gana, pero la toma */
        r.accepted = 1;
        r.why = FEED_MEDICINE;
        alma_force(a, a->ix_drink >= 0 ? a->ix_drink : a->ix_eat, now_s);
        return r;
    }
    /* Probabilidad de aceptar: hambre y gusto mandan; llena solo golosinas; repetir aburre; gruñona o enferma rechaza
       más; la impulsividad la vuelve impredecible (berrinche o capricho). */
    float h = a->hunger, p = 0.15f + 0.7f * h + 0.35f * like;
    if (h < FULL_AT && !d->sweet) p *= 0.3f;
    if (d->sweet) p += 0.25f * (1.0f - h);
    if (food == a->last_food && a->same_food_streak >= 2) p -= 0.3f;
    if (a->simple_mood == SM_GRUMPY) p -= 0.25f;
    if (a->sick && !d->drink) p -= 0.3f;
    p += 0.1f * a->affect_valence;
    p += (rnd(a) - 0.5f) * 0.3f * a->trait[TRAIT_IMPULSIVITY];
    p = alma_clampf(p, 0.03f, 0.97f);
    if (rnd(a) >= p) {
        r.why = h < FULL_AT && !d->sweet ? FEED_FULL
              : food == a->last_food && a->same_food_streak >= 2 ? FEED_SAME
              : like < -0.2f ? FEED_DISLIKE : FEED_TANTRUM;
        a->counts.refused++;
        alma_add_frust(a, 0.1f, now_s);
        alma_force(a, a->ix_refuse, now_s);
        return r;
    }
    r.accepted = 1;
    r.why = like > 0.5f ? FEED_LOVED : FEED_OK;
    if (h > 0.4f) a->counts.meals++;
    a->same_food_streak = food == a->last_food ? a->same_food_streak + 1 : 1;
    a->last_food = food;
    a->hunger = alma_clampf(a->hunger - d->nutrition, 0, 1);
    alma_add_joy(a, 0.15f + 0.25f * alma_clampf(like, 0, 1), now_s);
    if (h > 0.4f && like < 0.5f) a->food_like[food] = alma_clampf(like + FOOD_LIKE_LEARN, -1, 1);   /* el hambre enseña */
    if (d->sweet && ++a->counts.treats > TREATS_BEFORE_SICK && !a->sick && rnd(a) < SICK_P) {
        a->sick = 1;
        a->sick_since_s = now_s;
        r.got_sick = 1;
    }
    alma_force(a, d->drink ? (a->ix_drink >= 0 ? a->ix_drink : a->ix_eat) : a->ix_eat, now_s);
    return r;
}

/* ---- plan v2 (dueño, 2026-10-31): el servidor decide; el robot lo vive ---- */

void alma_care_apply_state(alma_t *a, float hunger, alma_sick_cause cause, alma_weight_band band, float energy,
                           double now_s)
{
    int was_sick = a->sick;
    a->care_remote = 1;
    a->hunger = alma_clampf(hunger, 0, 1);
    a->sick = cause != SICK_NONE;
    a->sick_cause = cause;
    if (a->sick && !was_sick) {
        a->sick_since_s = now_s;
        if (a->ix_sick >= 0 && a->state != ST_REFLEX && a->state != ST_LISTENING && a->state != ST_SLEEPING)
            alma_force(a, a->ix_sick, now_s);   /* se siente mal en ese momento, no al rato */
    }
    a->weight_band = band;
    a->care_energy = alma_clampf(energy, 0.2f, 1.2f);
}

void alma_care_apply_feed(alma_t *a, int food, int accepted, float joy, float bond, float frust, double now_s)
{
    if (food < 0 || food >= FOOD_COUNT) return;
    const food_def *d = &FOOD[food];
    int owner = alma_slot_of(a, ALMA_OWNER_ID);
    if (!accepted) {
        a->counts.refused++;
        alma_add_frust(a, alma_clampf(frust, 0, 0.5f), now_s);
        alma_force(a, a->ix_refuse, now_s);
        return;
    }
    if (a->hunger > 0.4f) a->counts.meals++;
    if (d->sweet) a->counts.treats++;
    a->same_food_streak = food == a->last_food ? a->same_food_streak + 1 : 1;
    a->last_food = food;
    if (joy >= 0) alma_add_joy(a, alma_clampf(joy, 0, 0.6f), now_s);
    else alma_add_frust(a, alma_clampf(-joy, 0, 0.3f), now_s);   /* lo comió sin ganas: la desanima un poco */
    if (owner >= 0) {   /* la amistad con el dueño: un poquito por comida */
        if (bond > 0) alma_attach(a, owner, alma_clampf(bond, 0, 0.05f) * 10.0f);
        else if (bond < 0) alma_attach_drop(a, owner, alma_clampf(bond, -0.05f, 0));
    }
    alma_force(a, d->drink ? (a->ix_drink >= 0 ? a->ix_drink : a->ix_eat) : a->ix_eat, now_s);
}

static const char *const EX_ID[EX_COUNT] = {"dance", "activity", "routine", "play", "explore"};

const char *alma_exercise_id(int k) { return k >= 0 && k < EX_COUNT ? EX_ID[k] : "?"; }

/* Solo cuenta si de verdad se mueve (con servos): en la base sin motor no hay ejercicio */
void alma_exercise_tick(alma_t *a, float dt)
{
    if (!a->cur.active || !a->cur.motion_played || dt <= 0 || dt > 5) return;
    int b = a->cur.behavior, k = -1;
    if (b == a->ix_action[ACT_DANCE]) k = EX_DANCE;
    else if (b == a->ix_activity) k = EX_ACTIVITY;
    else if (b == a->ix_routine) k = EX_ROUTINE;
    else if (b == a->ix_explore) k = EX_EXPLORE;
    else if (a->cat->b[b].category == CAT_PLAY) k = EX_PLAY;
    if (k >= 0) a->ex_s[k] += dt;
}
