/* hal_k210.c — arranque con la secuencia [SAM-SPI] de 03, envío por nombre y recepción de frames crudos. */
#include "hal_k210.h"

#include <stdio.h>
#include <string.h>

#include "f2_hal.h"

#define GAP_MS        20     /* 03: entre frames sin tiempo conocido */
#define READY_WAIT_MS 5000
#define FACE_POLL_MS  200    /* 03 [BOBBY-ARTE]: 0A 00 00 00 cada ≤ 200 ms en el modo 38 01 */

k210_cs_mode k210_payload_mode = K210_CS_CRC8;   /* PENDIENTE: 03, A1.4 */
int k210_log_raw = 1;
int k210_face_poll_ms = FACE_POLL_MS;
int k210_scan_every_ms = 15000;   /* SCAN_EVERY_MS; 0 = vistazo continuo (pruebas) */

static k210_parser parser;
static k210_raw_cb user_cb;
static void *user_arg;
static k210_state state;
static int64_t ready_ms = -1, seq_t0;
static uint32_t rx_count, face_polls, face_replies;
static int64_t next_face_poll;
static int face_dump;   /* respuestas de cara que quedan por registrar completas (tecla f) */

static int32_t le32(const uint8_t *b) { return (int32_t)((uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24); }

/* ---- secuencias de 03, "Secuencia de arranque" (las mismas de sesion1/k210_link.c, como pasos) ---- */
typedef enum { OP_RESETN, OP_SMALL, OP_PATH, OP_PLAY, OP_WAIT_READY } op_kind;
typedef struct { int wait_ms; op_kind op; uint8_t a, b, c, d; const char *s1, *s2; } step;

/* 06 D0 D1 D2 = el estado del ESP32 que el K210 consulta [BOBBY-ARTE]: bit0 Wi-Fi, bit1 "quiero el micrófono", bit12 (D1
   0x10) servidor listo. Sin bit0 y bit12 el K210 avisa la palabra de activación pero no graba; con ellos graba solo ~1 s
   después del 0B 01, y empuja el audio (01 len) solo si después le llega bit1 (2026-11-03: antes iba 06 00 00 00 y la voz
   nunca trajo audio) */
#define ESP_ST0     0x01
#define ESP_ST1     0x10
#define ESP_ST0_MIC 0x03
#define COMMANDS \
    {150, OP_SMALL, 0x69, 1, 0, 0, 0, 0}, {150, OP_SMALL, 0x69, 1, 0, 0, 0, 0}, {150, OP_SMALL, 0x69, 1, 0, 0, 0, 0}, \
    {GAP_MS, OP_SMALL, 0x2C, 0, 0, 0, 0, 0}, {100, OP_PATH, 0, 0, 0, 0, "/spiffs/json/profile.json", 0}, \
    {100, OP_SMALL, 0x2D, 0, 0, 0, 0, 0}, {GAP_MS, OP_SMALL, 0x70, 0, 0, 0, 0, 0}, {GAP_MS, OP_SMALL, 0x38, 1, 0, 0, 0, 0}, \
    {GAP_MS, OP_SMALL, 0x06, ESP_ST0, ESP_ST1, 0, 0, 0}, {GAP_MS, OP_SMALL, 0x17, 0x68, 0, 0, 0, 0}, {GAP_MS, OP_SMALL, 0x6A, 0x46, 0, 0, 0, 0}, \
    {GAP_MS, OP_SMALL, 0x6C, 0, 0, 0, 0, 0}, {GAP_MS, OP_SMALL, 0x74, 0, 0, 0, 0, 0}, \
    {100, OP_PLAY, 0, 0, 0, 0, "boot_start", "boot_start_000"}, {0, OP_WAIT_READY, 0, 0, 0, 0, 0, 0}

/* [SAM-SPI]: RESETN 1 ms, 3500 ms, 0x34, secuencia. Es la que funcionó en la unidad propia [ALMA-1A]; el respaldo
   [EL-GPIO] se quitó (03, decisión del 2026-10-27: desde la fase 1, solo la que funcionó) */
static const step SEQ_SAM[] = {{0, OP_RESETN, 1, 0, 0, 0, 0, 0}, {3500, OP_SMALL, 0x34, 0, 0, 0, 0, 0}, COMMANDS};

static const step *seq;
static k210_reg_state reg_state;   /* registro de cara, más abajo */
static int file_phase(void);
static void file_ack(int v);
static void file_reset(void);
static int file_img(void);
static int reg_phase, reg_result;
static int del_phase, del_got, del_id;   /* borrado de cara, más abajo */
static int mic_on, mic_end, mic_wanted;  /* micrófono, más abajo */
static void mic_rx(uint8_t cmd, size_t len);
static void photo_rx(int cmd, size_t len);
static void photo_ready(void);
static int photo_phase(void);
static void photo_step(void);
static int64_t del_due;
static k210_reg_state del_state;
static int seq_n, seq_i;
static int64_t next_due, wait_until;

/* Modo de caras del reposo, como el original (emo_backup/re/CARAS2.md [BOBBY-ARTE]): 38 01, ~3 s, 10 sondeos 0A y
   38 04; después sigue en el modo 4 sin volver a 38 01. Solo el modo 4 corre la detección (CONFIRMADO en la consola
   del K210); en el modo 1 el recuadro llega en 0xFF. */
#define FM_SETTLE_MS   3000
#define FM_MODE1_POLLS 10
#define FM_MODE4_WAIT_MS 500
static int fm_phase, fm_polls;   /* 0 sin empezar, 1 esperando tras 38 01, 2 sondeos en el modo 1, 3 vistazo (modo 4), 4 ojos (modo 1) */
/* Ojos vivos (dueño, 2026-10-30: "sólo está con la mirada fija todo el tiempo, parece muerta"). En el modo 4 los ojos quedan
   fijos y las animaciones no se ven. Casi siempre el K210 está en el modo 1, moviendo los ojos (stay_X_Y) o con las
   animaciones de las conductas; cada SCAN_EVERY_MS echa un vistazo de SCAN_MS en el modo 4 para buscar caras */
#define SCAN_MS         3500
#define EXPR_MAX_MS     20000   /* sin 08 00 (el saludo de hoy no lo mandó): a los 20 s vuelven los ojos */
#define EXPR_MISSING_MS 60      /* 08 00 antes de esto: el .avi no está en la SD (medido: 6 ms; uno real tarda ≥ 700 ms) */
#define EYES_MIN_MS     1500
#define EYES_MAX_MS     4000
static int expr_pending, idle_eyes = 1;
static int64_t expr_until, expr_sent_ms, scan_until, next_scan, next_idle;
static char fb_avi[40], fb_mp3[40], eye_pos = 'a';
static int (*done_cb)(void);
/* revisión de la SD (tecla V; dueño, 2026-11-03: "revisa que las otras animaciones sí funcionen bien"): no hay forma de
   listar la SD, así que se pide cada .avi sin sonido y se cuentan los 08 00. La reemplazada sí manda su 08 00 (robot,
   2026-11-03: 361 de 363 "sospechosas" sin contarlo): en la primera vuelta, rápida, falta la que trae un 08 00 de más; en
   la segunda, tras 20 s quieta, cada sospechosa sola */
#define CHK_MAX        420
#define CHK_STEP_MS    400     /* primera vuelta: una cada 0.4 s */
#define CHK_MISSING_MS 300     /* como SEQ_MISSING_MS: una que sí está tarda ≥ 700 ms */
#define CHK_SLOW_MS    1500    /* segunda vuelta */
#define CHK_WAIT_MS    20000   /* tras una que sí está: su 08 00 o esto (EXPR_MAX_MS); también antes de la segunda vuelta */
static const char *chk_name[CHK_MAX];
static unsigned char chk_sus[CHK_MAX];
static int chk_on, chk_n, chk_i, chk_pass, chk_cur = -1, chk_wait, chk_nsus, chk_missing, chk_cnt, chk_prev, chk_play;
static int64_t chk_t, chk_e[2], chk_due;
/* La animación reemplazada manda su 08 00 en cuanto llega la nueva (revisión de la SD, 2026-11-03: 361 de 363 lo
   mandaron). Ese 08 00 no es el fin de la nueva: antes se tomaba por "no está en la SD" (la cara de respaldo sin
   hacer falta, y la rutina Daily_Work_stamp sin sus repeticiones). Se ignora si llega a menos de REPLACED_MS */
#define REPLACED_MS 150
static int anim_on, rep_skip;
static int64_t rep_until;
static void anim_sent(void)
{
    rep_skip = anim_on;
    rep_until = hal_now_ms() + REPLACED_MS;
    anim_on = 1;
}
/* modo base (CASA.md [BOBBY-ARTE]): 65 01 y 35 01 cada 100 ms; al salir 65 FF ×3 y los ojos (modo 1). La tecla H lo usa
   20 s; home.c, mientras vuelve a casa */
static int base_on, base_found;
/* prueba de gestos (tecla T; dueño, 2026-11-02: saludarla con la tijera): el juego de piedra-papel-tijera del original
   pone el modo 3 (38 03), espera 2 s y el K210 manda solo un 3F con lo que ve; no hay sondeo [BOBBY-ARTE]. Al salir,
   los ojos y el modo 1, como siempre */
static int gest_on;
static int64_t gest_until;
static int64_t base_until, base_next, base_det_ms = -1;
static k210_base_det base_det;
static uint32_t eye_rng = 12345;
static float eye_scale = 1.0f, wink_p = 0.2f;   /* personalidad (k210_set_eye_style) */
static int64_t fm_due, last_face_log;
static void face_idle_start(void)
{
    k210_send_small(0x38, 1, 0, 0);
    fm_phase = 1;
    fm_polls = 0;
    fm_due = hal_now_ms() + FM_SETTLE_MS;
}
int k210_face_phase(void) { return fm_phase; }
int k210_expressing(void) { return fm_phase == 4; }
int k210_scanning(void) { return fm_phase == 2 || fm_phase == 3; }
int k210_expr_pending(void) { return expr_pending; }
void k210_set_idle_eyes(int on) { idle_eyes = on; }
void k210_set_eye_style(float scale, float wink) { eye_scale = scale; wink_p = wink; }
void k210_set_done_cb(int (*cb)(void)) { done_cb = cb; }
static int play_raw(const char *avi, const char *mp3, int mode);
static uint32_t eye_rand(uint32_t n) { eye_rng = eye_rng * 1103515245u + 12345u; return (eye_rng >> 16) % n; }
static int64_t eye_pause(void) { return (int64_t)((EYES_MIN_MS + eye_rand(EYES_MAX_MS - EYES_MIN_MS)) * eye_scale); }
static void to_scan(void)
{
    int64_t now = hal_now_ms();
    k210_send_small(0x38, 4, 0, 0);
    fm_phase = 3;
    scan_until = now + SCAN_MS;
    next_face_poll = now + FM_MODE4_WAIT_MS;
}
static void to_eyes(void)
{
    int64_t now = hal_now_ms();
    k210_send_small(0x38, 1, 0, 0);
    fm_phase = 4;
    next_scan = now + k210_scan_every_ms;
    next_idle = now + 300;
}
/* un movimiento de ojos del original: de la posición actual a otra (stay_a_b…), o un guiño de vez en cuando */
static void eyes_step(void)
{
    char name[16];
    if ((float)eye_rand(1000) < wink_p * 1000.0f) {
        static const char W[] = {'1', '2', '3', '4', '6', '7', '8', '9'};
        snprintf(name, sizeof name, "stay_wink_%c", W[eye_rand(sizeof W)]);
    } else {
        char to = (char)('a' + eye_rand(3));
        if (to >= eye_pos) to++;
        snprintf(name, sizeof name, "stay_%c_%c", eye_pos, to);
        eye_pos = to;
    }
    fb_avi[0] = 0;
    k210_play(name, NULL, 0);
}
static void anim_done(void)
{
    int64_t now = hal_now_ms();
    if (chk_on) {
        if (chk_cnt < 2) chk_e[chk_cnt] = now;
        chk_cnt++;
        if (chk_wait) { chk_wait = 0; chk_due = now + 300; }
        return;
    }
    if (rep_skip) {
        rep_skip = 0;
        if (now < rep_until) return;   /* el de la reemplazada */
    }
    anim_on = 0;
    if (now - expr_sent_ms < EXPR_MISSING_MS && fb_avi[0]) {
        hal_log("k210: la animación terminó en %lld ms: no está en la SD; va la cara de la conducta (%s)", (long long)(now - expr_sent_ms), fb_avi);
        char a[40], m[40];
        snprintf(a, sizeof a, "%s", fb_avi);
        snprintf(m, sizeof m, "%s", fb_mp3);
        fb_avi[0] = 0;
        expr_sent_ms = now;
        play_raw(a, m[0] ? m : NULL, 0);
        return;
    }
    if (done_cb) done_cb();   /* una secuencia (rutinas) manda la siguiente aquí: expr_pending sube antes de bajar */
    /* una sola animación en curso: una nueva reemplaza a la anterior y no se sabe si la reemplazada manda su 08 00 */
    if (fm_phase == 4 && expr_pending) { expr_pending = 0; next_idle = now + eye_pause(); }
}
void k210_set_fallback(const char *avi, const char *mp3)
{
    snprintf(fb_avi, sizeof fb_avi, "%s", avi ? avi : "");
    snprintf(fb_mp3, sizeof fb_mp3, "%s", mp3 ? mp3 : "");
}

static void on_raw(void *u, k210_rx_kind k, const uint8_t *p, size_t n, int flags)
{
    (void)u;
    rx_count++;
    if (k == K210_RX_SMALL && p[2] == 0x47) ready_ms = hal_now_ms();
    if (k == K210_RX_SMALL && p[2] == 0x08 && p[3] == 0 && state == K210_READY) anim_done();
    /* respuesta a 35 01 (CASA.md [BOBBY-ARTE]): diez int32 x, y, w, h, cx, cy, píxeles, color, encontrada, cámara */
    if (k == K210_RX_EXT && p[5] == 0x35 && n >= 7 + 40) {
        static int64_t last_base_log;
        const uint8_t *b = p + 7;
        if (le32(b + 32)) base_found++;
        base_det = (k210_base_det){le32(b + 32), le32(b), le32(b + 4), le32(b + 8), le32(b + 12), le32(b + 16), le32(b + 20)};
        base_det_ms = hal_now_ms();
        if (le32(b + 32) || hal_now_ms() - last_base_log >= 2000) {
            last_base_log = hal_now_ms();
            hal_log("base: encontrada=%ld x=%ld y=%ld w=%ld h=%ld cx=%ld cy=%ld píxeles=%ld color=%ld cámara=%ld", (long)le32(b + 32),
                    (long)le32(b), (long)le32(b + 4), (long)le32(b + 8), (long)le32(b + 12), (long)le32(b + 16), (long)le32(b + 20),
                    (long)le32(b + 24), (long)le32(b + 28), (long)le32(b + 36));
        }
    }
    if (k == K210_RX_SMALL && p[2] == 0x0F && reg_phase == 2) reg_result = p[3];
    if (k == K210_RX_EXT && p[5] == 0x4F && del_phase == 2) del_got = 1;
    if (k == K210_RX_SMALL && (p[2] == 0x01 || p[2] == 0x13)) mic_rx(p[2], (size_t)(p[3] | p[4] << 8));
    if (k == K210_RX_SMALL && p[2] == 0x0B && p[3] == 0 && mic_on) mic_end = 1;
    if (k == K210_RX_SMALL && p[2] == 0x0D && mic_on) hal_log("micrófono: habla detectada, sector %d (0D)", p[3]);
    if (k == K210_RX_SMALL && (p[2] == 0x21 || p[2] == 0x24 || p[2] == 0x33) && file_phase() && !file_img()) file_ack(p[3] | p[4] << 8);
    if (k == K210_RX_SMALL && p[2] == 0x55 && file_phase() && file_img()) file_ack(p[3] | p[4] << 8);   /* acuses de la imagen */
    if (k == K210_RX_SMALL && (p[2] == 0x04 || p[2] == 0x05) && photo_phase()) photo_rx(p[2], (size_t)(p[3] | p[4] << 8));
    if (k == K210_RX_SMALL && p[2] == 0x1D && p[3] == 0x12 && photo_phase()) photo_ready();
    /* respuestas de cara: 5 por segundo; solo la primera va en crudo (perception registra los cambios) */
    int face = k == K210_RX_EXT && p[5] == 0x0A;
    if (face) face_replies++;
    if (face && face_dump > 0 && n >= 7 + 24) {
        face_dump--;
        const uint8_t *b = p + 7;
        char name[33];
        size_t m = 0;
        for (size_t i = 24; i < n - 7 && b[i] && m + 1 < sizeof name; i++) name[m++] = b[i] >= 0x20 && b[i] < 0x7F ? (char)b[i] : '?';
        name[m] = 0;
        hal_log("cara (%u bytes): x=%ld y=%ld w=%ld h=%ld hay=%ld id=%ld nombre=\"%s\"", (unsigned)(n - 7), (long)le32(b), (long)le32(b + 4),
                (long)le32(b + 8), (long)le32(b + 12), (long)le32(b + 16), (long)le32(b + 20), name);
    } else if (face && n >= 7 + 24 && le32(p + 7 + 16) == 1 && hal_now_ms() - last_face_log >= 500) {
        /* las detecciones van completas (a lo sumo 2 por segundo); con hay = 0 el K210 repite el último recuadro */
        const uint8_t *b = p + 7;
        last_face_log = hal_now_ms();
        hal_log("cara detectada (modo %d): x=%ld y=%ld w=%ld h=%ld hay=%ld id=%ld", fm_phase == 3 ? 4 : 1, (long)le32(b), (long)le32(b + 4),
                (long)le32(b + 8), (long)le32(b + 12), (long)le32(b + 16), (long)le32(b + 20));
    }
    if (k210_log_raw && (!face || face_replies == 1)) {
        static const char *const KIND[] = {"CORTO", "EXTENDIDO", "BASURA", "INCOMPLETO"};
        char hex[3 * 48 + 8];
        size_t m = n < 48 ? n : 48, o = 0;
        for (size_t i = 0; i < m; i++) o += (size_t)snprintf(hex + o, sizeof hex - o, " %02x", p[i]);
        hal_log("RX %s n=%u:%s%s", KIND[k], (unsigned)n, hex, n > m ? " …" : "");
    }
    if (user_cb) user_cb(user_arg, k, p, n, flags);
}

void k210_init(void)
{
    k210_parser_init(&parser, on_raw, NULL);
    parser.ext_tail = 0;   /* el K210 manda los extendidos sin PAYLOAD_CS */
    state = K210_OFF;
    ready_ms = -1;
    face_polls = face_replies = 0;
    reg_phase = 0;
    reg_state = K210_REG_IDLE;
    del_phase = del_got = 0;
    del_state = K210_REG_IDLE;
    mic_on = mic_end = 0;
    file_reset();
    seq = NULL;
}

void k210_set_rx_handler(k210_raw_cb cb, void *user) { user_cb = cb; user_arg = user; }
void k210_rx_feed(const uint8_t *p, size_t n) { k210_parser_feed(&parser, p, n); }
void k210_rx_silence(void) { if (parser.n) k210_parser_flush(&parser); }
k210_state k210_get_state(void) { return state; }
uint32_t k210_rx_count(void) { return rx_count; }
uint32_t k210_face_polls(void) { return face_polls; }
uint32_t k210_face_replies(void) { return face_replies; }
const char *k210_state_name(void)
{
    static const char *const N[] = {"OFF", "ARRANCANDO_SAM", "LISTO", "FALLO"};
    return N[state];
}

const char *k210_boot_used(void)
{
    if (state != K210_READY) return NULL;
    return "SAM-SPI";
}

static void tx(const uint8_t *f, size_t n, const char *what)
{
    if (k210_log_raw) {
        char hex[3 * 24 + 8];
        size_t m = n < 24 ? n : 24, o = 0;
        for (size_t i = 0; i < m; i++) o += (size_t)snprintf(hex + o, sizeof hex - o, " %02x", f[i]);
        hal_log("TX %s n=%u:%s%s", what, (unsigned)n, hex, n > m ? " …" : "");
    }
    hal_k210_tx(f, n);
}

void k210_send_small(uint8_t cmd, uint8_t d0, uint8_t d1, uint8_t d2)
{
    uint8_t f[K210_SMALL_LEN];
    tx(f, k210_small(f, cmd, d0, d1, d2), "corto");
}

static int send_ext(uint8_t sel, const char *payload)
{
    static uint8_t f[K210_FRAME_MAX];
    size_t n = k210_ext(f, sizeof f, sel, payload, k210_payload_mode);
    if (!n) { hal_log("k210: payload demasiado largo (%u bytes)", (unsigned)strlen(payload)); return -1; }
    tx(f, n, sel == 0x02 ? "animación" : sel == 0x0E ? "registro de cara" : sel == 0x26 ? "nombre de archivo" : "ruta");
    return 0;
}

void k210_send_path(const char *path) { send_ext(0x03, path); }

void k210_face_mode(int dump)
{
    if (state != K210_READY) { hal_log("k210: no está listo; no se manda 38 01"); return; }
    face_idle_start();
    face_dump = dump;
    hal_log("k210: modo caras otra vez (38 01, 3 s, 10 sondeos, 38 04); registro completo de las siguientes %d respuestas", dump);
}

static int play_raw(const char *avi, const char *mp3, int mode)
{
    char p[192];
    if (!k210_anim_payload(p, sizeof p, avi, mp3, mode)) return -1;
    if (!chk_on) anim_sent();
    return send_ext(0x02, p);
}

int k210_play(const char *avi, const char *mp3_or_null, int mode)
{
    if (state != K210_READY) { hal_log("k210: no está listo; no se manda %s", avi); return -1; }
    if (chk_on) return 0;   /* revisando la SD: las caras de las conductas esperan */
    if (fm_phase == 3) to_eyes();   /* el modo 4 no muestra animaciones */
    if (fm_phase == 4) { expr_pending = 1; expr_until = hal_now_ms() + EXPR_MAX_MS; }
    expr_sent_ms = hal_now_ms();
    return play_raw(avi, mp3_or_null, mode);
}

static void start_seq(const step *s, int n)
{
    seq = s; seq_n = n; seq_i = 0;
    state = K210_BOOTING_SAM;
    seq_t0 = hal_now_ms();
    next_due = seq_t0 + s[0].wait_ms;
    wait_until = -1;
    hal_log("== k210_boot [SAM-SPI] ==");
}

void k210_boot(void) { start_seq(SEQ_SAM, (int)(sizeof SEQ_SAM / sizeof *SEQ_SAM)); }

/* Pide la cara (03, "Caras"): el K210 no avisa solo. Sin registro: serían 5 líneas por segundo. */
static void face_poll(void)
{
    int64_t now = hal_now_ms();
    if (fm_phase == 1) {
        if (now < fm_due) return;
        fm_phase = 2;
    }
    if (fm_phase == 4) return;   /* ojos (modo 1): no hay detección */
    if (k210_face_poll_ms <= 0 || now < next_face_poll) return;
    next_face_poll = now + k210_face_poll_ms;
    uint8_t f[K210_SMALL_LEN];
    hal_k210_tx(f, k210_small(f, 0x0A, 0, 0, 0));
    face_polls++;
    if (fm_phase == 2 && ++fm_polls >= FM_MODE1_POLLS) {
        to_scan();
        hal_log("k210: modo 4 (38 04): la detección de caras corre en este modo; vistazos de %d ms cada %d s, ojos vivos entre medio",
                SCAN_MS, k210_scan_every_ms / 1000);
    }
}

/* ---- registro de una cara nueva (03 y HALLAZGOS §7, "Registro de una cara nueva" [BOBBY-ARTE]) ----
   38 04 → REG_LOOK_MS para que vea la cara → extendido 0E con el nombre + 00 → 0F d0 (1 registrada, 2 falló), hasta
   REG_WAIT_MS → 38 01. Mientras dura no se pide la cara (0A). PENDIENTE: 03. REG_LOOK_MS se mide en el robot (el
   original pone en ese hueco una animación de ~1–2 s). */
#define REG_LOOK_MS 1500
#define REG_WAIT_MS 5100   /* el original: 51 × 100 ms */
static int64_t reg_due;
static char reg_name[K210_FACE_NAME_MAX + 1];

static int name_ok(const char *s)
{
    size_t n = strlen(s);
    if (n == 0 || n > K210_FACE_NAME_MAX) return 0;
    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) return 0;
    }
    return 1;
}

