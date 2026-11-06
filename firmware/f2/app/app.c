#include "app.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "api.h"
#include "backup.h"
#include "body.h"
#include "catalog_load.h"
#include "expression.h"
#include "fiesta.h"
#include "rlog.h"
#include "ota.h"
#include "f2_config.h"
#include "f2_hal.h"
#include "hal_k210.h"
#include "home.h"
#include "motion_player.h"
#include "outbox.h"
#include "perception.h"
#include "reflexes.h"
#include "repertorio.h"
#include "vision.h"
#include "voice.h"

static EXT_RAM_BSS_ATTR alma_t A;
static alma_catalog *CAT;
static EXT_RAM_BSS_ATTR alma_mem MEM;   /* esp_flash copia por su cuenta un buffer que no esté en DRAM */
/* siesta y bajarse de la base (batería, dueño 2026-11-02): se reinician en cada arranque (app_init) */
static int64_t nap_try_ms, leave_try_ms, bat_report_ms;
static int bat_test;
/* Truco de Darth Vader (dueño, 2026-11-03: imprimió el casco en 3D): aparece la boca, suena la marcha imperial y camina
   al frente. La cara y el mp3 los sube el servidor a /test/ (robot_debug "subir"); no es un .mot del catálogo */
#define VADER_MOT      "vader"
#define VADER_AVI      "/test/vader.avi"
#define VADER_MP3      "/test/vader_marcha.mp3"
#define VADER_MS       18700      /* lo que dura la marcha (y el video) */
#define VADER_WALK_MS  2300       /* empieza a caminar cuando ya apareció la boca */
#define VADER_LAST_MS  1500       /* el último paso empieza antes de que acabe */
#define VADER_FRONT_MM 150        /* algo enfrente: ya no camina */
static int64_t vader_t0;          /* −1 = no lo está haciendo */
static int vader_steps, vader_halt;   /* prueba de batería (dueño, 2026-11-02: "quiero saber cuánto le dura la batería") */
/* sobrevive a un reinicio por software (OTA): si no, al arrancar se iba de siesta antes de que se volviera a prender */
#define KEEP_BAT_TEST 1u
#define KEEP_USB_MOTION 2u
/* moverse con el USB (ALMA_DEV_MOTION_ON_USB): apagado por omisión (dueño, 2026-11-03: "sólo no quiero que se baje" al
   cargarlo por cable); se prende por Wi-Fi para las pruebas (robot_debug "usb on") y sigue tras un reinicio por software */
static int usb_motion;
int app_usb_motion_on(void) { return usb_motion; }
void app_usb_motion(int on)
{
    usb_motion = on;
    hal_keep_set(on ? hal_keep_get() | KEEP_USB_MOTION : hal_keep_get() & ~KEEP_USB_MOTION);
    hal_log("usb: %s", on ? "se mueve con el cable (pruebas)" : "con el cable cuenta como base: quieta");
}
void app_battery_test(int on)
{
    bat_test = on;
    hal_keep_set(on ? hal_keep_get() | KEEP_BAT_TEST : hal_keep_get() & ~KEEP_BAT_TEST);
    hal_log("batería: prueba %s", on ? "prendida (sin siesta; a casa con menos de 15 %)" : "apagada");
}
static int leave_steps;
static int64_t leave_check_ms;   /* −1: con "USB", tras el primer paso se mira si sigue cargando; >0: cuándo mirarlo */
static int play_test_avi;   /* tecla J: reproducir alma_test.avi cuando termine de subir */
static int show_test_sticker;   /* tecla K: encimar el sticker de prueba cuando termine de subir */
static int mem_ok, mem_wr, mem_born_empty;   /* mem_wr: se puede escribir (región en 0xFF o ya de Alma; 06) */
static double clock_base_s, preset_s = -1;
static int64_t clock_base_ms, last_tick_ms, last_motion_ms;
static app_exec_cb exec_cb;

#define QMAX 32
static alma_ev q[QMAX];
static int q_head, q_n;
static EXT_RAM_BSS_ATTR app_ev_log evlog[F2_LOG_EVENTS];
static int ev_first, ev_n;

static struct { int active, behavior; double t_start; float planned_s; } X;   /* conducta en ejecución */

/* Modo "Alma no está" (PLAN-RELOJ-v2 6.4 y 17; body.c decide): el núcleo no corre, sin conductas, sin caminar, sin pedir
   comida; los reflejos solo paran los servos; el K210 sigue buscando caras para la llegada (6.2).
   TODO: cara de ausencia dibujada por nosotros (11, 17); mientras, la de dormir del catálogo, sin sonido */
#define ABSENT_FACE          "sleep_breath_1"
#define ABSENT_FACE_EVERY_MS 8000
#define ABSENT_CLOCK_PATH    "/test/ausente_reloj.avi"   /* Alma está en el reloj (la sube el servidor, relay fiestas.py) */
#define ARRIVE_FACE          "charge_get_in_new"         /* al llegar sola a la base sin Alma (de fábrica) */
#define ARRIVE_FACE_MS       5000
#define GONE_FACE            "Byebye"   /* si lo levantan sin Alma ("se fue con tu dueño"); TODO: cara propia */
#define ABSENT_SCAN_EVERY_MS 4000       /* vistazos de caras más seguidos que en reposo (15 s), para la llegada */
#define CATCHUP_PER_STEP     3600       /* ponerse al día en pasos de 1 s, sin bloquear el bucle */
#define OFF_CHARGER_MS       10000      /* sin cargador al menos esto antes de ir a buscar la base (no por un parpadeo) */
#define NAP_BOOT_MS          120000     /* sin siesta los primeros 2 min tras arrancar (la lectura de batería se asienta) */
#define BAT_REPORT_MS        300000     /* la batería al servidor cada 5 min */
#define BAT_TEST_REPORT_MS   60000      /* en la prueba, cada minuto (el dueño calcula 30–40 min de batería) */
#define BAT_TEST_HOME_PCT    15.0f      /* en la prueba de batería, a casa hasta aquí */
#define RLOG_BOOT_MS         (4LL * 3600 * 1000)   /* registro por Wi-Fi al arrancar (rlog.h) */
#define MUSIC_MUTE_MS        25000      /* sin sonido propio hasta 25 s después del último aviso de música */
static uint32_t seed0;
static int link_up, asleep, ran, saved_scan_ms;
static double asleep_since, catchup_left, catchup_t;
static int64_t absent_face_ms;

static const char *const EV_NAMES[EV_COUNT] = {
    "EV_FACE_SEEN", "EV_FACE_UNKNOWN", "EV_FACE_LOST", "EV_WAKE_WORD", "EV_VOICE_COMMAND", "EV_PRAISE", "EV_SCOLD",
    "EV_VOICE_FAILED", "EV_REMOTE_COMMAND", "EV_TOUCH_TAP", "EV_TOUCH_PET", "EV_PICKED_UP", "EV_PUT_DOWN", "EV_SHAKEN",
    "EV_TIPPED_OVER", "EV_CLIFF", "EV_OBSTACLE", "EV_LOUD_SOUND", "EV_BATTERY_LOW", "EV_CHARGING_ON", "EV_CHARGING_OFF",
    "EV_BEHAVIOR_DONE", "EV_BEHAVIOR_INTERRUPTED", "EV_MUSIC", "EV_REMINDER", "EV_TRICK"};
/* action_id de 05 y 07 */
static const char *const ACT_NAMES[ACT_COUNT] = {"come", "dance", "turn_around", "sleep", "wake_up", "look_at_me",
                                                 "play", "stop", "greet", "go_home"};

const char *app_ev_name(int t) { return t >= 0 && t < EV_COUNT ? EV_NAMES[t] : "?"; }
const char *app_action_name(int a) { return a >= 0 && a < ACT_COUNT ? ACT_NAMES[a] : "?"; }
int app_action_of(const char *name)
{
    for (int i = 0; i < ACT_COUNT; i++) if (strcmp(name, ACT_NAMES[i]) == 0) return i;
    return -1;
}

double app_now_s(void) { return clock_base_s + (double)(hal_now_ms() - clock_base_ms) / 1000.0; }
void app_set_clock(double local_s) { clock_base_s = local_s; clock_base_ms = hal_now_ms(); }
void app_preset_clock(double local_s) { preset_s = local_s; }
int app_clock_real(void) { return preset_s >= 0; }

void app_clock_from_server(double local_s)
{
    if (preset_s >= 0 || local_s < 1.6e9) return;
    preset_s = local_s;
    /* el cuerpo se durmió con la hora falsa (8:00 del día 0): sin correrlo, al despertar contaba años y se ponía al día
       3 días de hambre (2026-11-05, SNTP falló al arrancar) */
    if (asleep) asleep_since += local_s - app_now_s();
    app_set_clock(local_s);
    A.t_last = local_s;        /* sin un salto de años en el siguiente tick */
    A.forget_enabled = 1;      /* con hora real ya se puede olvidar a los 28 días (06) */
    double d = fmod(local_s, 86400.0);
    hal_log("hora: sin SNTP; la del servidor (%02d:%02d)", (int)(d / 3600), (int)(fmod(d, 3600.0) / 60));
}
const alma_t *app_alma(void) { return &A; }

/* vacía al arrancar (flash borrada o robot nuevo): en segundos guarda sus primeros datos, por eso se mira al abrirla */
int app_mem_empty(void) { return mem_born_empty; }

/* respaldo del servidor (backup.c): solo con escritura habilitada; un archivo malo no toca el flash (alma_mem_import) */
int app_mem_restore(const uint8_t *p, size_t n)
{
    if (!mem_wr || alma_mem_import(&MEM, p, (uint32_t)n)) return -1;
    alma_mem_load(&MEM, &A);
    mem_born_empty = 0;
    alma_food_prefs_init(&A);
    return 0;
}
const alma_catalog *app_catalog(void) { return CAT; }
alma_mem *app_mem(void) { return &MEM; }
void app_set_exec_cb(app_exec_cb cb) { exec_cb = cb; }

