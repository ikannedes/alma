/* alma_core.h — núcleo de personalidad de Alma (04), C11 portable.
 *
 * Sin encabezados de ESP-IDF ni memoria dinámica. El llamador da el reloj (segundos en
 * hora local), los eventos EV_* (01) y las lecturas de batería, y recibe decisiones por
 * los ganchos de alma_hooks. Mismo código en el ESP32 y en sim/.
 */
#ifndef ALMA_CORE_H
#define ALMA_CORE_H

#include <stdint.h>

#define ALMA_MAX_BEHAVIORS   48
#define ALMA_MAX_PERSONS     10   /* límite del reconocimiento del K210 (04) */
#define ALMA_MAX_OPTIONS     32   /* 24 → 32 (2026-10-30): bhv_play_solo con los juegos del original llegó a 26 */
#define ALMA_MAX_CHAIN       4
#define ALMA_MAX_REQ         8
#define ALMA_MAX_ALT         3
#define ALMA_ID_LEN          32
#define ALMA_MOT_LEN         40
#define ALMA_RECENT          16   /* conductas recientes para boredom */

/* Eventos (01, "Bus de eventos") */
typedef enum {
    EV_FACE_SEEN, EV_FACE_UNKNOWN, EV_FACE_LOST, EV_WAKE_WORD, EV_VOICE_COMMAND,
    EV_PRAISE, EV_SCOLD, EV_VOICE_FAILED, EV_REMOTE_COMMAND, EV_TOUCH_TAP, EV_TOUCH_PET,
    EV_PICKED_UP, EV_PUT_DOWN, EV_SHAKEN, EV_TIPPED_OVER, EV_CLIFF, EV_OBSTACLE,
    EV_LOUD_SOUND, EV_BATTERY_LOW, EV_CHARGING_ON, EV_CHARGING_OFF, EV_BEHAVIOR_DONE,
    EV_BEHAVIOR_INTERRUPTED,
    EV_MUSIC,                  /* K210 37 (d0 en x: 100 oigo, 1 sigue, 2 terminó); dueño, 2026-10-30: que baile */
    EV_REMINDER,               /* alarma del dueño (07, servidor; dueño, 2026-10-30): bhv_reminder forzada */
    EV_TRICK,                  /* truco que pide el servidor (dueño, 2026-11-01): bhv_trick, opción = action_id */
    EV_COUNT
} alma_ev_type;

typedef struct {
    alma_ev_type type;
    int person_id;      /* EV_FACE_SEEN, EV_FACE_LOST, EV_PRAISE, EV_SCOLD, EV_VOICE_COMMAND; −1 si no aplica */
    int action_id;      /* alma_action, órdenes */
    int behavior;       /* índice en el catálogo: EV_BEHAVIOR_DONE */
    float x, y, w;      /* caras: posición y tamaño en píxeles (320×240) */
    float value;        /* intensity, soc_pct, distance_mm, duration_ms según el evento */
} alma_ev;

/* EV_CLIFF: value = dónde está el borde (reglas del dueño, 2026-10-29 y 2026-10-30). El reflejo se aleja de él:
   adelante → camina hacia atrás; atrás → camina hacia adelante; un pie entero en el aire (sus dos sensores sin piso, el
   otro con piso) → se mueve de lado hacia el pie apoyado; adelante y atrás a la vez → quieto. 0 = sin dato (adelante). */
#define ALMA_CLIFF_FRONT  1
#define ALMA_CLIFF_REAR   2
#define ALMA_CLIFF_BOTH   3
#define ALMA_CLIFF_FOOT_L 4   /* el pie izquierdo en el aire */
#define ALMA_CLIFF_FOOT_R 5   /* el pie derecho en el aire */

/* Órdenes: enum de action_id (05 y 07) */
typedef enum {
    ACT_COME, ACT_DANCE, ACT_TURN_AROUND, ACT_SLEEP, ACT_WAKE_UP, ACT_LOOK_AT_ME,
    ACT_PLAY, ACT_STOP, ACT_GREET, ACT_GO_HOME, ACT_COUNT
} alma_action;

/* Estados de alto nivel (01) */
typedef enum {
    ST_BOOT, ST_AWAKE, ST_PERFORMING, ST_RESTING, ST_SLEEPING, ST_LISTENING, ST_REFLEX
} alma_state_id;

