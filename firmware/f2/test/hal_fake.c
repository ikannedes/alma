#include "hal_fake.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "app.h"
#include "f2_config.h"
#include "hal_k210.h"
#include "k210_frames.h"
#include "rlog.h"

int64_t fake_ms;
fake_k210_mode fake_k210 = K_REPLY_SAM;
fake_tx fake_txs[FAKE_TX_MAX];
int fake_n_tx;
int64_t fake_resetn_t[8];
int fake_n_resetn;
fake_servo_ev fake_servo[FAKE_SERVO_MAX];
int fake_n_servo;
float fake_servo_deg[HAL_SERVOS];
int fake_audio_stops;
hal_sensors fake_sensors;
alma_mem_file fake_mem;
int fake_mem_ok;
int fake_face_polls;
int fake_reg_reply = 1;
int fake_del_reply = 1;
/* envío de archivos (hal_k210 k210_file_send): el K210 falso reconstruye lo que llega por SPI y contesta 0x400 */
int fake_file_ack_cmd = 0x21, fake_file_reject, fake_file_fatal, fake_spi_n, fake_file_bad;
uint8_t fake_file_rx[FAKE_FILE_MAX];
size_t fake_file_rx_n;
static uint8_t spi_hdr[8];

static void file_ack(int64_t ms, int v) { if (fake_file_ack_cmd) fake_k210_small(ms, (uint8_t)fake_file_ack_cmd, (uint8_t)(v & 0xFF), (uint8_t)(v >> 8), 0); }

/* micrófono: tras 4B 00 el K210 falso avisa fake_mic_chunks trozos (01 len) de FAKE_MIC_LEN bytes cada 100 ms y luego
   0B 00; el PCM es la muestra i = i (16 bits), con los bytes al revés en cada palabra como los manda el K210 */
int fake_mic_chunks = 10, fake_mic_reads, fake_mic_bad_hdr, fake_mic_on_4b = 1, fake_mic_on_06 = 1, fake_mic_06;
static size_t mic_sent;   /* bytes de PCM ya entregados */

uint8_t fake_photo[FAKE_PHOTO_LEN];
int fake_photo_late, fake_photo_reads, fake_photo_bad_hdr;
static size_t photo_sent;

static int photo_read(uint8_t *p, size_t n, size_t len)
{
    if (spi_hdr[5] != (uint8_t)(spi_hdr[2] + spi_hdr[3] + spi_hdr[4]) || n % 64 || n < len) fake_photo_bad_hdr++;
    static uint8_t b[16384 + 64];
    memset(b, 0, sizeof b);
    if (n > sizeof b) { fake_photo_bad_hdr++; return -1; }
    for (size_t i = 0; i < len && photo_sent + i < FAKE_PHOTO_LEN; i++) b[i] = fake_photo[photo_sent + i];
    for (size_t w = 0; w + 3 < n; w += 4) { p[w] = b[w + 3]; p[w + 1] = b[w + 2]; p[w + 2] = b[w + 1]; p[w + 3] = b[w]; }
    photo_sent += len;
    fake_photo_reads++;
    return 0;
}

void fake_mic_stream(int64_t ms)
{
    mic_sent = 0;
    for (int i = 0; i < fake_mic_chunks; i++) fake_k210_small(ms + 100 * (i + 1), 0x01, FAKE_MIC_LEN & 0xFF, FAKE_MIC_LEN >> 8, 0);
    fake_k210_small(ms + 100 * (fake_mic_chunks + 1), 0x0B, 0, 0, 0);
}