int app_events(const app_ev_log **out, int *first) { *out = evlog; *first = ev_first; return ev_n; }

static void log_event(const alma_ev *e)
{
    app_ev_log *l = &evlog[(ev_first + ev_n) % F2_LOG_EVENTS];
    if (ev_n < F2_LOG_EVENTS) ev_n++;
    else ev_first = (ev_first + 1) % F2_LOG_EVENTS;
    *l = (app_ev_log){hal_now_ms(), e->type, e->person_id, e->action_id, e->behavior};
}

/* ---- acomodarse (dueño, 2026-11-05): ladeada, hacia donde hay piso ----
   Con la inclinación del IMU (HALLAZGOS: A < 0 nariz abajo, B < 0 ladeada a su izquierda) y el mapa de los .mot
   (explore_foward1 avanza, explore_back_away1 retrocede, explore_turn_left2/right2 giran 44°): se aleja del lado en el
   aire y va hacia el que tiene piso. Antes de moverse revisa que los pies de ese lado vean piso; si no, se queda quieta.
   Muy ladeada (≥ SETTLE_MAX_DEG) no se mueve nunca. Si lo decide o no, es de la red (bhv_settle) */
#define SETTLE_MAX_DEG 35.0f
static void settle_start(void)
{
    static alma_motion_opt o;
    if (home_active()) { hal_log("acomodarse: va a la base; no"); return; }
    hal_sensors s;
    hal_sensors_read(&s);
    float ta = s.tilt_a, tb = s.tilt_b;
    memset(&o, 0, sizeof o);
    o.hhmm0 = o.hhmm1 = -1;
    const char *why = NULL;
    if (fabsf(ta) >= SETTLE_MAX_DEG || fabsf(tb) >= SETTLE_MAX_DEG) why = "muy ladeada: no se mueve";
    else if (fabsf(ta) >= fabsf(tb)) {
        int fwd = ta < 0;   /* nariz abajo: los de adelante tienen piso → avanza; cara arriba → retrocede */
        int p = fwd ? HAL_FLOOR_FRONT : HAL_FLOOR_REAR;
        if (s.floor[HAL_FOOT_L][p] != 1 || s.floor[HAL_FOOT_R][p] != 1) why = fwd ? "sin piso adelante" : "sin piso atrás";
        else { o.n = 1; snprintf(o.mot[0], sizeof o.mot[0], "%s", fwd ? "explore_foward1" : "explore_back_away1"); }
    } else {
        int left = tb < 0;   /* ladeada a su izquierda: el pie izquierdo es el que tiene piso → gira a la izquierda */
        int f = left ? HAL_FOOT_L : HAL_FOOT_R;
        if (s.floor[f][HAL_FLOOR_FRONT] != 1) why = left ? "sin piso a la izquierda" : "sin piso a la derecha";
        else {
            o.n = 2;
            snprintf(o.mot[0], sizeof o.mot[0], "%s", left ? "explore_turn_left2" : "explore_turn_right2");
            snprintf(o.mot[1], sizeof o.mot[1], "explore_foward1");
        }
    }
    if (why) { hal_log("acomodarse (A %.0f°, B %.0f°): %s; se queda quieta", ta, tb, why); return; }
    hal_log("acomodarse (A %.0f°, B %.0f°): %s%s%s", ta, tb, o.mot[0], o.n > 1 ? " + " : "", o.n > 1 ? o.mot[1] : "");
    motion_play(&o, A.on_charger, 0);
}

/* ---- ejecutor: los ganchos del núcleo ---- */
static void on_exec(void *user, const alma_exec_info *e)
{
    (void)user;
    const alma_behavior *b = &CAT->b[e->behavior];
    if (asleep) { hal_log("conducta %s: Alma no está, sin movimiento ni cara", b->id); return; }
    /* volver a casa (home.c): la conducta la arranca; mientras dure, las demás no mueven servos ni cambian la cara */
    if (strcmp(b->id, "bhv_go_home") == 0 && e->kind != RUN_REFLEX) home_start("conducta bhv_go_home");
    /* bajarse de la base (dueño, 2026-11-05: lo decide ella): los mismos pasos al frente que la regla de antes. Con "USB"
       también: en la Home Station RX0 sale alto y parece USB (2026-11-03 y 11-05, sin cable). El primer paso lo resuelve:
       si sigue cargando, es el cable de verdad y se queda (leave_check_ms) */
    if (strcmp(b->id, "bhv_settle") == 0 && e->kind != RUN_REFLEX) settle_start();
    /* sus movimientos propios (dueño, 2026-11-05): inventar (vía 2), enseñar un truco de Haiku (vía 3) y, jugando, a
       veces uno de los suyos en vez del de fábrica */
    if (strcmp(b->id, "bhv_invent") == 0 && e->kind != RUN_REFLEX && repertorio_invent(&A.rng, A.on_charger) != 0)
        hal_log("invento: ahora no (ocupada o en la base)");
    if (strcmp(b->id, "bhv_new_trick") == 0 && e->kind != RUN_REFLEX && repertorio_show_trick(A.on_charger) != 0)
        hal_log("truco: no hay uno nuevo que enseñar");
    int own = e->option >= 0 && e->kind == RUN_SELECTOR && (!strcmp(b->id, "bhv_play_solo") || !strcmp(b->id, "bhv_dance")
              || !strcmp(b->id, "bhv_happy_wiggle")) && alma_rng_u01(&A.rng) < 0.25f;
    if (strcmp(b->id, "bhv_photo") == 0 && e->kind != RUN_REFLEX) {   /* mirar con atención y tomar foto (vision.c) */
        int P = alma_P(&A);
        vision_decide(P >= 0 && A.person[P].present && A.person[P].facing);
    }
    if (strcmp(b->id, "bhv_leave_base") == 0 && e->kind != RUN_REFLEX && A.on_charger && !home_active()) {
        leave_try_ms = hal_now_ms();
        leave_steps = LEAVE_STEPS;
        leave_check_ms = perception_on_usb() ? -1 : 0;   /* −1: falta ver si es cable */
        perception_leaving_base(1);
        hal_log("base: decide bajarse (%.0f %%%s)", A.soc_pct, perception_on_usb() ? ", parece USB: primero un paso" : "");
    }
    if (vader_t0 >= 0 && e->kind == RUN_REFLEX) vader_halt = 1;   /* un reflejo: ya no camina (la marcha sigue) */
    if (home_active() || (vader_t0 >= 0 && e->kind != RUN_REFLEX)) {
        hal_log("conducta %s: %s, sin movimiento ni cara", b->id, home_active() ? "volviendo a casa" : "haciendo Darth Vader");
        X.active = 1;
        X.behavior = e->behavior;
        X.t_start = e->t_start;
        X.planned_s = e->planned_s;
        if (exec_cb) exec_cb(e);
        return;
    }
    X.active = 1;
    X.behavior = e->behavior;
    X.t_start = e->t_start;
    X.planned_s = e->planned_s;
    hal_log("conducta %s (tipo %d, opción %d, %.1f s%s)", b->id, (int)e->kind, e->option, e->planned_s,
            e->motion_null_reason == 3 ? ", sin servos: cargando" : e->motion_null_reason == 2 ? ", sin servos: presupuesto"
            : e->motion_null_reason == 1 ? ", sin servos: regla †" : "");
    /* un reflejo durante Darth Vader mueve los servos, pero la boca y la marcha siguen (dueño, 2026-11-04: "sólo pone la
       música 3 segundos") */
    if (vader_t0 < 0) {
        expression_stop(0);
        /* dueño, 2026-10-30: la flor a pantalla completa (EMO_flower_full) cuando disfruta tus caricias y te quiere mucho */
        int flower = strcmp(b->id, "bhv_enjoy_pet") == 0 && e->person >= 0 && A.person[e->person].attachment >= 0.3f
                     && A.affect_valence > 0.3f && (hal_now_ms() & 1);
        double d = fmod(app_now_s(), 86400.0);
        int hhmm = (int)(d / 3600.0) * 100 + (int)(fmod(d, 3600.0) / 60.0);
        if (flower) k210_play("EMO_flower_full", NULL, 0);
        else if (expression_play_seq(e->behavior, hhmm, e->planned_s) != 0)
            expression_play_exec(e->behavior, e->option >= 0 ? b->opt[e->option].mot[0] : NULL, A.affect_valence);
    }
    if (e->option >= 0) {
        if (e->tempo < 1.0f) hal_log("corre: paso × %.2f", e->tempo);
        motion_set_tempo(e->tempo);
        /* variar lo que sabe (dueño, 2026-11-05, vía 1): contenta o emocionada, más rápido y amplio; cansada, más lento y
           chico; a veces espejado. No en reflejos ni en lo que camina (la marcha y la dirección van exactas) */
        if (e->kind != RUN_REFLEX && !(b->tags & TAG_LOCOMOTION)) {
            float rest = alma_need(&A, NEED_REST), ar = A.affect_arousal, val = A.affect_valence;
            float speed = 1.0f + 0.3f * ar - 0.3f * rest, amp = 1.0f + 0.15f * (val > 0 ? val : 0) + 0.1f * ar - 0.15f * rest;
            motion_set_variation(speed, amp, alma_rng_u01(&A.rng) < 0.3f);
        }
    }
    if (own && repertorio_play_own(&A.rng, A.on_charger) == 0) {}   /* uno de los suyos (sin variación extra: la suya) */
    else if (e->option >= 0)
        motion_play(&b->opt[e->option], A.on_charger, 0);   /* sin límite diario de patas (dueño, 2026-11-05) */
    else if (e->kind != RUN_REFLEX)
        motion_stop_now();
    if (exec_cb) exec_cb(e);
}