int k210_face_register(const char *name)
{
    if (state != K210_READY) { hal_log("registro de cara: el K210 no está listo"); return -1; }
    if (reg_phase || del_phase) { hal_log("registro de cara: ya hay uno en curso (o un borrado)"); return -1; }
    if (!name || !name_ok(name)) { hal_log("registro de cara: nombre inválido (1–%d letras, números, _ o -)", K210_FACE_NAME_MAX); return -1; }
    strcpy(reg_name, name);
    hal_log("== registro de cara \"%s\": 38 04, %d ms para verla, 0E con el nombre ==", reg_name, REG_LOOK_MS);
    k210_send_small(0x38, 4, 0, 0);
    reg_state = K210_REG_RUNNING;
    reg_phase = 1;
    reg_result = -1;
    reg_due = hal_now_ms() + REG_LOOK_MS;
    return 0;
}

k210_reg_state k210_face_register_state(void) { return reg_state; }

static void reg_finish(k210_reg_state st, const char *why)
{
    face_idle_start();   /* vuelve al modo 4 como en reposo */
    reg_state = st;
    reg_phase = 0;
    next_face_poll = hal_now_ms();
    hal_log("registro de cara \"%s\": %s; 38 01 (vuelve el sondeo de caras)", reg_name, why);
}

