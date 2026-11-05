/* alma_select.c — habituación, utilidad, selección, órdenes y respuestas (04, 05). */
#include <math.h>
#include <string.h>
#include "alma_internal.h"

static int eq(int b, int ix) { return ix >= 0 && b == ix; }

static int is_forced(const alma_t *a, int b)
{
    return eq(b, a->ix_startle) || eq(b, a->ix_confused) || eq(b, a->ix_refuse) || eq(b, a->ix_listen) || eq(b, a->ix_stretch)
           || eq(b, a->ix_reminder) || eq(b, a->ix_eat) || eq(b, a->ix_drink)    /* alarma y comida: solo forzadas */
           || eq(b, a->ix_trick);                                               /* y los trucos (los pide el servidor) */
}

static int is_window(const alma_t *a, int b) { return eq(b, a->ix_enjoy_pet) || eq(b, a->ix_inspect) || eq(b, a->ix_wiggle); }

static int is_command_only(const alma_t *a, int b)
{
    return eq(b, a->ix_action[ACT_COME]) || eq(b, a->ix_action[ACT_TURN_AROUND]) || eq(b, a->ix_action[ACT_STOP]);
}

/* 05, "Cómo se disparan" */
int alma_in_free_pool(const alma_t *a, int b, double now_s)
{
    if (a->cat->b[b].category == CAT_REFLEX || eq(b, a->ix_sleep_cycle) || eq(b, a->ix_reflex) || eq(b, a->ix_ask_help) ||
        eq(b, a->ix_struggle)) return 0;
    if (is_forced(a, b) || is_command_only(a, b)) return 0;
    if (is_window(a, b)) return now_s < a->window_until[b];
    return 1;
}

int alma_relaxed_field(const alma_t *a, double now_s)
{
    return a->soc_pct > RELAXED_BATTERY && a->emo_fear < RELAXED_FEAR && now_s - a->last_fall_or_shake_s >= RELAXED_NO_FALL_S;
}

static int req_one(const alma_t *a, alma_req_kind k, float arg, int P, double now_s)
{
    switch (k) {
    case REQ_KNOWN_FACE_PRESENT:     return alma_any_known_present(a);
    case REQ_UNKNOWN_FACE_PRESENT:   return now_s - a->unknown_seen_s < FACE_LOST_S;
    case REQ_FACE_FACING:            return P >= 0 && a->person[P].facing;
    case REQ_NO_FACE:                return !alma_any_known_present(a) && now_s - a->unknown_seen_s >= FACE_LOST_S;
    case REQ_ON_CHARGER:             return a->on_charger;
    case REQ_OFF_CHARGER:            return !a->on_charger;
    case REQ_RELAXED_FIELD:          return alma_relaxed_field(a, now_s);
    case REQ_BATTERY_GE:             return a->soc_pct >= arg;
    case REQ_BATTERY_LE:             return a->soc_pct <= arg;
    case REQ_NOT_GREETED_THIS_VISIT: return P >= 0 && !a->person[P].greeted_this_visit;
    case REQ_GREET_INTENSITY_GE:     return alma_greet_intensity(a, P, now_s) >= arg;
    case REQ_NOT_WARY_OF_P:          return P < 0 || now_s >= a->person[P].wary_until_s;
    case REQ_WARY_OF_P:              return P >= 0 && now_s < a->person[P].wary_until_s;
    case REQ_NIGHT_WINDOW:           return alma_in_night_window(a, now_s);
    case REQ_DAY_WINDOW:             return !alma_in_night_window(a, now_s);
    case REQ_HAS_HOME_STATION:       return a->has_home_station;
    case REQ_HUNGRY:                 return a->hunger >= HUNGRY_AT;
    case REQ_SICK:                   return a->sick;
    }
    return 0;
}

int alma_req_ok(const alma_t *a, const alma_req *r, int P, double now_s)
{
    for (int i = 0; i < r->n_alt; i++)
        if (req_one(a, r->kind[i], r->arg[i], P, now_s)) return 1;
    return 0;
}

