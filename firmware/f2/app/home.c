#include "home.h"
#include "app.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "f2_hal.h"
#include "hal_k210.h"
#include "motion_player.h"
#include "outbox.h"
#include "perception.h"

/* CASA.md [BOBBY-ARTE]: centro 160, tolerancia 29 px, giro 0.3 × error; distancia por la altura h del recuadro */
#define CX_MID         160
#define CX_TOL         100      /* robot, 2026-10-30: un giro de fábrica (~30°) mueve la base ~75 px; con 29 oscilaba. Dueño: girar menos y avanzar */
#define TURN_PER_PX    0.3f
#define H_FAR          35       /* ≤: dos pasos */
#define H_MID          50       /* ≤: un paso; >: ya está pegada a la base (home_near_base) */
#define CX_TOL_NEAR    60       /* cerca: un giro entero la mueve ~230 px (sin el USB, 40–48°, medido 2026-11-02); medio giro ~115: se gira si la acerca */
#define CENTER_NEAR_MAX 3       /* cerca, medios giros para centrarla como mucho (oscilaba) */
#define H_NEAR         95       /* sin láser: ≥ es la distancia de la media vuelta (2026-11-02: h ≈ 130 a 88 mm, 113 a 97 mm) */
#define TURN_MM_MIN    120      /* con el láser: más lejos que TURN_MM_MAX, un paso; más cerca que esto, un paso atrás; */
#define TURN_MM_MAX    160      /* entre las dos, media vuelta. Medido 2026-11-02: a 88–97 mm la base lo atoraba al girar */
#define SEARCH_STEP    15.0f    /* grados por giro al buscar */
#define SEARCH_LAPS    3
#define TURN_TOL       5.0f     /* si al acabar un giro faltan más que esto, otro */
#define TURN_MAX_REPS  20       /* tope de seguridad (~32° por giro; 11 = una vuelta, medido 2026-11-02) */
#define TURN_CHECK     3        /* dueño, 2026-11-02: si en 3 giros no avanza ni TURN_MIN_DEG, está atorada: */
#define TURN_MIN_DEG   5.0f     /* salta de lado para alejarse y vuelve a buscar la base */
#define HOPS           2
#define TURN_BACK      180.0f   /* media vuelta: con el giroscopio hasta 180° (dueño, 2026-11-02) */
#define DOCK_TRIES     14       /* 2026-11-02: con 8 se quedaba a unos centímetros */
#define DOCK_SETTLE_MS 2000
#define DET_FRESH_MS   600
#define SETTLE_MS      1500     /* quieto tras cada giro antes de decidir (robot, 2026-10-30: con 400 ms pasaba frente a la base sin verla) */
#define LOST_MS        5000
#define HOME_MAX_MS    300000   /* el original: 300 s como máximo */
#define OBSTACLE_MM    80       /* el original: un obstáculo a menos de 80 mm se rodea */

static struct {
    home_state st;
    int64_t t0, wait_until, lost_since;
    float yaw0, turn_target, searched;
    int laps, tries, steps_left, turn_left, turn_reps, turn_stuck, center_turns;
    float turn_chk;
    const char *step_mot;
} H;

static const char *const NAME[] = {"apagada", "buscando", "acercándose", "media vuelta", "subiendo", "en la base", "falló"};

home_state home_get(void) { return H.st; }
/* medido 2026-11-02: pegado a la base, su orilla y su rampa se leen como "sin piso" (borde adelante a h ≈ 55; al subir
   de espaldas, atrás). Ahí un borde no cancela la vuelta */
int home_near_base(void)
{
    if (H.st == HOME_TURN || H.st == HOME_DOCK) return 1;
    if (H.st != HOME_APPROACH) return 0;
    k210_base_det d;
    int64_t age = k210_base_last(&d);
    return age >= 0 && age < DET_FRESH_MS && d.found && d.h > H_MID;
}

int home_active(void) { return H.st != HOME_OFF && H.st != HOME_DONE && H.st != HOME_FAIL; }

static void go(home_state s)
{
    hal_log("casa: %s → %s", NAME[H.st], NAME[s]);
    H.st = s;
}

static void play(const char *mot)
{
    static alma_motion_opt o;
    memset(&o, 0, sizeof o);
    o.n = 1;
    o.hhmm0 = o.hhmm1 = -1;
    snprintf(o.mot[0], sizeof o.mot[0], "%s", mot);
    H.turn_target = 0;   /* un paso no se corta por un giro anterior */
    motion_play(&o, 0, 0);
}

