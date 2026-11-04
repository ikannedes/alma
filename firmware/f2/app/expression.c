#include "expression.h"

#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "f2_hal.h"
#include "hal_k210.h"
#include "motion_player.h"

static EXT_RAM_BSS_ATTR expr_face faces[ALMA_MAX_BEHAVIORS][EXPR_MAX_FACES];
static int n_faces[ALMA_MAX_BEHAVIORS], next_face[ALMA_MAX_BEHAVIORS];
static const alma_catalog *C;
static int seq_next(void);
static EXT_RAM_BSS_ATTR struct { char mot[ALMA_MOT_LEN]; expr_face f; } media[EXPR_MAX_MEDIA];
static int n_media;
static int64_t last_mood_face_ms = INT64_MIN / 2;
/* Con música de afuera (dueño, 2026-11-02: "él no debe poner música, sólo bailar"): las caras van sin su .mp3 */
static int64_t mute_until = -1;
void expression_mute_until(int64_t until_ms) { mute_until = until_ms; }
static const char *snd(const char *mp3) { return hal_now_ms() < mute_until ? NULL : mp3; }

int expression_init(const char *catalog_text, const alma_catalog *cat)
{
    C = cat;
    memset(n_faces, 0, sizeof n_faces);
    memset(next_face, 0, sizeof next_face);
    cJSON *root = cJSON_Parse(catalog_text);
    if (!root) return -1;
    const cJSON *b;
    cJSON_ArrayForEach(b, cJSON_GetObjectItemCaseSensitive(root, "behaviors")) {
        const cJSON *id = cJSON_GetObjectItemCaseSensitive(b, "id");
        int ix = cJSON_IsString(id) ? alma_find(cat, id->valuestring) : -1;
        if (ix < 0) continue;
        const cJSON *f;
        cJSON_ArrayForEach(f, cJSON_GetObjectItemCaseSensitive(b, "faces")) {
            const cJSON *avi = cJSON_GetObjectItemCaseSensitive(f, "avi"), *mp3 = cJSON_GetObjectItemCaseSensitive(f, "mp3"),
                        *mode = cJSON_GetObjectItemCaseSensitive(f, "mode");
            const cJSON *sq = cJSON_GetObjectItemCaseSensitive(f, "seq");
            if ((!cJSON_IsString(avi) && !cJSON_IsArray(sq)) || n_faces[ix] >= EXPR_MAX_FACES) continue;
            expr_face *e = &faces[ix][n_faces[ix]++];
            memset(e, 0, sizeof *e);
            e->hhmm0 = e->hhmm1 = -1;
            if (cJSON_IsArray(sq)) {
                const cJSON *it, *snd = cJSON_GetObjectItemCaseSensitive(f, "snd"), *hr = cJSON_GetObjectItemCaseSensitive(f, "hours");
                cJSON_ArrayForEach(it, sq) {
                    if (!cJSON_IsString(it) || e->n_seq >= EXPR_MAX_SEQ) continue;
                    snprintf(e->seq[e->n_seq], EXPR_NAME_LEN, "%s", it->valuestring);
                    const cJSON *s2;
                    cJSON_ArrayForEach(s2, snd) if (cJSON_IsString(s2) && strcmp(s2->valuestring, it->valuestring) == 0) e->snd[e->n_seq] = 1;
                    e->n_seq++;
                }
                if (cJSON_GetArraySize(hr) == 2) { e->hhmm0 = cJSON_GetArrayItem(hr, 0)->valueint; e->hhmm1 = cJSON_GetArrayItem(hr, 1)->valueint; }
                snprintf(e->avi, sizeof e->avi, "%s", e->n_seq ? e->seq[0] : "");
                continue;
            }
            snprintf(e->avi, sizeof e->avi, "%s", avi->valuestring);
            snprintf(e->mp3, sizeof e->mp3, "%s", cJSON_IsString(mp3) ? mp3->valuestring : "");
            e->mode = cJSON_IsNumber(mode) ? mode->valueint : 0;
        }
    }
    n_media = 0;
    const cJSON *m;
    cJSON_ArrayForEach(m, cJSON_GetObjectItemCaseSensitive(root, "media")) {
        const cJSON *avi = cJSON_GetObjectItemCaseSensitive(m, "avi"), *mp3 = cJSON_GetObjectItemCaseSensitive(m, "mp3");
        if (n_media >= EXPR_MAX_MEDIA || !m->string || strlen(m->string) >= ALMA_MOT_LEN) continue;
        snprintf(media[n_media].mot, ALMA_MOT_LEN, "%s", m->string);
        expr_face *e = &media[n_media++].f;
        snprintf(e->avi, sizeof e->avi, "%s", cJSON_IsString(avi) ? avi->valuestring : "");
        snprintf(e->mp3, sizeof e->mp3, "%s", cJSON_IsString(mp3) ? mp3->valuestring : "");
        e->mode = 0;
    }
    cJSON_Delete(root);
    k210_set_done_cb(seq_next);
    return 0;
}

