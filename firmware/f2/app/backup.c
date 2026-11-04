/* backup.c — ver backup.h */
#include "backup.h"

#include <stdio.h>
#include <string.h>

#include "app.h"
#include "body.h"
#include "cJSON.h"
#include "f2_hal.h"
#include "outbox.h"

static EXT_RAM_BSS_ATTR uint8_t buf[BACKUP_MAX], rx[BACKUP_MAX];
static size_t n, sent, rx_n;
static int phase, seq, link_up, want_req, asked, waiting, rx_seq, rx_bad;
static int64_t next_ms = -1;

void backup_init(void) { phase = want_req = asked = waiting = 0; next_ms = -1; rx_n = 0; }

void backup_set_link(int up)
{
    link_up = up;
    if (!up) { phase = 0; return; }
    if (next_ms < 0) next_ms = hal_now_ms() + BACKUP_FIRST_S * 1000LL;
    if (app_mem_empty() && !asked && !body_protocol()) {   /* con el protocolo, la memoria la manda el árbitro */
        asked = want_req = waiting = 1;   /* memoria vacía: pedir la última copia (una vez por arranque) */
        hal_log("respaldo: la memoria está vacía; pido la última copia al servidor");
    }
}

void backup_after_night(void) { next_ms = hal_now_ms() + BACKUP_NIGHT_S * 1000LL; }

void backup_step(void)
{
    int64_t now = hal_now_ms();
    if (!link_up || phase || waiting || next_ms < 0 || now < next_ms) return;   /* sin pisar la copia buena del servidor */
    if (!body_runs()) return;   /* sin Alma aquí: una copia vieja no va a las copias del servidor (se manda al volver) */
    next_ms = now + BACKUP_EVERY_S * 1000LL;
    long k = alma_mem_export(app_mem(), buf, sizeof buf);
    if (k <= 0) { hal_log("respaldo: no se pudo exportar la memoria"); return; }
    n = (size_t)k;
    sent = 0;
    seq = 0;
    phase = 1;
    hal_log("respaldo: %u bytes al servidor (día %d)", (unsigned)n, app_alma()->age_days);
}

static size_t b64(const uint8_t *in, size_t len, char *out)
{
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t o = 0;
    for (size_t i = 0; i < len; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < len ? in[i + 1] << 8 : 0) | (i + 2 < len ? in[i + 2] : 0);
        out[o++] = T[v >> 18 & 63];
        out[o++] = T[v >> 12 & 63];
        out[o++] = i + 1 < len ? T[v >> 6 & 63] : '=';
        out[o++] = i + 2 < len ? T[v & 63] : '=';
    }
    return o;
}

/* base64 → rx (a partir de rx_n); −1 si no cabe o trae caracteres raros */
static int unb64(const char *s)
{
    uint32_t v = 0;
    int bits = 0;
    for (; *s; s++) {
        int c = *s;
        int d = c >= 'A' && c <= 'Z' ? c - 'A' : c >= 'a' && c <= 'z' ? c - 'a' + 26 : c >= '0' && c <= '9' ? c - '0' + 52
              : c == '+' ? 62 : c == '/' ? 63 : c == '=' ? -2 : -1;
        if (d == -2) break;
        if (d < 0) return -1;
        v = v << 6 | (uint32_t)d;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (rx_n >= sizeof rx) return -1;
            rx[rx_n++] = (uint8_t)(v >> bits);
        }
    }
    return 0;
}

long backup_take(char *out, size_t cap)
{
    if (want_req) {
        want_req = 0;
        return snprintf(out, cap, "{\"t\":\"mem_restore_req\"}");
    }
    if (phase != 1) return 0;
    size_t k = n - sent < BACKUP_CHUNK ? n - sent : BACKUP_CHUNK;
    int last = sent + k >= n;
    int m = snprintf(out, cap, "{\"t\":\"mem_backup\",\"seq\":%d,\"last\":%d,\"age\":%d,\"data\":\"", seq, last, app_alma()->age_days);
    if (m < 0 || (size_t)m + (k + 2) / 3 * 4 + 3 > cap) return 0;
    m += (int)b64(buf + sent, k, out + m);
    out[m++] = '"';
    out[m++] = '}';
    out[m] = 0;
    sent += k;
    seq++;
    if (last) phase = 0;
    return m;
}

void backup_restore_msg(const char *json)
{
    cJSON *j = cJSON_Parse(json);
    const cJSON *none = cJSON_GetObjectItemCaseSensitive(j, "none"), *sq = cJSON_GetObjectItemCaseSensitive(j, "seq");
    const cJSON *last = cJSON_GetObjectItemCaseSensitive(j, "last"), *data = cJSON_GetObjectItemCaseSensitive(j, "data");
    if (cJSON_IsTrue(none) || cJSON_IsNumber(none)) {
        waiting = 0;
        hal_log("respaldo: el servidor no tiene copias; Alma empieza de cero");
        cJSON_Delete(j);
        return;
    }
    int s = cJSON_IsNumber(sq) ? sq->valueint : -1;
    if (s == 0) { rx_n = 0; rx_seq = 0; rx_bad = 0; }
    if (s != rx_seq || !cJSON_IsString(data) || unb64(data->valuestring)) rx_bad = 1;
    rx_seq = s + 1;
    int done = cJSON_IsNumber(last) && last->valueint;
    cJSON_Delete(j);
    if (!done) return;
    waiting = 0;
    if (rx_bad) { hal_log("respaldo: la copia llegó incompleta; no se restaura"); outbox_event("mem_restore_failed", ""); return; }
    if (!app_mem_empty()) { hal_log("respaldo: Alma tiene memoria; la copia no la pisa"); return; }
    int r = app_mem_restore(rx, rx_n);
    hal_log("respaldo: %s (%u bytes)", r == 0 ? "memoria restaurada desde el servidor" : "no se pudo importar la copia", (unsigned)rx_n);
    char extra[48];
    snprintf(extra, sizeof extra, ",\"age_days\":%d", app_alma()->age_days);
    outbox_event(r == 0 ? "mem_restored" : "mem_restore_failed", r == 0 ? extra : "");
}