/* el cuerpo acompaña a una rutina o actividad: el .mot del mismo nombre, si existe (y con las reglas de siempre) */
static void seq_motion(const char *mot)
{
    static alma_motion_opt o;
    static EXT_RAM_BSS_ATTR mot_frame probe[MOTION_MAX_FRAMES];   /* ~10 KB: en la PSRAM */
    if (motion_load(mot, probe, MOTION_MAX_FRAMES) <= 0) return;
    memset(&o, 0, sizeof o);
    o.n = 1;
    o.hhmm0 = o.hhmm1 = -1;
    snprintf(o.mot[0], sizeof o.mot[0], "%s", mot);
    motion_play(&o, A.on_charger, 0);
}

static void on_night(void *user, const alma_day_summary *s)
{
    (void)user;
    hal_log("pase nocturno: día %d, ánimo %.2f, caricias %d, servo %.0f s", s->age_days, s->mood_end, s->counts.pets, s->servo_active_s);
    /* el resumen va a Haiku por el enlace; el ajuste vuelve en "night_result" (api_link_msg → app_night_result) */
    static EXT_RAM_BSS_ATTR char js[OUTBOX_LEN];
    if (api_night(s, js, sizeof js) > 0) outbox_put(js);
    else hal_log("pase nocturno: el resumen no cabe en %d bytes", OUTBOX_LEN);
    backup_after_night();   /* respaldo en el servidor con lo que aprendió hoy */
    body_night(1);          /* candado: no hay mudanza hasta que Haiku conteste (5.3.7) */
}

void app_night_result(int wb_adjust, const float nudges[TRAIT_COUNT])
{
    float before = A.wellbeing;
    body_night(0);
    alma_wellbeing_adjust(&A, wb_adjust);
    alma_trait_nudges(&A, nudges);
    hal_log("bienestar: %.0f → %.0f con el ajuste de Haiku (%+d)", before, A.wellbeing, A.wb_day_adjust);
}

/* olvidar a quien no se ve en 28 días (06; dueño, 2026-10-30): el núcleo ya liberó su lugar; la cara del K210 se
   borra en cuanto el K210 esté libre (k210_face_delete), una a la vez */
static int forget_q[ALMA_MAX_PERSONS], forget_n;

static void on_forget(void *user, int person_id)
{
    (void)user;
    hal_log("olvido: la persona %d no se vio en %d días; se libera su lugar y se borra su cara del K210", person_id, FORGET_DAYS);
    if (forget_n < ALMA_MAX_PERSONS) forget_q[forget_n++] = person_id;
    char extra[32];
    snprintf(extra, sizeof extra, ",\"person_id\":%d", person_id);
    outbox_event("forgot_face", extra);
}

static void forget_step(void)
{
    if (!forget_n || k210_face_delete_state() == K210_REG_RUNNING || k210_face_delete(forget_q[0])) return;
    memmove(forget_q, forget_q + 1, (size_t)--forget_n * sizeof *forget_q);
}

/* tamagotchi (dueño, 2026-10-30): el hambre corre solo si se le puede dar de comer (enlace con el servidor) */
static int hungry_told;

void app_set_link(int up)
{
    voice_set_link(up);
    vision_set_link(up);
    backup_set_link(up);
    body_set_link(up);
    ota_link(up);
    link_up = up;
    A.care_enabled = up;
}

alma_feed_result app_feed(int food)
{
    alma_feed_result r = alma_feed(&A, food, app_now_s());
    hal_log("comida: %s → %s (%s), hambre %.2f%s", alma_food_id(food), r.accepted ? "la acepta" : "la rechaza",
            alma_feed_why_id(r.why), A.hunger, r.got_sick ? ", ¡empacho!" : "");
    if (r.got_sick) outbox_event("sick", "");
    if (r.accepted) {   /* evento importante (5.5): a la memoria y respaldo */
        char d[48];
        snprintf(d, sizeof d, "{\"food\":\"%s\"}", alma_food_id(food));
        body_event("comida", d);
    }
    return r;
}

void app_care_state(float hunger, alma_sick_cause cause, alma_weight_band band, float energy)
{
    int was = A.sick;
    alma_weight_band band0 = A.weight_band;
    alma_care_apply_state(&A, hunger, cause, band, energy, app_now_s());
    if (A.sick != was || A.weight_band != band0)
        hal_log("salud (servidor): %s, peso %d, energía %.2f, hambre %.2f", A.sick ? "enferma" : "sana", A.weight_band,
                A.care_energy, A.hunger);
}

void app_care_feed(int food, int accepted, float joy, float bond, float frust)
{
    alma_care_apply_feed(&A, food, accepted, joy, bond, frust, app_now_s());
    if (accepted) {
        char d[48];
        snprintf(d, sizeof d, "{\"food\":\"%s\"}", alma_food_id(food));
        body_event("comida", d);
    }
    hal_log("comida (servidor): %s → %s, alegría %+.2f, amistad %+.2f", alma_food_id(food),
            accepted ? "la come" : "la rechaza", joy, bond);
}

void app_game_event(alma_game_ev e, const char *juego)
{
    alma_game_event(&A, e, app_now_s());
    char d[24];
    snprintf(d, sizeof d, "{\"ev\":%d}", (int)e);
    body_event("juego", d);
    hal_log("juego (app): %s, evento %d", juego ? juego : "?", (int)e);
}

void app_vision_event(alma_vision_ev e, const char *behavior)
{
    alma_vision_event(&A, e, behavior ? alma_find(CAT, behavior) : -1, app_now_s());
}

void app_remote_play(int seconds)
{
    if (seconds > 0 && seconds <= 3600) A.counts.remote_play_s += seconds;
}

/* en la Home Station, tras BASE_RELEASE_MS quieta: servos sueltos (dueño, 2026-11-03: "queda a veces mal acomodado y no sé si
   cargue al 100%"; la base es inalámbrica) */
#define BASE_RELEASE_MS 3000
/* los servos guardan su posición sin señal: flojos de verdad solo sin corriente en las patas (sí del dueño, 2026-11-03).
   Fuera de la base (o con "patas on" por Wi-Fi) vuelve la corriente, para que los pies vean las orillas */
static int legs_keep_on;
void app_legs_keep_on(int on) { legs_keep_on = on; hal_log("patas: en la base %s", on ? "siempre con corriente" : "sin corriente"); }
/* Descansando fuera de la base también relaja las patas (dueño, 2026-11-05: "si está descansando y desactivó los pies y yo
   la muevo, que se enoje y los active"). Sin corriente los pies no ven el piso: el IMU avisa que la mueven, las patas
   vuelven y, si está en el aire, los pies dan el levantado (reflejo de siempre) */
#define MOVED_WAKE_MS 10000   /* tras moverla, las patas siguen con corriente un rato aunque vuelva a descansar */
static int64_t moved_ms = -1000000;
void app_note_moved(int64_t now) { moved_ms = now; }
/* Desmayo (dueño, 2026-11-05: "desmayo con secuela"). Si no fue a cargarse y la batería llega a FAINT_PCT un minuto
   seguido: guarda su memoria (y el respaldo al servidor), pone la cara de batería agotada, suelta las patas y no hace
   nada más hasta que la pongan a cargar. El ESP32 y el enlace siguen prendidos: así el servidor no la manda al reloj, y
   no se toca PWR_EN (R13). Si la batería se acaba del todo, la protección la apaga; al cargarla arranca con la secuela
   guardada (alma_faint_rec) */
#define FAINT_PCT      1.0f      /* ≈ 3.41 V (battery.c: 0 % = 3.40 V) */
#define FAINT_HOLD_MS  60000     /* la lectura brinca ±100 mV: un minuto seguido */
#define FAINT_FACE     "battery_l2"
static int fainted;
static int64_t empty_since = -1;
int app_fainted(void) { return fainted; }
static int resting_still(void)
{
    if (fainted) return 1;
    if (A.state == ST_RESTING || A.state == ST_SLEEPING) return 1;
    return A.state == ST_PERFORMING && A.cur.active && A.cur.option < 0 && CAT->b[A.cur.behavior].category == CAT_REST;
}
static void base_servos(int64_t now)
{
    static int64_t base_since = -1;
    /* con cualquier cargador: en la base inalámbrica RX0 a veces sale alto y parece USB (medido 2026-11-03: GPIO36 2223 mV,
       RX0 1, sin cable); con el USB tampoco se mueve, salvo "usb on" */
    int rest_off_base = !A.on_charger && !perception_on_usb() && resting_still() && (fainted || now - moved_ms > MOVED_WAKE_MS)
                        && !motion_active() && !home_active() && leave_steps == 0;
    if ((!A.on_charger && !rest_off_base) || usb_motion || legs_keep_on) {
        base_since = -1;
        if (!hal_legs_on()) { hal_legs_power(1); perception_hold_edges(now + 600); }
        return;
    }
    if (base_since < 0) base_since = now;
    /* bajándose (leave_steps): entre un paso y otro no hay movimiento, y soltarlas ahí dejaba cada paso con las patas
       flojas; no avanzaba (2026-11-05 16:18: decidió bajarse y se quedó) */
    if (leave_steps > 0 || leave_check_ms != 0) base_since = now;
    if (now - base_since >= BASE_RELEASE_MS && !motion_active() && !home_active()) {
        motion_release_all();
        if (hal_legs_on()) hal_legs_power(0);
    }
    if (!hal_legs_on()) perception_hold_edges(now + 600);   /* sin corriente, los pies no cuentan */
}

static int vader_start(const char **why)
{
    if (home_active()) { *why = "va a su base"; return 0; }
    if (!alma_trick_ready(&A)) { *why = A.state == ST_SLEEPING ? "está dormida" : "está ocupada"; return 0; }
    if (vader_t0 >= 0) { *why = "ya lo está haciendo"; return 0; }
    expression_stop(0);
    motion_stop_now();
    if (k210_play_path(VADER_AVI, VADER_MP3, 0) != 0) { *why = "la pantalla no está lista"; return 0; }
    vader_t0 = hal_now_ms();
    vader_steps = vader_halt = 0;
    hal_log("truco: Darth Vader (%s con %s)", VADER_AVI, VADER_MP3);
    body_event("truco", "{\"mot\":\"vader\"}");
    return 1;
}

