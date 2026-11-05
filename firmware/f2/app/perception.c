#include "perception.h"

#include "home.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "hal_k210.h"
#include "outbox.h"
#include "app.h"

/* Tabla inicial (03, "Lo que el K210 manda al ESP32"). Las caras no van en la tabla: llegan como extendido 0x0A
 * (on_face, más abajo); los gestos (YOLO, 0x3F) por on_gesture. */
static const perc_rule DEFAULT_TABLE[] = {
    {0x47, PERC_KNOWN, EV_COUNT, "CONFIRMADO", "K210 listo tras el reset"},
    /* 03: confirmado en 1B (b1–b3). d0 = 1 detectada / 0 fin de escucha; d1 = sector de la voz (0–11).
       PENDIENTE: 03. direction_deg = d1 · 30 es DERIVADO; sin fórmula confirmada no se llena */
    {0x0B, PERC_EVENT, EV_WAKE_WORD, "CONFIRMADO", "palabra de activación"},
    /* 03 [BOBBY-ARTE]: frames que el K210 manda y que Alma todavía no usa como evento; se registran sin "desconocido" */
    {0x08, PERC_KNOWN, EV_COUNT, "CONFIRMADO", "fin de reproducción (d0 = 0 animación, 1 mp3)"},
    {0x1C, PERC_KNOWN, EV_COUNT, "DERIVADO", "soplido detectado"},
    {0x37, PERC_EVENT, EV_MUSIC, "CONFIRMADO", "música (d0 = 100 oigo, 1 sigue, 2 terminó)"},   /* el original baila (HALLAZGOS §10) */
    {0xFE, PERC_KNOWN, EV_COUNT, "CONFIRMADO", "acuse de frame extendido (d0 = 0xAA aceptado, 0x55 rechazado)"},
    {0x0F, PERC_KNOWN, EV_COUNT, "CONFIRMADO", "resultado del registro de cara (d0 = 1 registrada, 2 falló); lo usa hal_k210"},
    {0x01, PERC_KNOWN, EV_COUNT, "CONFIRMADO", "trozo de audio del micrófono (lo lee hal_k210 por SPI)"},
    {0x0D, PERC_KNOWN, EV_COUNT, "CONFIRMADO", "sector del sonido al detectar habla (lo registra hal_k210)"},
    {0x13, PERC_KNOWN, EV_COUNT, "CONFIRMADO", "trozo de audio por la otra vía (modo 5; lo lee hal_k210 por SPI)"},
};

/* PENDIENTE: 02. Umbral del ToF para EV_OBSTACLE (CALIBRAR con el sensor real) */
#define OBSTACLE_MM 100
/* 04: EV_BATTERY_LOW al 20% */
#define BATTERY_LOW_PCT 20.0f

static const perc_rule *table = DEFAULT_TABLE;
static int table_n = (int)(sizeof DEFAULT_TABLE / sizeof *DEFAULT_TABLE);
static perc_emit_fn emit;
static hal_sensors last;
static int edge_now;               /* bordes de ahora: bit 0 adelante, bit 1 atrás */
static int edge_side;              /* pie entero en el aire: bit 2 izquierdo, bit 3 derecho */
/* Máquina de estados de los bordes (dueño, 2026-10-30): mientras dura un movimiento de reflejo no se dispara otro (el
   propio movimiento inclina los pies y sus sensores dejan de ver la mesa: se ciclaba), y al terminar se espera
   EDGE_SETTLE_MS quieto antes de volver a evaluar. Durante la espera los bordes siguen frenando la marcha. */
#define EDGE_SETTLE_MS 500
static int64_t edge_hold_until = -1;
static int edge_recheck;
/* Sacudida propia (robot, 2026-11-02): react_look_down_2/4 hacen que el IMU pase SHAKE_ON 500 ms y salía EV_SHAKEN sin
   que nadie lo tocara. Durante sus movimientos y SHAKE_SETTLE_MS después no cuenta, salvo en la mano. */
