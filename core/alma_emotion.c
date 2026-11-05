/* alma_emotion.c — emociones, necesidades, afecto y ánimo (04). */
#include <math.h>
#include "alma_internal.h"

static const float JOY_T[JOY_CURVE_N] = JOY_CURVE_T;
static const float JOY_V[JOY_CURVE_N] = JOY_CURVE_V;

typedef struct { float fear, joy, frust, stim, social, w, abs_drop; int joy_social; } ev_effect;

static const ev_effect *effect_of(alma_ev_type t)
{
#define X(ev, f, j, fr, st, so, w, ab, js) case ev: { static const ev_effect e = {f, j, fr, st, so, w, ab, js}; return &e; }
    switch (t) { ALMA_EVENT_EFFECTS(X) default: return 0; }
#undef X
}

/* emo_joy: curva por tramos desde el último estímulo (04) */
static float joy_curve(float t)
{
    if (t <= JOY_T[0]) return JOY_V[0];
    for (int i = 1; i < JOY_CURVE_N; i++)
        if (t <= JOY_T[i])
            return JOY_V[i - 1] + (JOY_V[i] - JOY_V[i - 1]) * (t - JOY_T[i - 1]) / (JOY_T[i] - JOY_T[i - 1]);
    return JOY_V[JOY_CURVE_N - 1];
}

void alma_emotions_at(alma_t *a, double now_s)
{
    a->emo_joy = a->joy_peak * joy_curve((float)(now_s - a->joy_t));
    float fr = 1.0f - (float)(now_s - a->frust_t) / FRUST_LINEAR_S;
    a->emo_frustration = a->frust_peak * (fr > 0 ? fr : 0);
}

void alma_add_fear(alma_t *a, float d, double now_s)
{
    a->emo_fear = alma_clampf(a->emo_fear + d, 0, 1);
    if (d > 0) a->fear_t = now_s;
}

/* Un delta reinicia la curva desde el valor nuevo (DERIVADO, aprobado) */
void alma_add_joy(alma_t *a, float d, double now_s)
{
    alma_emotions_at(a, now_s);
    a->joy_peak = alma_clampf(a->emo_joy + d, 0, 1);
    a->joy_t = now_s;
    a->emo_joy = a->joy_peak;
}

void alma_add_frust(alma_t *a, float d, double now_s)
{
    alma_emotions_at(a, now_s);
    a->frust_peak = alma_clampf(a->emo_frustration + d, 0, 1);
    a->frust_t = now_s;
    a->emo_frustration = a->frust_peak;
}

void alma_add_stim(alma_t *a, float d)
{
    a->stim = alma_clampf(a->stim + d, 0, 1);
    if (d > 0) a->boredom = 0;   /* "cualquier estímulo nuevo: se pone en 0" (DERIVADO: evento externo que suba stim) */
}

void alma_add_social(alma_t *a, float d) { a->need_social = alma_clampf(a->need_social + d, 0, NEED_SOCIAL_CEIL); }

/* Base segura: con la persona de mayor A presente, boldness efectivo +0.15 (04) */
float alma_bold_eff(const alma_t *a)
{
    int best = -1;
    for (int i = 0; i < ALMA_MAX_PERSONS; i++)
        if (a->person[i].used && (best < 0 || a->person[i].attachment > a->person[best].attachment)) best = i;
    float b = a->trait[TRAIT_BOLDNESS];
    if (best >= 0 && a->person[best].present) b += SAFE_BASE_BOLDNESS;
    return alma_clampf(b, 0, 1);
}

/* Penalización por repetición (04): < 0.5 s sin efecto; recupera 100% a los 10 s.
 * DERIVADO (aprobado): se aplica a todos los efectos del evento, también al apego. */
static float repeat_factor(alma_t *a, alma_ev_type t, double now_s)
{
    double dt = now_s - a->last_ev_t[t];
    a->last_ev_t[t] = now_s;
    if (dt < REPEAT_NO_EFFECT_S) return 0;
    return dt >= REPEAT_RECOVER_S ? 1.0f : (float)(dt / REPEAT_RECOVER_S);
}