typedef enum {
    SM_SCARED, SM_SLEEPY, SM_GRUMPY, SM_BORED, SM_PLAYFUL, SM_HAPPY, SM_CALM, SM_COUNT
} alma_simple_mood;

enum { NEED_SOCIAL, NEED_STIMULATION, NEED_REST, NEED_BOREDOM, NEED_COUNT };
enum { TRAIT_BOLDNESS, TRAIT_ENERGY, TRAIT_SOCIABILITY, TRAIT_PLAYFULNESS, TRAIT_IMPULSIVITY, TRAIT_COUNT };

typedef enum { CAT_IDLE, CAT_REST, CAT_SOCIAL, CAT_PLAY, CAT_EXPLORE, CAT_EMOTION, CAT_COMMAND, CAT_REFLEX } alma_category;
enum { TAG_ATTENTION = 1, TAG_PLAY = 2, TAG_LOCOMOTION = 4 };

/* Precondiciones (05, lista cerrada) */
typedef enum {
    REQ_KNOWN_FACE_PRESENT, REQ_UNKNOWN_FACE_PRESENT, REQ_FACE_FACING, REQ_NO_FACE,
    REQ_ON_CHARGER, REQ_OFF_CHARGER, REQ_RELAXED_FIELD, REQ_BATTERY_GE, REQ_BATTERY_LE,
    REQ_NOT_GREETED_THIS_VISIT, REQ_GREET_INTENSITY_GE, REQ_NOT_WARY_OF_P, REQ_WARY_OF_P,
    REQ_NIGHT_WINDOW, REQ_DAY_WINDOW, REQ_HAS_HOME_STATION,
    REQ_HUNGRY, REQ_SICK         /* tamagotchi (dueño, 2026-10-30) */
} alma_req_kind;

/* Comida real que el dueño le da desde la app (tamagotchi; dueño, 2026-10-30). Ids de la app: alma_food_id. */
typedef enum {
    FOOD_MANZANA, FOOD_PLATANO, FOOD_ZANAHORIA, FOOD_BROCOLI, FOOD_PIZZA, FOOD_HAMBURGUESA, FOOD_TACOS, FOOD_SUSHI,
    FOOD_SOPA, FOOD_GALLETA, FOOD_HELADO, FOOD_PASTEL, FOOD_LECHE, FOOD_JUGO, FOOD_TE, FOOD_MEDICINA, FOOD_COUNT
} alma_food;
/* Por qué aceptó o rechazó */
typedef enum { FEED_OK, FEED_LOVED, FEED_FULL, FEED_DISLIKE, FEED_SAME, FEED_TANTRUM, FEED_NOT_SICK, FEED_MEDICINE,
               FEED_BUSY, FEED_WHY_COUNT } alma_feed_why;
typedef struct { int accepted; alma_feed_why why; float like; int got_sick; } alma_feed_result;
/* Plan v2 (dueño, 2026-10-31): la comida, el peso y la salud los lleva el servidor (care.py); el robot los vive */
typedef enum { SICK_NONE, SICK_EMPACHO, SICK_SOBREPESO, SICK_DEBIL, SICK_RESFRIADO } alma_sick_cause;   /* resfriado: de días, lo decide Haiku */
typedef enum { WB_BAJO, WB_SANO, WB_SOBREPESO, WB_OBESIDAD } alma_weight_band;
/* Ejercicio que el robot le cuenta al servidor (segundos con movimiento de verdad, por tipo) */
typedef enum { EX_DANCE, EX_ACTIVITY, EX_ROUTINE, EX_PLAY, EX_EXPLORE, EX_COUNT } alma_exercise;
/* Juegos de la app contra Alma (PLAN-JUEGOS, 2026-10-31): lo que pasa en la partida, por el enlace (game_event) */
typedef enum { GEV_EMPIEZA, GEV_BUENA, GEV_MALA, GEV_GANA, GEV_PIERDE, GEV_EMPATE, GEV_FAROL, GEV_COUNT } alma_game_ev;
/* Lo que vio de cerca (dueño, 2026-11-01): Haiku mira la foto y elige cómo reacciona */
typedef enum { VIS_CURIOSA, VIS_CONTENTA, VIS_ASUSTADA, VIS_CONFUNDIDA, VIS_INDIFERENTE, VIS_COUNT } alma_vision_ev;