/* ---- borrar una cara del K210: olvidar a quien no se ve en 28 días (06, `bonds`; dueño, 2026-10-30) ----
   4F 00 (modo de gestión) → 50 id_lo id_hi → extendido 4F (la tabla de caras) hasta DEL_WAIT_MS → 38 01.
   PENDIENTE: 03. Secuencia [BOBBY-ARTE] sin probar en el robot: probarla con una cara registrada para eso, nunca la del
   dueño (id 0), y ver que ya no se reconoce. */
#define DEL_GAP_MS 300
#define DEL_WAIT_MS 5100
int k210_face_delete(int id)
{
    if (id <= 0 || id > 0xFFFF) { hal_log("borrar cara: id %d no se borra (el dueño es 0)", id); return -1; }
    if (state != K210_READY || reg_phase || del_phase || file_phase()) return -1;
    del_id = id;
    del_state = K210_REG_RUNNING;
    del_phase = 1;
    del_got = 0;
    del_due = hal_now_ms() + DEL_GAP_MS;
    hal_log("== borrar cara id %d: 4F 00, 50 id ==", id);
    k210_send_small(0x4F, 0, 0, 0);
    return 0;
}

k210_reg_state k210_face_delete_state(void) { return del_state; }

static void del_step(void)
{
    int64_t now = hal_now_ms();
    if (del_phase == 1 && now >= del_due) {
        k210_send_small(0x50, (uint8_t)(del_id & 0xFF), (uint8_t)(del_id >> 8), 0);
        del_phase = 2;
        del_due = now + DEL_WAIT_MS;
    } else if (del_phase == 2 && (del_got || now >= del_due)) {
        del_state = del_got ? K210_REG_OK : K210_REG_TIMEOUT;
        del_phase = 0;
        face_idle_start();
        next_face_poll = now;
        hal_log("borrar cara id %d: %s; 38 01", del_id, del_got ? "el K210 contestó 4F" : "sin respuesta 4F en 5 s");
    }
}