int hal_k210_spi_read(uint8_t *p, size_t n)
{
    size_t len = spi_hdr[2] | (size_t)spi_hdr[3] << 8;
    if (spi_hdr[4] == 2) return photo_read(p, n, len);
    /* el audio que anuncia 01 se pide con modo 1 [BOBBY-ARTE] */
    if (spi_hdr[4] != 1 || spi_hdr[5] != (uint8_t)(spi_hdr[2] + spi_hdr[3] + spi_hdr[4]) || n % 64 || n < len) fake_mic_bad_hdr++;
    uint8_t b[4096 + 64] = {0};
    for (size_t i = 0; i + 1 < len; i += 2) {
        uint16_t v = (uint16_t)((mic_sent + i) / 2);
        b[i] = (uint8_t)v;
        b[i + 1] = (uint8_t)(v >> 8);
    }
    for (size_t w = 0; w + 3 < n; w += 4) { p[w] = b[w + 3]; p[w + 1] = b[w + 2]; p[w + 2] = b[w + 1]; p[w + 3] = b[w]; }
    mic_sent += len;
    fake_mic_reads++;
    return 0;
}

int hal_k210_spi_write(const uint8_t *p, size_t n)
{
    fake_spi_n++;
    if (n == 8) { memcpy(spi_hdr, p, 8); return 0; }
    size_t len = spi_hdr[2] | (size_t)spi_hdr[3] << 8;
    if (spi_hdr[5] != (uint8_t)(spi_hdr[2] + spi_hdr[3] + spi_hdr[4]) || n % 64 || n < len) { fake_file_bad++; return 0; }
    static uint8_t b[2048];
    for (size_t w = 0; w + 3 < n && w + 3 < sizeof b; w += 4) { b[w] = p[w + 3]; b[w + 1] = p[w + 2]; b[w + 2] = p[w + 1]; b[w + 3] = p[w]; }
    uint8_t sum = 0;
    for (size_t i = 0; i + 1 < len; i++) sum = (uint8_t)(sum + b[i]);
    if (sum != b[len - 1]) fake_file_bad++;
    int img = spi_hdr[4] == 9;   /* imagen (sticker): el K210 acusa con 55 [BOBBY-ARTE] */
    if (fake_file_fatal) { file_ack(20, 0x7FF); return 0; }
    if (fake_file_reject > 0) {
        fake_file_reject--;
        if (img) fake_k210_small(20, 0x55, 0x01, 0x04, 0); else file_ack(20, 0x401);
        return 0;
    }
    if (fake_file_rx_n + len - 1 <= sizeof fake_file_rx) { memcpy(fake_file_rx + fake_file_rx_n, b, len - 1); fake_file_rx_n += len - 1; }
    if (img) fake_k210_small(20, 0x55, 0x00, 0x04, 0); else file_ack(20, 0x400);
    return 0;
}

void hal_delay_us(uint32_t us) { (void)us; }

const uint8_t *hal_test_avi(size_t *n)
{
    static uint8_t avi[5000];
    for (size_t i = 0; i < sizeof avi; i++) avi[i] = (uint8_t)(i * 13 + 5);
    *n = sizeof avi;
    return avi;
}

const uint8_t *hal_test_sticker(size_t *n)
{
    static uint8_t png[3000];
    for (size_t i = 0; i < sizeof png; i++) png[i] = (uint8_t)(i * 7 + 1);
    *n = sizeof png;
    return png;
}
static int face_on;
static uint8_t face_reply[7 + 124];

static uint8_t *spiffs;
static uint32_t spiffs_size;
static FILE *log_file;
static int echo;
static char *logbuf;
static size_t log_n, log_cap = 16u << 20;

/* bytes pendientes del K210 */
#define RXQ 512
static struct { int64_t t; uint8_t b[160]; size_t n; } rxq[RXQ];   /* cabe una respuesta de cara (131 bytes) */
static int rx_n;
static int64_t t34 = -1, tres = -1;

int64_t hal_now_ms(void) { return fake_ms; }

void hal_log(const char *fmt, ...)
{
    char line[1024];
    int o = snprintf(line, sizeof line, "[%6lld.%03lld] ", (long long)(fake_ms / 1000), (long long)(fake_ms % 1000));
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(line + o, sizeof line - (size_t)o, fmt, ap);
    va_end(ap);
    if (!logbuf) logbuf = malloc(log_cap);
    size_t n = strlen(line);
    if (log_n + n + 2 < log_cap) { memcpy(logbuf + log_n, line, n); log_n += n; logbuf[log_n++] = '\n'; logbuf[log_n] = 0; }
    if (!log_file) log_file = fopen("build/test_f2.log", "w");
    if (log_file) fprintf(log_file, "%s\n", line);
    if (echo) printf("%s\n", line);
    rlog_push(line);
}

