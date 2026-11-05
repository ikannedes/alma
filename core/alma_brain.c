/* alma_brain.c — la red que decide (dueño, 2026-11-04; reports/Conducta felina y canina para Alma.md, "La red").
 *
 * Con política (alma_brain_set_policy), Alma decide cada segundo y en cada evento qué conducta hace, sin la pausa fija
 * ni la regla 2. La política ve ALMA_BRAIN_IN números (alma_brain_features) y da probabilidades para "seguir" y cada
 * conducta; la máscara (reglas del cuerpo, cooldown, precondiciones) anula lo que no se puede antes de sortear. Las
 * conductas forzadas, las órdenes, los reflejos, el descanso y el sueño de noche siguen como siempre.
 * La misma función de entradas sirve al robot y al generador de ejemplos (sim/brain_gen.c): la red nunca ve algo que
 * la maestra no vio.
 */
#include <math.h>
#include <string.h>
#include "alma_internal.h"

/* Salidas: 0 = seguir; el resto, conductas del sorteo libre. bhv_goodbye no: es forzada al irse el dueño */
const char *const ALMA_BRAIN_OUT_ID[ALMA_BRAIN_OUT] = {
    "seguir",
    "bhv_blink_idle", "bhv_look_around", "bhv_doze", "bhv_nap", "bhv_go_rest", "bhv_go_home",
    "bhv_greet", "bhv_follow_face", "bhv_enjoy_pet", "bhv_seek_person", "bhv_ask_attention", "bhv_investigate_face",
    "bhv_shy_retreat", "bhv_babble", "bhv_ask_food",
    "bhv_play_bow", "bhv_play_solo", "bhv_dance", "bhv_chase_turn", "bhv_happy_wiggle", "bhv_routine", "bhv_activity",
    "bhv_imitate", "bhv_sing",
    "bhv_explore", "bhv_inspect_obstacle",
    "bhv_sulk", "bhv_yawn_bored", "bhv_sick",
};

#define NEVER (-1e12)
#define DAY_S 86400.0
#define TWO_PI 6.283185307179586

static float rec(double now_s, double t, double tau) { return t <= NEVER / 2 ? 0.0f : (float)exp(-(now_s - t) / tau); }
static float log_s(double s, double cap) { return s <= 0 ? 0.0f : alma_clampf((float)(log1p(s) / log1p(cap)), 0, 1); }

int alma_brain_family(const alma_t *a, int b)
{
    if (b < 0) return BFAM_OTHER;
    switch (a->cat->b[b].category) {
    case CAT_IDLE: return BFAM_IDLE;
    case CAT_REST: return BFAM_REST;
    case CAT_SOCIAL: return BFAM_SOCIAL;
    case CAT_PLAY: return BFAM_PLAY;
    case CAT_EXPLORE: return BFAM_EXPLORE;
    case CAT_EMOTION: return BFAM_EMOTION;
    default: return BFAM_OTHER;
    }
}

void alma_brain_init(alma_t *a)
{
    alma_brain_mem *m = &a->bm;
    memset(m, 0, sizeof *m);
    m->ask_t = m->ignored_t = m->owner_contact_t = m->arrive_t = m->acc_t = NEVER;
    m->cur_since_s = m->idle_since_s = a->t_now;
    for (int f = 0; f < BFAM_COUNT; f++) m->fam_t[f] = NEVER;
    m->last_fam = BFAM_IDLE;
    m->last_b = -1;
    a->independence = 0.5f;
    for (int k = 0; k < ALMA_BRAIN_OUT; k++) a->ix_brain[k] = k ? alma_find(a->cat, ALMA_BRAIN_OUT_ID[k]) : -1;
}

void alma_brain_set_policy(alma_t *a, alma_policy_fn fn, void *user)
{
    a->policy = fn;
    a->policy_user = user;
    a->bm.next_s = 0;
}