/* Precondiciones de una orden: se ignoran las de oportunidad social (DERIVADO, ver reporte) */
static int command_reqs_ok(const alma_t *a, int b, int P, double now_s)
{
    const alma_behavior *x = &a->cat->b[b];
    for (int i = 0; i < x->n_req; i++) {
        alma_req_kind k = x->req[i].kind[0];
        if (x->req[i].n_alt == 1 && (k == REQ_NOT_GREETED_THIS_VISIT || k == REQ_GREET_INTENSITY_GE || k == REQ_BATTERY_LE)) continue;
        if (!alma_req_ok(a, &x->req[i], P, now_s)) return 0;
    }
    return !(x->tags & TAG_PLAY) || alma_relaxed_field(a, now_s);
}

/* score(b) de 04, "Selección de conducta" */
/* ¿se puede hacer ahora? (la misma puerta para la fórmula y para la red) */
int alma_eligible(const alma_t *a, int b, double now_s)
{
    const alma_behavior *x = &a->cat->b[b];
    if (a->age_days < x->unlock_day || now_s - a->last_exec_t[b] < x->cooldown_s) return 0;
    int P = alma_P(a);
    for (int i = 0; i < x->n_req; i++)
        if (!alma_req_ok(a, &x->req[i], P, now_s)) return 0;
    if ((x->tags & TAG_PLAY) && !alma_relaxed_field(a, now_s)) return 0;               /* regla 4 */
    if (a->sick && x->category == CAT_PLAY) return 0;   /* enferma no baila, no juega ni pide jugar (plan v2) */
    if ((x->tags & TAG_ATTENTION) && now_s < a->attention_suppressed_until) return 0;  /* regla 3 */
    return 1;
}

float alma_score(alma_t *a, int b, int use_pref)
{
    const alma_behavior *x = &a->cat->b[b];
    double now_s = a->t_now;
    if (!alma_eligible(a, b, now_s)) return 0;
    int P = alma_P(a);

    float s = x->base, n = 1, t = 1;
    for (int d = 0; d < NEED_COUNT; d++) n += x->need_w[d] * alma_need(a, d);
    s *= n * x->mood_fit[a->simple_mood];
    for (int k = 0; k < TRAIT_COUNT; k++) {
        float v = k == TRAIT_BOLDNESS ? alma_bold_eff(a) : a->trait[k];
        t += x->trait_w[k] * (v - 0.5f);
    }
    s *= (t > 0 ? t : 0) * a->interest[b];
    if (use_pref && P >= 0) s *= 1.0f + SEL_PREF_GAIN * a->person[P].pref[b];
    if (x->category == CAT_PLAY) s *= 1.0f + WB_PLAY_W * a->wellbeing / WB_MAX;   /* bienestar (04) */
    if (x->category == CAT_PLAY || x->category == CAT_EXPLORE) s *= a->care_energy;  /* sobrepeso o hambre: se mueve menos */
    if ((x->tags & TAG_LOCOMOTION) && a->soc_pct < SAVE_BATTERY_PCT) s *= SAVE_LOCO_F;   /* ahorra un poco (dueño, 2026-11-02) */
    if (is_window(a, b) && now_s < a->window_until[b]) s *= WINDOW_BOOST;          /* responde a lo que le hiciste */
    return s > 0 ? s : 0;
}

static float pause_s(alma_t *a)
{
    float hi = PAUSE_MAX_S - PAUSE_ENERGY_S * a->trait[TRAIT_ENERGY];
    float w = a->wellbeing / WB_MAX;
    float f = alma_P(a) >= 0 ? PRESENCE_PAUSE_F : 1.0f;
    float c = 1.0f / fmaxf(0.5f, a->care_energy) * (a->sick ? 1.5f : 1.0f);   /* cansada o enferma: descansa más */
    return (PAUSE_MIN_S + (hi - PAUSE_MIN_S) * alma_rng_u01(&a->rng)) * (1.0f - (w < 0 ? WB_PAUSE_W_SAD : WB_PAUSE_W_HAPPY) * w) * f * c;
}

