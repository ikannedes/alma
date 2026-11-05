/* alma_internal.h — funciones compartidas entre los módulos del núcleo. No es API pública. */
#ifndef ALMA_INTERNAL_H
#define ALMA_INTERNAL_H

#include "alma_core.h"
#include "alma_params.h"

static inline float alma_clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* alma_emotion.c: emociones, necesidades, afecto y ánimo */
void  alma_emotions_at(alma_t *a, double now_s);              /* actualiza emo_joy y emo_frustration */
void  alma_add_fear(alma_t *a, float d, double now_s);
void  alma_add_joy(alma_t *a, float d, double now_s);
void  alma_add_frust(alma_t *a, float d, double now_s);
void  alma_add_stim(alma_t *a, float d);
void  alma_add_social(alma_t *a, float d);
float alma_bold_eff(const alma_t *a);
float alma_presence_valence(const alma_t *a, double now_s);
int   alma_opt_in_hours(const alma_motion_opt *o, double now_s);
int   alma_apply_event_table(alma_t *a, alma_ev_type t, int slot, double now_s); /* 1 si tuvo efecto */
void  alma_needs_tick(alma_t *a, float dt, double now_s);
void  alma_affect_tick(alma_t *a, float dt, double now_s);

/* alma_bonds.c: apego por persona */
void  alma_attach(alma_t *a, int slot, float w);
void  alma_attach_drop(alma_t *a, int slot, float d);
void  alma_make_wary(alma_t *a, int slot, double now_s);
void  alma_face_seen(alma_t *a, const alma_ev *ev, double now_s);
void  alma_face_lost(alma_t *a, int person_id);
void  alma_persons_tick(alma_t *a, float dt, double now_s);
int   alma_any_known_present(const alma_t *a);

/* alma_select.c: habituación, utilidad, selección, órdenes */
int   alma_in_free_pool(const alma_t *a, int b, double now_s);
int   alma_select(alma_t *a, double now_s, alma_run_kind kind);  /* inicia una conducta; índice o −1 */
void  alma_start(alma_t *a, int b, alma_run_kind kind, double now_s, float ref_score, int hold);
void  alma_start_opt(alma_t *a, int b, alma_run_kind kind, double now_s, float ref_score, int hold, int forced_opt);
void  alma_finish(alma_t *a, double now_s, int interrupted);
void  alma_force(alma_t *a, int b, double now_s);
void  alma_command(alma_t *a, int action, int person_id, double now_s);
void  alma_hysteresis_check(alma_t *a, double now_s);
void  alma_interest_tick(alma_t *a, float dt);
void  alma_pending_response(alma_t *a, alma_ev_type t, double now_s);
void  alma_pending_tick(alma_t *a, double now_s);
int   alma_req_ok(const alma_t *a, const alma_req *r, int P, double now_s);
int   alma_relaxed_field(const alma_t *a, double now_s);
int   alma_eligible(const alma_t *a, int b, double now_s);     /* desbloqueo, cooldown, precondiciones, reglas 3 y 4 */

/* alma_brain.c: la red */
void  alma_brain_init(alma_t *a);
void  alma_brain_note_event(alma_t *a, alma_ev_type t, double now_s);
void  alma_brain_on_start(alma_t *a, int b, double now_s);
void  alma_brain_on_finish(alma_t *a, const alma_current *c, double now_s);
void  alma_brain_ignored(alma_t *a, double now_s);
void  alma_brain_poke(alma_t *a, double now_s, int event);     /* decide si toca (cada segundo) o si event = 1 */

/* alma_rhythm.c: estados, ritmo diario, reflejos */
int   alma_hour(double now_s);
int   alma_in_night_window(const alma_t *a, double now_s);
void  alma_state_tick(alma_t *a, double now_s);
void  alma_reflex_enter(alma_t *a, alma_ev_type t, double now_s);
void  alma_reflex_enter_cliff(alma_t *a, int where, double now_s);   /* EV_CLIFF: where = ALMA_CLIFF_* (alma_core.h) */
void  alma_wake(alma_t *a, double now_s, int full_wake);
void  alma_stimulus(alma_t *a, double now_s);                 /* despierta de ST_RESTING */

#endif