/* ---- micrófono: voz tras "Hey EMO" (07; dueño, 2026-10-30) ----
   [BOBBY-ARTE] (HALLAZGOS §8): el K210 avisa cada trozo con 01 len y el ESP32 lo recibe por SPI (cabecera de 8 bytes como
   al mandar archivos, con el modo = el comando que lo anunció: 1 para 01, 5 para 13; 500 µs; len redondeado a 64; bytes
   al revés en cada palabra de 32 bits) y lo lee siempre, abierto o no. 0B 00 = fin de la escucha. PCM de 16 kHz, 16 bits,
   mono (probable). Tras la palabra de activación el original NO manda 4B 00: pone la cara y lee lo que llegue; 4B 00
   ("abrir micrófono") lo usa cuando él hace una pregunta, con 500 ms de espera después.
   Como el original [BOBBY-ARTE]: tras 0B 01 no se manda 4B (eso es para cuando Alma pregunta); el K210 empieza a grabar
   solo ~1 s después y empuja el audio cuando le llega 06 con bit1 (k210_mic_want, voice.c a los 1.2 s); 0D D0 = sector
   del sonido al detectar habla; 0B 00 = fin. Al cerrar, 06 sin bit1. Trozos de hasta 20 480 bytes (el búfer del original). */
#define MIC_MAX 20480
static void (*mic_cb)(const uint8_t *p, size_t n);
static EXT_RAM_BSS_ATTR uint8_t mic_buf[MIC_MAX + 64];
static uint32_t mic_chunks, mic_stray;