/* acumuladores que decaen como exp(−t/τ): regaños τ = 10 min, caricias 5 min, insistencia del dueño 2 min */
static void acc_decay(alma_brain_mem *m, double now_s)
{
    if (m->acc_t > NEVER / 2) {
        double dt = now_s - m->acc_t;
        m->scold_acc *= (float)exp(-dt / 600.0);
        m->pet_acc *= (float)exp(-dt / 300.0);
        m->insist_acc *= (float)exp(-dt / 120.0);
    }
    m->acc_t = now_s;
}

void alma_brain_note_event(alma_t *a, alma_ev_type t, double now_s)
{
    alma_brain_mem *m = &a->bm;
    int owner = t == EV_TOUCH_PET || t == EV_TOUCH_TAP || t == EV_PRAISE || t == EV_VOICE_COMMAND || t == EV_REMOTE_COMMAND;
    if (!owner && t != EV_SCOLD) return;
    acc_decay(m, now_s);
    if (t == EV_SCOLD) m->scold_acc += 1;
    if (t == EV_TOUCH_PET) m->pet_acc += 1;
    if (owner) {
        /* contacto que ella no pidió en el último minuto: el dueño insiste (I4, Turner) */
        if (now_s - m->ask_t > 60.0) m->insist_acc += 1;
        m->owner_contact_t = now_s;
    }
}

void alma_brain_on_start(alma_t *a, int b, double now_s)
{
    alma_brain_mem *m = &a->bm;
    m->cur_since_s = now_s;
    m->fam_t[alma_brain_family(a, b)] = now_s;
    if ((a->cat->b[b].tags & TAG_ATTENTION) || b == a->ix_action[ACT_PLAY]) m->ask_t = now_s;   /* ella pidió */
}

void alma_brain_on_finish(alma_t *a, const alma_current *c, double now_s)
{
    alma_brain_mem *m = &a->bm;
    m->idle_since_s = now_s;
    m->last_fam = alma_brain_family(a, c->behavior);
    m->last_b = c->behavior;
    int day = (int)floor(now_s / DAY_S);
    if (day != m->play_day) { m->play_day = day; m->play_s_today = 0; }
    if (a->cat->b[c->behavior].category == CAT_PLAY && c->motion_played) m->play_s_today += (float)(now_s - c->t_start);
    /* la siesta descansa: cada minuto dormida quita dos de "despierta" (necesidad de descanso, 04) */
    if (c->behavior == a->ix_brain[4]) a->awake_since_s = fmin(now_s, a->awake_since_s + 2.0 * (now_s - c->t_start));
}

void alma_brain_ignored(alma_t *a, double now_s) { a->bm.ignored_t = now_s; }

