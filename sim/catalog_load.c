/* catalog_load.c — validador del catálogo (05): nombres contra el inventario, servo_cost_s, regla †. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cJSON.h"
#include "catalog_load.h"

static char *read_file(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (!f) return 0;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc((size_t)n + 1);
    if (buf && fread(buf, 1, (size_t)n, f) != (size_t)n) { free(buf); buf = 0; }
    if (buf) buf[n] = 0;
    fclose(f);
    return buf;
}

static int lookup(const char *name, const char *const *names, int n)
{
    for (int i = 0; i < n; i++)
        if (strcmp(name, names[i]) == 0) return i;
    return -1;
}

static const char *const CATS[] = {"idle", "rest", "social", "play", "explore", "emotion", "command", "reflex"};
static const char *const NEEDS[] = {"social", "stimulation", "rest", "boredom"};
static const char *const MOODS[] = {"SM_SCARED", "SM_SLEEPY", "SM_GRUMPY", "SM_BORED", "SM_PLAYFUL", "SM_HAPPY", "SM_CALM"};
static const char *const TRAITS[] = {"trait_boldness", "trait_energy", "trait_sociability", "trait_playfulness", "trait_impulsivity"};

static int weights(const cJSON *obj, const char *const *names, int n, float *dst, const char *id, const char *field)
{
    const cJSON *it;
    cJSON_ArrayForEach(it, obj) {
        int k = lookup(it->string, names, n);
        if (k < 0 || !cJSON_IsNumber(it)) { fprintf(stderr, "catalog: %s.%s: clave desconocida '%s'\n", id, field, it->string); return -1; }
        dst[k] = (float)it->valuedouble;
    }
    return 0;
}

/* Agrega una opción (un .mot o una cadena) consultando el inventario */
static int add_option(alma_behavior *b, const cJSON *opt, const cJSON *inv_mot)
{
    if (b->n_opt >= ALMA_MAX_OPTIONS) { fprintf(stderr, "catalog: %s: más de %d opciones\n", b->id, ALMA_MAX_OPTIONS); return -1; }
    alma_motion_opt *o = &b->opt[b->n_opt];
    memset(o, 0, sizeof *o);
    const cJSON *names[ALMA_MAX_CHAIN];
    int n = 0;
    if (cJSON_IsString(opt)) names[n++] = opt;
    else if (cJSON_IsArray(opt)) {
        const cJSON *it;
        cJSON_ArrayForEach(it, opt) {
            if (!cJSON_IsString(it) || n >= ALMA_MAX_CHAIN) return -1;
            names[n++] = it;
        }
    }
    if (n == 0) return -1;
    for (int i = 0; i < n; i++) {
        const cJSON *m = cJSON_GetObjectItemCaseSensitive(inv_mot, names[i]->valuestring);
        if (!m) { fprintf(stderr, "catalog: %s: '%s' no está en el inventario\n", b->id, names[i]->valuestring); return -1; }
        snprintf(o->mot[i], ALMA_MOT_LEN, "%s", names[i]->valuestring);
        o->dur_s += (float)cJSON_GetObjectItemCaseSensitive(m, "dur_s")->valuedouble;
        o->gait |= cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(m, "gait"));
    }
    o->n = n;
    o->hhmm0 = o->hhmm1 = -1;
    b->n_opt++;
    return 0;
}