/* girar `deg` grados (con signo: + izquierda) con el giroscopio; el .mot de giro se corta al llegar */
static void turn(float deg)
{
    play(deg >= 0 ? "explore_turn_left1" : "explore_turn_right1");
    H.yaw0 = hal_yaw_deg();
    H.turn_target = fabsf(deg);
    H.turn_left = deg >= 0;
    H.turn_reps = 1;
    H.turn_chk = 0;
    H.turn_stuck = 0;
}
static int turning_done(void)
{
    float d = hal_yaw_deg() - H.yaw0;
    if (fabsf(d) >= H.turn_target) { motion_stop_now(); hal_log("casa: giro cortado a %.0f° (giroscopio)", d); return 1; }
    /* medido 2026-11-02: cada giro de fábrica da ~32°; la media vuelta (170°) se quedaba en el primero. Si el giro
       acaba antes de llegar, otro (salvo 360 = "un giro completo, sin cortarlo", al centrar la base) */
    if (!motion_active() && H.turn_target < 359.0f && fabsf(d) < H.turn_target - TURN_TOL && H.turn_reps < TURN_MAX_REPS) {
        if (H.turn_reps % TURN_CHECK == 0) {   /* cada 3 giros: ¿avanzó? */
            if (fabsf(fabsf(d) - H.turn_chk) < TURN_MIN_DEG) {
                hal_log("casa: no gira (%d giros, %.0f° en los últimos %d)", H.turn_reps, fabsf(fabsf(d) - H.turn_chk), TURN_CHECK);
                H.turn_stuck = 1;
                return 1;
            }
            H.turn_chk = fabsf(d);
        }
        float target = H.turn_target;
        play(H.turn_left ? "explore_turn_left1" : "explore_turn_right1");   /* play() pone turn_target en 0 */
        H.turn_target = target;
        H.turn_reps++;
        return 0;
    }
    if (!motion_active()) { hal_log("casa: giro completo, %.0f° en %d giros (giroscopio; pedido %.0f°)", d, H.turn_reps, H.turn_target); return 1; }
    return 0;
}

static int on_home_station(void)
{
    hal_sensors s;
    hal_sensors_read(&s);
    /* cualquier cargador: con la base inalámbrica RX0 a veces sale alto y parece USB (2026-11-03, daba giros ya en la base);
       solo con "usb on" (pruebas con el cable) el USB no cuenta como casa */
    return s.on_charger && !(s.on_usb && app_usb_motion_on());
}

void home_start(const char *why)
{
    if (home_active()) return;
    if (on_home_station()) { hal_log("casa: ya está en la Home Station (%s)", why); H.st = HOME_DONE; return; }
    memset(&H, 0, sizeof H);
    H.t0 = hal_now_ms();
    hal_log("casa: volver a la Home Station (%s)", why);
    k210_base_mode(1);
    H.st = HOME_SEARCH;
}

void home_stop(const char *why)
{
    if (!home_active()) return;
    motion_stop_now();
    k210_base_mode(0);
    hal_log("casa: cancelada (%s)", why);
    H.st = HOME_OFF;
}

static void fail(const char *why)
{
    motion_stop_now();
    k210_base_mode(0);
    hal_log("casa: no llegó (%s)", why);
    H.st = HOME_FAIL;
    hal_sensors hs;   /* al celular (notify.py avisa si la batería está baja) */
    hal_sensors_read(&hs);
    char extra[96];
    snprintf(extra, sizeof extra, ",\"battery_pct\":%.0f,\"why\":\"%s\"", hs.soc_pct, why);
    outbox_event("home_failed", extra);
}