static void vader_step(int64_t now)
{
    if (vader_t0 < 0) return;
    int64_t t = now - vader_t0;
    if (t >= VADER_MS) { vader_t0 = -1; hal_log("truco: Darth Vader terminó (%d pasos)", vader_steps); return; }
    if (A.pause_until_s < app_now_s() + 1.0) A.pause_until_s = app_now_s() + 1.0;   /* sin conductas propias encima */
    if (vader_halt || t < VADER_WALK_MS || t > VADER_MS - VADER_LAST_MS || motion_active()) return;
    int mm = perception_front_mm();
    if (perception_forward_blocked() || (mm >= 0 && mm < VADER_FRONT_MM)) {
        hal_log("truco: Darth Vader deja de caminar (%s)", perception_forward_blocked() ? "orilla" : "algo enfrente");
        vader_halt = 1;
        return;
    }
    alma_motion_opt o;
    memset(&o, 0, sizeof o);
    o.n = 1;
    o.hhmm0 = o.hhmm1 = -1;
    snprintf(o.mot[0], sizeof o.mot[0], "explore_foward1");
    if (motion_play(&o, A.on_charger, 0) == MOTION_OK) vader_steps++;
    else vader_halt = 1;
}

int app_trick(const char *mot, const char **why)
{
    if (mot && strcmp(mot, VADER_MOT) == 0) return vader_start(why);
    if (A.ix_trick < 0) { *why = "no tiene trucos en el catálogo"; return 0; }
    const alma_behavior *x = &CAT->b[A.ix_trick];
    int opt = -1;
    for (int i = 0; mot && i < x->n_opt; i++)
        if (strcmp(x->opt[i].mot[0], mot) == 0) { opt = i; break; }
    if (opt < 0) { *why = "no conoce ese movimiento"; return 0; }
    if (home_active()) { *why = "va a su base"; return 0; }
    if (!alma_trick_ready(&A)) { *why = A.state == ST_SLEEPING ? "está dormida" : "está ocupada"; return 0; }
    alma_ev e = {EV_TRICK, -1, opt, -1, 0, 0, 0, 0};
    app_post(&e);
    char d[ALMA_MOT_LEN + 16];
    snprintf(d, sizeof d, "{\"mot\":\"%s\"}", x->opt[opt].mot[0]);
    body_event("truco", d);
    return 1;
}

static void hunger_step(void)
{
    if (!A.care_enabled) return;
    if (A.hunger >= HUNGRY_AT && !hungry_told) {
        char extra[32];
        snprintf(extra, sizeof extra, ",\"hunger\":%.2f", A.hunger);
        outbox_event("hungry", extra);
        hungry_told = 1;
    } else if (A.hunger < 0.5f) hungry_told = 0;
}

/* varias caídas o bordes en poco tiempo: aviso al celular (dueño, 2026-10-30) */
static int64_t falls_t[FALLS_N];
static int falls_n;

static void falls_check(int type)
{
    int64_t *t = falls_t;
    int n = falls_n;
    if (type != EV_CLIFF && type != EV_TIPPED_OVER) return;
    int64_t now = hal_now_ms();
    for (int i = FALLS_N - 1; i > 0; i--) t[i] = t[i - 1];
    t[0] = now;
    if (n < FALLS_N) n++;
    if (n == FALLS_N && now - t[FALLS_N - 1] <= FALLS_WINDOW_MS) {
        char extra[32];
        snprintf(extra, sizeof extra, ",\"count\":%d", FALLS_N);
        outbox_event("falls", extra);
        n = 0;
    }
    falls_n = n;
}

static void deliver(const alma_ev *e)
{
    log_event(e);
    if (e->type == EV_OBSTACLE && !home_active() && !A.policy) vision_obstacle();   /* yendo a la base, lo que tiene enfrente es la base */   /* algo a 10 cm o menos: ¿qué es? (cada 3 min como mucho) */
    /* al servidor: una caricia justo después de un truco bien hecho cuenta como "¡muy bien!" (dueño, 2026-11-02) */
    if (e->type == EV_TOUCH_PET) outbox_event("pet", "");
    repertorio_event(e->type);   /* ¿le gustó el truco nuevo? */
    alma_event(&A, e, app_now_s());
#if ALMA_MEM_WRITE_ENABLED
    if (mem_wr) alma_mem_on_event(&MEM, &A, e->type);
#endif
}

void app_post(const alma_ev *e)
{
    if (reflex_is(e->type)) {   /* ruta prioritaria (05): servos quietos ya, núcleo después */
        /* en la mano no hay bordes: no se corta el forcejeo (el núcleo también lo ignora) */
        if (e->type == EV_CLIFF && A.lifted) { hal_log("borde con EMO levantado: no cuenta"); deliver(e); return; }
        /* sacudirlo mientras forcejea en la mano no corta el forcejeo (dueño, 2026-10-30) */
        if (e->type == EV_SHAKEN && A.lifted && A.cur.active && A.cur.behavior == A.ix_struggle) { deliver(e); return; }
        if (e->type == EV_CLIFF && home_near_base()) { hal_log("casa: borde junto a la base (su orilla o su rampa): no cuenta"); return; }
        falls_check(e->type);
        home_stop(app_ev_name(e->type));   /* un reflejo (borde, levantarla, sacudirla) cancela la vuelta a casa */
        reflex_fire(e->type);
        if (asleep) {   /* sin Alma: los servos quietos y nada más; si lo levantan, la cara de que se fue */
            if (e->type == EV_PICKED_UP) k210_play(GONE_FACE, NULL, 0);
            return;
        }
        deliver(e);
        return;
    }
    if (e->type == EV_MUSIC)   /* 37 llega cada ~10 s mientras suena; 2 = terminó */
        expression_mute_until(e->x == 2 ? -1 : hal_now_ms() + MUSIC_MUTE_MS);
    if (q_n == QMAX) { hal_log("cola llena: se pierde %s", app_ev_name(e->type)); return; }
    q[(q_head + q_n++) % QMAX] = *e;
}

static void perc_emit(const alma_ev *e) { app_post(e); }

static void executor_step(double now_s)
{
    if (X.active) {
        int same = A.cur.active && A.cur.behavior == X.behavior && A.cur.t_start == X.t_start;
        if (!same) {
            X.active = 0;
            if (A.state != ST_REFLEX) motion_stop_now();   /* la conducta terminó o la interrumpieron */
        } else if (now_s >= X.t_start + X.planned_s) {
            X.active = 0;
            expression_stop(1);
            alma_ev d = {EV_BEHAVIOR_DONE, -1, -1, X.behavior, 0, 0, 0, 0};
            deliver(&d);
        }
    }
    /* ojos vivos, salvo dormida o en una conducta de descanso (sus caras son de ojos cerrados) */
    k210_set_idle_eyes(A.state != ST_SLEEPING && !(A.cur.active && CAT->b[A.cur.behavior].category == CAT_REST));
    /* la personalidad en los ojos (dueño, 2026-10-30): con más energía se mueven más seguido; con el bienestar bajo, más
       lento; con más juego, más guiños */
    {
        float w = A.wellbeing / 1023.0f, sc = (1.4f - 0.8f * A.trait[TRAIT_ENERGY]) * (1.0f - 0.3f * w);
        k210_set_eye_style(sc < 0.5f ? 0.5f : sc > 2.0f ? 2.0f : sc, 0.08f + 0.3f * A.trait[TRAIT_PLAYFULNESS]);
    }
    /* 04, "Escucha": GPIO26 bloqueado mientras dure ST_LISTENING */
    motion_lock_gpio26(A.state == ST_LISTENING);
}

#if ALMA_MEM_WRITE_ENABLED
/* 06, riesgos de la opción a): antes de escribir, la región debe estar toda en 0xFF o tener ya algún registro válido
   de Alma. Si tiene otra cosa (un firmware ajeno que use esa zona), no se escribe nunca. */
static int region_is_alma_or_blank(const alma_mem_flash *fl)
{
    for (int b = 0; b < ALMA_MEM_BLOCKS; b++)
        if (MEM.b[b].status == MEM_OK || MEM.b[b].status == MEM_KEEP) return 1;
    static uint8_t buf[256];
    for (uint32_t off = 0; off < fl->size; off += sizeof buf) {
        if (fl->read(fl->ctx, off, buf, sizeof buf)) return 0;
        for (size_t i = 0; i < sizeof buf; i++) if (buf[i] != 0xFF) return 0;
    }
    return 1;
}
#endif

/* La red que decide (dueño, 2026-11-04; reports/Conducta felina y canina para Alma.md). Los pesos van incrustados; si
   faltan o no cuadran, Alma sigue con la fórmula de siempre. Tecla N: red sí / no (para comparar) */
static EXT_RAM_BSS_ATTR uint32_t brain_buf[(64 * 1024) / 4];
static alma_mlp brain;
static int brain_on = 1, brain_err = -9;

static void on_brain(void *user, const struct alma_brain_decision *d)
{
    (void)user;
    hal_log("red: %s %.0f%% · %s %.0f%% · %s %.0f%%%s", ALMA_BRAIN_OUT_ID[d->top[0]], 100 * d->top_p[0],
            ALMA_BRAIN_OUT_ID[d->top[1]], 100 * d->top_p[1], ALMA_BRAIN_OUT_ID[d->top[2]], 100 * d->top_p[2],
            d->event ? " (evento)" : "");
}

static void brain_setup(void)
{
    size_t n = 0;
    const uint8_t *w = hal_brain_weights(&n);
    brain_err = !w ? -8 : n > sizeof brain_buf ? -7 : 0;
    if (!brain_err) {
        memcpy(brain_buf, w, n);   /* alineado a 4 bytes (alma_mlp_load) */
        brain_err = alma_mlp_load(&brain, brain_buf, (uint32_t)n);
    }
    alma_brain_set_policy(&A, !brain_err && brain_on ? alma_mlp_policy : NULL, &brain);
    if (brain_err) hal_log("red: sin pesos válidos (%d); decide la fórmula", brain_err);
    else hal_log("red: modelo %lu cargado, %s", (unsigned long)brain.model_version, brain_on ? "decide ella" : "apagada (tecla N), decide la fórmula");
}

