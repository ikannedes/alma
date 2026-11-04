/* alma_core.c — inicialización, eventos y tick del núcleo (01, 04). */
#include <stdlib.h>
#include <string.h>
#include "alma_internal.h"

#define NEVER (-1e12)

int alma_find(const alma_catalog *cat, const char *id)
{
    for (int i = 0; i < cat->n; i++)
        if (strcmp(cat->b[i].id, id) == 0) return i;
    return -1;
}

static const struct { const char *name; alma_req_kind kind; int has_arg; } REQ_NAMES[] = {
    {"known_face_present", REQ_KNOWN_FACE_PRESENT, 0}, {"unknown_face_present", REQ_UNKNOWN_FACE_PRESENT, 0},
    {"face_facing", REQ_FACE_FACING, 0}, {"no_face", REQ_NO_FACE, 0}, {"on_charger", REQ_ON_CHARGER, 0},
    {"off_charger", REQ_OFF_CHARGER, 0}, {"relaxed_field", REQ_RELAXED_FIELD, 0}, {"battery>=", REQ_BATTERY_GE, 1},
    {"battery<=", REQ_BATTERY_LE, 1}, {"not_greeted_this_visit", REQ_NOT_GREETED_THIS_VISIT, 0},
    {"greet_intensity>=", REQ_GREET_INTENSITY_GE, 1}, {"not_wary_of_P", REQ_NOT_WARY_OF_P, 0},
    {"wary_of_P", REQ_WARY_OF_P, 0}, {"night_window", REQ_NIGHT_WINDOW, 0}, {"day_window", REQ_DAY_WINDOW, 0},
    {"has_home_station", REQ_HAS_HOME_STATION, 0}, {"hungry", REQ_HUNGRY, 0}, {"sick", REQ_SICK, 0},
};

/* Precondición de 05: "a", "battery>=30" o alternativas "a|b" */
int alma_req_parse(const char *s, alma_req *out)
{
    out->n_alt = 0;
    while (*s) {
        while (*s == ' ') s++;
        size_t len = strcspn(s, "|");
        while (len && s[len - 1] == ' ') len--;
        int found = 0;
        for (size_t i = 0; i < sizeof REQ_NAMES / sizeof REQ_NAMES[0]; i++) {
            size_t nl = strlen(REQ_NAMES[i].name);
            if (REQ_NAMES[i].has_arg ? (len > nl && strncmp(s, REQ_NAMES[i].name, nl) == 0)
                                     : (len == nl && strncmp(s, REQ_NAMES[i].name, nl) == 0)) {
                if (out->n_alt >= ALMA_MAX_ALT) return -1;
                out->kind[out->n_alt] = REQ_NAMES[i].kind;
                out->arg[out->n_alt++] = REQ_NAMES[i].has_arg ? strtof(s + nl, 0) : 0;
                found = 1;
                break;
            }
        }
        if (!found) return -1;
        s += strcspn(s, "|");
        if (*s == '|') s++;
    }
    return out->n_alt ? 0 : -1;
}

