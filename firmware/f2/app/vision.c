/* vision.c — ver vision.h */
#include "vision.h"

#include <stdio.h>
#include <string.h>

#include "app.h"
#include "cJSON.h"
#include "f2_hal.h"
#include "hal_k210.h"

static int phase;            /* 0 nada, 4 gesto de cámara, 1 tomando la foto, 2 mandando, 3 esperando respuesta */
static int seq, link_up, shots, owner_shot;   /* owner_shot: la foto en curso es la del dueño ("kind":"owner") */
static size_t sent_n, jpg_n;
static const uint8_t *jpg;
static int64_t t_last = -1000000000, t_wait;
static int64_t owner_since = -1, owner_last = -1000000000, t_gesture;

int vision_owner_on = 1;

void vision_init(void) { phase = shots = 0; t_last = owner_last = -1000000000; owner_since = -1; }
void vision_set_link(int up) { link_up = up; }

static int take(int64_t now, int owner)
{
    char name[24];
    snprintf(name, sizeof name, "alma_%d", ++shots);
    if (k210_photo_take(name) != 0) { hal_log("vista: el K210 está ocupado; no hay foto"); return -1; }
    t_last = now;   /* intente o no, la siguiente vez es en 3 minutos */
    owner_shot = owner;
    phase = 1;
    hal_log("vista: %s → foto \"%s\"", owner ? "tu dueño" : "algo a 10 cm o menos", name);
    return 0;
}

static int can_look(const alma_t *a)
{
    return a->state != ST_SLEEPING && a->state != ST_REFLEX && a->state != ST_LISTENING && a->state != ST_BOOT;
}

void vision_obstacle(void)
{
    int64_t now = hal_now_ms();
    if (phase || !link_up || now - t_last < (int64_t)VISION_COOLDOWN_S * 1000 || !can_look(app_alma())) return;
    take(now, 0);
}

/* foto del dueño: de frente VISION_OWNER_FACING_S seguidos, despierta, sin una orden en curso, de día y con el plazo */
static void owner_check(int64_t now)
{
    const alma_t *a = app_alma();
    int s = alma_slot_of(a, 0);
    if (!vision_owner_on || s < 0 || !a->person[s].present || !a->person[s].facing) { owner_since = -1; return; }
    if (owner_since < 0) owner_since = now;
    if (phase || !link_up || now - owner_since < (int64_t)VISION_OWNER_FACING_S * 1000) return;
    if (now - owner_last < (int64_t)VISION_OWNER_EVERY_S * 1000 || now - t_last < (int64_t)VISION_COOLDOWN_S * 1000) return;
    if (!can_look(a) || (a->cur.active && a->cur.hold >= 2) || alma_in_night_window(a, app_now_s())) return;
    if (k210_play(VISION_OWNER_GESTURE, NULL, 0) != 0) return;
    owner_last = t_gesture = now;   /* salga o no la foto, la siguiente es en 30 minutos */
    phase = 4;
    hal_log("vista: tu dueño de frente %d s → gesto de cámara (%s)", VISION_OWNER_FACING_S, VISION_OWNER_GESTURE);
}

void vision_step(void)
{
    int64_t now = hal_now_ms();
    if (phase == 0) owner_check(now);
    if (phase == 4) {
        if (now - t_gesture < VISION_GESTURE_MS) return;
        if (!link_up || !can_look(app_alma()) || take(now, 1) != 0) phase = 0;
    } else if (phase == 1) {
        k210_photo_state st = k210_photo_state_get();
        if (st == K210_PHOTO_BUSY) return;
        if (st != K210_PHOTO_OK || !link_up) {
            hal_log("vista: %s", st != K210_PHOTO_OK ? "no salió la foto" : "sin enlace con el servidor");
            k210_photo_release();
            phase = 0;
            return;
        }
        jpg = k210_photo_data(&jpg_n);
        sent_n = 0;
        seq = 0;
        phase = 2;
        hal_log("vista: foto de %u bytes al servidor", (unsigned)jpg_n);
    } else if (phase == 3 && hal_now_ms() - t_wait > (int64_t)VISION_WAIT_S * 1000) {
        hal_log("vista: el servidor no contestó en %d s", VISION_WAIT_S);
        phase = 0;
    }
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

long vision_take(char *out, size_t cap)
{
    if (phase != 2) return 0;
    size_t k = jpg_n - sent_n < VISION_CHUNK ? jpg_n - sent_n : VISION_CHUNK;
    int last = sent_n + k >= jpg_n;
    int n = snprintf(out, cap, "{\"t\":\"photo\",\"seq\":%d,\"last\":%d,%s\"jpg\":\"", seq, last,
                     seq == 0 && owner_shot ? "\"kind\":\"owner\"," : "");
    if (n < 0 || (size_t)n + (k + 2) / 3 * 4 + 3 > cap) return 0;
    n += (int)b64(jpg + sent_n, k, out + n);
    out[n++] = '"';
    out[n++] = '}';
    out[n] = 0;
    sent_n += k;
    seq++;
    if (last) {
        k210_photo_release();
        phase = 3;
        t_wait = hal_now_ms();
    }
    return n;
}

void vision_result(const char *json)
{
    cJSON *j = cJSON_Parse(json);
    const cJSON *orig = cJSON_GetObjectItemCaseSensitive(j, "origen");
    int from_app = cJSON_IsString(orig) && strcmp(orig->valuestring, "app") == 0;   /* foto que subió el dueño */
    if (!from_app) {
        if (phase != 3) { hal_log("vista: respuesta fuera de tiempo; se ignora"); cJSON_Delete(j); return; }
        phase = 0;
    }
    const cJSON *err = cJSON_GetObjectItemCaseSensitive(j, "error"), *ob = cJSON_GetObjectItemCaseSensitive(j, "objeto");
    const cJSON *re = cJSON_GetObjectItemCaseSensitive(j, "reaccion"), *co = cJSON_GetObjectItemCaseSensitive(j, "conducta");
    int e = cJSON_IsString(re) ? alma_vision_ev_of(re->valuestring) : -1;
    hal_log("vista: %s%.60s → %s, %s", cJSON_IsString(err) ? "error " : "",
            cJSON_IsString(err) ? err->valuestring : cJSON_IsString(ob) ? ob->valuestring : "?", e >= 0 ? re->valuestring : "sin reacción",
            cJSON_IsString(co) ? co->valuestring : "sin conducta");
    if (e >= 0) app_vision_event((alma_vision_ev)e, cJSON_IsString(co) ? co->valuestring : NULL);
    cJSON_Delete(j);
}