static void pend_add(alma_t *a, alma_pending_kind k, int b, int person, int action, double deadline_s)
{
    int slot = 0;
    for (int i = 0; i < ALMA_MAX_PENDING; i++) {
        if (a->pend[i].kind == PEND_NONE) { slot = i; break; }
        if (a->pend[i].deadline_s < a->pend[slot].deadline_s) slot = i;   /* lleno: reemplaza la más vieja */
    }
    a->pend[slot] = (alma_pending){k, b, person, action, deadline_s};
}

static void play_done(alma_t *a, int slot, double now_s)
{
    a->counts.play_done++;
    alma_add_joy(a, PLAY_DONE_JOY * (JOY_SOCIAL_GAIN_BASE + JOY_SOCIAL_GAIN_SOC * a->trait[TRAIT_SOCIABILITY]), now_s);
    alma_add_stim(a, PLAY_DONE_STIM);
    alma_add_social(a, PLAY_DONE_SOCIAL);
    if (slot >= 0) alma_attach(a, slot, PLAY_DONE_W);
    if (a->ix_wiggle >= 0) a->window_until[a->ix_wiggle] = now_s + RESPONSE_WINDOW_S;
}

/* "option_hours" (dueño, 2026-10-30): p. ej. Good_morning solo de 5:00 a 12:00. Rango [hhmm0, hhmm1), cruza la medianoche si hhmm1 < hhmm0 */
int alma_opt_in_hours(const alma_motion_opt *o, double now_s)
{
    if (o->hhmm0 < 0) return 1;
    double d = fmod(now_s, 86400.0);
    if (d < 0) d += 86400.0;
    int hm = (int)(d / 3600.0) * 100 + (int)(fmod(d, 3600.0) / 60.0);
    return o->hhmm0 <= o->hhmm1 ? hm >= o->hhmm0 && hm < o->hhmm1 : hm >= o->hhmm0 || hm < o->hhmm1;
}

void alma_start(alma_t *a, int b, alma_run_kind kind, double now_s, float ref_score, int hold)
{
    alma_start_opt(a, b, kind, now_s, ref_score, hold, -2);
}