typedef struct {               /* un elemento de "requires": alternativas unidas por O */
    int n_alt;
    alma_req_kind kind[ALMA_MAX_ALT];
    float arg[ALMA_MAX_ALT];
} alma_req;

typedef struct {               /* una opción de motion.options: un .mot o una cadena */
    char mot[ALMA_MAX_CHAIN][ALMA_MOT_LEN];
    int n;
    float dur_s;               /* suma de duraciones nominales (validador) */
    int gait;                  /* 1 = algún .mot tiene cuadros de paso/giro (†) */
    int hhmm0, hhmm1;          /* "option_hours" (dueño, 2026-10-30): solo entre estas horas locales (HHMM); −1 = siempre */
} alma_motion_opt;

typedef struct {
    char id[ALMA_ID_LEN];
    alma_category category;
    unsigned tags;
    float base;
    float need_w[NEED_COUNT];
    float mood_fit[SM_COUNT];
    float trait_w[TRAIT_COUNT];
    alma_req req[ALMA_MAX_REQ];
    int n_req;
    float cooldown_s;
    int unlock_day;
    alma_motion_opt opt[ALMA_MAX_OPTIONS];
    int n_opt;                 /* 0 = la conducta no tiene .mot */
    float servo_cost_s;        /* calculado por el validador (05) */
    float dur_min_s, dur_max_s;/* duration_ms, solo para conductas sin .mot (05) */
} alma_behavior;

typedef struct {
    alma_behavior b[ALMA_MAX_BEHAVIORS];
    int n;
} alma_catalog;

/* Cómo se disparó una ejecución (05, "Cómo se disparan") */
typedef enum { RUN_SELECTOR, RUN_WINDOW, RUN_FORCED, RUN_COMMAND, RUN_FALLBACK, RUN_REFLEX } alma_run_kind;

typedef struct {
    int behavior;
    alma_run_kind kind;
    int option;                /* −1 = sin movimiento */
    int motion_null_reason;    /* 0 = con movimiento o sin .mot, 1 = regla †, 2 = presupuesto, 3 = cargando */
    double t_start;
    float planned_s;
    int person;                /* slot de P o −1 */
    float tempo;               /* 1 = paso nominal; < 1 = corre (solo la marcha, RUN_TEMPO) */
} alma_exec_info;

typedef struct {
    int pets, praises, scolds, shakes, play_done, play_ignored, scares, novel_ok, explore_ok;
    int behaviors[ALMA_MAX_BEHAVIORS];
    int lifts;                 /* EV_PICKED_UP del día (bienestar, dueño 2026-10-30) */
    /* tamagotchi y juegos a distancia (dueño, 2026-10-30), 5 int contiguos: */
    int meals, treats, refused;/* comidas aceptadas, golosinas aceptadas, rechazos */
    int starve_min;            /* minutos con hambre extrema */
    int remote_play_s;         /* segundos jugando con Alma desde la app (los cuenta el servidor) */
} alma_counters;

typedef struct {               /* resumen del pase nocturno (06, "Resumen diario") */
    int age_days;
    float traits[TRAIT_COUNT];
    float mood_end;
    alma_counters counts;
    float attachment[ALMA_MAX_PERSONS];
    float servo_active_s;
    float wellbeing;           /* bienestar ya con los puntos de hoy (04, "Bienestar") */
    int day_points, absent_days;
} alma_day_summary;

struct alma_brain_decision;     /* alma_brain.c, más abajo */

typedef struct {
    void (*on_exec)(void *user, const alma_exec_info *e);
    void (*on_night)(void *user, const alma_day_summary *s);
    void *user;
    /* 06 (dueño, 2026-10-30): la persona person_id no se vio en FORGET_DAYS y su lugar ya se liberó; el HAL borra la
       cara del K210. Va al final para que {on_exec, on_night, user} siga valiendo. */
    void (*on_forget)(void *user, int person_id);
    void (*on_brain)(void *user, const struct alma_brain_decision *d);   /* la red eligió algo (alma_brain.c) */
} alma_hooks;

typedef struct {               /* lecturas que el HAL da en cada tick */
    float soc_pct;
    int on_charger;
} alma_sensors;