int k210_mic(int on, void (*cb)(const uint8_t *p, size_t n))
{
    if (on) {
        if (state != K210_READY) return -1;
        mic_chunks = 0;
        hal_log("micrófono: esperando el audio del K210 (sin 4B)");
    } else if (mic_on) {
        hal_log("micrófono: cerrado (%u trozos)", (unsigned)mic_chunks);
        if (mic_wanted && state == K210_READY) k210_send_small(0x06, ESP_ST0, ESP_ST1, 0);   /* ya no quiere el audio */
        mic_wanted = 0;
    }
    mic_on = on;
    mic_cb = cb;
    mic_end = 0;
    return 0;
}

int k210_mic_want(void)
{
    if (state != K210_READY || !mic_on) return -1;
    k210_send_small(0x06, ESP_ST0_MIC, ESP_ST1, 0);
    hal_log("micrófono: 06 %02x %02x 00 (quiero el audio)", ESP_ST0_MIC, ESP_ST1);
    mic_wanted = 1;
    mic_end = 0;
    return 0;
}

int k210_mic_open(void)
{
    if (state != K210_READY || !mic_on) return -1;
    k210_send_small(0x4B, 0, 0, 0);
    hal_log("micrófono: 4B 00 (abrir; no llegó audio solo)");
    mic_end = 0;   /* un 0B 00 de antes era de la escucha sin audio */
    return 0;
}

int k210_mic_ended(void) { return mic_end; }
uint32_t k210_mic_chunks(void) { return mic_chunks; }

static void mic_read(uint8_t mode, size_t len);
static void mic_rx(uint8_t cmd, size_t len)
{
    if (!mic_on && !mic_stray++) hal_log("micrófono: llegó %02x (%u bytes) con el micrófono cerrado; se lee y se tira", cmd, (unsigned)len);
    mic_read(cmd == 0x13 ? 5 : 1, len);
}

static void mic_read(uint8_t mode, size_t len)
{
    static int warned;
    if (len == 0 || len > MIC_MAX) {
        if (!warned++) hal_log("micrófono: trozo de %u bytes fuera de rango; se ignora", (unsigned)len);
        return;
    }
    size_t pad = (len + 63) & ~(size_t)63;
    uint8_t hdr[8] = {0, 0, (uint8_t)(len & 0xFF), (uint8_t)(len >> 8), mode, 0, 0, 0};
    hdr[5] = (uint8_t)(hdr[2] + hdr[3] + hdr[4]);
    hal_k210_spi_write(hdr, sizeof hdr);
    hal_delay_us(500);
    if (hal_k210_spi_read(mic_buf, pad)) return;
    for (size_t w = 0; w < pad; w += 4) {
        uint8_t a = mic_buf[w], b = mic_buf[w + 1];
        mic_buf[w] = mic_buf[w + 3]; mic_buf[w + 1] = mic_buf[w + 2]; mic_buf[w + 2] = b; mic_buf[w + 3] = a;
    }
    if (!mic_on) return;
    mic_chunks++;
    if (mic_cb) mic_cb(mic_buf, len);
}

/* ---- foto (ver hal_k210.h) ----
   Medido en el robot (2026-11-01): ~480 ms después de ext 49 el K210 manda 1D 12 (la foto está lista): se pide en ese
   momento; si no llega, a los PHOTO_SHOT_MS. Los trozos 04 son de 10 240 bytes (D0 | D1 << 8). Si llega 05 sin datos se
   vuelve a pedir, hasta PHOTO_TRIES veces. Mientras dura, no se piden caras. El orden de los bytes por SPI se decide
   con el primer trozo: un JPEG empieza con FF D8. */
#define PHOTO_MODE      2
#define PHOTO_CHUNK_MAX 16384
#define PHOTO_SHOT_MS   1500
#define PHOTO_WAIT_MS   10000
#define PHOTO_TRIES     3
static struct {
    k210_photo_state st;
    int phase;                 /* 0 libre, 1 modo cámara, 2 espera la toma, 3 pidió el archivo, 4 cerrar */
    int64_t due;
    int tries, swap;           /* swap: −1 sin decidir */
    size_t n;
    char name[40];
} P;
static EXT_RAM_BSS_ATTR uint8_t photo_buf[K210_PHOTO_MAX];
static EXT_RAM_BSS_ATTR uint8_t photo_chunk[PHOTO_CHUNK_MAX + 64];
static int photo_phase(void) { return P.phase; }

int k210_photo_take(const char *name)
{
    if (state != K210_READY || P.phase || file_phase() || reg_phase || del_phase || mic_on || strlen(name) >= sizeof P.name) return -1;
    memset(&P, 0, sizeof P);
    snprintf(P.name, sizeof P.name, "%s", name);
    P.st = K210_PHOTO_BUSY;
    P.swap = -1;
    k210_send_small(0x67, 0x65, 0, 0);   /* modo cámara (pintura "start") */
    P.phase = 1;
    P.due = hal_now_ms() + 200;
    hal_log("foto: 67 65 y en 200 ms ext 49 \"%s\"", P.name);
    return 0;
}

k210_photo_state k210_photo_state_get(void) { return P.st; }
const uint8_t *k210_photo_data(size_t *n) { *n = P.st == K210_PHOTO_OK ? P.n : 0; return photo_buf; }
void k210_photo_release(void) { if (!P.phase) P.st = K210_PHOTO_IDLE; }

static void photo_ask(void)
{
    char path[64];
    snprintf(path, sizeof path, "/photo/%s.jpg", P.name);
    k210_send_small(0x2C, 0, 0, 0);
    send_ext(0x40, path);
    P.n = 0;
    P.phase = 3;
    P.due = hal_now_ms() + PHOTO_WAIT_MS;
}

static void photo_ask(void);
static void photo_ready(void)
{
    if (P.phase != 2) return;
    hal_log("foto: 1D 12 (lista)");
    photo_ask();
}

static void photo_close(k210_photo_state st, const char *why)
{
    k210_send_small(0x2D, 0, 0, 0);
    k210_send_small(0x67, 0x00, 0, 0);   /* sale del modo cámara */
    send_ext(0x4E, P.name);              /* la borra de su SD */
    P.phase = 0;
    P.st = st;
    hal_log("foto \"%s\": %s (%u bytes, %d intentos)", P.name, why, (unsigned)P.n, P.tries);
}