/* forced_opt: −2 = sortear una opción reproducible, −1 = sin movimiento, ≥ 0 = esa opción */
void alma_start_opt(alma_t *a, int b, alma_run_kind kind, double now_s, float ref_score, int hold, int forced_opt)
{
    if (b < 0) return;
    if (a->cur.active) alma_finish(a, now_s, 1);
    const alma_behavior *x = &a->cat->b[b];
    float speed = SPEED_MIN + (SPEED_MAX - SPEED_MIN) * alma_rng_u01(&a->rng);
    int opt = -1, reason = 0;
    float dur;

    if (forced_opt >= 0) {
        opt = forced_opt;
        dur = x->opt[opt].dur_s / speed;
        /* el reflejo de borde sí camina (hacia atrás) aunque la marcha propia de Alma siga apagada (dueño, 2026-10-30) */
        if (x->opt[opt].gait && !GAIT_MODE_AVAILABLE && kind != RUN_REFLEX) { reason = 1; opt = -1; }
        else if (a->servo_active_s_today + x->opt[opt].dur_s * BUDGET_MARGIN > alma_budget_s(a)) { reason = 2; opt = -1; }
    } else if (forced_opt == -1) {
        dur = x->dur_max_s > 0 ? x->dur_min_s + (x->dur_max_s - x->dur_min_s) * alma_rng_u01(&a->rng) : 1.0f;
    } else if (x->n_opt > 0) {
        /* regla † (05) y restricción de locomotion sobre la base o con EV_CLIFF reciente */
        int ok[ALMA_MAX_OPTIONS], n = 0;
        int block = a->on_charger || now_s - a->last_cliff_s < CLIFF_RECENT_S;
        for (int i = 0; i < x->n_opt; i++)
            if ((!x->opt[i].gait || (GAIT_MODE_AVAILABLE && !block)) && alma_opt_in_hours(&x->opt[i], now_s)) ok[n++] = i;
        if (n == 0)   /* ninguna a esta hora: las de siempre (sin la restricción de horas) */
            for (int i = 0; i < x->n_opt; i++)
                if (!x->opt[i].gait || (GAIT_MODE_AVAILABLE && !block)) ok[n++] = i;
        if (n > 0) {   /* plan v2: la caminata zombie es de enferma (enferma camina así; sana, solo si no hay otra) */
            int z = 0;
            for (int i = 0; i < n; i++)
                if ((strncmp(x->opt[ok[i]].mot[0], "zombie", 6) == 0) == (a->sick != 0)) ok[z++] = ok[i];
            if (z > 0) n = z;
        }
        if (n == 0) {
            reason = 1;
            dur = x->opt[(int)(alma_rng_u01(&a->rng) * x->n_opt)].dur_s;   /* dura lo que habría durado (05) */
        } else {
            opt = ok[(int)(alma_rng_u01(&a->rng) * n)];
            dur = x->opt[opt].dur_s;
            if (a->servo_active_s_today + x->servo_cost_s * BUDGET_MARGIN > alma_budget_s(a)) { reason = 2; opt = -1; }
        }
        dur /= speed;
    } else {
        dur = x->dur_min_s + (x->dur_max_s - x->dur_min_s) * alma_rng_u01(&a->rng);
    }
    if (opt >= 0 && a->on_charger && !ALMA_DEV_MOTION_ON_USB) { opt = -1; reason = 3; }   /* cargando: solo cara (04, "Carga") */
    float tempo = 1.0f;
    if (opt >= 0 && x->opt[opt].gait && kind != RUN_REFLEX && (x->category == CAT_PLAY || x->category == CAT_EXPLORE)
        && (a->simple_mood == SM_PLAYFUL || a->simple_mood == SM_HAPPY) && a->affect_arousal > RUN_AROUSAL
        && now_s - a->last_cliff_s > RUN_NO_CLIFF_S && a->wellbeing / WB_MAX > WB_RUN_MIN && !a->sick && a->care_energy >= 0.8f
        && alma_rng_u01(&a->rng) < a->trait[TRAIT_ENERGY] * (1.0f + 0.5f * a->wellbeing / WB_MAX))
        tempo = RUN_TEMPO;

    a->interest[b] *= INTEREST_EXEC_FACTOR;
    a->last_exec_t[b] = now_s;
    a->counts.behaviors[b]++;
    for (int i = ALMA_RECENT - 1; i > 0; i--) { a->recent[i] = a->recent[i - 1]; a->recent_t[i] = a->recent_t[i - 1]; }
    a->recent[0] = b;
    a->recent_t[0] = now_s;
    if (a->n_recent < ALMA_RECENT) a->n_recent++;

    a->cur = (alma_current){0};
    a->cur.active = 1;
    a->cur.behavior = b;
    a->cur.option = opt;
    a->cur.person = alma_P(a);
    a->cur.action = -1;
    a->cur.hold = hold;
    a->cur.kind = kind;
    a->cur.t_start = now_s;
    a->cur.planned_s = dur;
    a->cur.ref_score = ref_score;
    a->cur.motion_played = opt >= 0;
    if (b == a->ix_greet && a->cur.person >= 0) a->person[a->cur.person].greeted_this_visit = 1;
    if (kind != RUN_REFLEX) a->state = ST_PERFORMING;
    alma_brain_on_start(a, b, now_s);

    if (a->hooks.on_exec) {
        alma_exec_info e = {b, kind, opt, reason, now_s, dur, a->cur.person, tempo};
        a->hooks.on_exec(a->hooks.user, &e);
    }
}