void alma_brain_features(const alma_t *a, double now_s, float x[ALMA_BRAIN_IN])
{
    const alma_brain_mem *m = &a->bm;
    int P = alma_P(a);
    int present = alma_any_known_present(a);
    int i = 0;
    memset(x, 0, ALMA_BRAIN_IN * sizeof *x);
    /* necesidades y ánimo */
    x[i++] = 1.0f - alma_need(a, NEED_REST);                                          /* 0 energía */
    x[i++] = alma_need(a, NEED_SOCIAL);
    x[i++] = alma_need(a, NEED_STIMULATION);
    x[i++] = alma_need(a, NEED_BOREDOM);
    for (int s = 0; s < SM_COUNT; s++) x[i++] = (int)a->simple_mood == s;                   /* 4–10 */
    x[i++] = alma_clampf(a->affect_valence, -1, 1);                                   /* 11 */
    x[i++] = alma_clampf(a->affect_arousal, -1, 1);
    x[i++] = alma_clampf(a->mood, -1, 1);
    x[i++] = alma_clampf(a->emo_fear, 0, 1);
    x[i++] = alma_clampf(a->emo_joy, 0, 1);
    x[i++] = alma_clampf(a->emo_frustration, 0, 1);                                   /* 16 */
    /* hora */
    double d = fmod(now_s, DAY_S);
    if (d < 0) d += DAY_S;
    x[i++] = (float)sin(TWO_PI * d / DAY_S);                                        /* 17 */
    x[i++] = (float)cos(TWO_PI * d / DAY_S);
    x[i++] = alma_in_night_window(a, now_s);                                          /* 19 */
    /* el dueño */
    x[i++] = present;                                                                 /* 20 */
    x[i++] = P >= 0 && a->person[P].facing;
    x[i++] = now_s - a->unknown_seen_s < 10.0;
    x[i++] = P >= 0 && now_s < a->person[P].wary_until_s;
    x[i++] = present ? 0.0f : a->last_known_face_s <= NEVER / 2 ? 1.0f : log_s((now_s - a->last_known_face_s) / 60.0, 1440);  /* 24 sola */
    x[i++] = present && P >= 0 ? alma_greet_intensity(a, P, now_s) : 0.0f;
    x[i++] = P >= 0 && a->person[P].greeted_this_visit;                               /* 26 */
    /* lo que pasó hace poco */
    x[i++] = rec(now_s, a->last_ev_t[EV_TOUCH_PET], 120);                             /* 27 */
    x[i++] = rec(now_s, a->last_ev_t[EV_PRAISE], 120);
    x[i++] = rec(now_s, a->last_ev_t[EV_SCOLD], 300);
    x[i++] = rec(now_s, a->last_ev_t[EV_VOICE_COMMAND], 120);
    x[i++] = rec(now_s, m->ignored_t, 600);                                           /* 31 */
    x[i++] = rec(now_s, m->ask_t, 120);
    x[i++] = rec(now_s, m->owner_contact_t, 60);
    double dt = m->acc_t > NEVER / 2 ? now_s - m->acc_t : 0;
    x[i++] = alma_clampf(m->scold_acc * (float)exp(-dt / 600.0) / 3.0f, 0, 1);       /* 34 */
    x[i++] = alma_clampf(m->pet_acc * (float)exp(-dt / 300.0) / 5.0f, 0, 1);
    x[i++] = alma_clampf(m->insist_acc * (float)exp(-dt / 120.0) / 4.0f, 0, 1);
    x[i++] = present ? rec(now_s, m->arrive_t, 60) : 0.0f;                            /* 37 llegó hace poco */
    /* qué está haciendo */
    int fam = a->cur.active ? alma_brain_family(a, a->cur.behavior) : m->last_fam;
    for (int f = 0; f < BFAM_COUNT; f++) x[i++] = fam == f;                          /* 38–44 */
    x[i++] = a->cur.active;                                                           /* 45 */
    x[i++] = a->cur.active ? log_s(now_s - m->cur_since_s, 3600) : 0.0f;
    x[i++] = a->cur.active ? 0.0f : log_s(now_s - m->idle_since_s, 3600);            /* 47 */
    for (int f = 0; f < BFAM_COUNT; f++) x[i++] = rec(now_s, m->fam_t[f], 900);       /* 48–54 */
    int day = (int)floor(now_s / DAY_S);
    x[i++] = day == m->play_day ? alma_clampf(m->play_s_today / 2700.0f, 0, 1.5f) : 0.0f;   /* 55 */
    /* cuerpo */
    x[i++] = a->on_charger;                                                           /* 56 */
    x[i++] = alma_clampf(a->soc_pct / 100.0f, 0, 1);
    x[i++] = alma_relaxed_field(a, now_s);
    x[i++] = a->sick != 0;
    x[i++] = alma_clampf(a->hunger, 0, 1);                                            /* 60 */
    /* carácter: cariñosa, independiente, juguetona, impulsiva, valiente, energía; bienestar */
    x[i++] = a->trait[TRAIT_SOCIABILITY];                                             /* 61 */
    x[i++] = a->independence;
    x[i++] = a->trait[TRAIT_PLAYFULNESS];
    x[i++] = a->trait[TRAIT_IMPULSIVITY];
    x[i++] = alma_bold_eff(a);
    x[i++] = a->trait[TRAIT_ENERGY];
    x[i++] = alma_clampf(a->wellbeing / WB_MAX, -1, 1);                               /* 67 */
    /* lo que pasó en este segundo (τ 5 s; llegada τ 15 s): con los τ largos "ahora" y "hace 3 s" casi no se distinguen */
    x[i++] = rec(now_s, a->last_ev_t[EV_TOUCH_PET], 5);                               /* 68 */
    x[i++] = rec(now_s, a->last_ev_t[EV_SCOLD], 5);
    x[i++] = rec(now_s, a->last_ev_t[EV_PRAISE], 5);
    x[i++] = present ? rec(now_s, m->arrive_t, 15) : 0.0f;                            /* 71 */
    (void)i;   /* i == BF_COUNT == ALMA_BRAIN_IN (sim/test_core.c) */
}