static const alma_hooks HOOKS = {on_exec, on_night, NULL, on_forget, on_brain};

/* después de alma_mem_load: al arrancar y al recibir a Alma de otro cuerpo */
static void after_load(void)
{
    alma_food_prefs_init(&A);   /* memoria de antes del tamagotchi: gustos de la semilla */
    hungry_told = 0;
    /* olvido a los 28 días (06): solo con hora real (SNTP). Una marca de un arranque sin hora (segundos desde las 8:00
       del día 0) no se compara con una fecha real: esa persona empieza a contar desde hoy en vez de olvidarse de golpe */
    forget_n = 0;
    A.forget_enabled = preset_s >= 0;
    for (int i = 0; A.forget_enabled && i < ALMA_MAX_PERSONS; i++)
        if (A.person[i].used && A.person[i].last_seen_s > -1e11 && A.person[i].last_seen_s < 1e9) A.person[i].last_seen_s = app_now_s();
    brain_setup();
}

int app_init(const char *catalog_text, alma_catalog *catalog_mem, uint32_t seed)
{
    static EXT_RAM_BSS_ATTR char inv[16 * 1024];
    CAT = catalog_mem;
    seed0 = seed;
    clock_base_ms = hal_now_ms();
    clock_base_s = preset_s >= 0 ? preset_s : F2_BOOT_LOCAL_S;
    q_head = q_n = ev_first = ev_n = 0;
    memset(&X, 0, sizeof X);
    outbox_clear();
    voice_init();
    vision_init();
    fiesta_init();
    nap_try_ms = leave_try_ms = -10000000;
    bat_report_ms = 0;
    motion_boot();
    vader_t0 = -1;
    vader_steps = vader_halt = 0;
    bat_test = (hal_keep_get() & KEEP_BAT_TEST) != 0;
    usb_motion = (hal_keep_get() & KEEP_USB_MOTION) != 0;
    if (bat_test) hal_log("batería: la prueba sigue prendida (de antes del reinicio)");
    leave_steps = 0;
    leave_check_ms = 0;
    rlog_set(1);   /* registro por Wi-Fi prendido las primeras RLOG_BOOT_MS (2026-11-02: se fue sola a la base sin cable y no quedó nada) */
    ota_init();
    backup_init();
    repertorio_init();
    falls_n = 0;
    k210_init();
    perception_init(perc_emit);
    k210_set_rx_handler(perception_on_frame, NULL);
    if (expression_build_inventory(catalog_text, inv, sizeof inv) < 0) { hal_log("no pude armar el inventario"); return -1; }
    hal_heap_mark("inventario");   /* cada parse completo de catalog.json (RAM-PROPUESTA.md, 3.1) */
    int n = catalog_load_text(catalog_text, inv, CAT, 0);
    hal_heap_mark("catalogo");
    hal_log("catálogo: %d conductas aceptadas", n);
    if (n <= 0) return -1;
    expression_init(catalog_text, CAT);
    expression_set_seq_motion(seq_motion);
    hal_heap_mark("expresiones");
    alma_init(&A, CAT, seed, app_now_s(), HOOKS);
    /* memory_store (06): leer y validar; con ALMA_MEM_WRITE_ENABLED=0 nunca escribe */
    alma_mem_flash fl;
    mem_wr = 0;
    mem_ok = hal_mem_flash(&fl) == 0 && alma_mem_open(&MEM, &fl) == 0;
    mem_born_empty = mem_ok;
    for (int b = 0; mem_ok && b < ALMA_MEM_BLOCKS; b++) if (b != MEM_BODY && MEM.b[b].status != MEM_EMPTY) mem_born_empty = 0;
    if (mem_ok) {
        alma_mem_load(&MEM, &A);
        for (int b = 0; b < ALMA_MEM_BLOCKS; b++)
            if (MEM.b[b].status != MEM_EMPTY)
                hal_log("memoria: %s estado %d seq %lu", alma_mem_block_name(b), MEM.b[b].status, (unsigned long)MEM.b[b].seq);
#if ALMA_MEM_WRITE_ENABLED
        mem_wr = region_is_alma_or_blank(&fl);
#endif
        hal_log("memoria: región leída, memory_recovered=%s, escritura %s", MEM.recovered ? "true" : "false",
                !ALMA_MEM_WRITE_ENABLED ? "deshabilitada al compilar"
                : mem_wr ? "habilitada" : "BLOQUEADA: la región tiene datos que no son de Alma (06); ver PRUEBA-MEMORIA.md");
    } else {
        hal_log("memoria: región no disponible; Alma arranca con valores por omisión");
    }
    after_load();
    last_tick_ms = last_motion_ms = hal_now_ms();
    /* mudanza (body.c): con el protocolo encendido arranca sin Alma hasta que el servidor conteste (7) */
    asleep = ran = 0;
    catchup_left = 0;
    saved_scan_ms = k210_scan_every_ms;
    body_init();
    if (!body_runs()) app_body_sleep("arranca sin Alma: espera al servidor (7)");
    k210_boot();
    return 0;
}

/* ---- mudanza entre cuerpos (body.c): lo que el protocolo le pide al núcleo de este cuerpo ---- */
int app_mem_writable(void) { return mem_ok && mem_wr; }
int app_body_asleep(void) { return asleep; }

void app_body_sleep(const char *why)
{
    if (asleep) return;
    asleep = 1;   /* primero: lo que el núcleo arranque desde aquí ya no mueve servos ni cambia la cara */
    asleep_since = app_now_s();
    hal_log("Alma no está en este cuerpo: %s", why);
    X.active = 0;
    motion_stop_now();
    expression_stop(0);
    home_stop("Alma no está");
    /* 6.4 paso 3 (dueño, 2026-11-02: "en cuanto lo mando al reloj… solamente el regreso a base, ya sin existir alma, solo
       un cuerpo móvil a su casa"): fuera de la base, el cuerpo vuelve solo; si no llega, se queda donde quedó */
    if (!A.on_charger && !perception_on_usb()) home_start("Alma no está: el cuerpo vuelve a su casa");   /* con el USB (mesa de pruebas), no */
    k210_set_idle_eyes(0);
    if (k210_scan_every_ms > 0) { saved_scan_ms = k210_scan_every_ms; k210_scan_every_ms = ABSENT_SCAN_EVERY_MS; }
    absent_face_ms = 0;
    q_head = q_n = 0;
    catchup_left = 0;
#if ALMA_MEM_WRITE_ENABLED
    if (ran && mem_wr) alma_mem_flush(&MEM, &A);   /* guarda su último estado (6.4) */
#endif
}

static void body_wake(void)
{
    asleep = 0;
    double gap = app_now_s() - asleep_since;
    if (gap < 0) gap = 0;
    if (gap > BODY_CATCHUP_MAX_S) gap = BODY_CATCHUP_MAX_S;
    if (catchup_left <= 0) { catchup_t = asleep_since; catchup_left = gap; }
    else catchup_left += gap;
    if (saved_scan_ms > 0 && k210_scan_every_ms == ABSENT_SCAN_EVERY_MS) k210_scan_every_ms = saved_scan_ms;
    hal_log("Alma está en este cuerpo: despierta (%.0f s sin correr)", gap);
}

/* ponerse al día sin conductas (8.1): solo el estado continuo, en pasos fijos de 1 s */
static void catchup_step(void)
{
    for (int k = 0; k < CATCHUP_PER_STEP && catchup_left >= 1.0; k++) {
        catchup_t += 1.0;
        catchup_left -= 1.0;
        if (A.care_enabled) alma_care_tick(&A, 1.0f, catchup_t);
    }
    if (catchup_left < 1.0) {
        catchup_left = 0;
        A.t_last = app_now_s();   /* el siguiente alma_tick no vuelve a contar ese tiempo */
    }
}

long app_body_export(uint8_t *out, size_t cap, int flush)
{
#if ALMA_MEM_WRITE_ENABLED
    if (flush && mem_wr) alma_mem_flush(&MEM, &A);
#else
    (void)flush;
#endif
    return mem_ok ? alma_mem_export(&MEM, out, (uint32_t)cap) : -1;
}

int app_body_import(const uint8_t *p, size_t n, double elapsed_s)
{
    if (!mem_wr || alma_mem_import(&MEM, p, (uint32_t)n)) return -1;   /* valida todo antes de escribir (06) */
    alma_init(&A, CAT, seed0, app_now_s(), HOOKS);
    alma_mem_load(&MEM, &A);
    after_load();
    A.care_enabled = link_up;
    mem_born_empty = 0;
    memset(&X, 0, sizeof X);
    q_head = q_n = 0;
    ran = 0;
    asleep_since = app_now_s();
    catchup_t = app_now_s() - elapsed_s;
    catchup_left = elapsed_s;
    hal_log("memoria: Alma importada (%u bytes, día %d); se pone al día %.0f s sin conductas", (unsigned)n, A.age_days, elapsed_s);
    return 0;
}