void alma_finish(alma_t *a, double now_s, int interrupted)
{
    if (!a->cur.active) return;
    alma_current c = a->cur;
    a->cur.active = 0;
    const alma_behavior *x = &a->cat->b[c.behavior];
    if (c.motion_played) a->servo_active_s_today += (float)(now_s - c.t_start);   /* duración real (04) */
    alma_brain_on_finish(a, &c, now_s);

    if (interrupted) {
        alma_add_frust(a, INTERRUPTED_FRUST * (1.0f - INTERRUPTED_IMP_W * a->trait[TRAIT_IMPULSIVITY]), now_s);
    } else {
        if (c.behavior == a->ix_explore && !c.saw_cliff_or_obstacle) a->counts.explore_ok++;
        if ((x->tags & TAG_PLAY) && c.person >= 0 && a->person[c.person].present) {
            if (a->person[c.person].facing) play_done(a, c.person, now_s);
            else pend_add(a, PEND_PLAY, c.behavior, c.person, -1, now_s + PREF_RESPONSE_S);
        }
    }
    if (c.kind == RUN_REFLEX) return;
    if (c.person >= 0) pend_add(a, PEND_PREF, c.behavior, c.person, -1, now_s + PREF_RESPONSE_S);
    if (x->tags & TAG_ATTENTION) pend_add(a, PEND_ATTN, c.behavior, c.person, -1, now_s + NO_BOTHER_RESPONSE_S);
    if (c.kind == RUN_COMMAND && c.action >= 0) pend_add(a, PEND_TRAIN, c.behavior, c.person, c.action, now_s + TRAIN_RESPONSE_S);

    if (a->state == ST_PERFORMING) {
        a->state = ST_AWAKE;
        a->pause_until_s = now_s + pause_s(a);
        if (!interrupted && c.behavior == a->ix_go_rest) { a->state = ST_RESTING; a->resting_for_rest = 1; }
    }
}

int alma_select(alma_t *a, double now_s, alma_run_kind kind)
{
    int use_pref = alma_rng_u01(&a->rng) >= SEL_PREF_IGNORE_P;
    int idx[ALMA_MAX_BEHAVIORS], n = 0;
    float sc[ALMA_MAX_BEHAVIORS];
    for (int b = 0; b < a->cat->n; b++) {
        if (!alma_in_free_pool(a, b, now_s)) continue;
        float s = alma_score(a, b, use_pref);
        if (s > 0) { idx[n] = b; sc[n++] = s; }
    }
    /* TOP_K por selección parcial */
    for (int i = 0; i < n && i < SEL_TOP_K; i++)
        for (int j = i + 1; j < n; j++)
            if (sc[j] > sc[i]) { float t = sc[i]; sc[i] = sc[j]; sc[j] = t; int u = idx[i]; idx[i] = idx[j]; idx[j] = u; }
    if (n > SEL_TOP_K) n = SEL_TOP_K;

    if (n == 0 || sc[0] <= SEL_MIN_SCORE) {
        /* regla 6: bhv_blink_idle o bhv_look_around */
        int b = a->ix_blink;
        if (a->ix_look_around >= 0 && alma_rng_u01(&a->rng) < 0.5f && alma_score(a, a->ix_look_around, 0) > 0) b = a->ix_look_around;
        alma_start(a, b, RUN_FALLBACK, now_s, n ? sc[0] : 0, 0);
        return b;
    }
    float T = SEL_T_BASE + SEL_T_IMPULSIVITY * a->trait[TRAIT_IMPULSIVITY], w[SEL_TOP_K], tot = 0;
    for (int i = 0; i < n; i++) tot += w[i] = (float)pow(sc[i] / sc[0], 1.0 / T);
    float r = alma_rng_u01(&a->rng) * tot;
    int k = 0;
    while (k < n - 1 && r >= w[k]) r -= w[k++];
    int b = idx[k];
    alma_start(a, b, is_window(a, b) ? RUN_WINDOW : kind, now_s, sc[k], 0);
    return b;
}