#define SHAKE_SETTLE_MS 700
static int64_t shake_hold_until = -1;
/* Al dejarlo (dueño, 2026-11-02): quieto y derecho en la mano ya cuenta como dejado (como el original) y sus pies
   no ven la mesa: saltaba de lado en la mano. Los bordes esperan PUT_DOWN_SETTLE_MS y luego se evalúan de nuevo */
#define PUT_DOWN_SETTLE_MS 2000
static int gait_dir, swing_foot = -1;
static int have_last, low_sent;
static uint32_t unknown;
static int on_usb;
int perception_on_usb(void) { return on_usb; }

/* ---- caras (03, "Caras"): hal_k210 las pide cada 200 ms; aquí se vuelven eventos ---- */
#define FACE_EVERY_MS 1000   /* DERIVADO: un EV_FACE_SEEN/UNKNOWN por segundo mientras se vea; el núcleo pide < 5 s */
#define FACE_LOST_MS  5000   /* 01: EV_FACE_LOST sin detección por 5 s */
#define FACE_TRACK    8
#define WHO_NOBODY   -1
#define WHO_UNKNOWN  -2

typedef struct { int id; int64_t last_ms; } face_seen_at;
static face_seen_at seen[FACE_TRACK];   /* personas conocidas vistas hace < 5 s */
static int face_who, n_seen;
static int64_t face_sent_ms;
static uint32_t face_changes, face_hits;
static perc_face last_hit;
static int64_t last_hit_ms = -1;
/* la última respuesta de verdad del K210 con cara, ya con el seguimiento de abajo (llegada por cara, body.c 6.2) */
static int last_who = WHO_NOBODY;
static int64_t last_who_ms = -1;
/* Seguimiento (robot, 2026-10-30): el K210 alterna id 0 y 255 para la misma cara en el mismo lugar; a una Alma tímida
   cada "desconocida" la asusta. Una desconocida cuyo centro cae a menos de un ancho de cara de la última conocida, vista
   hace menos de FACE_SAME_MS, se toma como esa persona */
#define FACE_SAME_MS 3000
static perc_face last_known;
static int64_t last_known_ms = -1;
/* Registro automático (dueño, 2026-10-30: "si detecta una cara desconocida durante más de un minuto hay que registrarla,
   identificando que no es la mía"). Una desconocida vista ≥ 60 s sin huecos de más de 20 s (los vistazos son cada 15 s),
   cerca (ancho ≥ 40 px), sin ninguna cara conocida en los últimos 2 min y como mucho un registro cada 10 min. Escribe
   en la SD del K210 (decisión del dueño) */
#define AUTOREG_MS       60000
#define AUTOREG_GAP_MS   20000
#define AUTOREG_OWNER_MS 120000
#define AUTOREG_EVERY_MS 600000
#define AUTOREG_MIN_W    40
#define AUTOREG_MIN_HITS 4
static int64_t unk_first = -1, unk_last = -1, any_known_ms = -1, autoreg_ms = -1;
static int unk_hits;

static char autoreg_name[16];   /* registro en curso: se avisa al celular cuando el K210 lo confirma */

static void autoreg_done(void)
{
    if (!autoreg_name[0]) return;
    k210_reg_state st = k210_face_register_state();
    if (st == K210_REG_RUNNING) return;
    if (st == K210_REG_OK) {
        char extra[48];
        snprintf(extra, sizeof extra, ",\"name\":\"%s\"", autoreg_name);
        outbox_event("new_face", extra);
    }
    autoreg_name[0] = 0;
}

static void autoreg_check(const perc_face *f, int who, int64_t now)
{
    if (who >= 0) { any_known_ms = now; unk_first = -1; unk_hits = 0; return; }
    if (who != WHO_UNKNOWN) return;
    if (unk_first < 0 || now - unk_last > AUTOREG_GAP_MS) { unk_first = now; unk_hits = 0; }
    unk_last = now;
    unk_hits++;
    if (now - unk_first < AUTOREG_MS || unk_hits < AUTOREG_MIN_HITS || f->w < AUTOREG_MIN_W) return;
    if (any_known_ms >= 0 && now - any_known_ms < AUTOREG_OWNER_MS) return;   /* el dueño anda cerca: no */
    if (autoreg_ms >= 0 && now - autoreg_ms < AUTOREG_EVERY_MS) return;
    if (k210_face_register_state() == K210_REG_RUNNING) return;
    char name[16];
    snprintf(name, sizeof name, "amigo_%u", (unsigned)((now / 1000) % 100000));
    if (k210_face_register(name) == 0) {
        hal_log("perception: cara desconocida %lld s seguidos, sin el dueño en 2 min: se registra como \"%s\"",
                (long long)((now - unk_first) / 1000), name);
        autoreg_ms = now;
        snprintf(autoreg_name, sizeof autoreg_name, "%s", name);
        unk_first = -1;
        unk_hits = 0;
    }
}