void alma_brain_mask(const alma_t *a, double now_s, unsigned char mask[ALMA_BRAIN_OUT])
{
    mask[0] = 1;
    for (int k = 1; k < ALMA_BRAIN_OUT; k++) {
        int b = a->ix_brain[k];
        mask[k] = b >= 0 && !(a->cur.active && a->cur.behavior == b) && alma_in_free_pool(a, b, now_s)
                  && alma_eligible(a, b, now_s);
    }
}

/* Una decisión. 1 = empezó una conducta, 0 = siguió, −1 = la política falló */
static int step(alma_t *a, double now_s, int event)
{
    float x[ALMA_BRAIN_IN], p[ALMA_BRAIN_OUT];
    unsigned char m[ALMA_BRAIN_OUT];
    alma_brain_features(a, now_s, x);
    alma_brain_mask(a, now_s, m);
    if (a->policy(a->policy_user, x, m, p)) return -1;
    float tot = 0;
    for (int k = 0; k < ALMA_BRAIN_OUT; k++) tot += p[k] = m[k] && p[k] > 0 ? p[k] : 0;
    int k = 0;
    if (tot > 0) {
        float r = alma_rng_u01(&a->rng) * tot;
        for (int j = 0; j < ALMA_BRAIN_OUT; j++) {
            if (p[j] <= 0) continue;
            k = j;                       /* la última con probabilidad, por si el redondeo deja r ≥ 0 al final */
            if (r < p[j]) break;
            r -= p[j];
        }
    }
    if (k == 0) return 0;
    int b = a->ix_brain[k];
    alma_start(a, b, now_s < a->window_until[b] ? RUN_WINDOW : RUN_SELECTOR, now_s, 0, 0);
    if (a->hooks.on_brain) {
        alma_brain_decision dd = {k, b, {0, 0, 0}, {0, 0, 0}, x, event};
        for (int j = 0; j < ALMA_BRAIN_OUT; j++)
            for (int t = 0; t < 3; t++)
                if (p[j] / tot > dd.top_p[t]) {
                    for (int u = 2; u > t; u--) { dd.top[u] = dd.top[u - 1]; dd.top_p[u] = dd.top_p[u - 1]; }
                    dd.top[t] = j;
                    dd.top_p[t] = p[j] / tot;
                    break;
                }
        a->hooks.on_brain(a->hooks.user, &dd);
    }
    return 1;
}

/* ¿la conducta en curso se puede cambiar? Solo estar quieta, dormitar o la siesta, sin movimiento: una animación,
   una rutina o algo forzado no se corta a la mitad (A3) */
static int interruptible(const alma_t *a)
{
    if (!a->cur.active || a->cur.option >= 0 || a->cur.hold || a->cur.kind == RUN_REFLEX || a->cur.kind == RUN_COMMAND) return 0;
    alma_category c = a->cat->b[a->cur.behavior].category;
    return c == CAT_IDLE || c == CAT_REST;
}

void alma_brain_poke(alma_t *a, double now_s, int event)
{
    if (!a->policy) return;
    if (!event && now_s < a->bm.next_s) return;
    if (a->state != ST_AWAKE && !(a->state == ST_PERFORMING && interruptible(a))) return;
    a->bm.next_s = now_s + 1.0;
    step(a, now_s, event);
}