/* ¿puede hacer un truco ahora? Despierta (o descansando), sin reflejo, sin escuchar y sin una conducta que no se corta */
int alma_trick_ready(const alma_t *a)
{
    return a->ix_trick >= 0 && a->state != ST_SLEEPING && a->state != ST_REFLEX && a->state != ST_LISTENING
           && a->state != ST_BOOT && !(a->cur.active && a->cur.hold >= 2);
}

void alma_force(alma_t *a, int b, double now_s)
{
    if (b < 0 || a->state == ST_REFLEX || (a->cur.active && a->cur.hold >= 2)) return;
    if (a->state == ST_LISTENING) return;   /* 04 "Escucha": solo un reflejo interrumpe bhv_listen */
    if (now_s - a->last_exec_t[b] < a->cat->b[b].cooldown_s) return;   /* 05: cooldown también en las forzadas */
    alma_start(a, b, RUN_FORCED, now_s, 0, 1);
}

/* Regla 2: otra conducta supera 1.5× el score que tenía la actual al elegirla */
void alma_hysteresis_check(alma_t *a, double now_s)
{
    if (!a->cur.active || a->cur.hold || a->state != ST_PERFORMING) return;
    if (now_s - a->cur.t_start < HYST_MIN_RUN_S) return;
    int best = -1;
    float bs = 0;
    for (int b = 0; b < a->cat->n; b++) {
        if (b == a->cur.behavior || !alma_in_free_pool(a, b, now_s)) continue;
        float s = alma_score(a, b, 1);
        if (s > bs) { bs = s; best = b; }
    }
    if (best >= 0 && bs > SEL_HYSTERESIS * a->cur.ref_score)
        alma_start(a, best, is_window(a, best) ? RUN_WINDOW : RUN_SELECTOR, now_s, bs, 0);
}

float alma_p_obey(const alma_t *a, int slot, int action, double now_s)
{
    float A = 0;
    if (slot >= 0) {
        A = a->person[slot].attachment;
        if (now_s < a->person[slot].wary_until_s) A *= OBEY_WARY_FACTOR;
    }
    float p = OBEY_BASE + OBEY_A * A + OBEY_MOOD * a->mood + OBEY_TRAINED * a->trained[action]
              - OBEY_REST * alma_need(a, NEED_REST) - OBEY_FEAR * a->emo_fear - OBEY_FRUST * a->emo_frustration;
    return alma_clampf(p, OBEY_MIN, OBEY_MAX);
}

void alma_command(alma_t *a, int action, int person_id, double now_s)
{
    if (action < 0 || action >= ACT_COUNT) return;
    int s = person_id >= 0 ? alma_slot_of(a, person_id) : alma_P(a);
    alma_add_stim(a, VOICE_CMD_STIM);
    alma_add_social(a, VOICE_CMD_SOCIAL);
    alma_pending_response(a, EV_VOICE_COMMAND, now_s);
    if (a->state == ST_REFLEX) return;
    if (a->state == ST_LISTENING) { alma_finish(a, now_s, 0); a->state = ST_AWAKE; }
    alma_emotions_at(a, now_s);
    int b = a->ix_action[action];
    int P = alma_P(a);
    /* deprimido (bienestar < WB_DEPRESSED): a veces no quiere jugar (dueño, 2026-10-30) */
    float w = a->wellbeing / WB_MAX;
    int sulky = b >= 0 && a->cat->b[b].category == CAT_PLAY && w < WB_DEPRESSED
                && alma_rng_u01(&a->rng) < WB_REFUSE_MAX * (WB_DEPRESSED - w) / (1.0f + WB_DEPRESSED);
    if (b >= 0 && !sulky && alma_rng_u01(&a->rng) < alma_p_obey(a, s, action, now_s) && command_reqs_ok(a, b, P, now_s)) {
        if (s >= 0) alma_attach(a, s, VOICE_CMD_W_OBEY);
        alma_start(a, b, RUN_COMMAND, now_s, 0, 2);
        a->cur.action = action;
    } else {
        alma_start(a, a->ix_refuse, RUN_FORCED, now_s, 0, 1);
    }
}