/* ---- secuencias de las rutinas ---- */
static struct { int active, pos; const expr_face *f; int64_t until, t_play; } S;
/* una animación que "termina" en menos de esto no está en la SD del K210 (2026-11-03: Daily_Work_stamp_loop1/2 no
   estaban y la rutina daba vueltas cada 70 ms durante 225 s, "se traba") */
#define SEQ_MISSING_MS 300
static void (*seq_motion)(const char *mot);
void expression_set_seq_motion(void (*cb)(const char *mot)) { seq_motion = cb; }

static void seq_play(int pos)
{
    char mp3[EXPR_NAME_LEN + 8];
    S.pos = pos;
    S.t_play = hal_now_ms();
    snprintf(mp3, sizeof mp3, "%s_000", S.f->seq[pos]);
    k210_set_fallback(NULL, NULL);
    k210_play(S.f->seq[pos], snd(S.f->snd[pos] ? mp3 : NULL), 0);
    if (seq_motion) seq_motion(S.f->seq[pos]);
}

/* con cada 08 00: inicio → repeticiones (mientras quede tiempo) → final */
static int seq_next(void)
{
    if (!S.active) return 0;
    int n = S.f->n_seq, last = n - 1;
    if (S.pos == last) { S.active = 0; return 0; }
    if (hal_now_ms() - S.t_play < SEQ_MISSING_MS && S.pos > 0) {   /* no está: sin repeticiones, el final */
        hal_log("rutina: %s no está en la SD; va el final", S.f->seq[S.pos]);
        seq_play(last);
        return 1;
    }
    int loops = n - 2;
    if (loops <= 0 || hal_now_ms() >= S.until) { seq_play(last); return 1; }
    seq_play(S.pos < 1 || S.pos >= last - 0 ? 1 : 1 + (S.pos % loops));
    return 1;
}

static int in_hours(const expr_face *e, int hhmm)
{
    if (e->hhmm0 < 0) return 1;
    return e->hhmm0 <= e->hhmm1 ? hhmm >= e->hhmm0 && hhmm < e->hhmm1 : hhmm >= e->hhmm0 || hhmm < e->hhmm1;
}

int expression_play_seq(int behavior, int hhmm, float planned_s)
{
    if (behavior < 0 || behavior >= ALMA_MAX_BEHAVIORS) return -1;
    int cand[EXPR_MAX_FACES], n = 0, any = 0;
    for (int i = 0; i < n_faces[behavior]; i++) {
        if (!faces[behavior][i].n_seq) continue;
        any++;
        if (in_hours(&faces[behavior][i], hhmm)) cand[n++] = i;
    }
    if (!any) return -1;
    if (!n)   /* ninguna a esta hora: cualquiera (el dueño quiere que haga cosas) */
        for (int i = 0; i < n_faces[behavior]; i++) if (faces[behavior][i].n_seq) cand[n++] = i;
    const expr_face *f = &faces[behavior][cand[next_face[behavior]++ % n]];
    S.active = 1;
    S.f = f;
    S.until = hal_now_ms() + (int64_t)(planned_s * 1000.0f) - 4000;   /* deja tiempo para el final */
    hal_log("rutina: %s (%d animaciones, %.0f s)", f->seq[0], f->n_seq, planned_s);
    seq_play(0);
    return 0;
}

void expression_stop(int graceful)
{
    if (!S.active) return;
    if (graceful && S.pos != S.f->n_seq - 1) { S.until = 0; return; }   /* el siguiente 08 00 pone el final */
    S.active = 0;
}

const expr_face *expression_media(const char *mot)
{
    for (int i = 0; mot && i < n_media; i++)
        if (strcmp(media[i].mot, mot) == 0) return &media[i].f;
    return NULL;
}

