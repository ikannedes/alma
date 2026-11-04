/* fiesta.c — ver fiesta.h */
#include "fiesta.h"

#include <stdio.h>
#include <string.h>

#include "app.h"
#include "cJSON.h"
#include "f2_hal.h"
#include "hal_k210.h"
#include "home.h"
#include "outbox.h"

#define FIRST_MIN_MS  (2 * 60000)
#define FIRST_MAX_MS  (10 * 60000)
#define GAP_MIN_MS    (40 * 60000)
#define GAP_MAX_MS    (80 * 60000)

static struct {
    uint8_t *buf;                       /* la cara que llega (hal_big_alloc); se suelta al terminar de subirla */
    size_t n, cap;
    int next_seq, complete, uploading;
    char name[FIESTA_NAME_MAX + 1];     /* la que llega o se sube */
    char ext[4];                        /* "avi" o "mp3" */
    char active[FIESTA_NAME_MAX + 1];   /* la del día */
    int plays;
    int64_t next_ms;
    uint32_t rng;
} F;

static uint32_t rnd(void)
{
    if (!F.rng) F.rng = (uint32_t)hal_now_ms() * 2654435761u | 1u;
    F.rng ^= F.rng << 13;
    F.rng ^= F.rng >> 17;
    F.rng ^= F.rng << 5;
    return F.rng;
}
static int64_t between(int64_t a, int64_t b) { return a + (int64_t)(rnd() % (uint32_t)(b - a + 1)); }

static int valid_name(const char *s)
{
    size_t n = s ? strlen(s) : 0;
    if (n > FIESTA_NAME_MAX) return 0;
    for (size_t i = 0; i < n; i++)
        if (!((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= '0' && s[i] <= '9') || s[i] == '_')) return 0;
    return 1;
}

static void drop(void)
{
    if (F.buf) hal_big_free(F.buf);
    F.buf = NULL;
    F.n = 0;
    F.next_seq = F.complete = F.uploading = 0;
}

static void reply(const char *t, const char *name)
{
    char j[96];
    snprintf(j, sizeof j, "{\"t\":\"%s\",\"nombre\":\"%s\"}", t, name);
    outbox_put(j);
}

static void fail(const char *why)
{
    hal_log("fiesta: la cara \"%s\" no se pudo recibir (%s)", F.name, why);
    reply("cara_error", F.name);
    drop();
}

void fiesta_init(void)
{
    drop();
    memset(&F, 0, sizeof F);
}

static int b64v(int c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    return c == '+' ? 62 : c == '/' ? 63 : -1;
}

/* decodifica b64 al final del búfer; −1 si es inválido o no cabe */
static int append_b64(const char *s)
{
    uint32_t acc = 0;
    int bits = 0;
    for (; *s && *s != '='; s++) {
        int v = b64v((unsigned char)*s);
        if (v < 0) return -1;
        acc = acc << 6 | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (F.n >= F.cap) return -1;
            F.buf[F.n++] = (uint8_t)(acc >> bits);
        }
    }
    return 0;
}

static void chunk(const cJSON *j)
{
    const cJSON *nm = cJSON_GetObjectItemCaseSensitive(j, "nombre"), *sq = cJSON_GetObjectItemCaseSensitive(j, "seq");
    const cJSON *ls = cJSON_GetObjectItemCaseSensitive(j, "last"), *b = cJSON_GetObjectItemCaseSensitive(j, "b64");
    if (!cJSON_IsString(nm) || !valid_name(nm->valuestring) || !*nm->valuestring || !cJSON_IsNumber(sq) || !cJSON_IsString(b)) {
        hal_log("fiesta: trozo de cara inválido");
        return;
    }
    if (sq->valueint == 0) {   /* empieza una cara (si había otra a medias, se tira) */
        if (F.uploading) { hal_log("fiesta: llegó otra cara mientras se subía \"%s\"; se ignora", F.name); return; }
        drop();
        snprintf(F.name, sizeof F.name, "%s", nm->valuestring);
        const cJSON *ex = cJSON_GetObjectItemCaseSensitive(j, "ext");
        snprintf(F.ext, sizeof F.ext, "%s", cJSON_IsString(ex) && !strcmp(ex->valuestring, "mp3") ? "mp3" : "avi");
        const cJSON *sz = cJSON_GetObjectItemCaseSensitive(j, "size");
        F.cap = cJSON_IsNumber(sz) && sz->valuedouble > 0 && sz->valuedouble <= FIESTA_MAX ? (size_t)sz->valuedouble : FIESTA_DEFAULT;
        F.buf = hal_big_alloc(F.cap);
        if (!F.buf) {
            hal_log("fiesta: sin memoria para %u bytes (bloque libre más grande: %u)", (unsigned)F.cap, (unsigned)hal_big_largest());
            fail("sin memoria");
            return;
        }
    }
    if (!F.buf || strcmp(F.name, nm->valuestring) || sq->valueint != F.next_seq) {
        if (F.uploading) { hal_log("fiesta: trozo de \"%s\" mientras se sube \"%s\"; se ignora", nm->valuestring, F.name); return; }
        snprintf(F.name, sizeof F.name, "%s", nm->valuestring);   /* el error es de la que llegó */
        fail("trozo fuera de orden");
        return;
    }
    if (append_b64(b->valuestring)) { fail("demasiado grande o mal codificada"); return; }
    F.next_seq++;
    if (cJSON_IsTrue(ls)) {
        F.complete = 1;
        hal_log("fiesta: cara \"%s\" recibida (%u bytes en %d trozos)", F.name, (unsigned)F.n, F.next_seq);
    }
}