void alma_interest_tick(alma_t *a, float dt)
{
    float k = 1.0f - (float)pow(2.0, -dt / INTEREST_HALF_LIFE_S);   /* media vida 4 h */
    for (int b = 0; b < a->cat->n; b++) a->interest[b] += (1.0f - a->interest[b]) * k;
}

static void pend_resolve(alma_t *a, alma_pending *p, int responded, double now_s)
{
    switch (p->kind) {
    case PEND_PREF: {
        float *v = &a->person[p->person].pref[p->behavior];
        *v = alma_clampf(*v + (responded ? PREF_UP : -PREF_DOWN), -1, 1);
        break;
    }
    case PEND_PLAY:
        if (responded) play_done(a, p->person, now_s);
        else a->counts.play_ignored++, alma_brain_ignored(a, now_s);
        break;
    case PEND_ATTN:
        if (responded) a->attention_fails = 0;
        else if (alma_brain_ignored(a, now_s), ++a->attention_fails >= NO_BOTHER_FAILS) {
            a->attention_suppressed_until = now_s + NO_BOTHER_SUPPRESS_S;
            a->stim = alma_clampf(a->stim - NO_BOTHER_STIM_DROP, 0, 1);
            a->attention_fails = 0;
        }
        break;
    case PEND_TRAIN:
        if (responded) a->trained[p->action] += TRAIN_UP * (1.0f - a->trained[p->action]);
        break;
    case PEND_NONE:
        break;
    }
    p->kind = PEND_NONE;
}

void alma_pending_response(alma_t *a, alma_ev_type t, double now_s)
{
    int reward = t == EV_TOUCH_PET || t == EV_PRAISE;
    int attn = reward || t == EV_TOUCH_TAP || t == EV_VOICE_COMMAND || t == EV_REMOTE_COMMAND;
    for (int i = 0; i < ALMA_MAX_PENDING; i++) {
        alma_pending *p = &a->pend[i];
        if (p->kind == PEND_NONE) continue;
        if (p->kind == PEND_ATTN ? attn : reward) pend_resolve(a, p, 1, now_s);
    }
}

void alma_pending_tick(alma_t *a, double now_s)
{
    int P = alma_P(a);
    int facing = P >= 0 && a->person[P].facing;
    for (int i = 0; i < ALMA_MAX_PENDING; i++) {
        alma_pending *p = &a->pend[i];
        if (p->kind == PEND_NONE) continue;
        if (p->kind == PEND_ATTN && facing) pend_resolve(a, p, 1, now_s);         /* mirada de frente */
        else if (now_s >= p->deadline_s) pend_resolve(a, p, 0, now_s);
    }
}

/* ---- juegos de la app (PLAN-JUEGOS, dueño, 2026-10-31) ---- */

static const char *const GEV_ID[GEV_COUNT] = {"empieza", "buena_jugada", "mala_jugada", "gana_alma", "pierde_alma",
                                              "empate", "farol_descubierto"};

int alma_game_ev_of(const char *tipo)
{
    for (int i = 0; tipo && i < GEV_COUNT; i++)
        if (strcmp(tipo, GEV_ID[i]) == 0) return i;
    return -1;
}

/* Reacción con una conducta del catálogo, con su cooldown y la habituación de siempre; nunca en un reflejo, escuchando
   o dormida, y enferma no hace conductas de juego. */