void alma_init(alma_t *a, const alma_catalog *cat, uint32_t seed, double now_s, alma_hooks hooks)
{
    memset(a, 0, sizeof *a);
    a->simple_mood = SM_CALM;   /* el 0 es SM_SCARED: un cuerpo recién creado (o sin Alma) no debe verse asustado */
    a->cat = cat;
    a->hooks = hooks;
    a->forget_enabled = 1;
    a->seed = seed;
    alma_rng_seed(&a->rng, seed);
    for (int k = 0; k < TRAIT_COUNT; k++) a->trait[k] = a->trait_base[k] = alma_rng_beta22(&a->rng);  /* 04: Beta(2,2) */
    a->hunger = 0.3f;
    a->care_energy = 1.0f;
    a->weight_band = WB_SANO;
    alma_food_prefs_init(a);

    a->fear_t = a->joy_t = a->frust_t = NEVER;
    for (int t = 0; t < EV_COUNT; t++) a->last_ev_t[t] = NEVER;
    a->stim = STIM_INIT;
    a->need_social = NEED_SOCIAL_INIT;
    a->stim_hi_need_since = -1;
    a->soc_pct = 100;
    a->awake_since_s = a->t_last = a->t_now = a->pause_until_s = now_s;
    a->last_stimulus_s = now_s;
    for (int b = 0; b < ALMA_MAX_BEHAVIORS; b++) { a->interest[b] = 1; a->last_exec_t[b] = NEVER; a->window_until[b] = NEVER; }
    a->unknown_seen_s = a->last_known_face_s = NEVER;
    a->last_fall_or_shake_s = a->last_cliff_s = a->last_lift_or_shake_s = NEVER;
    a->attention_suppressed_until = NEVER;
    a->lift_person = -1;
    for (int h = 0; h < 24; h++) a->home_presence_hist[h] = PRESENCE_INIT;
    a->night_start_h = NIGHT_WINDOW_DEFAULT_START;
    a->night_done_for_day = -1000000;
    a->has_home_station = 1;
    a->state = ST_AWAKE;   /* ST_BOOT → ST_AWAKE: K210 listo y estado restaurado (01) */

    a->ix_blink = alma_find(cat, "bhv_blink_idle");
    a->ix_look_around = alma_find(cat, "bhv_look_around");
    a->ix_startle = alma_find(cat, "bhv_startle");
    a->ix_confused = alma_find(cat, "bhv_confused");
    a->ix_refuse = alma_find(cat, "bhv_refuse");
    a->ix_listen = alma_find(cat, "bhv_listen");
    a->ix_reminder = alma_find(cat, "bhv_reminder");
    a->ix_trick = alma_find(cat, "bhv_trick");
    a->ix_eat = alma_find(cat, "bhv_eat");
    a->ix_drink = alma_find(cat, "bhv_drink");
    a->ix_ask_food = alma_find(cat, "bhv_ask_food");
    a->ix_sick = alma_find(cat, "bhv_sick");
    a->ix_activity = alma_find(cat, "bhv_activity");
    a->ix_routine = alma_find(cat, "bhv_routine");
    a->ix_sulk = alma_find(cat, "bhv_sulk");
    a->ix_stretch = alma_find(cat, "bhv_stretch");
    a->ix_enjoy_pet = alma_find(cat, "bhv_enjoy_pet");
    a->ix_inspect = alma_find(cat, "bhv_inspect_obstacle");
    a->ix_wiggle = alma_find(cat, "bhv_happy_wiggle");
    a->ix_reflex = alma_find(cat, "bhv_reflex_freeze");
    a->ix_ask_help = alma_find(cat, "bhv_ask_help");
    a->ix_struggle = alma_find(cat, "bhv_reflex_struggle");
    a->ix_goodbye = alma_find(cat, "bhv_goodbye");
    a->ix_dizzy = alma_find(cat, "bhv_dizzy");
    a->ix_sleep_cycle = alma_find(cat, "bhv_sleep_cycle");
    a->ix_explore = alma_find(cat, "bhv_explore");
    a->ix_go_rest = alma_find(cat, "bhv_go_rest");
    a->ix_greet = alma_find(cat, "bhv_greet");
    /* action_id → conducta (05, "Órdenes de voz") */
    static const char *ACT_BHV[ACT_COUNT] = {"bhv_come_here", "bhv_dance", "bhv_turn_around", "bhv_go_rest", "bhv_stretch",
                                             "bhv_follow_face", "bhv_play_bow", "bhv_stop", "bhv_greet", "bhv_go_home"};
    for (int i = 0; i < ACT_COUNT; i++) a->ix_action[i] = alma_find(cat, ACT_BHV[i]);
}