long hal_rlog_take(char *out, size_t cap) { return rlog_take(out, cap); }
int hal_battery_mv(void) { return (int)(3300 + fake_sensors.soc_pct * 9); }
void *hal_big_alloc(size_t n) { return malloc(n); }
void hal_big_free(void *p) { free(p); }
size_t hal_big_largest(void) { return 4u << 20; }

/* ---- firmware por Wi-Fi: dos particiones en memoria; arrancar = cambiar fake_ota_boot ---- */
#include "mbedtls/sha256.h"
char fake_ota_running[8] = "ota_1", fake_ota_boot[8] = "ota_1", fake_ota_prev[8];
int fake_ota_restarts, fake_ota_trial_flag;
static unsigned fake_keep;   /* como la RAM RTC: sobrevive a boot_app */
int fake_legs_on = 1, fake_legs_offs;
void hal_legs_power(int on) { if (!on && fake_legs_on) fake_legs_offs++; fake_legs_on = on; }
int hal_legs_on(void) { return fake_legs_on; }
unsigned hal_keep_get(void) { return fake_keep; }
void hal_keep_set(unsigned v) { fake_keep = v; }
static uint8_t *ota_buf;
static size_t ota_cap, ota_n;
static int ota_open, ota_ok;

int hal_ota_begin(size_t size)
{
    free(ota_buf);
    ota_buf = malloc(size);
    ota_cap = size;
    ota_n = 0;
    ota_open = ota_buf != NULL;
    ota_ok = 0;
    return ota_open ? 0 : -1;
}

int hal_ota_write(const uint8_t *buf, size_t n)
{
    if (!ota_open || ota_n + n > ota_cap) return -1;
    memcpy(ota_buf + ota_n, buf, n);
    ota_n += n;
    return 0;
}

int hal_ota_end_and_check(const char *sha256_hex)
{
    if (!ota_open) return -1;
    ota_open = 0;
    uint8_t sum[32];
    mbedtls_sha256(ota_buf, ota_n, sum, 0);
    char hex[65];
    for (int i = 0; i < 32; i++) snprintf(hex + 2 * i, 3, "%02x", sum[i]);
    ota_ok = strcmp(hex, sha256_hex) == 0;
    return ota_ok ? 0 : -1;
}

void hal_ota_abort(void) { ota_open = 0; }

void hal_ota_set_boot_and_restart(void)
{
    if (!ota_ok) return;
    snprintf(fake_ota_prev, sizeof fake_ota_prev, "%s", fake_ota_running);
    snprintf(fake_ota_boot, sizeof fake_ota_boot, "%s", strcmp(fake_ota_running, "ota_1") ? "ota_1" : "ota_0");
    fake_ota_trial_flag = 1;
    fake_ota_restarts++;
}

const char *hal_ota_running_label(void) { return fake_ota_running; }

int hal_ota_trial(char *prev, size_t cap)
{
    if (!fake_ota_trial_flag) return 0;
    snprintf(prev, cap, "%s", fake_ota_prev);
    return 1;
}

void hal_ota_trial_confirm(void) { fake_ota_trial_flag = 0; }

void hal_ota_trial_revert(void)
{
    fake_ota_trial_flag = 0;
    snprintf(fake_ota_boot, sizeof fake_ota_boot, "%s", fake_ota_prev);
    fake_ota_restarts++;
}

int fake_log_contains(const char *s) { return logbuf && strstr(logbuf, s) != NULL; }
int fake_log_count(const char *s)
{
    int n = 0;
    for (const char *p = logbuf; p && (p = strstr(p, s)); p += strlen(s)) n++;
    return n;
}
void fake_log_clear(void) { log_n = 0; if (logbuf) logbuf[0] = 0; }
void fake_log_echo(int on) { echo = on; }