static void game_react(alma_t *a, int b, double now_s)
{
    if (b < 0 || a->state == ST_REFLEX || a->state == ST_LISTENING || a->state == ST_SLEEPING) return;
    if (now_s - a->last_exec_t[b] < a->cat->b[b].cooldown_s || a->interest[b] < GAME_REACT_MIN_INTEREST) return;
    if (a->sick && a->cat->b[b].category == CAT_PLAY) return;
    alma_force(a, b, now_s);
}

void alma_game_event(alma_t *a, alma_game_ev e, double now_s)
{
    int owner = alma_slot_of(a, ALMA_OWNER_ID);
    switch (e) {
    case GEV_EMPIEZA:
        alma_add_joy(a, 0.1f, now_s);
        if (a->ix_wiggle >= 0) a->window_until[a->ix_wiggle] = now_s + RESPONSE_WINDOW_S;
        break;
    case GEV_BUENA:
        alma_add_joy(a, 0.15f, now_s);
        if (a->ix_wiggle >= 0) a->window_until[a->ix_wiggle] = now_s + RESPONSE_WINDOW_S;
        break;
    case GEV_MALA:
        alma_add_frust(a, 0.1f, now_s);
        break;
    case GEV_GANA:
        play_done(a, owner, now_s);   /* jugó con el dueño: juego, alegría y apego como en persona */
        alma_add_joy(a, GAME_JOY_WIN, now_s);
        game_react(a, a->ix_wiggle, now_s);
        break;
    case GEV_PIERDE:
        play_done(a, owner, now_s);
        alma_add_frust(a, GAME_FRUST_LOSE, now_s);
        game_react(a, a->ix_sulk, now_s);
        break;
    case GEV_EMPATE:
        play_done(a, owner, now_s);
        break;
    case GEV_FAROL:   /* la cacharon en un farol */
        alma_add_frust(a, 0.1f, now_s);
        game_react(a, a->ix_confused, now_s);
        break;
    default:
        break;
    }
}

/* ---- lo que vio de cerca (dueño, 2026-11-01): foto del K210 → Haiku → reacción ---- */

static const char *const VIS_ID[VIS_COUNT] = {"curiosa", "contenta", "asustada", "confundida", "indiferente"};

int alma_vision_ev_of(const char *reaccion)
{
    for (int i = 0; reaccion && i < VIS_COUNT; i++)
        if (strcmp(reaccion, VIS_ID[i]) == 0) return i;
    return -1;
}

/* Lo que Haiku puede pedir frente a un objeto: nada de reflejos, descanso ni órdenes (salvo hacer como que come o bebe),
   ni la conducta de enferma */
static int vision_allowed(const alma_t *a, int b)
{
    if (b < 0 || b >= a->cat->n || b == a->ix_sick) return 0;
    alma_category c = a->cat->b[b].category;
    if (c == CAT_REFLEX || c == CAT_REST) return 0;
    return c != CAT_COMMAND || b == a->ix_eat || b == a->ix_drink;
}

/* Un objeto nuevo visto sin miedo cuenta como novedad bien llevada (novel_ok: valentía en el pase nocturno). La
   reacción mueve el ánimo; la conducta es la que eligió Haiku (dueño, 2026-11-01) o, si no se puede, la de la reacción */
void alma_vision_event(alma_t *a, alma_vision_ev e, int behavior, double now_s)
{
    int b = -1;
    switch (e) {
    case VIS_CURIOSA:
        a->counts.novel_ok++;
        alma_add_joy(a, 0.05f, now_s);
        b = a->ix_inspect;
        break;
    case VIS_CONTENTA:
        a->counts.novel_ok++;
        alma_add_joy(a, 0.15f, now_s);
        b = a->ix_wiggle;
        break;
    case VIS_ASUSTADA:
        alma_add_fear(a, 0.15f, now_s);
        b = a->ix_startle;
        break;
    case VIS_CONFUNDIDA:
        b = a->ix_confused;
        break;
    default:
        break;
    }
    game_react(a, vision_allowed(a, behavior) ? behavior : b, now_s);
}