typedef struct {
    int used, id;
    int present, facing;
    float face_w;
    double last_seen_s;
    double absence_s;          /* ausencia antes de la visita actual (saludo, 04) */
    float attachment, floor;
    int first_seen_day;
    double wary_until_s;
    float pref[ALMA_MAX_BEHAVIORS];
    int greeted_this_visit;
    int seen_today;
} alma_person;

typedef struct {               /* conducta en curso */
    int active, behavior, option, person, action;
    int hold;                  /* 0 = normal, 1 = forzada (no la corta la regla 2), 2 = orden obedecida (histéresis máxima) */
    alma_run_kind kind;
    double t_start;
    float planned_s, ref_score;
    int motion_played, saw_cliff_or_obstacle;
} alma_current;

typedef enum { PEND_NONE, PEND_PREF, PEND_PLAY, PEND_ATTN, PEND_TRAIN } alma_pending_kind;

typedef struct {               /* respuesta esperada tras una ejecución (pref, juego, entrenamiento, regla 3) */
    alma_pending_kind kind;
    int behavior, person, action;
    double deadline_s;
} alma_pending;

#define ALMA_MAX_PENDING 12

typedef struct {
    uint64_t s[2];
} alma_rng;

/* ---- la red que decide (alma_brain.c; dueño, 2026-11-04) ----
 * Si hay política, elige la conducta cada segundo y en cada evento en lugar de alma_select, la pausa y la regla 2.
 * Entradas: ALMA_BRAIN_IN números de alma_brain_features; salidas: ALMA_BRAIN_OUT (0 = seguir, el resto conductas). */
#define ALMA_BRAIN_IN           72
#define ALMA_BRAIN_OUT          30
#define ALMA_BRAIN_FEAT_VERSION 2   /* 2: + eventos de este segundo (crítica de la red v2) */
enum { BFAM_IDLE, BFAM_REST, BFAM_SOCIAL, BFAM_PLAY, BFAM_EXPLORE, BFAM_EMOTION, BFAM_OTHER, BFAM_COUNT };
/* Índices de las entradas (alma_brain_features las llena en este orden) */
enum {
    BF_ENERGY, BF_NEED_SOCIAL, BF_NEED_STIM, BF_BOREDOM, BF_MOOD0, BF_VALENCE = BF_MOOD0 + 7, BF_AROUSAL, BF_MOOD, BF_FEAR,
    BF_JOY, BF_FRUST, BF_HOUR_SIN, BF_HOUR_COS, BF_NIGHT, BF_PRESENT, BF_FACING, BF_UNKNOWN, BF_WARY, BF_ALONE, BF_GREET,
    BF_GREETED, BF_PET, BF_PRAISE, BF_SCOLD, BF_CMD, BF_IGNORED, BF_ASKED, BF_OWNER_CONTACT, BF_SCOLD_ACC, BF_PET_ACC,
    BF_INSIST, BF_ARRIVED, BF_FAM0, BF_ACTIVE = BF_FAM0 + BFAM_COUNT, BF_T_CUR, BF_T_IDLE, BF_FAMREC0,
    BF_PLAY_TODAY = BF_FAMREC0 + BFAM_COUNT, BF_ON_CHARGER, BF_SOC, BF_RELAXED, BF_SICK, BF_HUNGER, BF_K_SOCIAL,
    BF_K_INDEP, BF_K_PLAY, BF_K_IMPULSIVE, BF_K_BOLD, BF_K_ENERGY, BF_WELLBEING, BF_NOW_PET, BF_NOW_SCOLD, BF_NOW_PRAISE,
    BF_NOW_ARRIVED, BF_COUNT
};

/* p: probabilidades de las ALMA_BRAIN_OUT salidas, ya con la máscara (las prohibidas en 0). 0 = ok */
typedef int (*alma_policy_fn)(void *user, const float *x, const unsigned char *mask, float *p);

typedef struct {               /* memoria corta que la red ve como entradas (no se guarda) */
    double ask_t, ignored_t, owner_contact_t, arrive_t, cur_since_s, idle_since_s, next_s;
    double fam_t[BFAM_COUNT];
    float scold_acc, pet_acc, insist_acc;
    double acc_t;
    int last_fam, last_b, play_day;
    float play_s_today;        /* juego intenso del día (s) */
} alma_brain_mem;

