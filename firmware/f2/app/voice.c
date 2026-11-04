/* voice.c — ver voice.h */
#include "voice.h"

#include <stdio.h>
#include <string.h>

#include "app.h"
#include "cJSON.h"
#include "f2_hal.h"
#include "hal_k210.h"

#define RATE 16000
#define MAX_BYTES (3 * RATE * 2)   /* LISTEN_RECORD_MAX_S (3 s, alma_params.h) de PCM de 16 bits */
_Static_assert(LISTEN_RECORD_MAX_S == 3.0f, "MAX_BYTES sigue a LISTEN_RECORD_MAX_S");
#define WANT_AFTER_MS 1200         /* tras la palabra de activación: 06 con bit1 (el K210 empieza a grabar ~1 s después) */
#define WANT_RETRY_MS 300          /* sin audio ni fin: otra vez, hasta WANT_TRIES (si llegó antes de que grabara, lo borra) */
#define WANT_TRIES    3

static EXT_RAM_BSS_ATTR uint8_t pcm[MAX_BYTES];
static size_t pcm_n, sent_n;
static int phase;            /* 0 nada, 1 grabando, 2 mandando, 3 esperando respuesta */
static int seq, link_up, wants, was_listening;
static int64_t t_rec, t_wait;

static void on_pcm(const uint8_t *p, size_t n)
{
    if (phase != 1) return;
    if (n > MAX_BYTES - pcm_n) n = MAX_BYTES - pcm_n;
    memcpy(pcm + pcm_n, p, n);
    pcm_n += n;
}

static void fail(const char *why)
{
    hal_log("voz: %s → EV_VOICE_FAILED", why);
    k210_mic(0, NULL);
    phase = 0;
    alma_ev e = {EV_VOICE_FAILED, -1, -1, -1, 0, 0, 0, 0};
    app_post(&e);
}

void voice_init(void) { phase = was_listening = 0; pcm_n = sent_n = 0; }
void voice_set_link(int up) { link_up = up; }

void voice_step(void)
{
    int listening = app_alma()->state == ST_LISTENING;
    int64_t now = hal_now_ms();
    int started = listening && !was_listening;   /* solo al empezar: tras la respuesta sigue un instante en ST_LISTENING */
    was_listening = listening;
    if (phase == 0 && started) {
        pcm_n = sent_n = 0;
        seq = wants = 0;
        t_rec = now;
        if (k210_mic(1, on_pcm) == 0) phase = 1;
        return;
    }
    if (phase && !listening && phase != 3) { k210_mic(0, NULL); phase = 0; return; }   /* un reflejo cortó la escucha */
    if (phase == 1 && wants < WANT_TRIES && !k210_mic_chunks() && !(wants && k210_mic_ended())
        && now - t_rec >= WANT_AFTER_MS + (int64_t)wants * WANT_RETRY_MS) {
        /* desde el primero cuentan los 3 s de grabación (t_rec queda WANT_AFTER_MS antes) */
        if (k210_mic_want() == 0 && wants++ == 0) {
            t_rec = now - WANT_AFTER_MS;
            /* la señal de que ya escucha (dueño, 2026-11-03: "normalmente sólo hacía un sonido"): ahora, no con la
               palabra, porque el K210 empieza a grabar ~1 s después y lo que se dice antes se pierde */
            k210_play("listen_and_think", "listen_and_think_000", 1);
        }
    }
    if (phase == 1 && ((k210_mic_ended() && (wants || k210_mic_chunks())) || pcm_n >= MAX_BYTES
                       || now - t_rec >= WANT_AFTER_MS + (int64_t)(LISTEN_RECORD_MAX_S * 1000))) {
        k210_mic(0, NULL);
        hal_log("voz: %u bytes (%.1f s) grabados", (unsigned)pcm_n, pcm_n / (2.0 * RATE));
        if (pcm_n < RATE / 5) fail("casi nada de audio (¿micrófono del K210?)");
        else if (!link_up) fail("sin enlace con el servidor (no_network)");
        else { phase = 2; t_wait = now; }
        return;
    }
    if ((phase == 2 || phase == 3) && now - t_wait > (int64_t)(LISTEN_CLOUD_WAIT_S * 1000)) fail("el servidor no contestó en 6 s (timeout)");
}

static size_t b64(const uint8_t *in, size_t n, char *out)
{
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t o = 0;
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < n ? in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
        out[o++] = T[v >> 18 & 63];
        out[o++] = T[v >> 12 & 63];
        out[o++] = i + 1 < n ? T[v >> 6 & 63] : '=';
        out[o++] = i + 2 < n ? T[v & 63] : '=';
    }
    return o;
}

long voice_take(char *out, size_t cap)
{
    if (phase != 2) return 0;
    size_t k = pcm_n - sent_n < VOICE_CHUNK ? pcm_n - sent_n : VOICE_CHUNK;
    int last = sent_n + k >= pcm_n;
    int n = snprintf(out, cap, "{\"t\":\"voice\",\"seq\":%d,\"last\":%d,\"rate\":%d,\"pcm\":\"", seq, last, RATE);
    if (n < 0 || (size_t)n + (k + 2) / 3 * 4 + 3 > cap) return 0;
    n += (int)b64(pcm + sent_n, k, out + n);
    out[n++] = '"';
    out[n++] = '}';
    out[n] = 0;
    sent_n += k;
    seq++;
    if (last) phase = 3;
    return n;
}

void voice_result(const char *json)
{
    if (phase != 3 && phase != 2) { hal_log("voz: respuesta fuera de tiempo; se ignora"); return; }
    phase = 0;
    cJSON *j = cJSON_Parse(json);
    const cJSON *err = cJSON_GetObjectItemCaseSensitive(j, "error"), *in = cJSON_GetObjectItemCaseSensitive(j, "intent");
    const cJSON *ac = cJSON_GetObjectItemCaseSensitive(j, "action_id"), *cf = cJSON_GetObjectItemCaseSensitive(j, "confidence");
    const cJSON *tx = cJSON_GetObjectItemCaseSensitive(j, "transcript");
    float conf = cJSON_IsNumber(cf) ? (float)cf->valuedouble : 0;
    const char *intent = cJSON_IsString(in) ? in->valuestring : "none";
    hal_log("voz: \"%.80s\" → %s %s (%.2f)%s%s", cJSON_IsString(tx) ? tx->valuestring : "", intent,
            cJSON_IsString(ac) ? ac->valuestring : "", conf, cJSON_IsString(err) ? " error: " : "",
            cJSON_IsString(err) ? err->valuestring : "");
    alma_ev e = {EV_VOICE_FAILED, -1, -1, -1, 0, 0, 0, 0};
    if (!cJSON_IsString(err) && conf >= VOICE_MIN_CONF) {
        int act = cJSON_IsString(ac) ? app_action_of(ac->valuestring) : -1;
        if (strcmp(intent, "action") == 0 && act >= 0) { e.type = EV_VOICE_COMMAND; e.action_id = act; }
        else if (strcmp(intent, "praise") == 0) e.type = EV_PRAISE;
        else if (strcmp(intent, "scold") == 0) e.type = EV_SCOLD;
    }
    cJSON_Delete(j);
    /* que se note que entendió (dueño, 2026-11-03: "para saber que sí entendió"): un guiño con un elogio, carita triste con
       un regaño, antes de la reacción; si el núcleo elige una reacción grande, su cara tapa esta */
    if (e.type == EV_PRAISE) k210_play("stay_wink_1", NULL, 0);
    else if (e.type == EV_SCOLD) k210_play("mood_sad", NULL, 0);
    app_post(&e);
}