int expression_play_exec(int behavior, const char *mot, float valence)
{
    if (behavior < 0 || behavior >= ALMA_MAX_BEHAVIORS) return -1;
    const expr_face *md = expression_media(mot);
    if (md && md->avi[0]) {
        /* si el .avi del .mot no está en la SD de esta unidad, va la cara de la conducta */
        if (n_faces[behavior]) {
            const expr_face *e = &faces[behavior][next_face[behavior]];
            k210_set_fallback(e->avi, snd(e->mp3[0] ? e->mp3 : NULL));
        }
        return k210_play(md->avi, snd(md->mp3[0] ? md->mp3 : NULL), 0);
    }
    k210_set_fallback(NULL, NULL);
    int64_t now = hal_now_ms();
    if (C && C->b[behavior].category == CAT_IDLE && now - last_mood_face_ms >= EXPR_MOOD_EVERY_MS
        && (valence > SM_HAPPY_VALENCE || valence < EXPR_SAD_VALENCE)) {
        last_mood_face_ms = now;
        return valence > 0 ? k210_play("mood_happy", snd("mood_happy_000"), 0) : k210_play("mood_sad", snd("mood_sad_000"), 0);
    }
    if (md && md->mp3[0] && n_faces[behavior]) {   /* el .mot solo trae sonido: con la cara de la conducta */
        const expr_face *e = &faces[behavior][next_face[behavior]];
        next_face[behavior] = (next_face[behavior] + 1) % n_faces[behavior];
        return k210_play(e->avi, snd(md->mp3), e->mode);
    }
    return expression_play(behavior);
}

int expression_avis(const char **out, int max)
{
    int n = 0;
    for (int b = 0; b < ALMA_MAX_BEHAVIORS; b++)
        for (int i = 0; i < n_faces[b]; i++) {
            const expr_face *e = &faces[b][i];
            if (e->n_seq) for (int k = 0; k < e->n_seq && n < max; k++) out[n++] = e->seq[k];
            else if (e->avi[0] && n < max) out[n++] = e->avi;
        }
    for (int i = 0; i < n_media && n < max; i++) if (media[i].f.avi[0]) out[n++] = media[i].f.avi;
    return n;
}

int expression_faces(int behavior, const expr_face **out)
{
    if (behavior < 0 || behavior >= ALMA_MAX_BEHAVIORS) return 0;
    *out = faces[behavior];
    return n_faces[behavior];
}

int expression_play(int behavior)
{
    if (behavior < 0 || behavior >= ALMA_MAX_BEHAVIORS) return -1;
    if (!n_faces[behavior]) {
        /* "avi": null con "tbd" en el catálogo: la cara se elige al ver las animaciones del K210 (05) */
        hal_log("expression: %s no tiene cara asignada todavía (tbd en catalog.json)", C ? C->b[behavior].id : "?");
        return -1;
    }
    const expr_face *e = &faces[behavior][next_face[behavior]];
    next_face[behavior] = (next_face[behavior] + 1) % n_faces[behavior];
    return k210_play(e->avi, snd(e->mp3[0] ? e->mp3 : NULL), e->mode);
}

static int add_inventory(cJSON *mot, const char *name)
{
    if (cJSON_GetObjectItemCaseSensitive(mot, name)) return 0;
    static EXT_RAM_BSS_ATTR mot_frame f[MOTION_MAX_FRAMES];
    int n = motion_load(name, f, MOTION_MAX_FRAMES);
    if (n <= 0) { hal_log("inventario: %s no está en la SPIFFS o es inválido", name); return 0; }
    long ms = 0;
    int gait = 0;
    for (int k = 0; k < n; k++) { ms += mot_frame_ms(&f[k]); gait |= f[k].mode != MOT_MODE_POSE; }
    cJSON *e = cJSON_CreateObject();
    cJSON_AddNumberToObject(e, "frames", n);
    cJSON_AddNumberToObject(e, "dur_s", ms / 1000.0);   /* como make_inventory.py: poses ms, primitivas pasos × T */
    cJSON_AddBoolToObject(e, "gait", gait);
    cJSON_AddItemToObject(mot, name, e);
    return 1;
}

long expression_build_inventory(const char *catalog_text, char *out, size_t cap)
{
    cJSON *root = cJSON_Parse(catalog_text);
    if (!root) return -1;
    cJSON *inv = cJSON_CreateObject(), *mot = cJSON_AddObjectToObject(inv, "mot");
    const cJSON *b, *o, *m;
    int n = 0;
    cJSON_ArrayForEach(b, cJSON_GetObjectItemCaseSensitive(root, "behaviors")) {
        const cJSON *motion = cJSON_GetObjectItemCaseSensitive(b, "motion");
        cJSON_ArrayForEach(o, cJSON_GetObjectItemCaseSensitive(motion, "options")) {
            if (cJSON_IsString(o)) n += add_inventory(mot, o->valuestring);
            else cJSON_ArrayForEach(m, o) if (cJSON_IsString(m)) n += add_inventory(mot, m->valuestring);
        }
    }
    long len = -1;
    if (cJSON_PrintPreallocated(inv, out, (int)cap, 0)) len = (long)strlen(out);
    hal_log("inventario: %d .mot leídos de la SPIFFS", n);
    cJSON_Delete(inv);
    cJSON_Delete(root);
    return len;
}