static void photo_rx(int cmd, size_t len)
{
    if (P.phase != 3) { hal_log("foto: frame %02X fuera de tiempo", cmd); return; }
    if (cmd == 0x05) {
        if (P.n >= 2 && photo_buf[0] == 0xFF && photo_buf[1] == 0xD8) { photo_close(K210_PHOTO_OK, "lista"); return; }
        if (++P.tries >= PHOTO_TRIES) { photo_close(K210_PHOTO_FAILED, P.n ? "no es un JPEG" : "llegó vacía"); return; }
        k210_send_small(0x2D, 0, 0, 0);
        P.phase = 2;                      /* todavía no estaba: se vuelve a pedir */
        P.due = hal_now_ms() + 1000;
        return;
    }
    if (len == 0 || len > PHOTO_CHUNK_MAX || P.n + len > K210_PHOTO_MAX) {
        photo_close(K210_PHOTO_FAILED, len > PHOTO_CHUNK_MAX ? "trozo demasiado grande" : "no cabe");
        return;
    }
    size_t pad = (len + 63) & ~(size_t)63;
    uint8_t hdr[8] = {0, 0, (uint8_t)(len & 0xFF), (uint8_t)(len >> 8), PHOTO_MODE, 0, 0, 0};
    hdr[5] = (uint8_t)(hdr[2] + hdr[3] + hdr[4]);
    hal_k210_spi_write(hdr, sizeof hdr);
    hal_delay_us(500);
    if (hal_k210_spi_read(photo_chunk, pad)) { photo_close(K210_PHOTO_FAILED, "falló la lectura SPI"); return; }
    if (P.swap < 0) {
        P.swap = !(photo_chunk[0] == 0xFF && photo_chunk[1] == 0xD8);
        hal_log("foto: primer trozo %02x %02x %02x %02x → %s", photo_chunk[0], photo_chunk[1], photo_chunk[2], photo_chunk[3],
                P.swap ? "bytes invertidos por palabra" : "en orden");
    }
    for (size_t w = 0; w < len; w += 4) {
        const uint8_t *s = photo_chunk + w;
        uint8_t *d = photo_buf + P.n + w;
        size_t m = len - w < 4 ? len - w : 4;
        for (size_t i = 0; i < m; i++) d[i] = P.swap ? s[3 - i] : s[i];
    }
    P.n += len;
    P.due = hal_now_ms() + PHOTO_WAIT_MS;
}

static void photo_step(void)
{
    int64_t now = hal_now_ms();
    if (now < P.due) return;
    if (P.phase == 1) {
        send_ext(0x49, P.name);   /* la toma y la guarda en /photo/<nombre>.jpg */
        P.phase = 2;
        P.due = now + PHOTO_SHOT_MS;
    } else if (P.phase == 2) photo_ask();
    else if (P.phase == 3) photo_close(K210_PHOTO_FAILED, "sin 05 en 10 s");
}

static void reg_step(void)
{
    int64_t now = hal_now_ms();
    if (reg_phase == 1 && now >= reg_due) {
        send_ext(0x0E, reg_name);
        reg_phase = 2;
        reg_due = now + REG_WAIT_MS;
    } else if (reg_phase == 2) {
        if (reg_result == 1) reg_finish(K210_REG_OK, "REGISTRADA (0F 01)");
        else if (reg_result >= 0) reg_finish(K210_REG_FAILED, reg_result == 2 ? "falló (0F 02)" : "respuesta 0F desconocida");
        else if (now >= reg_due) reg_finish(K210_REG_TIMEOUT, "sin respuesta 0F en 5 s");
    }
}

/* ---- mandar un archivo al K210 (HALLAZGOS §14 [BOBBY-ARTE]), como la actualización de recursos del original ----
   28 "<tipo>" (sin 00) → 26 "<nombre>" → 23 y acuse → por trozo: SPI [cabecera de 8 bytes; 500 µs; datos + suma, con
   los bytes invertidos en cada palabra de 32 bits y rellenos a 64] y acuse → 25. El acuse es 0x400 (D0 | D1 << 8) en
   un frame 21, 24 o 33 (cuál, por medir: se acepta cualquiera); 0x7FF = error fatal; otro valor = se reenvía el trozo.
   Mientras dura, no se pide la cara. */
#define FILE_CHUNK     1024
#define FILE_ACK_MS    10000
#define FILE_TRIES     10
#define FILE_OK_CODE   0x400
#define FILE_FATAL     0x7FF
static struct {
    k210_file_state st;
    int phase;                 /* 0 libre, 1 espera el acuse de 23, 2 el de un trozo, 3 el de 25, 4 manda 2D tras 2B */
    const uint8_t *data;
    size_t n, off, len;        /* len = bytes del trozo en curso */
    int mode, tries, ack;
    int img;                   /* imagen (sticker): 57/54/modo 9/56 con acuses 55 en lugar de 28/26/23/modo 7/25 */
    int64_t due;
    uint32_t chunks;
} F;
static uint8_t file_buf[FILE_CHUNK + 64];
static int file_phase(void) { return F.phase; }
static int file_img(void) { return F.img; }
static void file_reset(void) { memset(&F, 0, sizeof F); }
static void file_ack(int v) { F.ack = v; }

static int file_mode(const char *type) { return !strcmp(type, "model") ? 6 : !strcmp(type, "bin") ? 8 : 7; }

int k210_file_send(const char *type, const char *name, const uint8_t *data, size_t n)
{
    if (state != K210_READY || F.phase || reg_phase || del_phase) { hal_log("archivo al K210: %s", state != K210_READY ? "el K210 no está listo" : "ocupado"); return -1; }
    if (!type || !*type || !name || !*name || strlen(name) > 100 || !data || !n) { hal_log("archivo al K210: datos inválidos"); return -1; }
    static uint8_t f[K210_FRAME_MAX];
    size_t m = k210_ext_bytes(f, sizeof f, 0x28, (const uint8_t *)type, strlen(type), k210_payload_mode);   /* sin 00 */
    if (!m) return -1;
    tx(f, m, "tipo de archivo");
    send_ext(0x26, name);
    k210_send_small(0x23, 0, 0, 0);
    memset(&F, 0, sizeof F);
    F.st = K210_FILE_BUSY; F.phase = 1; F.data = data; F.n = n; F.mode = file_mode(type); F.ack = -1;
    F.due = hal_now_ms() + FILE_ACK_MS;
    hal_log("== archivo al K210: %s \"%s\", %u bytes en trozos de %d (modo %d) ==", type, name, (unsigned)n, FILE_CHUNK, F.mode);
    return 0;
}

/* ---- una imagen PNG al K210, para encimarla en la cara (dueño, 2026-11-02: "la app original me permite poner un dibujo
   sobre los ojos") [BOBBY-ARTE]: ext 57 "<nombre>", 100 ms, 54 y acuse 55; trozos en modo 9 (mismo formato que los
   archivos) con acuse 55 = 0x400 (hasta 5 reintentos); 56 cierra. El K210 la guarda en 0:/png/<nombre>. Con el nombre
   "sticker.png", `59 01` la pone encima de lo que esté en pantalla (PNG de 320×240 con alfa: lo que tiene alfa ≤ 49 queda
   transparente) y `59 03` la quita. */
#define IMG_ACK_MS   5000
#define IMG_TRIES    5

int k210_image_send(const char *name, const uint8_t *data, size_t n)
{
    if (state != K210_READY || F.phase || reg_phase || del_phase) { hal_log("imagen al K210: %s", state != K210_READY ? "el K210 no está listo" : "ocupado"); return -1; }
    if (!name || !*name || strlen(name) > 100 || !data || !n) { hal_log("imagen al K210: datos inválidos"); return -1; }
    send_ext(0x57, name);
    memset(&F, 0, sizeof F);
    F.st = K210_FILE_BUSY; F.phase = 10; F.img = 1; F.data = data; F.n = n; F.mode = 9; F.ack = -1;
    F.due = hal_now_ms() + 100;
    hal_log("== imagen al K210: \"%s\", %u bytes en trozos de %d (modo 9) ==", name, (unsigned)n, FILE_CHUNK);
    return 0;
}

void k210_sticker(int on)
{
    if (state != K210_READY) return;
    k210_send_small(0x59, on ? 0x01 : 0x03, 0, 0);
    hal_log("sticker: %s (59 %02x)", on ? "encima" : "fuera", on ? 1 : 3);
}

k210_file_state k210_file_state_get(void) { return F.st; }
uint32_t k210_file_chunks(void) { return F.chunks; }