void fake_k210_send(int64_t delay_ms, const uint8_t *p, size_t n)
{
    if (rx_n == RXQ || n > sizeof rxq[0].b) return;
    rxq[rx_n].t = fake_ms + delay_ms;
    memcpy(rxq[rx_n].b, p, n);
    rxq[rx_n++].n = n;
}

void fake_k210_small(int64_t delay_ms, uint8_t cmd, uint8_t d0, uint8_t d1, uint8_t d2)
{
    uint8_t f[K210_SMALL_LEN];
    fake_k210_send(delay_ms, f, k210_small(f, cmd, d0, d1, d2));
}

void fake_face_set(int has_face, int id, int x, int y, int w, int h, const char *name)
{
    face_on = has_face >= 0;
    static const uint8_t HDR[] = {0x55, 0xAA, 0xFF, 0x7C, 0x00, 0x0A};
    memset(face_reply, 0, sizeof face_reply);
    memcpy(face_reply, HDR, sizeof HDR);
    uint8_t cs = 0;
    for (int i = 0; i < 6; i++) cs = (uint8_t)(cs + face_reply[i]);
    face_reply[6] = cs;
    const int v[] = {x, y, w, h, has_face, id};
    for (int k = 0; k < 6; k++)
        for (int i = 0; i < 4; i++) face_reply[7 + 4 * k + i] = (uint8_t)((uint32_t)v[k] >> (8 * i));
    if (name) strncpy((char *)face_reply + 7 + 24, name, 99);
}

/* base (CASA.md): respuesta 35 con diez int32 x, y, w, h, cx, cy, píxeles, color, encontrada, cámara */
static int base_on_fake;
static uint8_t base_reply[7 + 40];
int fake_base_polls;
void fake_base_set(int found, int cx, int h)
{
    base_on_fake = found >= 0;
    static const uint8_t HDR[] = {0x55, 0xAA, 0xFF, 0x28, 0x00, 0x35};
    memset(base_reply, 0, sizeof base_reply);
    memcpy(base_reply, HDR, sizeof HDR);
    uint8_t cs = 0;
    for (int i = 0; i < 6; i++) cs = (uint8_t)(cs + base_reply[i]);
    base_reply[6] = cs;
    const int v[] = {cx - 10, 140, 20, h, cx, 150, 230, 1, found, 1};
    for (int k = 0; k < 10; k++)
        for (int i = 0; i < 4; i++) base_reply[7 + 4 * k + i] = (uint8_t)((uint32_t)v[k] >> (8 * i));
}