static int load_behavior(const cJSON *j, const cJSON *inv_mot, alma_behavior *b)
{
    memset(b, 0, sizeof *b);
    for (int i = 0; i < SM_COUNT; i++) b->mood_fit[i] = 1.0f;   /* mood_fit ausente = 1.0 (05) */
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(j, "id");
    if (!cJSON_IsString(v)) return -1;
    snprintf(b->id, ALMA_ID_LEN, "%s", v->valuestring);

    v = cJSON_GetObjectItemCaseSensitive(j, "category");
    int cat = cJSON_IsString(v) ? lookup(v->valuestring, CATS, 8) : -1;
    if (cat < 0) { fprintf(stderr, "catalog: %s: categoría inválida\n", b->id); return -1; }
    b->category = (alma_category)cat;

    const cJSON *it;
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(j, "tags")) {
        if (strcmp(it->valuestring, "attention") == 0) b->tags |= TAG_ATTENTION;
        else if (strcmp(it->valuestring, "play") == 0) b->tags |= TAG_PLAY;
        else if (strcmp(it->valuestring, "locomotion") == 0) b->tags |= TAG_LOCOMOTION;
        else { fprintf(stderr, "catalog: %s: etiqueta '%s' desconocida\n", b->id, it->valuestring); return -1; }
    }
    v = cJSON_GetObjectItemCaseSensitive(j, "base");
    b->base = cJSON_IsNumber(v) ? (float)v->valuedouble : 1.0f;
    if (weights(cJSON_GetObjectItemCaseSensitive(j, "need_w"), NEEDS, NEED_COUNT, b->need_w, b->id, "need_w") ||
        weights(cJSON_GetObjectItemCaseSensitive(j, "mood_fit"), MOODS, SM_COUNT, b->mood_fit, b->id, "mood_fit") ||
        weights(cJSON_GetObjectItemCaseSensitive(j, "trait_w"), TRAITS, TRAIT_COUNT, b->trait_w, b->id, "trait_w"))
        return -1;
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(j, "requires")) {
        if (b->n_req >= ALMA_MAX_REQ || !cJSON_IsString(it) || alma_req_parse(it->valuestring, &b->req[b->n_req])) {
            fprintf(stderr, "catalog: %s: precondición inválida '%s'\n", b->id, cJSON_IsString(it) ? it->valuestring : "?");
            return -1;
        }
        b->n_req++;
    }
    v = cJSON_GetObjectItemCaseSensitive(j, "cooldown_s");
    b->cooldown_s = cJSON_IsNumber(v) ? (float)v->valuedouble : 0;
    v = cJSON_GetObjectItemCaseSensitive(j, "unlock_day");
    b->unlock_day = cJSON_IsNumber(v) ? v->valueint : 0;

    const cJSON *motion = cJSON_GetObjectItemCaseSensitive(j, "motion");
    if (cJSON_IsObject(motion)) {
        cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(motion, "options"))
            if (add_option(b, it, inv_mot)) return -1;
        /* option_hours (dueño, 2026-10-30): {"Good_morning": [500, 1200]} por el primer .mot de la opción */
        const cJSON *oh;
        cJSON_ArrayForEach(oh, cJSON_GetObjectItemCaseSensitive(j, "option_hours"))
            for (int i = 0; i < b->n_opt; i++)
                if (oh->string && strcmp(b->opt[i].mot[0], oh->string) == 0 && cJSON_GetArraySize(oh) == 2) {
                    b->opt[i].hhmm0 = cJSON_GetArrayItem(oh, 0)->valueint;
                    b->opt[i].hhmm1 = cJSON_GetArrayItem(oh, 1)->valueint;
                }
        /* servo_cost_s: el candidato más largo; en una cadena, la suma (05) */
        for (int i = 0; i < b->n_opt; i++)
            if (b->opt[i].dur_s > b->servo_cost_s) b->servo_cost_s = b->opt[i].dur_s;
    }
    v = cJSON_GetObjectItemCaseSensitive(j, "duration_ms");
    if (cJSON_GetArraySize(v) == 2) {
        b->dur_min_s = (float)cJSON_GetArrayItem(v, 0)->valuedouble / 1000.0f;
        b->dur_max_s = (float)cJSON_GetArrayItem(v, 1)->valuedouble / 1000.0f;
        if (b->n_opt) fprintf(stderr, "catalog: %s: duration_ms ignorado, la conducta tiene .mot (05)\n", b->id);
    }
    return 0;
}

int catalog_load(const char *catalog_path, const char *inventory_path, alma_catalog *out, int verbose)
{
    char *ctext = read_file(catalog_path), *itext = read_file(inventory_path);
    if (!ctext || !itext) {
        fprintf(stderr, "catalog: no pude leer %s\n", !ctext ? catalog_path : inventory_path);
        free(ctext); free(itext);
        return -1;
    }
    int n = catalog_load_text(ctext, itext, out, verbose);
    free(ctext); free(itext);
    return n;
}

int catalog_load_text(const char *ctext, const char *itext, alma_catalog *out, int verbose)
{
    cJSON *cat = cJSON_Parse(ctext), *inv = cJSON_Parse(itext);
    if (!cat || !inv) { fprintf(stderr, "catalog: JSON inválido\n"); cJSON_Delete(cat); cJSON_Delete(inv); return -1; }
    const cJSON *inv_mot = cJSON_GetObjectItemCaseSensitive(inv, "mot");
    memset(out, 0, sizeof *out);
    const cJSON *j;
    int rejected = 0;
    cJSON_ArrayForEach(j, cJSON_GetObjectItemCaseSensitive(cat, "behaviors")) {
        if (out->n >= ALMA_MAX_BEHAVIORS) break;
        if (load_behavior(j, inv_mot, &out->b[out->n]) == 0) out->n++;
        else rejected++;
    }
    if (verbose) {
        for (int i = 0; i < out->n; i++) {
            const alma_behavior *b = &out->b[i];
            int playable = 0;
            for (int k = 0; k < b->n_opt; k++) playable += !b->opt[k].gait;
            fprintf(stderr, "  %-22s opciones %2d (sin † %2d)  servo_cost_s %6.1f\n", b->id, b->n_opt, playable, b->servo_cost_s);
        }
        fprintf(stderr, "catalog: %d conductas aceptadas, %d descartadas\n", out->n, rejected);
    }
    cJSON_Delete(cat);
    cJSON_Delete(inv);
    return out->n;
}