static void file_chunk(void)
{
    size_t k = F.n - F.off < FILE_CHUNK ? F.n - F.off : FILE_CHUNK;
    uint8_t sum = 0;
    for (size_t i = 0; i < k; i++) sum = (uint8_t)(sum + F.data[F.off + i]);
    uint16_t len = (uint16_t)(k + 1);
    memcpy(file_buf, F.data + F.off, k);
    file_buf[k] = sum;
    size_t pad = ((size_t)len + 63) & ~(size_t)63;
    memset(file_buf + len, 0, pad - len);
    for (size_t w = 0; w < pad; w += 4) {   /* el K210 lee palabras: cada grupo de 4 bytes va al revés */
        uint8_t a = file_buf[w], b = file_buf[w + 1];
        file_buf[w] = file_buf[w + 3]; file_buf[w + 1] = file_buf[w + 2]; file_buf[w + 2] = b; file_buf[w + 3] = a;
    }
    uint8_t hdr[8] = {0, 0, (uint8_t)(len & 0xFF), (uint8_t)(len >> 8), (uint8_t)F.mode, 0, 0, 0};
    hdr[5] = (uint8_t)(hdr[2] + hdr[3] + hdr[4]);
    F.len = k;
    F.ack = -1;
    hal_k210_spi_write(hdr, sizeof hdr);
    hal_delay_us(500);
    hal_k210_spi_write(file_buf, pad);
    F.phase = 2;
    F.due = hal_now_ms() + FILE_ACK_MS;
}

static void file_end(k210_file_state st, const char *why)
{
    F.st = st;
    F.phase = 0;
    next_face_poll = hal_now_ms();
    hal_log("archivo al K210: %s (%u trozos)", why, (unsigned)F.chunks);
}

static void file_step(void)
{
    int64_t now = hal_now_ms();
    int ack = F.ack;
    if (ack < 0 && now < F.due) return;
    F.ack = -1;
    if (ack == FILE_FATAL) { file_end(K210_FILE_FAILED, "el K210 contestó 0x7FF (error fatal)"); return; }
    if (F.phase == 10) {   /* imagen: tras el nombre, 54 abre */
        k210_send_small(0x54, 0, 0, 0);
        F.phase = 11;
        F.due = now + IMG_ACK_MS;
        return;
    }
    if (F.phase == 11) {   /* el original no revisa el valor de este acuse */
        if (ack < 0) { k210_send_small(0x56, 0, 0, 0); file_end(K210_FILE_FAILED, "sin acuse 55 al abrir la imagen (5 s)"); return; }
        F.tries = 0;
        file_chunk();
        return;
    }
    if (F.phase == 1) {
        if (ack != FILE_OK_CODE) { file_end(K210_FILE_FAILED, ack < 0 ? "sin acuse al abrir el archivo (10 s)" : "el K210 no aceptó el archivo"); return; }
        F.tries = 0;
        file_chunk();
    } else if (F.phase == 2) {
        if (ack != FILE_OK_CODE) {
            if (++F.tries > (F.img ? IMG_TRIES : FILE_TRIES)) {
                if (F.img) k210_send_small(0x56, 0, 0, 0);
                file_end(K210_FILE_FAILED, F.img ? "un trozo de la imagen falló 5 veces" : "un trozo falló 10 veces");
                return;
            }
            hal_log("archivo al K210: trozo en %u %s; reintento %d", (unsigned)F.off, ack < 0 ? "sin acuse" : "rechazado", F.tries);
            file_chunk();
            return;
        }
        F.chunks++;
        F.tries = 0;
        F.off += F.len;
        if (F.off < F.n) { file_chunk(); return; }
        if (F.img) { k210_send_small(0x56, 0, 0, 0); file_end(K210_FILE_OK, "IMAGEN ENVIADA (56)"); return; }
        k210_send_small(0x25, 0, 0, 0);
        F.phase = 3;
        F.due = now + FILE_ACK_MS;
    } else if (F.phase == 3) {
        /* el servidor de pruebas del original no espera este acuse; la actualización sí. Después cierra la subida con
           2B, 100 ms y 2D [BOBBY-ARTE]: sin eso el K210 se quedaba en "Updating step 1" (2026-10-30) */
        hal_log("archivo al K210: 25 %s; cierro con 2B + 2D", ack == FILE_OK_CODE ? "con acuse" : "sin acuse");
        k210_send_small(0x2B, 0, 0, 0);
        F.phase = 4;
        F.due = now + 100;
    } else if (F.phase == 4) {
        k210_send_small(0x2D, 0, 0, 0);
        file_end(K210_FILE_OK, "ENVIADO (25, 2B, 2D)");
    }
}

int k210_play_path(const char *avi_path, const char *mp3_path_or_null, int mode)
{
    char p[256];
    if (state != K210_READY || !k210_anim_payload_path(p, sizeof p, avi_path, mp3_path_or_null, mode)) return -1;
    if (chk_on) return 0;   /* revisando la SD */
    /* como k210_play: que el vistazo de caras no la corte a la mitad (la de Darth Vader dura 18.7 s; 2026-11-03) */
    if (fm_phase == 3) to_eyes();
    if (fm_phase == 4) { expr_pending = 1; expr_until = hal_now_ms() + EXPR_MAX_MS; }
    expr_sent_ms = hal_now_ms();
    anim_sent();
    return send_ext(0x02, p);
}

int k210_check_avis(const char *const *names, int n)
{
    if (state != K210_READY || chk_on || gest_on || base_on || reg_phase || del_phase || F.phase || photo_phase()) return -1;
    chk_n = 0;
    for (int i = 0; i < n && chk_n < CHK_MAX; i++) {
        if (!names[i] || !names[i][0]) continue;
        int dup = 0;
        for (int j = 0; j < chk_n && !dup; j++) dup = strcmp(chk_name[j], names[i]) == 0;
        if (!dup) { chk_sus[chk_n] = 0; chk_name[chk_n++] = names[i]; }
    }
    chk_on = 1;
    chk_pass = 1;
    chk_i = chk_nsus = chk_missing = chk_wait = chk_play = 0;
    chk_cur = -1;
    to_eyes();
    expr_pending = 0;
    chk_due = hal_now_ms() + 500;
    hal_log("revisión de la SD: %d animaciones, una cada %d ms (sin sonido)", chk_n, CHK_STEP_MS);
    return chk_n;
}
int k210_checking(void) { return chk_on; }