static void open_window(alma_t *a, int b, double now_s)
{
    if (b < 0) return;
    a->window_until[b] = now_s + RESPONSE_WINDOW_S;
    if (a->state == ST_AWAKE) alma_select(a, now_s, RUN_WINDOW);   /* libre: sorteo en ese instante */
    else if (a->state == ST_PERFORMING) a->next_hyst_s = now_s;     /* ocupada: regla 2 */
}

/* Caída provocada: EV_TIPPED_OVER o EV_CLIFF dentro de 10 s de EV_PICKED_UP/EV_SHAKEN (04, "Contadores") */
static void provoked_fall(alma_t *a, double now_s)
{
    if (now_s - a->last_lift_or_shake_s > FALL_PROVOKED_S || a->lift_person < 0) return;
    alma_attach_drop(a, a->lift_person, -ATTACH_FALL_DROP);
    alma_make_wary(a, a->lift_person, now_s);
}

void alma_event(alma_t *a, const alma_ev *ev, double now_s)
{
    a->t_now = now_s;
    int slot = ev->person_id >= 0 ? alma_slot_of(a, ev->person_id) : alma_P(a);
    int sleeping = a->state == ST_SLEEPING;
    switch (ev->type) {
    case EV_FACE_SEEN: {
        int s = alma_slot_of(a, ev->person_id);
        int was_present = s >= 0 && a->person[s].present;
        alma_face_seen(a, ev, now_s);
        s = alma_slot_of(a, ev->person_id);
        if (s < 0) break;
        if (sleeping) {
            /* despierta si A > 0.5 durante la última hora de la ventana (04) */
            int last_hour = (alma_hour(now_s) - NIGHT_WINDOW_DEFAULT_START + 24) % 24 == NIGHT_WINDOW_H - 1;
            if (last_hour && a->person[s].attachment > WAKE_FACE_A) alma_wake(a, now_s, 1);
        } else if (!was_present) {
            alma_stimulus(a, now_s);
        }
        break;
    }
    case EV_FACE_UNKNOWN: {
        int new_face = now_s - a->unknown_seen_s >= FACE_LOST_S;
        a->unknown_seen_s = now_s;
        if (new_face && alma_apply_event_table(a, EV_FACE_UNKNOWN, -1, now_s) && !a->unknown_pending) {
            a->unknown_pending = 1;
            a->unknown_scare_check_s = now_s + PREF_RESPONSE_S;
        }
        break;
    }
    case EV_FACE_LOST: {
        /* dueño, 2026-10-30: se despide (Byebye) de alguien conocido que se va, si estaba despierta y le tiene apego */
        int s = alma_slot_of(a, ev->person_id);
        int was = s >= 0 && a->person[s].present;
        alma_face_lost(a, ev->person_id);
        if (was && !sleeping && a->state != ST_REFLEX && a->person[s].attachment >= GOODBYE_MIN_A) alma_force(a, a->ix_goodbye, now_s);
        break;
    }
    case EV_WAKE_WORD:
        if (sleeping || a->state == ST_REFLEX) break;
        alma_stimulus(a, now_s);
        alma_force(a, a->ix_listen, now_s);
        if (a->cur.active && a->cur.behavior == a->ix_listen) { a->state = ST_LISTENING; a->listen_since_s = now_s; }
        break;
    case EV_REMINDER:
        /* una alarma que pidió el dueño: también dormida (la despierta); un reflejo o la escucha la posponen */
        alma_stimulus(a, now_s);
        if (a->state == ST_REFLEX || a->state == ST_LISTENING) a->reminder_pending = 1;
        else alma_force(a, a->ix_reminder, now_s);
        break;
    case EV_TRICK:
        /* el servidor ya decidió que obedece y qué hace; aquí solo si puede ahora (despierta, sin reflejo ni escucha) */
        if (alma_trick_ready(a) && ev->action_id >= 0 && ev->action_id < a->cat->b[a->ix_trick].n_opt) {
            alma_stimulus(a, now_s);
            alma_start_opt(a, a->ix_trick, RUN_FORCED, now_s, 0, 1, ev->action_id);
        }
        break;
    case EV_VOICE_COMMAND:
    case EV_REMOTE_COMMAND:   /* DERIVADO: la orden del celular pasa por la misma obediencia */
        if (!sleeping) alma_command(a, ev->action_id, ev->person_id, now_s);
        break;
    case EV_TOUCH_PET:
    case EV_TOUCH_TAP:
    case EV_PRAISE:
    case EV_SCOLD: {
        int eff = alma_apply_event_table(a, ev->type, slot, now_s);
        if (eff) {
            if (ev->type == EV_TOUCH_PET) a->counts.pets++;
            if (ev->type == EV_PRAISE) a->counts.praises++;
            if (ev->type == EV_SCOLD) a->counts.scolds++;
        }
        alma_pending_response(a, ev->type, now_s);
        if (sleeping) break;
        if (ev->type != EV_PRAISE && ev->type != EV_SCOLD) alma_stimulus(a, now_s);
        if (eff && ev->type == EV_TOUCH_PET) open_window(a, a->ix_enjoy_pet, now_s);
        if (eff && (ev->type == EV_TOUCH_PET || ev->type == EV_PRAISE)) open_window(a, a->ix_wiggle, now_s);
        break;
    }
    case EV_VOICE_FAILED:
        alma_apply_event_table(a, EV_VOICE_FAILED, -1, now_s);
        if (a->state == ST_LISTENING) { alma_finish(a, now_s, 0); a->state = ST_AWAKE; }
        if (!sleeping) alma_force(a, a->ix_confused, now_s);
        break;
    case EV_PICKED_UP:
        alma_apply_event_table(a, EV_PICKED_UP, -1, now_s);
        a->counts.lifts++;
        a->last_lift_or_shake_s = now_s;
        a->lift_person = slot;
        alma_reflex_enter(a, EV_PICKED_UP, now_s);
        break;
    case EV_SHAKEN:
        if (alma_apply_event_table(a, EV_SHAKEN, slot, now_s)) { a->counts.shakes++; a->counts.scares++; }
        if (slot >= 0) alma_make_wary(a, slot, now_s);   /* 04: −0.08 y timidez */
        a->last_lift_or_shake_s = a->last_fall_or_shake_s = now_s;
        a->lift_person = slot;
        alma_reflex_enter(a, EV_SHAKEN, now_s);
        break;
    case EV_TIPPED_OVER:
        if (alma_apply_event_table(a, EV_TIPPED_OVER, -1, now_s)) a->counts.scares++;
        a->last_fall_or_shake_s = now_s;
        provoked_fall(a, now_s);
        alma_reflex_enter(a, EV_TIPPED_OVER, now_s);
        break;
    case EV_CLIFF:
        if (alma_apply_event_table(a, EV_CLIFF, -1, now_s)) a->counts.scares++;
        a->last_cliff_s = a->last_fall_or_shake_s = now_s;
        if (a->cur.active) a->cur.saw_cliff_or_obstacle = 1;
        provoked_fall(a, now_s);
        alma_reflex_enter_cliff(a, (int)ev->value, now_s);
        break;
    case EV_PUT_DOWN:
        a->lifted = a->tipped = 0;
        if (a->state == ST_REFLEX) a->put_down_s = now_s;
        break;
    case EV_LOUD_SOUND:
        if (alma_apply_event_table(a, EV_LOUD_SOUND, -1, now_s)) a->counts.scares++;
        if (a->state == ST_REFLEX) break;
        if (sleeping) alma_wake(a, now_s, 0);
        alma_stimulus(a, now_s);
        alma_force(a, a->ix_startle, now_s);
        break;
    case EV_MUSIC:
    {   /* dueño, 2026-10-30: con música baila un rato y no otra vez en MUSIC_DANCE_GAP_S, aunque la canción dure 30 min.
           Ese plazo es aparte del cooldown de bhv_dance (20 min, el de bailar sola). El K210 manda 37 cada ~10 s; 2 = terminó */
        int d = a->ix_action[ACT_DANCE];
        if (sleeping || a->state == ST_REFLEX || a->state == ST_LISTENING || ev->x == 2 || d < 0) break;
        alma_stimulus(a, now_s);
        if (now_s - a->last_exec_t[d] < MUSIC_DANCE_GAP_S || (a->cur.active && a->cur.hold >= 2)) break;
        /* dueño: no baila "de la nada" si está con él (jugando, caricias, saludo, seguirlo, una rutina); solo aburrida,
           sin hacer nada, mirando, explorando o jugando sola */
        if (now_s - a->last_ev_t[EV_TOUCH_PET] < MUSIC_ENGAGED_S || now_s - a->last_ev_t[EV_TOUCH_TAP] < MUSIC_ENGAGED_S
            || now_s - a->last_ev_t[EV_PRAISE] < MUSIC_ENGAGED_S) break;
        if (a->cur.active) {
            const alma_behavior *c = &a->cat->b[a->cur.behavior];
            int free_now = c->category == CAT_IDLE || c->category == CAT_EXPLORE || strcmp(c->id, "bhv_play_solo") == 0
                           || a->simple_mood == SM_BORED;
            if (!free_now) break;
        }
        alma_start(a, d, RUN_FORCED, now_s, 0, 1);
        break;
    }
    case EV_OBSTACLE:
        alma_apply_event_table(a, EV_OBSTACLE, -1, now_s);
        if (a->cur.active) a->cur.saw_cliff_or_obstacle = 1;
        if (!sleeping) open_window(a, a->ix_inspect, now_s);
        break;
    case EV_BATTERY_LOW:
        a->soc_pct = ev->value;
        break;
    case EV_CHARGING_ON:
    case EV_CHARGING_OFF:
        a->on_charger = ev->type == EV_CHARGING_ON;
        if (a->on_charger && a->cur.active && a->cur.motion_played && !ALMA_DEV_MOTION_ON_USB) {   /* los servos paran; la cara sigue (04) */
            a->servo_active_s_today += (float)(now_s - a->cur.t_start);
            a->cur.motion_played = 0;
        }
        break;
    case EV_BEHAVIOR_DONE:
        if (a->cur.active && ev->behavior == a->cur.behavior) {
            int listening = a->state == ST_LISTENING;
            alma_finish(a, now_s, 0);
            if (listening) { a->state = ST_AWAKE; a->pause_until_s = now_s; }
        }
        break;
    case EV_BEHAVIOR_INTERRUPTED:
        if (a->cur.active && ev->behavior == a->cur.behavior) alma_finish(a, now_s, 1);
        break;
    case EV_COUNT:
        break;
    }
}

void alma_tick(alma_t *a, double now_s, const alma_sensors *s)
{
    float dt = (float)(now_s - a->t_last);
    if (dt < 0) dt = 0;
    a->t_last = a->t_now = now_s;
    if (s) { a->soc_pct = s->soc_pct; a->on_charger = s->on_charger; }

    alma_persons_tick(a, dt, now_s);
    alma_needs_tick(a, dt, now_s);
    if (a->care_enabled) alma_care_tick(a, dt, now_s);
    alma_exercise_tick(a, dt);
    alma_affect_tick(a, dt, now_s);
    alma_interest_tick(a, dt);
    alma_pending_tick(a, now_s);

    /* novel_ok / scares de EV_FACE_UNKNOWN (04, "Contadores") */
    if (a->unknown_pending) {
        if (a->simple_mood == SM_SCARED) a->unknown_pending = 2;
        if (now_s >= a->unknown_scare_check_s) {
            if (a->unknown_pending == 2) a->counts.scares++;
            else a->counts.novel_ok++;
            a->unknown_pending = 0;
        }
    }
    alma_state_tick(a, now_s);
}