int alma_apply_event_table(alma_t *a, alma_ev_type t, int slot, double now_s)
{
    const ev_effect *e = effect_of(t);
    if (!e) return 0;
    float h = repeat_factor(a, t, now_s);
    if (h <= 0) return 0;
    float fear_gain = FEAR_GAIN_BASE - alma_bold_eff(a);
    float joy_gain = e->joy_social ? JOY_SOCIAL_GAIN_BASE + JOY_SOCIAL_GAIN_SOC * a->trait[TRAIT_SOCIABILITY] : 1.0f;
    if (e->fear != 0) alma_add_fear(a, e->fear * fear_gain * h, now_s);
    if (e->joy != 0) alma_add_joy(a, e->joy * joy_gain * h, now_s);
    if (e->frust != 0) alma_add_frust(a, e->frust * h, now_s);
    if (e->stim != 0) alma_add_stim(a, e->stim * h);
    if (e->social != 0) alma_add_social(a, e->social * h);
    if (slot >= 0) {
        if (e->w > 0) alma_attach(a, slot, e->w * h);
        if (e->abs_drop < 0) alma_attach_drop(a, slot, e->abs_drop * h);
    }
    return 1;
}

static int distinct_recent(const alma_t *a, double now_s)
{
    int seen[ALMA_RECENT], n = 0;
    for (int i = 0; i < a->n_recent; i++) {
        if (a->recent_t[i] < now_s - BOREDOM_WINDOW_S) continue;
        int dup = 0;
        for (int j = 0; j < n; j++) dup |= seen[j] == a->recent[i];
        if (!dup) seen[n++] = a->recent[i];
    }
    return n;
}

void alma_needs_tick(alma_t *a, float dt, double now_s)
{
    /* stim decae por minuto con pendientes por tramo (04) */
    float rate = a->stim < STIM_LOW ? STIM_DECAY_LOW_PER_MIN : (a->stim > STIM_HIGH ? STIM_DECAY_HIGH_PER_MIN : STIM_DECAY_MID_PER_MIN);
    a->stim = alma_clampf(a->stim - rate * dt / 60.0f, 0, 1);

    /* need_social sube sin compañía: +0.1/h × (0.5 + sociability), techo 0.9 */
    if (!alma_any_known_present(a))
        alma_add_social(a, NEED_SOCIAL_RISE_PER_H * dt / 3600.0f * (NEED_SOCIAL_SOC_BASE + a->trait[TRAIT_SOCIABILITY]));

    /* boredom: need_stimulation > 0.7 por más de 600 s y < 3 conductas distintas en 30 min */
    if (1.0f - a->stim > BOREDOM_NEED_STIM) {
        if (a->stim_hi_need_since < 0) a->stim_hi_need_since = now_s;
        if (now_s - a->stim_hi_need_since > BOREDOM_HOLD_S && distinct_recent(a, now_s) < BOREDOM_DISTINCT)
            a->boredom = alma_clampf(a->boredom + BOREDOM_RISE_PER_MIN * dt / 60.0f, 0, 1);
    } else {
        a->stim_hi_need_since = -1;
    }
}

float alma_budget_s(const alma_t *a) { return BUDGET_BASE_S + BUDGET_ENERGY_S * a->trait[TRAIT_ENERGY]; }

float alma_faint_rec(const alma_t *a, double now_s)
{
    return a->faint_s > 0 && now_s >= a->faint_s ? (float)exp(-(now_s - a->faint_s) / FAINT_TAU_S) : 0.0f;
}

void alma_faint(alma_t *a, double now_s)
{
    a->faint_s = now_s;
    if (a->mood > FAINT_MOOD) a->mood = FAINT_MOOD;
}

float alma_need(const alma_t *a, int need)
{
    switch (need) {
    case NEED_SOCIAL: return a->need_social;
    case NEED_STIMULATION: return 1.0f - a->stim;
    case NEED_BOREDOM: return a->boredom;
    case NEED_REST: {
        /* max(1 − soc/100, awake_h/16, min(1, servo_active_s_today/budget_s)) (04) */
        float r = 1.0f - a->soc_pct / 100.0f;
        float awake = (float)((a->t_now - a->awake_since_s) / 3600.0) / NEED_REST_AWAKE_H;
        float servo = a->servo_active_s_today / alma_budget_s(a);
        if (awake > r) r = awake;
        if (servo > 1) servo = 1;
        if (servo > r) r = servo;
        float weak = FAINT_REST * alma_faint_rec(a, a->t_now);
        if (weak > r) r = weak;
        return alma_clampf(r, 0, 1);
    }
    }
    return 0;
}