static void chk_send(int i, int64_t now, int64_t gap)
{
    chk_cur = i;
    chk_t = now;
    chk_cnt = 0;
    chk_prev = chk_play;   /* la que sigue en pantalla manda su 08 00 al ser reemplazada */
    chk_due = now + gap;
    play_raw(chk_name[i], NULL, 0);
}
static int chk_quick(int k) { return chk_cnt > k && chk_e[k] - chk_t < CHK_MISSING_MS; }
static void chk_step(int64_t now)
{
    if (now < chk_due) return;
    if (chk_pass == 1) {
        if (chk_cur >= 0) {
            int gone = chk_cnt > chk_prev;   /* un 08 00 de más: terminó enseguida */
            if (gone) { chk_sus[chk_cur] = 1; chk_nsus++; }
            chk_play = !gone;
        }
        if (chk_i < chk_n) { chk_send(chk_i++, now, CHK_STEP_MS); return; }
        hal_log("revisión de la SD: primera vuelta, %d de %d sospechosas; ahora una por una", chk_nsus, chk_n);
        chk_pass = 2;
        chk_i = 0;
        chk_cur = -1;
        chk_wait = 0;
        chk_due = now + CHK_WAIT_MS;   /* que termine la que quedó */
        return;
    }
    chk_play = 0;
    if (chk_cur >= 0) {
        /* sola: un 08 00 enseguida = no está; si aun así venía otra, el segundo es el suyo */
        int missing = chk_cnt == 1 ? chk_quick(0) : chk_quick(0) && chk_quick(1);
        if (missing) {
            chk_missing++;
            hal_log("revisión de la SD: %s no está", chk_name[chk_cur]);
        } else if (chk_cnt == 0) {   /* sí está y sigue: que termine antes de la siguiente */
            chk_cur = -1;
            chk_wait = 1;
            chk_due = now + CHK_WAIT_MS;
            return;
        }
        chk_cur = -1;
    }
    chk_wait = 0;
    while (chk_i < chk_n && !chk_sus[chk_i]) chk_i++;
    if (chk_i < chk_n) { chk_send(chk_i++, now, CHK_SLOW_MS); return; }
    hal_log("revisión de la SD: terminada; %d de %d animaciones no están", chk_missing, chk_n);
    chk_on = 0;
    anim_on = rep_skip = 0;   /* 20 s quieta y la última sola: nada en pantalla */
    to_eyes();
}

void k210_poll(void)
{
    if (state == K210_READY) {
        int64_t now = hal_now_ms();
        if (chk_on && (gest_on || base_on || reg_phase || del_phase || F.phase || photo_phase())) {   /* T o H la cancelan */
            hal_log("revisión de la SD: cancelada (el K210 tiene otra cosa)");
            chk_on = 0;
        }
        if (gest_on) {   /* sin vistazos de caras ni ojos: solo esperar los 3F (perception los registra) */
            if (now >= gest_until) {
                gest_on = 0;
                hal_log("gesto: fin de la prueba; modo 1");
                to_eyes();
            }
            return;
        }
        if (base_on) {
            if (base_until && now >= base_until) {
                hal_log("base: fin de la prueba (%d respuestas con encontrada=1)", base_found);
                k210_base_mode(0);
            } else if (now >= base_next) {
                base_next = now + 100;
                uint8_t f[K210_SMALL_LEN];
                hal_k210_tx(f, k210_small(f, 0x35, 1, 0, 0));
            }
            return;
        }
        if (fm_phase == 4 && expr_pending && now >= expr_until) { hal_log("k210: sin 08 00 en 20 s"); expr_pending = 0; anim_on = rep_skip = 0; }
        if (chk_on) chk_step(now);
        else if (fm_phase == 3 && k210_scan_every_ms > 0 && now >= scan_until) to_eyes();
        else if (fm_phase == 4 && !expr_pending && !reg_phase && !del_phase && !F.phase && !photo_phase()) {
            if (now >= next_scan) to_scan();
            else if (idle_eyes && now >= next_idle) eyes_step();
        }
        if (reg_phase) reg_step();
        else if (del_phase) del_step();
        else if (F.phase) file_step();
        else if (photo_phase()) photo_step();
        else face_poll();
        return;
    }
    if (state != K210_BOOTING_SAM) return;
    int64_t now = hal_now_ms();
    while (seq_i < seq_n && now >= next_due) {
        const step *s = &seq[seq_i];
        if (s->op == OP_WAIT_READY) {
            if (wait_until < 0) wait_until = now + READY_WAIT_MS;
            if (ready_ms >= seq_t0) {
                state = K210_READY;
                next_face_poll = now;
                hal_log("k210 listo (0x47) con [%s]", k210_boot_used());
                face_idle_start();
                return;
            }
            if (now < wait_until) return;
            state = K210_FAILED;
            hal_log("k210: no llegó 0x47 con [SAM-SPI]; Alma sigue sin caras ni sonidos");
            return;
        }
        switch (s->op) {
        case OP_RESETN: hal_k210_resetn_pulse(s->a); break;
        case OP_SMALL: k210_send_small(s->a, s->b, s->c, s->d); break;
        case OP_PATH: send_ext(0x03, s->s1); break;
        case OP_PLAY: play_raw(s->s1, s->s2, 0); break;
        default: break;
        }
        seq_i++;
        if (seq_i < seq_n) next_due = now + seq[seq_i].wait_ms;
    }
}

/* Orden corta de prueba (tecla X): solo las de estado, que no escriben en la SD ni tocan la actualización. 38 04 vale:
   en reposo el original busca caras en el modo 4 (HALLAZGOS §7 [BOBBY-ARTE]); registrar exige además 0E, que no está.
   Después registra completas las siguientes 10 respuestas de cara. */
int k210_base_mode(int on)
{
    if (on) {
        if (state != K210_READY || reg_phase || del_phase || F.phase) return -1;
        if (!base_on) k210_send_small(0x65, 1, 0, 0);
        base_on = 1;
        base_until = 0;
        base_found = 0;
        base_det_ms = -1;
        base_next = hal_now_ms() + 300;
        return 0;
    }
    if (!base_on) return 0;
    for (int i = 0; i < 3; i++) k210_send_small(0x65, 0xFF, 0, 0);
    base_on = 0;
    base_until = 0;
    hal_log("base: fin del modo base; 65 FF ×3 y modo 1");
    to_eyes();
    return 0;
}

int64_t k210_base_last(k210_base_det *out)
{
    if (base_det_ms < 0) return -1;
    if (out) *out = base_det;
    return hal_now_ms() - base_det_ms;
}

int k210_base_probe(int secs)
{
    if (base_on || k210_base_mode(1)) return -1;
    base_until = hal_now_ms() + secs * 1000;
    hal_log("base: prueba de %d s (65 01 y 35 01 cada 100 ms)", secs);
    return 0;
}

int k210_gesture_probe(int secs)
{
    if (state != K210_READY || gest_on || base_on || reg_phase || del_phase || F.phase || photo_phase()) return -1;
    k210_send_small(0x38, 3, 0, 0);
    gest_on = 1;
    gest_until = hal_now_ms() + secs * 1000;
    hal_log("gesto: prueba de %d s en el modo 3 (38 03, el de piedra-papel-tijera); enséñale la mano", secs);
    return 0;
}
int k210_gesture_probing(void) { return gest_on; }

int k210_send_debug(uint8_t cmd, uint8_t d0)
{
    /* 35: "¿ves la base?" (CASA.md [BOBBY-ARTE]; solo consulta, contesta con el extendido 35) */
    static const uint8_t OK[] = {0x06, 0x0A, 0x0C, 0x1C, 0x1F, 0x35, 0x36, 0x38, 0x59, 0x5A, 0x60, 0x62, 0x65, 0x6A, 0x6C, 0x74};
    int allowed = memchr(OK, cmd, sizeof OK) != NULL;
    if (!allowed) { hal_log("k210: la orden %02X %02X no está en la lista de prueba; no se manda", cmd, d0); return -1; }
    if (state != K210_READY || reg_phase || del_phase || F.phase) { hal_log("k210: no está listo u ocupado; no se manda %02X %02X", cmd, d0); return -1; }
    k210_send_small(cmd, d0, 0, 0);
    face_dump = 10;
    hal_log("k210: orden de prueba %02X %02X; registro completo de las siguientes 10 respuestas de cara", cmd, d0);
    return 0;
}