typedef struct alma_brain_decision {   /* una decisión que no fue "seguir", para el registro */
    int out, behavior;
    int top[3];
    float top_p[3];
    const float *x;            /* ALMA_BRAIN_IN entradas (ajuste fino en la PC) */
    int event;                 /* 1 = la pidió un evento, 0 = el segundo */
} alma_brain_decision;

typedef struct {
    const alma_catalog *cat;
    alma_hooks hooks;
    /* tamagotchi (dueño, 2026-10-30) */
    int care_enabled;          /* el HAL lo prende si se le puede dar de comer (enlace con el servidor); no se guarda */
    float hunger;              /* 0 llena … 1 muerta de hambre; sube con el tiempo */
    int sick;                  /* empacho: se cura con medicina o solo en SICK_CURE_S */
    double sick_since_s;
    float food_like[FOOD_COUNT];   /* gustos de nacimiento (−1 … 1), cambian poco a poco */
    int last_food, same_food_streak;
    double starve_acc_s;
    int ix_eat, ix_drink, ix_ask_food, ix_sick, ix_activity, ix_routine, ix_sulk;
    /* plan v2: con el servidor al mando (care_remote) el robot no calcula hambre ni enfermedad, aplica lo que le
       mandan; hunger y sick siguen guardándose como antes. Lo demás no se guarda: tras reiniciar sin enlace queda
       sano de peso y con energía 1 hasta que el servidor vuelva a hablar. */
    int care_remote;
    alma_sick_cause sick_cause;
    alma_weight_band weight_band;
    float care_energy;         /* 0.2 … 1.2: cuánto se mueve (baila, juega, explora) y cuánto descansa */
    float ex_s[EX_COUNT];      /* desde que arrancó; el servidor saca la diferencia */
    int reminder_pending;      /* alarma que llegó en un reflejo o escuchando: suena al terminar (no se guarda) */
    int ix_trick;              /* bhv_trick: el servidor decide qué movimiento (tricks.py); solo forzada */
    int forget_enabled;        /* 1 por omisión; el HAL lo apaga si el reloj no es real (sin SNTP), no se guarda */
    alma_rng rng;
    uint32_t seed;
    int has_home_station;

    /* rasgos (04, "Plasticidad"): trait = clamp(trait_base + trait_learned, 0, 1).
     * trait_base es fijo desde el nacimiento; solo trait_learned cambia, con tope ±TRAIT_LEARNED_MAX. */
    float trait[TRAIT_COUNT], trait_base[TRAIT_COUNT], trait_learned[TRAIT_COUNT];
    float night_delta[TRAIT_COUNT], night_maxd[TRAIT_COUNT];   /* último pase nocturno, para los nudges de 07 */
    /* emociones: valor de partida y hora del último estímulo */
    float emo_fear, joy_peak, frust_peak;
    double fear_t, joy_t, frust_t;
    float emo_joy, emo_frustration;
    double last_ev_t[EV_COUNT];
    /* necesidades, afecto, ánimo */
    float stim, need_social, boredom;
    double stim_hi_need_since;
    float affect_valence, affect_arousal, mood;
    /* bienestar de largo plazo (04, "Bienestar"; dueño, 2026-10-30): [−WB_MAX, WB_MAX], 0 al nacer */
    float wellbeing, wb_base;   /* wb_base: el de anoche ya con la deriva, para rehacer la suma con el ajuste de Haiku */
    int wb_day_points, wb_day_adjust, absent_days;
    alma_simple_mood simple_mood;
    float soc_pct;
    int on_charger;
    double awake_since_s;
    float servo_active_s_today;
    /* aprendizaje */
    float interest[ALMA_MAX_BEHAVIORS];
    float trained[ACT_COUNT];
    double last_exec_t[ALMA_MAX_BEHAVIORS];
    int recent[ALMA_RECENT];
    double recent_t[ALMA_RECENT];
    int n_recent;
    /* personas */
    alma_person person[ALMA_MAX_PERSONS];
    double unknown_seen_s, unknown_scare_check_s;
    int unknown_pending;
    double last_known_face_s;
    /* ritmo */
    float home_presence_hist[24];
    int hour_seen[24];
    int night_start_h;     /* fijo en NIGHT_WINDOW_DEFAULT_START (2026-11-01); se guarda por compatibilidad con 06 */
    int age_days;
    int night_done_for_day;
    double sleep_cycle_t;
    /* estado */
    alma_state_id state;
    double t_last, t_now, pause_until_s, last_stimulus_s, listen_since_s;
    int resting_for_rest;
    int sleep_here;        /* de noche no pudo llegar a la base: duerme donde está (dueño, 2026-11-01) */
    alma_current cur;
    alma_pending pend[ALMA_MAX_PENDING];
    double next_hyst_s;
    double window_until[ALMA_MAX_BEHAVIORS];
    /* regla 3 "no molestar" */
    int attention_fails;
    double attention_suppressed_until;
    /* reflejo */
    double reflex_last_s, put_down_s, last_fall_or_shake_s, last_cliff_s, last_lift_or_shake_s;
    int reflex_put_down, lifted, tipped, lift_person, shaken_pending;
    /* índices fijos del catálogo */
    int ix_blink, ix_look_around, ix_startle, ix_confused, ix_refuse, ix_listen, ix_reminder, ix_stretch,
        ix_enjoy_pet, ix_inspect, ix_wiggle, ix_reflex, ix_ask_help, ix_struggle, ix_sleep_cycle,
        ix_explore, ix_go_rest, ix_greet, ix_goodbye, ix_dizzy;
    int ix_action[ACT_COUNT];
    alma_counters counts;
    /* la red (alma_brain.c): sin política, todo sigue como antes */
    alma_policy_fn policy;
    void *policy_user;
    float independence;        /* perilla de carácter nueva (0–1); la mueve Haiku de noche */
    int ix_brain[ALMA_BRAIN_OUT];
    alma_brain_mem bm;
    /* despedida (dueño, 2026-11-05): solo si de verdad se fue; no se guarda */
    double visit_start_s[ALMA_MAX_PERSONS], bye_due_s;
    int bye_slot;
} alma_t;