static void set_active(const char *name)
{
    if (!strcmp(F.active, name)) return;   /* la misma de hoy: sigue la cuenta */
    snprintf(F.active, sizeof F.active, "%s", name);
    F.plays = 0;
    F.next_ms = hal_now_ms() + between(FIRST_MIN_MS, FIRST_MAX_MS);
    hal_log("fiesta: %s", *name ? name : "ninguna hoy");
}

int fiesta_msg(const char *type, const char *json, char *out, size_t cap)
{
    (void)out; (void)cap;
    cJSON *j = cJSON_Parse(json);
    if (!strcmp(type, "cara")) chunk(j);
    else if (!strcmp(type, "fiesta")) {
        const cJSON *nm = cJSON_GetObjectItemCaseSensitive(j, "nombre");
        if (cJSON_IsString(nm) && valid_name(nm->valuestring)) set_active(nm->valuestring);
    }
    cJSON_Delete(j);
    return 0;
}

/* ¿Alma está para que salga la cara? De día, despierta, sin reflejo ni escucha ni orden, sin ir a casa, y sin hacer
   nada o haciendo algo ocioso: la cara es una de "sus actividades normales" */
static int calm(void)
{
    const alma_t *a = app_alma();
    if (app_body_asleep() || home_active() || alma_in_night_window(a, app_now_s())) return 0;
    if (a->state == ST_SLEEPING || a->state == ST_REFLEX || a->state == ST_LISTENING || a->state == ST_BOOT) return 0;
    if (a->cur.active && (a->cur.hold >= 2 || app_catalog()->b[a->cur.behavior].category != CAT_IDLE)) return 0;
    return k210_get_state() == K210_READY && k210_file_state_get() != K210_FILE_BUSY && k210_photo_state_get() != K210_PHOTO_BUSY;
}

void fiesta_step(int64_t now)
{
    if (F.complete && !F.uploading) {   /* subirla cuando el K210 esté libre */
        if (k210_get_state() == K210_READY && k210_file_state_get() != K210_FILE_BUSY && k210_photo_state_get() != K210_PHOTO_BUSY) {
            char file[FIESTA_NAME_MAX + 8];
            snprintf(file, sizeof file, "%s.%s", F.name, F.ext);
            if (k210_file_send("test", file, F.buf, F.n) == 0) F.uploading = 1;
        }
    } else if (F.uploading && k210_file_state_get() != K210_FILE_BUSY) {
        int ok = k210_file_state_get() == K210_FILE_OK;
        hal_log("fiesta: cara \"%s\" %s", F.name, ok ? "ya está en la SD del K210" : "no se pudo subir");
        reply(ok ? "cara_ok" : "cara_error", F.name);
        drop();
    }
    if (!*F.active || F.plays >= FIESTA_PLAYS || now < F.next_ms || F.uploading || !calm()) return;
    char path[FIESTA_NAME_MAX + 16];
    snprintf(path, sizeof path, "/test/%s.avi", F.active);
    if (k210_play_path(path, NULL, 0) != 0) return;
    F.plays++;
    F.next_ms = now + between(GAP_MIN_MS, GAP_MAX_MS);
    hal_log("fiesta: %s (%d/%d)", F.active, F.plays, FIESTA_PLAYS);
}

const char *fiesta_active(void) { return F.active; }
int fiesta_plays(void) { return F.plays; }
