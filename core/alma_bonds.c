/* alma_bonds.c — apego por persona y presencia de caras (04, "Apego por persona"). */
#include <math.h>
#include "alma_internal.h"

int alma_slot_of(const alma_t *a, int person_id)
{
    for (int i = 0; i < ALMA_MAX_PERSONS; i++)
        if (a->person[i].used && a->person[i].id == person_id) return i;
    return -1;
}

static int slot_new(alma_t *a, int person_id)
{
    for (int i = 0; i < ALMA_MAX_PERSONS; i++) {
        alma_person *p = &a->person[i];
        if (p->used) continue;
        *p = (alma_person){0};
        p->used = 1;
        p->id = person_id;
        p->first_seen_day = a->age_days;
        p->last_seen_s = -1e12;
        p->wary_until_s = -1e12;
        p->absence_s = 1e12;
        return i;
    }
    return -1;
}

int alma_any_known_present(const alma_t *a)
{
    for (int i = 0; i < ALMA_MAX_PERSONS; i++)
        if (a->person[i].used && a->person[i].present) return 1;
    return 0;
}

int alma_P(const alma_t *a)
{
    int best = -1;
    for (int i = 0; i < ALMA_MAX_PERSONS; i++) {
        const alma_person *p = &a->person[i];
        if (p->used && p->present && (best < 0 || p->face_w > a->person[best].face_w)) best = i;
    }
    return best;
}

/* A += K_ATTACH·(1 − A)·w·(0.5 + sociability); piso al pasar 0.5 */
void alma_attach(alma_t *a, int slot, float w)
{
    alma_person *p = &a->person[slot];
    p->attachment += K_ATTACH * powf(1.0f - p->attachment, 1.0f + ATTACH_GAMMA) * w * (ATTACH_SOC_BASE + a->trait[TRAIT_SOCIABILITY]);
    p->attachment = alma_clampf(p->attachment, 0, 1);
    if (p->attachment > ATTACH_FLOOR_TRIGGER) p->floor = ATTACH_FLOOR;
}

/* Bajadas absolutas; DERIVADO: nunca por debajo del piso */
void alma_attach_drop(alma_t *a, int slot, float d)
{
    alma_person *p = &a->person[slot];
    p->attachment = alma_clampf(p->attachment + d, p->floor, 1);
}

void alma_make_wary(alma_t *a, int slot, double now_s)
{
    a->person[slot].wary_until_s = now_s + 3600.0 * (WARY_BASE_H + WARY_BOLD_H * (1.0f - a->trait[TRAIT_BOLDNESS]));
}

void alma_face_seen(alma_t *a, const alma_ev *ev, double now_s)
{
    int s = alma_slot_of(a, ev->person_id);
    if (s < 0) s = slot_new(a, ev->person_id);
    if (s < 0) return;
    alma_person *p = &a->person[s];
    double gap = now_s - p->last_seen_s;
    if (!p->present && gap >= ARRIVAL_ABSENCE_S) {
        /* llegada tras ≥ 10 min de ausencia (04): joy +0.3·A, stim +0.1, need_social −0.15, w 0.2 */
        p->absence_s = gap;
        alma_add_joy(a, ARRIVAL_JOY_PER_A * p->attachment
                        * (JOY_SOCIAL_GAIN_BASE + JOY_SOCIAL_GAIN_SOC * a->trait[TRAIT_SOCIABILITY]), now_s);
        alma_add_stim(a, ARRIVAL_STIM);
        alma_add_social(a, ARRIVAL_SOCIAL);
        alma_attach(a, s, ARRIVAL_W);
    }
    if (gap >= VISIT_END_S) { p->greeted_this_visit = 0; a->visit_start_s[s] = now_s; }
    if (a->bye_slot == s) a->bye_slot = -1;   /* volvió a verlo: no se fue */
    p->present = 1;
    p->last_seen_s = now_s;
    p->face_w = ev->w;
    p->facing = ev->w >= FACING_MIN_W && (ev->x - FACING_X_CENTER < FACING_X_TOL && FACING_X_CENTER - ev->x < FACING_X_TOL);
    p->seen_today = 1;
}

void alma_face_lost(alma_t *a, int person_id)
{
    int s = alma_slot_of(a, person_id);
    if (s >= 0) a->person[s].present = a->person[s].facing = 0;
}

void alma_persons_tick(alma_t *a, float dt, double now_s)
{
    int any = 0;
    for (int i = 0; i < ALMA_MAX_PERSONS; i++) {
        alma_person *p = &a->person[i];
        if (!p->used || !p->present) continue;
        if (now_s - p->last_seen_s > FACE_LOST_S) { p->present = p->facing = 0; continue; }
        any = 1;
    }
    if (any) {
        a->last_known_face_s = now_s;
        a->hour_seen[alma_hour(now_s)] = 1;
    }
    /* persona conocida presente y de frente, por minuto (04) */
    int P = alma_P(a);
    if (P >= 0 && a->person[P].facing) {
        /* suma directa: no reinicia boredom, no es un estímulo nuevo */
        a->stim =alma_clampf(a->stim + FACING_STIM_PER_MIN * dt / 60.0f, 0, 1);
        alma_add_social(a, FACING_SOCIAL_PER_MIN * dt / 60.0f);
        alma_attach(a, P, FACING_W_PER_MIN * dt / 60.0f);
    }
}

/* sat(ausencia) y greet_intensity (04, "Saludo") */
float alma_greet_intensity(const alma_t *a, int slot, double now_s)
{
    (void)now_s;
    if (slot < 0) return 0;
    const alma_person *p = &a->person[slot];
    double t = p->absence_s;
    float sat;
    if (t < GREET_SAT_T0) sat = 0;
    else if (t < GREET_SAT_T1) sat = GREET_SAT_V0 + (GREET_SAT_V1 - GREET_SAT_V0) * (float)((t - GREET_SAT_T0) / (GREET_SAT_T1 - GREET_SAT_T0));
    else if (t < GREET_SAT_T2) sat = GREET_SAT_V1 + (1.0f - GREET_SAT_V1) * (float)((t - GREET_SAT_T1) / (GREET_SAT_T2 - GREET_SAT_T1));
    else sat = 1.0f;
    return sat * (GREET_A_BASE + GREET_A_W * p->attachment) * (GREET_SOC_BASE + GREET_SOC_W * a->trait[TRAIT_SOCIABILITY]);
}