void home_step(void)
{
    if (!home_active()) return;
    int64_t now = hal_now_ms();
    if (now - H.t0 > HOME_MAX_MS) { fail("más de 300 s"); return; }
    if (on_home_station()) {
        motion_stop_now();
        k210_base_mode(0);
        hal_log("casa: en la Home Station (cargador y RX0 = 0) a los %lld s", (long long)((now - H.t0) / 1000));
        H.st = HOME_DONE;
        return;
    }
    if (now < H.wait_until) return;
    k210_base_det d;
    int64_t age = k210_base_last(&d);
    int seen = age >= 0 && age < DET_FRESH_MS && d.found;

    switch (H.st) {
    case HOME_SEARCH:
        if (motion_active() && H.turn_target == 0) return;   /* un salto de lado (atorada), no un giro */
        if (H.steps_left > 0) { H.steps_left--; play(H.step_mot); return; }
        if (motion_active() && !turning_done()) return;
        if (seen) { H.lost_since = 0; go(HOME_APPROACH); return; }
        if (H.searched >= 360.0f) {
            H.searched = 0;
            if (++H.laps >= SEARCH_LAPS) { fail("no vio la base en 3 vueltas"); return; }
        }
        H.searched += SEARCH_STEP;
        turn(SEARCH_STEP);
        H.wait_until = now + SETTLE_MS;   /* deja al K210 mirar quieto antes de decidir otra vez */
        return;
    case HOME_APPROACH:
        if (motion_active()) { if (H.turn_target > 0 && turning_done()) H.turn_target = 0; return; }
        if (H.steps_left > 0) { H.steps_left--; play(H.step_mot); return; }
        if (!seen) {
            if (!H.lost_since) H.lost_since = now;
            if (now - H.lost_since > LOST_MS) { hal_log("casa: la perdió de vista"); H.searched = 0; go(HOME_SEARCH); }
            return;
        }
        H.lost_since = 0;
        int front = perception_front_mm();
        if (front >= 0 && front < OBSTACLE_MM && d.h <= H_MID) {   /* algo entre EMO y la base: atrás, girar y buscar otra vez */
            hal_log("casa: obstáculo a %d mm: lo rodea", front);
            play("explore_back_away1");
            H.searched = 0;
            go(HOME_SEARCH);
            return;
        }
        /* medido 2026-11-02 sin el USB: cerca, un giro de fábrica mueve la base ~230 px y oscilaba 2 min a izquierda y
           derecha. Cerca, como mucho CENTER_NEAR_MAX giros para centrarla; luego sigue (la media vuelta es con giroscopio) */
        if (d.h <= H_MID) H.center_turns = 0;
        if (abs(CX_MID - d.cx) > (d.h > H_MID ? CX_TOL_NEAR : CX_TOL) && (d.h <= H_MID || H.center_turns++ < CENTER_NEAR_MAX)) {
            /* medido en el robot (2026-10-30): al girar a la izquierda la base se mueve a la IZQUIERDA en la imagen
               (cx 142 → 85 → 6), así que para centrar una base con cx < 160 se gira a la derecha */
            if (d.h > H_MID) {   /* cerca: medio giro (dueño, 2026-11-02: 2 pasos en lugar de 4), sin cortarlo */
                play(d.cx < CX_MID ? "explore_turn_right1_half" : "explore_turn_left1_half");
                H.turn_target = 360.0f;   /* para que turning_done no lo corte ni lo repita */
                H.yaw0 = hal_yaw_deg();
            } else turn(d.cx < CX_MID ? -360.0f : 360.0f);   /* un giro completo de fábrica (~30°), sin cortarlo */
            H.wait_until = now + SETTLE_MS;
            return;
        }
        if (d.h <= H_FAR) { H.step_mot = "explore_foward1"; H.steps_left = 1; play(H.step_mot); }
        else if (d.h <= H_MID) play("explore_foward1");
        else {   /* pegada a la base: la distancia exacta con el láser (sin lectura, con el tamaño en la cámara) */
            int mm = perception_front_mm(), laser = mm > 0 && mm < 400;
            if (laser ? mm > TURN_MM_MAX : d.h < H_NEAR) play("explore_foward1");
            else if (laser && mm < TURN_MM_MIN) play("explore_back_away1");
            else { hal_log("casa: cerca (%d mm, h=%d): media vuelta", mm, d.h); k210_base_mode(0); turn(TURN_BACK); go(HOME_TURN); }
        }
        H.wait_until = now + 300;
        return;
    case HOME_TURN:
        if (!turning_done()) return;
        if (H.turn_stuck) {   /* saltos al lado contrario del giro (cliff_L va a la derecha) y a buscarla otra vez */
            H.turn_stuck = 0;
            H.step_mot = H.turn_left ? "cliff_L" : "cliff_R";
            hal_log("casa: atorada: %d saltos de lado (%s) y vuelve a buscar la base", HOPS, H.step_mot);
            H.steps_left = HOPS - 1;
            play(H.step_mot);
            k210_base_mode(1);
            H.searched = 0;
            H.lost_since = 0;
            go(HOME_SEARCH);
            return;
        }
        go(HOME_DOCK);
        return;
    case HOME_DOCK:
        if (motion_active()) return;
        if (H.tries >= DOCK_TRIES) {
            hal_sensors hs;
            hal_sensors_read(&hs);
            if (hs.on_usb) {   /* con el USB no se distingue la base (RX0 alto): se revisa a ojo, sin aviso de falla */
                motion_stop_now();
                hal_log("casa (USB): terminó los %d intentos de subir; con el USB no se sabe si llegó: revísalo a ojo", DOCK_TRIES);
                H.st = HOME_DONE;
                return;
            }
            fail("14 intentos de subir de espaldas");
            return;
        }
        H.tries++;
        {   /* dueño, 2026-11-02: probar con el USB puesto. Lo que miden los pines en cada intento, para aprender la firma
               de la base con el USB (y sin él) */
            hal_power_probe_t pp;
            if (hal_power_probe(&pp) == 0)
                hal_log("casa: intento %d de subir; GPIO36 %d mV, GPIO37 %d mV, GPIO38 %d mV, RX0 %d, cargador %d", H.tries,
                        pp.mv[0], pp.mv[1], pp.mv[2], pp.rx0, pp.charger);
        }
        play("explore_back_away1_alto");   /* paso alto: al empezar la rampa no subía solo (dueño, 2026-11-03) */
        H.wait_until = now + DOCK_SETTLE_MS;   /* el original lee GPIO36, empuja y espera 2 s */
        return;
    default:
        return;
    }
}