/* API */
int  alma_req_parse(const char *s, alma_req *out);           /* 0 = ok */
void alma_init(alma_t *a, const alma_catalog *cat, uint32_t seed, double now_s, alma_hooks hooks);
void alma_event(alma_t *a, const alma_ev *ev, double now_s);
void alma_tick(alma_t *a, double now_s, const alma_sensors *s);
int  alma_find(const alma_catalog *cat, const char *id);     /* índice o −1 */

/* Consultas (también usadas por las pruebas) */
float alma_need(const alma_t *a, int need);
float alma_budget_s(const alma_t *a);
float alma_score(alma_t *a, int b, int use_pref);
float alma_greet_intensity(const alma_t *a, int slot, double now_s);
float alma_p_obey(const alma_t *a, int slot, int action, double now_s);
int   alma_slot_of(const alma_t *a, int person_id);
int   alma_P(const alma_t *a);                               /* slot de la persona con cara más grande o −1 */
void  alma_night_cycle(alma_t *a, double now_s);
/* trait_nudges del pase nocturno en la nube (07): se aplican después de alma_night_cycle */
void  alma_trait_nudges(alma_t *a, const float nudges[TRAIT_COUNT]);
/* wellbeing_adjust del pase nocturno en la nube (07): Haiku mueve los puntos del día ±WB_CLOUD_ADJ_MAX, sin salir de
 * ±WB_DAY_MAX. Se aplica después de alma_night_cycle; otra llamada la misma noche reemplaza la anterior. */
void  alma_wellbeing_adjust(alma_t *a, int adjust);
/* 06: libera a quien no se ve en FORGET_DAYS (nunca a ALMA_OWNER_ID) y llama hooks.on_forget. Lo llama el pase
   nocturno; devuelve cuántas personas olvidó. */
int   alma_forget_unseen(alma_t *a, double now_s);
/* Tamagotchi (alma_care.c): el dueño le ofrece comida; ella decide y, si acepta, come (bhv_eat / bhv_drink). */
const char *alma_food_id(int food);           /* "manzana" … */
int   alma_food_of(const char *id);           /* −1 si no existe */
const char *alma_feed_why_id(alma_feed_why w);/* "ok", "le_encanta", "llena", … */
alma_feed_result alma_feed(alma_t *a, int food, double now_s);
void  alma_food_prefs_init(alma_t *a);         /* gustos de nacimiento desde la semilla (si están en cero) */
void  alma_care_tick(alma_t *a, float dt, double now_s);
/* Plan v2: lo que manda el servidor ({"t":"care_state"} y {"t":"care_feed"}) */
void  alma_care_apply_state(alma_t *a, float hunger, alma_sick_cause cause, alma_weight_band band, float energy,
                            double now_s);