/* sin Alma: reflejos que paran servos, caras para la llegada, la cara de ausencia y nada del núcleo */
static void absent_step(int64_t now)
{
    forget_step();
    backup_step();
    alma_sensors s = {A.soc_pct, A.on_charger};
    perception_poll_sensors(&s);
    /* sin Alma el núcleo no corre: la batería y el cargador se copian aquí (el aviso de batería, las patas en la base y la
       cara de carga los leen de A; 2026-11-03: sin esto se quedaba en 100 % y "sin cargador") */
    A.soc_pct = s.soc_pct;
    A.on_charger = s.on_charger;
    q_head = q_n = 0;   /* los eventos no van al núcleo */
    home_step();   /* sin Alma, solo el viaje a la base (app_body_sleep) */
    fiesta_step(now);   /* subir al K210 las caras que lleguen (sin Alma no salen: fiesta.c calm) */
    static home_state was;
    home_state hs = home_get();
    int ready = k210_get_state() == K210_READY && k210_face_phase() == 4 && !k210_expr_pending();
    if (hs == HOME_DONE && was != HOME_DONE && k210_get_state() == K210_READY) {   /* llegó sola a la base: la animación de carga de fábrica */
        k210_set_fallback(ABSENT_FACE, NULL);
        k210_play(ARRIVE_FACE, NULL, 0);
        absent_face_ms = now + ARRIVE_FACE_MS;
    } else if (ready && now >= absent_face_ms && !body_watching() && !home_active() && k210_file_state_get() != K210_FILE_BUSY) {
        /* dueño, 2026-11-02: "sólo el reloj con los ojos parpadeando en el centro" (tools/caras, ausente_reloj); si aún no
           está en la SD, la de dormida */
        k210_set_fallback(ABSENT_FACE, NULL);
        k210_play_path(ABSENT_CLOCK_PATH, NULL, 0);
        absent_face_ms = now + ABSENT_FACE_EVERY_MS;
    }
    was = hs;
    if (now - last_motion_ms >= F2_MOTION_STEP_MS) {
        last_motion_ms = now;
        motion_step();
    }
}

static int64_t touch_stream_until, touch_stream_last;   /* tecla G: el toque cada 200 ms durante 10 s */

void app_step(void)
{
    int64_t now = hal_now_ms();
    k210_poll();
    /* mudanza (body.c): sin el turno, Alma no corre aquí */
    body_step();
    int here = body_runs();
    if (here && asleep) body_wake();
    else if (!here && !asleep) app_body_sleep("sin turno");
    ota_step(now);   /* la prueba de un firmware nuevo corre aunque Alma no esté (ota.h) */
    static int rlog_auto = 1;
    if (rlog_auto && now > RLOG_BOOT_MS) { rlog_auto = 0; if (rlog_on()) { hal_log("enlace: registro por Wi-Fi: fin de las 4 h del arranque"); rlog_set(0); } }
    if (now - bat_report_ms >= (bat_test ? BAT_TEST_REPORT_MS : BAT_REPORT_MS)) {   /* la curva de la batería, al servidor (relay: bateria.csv) */
        bat_report_ms = now;
        char extra[192];
        snprintf(extra, sizeof extra, ",\"pct\":%.0f,\"mv\":%d,\"carga\":%d,\"estado\":%d,\"sin_alma\":%d,\"servo_s\":%.0f,\"prueba\":%d",
                 A.soc_pct, hal_battery_mv(), A.on_charger, (int)A.state, asleep, A.servo_active_s_today, bat_test);
        outbox_event("bateria", extra);
    }
    if (fainted) {   /* desmayada: solo espera el cargador (el enlace y el reporte de batería siguen arriba) */
        hal_sensors hs;
        hal_sensors_read(&hs);
        if (hs.on_charger) {
            fainted = 0;
            empty_since = -1;
            A.t_last = app_now_s();   /* apagada no vivió ese rato */
            A.state = ST_AWAKE;
            hal_log("desmayo: la pusieron a cargar; revive débil y triste (secuela %.2f)", alma_faint_rec(&A, app_now_s()));
        } else {
            base_servos(now);
            return;
        }
    }
    {   /* Home Station por Bluetooth (main/ble_base.c): por ahora solo se anota, para calibrar (dueño, 2026-11-05) */
        static int64_t ble_log_ms;
        static int ble_last_chg = -1, ble_said_none;
        int rssi, chg = A.on_charger + perception_on_usb();
        int64_t age;
        int seen = hal_home_ble(&rssi, &age);
        if (seen && (now - ble_log_ms >= 300000 || chg != ble_last_chg)) {
            hal_log("ble: Home Station a %d dBm (hace %lld ms); cargador %s", rssi, (long long)age,
                    !A.on_charger ? "no" : perception_on_usb() ? "USB" : "Home Station");
            ble_log_ms = now;
            ble_last_chg = chg;
        } else if (!seen && !ble_said_none && now > 120000) {
            ble_said_none = 1;
            hal_log("ble: en 2 min no oí a la Home Station (o esta variante no tiene Bluetooth)");
        }
    }
    base_servos(now);
    if (asleep) { vader_t0 = -1; absent_step(now); return; }
    if (!A.on_charger && !perception_on_usb() && A.soc_pct <= FAINT_PCT) {
        if (empty_since < 0) empty_since = now;
        if (now - empty_since >= FAINT_HOLD_MS) {
            hal_log("desmayo: se acabó la batería (%.0f %%, %d mV); guarda su memoria y se queda quieta hasta que la pongan a cargar",
                    A.soc_pct, hal_battery_mv());
            alma_faint(&A, app_now_s());
            motion_stop_now();
            expression_stop(0);
            home_stop("desmayo");
            leave_steps = 0;
            k210_play(FAINT_FACE, NULL, 0);
#if ALMA_MEM_WRITE_ENABLED
            if (mem_wr) alma_mem_flush(&MEM, &A);
#endif
            body_event("desmayo", "{}");   /* a la memoria del cuerpo y respaldo inmediato al servidor */
            fainted = 1;
            return;
        }
    } else empty_since = -1;
    /* la cara de carga al ponerla en la Home Station (dueño, 2026-11-03: "no hizo ningún gesto de estar cargando"); una vez
       por minuto como mucho, porque los contactos a veces parpadean */
    static int was_base;
    static int64_t charge_face_ms = -100000;
    int base = A.on_charger   /* base o USB: RX0 no distingue bien con la base inalámbrica */;
    if (base && !was_base && now - charge_face_ms > 60000 && !home_active() && A.state != ST_REFLEX && A.state != ST_LISTENING) {
        charge_face_ms = now;
        hal_log("base: cargando (cara de carga)");
        k210_play(ARRIVE_FACE, NULL, 0);
    }
    was_base = base;
    vader_step(now);
    /* batería baja: a casa sola (dueño, 2026-10-30: menos de 20 %), con 3 min entre intentos como el original */
    static int64_t home_try_ms = -1000000, off_charger_ms;
    if (A.on_charger || perception_on_usb()) off_charger_ms = now;   /* los contactos parpadean: cuenta desde la última vez */
    /* dueño, 2026-11-05: con la red, ir a cargarse lo decide ella (bhv_go_home); estas reglas quedan para la fórmula y la
       prueba de batería */
    int rules = !A.policy || bat_test;
    if (rules && A.soc_pct < (bat_test ? BAT_TEST_HOME_PCT : HOME_BATTERY_PCT) && !A.on_charger && now - off_charger_ms >= OFF_CHARGER_MS
        && !home_active() && now - home_try_ms > HOME_RETRY_MS) {
        home_try_ms = now;
        home_start("batería baja");
    }
    /* siesta (dueño, 2026-11-02): de día, cansada o aburrida y con menos de NAP_BATTERY_PCT, se va a cargar a la base */
    int night = alma_in_night_window(&A, app_now_s());
    if (!A.policy && !bat_test && now > NAP_BOOT_MS && !night && !A.on_charger && !perception_on_usb() && !home_active() && A.soc_pct < NAP_BATTERY_PCT
        && (alma_need(&A, NEED_REST) > NAP_REST || A.simple_mood == SM_BORED || A.simple_mood == SM_SLEEPY)
        && A.state != ST_REFLEX && A.state != ST_LISTENING && now - nap_try_ms > NAP_RETRY_MS && now - home_try_ms > HOME_RETRY_MS) {
        nap_try_ms = home_try_ms = now;
        home_start("siesta: cansada y con poca batería");
    }
    /* bajarse de la base (dueño, 2026-11-02): cargada, de día y viéndote, unos pasos al frente (R14 no aplica a estos) */
    int who = -1;
    int64_t seen = perception_last_who(&who);
    if (!A.policy && !night && A.on_charger && !perception_on_usb() && A.soc_pct >= LEAVE_BASE_PCT && who == 0 && seen >= 0
        && now - seen < 3000 && A.state == ST_AWAKE && !home_active() && now - leave_try_ms > LEAVE_RETRY_MS) {
        leave_try_ms = now;
        leave_steps = LEAVE_STEPS;
        perception_leaving_base(1);
        hal_log("base: cargada (%.0f %%) y te ve: se baja", A.soc_pct);
    }
    if (leave_check_ms == -1 && leave_steps == LEAVE_STEPS - 1 && !motion_active()) leave_check_ms = now + 2000;   /* el cargador tarda ~1 s */
    if (leave_check_ms > 0 && now >= leave_check_ms) {
        leave_check_ms = 0;
        hal_sensors hs;
        hal_sensors_read(&hs);
        if (hs.on_charger) { leave_steps = 0; hal_log("base: tras un paso sigue cargando: es el cable USB, se queda"); }
        else hal_log("base: tras un paso ya no carga: era la Home Station, sigue bajando");
    }
    if (leave_steps > 0 && !motion_active() && (leave_check_ms == 0 || (leave_check_ms == -1 && leave_steps == LEAVE_STEPS))) {
        alma_motion_opt o;
        memset(&o, 0, sizeof o);
        o.n = 1;
        o.hhmm0 = o.hhmm1 = -1;
        snprintf(o.mot[0], sizeof o.mot[0], "explore_foward1");
        leave_steps = motion_play(&o, 0, 0) == MOTION_OK ? leave_steps - 1 : 0;
    } else if (leave_steps == 0 && !motion_active()) perception_leaving_base(0);
    /* hora de dormir (dueño, 2026-11-01): de 20:00 a 8:00, cuando el núcleo la manda a descansar fuera de la base, va
       sola; si no llega en HOME_NIGHT_TRIES intentos, duerme donde está. Con el USB puesto ya cuenta como base (abajo) */
    static int bed_tries;
    if (!alma_in_night_window(&A, app_now_s())) bed_tries = 0;
    else if (A.state == ST_RESTING && !A.on_charger && !home_active() && now - home_try_ms > HOME_RETRY_MS) {
        if (bed_tries < HOME_NIGHT_TRIES) {
            bed_tries++;
            home_try_ms = now;
            home_start("hora de dormir");
        } else {
            hal_log("hora de dormir: no llegó a la base en %d intentos, duerme aquí", HOME_NIGHT_TRIES);
            alma_sleep_here(&A);
            bed_tries = HOME_NIGHT_TRIES + 1;
        }
    }
    home_step();
    forget_step();
    voice_step();
    vision_step();
    fiesta_step(now);
    backup_step();
    hunger_step();
    repertorio_step(now);
    A.trick_new = repertorio_new_tricks();
    if (show_test_sticker && k210_file_state_get() != K210_FILE_BUSY) {
        if (k210_file_state_get() == K210_FILE_OK) k210_sticker(1);
        show_test_sticker = 0;
    }
    if (play_test_avi && k210_file_state_get() != K210_FILE_BUSY) {
        if (k210_file_state_get() == K210_FILE_OK) k210_play_path("/test/alma_test.avi", NULL, 0);
        play_test_avi = 0;
    }
    if (now < touch_stream_until && now - touch_stream_last >= 200) { touch_stream_last = now; hal_touch_debug(); }
    alma_sensors s = {A.soc_pct, A.on_charger};
    /* máquina de estados de los bordes: durante un movimiento de reflejo y 500 ms después, no se dispara otro */
    if (A.state == ST_REFLEX && motion_active()) perception_hold_edges(now + 500);
    if (motion_active()) perception_moving(now);
    /* dueño, 2026-11-05: "si está haciendo un movimiento que no detecte sensores, hasta que lo termine". Sus animaciones
       (mirar abajo, bailar, gestos) inclinan los pies y los sensores pierden la mesa un instante: no es borde. Al terminar
       se vuelve a revisar desde cero (edge_recheck). Caminando sí revisa cada paso (regla del dueño, 2026-10-29) */
    if (motion_active() && !motion_walking()) perception_hold_edges(now + 400);
    perception_poll_sensors(&s);   /* los reflejos salen de aquí en el acto */
    alma_near(&A, perception_front_mm(), app_now_s());   /* qué tan cerca le interesa lo decide la red */
    /* ladeada: solo cuenta quieta 1.5 s (no a media animación ni volviendo a casa; 2026-11-05 17:58 se quiso acomodar
       por la inclinación de su propio giro) */
    static int64_t still_since;
    if (motion_active() || home_active() || leave_steps) still_since = now;
    float ta, tb;
    if (perception_tilt(&ta, &tb)) {
        if (now - still_since >= 1500) alma_tilt(&A, ta, tb, app_now_s());
        else alma_tilt(&A, 0, 0, app_now_s());
    }
    {   /* la base cerca (red v8): encima −20…−30 dBm, a un par de metros ~−50; con cargador, encima */
        int rssi;
        int64_t age;
        A.base_near = A.on_charger ? 1.0f : hal_home_ble(&rssi, &age) && age < 10000 ? fminf(1.0f, fmaxf(0.0f, (rssi + 75) / 45.0f)) : 0.0f;
    }
    while (q_n && catchup_left <= 0) {
        alma_ev e = q[q_head];
        q_head = (q_head + 1) % QMAX;
        q_n--;
        deliver(&e);
    }
    if (catchup_left > 0) catchup_step();
    else if (now - last_tick_ms >= F2_TICK_MS) {
        last_tick_ms = now;
        ran = 1;
#if ALMA_DEV_MOTION_ON_USB
        /* desarrollo con USB (dueño, 2026-10-30: "saltate la restricción de la base, está por USB"): con el USB el núcleo
           lo ve fuera de la base, así camina, explora y busca. En la Home Station (RX0 = 0) sigue en la base y carga */
        /* 2026-10-31: pero en su ventana de noche el USB cuenta como base, para que duerma y haga el pase nocturno
           (con el USB siempre puesto nunca dormía y no había diario) */
        if (usb_motion && perception_on_usb() && !alma_in_night_window(&A, app_now_s())) s.on_charger = 0;
#endif
        alma_tick(&A, app_now_s(), &s);
#if ALMA_MEM_WRITE_ENABLED
        if (mem_wr) alma_mem_tick(&MEM, &A, app_now_s());
#endif
    }
    executor_step(app_now_s());
    if (now - last_motion_ms >= F2_MOTION_STEP_MS) {
        last_motion_ms = now;
        motion_step();
    }
}