/* ---- MLP ---- */

uint32_t alma_brain_crc32(const void *p, uint32_t n)
{
    const unsigned char *s = p;
    uint32_t c = 0xFFFFFFFFu;
    while (n--) {
        c ^= *s++;
        for (int k = 0; k < 8; k++) c = c & 1 ? (c >> 1) ^ 0xEDB88320u : c >> 1;
    }
    return ~c;
}

#define MLP_MAX_H 128

int alma_mlp_load(alma_mlp *m, const void *blob, uint32_t size)
{
    const uint32_t *h = blob;
    if (size < 32 || ((uintptr_t)blob & 3) || h[0] != 0x424D4C41u || h[1] != 1) return -1;   /* "ALMB", formato 1 */
    if (h[2] != ALMA_BRAIN_FEAT_VERSION) return -2;
    int n_in = (int)h[3], h1 = (int)h[4], h2 = (int)h[5], n_out = (int)h[6];
    if (n_in != ALMA_BRAIN_IN || n_out != ALMA_BRAIN_OUT || h1 < 1 || h2 < 1 || h1 > MLP_MAX_H || h2 > MLP_MAX_H) return -3;
    uint32_t nf = (uint32_t)(2 * n_in + h1 * n_in + h1 + h2 * h1 + h2 + n_out * h2 + n_out);
    if (size != 32 + 32u * (uint32_t)n_out + 4 * nf + 4) return -3;
    const char *ids = (const char *)blob + 32;
    for (int k = 0; k < n_out; k++)
        if (strncmp(ids + 32 * k, ALMA_BRAIN_OUT_ID[k], 32) != 0) return -4;
    uint32_t crc;
    memcpy(&crc, (const char *)blob + size - 4, 4);
    if (crc != alma_brain_crc32(blob, size - 4)) return -5;
    const float *f = (const float *)(ids + 32 * n_out);
    m->n_in = n_in; m->h1 = h1; m->h2 = h2; m->n_out = n_out; m->model_version = h[7];
    m->mu = f; f += n_in;
    m->sd = f; f += n_in;
    m->w1 = f; f += h1 * n_in;
    m->b1 = f; f += h1;
    m->w2 = f; f += h2 * h1;
    m->b2 = f; f += h2;
    m->w3 = f; f += n_out * h2;
    m->b3 = f;
    return 0;
}

int alma_mlp_policy(void *mlp, const float *x, const unsigned char *mask, float *p)
{
    const alma_mlp *m = mlp;
    float z[ALMA_BRAIN_IN], a1[MLP_MAX_H], a2[MLP_MAX_H];
    for (int i = 0; i < m->n_in; i++) z[i] = (x[i] - m->mu[i]) / m->sd[i];
    for (int j = 0; j < m->h1; j++) {
        const float *w = m->w1 + j * m->n_in;
        float s = m->b1[j];
        for (int i = 0; i < m->n_in; i++) s += w[i] * z[i];
        a1[j] = s > 0 ? s : 0;
    }
    for (int j = 0; j < m->h2; j++) {
        const float *w = m->w2 + j * m->h1;
        float s = m->b2[j];
        for (int i = 0; i < m->h1; i++) s += w[i] * a1[i];
        a2[j] = s > 0 ? s : 0;
    }
    float mx = -1e30f;
    for (int k = 0; k < m->n_out; k++) {
        if (!mask[k]) { p[k] = 0; continue; }
        const float *w = m->w3 + k * m->h2;
        float s = m->b3[k];
        for (int i = 0; i < m->h2; i++) s += w[i] * a2[i];
        p[k] = s;
        if (s > mx) mx = s;
    }
    float tot = 0;
    for (int k = 0; k < m->n_out; k++) tot += p[k] = mask[k] ? expf(p[k] - mx) : 0;   /* temperatura 1 */
    if (!(tot > 0)) return -1;
    for (int k = 0; k < m->n_out; k++) p[k] /= tot;
    return 0;
}
