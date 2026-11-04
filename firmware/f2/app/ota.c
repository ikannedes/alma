/* ota.c — ver ota.h */
#include "ota.h"

#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "f2_hal.h"
#include "motion_player.h"

#define OTA_CHUNK_MAX 9216   /* datos por trozo (el servidor manda 9000) */

static struct {
    int on;                  /* recibiendo */
    int ready;               /* escrita y verificada: falta ota_reboot */
    int next;                /* el siguiente seq que se espera */
    size_t size, n;
    char sha[65];
    int64_t trial_t0;        /* arranque a prueba: desde cuándo (−1 = no) */
} O;
static uint8_t chunk[OTA_CHUNK_MAX];

static long reply(char *out, size_t cap, const char *t, const char *why)
{
    int n = why ? snprintf(out, cap, "{\"t\":\"%s\",\"why\":\"%s\"}", t, why) : snprintf(out, cap, "{\"t\":\"%s\"}", t);
    return n > 0 && (size_t)n < cap ? n : 0;
}

static long fail(char *out, size_t cap, const char *why)
{
    if (O.on) hal_ota_abort();
    hal_log("ota: error (%s); el arranque queda como estaba", why);
    O.on = O.ready = 0;
    return reply(out, cap, "ota_error", why);
}

void ota_init(void)
{
    memset(&O, 0, sizeof O);
    O.trial_t0 = -1;
    char prev[17];
    if (hal_ota_trial(prev, sizeof prev)) {
        O.trial_t0 = hal_now_ms();
        hal_log("ota: arranque a prueba en %s; si en %d s no hay servidor, vuelve a %s", hal_ota_running_label(),
                OTA_TRIAL_MS / 1000, prev);
    }
}

static int b64v(int c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    return c == '+' ? 62 : c == '/' ? 63 : -1;
}

static long b64dec(const char *s, uint8_t *dst, size_t cap)
{
    uint32_t acc = 0;
    int bits = 0;
    size_t n = 0;
    for (; *s && *s != '='; s++) {
        int v = b64v((unsigned char)*s);
        if (v < 0) return -1;
        acc = acc << 6 | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (n >= cap) return -1;
            dst[n++] = (uint8_t)(acc >> bits);
        }
    }
    return (long)n;
}

long ota_msg(const char *type, const char *json, char *out, size_t cap)
{
    if (strcmp(type, "ota_reboot") == 0) {
        if (!O.ready) return fail(out, cap, "no hay firmware verificado");
        hal_log("ota: reinicio confirmado; arranca la nueva (a prueba %d s)", OTA_TRIAL_MS / 1000);
        hal_ota_set_boot_and_restart();   /* en el robot no regresa */
        O.ready = 0;
        return 0;
    }
    cJSON *j = cJSON_Parse(json);
    long n = 0;
    if (strcmp(type, "ota_begin") == 0) {
        const cJSON *sz = cJSON_GetObjectItemCaseSensitive(j, "size"), *sh = cJSON_GetObjectItemCaseSensitive(j, "sha256");
        const cJSON *ve = cJSON_GetObjectItemCaseSensitive(j, "version");
        if (O.on) hal_ota_abort();
        O.on = O.ready = 0;
        if (!cJSON_IsNumber(sz) || sz->valuedouble <= 0 || !cJSON_IsString(sh) || strlen(sh->valuestring) != 64)
            n = fail(out, cap, "ota_begin sin size o sha256");
        else if (hal_ota_begin((size_t)sz->valuedouble))
            n = fail(out, cap, "no se pudo preparar la partición");
        else {
            O.on = 1;
            O.next = 0;
            O.n = 0;
            O.size = (size_t)sz->valuedouble;
            snprintf(O.sha, sizeof O.sha, "%s", sh->valuestring);
            motion_stop_now();
            hal_log("ota: recibiendo %s (%u bytes) en la partición libre (corre %s)",
                    cJSON_IsString(ve) ? ve->valuestring : "?", (unsigned)O.size, hal_ota_running_label());
            n = reply(out, cap, "ota_ready", NULL);
        }
    } else if (strcmp(type, "ota") == 0) {
        const cJSON *sq = cJSON_GetObjectItemCaseSensitive(j, "seq"), *ls = cJSON_GetObjectItemCaseSensitive(j, "last");
        const cJSON *b = cJSON_GetObjectItemCaseSensitive(j, "b64");
        long k;
        if (!O.on) n = fail(out, cap, "trozo sin ota_begin");
        else if (!cJSON_IsNumber(sq) || sq->valueint != O.next) n = fail(out, cap, "trozo fuera de orden");
        else if (!cJSON_IsString(b) || (k = b64dec(b->valuestring, chunk, sizeof chunk)) <= 0) n = fail(out, cap, "trozo mal codificado");
        else if (O.n + (size_t)k > O.size) n = fail(out, cap, "más datos que size");
        else if (hal_ota_write(chunk, (size_t)k)) n = fail(out, cap, "no se pudo escribir la flash");
        else {
            motion_stop_now();   /* mientras llega, sin servos */
            O.n += (size_t)k;
            O.next++;
            if (O.next % 32 == 0) hal_log("ota: %u de %u bytes", (unsigned)O.n, (unsigned)O.size);
            if (cJSON_IsTrue(ls)) {
                if (O.n != O.size) n = fail(out, cap, "tamaño distinto");
                else if (hal_ota_end_and_check(O.sha)) n = fail(out, cap, "SHA-256 distinto o imagen inválida");
                else {
                    O.on = 0;
                    O.ready = 1;
                    hal_log("ota: %u bytes verificados (SHA-256 %.12s…); falta ota_reboot", (unsigned)O.n, O.sha);
                    int m = snprintf(out, cap, "{\"t\":\"ota_ok\",\"sha256\":\"%s\"}", O.sha);
                    n = m > 0 && (size_t)m < cap ? m : 0;
                }
            }
        }
    }
    cJSON_Delete(j);
    return n;
}

void ota_link(int up)
{
    if (!up && O.on) {
        hal_ota_abort();
        O.on = 0;
        hal_log("ota: se cortó el enlace a media recepción; el siguiente intento empieza de cero");
    }
}

void ota_welcome(void)
{
    if (O.trial_t0 < 0) return;
    O.trial_t0 = -1;
    hal_ota_trial_confirm();
    hal_log("ota: el servidor contestó: %s confirmada", hal_ota_running_label());
}

void ota_step(int64_t now_ms)
{
    if (O.trial_t0 >= 0 && now_ms - O.trial_t0 >= OTA_TRIAL_MS) {
        O.trial_t0 = -1;
        hal_log("ota: %d s sin servidor: vuelve a la partición anterior", OTA_TRIAL_MS / 1000);
        hal_ota_trial_revert();   /* en el robot no regresa */
    }
}

int ota_receiving(void) { return O.on; }