/* ---- consola de desarrollo: las teclas de sesion1 que siguen teniendo sentido, más eventos inyectados ---- */
static void help(void)
{
    hal_log("=== alma-f2 === (ALMA_DEV_MOTION_ON_USB=%d, ALMA_MEM_WRITE_ENABLED=%d, ALMA_F2_API=%d, ALMA_SERVOS_DISABLED=%d)",
            ALMA_DEV_MOTION_ON_USB, ALMA_MEM_WRITE_ENABLED, ALMA_F2_API, ALMA_SERVOS_DISABLED);
    hal_log("  h ayuda  i estado  b k210_boot  w stay_wink_1  V revisar las animaciones de la SD  l listen_and_think (CRC-8)  L listen_and_think (suma)");
    hal_log("  0 o espacio PARO (servos quietos)  x soltar los 4 servos  r registro crudo del K210 on/off");
    hal_log("  R<nombre>Enter registrar la cara que está frente a la cámara (Esc cancela)");
    hal_log("  N la red que decide sí / no (sin ella, la fórmula de siempre)");
    hal_log("  marcha de prueba: W adelante  S atrás  A girar izquierda  D girar derecha (R14 y presupuesto; 0 = PARO)");
    hal_log("  T gesto: 20 s en el modo de piedra-papel-tijera (enséñale la mano; registra cada 3F)");
    hal_log("  K subir el sticker de prueba (0:/png/sticker.png) y encimarlo (59 01)  U quitarlo (59 03)");
    hal_log("  J subir alma_test.avi al K210 (/test/) y mostrarla en la pantalla  f modo caras (38 01) y 10 respuestas completas  X<CMD><D0> orden de prueba  g sensores  G toque 10 s");
    hal_log("  eventos: k EV_WAKE_WORD  p EV_TOUCH_PET  t EV_TOUCH_TAP  u EV_PICKED_UP  n EV_PUT_DOWN  z EV_SHAKEN");
    hal_log("           c EV_CLIFF  o EV_LOUD_SOUND  e EV_CHARGING_ON  E EV_CHARGING_OFF  d orden dance  v EV_VOICE_FAILED");
}

static void status(void)
{
    static const char *const ST[] = {"ST_BOOT", "ST_AWAKE", "ST_PERFORMING", "ST_RESTING", "ST_SLEEPING", "ST_LISTENING", "ST_REFLEX"};
    hal_log("estado: %s, ánimo %.2f, batería %.0f%%, %s, K210 %s, frames desconocidos %lu, cuadros de paso saltados %lu, "
            "servo hoy %.1f / %.1f s, GPIO26 %s",
            ST[A.state], A.mood, A.soc_pct, A.on_charger ? "en la base" : "fuera de la base",
            k210_get_state() == K210_READY ? k210_boot_used() : "no listo", (unsigned long)perception_unknown_frames(),
            (unsigned long)motion_skipped_gait_frames(), A.servo_active_s_today, alma_budget_s(&A),
            motion_gpio26_locked() ? "bloqueado" : "libre");
    /* PRUEBA-MEMORIA.md: la personalidad y el bienestar deben ser los mismos después de un reinicio */
    hal_log("personalidad: día %d, valentía %.2f, energía %.2f, sociabilidad %.2f, juego %.2f, impulsividad %.2f; "
            "bienestar %.0f (puntos de anoche %d%+d), valencia %.2f", A.age_days, A.trait[TRAIT_BOLDNESS], A.trait[TRAIT_ENERGY],
            A.trait[TRAIT_SOCIABILITY], A.trait[TRAIT_PLAYFULNESS], A.trait[TRAIT_IMPULSIVITY], A.wellbeing, A.wb_day_points,
            A.wb_day_adjust, A.affect_valence);
    /* PRUEBA-ROBOT.md 2.2: sin USB no hay consola; al reconectar se ve si el cargador llegó a bajar */
    int off = 0, on = 0;
    int64_t last_off = -1, last_on = -1;
    for (int i = 0; i < ev_n; i++) {
        const app_ev_log *l = &evlog[(ev_first + i) % F2_LOG_EVENTS];
        if (l->type == EV_CHARGING_OFF) { off++; last_off = l->t_ms; }
        if (l->type == EV_CHARGING_ON) { on++; last_on = l->t_ms; }
    }
    hal_log("cargador: %d desconexiones (última t=%lld ms), %d conexiones (última t=%lld ms), en los últimos %d eventos",
            off, (long long)last_off, on, (long long)last_on, ev_n);
    perc_face lf;
    int64_t t = perception_last_face(&lf);
    hal_log("caras: %lu sondeos, %lu respuestas, %lu con cara, %lu cambios", (unsigned long)k210_face_polls(),
            (unsigned long)k210_face_replies(), (unsigned long)perception_face_hits(), (unsigned long)perception_face_changes());
    if (t >= 0)
        hal_log("caras: la última, hace %lld s: id=%d \"%s\" x=%d y=%d w=%d h=%d", (long long)((hal_now_ms() - t) / 1000),
                lf.person_id, lf.name, lf.x, lf.y, lf.w, lf.h);
}

void app_console_help(void) { help(); }

/* Marcha de prueba (HALLAZGOS §5): un .mot de explore_*, con las mismas reglas que una conducta (R14, presupuesto). La
   marcha sigue fuera del sorteo (GAIT_MODE_AVAILABLE = 0) hasta verla en el robot. */