void hal_k210_tx(const uint8_t *frame, size_t n)
{
    if (n == K210_SMALL_LEN && frame[2] == 0x35) {   /* ¿ves la base? */
        fake_base_polls++;
        if (base_on_fake) fake_k210_send(10, base_reply, sizeof base_reply);
        return;
    }
    /* 0A (pedir cara): se cuenta aparte para no llenar fake_txs; el K210 falso contesta a los 10 ms si hay cara fijada */
    if (n == K210_SMALL_LEN && frame[2] == 0x0A) {
        fake_face_polls++;
        if (face_on) fake_k210_send(10, face_reply, sizeof face_reply);
        return;
    }
    if (fake_n_tx < FAKE_TX_MAX) {
        fake_tx *t = &fake_txs[fake_n_tx++];
        t->t = fake_ms;
        t->n = n < sizeof t->b ? n : sizeof t->b;
        memcpy(t->b, frame, t->n);
    }
    if (n == K210_SMALL_LEN && (frame[2] == 0x23 || frame[2] == 0x25)) file_ack(50, 0x400);   /* abrir y cerrar archivo */
    if (n == K210_SMALL_LEN && frame[2] == 0x54) fake_k210_small(50, 0x55, 0x00, 0x04, 0);         /* abrir la imagen */
    /* registro de cara: al extendido 0E contesta 0F <fake_reg_reply> a los 300 ms (−1: no contesta) */
    if (n > 7 && frame[2] == 0xFF && frame[5] == 0x0E && fake_reg_reply >= 0) fake_k210_small(300, 0x0F, (uint8_t)fake_reg_reply, 0, 0);
    if (n > 7 && frame[2] == 0xFF && frame[5] == 0x49) fake_k210_small(480, 0x1D, 0x12, 0, 0);   /* foto tomada */
    if (n > 7 && frame[2] == 0xFF && frame[5] == 0x40) {   /* pedir /photo/<nombre>.jpg */
        photo_sent = 0;
        if (fake_photo_late > 0) { fake_photo_late--; fake_k210_small(30, 0x05, 0, 0, 0); }
        else {
            int k = 0;
            for (size_t off = 0; off < FAKE_PHOTO_LEN; off += FAKE_PHOTO_CHUNK, k++) {
                size_t m = FAKE_PHOTO_LEN - off < FAKE_PHOTO_CHUNK ? FAKE_PHOTO_LEN - off : FAKE_PHOTO_CHUNK;
                fake_k210_small(20 * (k + 1), 0x04, (uint8_t)(m & 0xFF), (uint8_t)(m >> 8), 0);
            }
            fake_k210_small(20 * (k + 1), 0x05, 0, 0, 0);
        }
    }
    if (n == K210_SMALL_LEN && frame[2] == 0x4B && fake_mic_on_4b) fake_mic_stream(0);
    if (n == K210_SMALL_LEN && frame[2] == 0x06) {
        fake_mic_06++;
        if ((frame[3] & 0x03) == 0x03 && (frame[4] & 0x10) && fake_mic_on_06) fake_mic_stream(0);
    }
    /* borrar cara: a 50 id contesta el extendido 4F (tabla de caras, 40 bytes) a los 200 ms; fake_del_reply = 0: no contesta */
    if (n == K210_SMALL_LEN && frame[2] == 0x50 && fake_del_reply) {
        uint8_t r[7 + 40] = {0x55, 0xAA, 0xFF, 40, 0x00, 0x4F};
        for (int i = 0; i < 6; i++) r[6] = (uint8_t)(r[6] + r[i]);
        fake_k210_send(200, r, sizeof r);
    }
    /* K210 falso: contesta 0x47 200 ms después de boot_start si el orden de 0x34 y RESETN es el de su modo */
    if (n == K210_SMALL_LEN && frame[2] == 0x34) t34 = fake_ms;
    int boot_start = 0;
    for (size_t i = 0; n > 7 && i + 14 <= n; i++) boot_start |= memcmp(frame + i, "boot_start.avi", 14) == 0;
    if (boot_start && frame[2] == 0xFF && frame[5] == 0x02) {
        int sam_order = tres >= 0 && t34 > tres, el_order = t34 >= 0 && tres > t34;
        if ((fake_k210 == K_REPLY_SAM && sam_order) || (fake_k210 == K_REPLY_EL && el_order)) fake_k210_small(200, 0x47, 0, 0, 0);
        t34 = tres = -1;
    }
}

void hal_k210_resetn_pulse(int low_ms)
{
    (void)low_ms;
    if (fake_n_resetn < 8) fake_resetn_t[fake_n_resetn++] = fake_ms;
    tres = fake_ms;
}

static void servo_ev(int idx, float deg, char op)
{
    if (fake_n_servo < FAKE_SERVO_MAX) fake_servo[fake_n_servo++] = (fake_servo_ev){fake_ms, idx, deg, op};
}
void hal_servo_set(int idx, float deg) { fake_servo_deg[idx] = deg; servo_ev(idx, deg, 's'); }
void hal_servo_hold_all(void) { servo_ev(-1, 0, 'h'); }
void hal_servo_release(int idx) { servo_ev(idx, 0, 'r'); }
void hal_servo_restore(int idx) { servo_ev(idx, fake_servo_deg[idx], 'R'); }
void hal_audio_stop(void) { fake_audio_stops++; }