void  alma_care_apply_feed(alma_t *a, int food, int accepted, float joy, float bond, float frust, double now_s);
void  alma_exercise_tick(alma_t *a, float dt);
const char *alma_exercise_id(int k);           /* "dance", "activity", … (los del servidor) */
/* Juegos de la app: reacciones con conductas del catálogo (cooldown y habituación normales); ganar, perder o
   empatar cuenta como jugar con el dueño (play_done). −1 si el tipo no existe. */
int   alma_in_night_window(const alma_t *a, double now_s);   /* su ventana de noche (04, "Ritmo"): 20:00 a 8:00 */
/* de noche no llegó a la base (o no la tiene): que duerma donde está hasta la mañana */
void  alma_sleep_here(alma_t *a);
int   alma_trick_ready(const alma_t *a);   /* trucos (2026-11-01): despierta, sin reflejo ni escucha */
int   alma_game_ev_of(const char *tipo);         /* "empieza", "buena_jugada", … */
void  alma_game_event(alma_t *a, alma_game_ev e, double now_s);
int   alma_vision_ev_of(const char *reaccion);   /* "curiosa", "contenta", … o −1 */
/* behavior: la conducta que eligió Haiku (índice del catálogo) o −1; si no se puede hacer, la de la reacción */
void  alma_vision_event(alma_t *a, alma_vision_ev e, int behavior, double now_s);
float alma_remote_play_points(int seconds);    /* puntos del día por jugar desde la app (curva aprobada) */
/* Puntos locales del día con los contadores actuales, antes del pase (04, "Bienestar") */
int   alma_wellbeing_day_points(const alma_t *a, int *absent_days_out);
/* Un paso del bienestar: base + puntos, ponderados por la distancia a 0 (04, "Bienestar") */
float alma_wellbeing_step(float base, float points);
/* bloque identity (06): base y learned se guardan por separado */
void  alma_traits_export(const alma_t *a, float base[TRAIT_COUNT], float learned[TRAIT_COUNT]);
void  alma_traits_import(alma_t *a, const float base[TRAIT_COUNT], const float learned[TRAIT_COUNT]);

/* La red (alma_brain.c). alma_brain_set_policy(a, NULL, NULL) vuelve a la fórmula. */
extern const char *const ALMA_BRAIN_OUT_ID[ALMA_BRAIN_OUT];
void  alma_brain_set_policy(alma_t *a, alma_policy_fn fn, void *user);
void  alma_brain_features(const alma_t *a, double now_s, float x[ALMA_BRAIN_IN]);
void  alma_brain_mask(const alma_t *a, double now_s, unsigned char mask[ALMA_BRAIN_OUT]);
int   alma_brain_family(const alma_t *a, int b);                 /* BFAM_* de una conducta del catálogo */

/* MLP de la red: pesos en un bloque "ALMB" (tools/brain/train.py). El bloque debe vivir mientras se use y estar
   alineado a 4 bytes. 0 = ok; −1 formato, −2 versión de entradas, −3 tamaños, −4 salidas, −5 CRC */
typedef struct {
    int n_in, h1, h2, n_out;
    uint32_t model_version;
    const float *mu, *sd, *w1, *b1, *w2, *b2, *w3, *b3;
} alma_mlp;
int   alma_mlp_load(alma_mlp *m, const void *blob, uint32_t size);
int   alma_mlp_policy(void *mlp, const float *x, const unsigned char *mask, float *p);   /* alma_policy_fn */
uint32_t alma_brain_crc32(const void *p, uint32_t n);

/* RNG portable (xoroshiro128+) y Beta(2,2) como mediana de 3 uniformes */
void  alma_rng_seed(alma_rng *r, uint64_t seed);
float alma_rng_u01(alma_rng *r);
float alma_rng_beta22(alma_rng *r);

#endif