static void log_unknown(const char *why, const uint8_t *p, size_t n);

static int32_t le32(const uint8_t *b) { return (int32_t)((uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24); }

int perception_parse_face(const uint8_t *p, size_t n, perc_face *out)
{
    if (n < 7 + 24 || p[2] != 0xFF || p[5] != 0x0A) return -1;
    size_t body = (size_t)p[3] | (size_t)p[4] << 8;
    if (body < 24 || n < 7 + body) return -1;
    const uint8_t *b = p + 7;
    out->x = le32(b);
    out->y = le32(b + 4);
    out->w = le32(b + 8);
    out->h = le32(b + 12);
    out->has_face = le32(b + 16) == 1;
    out->person_id = le32(b + 20);
    size_t k = 0;
    for (size_t i = 24; i < body && b[i] && k + 1 < sizeof out->name; i++) out->name[k++] = b[i] >= 0x20 && b[i] < 0x7F ? (char)b[i] : '?';
    out->name[k] = 0;
    return 0;
}

static void face_track(int id, int64_t now)
{
    for (int i = 0; i < n_seen; i++)
        if (seen[i].id == id) { seen[i].last_ms = now; return; }
    if (n_seen < FACE_TRACK) seen[n_seen++] = (face_seen_at){id, now};
}

/* Las personas conocidas que llevan 5 s sin verse se pierden, conteste o no el K210 */
static void face_expire(int64_t now)
{
    /* entre vistazos (ojos vivos en el modo 1) no hay detección: el tiempo sin ver a alguien solo corre en los vistazos,
       y quien estaba sigue estando (un EV_FACE_SEEN por segundo con su último recuadro) */
    static int64_t last_ms_seen_check;
    int64_t dt = last_ms_seen_check ? now - last_ms_seen_check : 0;
    last_ms_seen_check = now;
    if (!k210_scanning() && k210_face_phase() >= 3) {
        for (int i = 0; i < n_seen; i++) seen[i].last_ms += dt;
        if (n_seen && last_known_ms >= 0 && now - face_sent_ms >= FACE_EVERY_MS) {
            face_sent_ms = now;
            for (int i = 0; i < n_seen; i++) {
                alma_ev e = {EV_FACE_SEEN, seen[i].id, -1, -1, (float)last_known.x + (float)last_known.w / 2,
                             (float)last_known.y + (float)last_known.h / 2, (float)last_known.w, 0};
                emit(&e);
            }
        }
        return;
    }
    for (int i = 0; i < n_seen;) {
        if (now - seen[i].last_ms < FACE_LOST_MS) { i++; continue; }
        alma_ev e = {EV_FACE_LOST, seen[i].id, -1, -1, 0, 0, 0, 0};
        hal_log("perception: cara %d perdida (5 s sin verla)", seen[i].id);
        seen[i] = seen[--n_seen];
        emit(&e);
    }
}

static void on_face(const uint8_t *p, size_t n)
{
    perc_face f;
    if (perception_parse_face(p, n, &f) != 0) { log_unknown("de cara mal formado", p, n); return; }
    int64_t now = hal_now_ms();
    if (f.has_face) { face_hits++; last_hit = f; last_hit_ms = now; }   /* para la tecla i (sin USB no hay consola) */
    int who = !f.has_face ? WHO_NOBODY : f.person_id == PERC_FACE_UNKNOWN_ID ? WHO_UNKNOWN : f.person_id;
    if (who >= 0) { last_known = f; last_known_ms = now; }
    if (who == WHO_UNKNOWN && last_known_ms >= 0 && now - last_known_ms < FACE_SAME_MS) {
        long dx = (long)(f.x + f.w / 2) - (last_known.x + last_known.w / 2), dy = (long)(f.y + f.h / 2) - (last_known.y + last_known.h / 2);
        long r = f.w > last_known.w ? f.w : last_known.w;
        if (dx * dx + dy * dy <= r * r) {
            who = f.person_id = last_known.person_id;   /* la misma cara en el mismo lugar */
            snprintf(f.name, sizeof f.name, "%s", last_known.name);
        }
    }
    if (f.has_face) { last_who = who; last_who_ms = now; }
    autoreg_done();
    if (f.has_face) autoreg_check(&f, who, now);
    int change = who != face_who;
    if (change) {
        face_changes++;
        if (who == WHO_NOBODY) hal_log("perception: sin cara");
        else hal_log("perception: cara %s id=%d \"%s\" x=%d y=%d w=%d h=%d", who == WHO_UNKNOWN ? "desconocida" : "conocida",
                     f.person_id, f.name, f.x, f.y, f.w, f.h);
        face_who = who;
    }
    if (who == WHO_NOBODY) return;
    if (who >= 0) face_track(who, now);
    if (!change && now - face_sent_ms < FACE_EVERY_MS) return;
    face_sent_ms = now;
    /* el núcleo espera el centro de la cara en 320×240. PENDIENTE: 03. La resolución de la cámara se mide en el robot */
    alma_ev e = {who >= 0 ? EV_FACE_SEEN : EV_FACE_UNKNOWN, who >= 0 ? who : -1, -1, -1,
                 (float)f.x + (float)f.w / 2, (float)f.y + (float)f.h / 2, (float)f.w, 0};
    emit(&e);
}

void perception_init(perc_emit_fn fn)
{
    emit = fn;
    have_last = low_sent = edge_now = edge_side = gait_dir = edge_recheck = 0;
    edge_hold_until = shake_hold_until = -1;
    swing_foot = -1;
    unknown = 0;
    face_who = WHO_NOBODY;
    n_seen = 0;
    face_sent_ms = 0;
    face_changes = face_hits = 0;
    last_hit_ms = last_known_ms = last_who_ms = -1;
    last_who = WHO_NOBODY;
    unk_first = unk_last = any_known_ms = autoreg_ms = -1;
    autoreg_name[0] = 0;
    unk_hits = 0;
    perception_set_table(NULL, 0);
}

void perception_set_table(const perc_rule *rules, int n)
{
    table = n > 0 ? rules : DEFAULT_TABLE;
    table_n = n > 0 ? n : (int)(sizeof DEFAULT_TABLE / sizeof *DEFAULT_TABLE);
}

static void post(alma_ev_type t, float value)
{
    alma_ev e = {t, -1, -1, -1, 0, 0, 0, value};
    emit(&e);
}

static void log_unknown(const char *why, const uint8_t *p, size_t n)
{
    char hex[3 * 32 + 8];
    size_t m = n < 32 ? n : 32, o = 0;
    for (size_t i = 0; i < m; i++) o += (size_t)snprintf(hex + o, sizeof hex - o, " %02x", p[i]);
    unknown++;
    hal_log("perception: frame %s t=%lld ms n=%u:%s%s", why, (long long)hal_now_ms(), (unsigned)n, hex, n > m ? " …" : "");
}

/* 3F (YOLO): clase, x, y, sin pedirlo [BOBBY-ARTE]. En el modo de piedra-papel-tijera el original lee 0 = papel,
   1 = piedra, 2 = tijera (DERIVADO); el detector tiene además 3 = tijera y 0 = otro EMO con su numeración propia, así
   que se registra el número tal cual. Todavía sin evento ni conducta (prueba con el dueño, tecla T) */
static uint32_t gestures;
static int last_gesture = -1;
uint32_t perception_gestures(int *last) { if (last) *last = last_gesture; return gestures; }
static void on_gesture(int c, int x, int y)
{
    static const char *const NAME[] = {"papel", "piedra", "tijera"};
    gestures++;
    last_gesture = c;
    hal_log("gesto: %s (clase %d, x %d, y %d)", c >= 0 && c < 3 ? NAME[c] : "¿?", c, x, y);
}

void perception_on_frame(void *user, k210_rx_kind kind, const uint8_t *p, size_t n, int flags)
{
    (void)user;
    (void)flags;
    if (kind == K210_RX_EXT && p[5] == 0x0A) { on_face(p, n); return; }
    if (kind == K210_RX_EXT && p[5] == 0x69) return;   /* versión del K210 (03): la registra hal_k210 */
    if (kind == K210_RX_EXT && p[5] == 0x35) return;   /* base (CASA.md): la registra hal_k210 */
    if (kind == K210_RX_SMALL && p[2] == 0x3F) { on_gesture(p[3], p[4], p[5]); return; }
    if (kind == K210_RX_EXT && p[5] == 0x3F) { log_unknown("gesto (3F extendido)", p, n); gestures++; return; }
    if (kind != K210_RX_SMALL) {   /* otros extendidos, basura e incompletos: formato PENDIENTE (03) */
        log_unknown(kind == K210_RX_EXT ? "extendido sin tabla" : "no reconocido", p, n);
        return;
    }
    for (int i = 0; i < table_n; i++) {
        if (table[i].cmd != p[2]) continue;
        if (p[2] == 0x0B && p[3] == 0) return;   /* 0B 00 = fin de la escucha, no otra palabra de activación (hal_k210) */
        if (table[i].action == PERC_EVENT) {
            alma_ev e = {table[i].ev, -1, -1, -1, p[3], p[4], p[5], 0};
            if (p[2] == 0x0B) e.value = (float)(p[4] % 12 + 1);   /* sector de la voz (d1, 0–11) + 1 para el núcleo */
            hal_log("perception: %02x → evento %d (%s, %s)", p[2], (int)table[i].ev, table[i].what, table[i].status);
            emit(&e);
        }
        return;
    }
    log_unknown("desconocido", p, n);
}

/* ---- piso y bordes (regla del dueño, 2026-10-29) ----
   - Los dos pies apoyados (sin marcha): cualquier sensor sin piso es una posible caída. Si ninguno ve piso, no es un
     borde: lo levantaron (eso lo ve el IMU).
   - Caminando: los sensores del pie en el aire no cuentan; se evalúan cuando se apoya. De frente solo cuentan los
     sensores de adelante de los pies apoyados; en reversa, los de atrás.
   - Con borde se manda EV_CLIFF (los servos se detienen en el acto) con el lado en value, y no se avanza hacia ese lado
     mientras dure. */
void perception_set_gait(int dir, int swing) { gait_dir = dir; swing_foot = swing; }

static int edges(const hal_sensors *s)   /* bit 0 = borde adelante, bit 1 = borde atrás, bit 2/3 = pie izq./der. en el aire */
{
    int known = 0, missing = 0, mask = 0;
    /* quieto, un pie con sus dos sensores sin piso y el otro con los dos con piso: ese pie está en el aire */
    if (gait_dir == 0 && swing_foot < 0)
        for (int f = 0; f < 2; f++) {
            const int *a = s->floor[f], *b = s->floor[1 - f];
            if (a[0] == 0 && a[1] == 0 && b[0] == 1 && b[1] == 1) return 3 | (f == HAL_FOOT_L ? 4 : 8);
        }
    for (int f = 0; f < 2; f++) {
        if (f == swing_foot) continue;
        for (int p = 0; p < 2; p++) {
            int v = s->floor[f][p];
            if (v < 0) continue;
            known++;
            if (v == 0) { missing++; mask |= p == HAL_FLOOR_FRONT ? 1 : 2; }
        }
    }
    if (!missing) return 0;
    if (gait_dir == 0 && swing_foot < 0) return missing == known && known == 4 ? 0 : mask;
    /* girando en el sitio (medido 2026-11-02: con un pie en el aire el otro se inclina y su sensor de adelante deja de ver
       la mesa un instante; cancelaba la vuelta a casa): solo cuenta si el pie apoyado pierde el piso con los dos */
    if (gait_dir == 0) return missing == known && known == 2 ? mask : 0;
    return gait_dir > 0 ? mask & 1 : gait_dir < 0 ? mask & 2 : mask;
}

/* Ladeada, los sensores del lado alto quedan en el aire y parecen borde (medido 2026-11-05: cara arriba → "borde adelante";
   ladeada a su izquierda → el pie derecho sin piso). Si todo lo que falta está del lado alto, es la inclinación, no un
   borde. Si falta del lado bajo (se está yendo de boca por una orilla), sí es borde */
#define TILT_EDGE_DEG 8.0f
static int tilt_explains(const hal_sensors *s)
{
    int any = 0;
    for (int f = 0; f < 2; f++)
        for (int p = 0; p < 2; p++) {
            if (s->floor[f][p] != 0) continue;
            any = 1;
            int high = (p == HAL_FLOOR_FRONT && s->tilt_a > TILT_EDGE_DEG) || (p == HAL_FLOOR_REAR && s->tilt_a < -TILT_EDGE_DEG)
                       || (f == HAL_FOOT_R && s->tilt_b < -TILT_EDGE_DEG) || (f == HAL_FOOT_L && s->tilt_b > TILT_EDGE_DEG);
            if (!high) return 0;
        }
    return any;
}
int perception_tilt(float *a, float *b) { if (a) *a = last.tilt_a; if (b) *b = last.tilt_b; return have_last; }

/* adelante: un borde, o algo a menos de FRONT_STOP_MM en el sensor de distancia (2026-10-30) */
#define FRONT_STOP_MM 60
static int front_mm = -1;
static int leaving_base;   /* bajándose de la base: su orilla de enfrente no frena los pasos (dueño, 2026-11-02) */
void perception_leaving_base(int on) { leaving_base = on; }
/* muy ladeada (≥ 35°, dueño, 2026-11-05): no camina para ningún lado; se puede ir de lado */
static int too_tilted(void) { return have_last && (fabsf(last.tilt_a) >= 35.0f || fabsf(last.tilt_b) >= 35.0f); }
int perception_forward_blocked(void) { return ((edge_now & 1) && !leaving_base) || (front_mm >= 0 && front_mm < FRONT_STOP_MM) || too_tilted(); }
int perception_front_mm(void) { return front_mm; }

void perception_hold_edges(int64_t until_ms)
{
    if (until_ms > edge_hold_until) edge_hold_until = until_ms;
    edge_recheck = 1;
}

void perception_moving(int64_t now_ms)
{
    if (now_ms + SHAKE_SETTLE_MS > shake_hold_until) shake_hold_until = now_ms + SHAKE_SETTLE_MS;
}

static void post_edge(int e, const char *why)
{
    hal_log("perception: borde %s (marcha %d, pie en el aire %d)%s", e & 4 ? "bajo el pie izquierdo" : e & 8 ? "bajo el pie derecho"
            : e == 3 ? "adelante y atrás" : e == 1 ? "adelante" : "atrás", gait_dir, swing_foot, why);
    post(EV_CLIFF, e & 4 ? ALMA_CLIFF_FOOT_L : e & 8 ? ALMA_CLIFF_FOOT_R : e == 3 ? ALMA_CLIFF_BOTH : e == 1 ? ALMA_CLIFF_FRONT : ALMA_CLIFF_REAR);
}
int perception_edges_now(void) { return edge_now; }
/* subiendo de espaldas a la base (medido 2026-11-02 sin el USB): la rampa se lee como borde atrás y cada paso se frenaba
   en el cuadro 2; los 14 intentos se quedaban en el sitio. Ahí atrás no frena */
int perception_backward_blocked(void) { return ((edge_now & 2) != 0 && home_get() != HOME_DOCK) || too_tilted(); }

void perception_poll_sensors(alma_sensors *for_tick)
{
    hal_sensors s;
    hal_sensors_read(&s);
    face_expire(hal_now_ms());
    if (s.shaken && !s.lifted && hal_now_ms() < shake_hold_until) s.shaken = 0;   /* se avisa si sigue al acabar la espera */
    if (have_last) {
        /* reflejos primero (05): app_post los manda por la ruta prioritaria */
        if (s.lifted && !last.lifted) post(EV_PICKED_UP, 0);
        if (s.shaken && !last.shaken) post(EV_SHAKEN, 1);
        if (s.tipped && !last.tipped) post(EV_TIPPED_OVER, 0);
        /* dejado: termina el levantado o el volcado (el núcleo borra los dos con EV_PUT_DOWN) */
        if (!(s.lifted || s.tipped) && (last.lifted || last.tipped)) {
            perception_hold_edges(hal_now_ms() + PUT_DOWN_SETTLE_MS);
            post(EV_PUT_DOWN, 0);
        }
        /* que quede en el registro (dueño, 2026-11-05: "a veces reacciona a veces no"): sintió o no sintió */
        if (s.touch_pet && !last.touch_pet) { hal_log("toque: caricia (≥ 1.5 s)"); post(EV_TOUCH_PET, 1500); }
        if (s.touch_tap && !last.touch_tap) { hal_log("toque: toquecito"); post(EV_TOUCH_TAP, 0); }
        if (s.moved && !hal_legs_on() && !s.on_charger) {   /* en la base siguen sueltas (se acomoda para cargar) */
            static int64_t moved_log;
            if (hal_now_ms() - moved_log > 5000) { hal_log("patas: la mueven, vuelve la corriente"); moved_log = hal_now_ms(); }
            app_note_moved(hal_now_ms());
        }
        int near = s.tof_mm >= 0 && s.tof_mm < OBSTACLE_MM, was = last.tof_mm >= 0 && last.tof_mm < OBSTACLE_MM;
        if (near && !was) post(EV_OBSTACLE, (float)s.tof_mm);
        if (s.on_charger != last.on_charger) post(s.on_charger ? EV_CHARGING_ON : EV_CHARGING_OFF, 0);
    }
    if (s.soc_pct <= BATTERY_LOW_PCT && !low_sent) { low_sent = 1; post(EV_BATTERY_LOW, s.soc_pct); }
    if (s.soc_pct > BATTERY_LOW_PCT + 10) low_sent = 0;
    int e = edges(&s);
    if (e && gait_dir == 0 && tilt_explains(&s)) {
        static int64_t said = -1000000;
        if (hal_now_ms() - said > 10000) { hal_log("perception: ladeada (A %.0f°, B %.0f°): el lado alto sin piso no es borde", s.tilt_a, s.tilt_b); said = hal_now_ms(); }
        e = 0;
    }
    if (hal_now_ms() < edge_hold_until) {
        /* en un movimiento de reflejo o en la espera de después: no se avisa (los bordes siguen frenando la marcha) */
    } else if (edge_recheck) {
        /* terminó el movimiento y pasó la espera: se vuelve a evaluar desde cero */
        edge_recheck = 0;
        if (e) post_edge(e, ", sigue tras el movimiento");
    } else if ((e && !edge_now) || ((e & 12) && !edge_side)) {
        /* un pie no sale de golpe: primero se pierde un sensor (borde adelante o atrás) y luego el otro. Cuando el
           borde que ya había pasa a ser un pie entero en el aire, se avisa otra vez (medido en el robot, 2026-10-30) */
        post_edge(e, "");
    }
    edge_now = e & 3;
    edge_side = e & 12;
    last = s;
    have_last = 1;
    front_mm = s.tof_mm;
    if (for_tick) { for_tick->soc_pct = s.soc_pct; for_tick->on_charger = s.on_charger; }
    on_usb = s.on_usb;
}

uint32_t perception_unknown_frames(void) { return unknown; }
uint32_t perception_face_changes(void) { return face_changes; }
uint32_t perception_face_hits(void) { return face_hits; }
int64_t perception_last_face(perc_face *out) { if (out) *out = last_hit; return last_hit_ms; }
int64_t perception_last_who(int *who) { if (who) *who = last_who; return last_who_ms; }