void hal_heap_mark(const char *phase) { hal_log("ALMA_HEAP fase=%s (PC: sin medida)", phase); }

void hal_sensors_read(hal_sensors *out) { *out = fake_sensors; }
void hal_sensors_debug(void) { hal_log("sensores: (falsos)"); }
void hal_touch_debug(void) { hal_log("toque: (falso)"); }
float fake_yaw;
float hal_yaw_deg(void) { return fake_yaw; }
int hal_power_probe(hal_power_probe_t *out) { *out = (hal_power_probe_t){{2513, 382, 142, 2208}, 1, 1}; return 0; }

int fake_spiffs_load(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    fseek(f, 0, SEEK_END);
    spiffs_size = (uint32_t)ftell(f);
    fseek(f, 0, SEEK_SET);
    spiffs = malloc(spiffs_size);
    size_t got = fread(spiffs, 1, spiffs_size, f);
    fclose(f);
    return got == spiffs_size ? 0 : -1;
}

int hal_spiffs_read(uint32_t off, void *buf, size_t n)
{
    if (!spiffs || off > spiffs_size || n > spiffs_size - off) return -1;
    memcpy(buf, spiffs + off, n);
    return 0;
}
uint32_t hal_spiffs_size(void) { return spiffs_size; }

int hal_mem_flash(alma_mem_flash *out)
{
    static alma_mem_flash fl;
    if (!fake_mem_ok) {
        if (alma_mem_file_open(&fake_mem, &fl, NULL, 512u * 1024u)) return -1;
        fake_mem_ok = 1;
    }
    *out = fl;
    return 0;
}

void fake_reset(void)
{
    fake_ms = 0;
    fake_k210 = K_REPLY_SAM;
    fake_n_tx = fake_n_resetn = fake_n_servo = rx_n = 0;
    fake_audio_stops = 0;
    fake_face_polls = face_on = 0;
    fake_base_polls = base_on_fake = 0;
    fake_yaw = 0;
    fake_reg_reply = 1;
    fake_del_reply = 1;
    fake_mic_chunks = 10;
    fake_mic_on_4b = 1;
    fake_mic_on_06 = 1;
    fake_legs_on = 1;
    fake_mic_06 = 0;
    fake_photo_late = fake_photo_reads = fake_photo_bad_hdr = 0;
    for (int i = 0; i < FAKE_PHOTO_LEN; i++) fake_photo[i] = (uint8_t)(i * 7 + 3);
    fake_photo[0] = 0xFF; fake_photo[1] = 0xD8; fake_photo[FAKE_PHOTO_LEN - 2] = 0xFF; fake_photo[FAKE_PHOTO_LEN - 1] = 0xD9;
    fake_mic_reads = fake_mic_bad_hdr = 0;
    fake_file_ack_cmd = 0x21;
    fake_file_reject = fake_file_fatal = fake_spi_n = fake_file_bad = 0;
    fake_file_rx_n = 0;
    t34 = tres = -1;
    for (int i = 0; i < HAL_SERVOS; i++) fake_servo_deg[i] = NAN;
    memset(&fake_sensors, 0, sizeof fake_sensors);
    fake_sensors.soc_pct = 90;
    fake_sensors.on_charger = 1;
    fake_sensors.tof_mm = -1;
    for (int f = 0; f < 2; f++) fake_sensors.floor[f][0] = fake_sensors.floor[f][1] = -1;
}

void fake_run(int64_t ms)
{
    int64_t end = fake_ms + ms;
    while (fake_ms < end) {
        fake_ms++;
        int any = 0;
        for (int i = 0; i < rx_n;) {
            if (rxq[i].t <= fake_ms) {
                k210_rx_feed(rxq[i].b, rxq[i].n);
                rxq[i] = rxq[--rx_n];
                any = 1;
            } else i++;
        }
        if (!any) k210_rx_silence();
        if (fake_ms % F2_STEP_MS == 0) app_step();
    }
}