static void test_walk(const char *mot)
{
    static alma_motion_opt o;
    memset(&o, 0, sizeof o);
    o.n = 1;
    snprintf(o.mot[0], sizeof o.mot[0], "%s", mot);
    motion_result r = motion_play(&o, A.on_charger, 0);
    hal_log("marcha de prueba %s: %s", mot, r == MOTION_OK ? "en marcha" : "rechazada (ver arriba)");
}

/* R<nombre>Enter: registro de cara (hal_k210). Mientras se escribe el nombre, las teclas son letras, no órdenes. */
static char reg_name[K210_FACE_NAME_MAX + 1];
static int reg_typing, reg_n;
/* M<avi>:<mp3>Enter: prueba una cara de /spiffs/avi con su sonido de /spiffs/mp3 (sin ":<mp3>", sin sonido). Para
   averiguar qué canciones tiene la SD (dueño, 2026-11-02: "cuando canta no reproduce audios") */
static char media_name[80];
static int media_typing, media_n;

/* X + 4 dígitos hex (CMD D0): orden corta de prueba al K210, solo de la lista de k210_send_debug */
static int hex_typing, hex_n;
static char hex_buf[5];

static int hex_key(char c)
{
    if (!hex_typing) return 0;
    int v = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
    if (v < 0) { hex_typing = 0; hal_log("orden de prueba: cancelada"); return 1; }
    hex_buf[hex_n++] = c;
    if (hex_n == 4) {
        hex_typing = 0;
        unsigned cmd = 0, d0 = 0;
        hex_buf[4] = 0;
        sscanf(hex_buf, "%2x%2x", &cmd, &d0);
        k210_send_debug((uint8_t)cmd, (uint8_t)d0);
    }
    return 1;
}

static int media_key(char c)
{
    if (!media_typing) return 0;
    if (c == '\r' || c == '\n') {
        media_typing = 0;
        media_name[media_n] = 0;
        char *mp3 = strchr(media_name, ':');
        if (mp3) *mp3++ = 0;
        hal_log("prueba de cara: %s.avi con %s%s", media_name, mp3 && *mp3 ? mp3 : "(sin sonido)", mp3 && *mp3 ? ".mp3" : "");
        if (media_n) k210_play(media_name, mp3 && *mp3 ? mp3 : NULL, 0);
    } else if (c == 0x1B) {
        media_typing = 0;
    } else if (media_n < (int)sizeof media_name - 1 && c > 0x20 && c < 0x7F) {
        media_name[media_n++] = c;
    }
    return 1;
}

static int name_key(char c)
{
    if (!reg_typing) return 0;
    if (c == '\r' || c == '\n') {
        reg_typing = 0;
        reg_name[reg_n] = 0;
        if (reg_n) k210_face_register(reg_name);
        else hal_log("registro de cara: sin nombre, cancelado");
    } else if (c == 0x1B) {
        reg_typing = 0;
        hal_log("registro de cara: cancelado");
    } else if (reg_n < K210_FACE_NAME_MAX && c > 0x20 && c < 0x7F) {
        reg_name[reg_n++] = c;
    }
    return 1;
}

void app_console_key(char c)
{
    alma_ev e = {EV_COUNT, -1, -1, -1, 0, 0, 0, 0};
    /* cada byte recibido queda en el log (1A, A10: una 'c' que no llegó a la app no dejó rastro); el paro va antes */
    if (c == '0' || c == ' ' || c == 'x') { motion_stop_now(); home_stop("PARO"); }   /* también la vuelta a casa (2026-11-02) */
    hal_log("tecla recibida 0x%02x '%c'", (unsigned char)c, c >= 0x20 && c < 0x7F ? c : '?');
    if (name_key(c) || media_key(c) || hex_key(c)) return;
    switch (c) {
    case 'J': {   /* HALLAZGOS §14: envío por SPI; al confirmar el K210, se reproduce desde /test/ */
        size_t n;
        const uint8_t *avi = hal_test_avi(&n);
        if (k210_file_send("test", "alma_test.avi", avi, n) == 0) play_test_avi = 1;
        return;
    }
    case 'K': {   /* sticker encima de la cara (dueño, 2026-11-02): sube el PNG de prueba a 0:/png/sticker.png y 59 01 */
        size_t n;
        const uint8_t *png = hal_test_sticker(&n);
        if (k210_image_send("sticker.png", png, n) == 0) show_test_sticker = 1;
        return;
    }
    case 'U': k210_sticker(0); return;   /* quita el sticker (59 03) */
    case 'W': test_walk("explore_foward1"); return;
    case 'S': test_walk("explore_back_away1"); return;
    case 'A': test_walk("explore_turn_left1"); return;
    case 'D': test_walk("explore_turn_right1"); return;
    case 'M': media_typing = 1; media_n = 0; hal_log("prueba de cara: escribe <avi>:<mp3> y Enter (Esc cancela)"); return;
    case 'R': reg_typing = 1; reg_n = 0; hal_log("registro de cara: escribe el nombre y Enter (Esc cancela)"); return;
    case '\r': case '\n': return;
    case 'h': case '?': help(); return;
    case 'N': brain_on = !brain_on; brain_setup(); return;
    case 'i': status(); return;
    case 'b': k210_boot(); return;
    case 'f': k210_face_mode(10); return;
    case 'G': touch_stream_until = hal_now_ms() + 10000; hal_log("toque: 10 s de lecturas cada 200 ms"); return;
    case 'g': {
        hal_sensors_debug();
        hal_sensors hs;
        hal_sensors_read(&hs);
        int e = perception_edges_now();
        hal_log("piso por pie: izq. adelante %d atrás %d, der. adelante %d atrás %d; borde ahora: %s", hs.floor[HAL_FOOT_L][HAL_FLOOR_FRONT],
                hs.floor[HAL_FOOT_L][HAL_FLOOR_REAR], hs.floor[HAL_FOOT_R][HAL_FLOOR_FRONT], hs.floor[HAL_FOOT_R][HAL_FLOOR_REAR],
                e == 3 ? "adelante y atrás" : e == 1 ? "adelante" : e == 2 ? "atrás" : "ninguno");
        return;
    }
    case 'X': hex_typing = 1; hex_n = 0; hal_log("orden de prueba: 4 dígitos hex (CMD D0)"); return;
    case 'w': k210_play("stay_wink_1", NULL, 0); return;
    case 'V': {   /* revisión de la SD: el catálogo y las caras fijas del firmware */
        static const char *names[440];
        static const char *const FIXED[] = {ABSENT_FACE, ARRIVE_FACE, GONE_FACE, "EMO_flower_full", "listen_and_think", "mood_happy",
                                            "mood_sad", VISION_OWNER_GESTURE, "stay_wink_1", "stay_wink_2", "stay_wink_3",
                                            "stay_wink_4", "stay_wink_6", "stay_wink_7", "stay_wink_8", "stay_wink_9",
                                            "stay_a_b", "stay_a_c", "stay_a_d", "stay_b_a", "stay_b_c", "stay_b_d",
                                            "stay_c_a", "stay_c_b", "stay_c_d", "stay_d_a", "stay_d_b", "stay_d_c"};
        int n = 0;
        for (size_t i = 0; i < sizeof FIXED / sizeof *FIXED; i++) names[n++] = FIXED[i];
        n += expression_avis(names + n, (int)(sizeof names / sizeof *names) - n);
        if (k210_check_avis(names, n) < 0) hal_log("revisión de la SD: el K210 está ocupado; prueba otra vez");
        return;
    }
    case 'H': k210_base_probe(20); return;   /* ¿ve la Home Station? (CASA.md) */
    case 'T': if (k210_gesture_probe(20)) hal_log("gesto: la cámara está ocupada; prueba otra vez"); return;   /* tijera: modo 3 durante 20 s */
    case 'Q': {   /* prueba de caras (CARAS2.md): el sondeo 0A puede cortar el reconocimiento; 200 → 1000 → 2000 ms */
        k210_face_poll_ms = k210_face_poll_ms < 1000 ? 1000 : k210_face_poll_ms < 2000 ? 2000 : 200;
        hal_log("sondeo de caras cada %d ms (modo %d)", k210_face_poll_ms, k210_face_phase() == 3 ? 4 : 1);
        return;
    }
    case 'l': case 'L': {
        k210_cs_mode m = k210_payload_mode;
        k210_payload_mode = c == 'l' ? K210_CS_CRC8 : K210_CS_SUM;
        k210_play("listen_and_think", "listen_and_think_000", 1);
        k210_payload_mode = m;
        return;
    }
    case '0': case ' ': hal_log("PARO"); return;
    case 'x': for (int i = 0; i < HAL_SERVOS; i++) hal_servo_release(i); hal_log("servos sueltos"); return;
    case 'r': k210_log_raw = !k210_log_raw; hal_log("registro crudo del K210 %s", k210_log_raw ? "encendido" : "apagado"); return;
    case 'k': e.type = EV_WAKE_WORD; break;
    case 'p': e.type = EV_TOUCH_PET; e.value = 1500; break;
    case 't': e.type = EV_TOUCH_TAP; break;
    case 'u': e.type = EV_PICKED_UP; break;
    case 'n': e.type = EV_PUT_DOWN; break;
    case 'z': e.type = EV_SHAKEN; e.value = 1; break;
    case 'c': e.type = EV_CLIFF; break;
    case 'C': home_start("tecla C"); return;   /* prueba: volver a la Home Station ahora */
    case 'o': e.type = EV_LOUD_SOUND; break;
    case 'e': e.type = EV_CHARGING_ON; break;
    case 'E': e.type = EV_CHARGING_OFF; break;
    case 'd': e.type = EV_REMOTE_COMMAND; e.action_id = ACT_DANCE; break;
    case 'v': e.type = EV_VOICE_FAILED; break;
    default: hal_log("tecla '%c' sin uso (h = ayuda)", c >= 0x20 && c < 0x7F ? c : '?'); return;
    }
    hal_log("consola: %s", app_ev_name(e.type));
    app_post(&e);
}