/* Dueño, 2026-10-30: "Alma debe ponerse feliz si estoy frente; si no estoy frente, debe estar triste".
 * Con una cara conocida delante: +PRESENCE_VAL_W·(base + (1 − base)·A). Sin ella: la tristeza crece desde
 * ABSENCE_GRACE_S hasta ABSENCE_VAL_MAX en ABSENCE_RAMP_S. Antes de la primera cara conocida desde el arranque no
 * cuenta: si la cámara no detecta, Alma no debe quedarse triste para siempre. */
float alma_presence_valence(const alma_t *a, double now_s)
{
    int P = alma_P(a);
    if (P >= 0)
        return PRESENCE_VAL_W * (PRESENCE_A_BASE + (1.0f - PRESENCE_A_BASE) * a->person[P].attachment);
    if (a->last_known_face_s < -1e11) return 0;   /* NEVER: ninguna cara conocida desde el arranque */
    float r = (float)(now_s - a->last_known_face_s - ABSENCE_GRACE_S) / ABSENCE_RAMP_S;
    return -ABSENCE_VAL_MAX * alma_clampf(r, 0, 1);
}

void alma_affect_tick(alma_t *a, float dt, double now_s)
{
    /* emo_fear: media vida 20 s; 0 a los 60 s del último estímulo */
    a->emo_fear *= (float)pow(2.0, -dt / FEAR_HALF_LIFE_S);
    if (now_s - a->fear_t >= FEAR_ZERO_S) a->emo_fear = 0;
    alma_emotions_at(a, now_s);

    float need_rest = alma_need(a, NEED_REST);
    a->affect_valence = alma_clampf(a->emo_joy - VAL_FEAR_W * a->emo_fear - VAL_FRUST_W * a->emo_frustration
                                    - VAL_BOREDOM_W * a->boredom - VAL_SOCIAL_W * a->need_social
                                    + alma_presence_valence(a, now_s) + WB_VAL_W * a->wellbeing / WB_MAX
                                    - FAINT_SAD * alma_faint_rec(a, now_s)
                                    - (a->care_enabled ? VAL_HUNGER_W * fmaxf(0, a->hunger - 0.5f) + VAL_SICK * a->sick : 0), -1, 1);
    float m = a->emo_fear;
    if (AROUSAL_JOY_W * a->emo_joy > m) m = AROUSAL_JOY_W * a->emo_joy;
    if (AROUSAL_FRUST_W * a->emo_frustration > m) m = AROUSAL_FRUST_W * a->emo_frustration;
    if (AROUSAL_STIM_W * a->stim > m) m = AROUSAL_STIM_W * a->stim;
    a->affect_arousal = alma_clampf(m * (1.0f - AROUSAL_REST_W * need_rest), 0, 1);
    a->mood += (a->affect_valence - a->mood) * (dt / MOOD_TAU_S);

    /* simple_mood, en el orden de 04 */
    if (a->emo_fear > SM_SCARED_FEAR) a->simple_mood = SM_SCARED;
    else if (need_rest > SM_SLEEPY_REST) a->simple_mood = SM_SLEEPY;
    else if (a->emo_frustration > SM_GRUMPY_FRUST || a->mood < SM_GRUMPY_MOOD) a->simple_mood = SM_GRUMPY;
    else if (a->boredom > SM_BORED_BOREDOM) a->simple_mood = SM_BORED;
    else if (a->emo_joy > SM_PLAYFUL_JOY && a->affect_arousal > SM_PLAYFUL_AROUSAL && a->trait[TRAIT_PLAYFULNESS] > SM_PLAYFUL_TRAIT)
        a->simple_mood = SM_PLAYFUL;
    else if (a->affect_valence > SM_HAPPY_VALENCE) a->simple_mood = SM_HAPPY;
    else a->simple_mood = SM_CALM;
}
