/* brain_gen.c — ejemplos para la red de Alma y su evaluación (dueño, 2026-11-04).
 *
 * Mundo: los escenarios de casa (sim/brain/escenarios, un .json cada uno; formato en sim/brain/ESCENARIOS.md) corren con el
 * núcleo real (alma_core), segundo a segundo. Quien decide es una política:
 *   maestra  — las reglas del informe "Conducta felina y canina para Alma" (teacher(), abajo), solo con lo que la red ve;
 *   mlp      — la red entrenada (bloque ALMB de tools/brain/train.py);
 *   formula  — sin red: alma_select de siempre.
 *
 * Uso:
 *   brain_gen gen  <catalog.json> <assets_inventory.json> <dir_escenarios> <salida.bin> [corridas=400] [días=7] [semilla=1]
 *   brain_gen eval <catalog.json> <assets_inventory.json> <dir_escenarios> <dir_salida> <maestra|formula|pesos.bin> [corridas=60] [días=7] [semilla=7]
 * gen escribe los ejemplos (formato en tools/brain/train.py); eval escribe metricas.json y bitacora.txt.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include "alma_core.h"
#include "alma_internal.h"
#include "catalog_load.h"
#include "cJSON.h"

#define DAY 86400.0
#define HR 3600.0
#define MAX_SCEN 64
#define MAX_TPL 12
#define MAX_BLK 24
#define MAX_SEG 512
#define MAX_Q 128

/* ---- escenarios ---- */
enum { W_FUERA, W_CASA, W_CERCA, W_JUEGO, W_DORMIDO };
static const char *const W_NAME[] = {"fuera", "casa", "cerca", "juego", "dormido"};

typedef struct { double a, b; int who, en_base; float pet, praise, scold, cmd, lift, front, resp, pass; } blk;
typedef struct {
    unsigned days; float p; int has_owner;
    double wake, bed, var_s;
    blk b[MAX_BLK]; int nb;
    double vis_a, vis_b; float vis_p, loud;
} tpl;
typedef struct { char id[48]; float weight; tpl t[MAX_TPL]; int nt; } scen;

static scen SC[MAX_SCEN];
static int n_sc;

static double hhmm(const cJSON *j)
{
    if (!cJSON_IsString(j)) return -1;
    int h = 0, m = 0;
    if (sscanf(j->valuestring, "%d:%d", &h, &m) != 2) return -1;
    return h * HR + m * 60.0;
}
static float num(const cJSON *o, const char *k, float def)
{
    const cJSON *j = cJSON_GetObjectItemCaseSensitive(o, k);
    return cJSON_IsNumber(j) ? (float)j->valuedouble : def;
}

static int load_scen(const char *path)
{
    FILE *f = fopen(path, "rb");
    if (!f) return -1;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *buf = malloc(n + 1);
    if (fread(buf, 1, n, f) != (size_t)n) { fclose(f); free(buf); return -1; }
    buf[n] = 0;
    fclose(f);
    cJSON *r = cJSON_Parse(buf);
    free(buf);
    if (!r || n_sc >= MAX_SCEN) return -1;
    scen *s = &SC[n_sc];
    memset(s, 0, sizeof *s);
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(r, "id");
    snprintf(s->id, sizeof s->id, "%s", cJSON_IsString(id) ? id->valuestring : "?");
    s->weight = num(r, "peso", 1.0f);
    const cJSON *dias, *d;
    dias = cJSON_GetObjectItemCaseSensitive(r, "dias");
    cJSON_ArrayForEach(d, dias) {
        if (s->nt >= MAX_TPL) break;
        tpl *t = &s->t[s->nt];
        memset(t, 0, sizeof *t);
        const cJSON *ds, *x;
        cJSON_ArrayForEach(x, cJSON_GetObjectItemCaseSensitive(d, "dias_semana")) if (cJSON_IsNumber(x)) t->days |= 1u << x->valueint;
        (void)ds;
        t->p = num(d, "p", 1.0f);
        t->wake = hhmm(cJSON_GetObjectItemCaseSensitive(d, "despierta"));
        t->bed = hhmm(cJSON_GetObjectItemCaseSensitive(d, "duerme"));
        t->has_owner = t->wake >= 0 && t->bed >= 0;
        if (t->has_owner && t->bed <= t->wake) t->bed += DAY;   /* se acuesta pasada la medianoche */
        t->var_s = num(d, "variacion_min", 15) * 60.0;
        t->loud = num(d, "ruidos_dia", 0.5f);
        const cJSON *v = cJSON_GetObjectItemCaseSensitive(d, "visita");
        if (v) {
            t->vis_a = hhmm(cJSON_GetObjectItemCaseSensitive(v, "desde"));
            t->vis_b = hhmm(cJSON_GetObjectItemCaseSensitive(v, "hasta"));
            t->vis_p = num(v, "p", 0);
            if (t->has_owner && t->vis_a < t->wake) t->vis_a += DAY, t->vis_b += DAY;
            if (t->vis_b <= t->vis_a) t->vis_b += DAY;
        }
        cJSON_ArrayForEach(x, cJSON_GetObjectItemCaseSensitive(d, "bloques")) {
            if (t->nb >= MAX_BLK) break;
            blk *b = &t->b[t->nb];
            b->a = hhmm(cJSON_GetObjectItemCaseSensitive(x, "desde"));
            b->b = hhmm(cJSON_GetObjectItemCaseSensitive(x, "hasta"));
            if (b->a < 0 || b->b < 0) continue;
            if (t->has_owner && b->a < t->wake) b->a += DAY;
            if (b->b <= b->a) b->b += DAY;
            const cJSON *w = cJSON_GetObjectItemCaseSensitive(x, "dueno");
            const char *ws = cJSON_IsString(w) ? w->valuestring : "casa";
            b->who = !strcmp(ws, "fuera") ? W_FUERA : !strcmp(ws, "cerca") ? W_CERCA : !strcmp(ws, "juego") ? W_JUEGO : W_CASA;
            const cJSON *eb = cJSON_GetObjectItemCaseSensitive(x, "en_base");
            b->en_base = eb ? cJSON_IsTrue(eb) : b->who == W_FUERA;
            b->pet = num(x, "caricias_h", 0); b->praise = num(x, "felicita_h", 0); b->scold = num(x, "regana_h", 0);
            b->cmd = num(x, "ordenes_h", 0); b->lift = num(x, "levanta_h", 0);
            b->front = num(x, "de_frente_p", 0.5f); b->resp = num(x, "responde_p", 0.4f); b->pass = num(x, "pasa_h", 2);
            t->nb++;
        }
        s->nt++;
    }
    cJSON_Delete(r);
    return s->nt ? (n_sc++, 0) : -1;
}

static int load_dir(const char *dir)
{
    DIR *d = opendir(dir);
    if (!d) return -1;
    struct dirent *e;
    char path[1024];
    while ((e = readdir(d))) {
        size_t n = strlen(e->d_name);
        if (n < 6 || strcmp(e->d_name + n - 5, ".json")) continue;
        snprintf(path, sizeof path, "%s/%s", dir, e->d_name);
        if (load_scen(path)) fprintf(stderr, "escenario con error: %s\n", path);
    }
    closedir(d);
    return n_sc ? 0 : -1;
}

/* ---- el mundo de una corrida ---- */
typedef struct { double a, b; int who, en_base; const blk *k; } seg;

typedef struct {
    const alma_catalog *cat;
    alma_rng rng;
    alma_t alma;
    const scen *sc;
    seg sg[MAX_SEG]; int ns, si;
    double vis_a[16], vis_b[16]; int nvis;
    double loud[64]; int nloud;
    double t, t0;
    float soc;
    int on_charger, visible, facing, lifted, low_sent;
    double vis_until, last_face_ev, last_unknown_ev, done_t, last_resp_t;
    int done_b;
    struct { double t; alma_ev ev; } q[MAX_Q]; int nq;
    /* dueño fuera y regreso (métricas) */
    double away_since;
    int was_present, arrival_pending;
    /* base y batería (dueño, 2026-11-05): ella decide ir a cargarse y bajarse; el dueño solo la mueve al cambiar de bloque
       y la levanta si está desmayada */
    int prev_en_base, fainted;
    int near_mm; double near_until;   /* lo que tiene enfrente (sensor de distancia) */
    double dock_t;             /* llega a la base al terminar bhv_go_home (si no falla) */
} world;

static float u01(world *w) { return alma_rng_u01(&w->rng); }
static float urange(world *w, float a, float b) { return a + (b - a) * u01(w); }
static double gauss(world *w, double sd) { return sd * 1.7320508 * (u01(w) + u01(w) + u01(w) - 1.5) / 1.5 * 1.0; }

static void push(world *w, double t, alma_ev_type type, int person, int action, float value)
{
    if (w->nq >= MAX_Q) return;
    w->q[w->nq].t = t;
    w->q[w->nq++].ev = (alma_ev){type, person, action, -1, 0, 0, 0, value};
}

static const tpl *pick_tpl(world *w, int wd)
{
    const scen *s = w->sc;
    float tot = 0;
    for (int i = 0; i < s->nt; i++) if (s->t[i].days >> wd & 1) tot += s->t[i].p;
    float r = u01(w) * tot;
    const tpl *last = NULL;
    for (int i = 0; i < s->nt; i++) {
        if (!(s->t[i].days >> wd & 1)) continue;
        last = &s->t[i];
        if (r < s->t[i].p) return last;
        r -= s->t[i].p;
    }
    return last;
}

static void add_seg(world *w, double a, double b, int who, int en_base, const blk *k)
{
    if (b <= a || w->ns >= MAX_SEG) return;
    if (w->ns && w->sg[w->ns - 1].b < a) {   /* hueco: en casa, sin atenderla */
        seg *p = &w->sg[w->ns - 1];
        w->sg[w->ns++] = (seg){p->b, a, W_CASA, 1, NULL};
    }
    w->sg[w->ns++] = (seg){a, b, who, en_base, k};
}

/* Arma la semana: bloques con su variación; entre acostarse y despertar el dueño duerme y Alma está en la base */
static void plan(world *w, int days, int wd0)
{
    w->ns = w->nvis = w->nloud = 0;
    double cur = w->t0;
    for (int d = 0; d < days + 1; d++) {
        double day0 = w->t0 + d * DAY;
        const tpl *t = pick_tpl(w, (wd0 + d) % 7);
        if (!t || !t->has_owner) {
            double nxt = day0 + DAY + 7 * HR;
            add_seg(w, cur, nxt, W_FUERA, 1, NULL);   /* sin dueño ese día: hasta la mañana siguiente */
            cur = nxt;
            continue;
        }
        double sh = gauss(w, t->var_s);
        double wake = day0 + t->wake + sh;
        if (wake < cur) wake = cur;
        add_seg(w, cur, wake, W_DORMIDO, 1, NULL);
        double prev = wake;
        for (int i = 0; i < t->nb; i++) {
            const blk *k = &t->b[i];
            double b = day0 + k->b + sh + (i < t->nb - 1 ? gauss(w, t->var_s * 0.4) : 0);
            if (b < prev + 120) b = prev + 120;
            add_seg(w, prev, b, k->who, k->en_base, k);
            prev = b;
        }
        double bed = day0 + t->bed + sh;
        if (bed > prev) add_seg(w, prev, bed, W_CASA, 0, NULL), prev = bed;
        cur = prev;
        if (t->vis_p > 0 && u01(w) < t->vis_p && w->nvis < 16) {
            w->vis_a[w->nvis] = day0 + t->vis_a + sh;
            w->vis_b[w->nvis++] = day0 + t->vis_b + sh;
        }
        float lam = t->loud;
        while (lam > 0 && w->nloud < 64) {
            if (u01(w) < (lam >= 1 ? 1.0f : lam)) w->loud[w->nloud++] = wake + urange(w, 0, (float)(bed - wake));
            lam -= 1;
        }
    }
}

static const seg *seg_at(world *w, double t)
{
    while (w->si < w->ns - 1 && t >= w->sg[w->si].b) w->si++;
    return &w->sg[w->si];
}

/* ---- la maestra ---- */
enum {   /* el orden de ALMA_BRAIN_OUT_ID */
    O_SEGUIR, O_BLINK, O_LOOK, O_DOZE, O_NAP, O_GO_REST, O_GO_HOME, O_GREET, O_FOLLOW, O_ENJOY, O_SEEK, O_ASK, O_INVEST,
    O_SHY, O_BABBLE, O_ASK_FOOD, O_BOW, O_SOLO, O_DANCE, O_CHASE, O_WIGGLE, O_ROUTINE, O_ACTIVITY, O_IMITATE, O_SING,
    O_EXPLORE, O_INSPECT, O_SULK, O_YAWN, O_SICK, O_LEAVE, O_PHOTO, O_N
};

static double secs(float rec, double tau) { return rec > 1e-6f ? -tau * log(rec) : 1e9; }

/* Las reglas del informe (secciones D–F) como probabilidades. Solo usa x: lo que la red también ve.
   v2 (2026-11-05): con la crítica de la maestra v1 (llegadas de verdad, saludo según el carácter, continuidad tras
   caricia, saludo y juego, siesta que dura, umbrales de los acumuladores, recuperación gradual tras un regaño). */
static int teacher(void *user, const float *x, const unsigned char *mask, float *p)
{
    (void)user;
    float soc = x[BF_K_SOCIAL], ind = x[BF_K_INDEP], ply = x[BF_K_PLAY], imp = x[BF_K_IMPULSIVE];
    float fearful = 1.0f - x[BF_K_BOLD];
    float E = x[BF_ENERGY], need_soc = x[BF_NEED_SOCIAL];
    int mood = 0;
    for (int s = 1; s < SM_COUNT; s++) if (x[BF_MOOD0 + s] > x[BF_MOOD0 + mood]) mood = s;
    double hour = atan2(x[BF_HOUR_SIN], x[BF_HOUR_COS]) / (2 * 3.14159265358979) * 24.0;
    if (hour < 0) hour += 24;
    int present = x[BF_PRESENT] > 0.5f, facing = x[BF_FACING] > 0.5f, unknown = x[BF_UNKNOWN] > 0.5f;
    int night = x[BF_NIGHT] > 0.5f, wary = x[BF_WARY] > 0.5f;
    double alone_min = present ? 0 : expm1(x[BF_ALONE] * log1p(1440.0));
    int active = x[BF_ACTIVE] > 0.5f, fam = 0;
    for (int f = 1; f < BFAM_COUNT; f++) if (x[BF_FAM0 + f] > x[BF_FAM0 + fam]) fam = f;
    double t_idle = active ? 0 : expm1(x[BF_T_IDLE] * log1p(3600.0));
    double t_cur = active ? expm1(x[BF_T_CUR] * log1p(3600.0)) : 0;
    double d_pet = secs(x[BF_PET], 120), d_praise = secs(x[BF_PRAISE], 120), d_scold = secs(x[BF_SCOLD], 300);
    double d_ign = secs(x[BF_IGNORED], 600), d_ask = secs(x[BF_ASKED], 120), d_arr = present ? secs(x[BF_ARRIVED], 60) : 1e9;
    double d_contact = secs(x[BF_OWNER_CONTACT], 60);
    /* acumuladores con decaimiento exp(−t/τ): 3 en poco tiempo dan ~2 (crítica v1, hallazgo 6) */
    float scolds = x[BF_SCOLD_ACC] * 3, pets = x[BF_PET_ACC] * 5, insist = x[BF_INSIST] * 4;
    float rec_play = x[BF_FAMREC0 + BFAM_PLAY], rec_expl = x[BF_FAMREC0 + BFAM_EXPLORE];
    float fear = x[BF_FEAR];
    int peak = (hour >= 6 && hour < 10) || (hour >= 17 && hour < 22), siesta_h = hour >= 12 && hour < 17;
    int greeted = x[BF_GREETED] > 0.5f;
    float g = x[BF_GREET];
    int after_play = !active && fam == BFAM_PLAY;              /* lo último fue jugar */
    int session = after_play && t_idle < 20;                   /* sesión de juego en curso (P1, P6) */
    int woke = !active && fam == BFAM_REST && t_idle < 60;     /* acaba de despertar */
    int rested = !active && fam == BFAM_REST && t_idle < 900;  /* descansó hace poco */
    int pet_now = d_pet < 1.5, satur = pets >= 2.3f && ind >= 0.6f && d_ask > 120;   /* C3 */
    int scold_fresh = d_scold < 30 && mask[O_SULK];   /* si estaba ocupada, la primera decisión después del regaño (N1) */

    /* recuperación tras un regaño (N2–N4): nada social ni de juego hasta R; vuelve poco a poco hasta 2R */
    double R = 180.0 * (1 + fearful) * (1 + 0.5 * ind);
    if (scolds >= 1.9f) R = 900.0 * (1 + fearful);
    if (d_pet < d_scold && soc >= 0.5f) R *= 0.5;   /* N3: una caricia después ayuda */
    float back = d_scold < R ? 0.0f : d_scold < 2 * R ? (float)((d_scold - R) / R) : 1.0f;

    float w[O_N] = {0};
    /* quieta y mirar */
    w[O_BLINK] = 1.0f;
    w[O_LOOK] = 1.0f + (unknown ? 1.5f : 0) + (d_ign < 120 ? 1.0f : 0) + (back < 1 ? 2.0f : 0);
    /* descanso: siesta y dormitar (H1, S2, S4, P6) */
    float tired = 1.0f - E;
    w[O_DOZE] = 0.3f + 1.5f * tired + (mood == SM_SLEEPY ? 1.5f : 0) + (alone_min > 60 ? 0.6f : 0);
    w[O_NAP] = 2.0f * tired * tired + (mood == SM_SLEEPY ? 1.5f : 0) + (alone_min > 30 ? 0.3f + 0.4f * (float)fmin(alone_min / 240.0, 1.0) : 0)
               + (after_play && !session && rec_play > 0.5f ? 0.6f : 0) + (siesta_h ? 0.4f : 0);
    if (present) {           /* con el dueño, siesta solo muy cansada y sin tenerlo de frente */
        w[O_NAP] = E < 0.3f && !facing ? w[O_NAP] * 0.1f : 0;
        w[O_DOZE] *= 0.4f;
    }
    if (rested) w[O_NAP] *= 0.2f, w[O_DOZE] *= 0.4f;
    if (!present && alone_min < 15) w[O_NAP] *= 0.1f, w[O_DOZE] *= 0.3f, w[O_LOOK] += 1.0f;   /* S1: recién se fue, aún atenta */
    w[O_GO_REST] = E < 0.25f ? 1.0f : 0;   /* "buenas noches" solo muy cansada (crítica de la red) */
    /* batería y base (dueño, 2026-11-05: lo decide ella; si no va, se desmaya). Como un animal con hambre: con poca
       batería ir a cargarse gana, pero jugando con el dueño la impulsiva lo deja para después. Tras un desmayo es
       precavida unos días (BF_FAINT sube los umbrales) */
    float bat = x[BF_SOC], caut = x[BF_FAINT];
    float low = 0.25f + 0.25f * caut;
    float gh = bat < 0.12f ? 40.0f : bat < low ? 2.0f + 6.0f * (low - bat) / (low - 0.12f)
             : bat < 0.5f + 0.2f * caut ? 1.2f * tired * tired + (mood == SM_SLEEPY ? 0.4f : 0) : 0.05f * tired;
    if (present && (facing || session) && bat >= 0.12f) gh *= 0.25f + 0.75f * (1.0f - imp) * (1.0f - 0.5f * ply);
    w[O_GO_HOME] = gh;
    /* bajarse de la base: cargada y de día; con el dueño enfrente va hacia él, sola sale a explorar si está aburrida */
    float full = 0.85f + 0.1f * caut;
    float lv = 0;
    if (!night && bat >= full - 0.25f && E > 0.35f) {
        lv = present ? (facing ? 2.0f * (0.5f + soc) : 0.5f) : (0.2f + 0.5f * ind) * (mood == SM_BORED ? 2.0f : 1.0f) * (0.5f + x[BF_NEED_STIM]);
        if (bat < full) lv *= 0.25f;
    }
    w[O_LEAVE] = lv;
    /* mirar con atención y tomar foto (dueño, 2026-11-05: lo decide ella). Curiosidad: algo que se le acercó, una cara
       desconocida, el dueño de frente un rato; casi nunca cansada, asustada, enojada o jugando; la última foto la sacia */
    float near = x[BF_NEAR], last_ph = x[BF_PHOTO], bold = x[BF_K_BOLD];
    float ph = (near > 0.6f ? 25.0f * (0.4f + bold) * (0.4f + 0.6f * x[BF_CLOSE]) : 0) + (unknown ? 1.5f * bold : 0)
               + (present && facing ? 0.25f * (0.3f + soc) * (0.5f + x[BF_NEED_STIM]) : 0) + (!present ? 0.03f * x[BF_NEED_STIM] : 0);
    if (E < 0.3f) ph *= 0.2f;
    if (session) ph *= 0.2f;
    w[O_PHOTO] = ph * (1.0f - 0.7f * last_ph);
    /* social (E2–E4): quién empieza el contacto lo decide la independencia */
    float init = fmaxf(0.03f, 0.2f + 1.2f * soc - 0.9f * ind);
    float drive = (float)fmin(1.0, d_contact / 900.0) * (0.5f + need_soc);
    if (present) {
        w[O_FOLLOW] = (0.8f + soc) * (facing ? 1.5f : 0.7f);
        w[O_ASK] = 6.0f * drive * init;
        if (greeted && d_arr < 300 && d_ask > 20 && d_ask < 90 && d_contact > d_ask) w[O_ASK] *= 3.0f;   /* G4 */
        if (d_ign < 1800) w[O_ASK] *= 0.5f;                                                             /* I6 */
        if (insist >= 1.9f && ind >= 0.6f) w[O_ASK] *= 0.3f, w[O_FOLLOW] *= 0.4f, w[O_EXPLORE] += 0.8f; /* I4 */
        w[O_BABBLE] = 0.5f * (0.4f + soc) * (mood == SM_HAPPY || mood == SM_PLAYFUL ? 1.5f : 1.0f) * (0.3f + drive) * init / 0.5f;
        w[O_GREET] = 0.5f * g;   /* fuera de la llegada: saludo tardío, raro */
    } else {
        w[O_SEEK] = alone_min > 10 && need_soc > 0.5f ? 0.5f * need_soc * fmaxf(0.03f, 0.4f + 0.8f * soc - 0.9f * ind) : 0;   /* S3 */
    }
    w[O_ENJOY] = d_pet < 5 ? 15.0f * (0.5f + soc) : 3.0f * x[BF_PET];
    if (satur) w[O_ENJOY] *= 0.3f, w[O_LOOK] += 1.5f;
    w[O_INVEST] = unknown ? 3.0f * x[BF_K_BOLD] : 0;
    w[O_SHY] = unknown || wary ? 3.0f * fearful : 0;
    w[O_ASK_FOOD] = 3.0f;    /* solo con hambre */
    /* juego (E7): sesiones, habituación, tope del día */
    static const float MOOD_PLAY[SM_COUNT] = {0.1f, 0.2f, 0.3f, 1.3f, 2.5f, 1.5f, 1.0f};
    float bp = (0.3f + ply) * (E > 0.4f ? 1.0f : 0.2f) * MOOD_PLAY[mood] * (peak ? 1.5f : siesta_h ? 0.8f : 1.0f)
               * (session ? 2.0f : 1.0f - 0.6f * rec_play) * (x[BF_PLAY_TODAY] >= 1.0f ? 0.05f : 1.0f);
    if (present) bp *= facing ? 0.5f : 0.2f;                   /* con el dueño, más cerca que jugando; sin mirarla, casi nada */
    if (woke) bp *= 0.1f, w[O_LOOK] *= 2.0f;                   /* al despertar, primero mira */
    if (present) {
        w[O_BOW] = (facing ? 2.0f : 0) * bp * (0.5f + soc) * init / 0.5f * (0.3f + drive);
        w[O_ROUTINE] = 0.8f * bp;
        w[O_IMITATE] = 0.6f * bp;
    } else {
        w[O_SOLO] = 1.5f * bp * (0.5f + ind);
    }
    w[O_DANCE] = 0.5f * bp;
    w[O_CHASE] = 0.5f * bp;
    w[O_ACTIVITY] = 0.6f * bp;
    w[O_SING] = 0.4f * bp;
    w[O_WIGGLE] = d_praise < 5 || d_pet < 5 ? 4.0f : 0.5f * bp;
    /* explorar */
    w[O_EXPLORE] += E > 0.35f ? (0.4f + 0.6f * ind) * (mood == SM_BORED ? 1.5f : 1.0f) * (peak ? 1.4f : 1.0f) * (1.0f - 0.5f * rec_expl)
                                     * (1.0f - 0.5f * fearful) * (woke ? 0.3f : 1.0f) : 0;
    w[O_INSPECT] = 3.0f;     /* solo con la ventana de un obstáculo */
    /* emociones */
    w[O_SULK] = d_scold < 30 ? 20.0f : scolds >= 1.9f && d_scold < 600 ? 1.0f : 0;
    w[O_YAWN] = (mood == SM_BORED ? 0.6f : 0.1f) + (d_ign < 120 ? 1.0f : 0);
    w[O_SICK] = 4.0f;        /* solo enferma */

    /* continuidad (crítica v1, hallazgo 4) */
    if (present && d_arr < 300) {              /* 5 min de atención tras cada llegada, haya saludado o no */
        w[O_DOZE] *= 0.1f; w[O_NAP] = 0; w[O_GO_REST] = 0; w[O_EXPLORE] *= 0.3f;
        for (int k = O_BOW; k <= O_SING; k++) if (k != O_WIGGLE) w[k] *= 0.5f;
    }
    if (scold_fresh) {                         /* N1: al regaño, apaciguarse (enfurruñarse) casi siempre */
        for (int k = 1; k < O_N; k++) if (k != O_SULK && k != O_LOOK) w[k] *= 0.05f;
    }
    if (present && greeted && d_arr < 300) {   /* tras el saludo, un rato de contacto */
        w[O_FOLLOW] *= 2.0f; w[O_BABBLE] *= 1.5f;
        w[O_DOZE] *= 0.1f; w[O_NAP] = 0; w[O_GO_REST] *= 0.2f; w[O_EXPLORE] *= 0.3f;
    }
    if (d_pet < 180 && !satur) {               /* tras una caricia, se queda cerca */
        w[O_FOLLOW] *= 2.0f; w[O_BLINK] *= 1.5f;
        w[O_DOZE] *= 0.2f; w[O_NAP] *= 0.1f; w[O_EXPLORE] *= 0.3f;
        for (int k = O_BOW; k <= O_SING; k++) if (k != O_WIGGLE) w[k] *= 0.5f;
    }
    if (x[BF_NEAR] > 0.86f && !pet_now) {      /* algo apareció enfrente: lo primero es mirarlo (o fotografiarlo) */
        for (int k = 1; k < O_N; k++) if (k != O_PHOTO && k != O_LOOK && k != O_INSPECT && k != O_SHY) w[k] *= 0.3f;
    }
    if (pet_now) {                             /* C1: la caricia se responde con la caricia */
        for (int k = 1; k < O_N; k++)
            if (k != O_ENJOY && k != O_WIGGLE && k != O_FOLLOW && k != O_BLINK && k != O_LOOK
                && !(satur && (k == O_EXPLORE || k == O_SOLO))) w[k] *= 0.05f;
        /* dueño, 2026-11-05: "a veces reacciona a veces no"; mirar o parpadear no se notan como respuesta */
        if (!satur) w[O_LOOK] *= 0.3f, w[O_BLINK] *= 0.3f;
    }
    if (back < 1) {                            /* N2: recuperación; al volver, primero lo mira */
        for (int k = O_GREET; k <= O_BABBLE; k++) if (k != O_SHY && k != O_FOLLOW) w[k] *= back;
        for (int k = O_BOW; k <= O_SING; k++) if (k != O_WIGGLE) w[k] *= back;
        if (back == 0 && soc < 0.5f) w[O_WIGGLE] *= 0.2f;   /* recién regañada: solo la cariñosa se alegra con la caricia */
        w[O_FOLLOW] *= back > 0 ? 1.5f : 0.0f;
        w[O_EXPLORE] += 1.0f;
    }
    if (fear > 0.5f) {       /* F1: quieta y observando */
        for (int k = O_BOW; k <= O_SING; k++) w[k] *= 0.1f;
        w[O_PHOTO] *= 0.2f;
        w[O_EXPLORE] *= 0.1f; w[O_ASK] *= 0.3f; w[O_FOLLOW] *= 0.3f;
        w[O_LOOK] *= 2.0f; w[O_BLINK] *= 2.0f; w[O_DOZE] = 0; w[O_NAP] = 0;
    }
    if (night && !present) {   /* de noche, sola: quieta */
        for (int k = O_GREET; k < O_N; k++) if (k != O_SICK && k != O_ENJOY) w[k] *= 0.05f;
        w[O_DOZE] *= 3.0f;
    }

    /* lo que no se puede ahora (espera, campo relajado) cuenta como "seguir", no se reparte entre lo demás; las que solo
       existen con su condición (batería baja, ventana, hambre, caras) no */
    float tot = 0, blocked = 0;
    for (int k = 1; k < O_N; k++) {
        int cond = k == O_GO_HOME || k == O_LEAVE || k == O_PHOTO || k == O_INSPECT || k == O_ASK_FOOD || k == O_SICK || k == O_ENJOY || k == O_WIGGLE
                   || k == O_GREET || k == O_INVEST || k == O_SHY || k == O_SEEK;
        if (!mask[k]) { if (!cond) blocked += w[k]; w[k] = 0; }
        tot += w[k];
    }
    memset(p, 0, O_N * sizeof *p);

    /* G1–G2: llegada de verdad. Primero lo mira (más rato si es independiente); luego saluda con probabilidad
       q = (0.5 + 0.4·cariñosa − 0.3·independiente)·min(1, g/0.5) repartida en 20 s; si no, ya no es el saludo de llegada */
    if (mask[O_GREET] && d_arr < 90 && !active) {
        double delay = 0.5 + 6.0 * ind;
        if (d_arr < delay) {
            double hl = 0.15;
            float a1 = mask[O_FOLLOW] ? 3.0f : 0, a2 = w[O_LOOK], a3 = 0.2f * w[O_BLINK], wl = a1 + a2 + a3;
            p[0] = 1;
            if (wl <= 0) return 0;
            p[0] = (float)(1 - hl);
            p[O_FOLLOW] = (float)hl * a1 / wl;
            p[O_LOOK] = (float)hl * a2 / wl;
            p[O_BLINK] = (float)hl * a3 / wl;
            return 0;
        }
        if (d_arr < delay + 20) {
            double q = fmin(0.95, fmax(0.05, 0.5 + 0.4 * soc - 0.3 * ind)) * fmin(1.0, g / 0.5);
            float r = (float)(1.0 - pow(1.0 - q, 1.0 / 20.0));
            p[O_GREET] = r;
            p[0] = 1 - r;
            return 0;
        }
    }

    /* ¿cambia ahora? (D: inercia) */
    double h;
    int arrival = present && d_arr < 1.5 && !greeted && g >= 0.15f;
    int near_now = x[BF_NEAR] > 0.86f;   /* algo se le acercó en los últimos ~1.5 s */
    int ev_now = pet_now || d_praise < 1.5 || d_scold < 1.5 || arrival || d_contact < 1.5 || (d_scold < 30 && mask[O_SULK]) || near_now;
    if (active) {            /* solo quieta, dormitando o en siesta: la saca algo fuerte */
        int nap = fam == BFAM_REST;
        h = nap ? (t_cur < 1200 ? 0.0 : 0.0006) : 0.01;   /* la siesta dura (mediana ~40 min) */
        if (pet_now) h = nap ? 0.5 : 0.85;
        else if (d_scold < 1.5) h = 0.7;
        else if (arrival) h = nap ? 0.35 + 0.4 * soc * g : 0.8;
        else if (d_contact < 1.5 || d_praise < 1.5) h = nap ? 0.2 : 0.6;
        else if (near_now) h = nap ? 0.3 : 0.7;
        else if (fear > 0.5f) h = 0.3;
    } else {
        double mean = present ? 50.0 : alone_min > 30 ? 160.0 : 100.0;
        if (night) mean *= 3;
        if (mood == SM_SLEEPY || E < 0.3f) mean *= 1.5;
        if (mood == SM_PLAYFUL) mean *= 0.6;
        mean *= 1.3 - 0.6 * imp;
        h = 1.0 / mean;
        if (session) h = 1.0 / 8;    /* en plena sesión de juego sigue el ritmo */
        else if (t_idle < 4) h *= 0.15;   /* notar y considerar antes de actuar (A7) */
        if (ev_now) h = pet_now && soc >= 0.5f ? 0.95 : 0.8;
    }

    if (tot <= 0) { p[0] = 1; return 0; }
    if (scold_fresh) h = 0.9;
    /* con poca batería, ni la siesta la detiene: se despierta a cargarse (casi vacía, en ~20 s) */
    if (mask[O_GO_HOME] && bat < 0.12f && !(present && session && imp > 0.7f)) h = fmax(h, 0.05);
    else if (mask[O_GO_HOME] && bat < low) h = fmax(h, 0.004);
    float share = ev_now ? 1.0f : tot / (tot + blocked);   /* a un evento sí se responde con lo que haya */
    p[0] = (float)(1.0 - h * share);
    for (int k = 1; k < O_N; k++) p[k] = (float)(h * share) * w[k] / tot;
    return 0;
}

/* ---- políticas y grabación ---- */
typedef struct {
    alma_policy_fn inner;
    void *inner_user;
    FILE *out;                 /* gen: ejemplos */
    world *w;
    long n_rec, n_dec;
    unsigned short scen_ix;
} rec_ctx;

/* registro: x[ALMA_BRAIN_IN] float32, p[ALMA_BRAIN_OUT] float32, máscara uint32, peso float32, escenario uint16, hora uint16 (min) */
static int rec_policy(void *user, const float *x, const unsigned char *mask, float *p)
{
    rec_ctx *c = user;
    if (c->inner(c->inner_user, x, mask, p)) return -1;
    c->n_dec++;
    if (!c->out) return 0;
    /* los segundos tranquilos (casi seguro "seguir", sin evento cerca) se guardan 1 de cada 20 y pesan 20 */
    float evmax = fmaxf(fmaxf(x[BF_PET], x[BF_PRAISE]), fmaxf(x[BF_SCOLD], x[BF_OWNER_CONTACT]));
    float wgt = 1;
    /* los ratos que siguen a una llegada (40 s), un regaño (3 min) o una caricia (2 min) son lo que más define su
       carácter: se guardan más y pesan 5 veces más que su frecuencia */
    int window = x[BF_ARRIVED] > 0.5f || x[BF_SCOLD] > 0.5f || x[BF_PET] > 0.37f;
    if (window && p[0] > 0.97f) {   /* 1 de cada 4, con 5 veces su peso natural: es donde más se equivocaba la red v2 */
        if (alma_rng_u01(&c->w->rng) >= 0.25f) return 0;
        wgt = 20;
    } else if (window) {
        wgt = 5;
    } else if (p[0] > 0.97f && evmax < 0.9f) {   /* tranquilos: 1 de cada 100, con peso 100 */
        if (alma_rng_u01(&c->w->rng) >= 0.01f) return 0;
        wgt = 100;
    }
    uint32_t m = 0;
    for (int k = 0; k < ALMA_BRAIN_OUT; k++) m |= (uint32_t)(mask[k] != 0) << k;
    unsigned short meta[2] = {c->scen_ix, (unsigned short)(fmod(c->w->t, DAY) / 60.0)};
    fwrite(x, sizeof(float), ALMA_BRAIN_IN, c->out);
    fwrite(p, sizeof(float), ALMA_BRAIN_OUT, c->out);
    fwrite(&m, 4, 1, c->out);
    fwrite(&wgt, 4, 1, c->out);
    fwrite(meta, 2, 2, c->out);
    c->n_rec++;
    return 0;
}

/* ---- métricas ---- */
enum { SIT_NOCHE, SIT_SOLA_CORTA, SIT_SOLA_LARGA, SIT_PRESENTE, SIT_N };
static const char *const SIT_NAME[SIT_N] = {"noche", "sola_menos_30min", "sola_4h_o_mas", "dueno_presente"};
enum { ACT_DORMIR, ACT_REPOSO, ACT_MIRAR, ACT_SOCIAL, ACT_JUEGO, ACT_EXPLORAR, ACT_EMOCION, ACT_OTRO, ACT_N };
static const char *const ACT_NAME[ACT_N] = {"dormir", "reposo", "mirar", "social", "juego", "explorar", "emocion", "otro"};

typedef struct {
    double sit_act[SIT_N][ACT_N];
    double play_s, days;
    long arr_n[5], arr_greet[5];
    long scolds, social_after_scold;
    long execs_awake, aba;
    double awake_s;
    long naps; double nap_s;
    long asks_hi, asks_lo; double pres_hi_s, pres_lo_s;
    long changes_alone; double alone_awake_s;
    long by_b[ALMA_MAX_BEHAVIORS];
    double pres_sleep[4];
    double mask_ok[ALMA_BRAIN_OUT], mask_n, off_base;   /* con el dueño cerca: noche, descanso por cansancio, descanso por casa vacía, siesta */
    long faints, go_home, leave_base; double go_home_soc, fainted_s, off_base_s, leave_soc;
    long photos, photos_near, nears;   /* fotos que decidió; cuántas en los 10 s tras algo cerca; cuántas veces algo cerca */
    long pets, pets_reacted;   /* caricias con ella despierta y cuántas respondió en 6 s (disfrutar, alegrarse) */
} metrics;

typedef struct {
    world *w;
    metrics *m;
    FILE *log;
    int prev_b[3]; double prev_t[3];
    double scold_t[8]; int nscold;
    double arr_t; int arr_bin, arr_open;
    int alma_ix_nap;
    double pet_t, near_t;
} hooks_ctx;

static int act_of(const alma_t *a)
{
    if (a->state == ST_SLEEPING || a->state == ST_RESTING) return ACT_DORMIR;
    if (!a->cur.active) return ACT_REPOSO;
    const alma_behavior *b = &a->cat->b[a->cur.behavior];
    if (!strcmp(b->id, "bhv_look_around") || !strcmp(b->id, "bhv_follow_face")) return ACT_MIRAR;
    switch (b->category) {
    case CAT_IDLE: return ACT_REPOSO;
    case CAT_REST: return ACT_DORMIR;
    case CAT_SOCIAL: return ACT_SOCIAL;
    case CAT_PLAY: return ACT_JUEGO;
    case CAT_EXPLORE: return ACT_EXPLORAR;
    case CAT_EMOTION: return ACT_EMOCION;
    default: return ACT_OTRO;
    }
}

static void hhmmss(double t, char *s)
{
    double d = fmod(t, DAY);
    int x = (int)d;
    sprintf(s, "d%d %02d:%02d:%02d", (int)(t / DAY), x / 3600, x / 60 % 60, x % 60);
}

static void on_exec(void *user, const alma_exec_info *e)
{
    hooks_ctx *h = user;
    world *w = h->w;
    alma_t *a = &w->alma;
    const alma_behavior *b = &w->cat->b[e->behavior];
    w->done_t = e->t_start + e->planned_s;
    w->done_b = e->behavior;
    if (e->kind != RUN_REFLEX) {
        h->m->by_b[e->behavior]++;
        if (a->state != ST_SLEEPING) h->m->execs_awake++;
        /* A→B→A en menos de 10 s */
        if (h->prev_b[1] == e->behavior && h->prev_b[0] != e->behavior && e->t_start - h->prev_t[1] < 10) h->m->aba++;
        h->prev_b[1] = h->prev_b[0]; h->prev_t[1] = h->prev_t[0];
        h->prev_b[0] = e->behavior; h->prev_t[0] = e->t_start;
        for (int i = 0; i < h->nscold; i++)
            if (e->t_start - h->scold_t[i] < 60 && e->kind == RUN_SELECTOR && (b->category == CAT_SOCIAL || b->category == CAT_PLAY)
                && strcmp(b->id, "bhv_shy_retreat") && strcmp(b->id, "bhv_enjoy_pet") && strcmp(b->id, "bhv_goodbye")) {
                h->m->social_after_scold++;
                h->scold_t[i] = -1e9;
            }
        if (e->behavior == h->alma_ix_nap) h->m->naps++, h->m->nap_s += e->planned_s;
        if (!strcmp(b->id, "bhv_ask_attention")) {
            if (a->independence >= 0.6f) h->m->asks_hi++;
            else if (a->independence <= 0.4f) h->m->asks_lo++;
        }
        if (!strcmp(b->id, "bhv_photo")) { h->m->photos++; if (e->t_start - h->near_t <= 10) h->m->photos_near++; }
        if (e->t_start - h->pet_t <= 6 && (!strcmp(b->id, "bhv_enjoy_pet") || !strcmp(b->id, "bhv_happy_wiggle"))) {
            h->m->pets_reacted++;
            h->pet_t = -1e9;
        }
        if (h->arr_open && !strcmp(b->id, "bhv_greet") && e->t_start - h->arr_t <= 60) { h->m->arr_greet[h->arr_bin]++; h->arr_open = 0; }
    }
    /* el dueño responde a lo que pide (responde_p), si la está viendo */
    const seg *s = seg_at(w, e->t_start);
    if (e->kind != RUN_REFLEX && (b->tags & (TAG_ATTENTION | TAG_PLAY)) && w->visible && s->k && e->t_start - w->last_resp_t > 60
        && u01(w) < s->k->resp) {
        w->last_resp_t = e->t_start;
        push(w, e->t_start + urange(w, 1.0f, fminf(e->planned_s, 8.0f) + 2.0f), u01(w) < 0.6f ? EV_TOUCH_PET : EV_PRAISE, 1, -1, 1500);
    }
    if (!strcmp(b->id, "bhv_go_home")) {   /* llega al terminar; 1 de cada 8 no atina (home.c) */
        h->m->go_home++, h->m->go_home_soc += w->soc;
        w->dock_t = u01(w) < 0.875f ? e->t_start + e->planned_s : 0;
    }
    if (!strcmp(b->id, "bhv_leave_base") && w->on_charger) {
        h->m->leave_base++, h->m->leave_soc += w->soc;
        w->on_charger = 0;
        push(w, e->t_start + 1.0, EV_CHARGING_OFF, -1, -1, 0);
    }
    if (h->log) {
        char ts[32];
        hhmmss(e->t_start, ts);
        fprintf(h->log, "%s  [%s]  → %s%s\n", ts, W_NAME[s->who], b->id,
                e->kind == RUN_FORCED ? " (forzada)" : e->kind == RUN_COMMAND ? " (orden)" : e->kind == RUN_REFLEX ? " (reflejo)" : "");
    }
}

static void on_brain(void *user, const struct alma_brain_decision *d)
{
    hooks_ctx *h = user;
    if (!h->log) return;
    fprintf(h->log, "                    red: %s %.0f%% · %s %.0f%% · %s %.0f%%%s\n", ALMA_BRAIN_OUT_ID[d->top[0]], 100 * d->top_p[0],
            ALMA_BRAIN_OUT_ID[d->top[1]], 100 * d->top_p[1], ALMA_BRAIN_OUT_ID[d->top[2]], 100 * d->top_p[2], d->event ? " (evento)" : "");
}

static const char *EVN(alma_ev_type t)
{
    switch (t) {
    case EV_TOUCH_PET: return "caricia";
    case EV_PRAISE: return "felicita";
    case EV_SCOLD: return "regaño";
    case EV_VOICE_COMMAND: return "orden";
    case EV_PICKED_UP: return "la levanta";
    case EV_LOUD_SOUND: return "ruido fuerte";
    default: return NULL;
    }
}

/* un segundo del mundo */
static void world_second(world *w, hooks_ctx *h)
{
    double t = w->t;
    alma_t *a = &w->alma;
    if (a->cur.active && a->cur.behavior == w->done_b && t >= w->done_t) {
        alma_ev e = {EV_BEHAVIOR_DONE, -1, -1, w->done_b, 0, 0, 0, 0};
        alma_event(a, &e, w->done_t);
    }
    const seg *s = seg_at(w, t);
    int near = s->who == W_CERCA || s->who == W_JUEGO;
    const blk *k = s->k;

    /* base (dueño, 2026-11-05): ir y bajarse lo decide ella. El dueño la pone o la quita solo al cambiar de bloque
       ("en_base" del escenario), y de noche el firmware la lleva si se quedó descansando fuera (app.c, hora de dormir) */
    int dock = 0, undock = 0;
    if (s->en_base != w->prev_en_base && !w->fainted) { if (s->en_base) dock = 1; else if (near) undock = 1; }
    w->prev_en_base = s->en_base;
    if (w->dock_t > 0 && t >= w->dock_t) { w->dock_t = 0; dock = 1; }
    if (!w->fainted && !w->on_charger && alma_in_night_window(a, t) && a->state == ST_RESTING && fmod(t, 180.0) < 1.0
        && u01(w) < 0.875f) dock = 1;
    /* desmayada: el dueño la encuentra (cerca en ~5 min; en casa en ~30) y la pone a cargar; revive al instante */
    int home_now = s->who != W_FUERA;
    if (w->fainted && home_now && u01(w) < (near ? 1.0f / 300 : 1.0f / 1800)) {
        w->fainted = 0;
        dock = 1;
        a->state = ST_AWAKE;   /* revive como al arrancar */
    }
    if (dock && !w->on_charger && !w->lifted) { w->on_charger = 1; push(w, t, EV_CHARGING_ON, -1, -1, 0); }
    if (undock && w->on_charger && !w->lifted) { w->on_charger = 0; push(w, t, EV_CHARGING_OFF, -1, -1, 0); }
    if (w->on_charger) w->soc = fminf(100.0f, w->soc + 100.0f / (2.5f * 3600.0f));
    else if (!w->fainted) {
        float drain = a->state == ST_PERFORMING && a->cur.motion_played ? 1.5f : (a->state == ST_RESTING || a->state == ST_SLEEPING ? 8.0f : 3.0f);
        w->soc = fmaxf(0.0f, w->soc - 100.0f / (drain * 3600.0f));
        if (w->soc <= 0.5f) {   /* se acabó: se desmaya (firmware: guarda la memoria y se apaga) */
            w->fainted = 1;
            h->m->faints++;
            alma_faint(a, t);
            if (a->cur.active) alma_finish(a, t, 0);
            if (h->log) { char ts[32]; hhmmss(t, ts); fprintf(h->log, "%s  [%s]  ✝ se desmayó sin batería\n", ts, W_NAME[s->who]); }
        }
    }
    if (w->fainted) { h->m->fainted_s += 1; return; }   /* apagada: el núcleo no corre */
    if (!w->on_charger) h->m->off_base_s += 1;
    if (w->soc <= 20.0f && !w->low_sent) { w->low_sent = 1; push(w, t, EV_BATTERY_LOW, -1, -1, w->soc); }
    if (w->soc > 30.0f) w->low_sent = 0;

    /* cara del dueño: ráfagas mientras está cerca; pasadas cortas mientras está en casa */
    int was_vis = w->visible;
    if (near && k) {
        float vis_p = fminf(1.0f, k->front + 0.3f);
        if (t >= w->vis_until) {
            w->visible = u01(w) < vis_p;
            w->facing = w->visible && u01(w) < k->front / vis_p;
            w->vis_until = t + (w->visible ? 60.0 : 30.0) * -log(1.0 - u01(w) + 1e-9);
        }
    } else if (s->who == W_CASA) {
        if (w->visible && t >= w->vis_until) w->visible = 0;
        else if (!w->visible && u01(w) < (k ? k->pass : 2.0f) / 3600.0f) {
            w->visible = 1;
            w->facing = u01(w) < 0.5f;
            w->vis_until = t + urange(w, 10, 40);
        }
    } else {
        w->visible = 0;
    }
    if (was_vis && !w->visible) push(w, t + FACE_LOST_S, EV_FACE_LOST, 1, -1, 0);
    int home = s->who != W_FUERA && s->who != W_DORMIDO;
    if (!home && w->was_present) w->away_since = t;   /* se fue de casa o a dormir */
    if (home && !w->was_present) w->arrival_pending = 1;
    if (!home) w->arrival_pending = 0;
    w->was_present = home;
    if (w->visible && w->arrival_pending) {           /* la primera vez que lo ve tras volver */
        w->arrival_pending = 0;
        double T = (t - w->away_since) / 60.0;
        h->arr_bin = T < 10 ? 0 : T < 30 ? 1 : T < 120 ? 2 : T < 240 ? 3 : 4;
        h->arr_t = t;
        h->arr_open = a->state != ST_SLEEPING && !(a->cur.active && a->cur.hold);
        if (h->arr_open) h->m->arr_n[h->arr_bin]++;
    }
    if (w->visible && t - w->last_face_ev >= 2.0) {
        w->last_face_ev = t;
        alma_ev e = {EV_FACE_SEEN, 1, -1, -1, w->facing ? urange(w, 120, 200) : (u01(w) < 0.5f ? urange(w, 10, 80) : urange(w, 240, 310)),
                     120, w->facing ? urange(w, 55, 95) : urange(w, 25, 50), 0};
        alma_event(a, &e, t);
    }
    int present = alma_any_known_present(a);
    /* visitas */
    for (int i = 0; i < w->nvis; i++)
        if (t >= w->vis_a[i] && t < w->vis_b[i] && t - w->last_unknown_ev >= 2.0 && u01(w) < 0.5f) {
            w->last_unknown_ev = t;
            alma_ev e = {EV_FACE_UNKNOWN, -1, -1, -1, urange(w, 60, 260), 120, urange(w, 30, 80), 0};
            alma_event(a, &e, t);
        }
    /* lo que hace el dueño por su cuenta */
    if (near && k && !w->lifted) {
        if (u01(w) < k->pet / 3600.0f) push(w, t, EV_TOUCH_PET, 1, -1, 1500);
        if (u01(w) < k->praise / 3600.0f) push(w, t, EV_PRAISE, 1, -1, 0);
        if (u01(w) < k->scold / 3600.0f) {
            push(w, t, EV_SCOLD, 1, -1, 0);
            if (h->nscold < 8) h->scold_t[h->nscold++] = t; else h->scold_t[h->m->scolds % 8] = t;
            h->m->scolds++;
        }
        if (u01(w) < k->cmd / 3600.0f) {
            static const float W[ACT_COUNT] = {0.2f, 0.15f, 0.1f, 0.03f, 0.03f, 0.25f, 0.12f, 0.04f, 0.05f, 0.03f};
            float r = u01(w), acc = 0;
            int act = 0;
            for (; act < ACT_COUNT - 1; act++) { acc += W[act]; if (r < acc) break; }
            push(w, t, EV_WAKE_WORD, -1, -1, 0);
            double reply = t + urange(w, 1.5f, 3.0f) + urange(w, 0.8f, 3.0f);
            if (u01(w) < 0.85f) push(w, reply, EV_VOICE_COMMAND, 1, act, 0);
            else push(w, reply, EV_VOICE_FAILED, -1, -1, 0);
        }
        if (u01(w) < k->lift / 3600.0f) {
            w->lifted = 1;
            push(w, t, EV_PICKED_UP, 1, -1, 0);
            push(w, t + urange(w, 5, 20), EV_PUT_DOWN, -1, -1, 0);
        }
        if (s->who == W_JUEGO && u01(w) < 0.1f / 60.0f) {
            float mm = urange(w, 50, 200);
            push(w, t, EV_OBSTACLE, -1, -1, mm);
            w->near_mm = (int)mm, w->near_until = t + urange(w, 2, 10), h->m->nears++, h->near_t = t;
        }
        /* el dueño le pone algo enfrente (la mano, una taza, el celular), a 4–35 cm: ~1 cada 20 min cerca de ella */
        if (s->who == W_CERCA && t >= w->near_until && u01(w) < 1.0f / 1200.0f)
            w->near_mm = (int)urange(w, 40, 340), w->near_until = t + urange(w, 5, 60), h->m->nears++, h->near_t = t;
    }
    for (int i = 0; i < w->nloud; i++)
        if (w->loud[i] >= t && w->loud[i] < t + 1) push(w, t, EV_LOUD_SOUND, -1, -1, 0);

    for (int i = 0; i < w->nq;) {
        if (w->q[i].t <= t) {
            alma_ev e = w->q[i].ev;
            if (e.type == EV_PUT_DOWN) w->lifted = 0;
            if (e.type == EV_TOUCH_PET && a->state != ST_SLEEPING) h->m->pets++, h->pet_t = t;
            w->q[i] = w->q[--w->nq];
            if (h->log && EVN(e.type)) {
                char ts[32];
                hhmmss(t, ts);
                fprintf(h->log, "%s  [%s]  * %s\n", ts, W_NAME[s->who], EVN(e.type));
            }
            alma_event(a, &e, t);
        } else i++;
    }
    /* sola y despierta fuera de la base, a veces queda frente a un mueble o una pared (~1 cada 4 h) */
    if (!present && !w->on_charger && a->state == ST_AWAKE && t >= w->near_until && u01(w) < 1.0f / 14400.0f)
        w->near_mm = (int)urange(w, 60, 300), w->near_until = t + urange(w, 5, 30), h->m->nears++, h->near_t = t;
    if (t >= w->near_until) w->near_mm = 900;   /* nada cerca: el fondo de la mesa o el cuarto */
    alma_near(a, w->near_mm, t);
    alma_sensors sens = {w->soc, w->on_charger};
    alma_tick(a, t, &sens);

    /* métricas por segundo */
    int night = alma_in_night_window(a, t) && !home;
    double alone = home ? 0 : (t - w->away_since) / 60.0;
    int sit = night ? SIT_NOCHE : (s->who == W_CERCA || s->who == W_JUEGO) ? SIT_PRESENTE : home ? -1 : alone < 30 ? SIT_SOLA_CORTA : alone >= 240 ? SIT_SOLA_LARGA : -1;
    int act = act_of(a);
    if (sit >= 0) h->m->sit_act[sit][act] += 1;
    if (sit == SIT_PRESENTE && a->state == ST_AWAKE) {   /* qué tan seguido está permitida cada salida */
        unsigned char mk[ALMA_BRAIN_OUT];
        alma_brain_mask(a, t, mk);
        h->m->mask_n += 1;
        for (int k = 0; k < ALMA_BRAIN_OUT; k++) h->m->mask_ok[k] += mk[k];
        h->m->off_base += !w->on_charger;
    }
    if (sit == SIT_PRESENTE && act == ACT_DORMIR) {
        if (a->state == ST_SLEEPING) h->m->pres_sleep[0] += 1;
        else if (a->state == ST_RESTING) h->m->pres_sleep[a->resting_for_rest ? 1 : 2] += 1;
        else h->m->pres_sleep[3] += 1;   /* siesta o dormitar */
    }
    if (a->state != ST_SLEEPING) h->m->awake_s += 1;
    if (a->cur.active && a->cat->b[a->cur.behavior].category == CAT_PLAY && a->cur.motion_played) h->m->play_s += 1;
    if (present && a->independence >= 0.6f) h->m->pres_hi_s += 1;
    if (present && a->independence <= 0.4f) h->m->pres_lo_s += 1;
    if (!present && !night && a->state != ST_SLEEPING) h->m->alone_awake_s += 1;
    if (h->log && fmod(t, 900.0) < 1.0) {
        char ts[32];
        hhmmss(t, ts);
        fprintf(h->log, "%s  [%s]  · estado: energía %.2f, social %.2f, ánimo %d, batería %.0f%%, base %d, sola %.0f min\n", ts,
                W_NAME[s->who], 1 - alma_need(a, NEED_REST), alma_need(a, NEED_SOCIAL), a->simple_mood, w->soc, w->on_charger, alone);
    }
}

static int pick_scen(alma_rng *r)
{
    float tot = 0;
    for (int i = 0; i < n_sc; i++) tot += SC[i].weight;
    float x = alma_rng_u01(r) * tot;
    for (int i = 0; i < n_sc; i++) { if (x < SC[i].weight) return i; x -= SC[i].weight; }
    return n_sc - 1;
}

/* Una corrida: un escenario, rasgos al azar (A5), `days` días desde un día de la semana al azar */
static void run(const alma_catalog *cat, int sc_ix, uint32_t seed, int days, alma_policy_fn pol, void *pol_user, rec_ctx *rc,
                metrics *m, FILE *log)
{
    static world w;
    memset(&w, 0, sizeof w);
    w.cat = cat;
    alma_rng_seed(&w.rng, seed * 2654435761u + 17);
    w.sc = &SC[sc_ix];
    w.t0 = 10 * DAY;
    int wd0 = (int)(u01(&w) * 7);
    plan(&w, days, wd0);
    hooks_ctx h = {&w, m, log, {-1, -1, -1}, {0}, {0}, 0, 0, 0, 0, alma_find(cat, "bhv_nap"), -1e9, -1e9};
    alma_hooks hooks = {on_exec, NULL, &h, NULL, on_brain};
    alma_init(&w.alma, cat, seed, w.t0, hooks);
    alma_t *a = &w.alma;
    /* A5: 60 % rasgos al azar en [0, 1]; 40 % cerca del medio (como nace Alma) */
    int spread = u01(&w) < 0.6f;
    for (int k = 0; k < TRAIT_COUNT; k++) {
        float v = spread ? u01(&w) : 0.5f + 0.3f * (u01(&w) - 0.5f);
        a->trait[k] = a->trait_base[k] = v;
    }
    a->independence = spread ? u01(&w) : 0.5f + 0.3f * (u01(&w) - 0.5f);
    a->age_days = 30 + (int)(u01(&w) * 200);   /* todo desbloqueado */
    a->soc_pct = w.soc = 60 + 40 * u01(&w);
    /* casi nunca se desmaya: 15 % de las corridas empiezan con un desmayo de hace 0–4 días, para que la red vea la secuela */
    if (u01(&w) < 0.15f) a->faint_s = w.t0 - urange(&w, 0, 4 * DAY);
    w.on_charger = 1;
    w.prev_en_base = 1;
    w.away_since = w.t0 - 8 * HR;
    if (pol) {
        if (rc) { rc->inner = pol; rc->inner_user = pol_user; rc->w = &w; rc->scen_ix = (unsigned short)sc_ix; alma_brain_set_policy(a, rec_policy, rc); }
        else alma_brain_set_policy(a, pol, pol_user);
    }
    if (log) fprintf(log, "\n===== %s · semilla %u · rasgos: cariñosa %.2f, independiente %.2f, juguetona %.2f, impulsiva %.2f, valiente %.2f, energía %.2f =====\n",
                     w.sc->id, seed, a->trait[TRAIT_SOCIABILITY], a->independence, a->trait[TRAIT_PLAYFULNESS], a->trait[TRAIT_IMPULSIVITY],
                     a->trait[TRAIT_BOLDNESS], a->trait[TRAIT_ENERGY]);
    for (w.t = w.t0; w.t < w.t0 + days * DAY; w.t += 1.0) world_second(&w, &h);
    m->days += days;
}

static void write_metrics(const metrics *m, const char *path, const char *pol)
{
    FILE *f = fopen(path, "w");
    if (!f) return;
    fprintf(f, "{\n  \"politica\": \"%s\",\n  \"dias\": %.0f,\n  \"presupuesto\": {\n", pol, m->days);
    for (int s = 0; s < SIT_N; s++) {
        double tot = 0;
        for (int k = 0; k < ACT_N; k++) tot += m->sit_act[s][k];
        fprintf(f, "    \"%s\": {\"horas\": %.0f", SIT_NAME[s], tot / HR);
        for (int k = 0; k < ACT_N; k++) fprintf(f, ", \"%s\": %.3f", ACT_NAME[k], tot ? m->sit_act[s][k] / tot : 0);
        fprintf(f, "}%s\n", s < SIT_N - 1 ? "," : "");
    }
    fprintf(f, "  },\n  \"juego_intenso_min_dia\": %.1f,\n", m->play_s / 60.0 / m->days);
    fprintf(f, "  \"dormir_con_dueno_horas\": {\"noche\": %.0f, \"cansancio\": %.0f, \"otro_descanso\": %.0f, \"siesta\": %.0f},\n",
            m->pres_sleep[0] / HR, m->pres_sleep[1] / HR, m->pres_sleep[2] / HR, m->pres_sleep[3] / HR);
    static const char *const BIN[5] = {"<10min", "10-30min", "30-120min", "2-4h", ">=4h"};
    fprintf(f, "  \"saludo_en_60s_por_ausencia\": {");
    for (int i = 0; i < 5; i++) fprintf(f, "%s\"%s\": [%ld, %.2f]", i ? ", " : "", BIN[i], m->arr_n[i], m->arr_n[i] ? (double)m->arr_greet[i] / m->arr_n[i] : 0);
    fprintf(f, "},\n  \"regaños\": %ld,\n  \"social_o_juego_60s_tras_regaño\": %ld,\n", m->scolds, m->social_after_scold);
    fprintf(f, "  \"cambios_por_hora_despierta\": %.1f,\n  \"aba_10s_por_dia\": %.2f,\n", m->execs_awake / (m->awake_s / HR + 1e-9), m->aba / m->days);
    fprintf(f, "  \"siestas_por_dia\": %.2f,\n  \"siesta_min_media\": %.1f,\n", m->naps / m->days, m->naps ? m->nap_s / m->naps / 60.0 : 0);
    fprintf(f, "  \"pide_atencion_por_hora_con_dueno\": {\"independiente>=0.6\": %.2f, \"independiente<=0.4\": %.2f},\n",
            m->asks_hi / (m->pres_hi_s / HR + 1e-9), m->asks_lo / (m->pres_lo_s / HR + 1e-9));
    fprintf(f, "  \"bateria\": {\"desmayos_por_semana\": %.2f, \"horas_desmayada_por_semana\": %.2f, \"va_a_cargarse_por_dia\": %.2f, "
               "\"bateria_media_al_ir\": %.1f, \"se_baja_por_dia\": %.2f, \"bateria_media_al_bajarse\": %.1f, \"fuera_de_la_base\": %.3f},\n",
            7 * m->faints / m->days, 7 * m->fainted_s / HR / m->days, m->go_home / m->days, m->go_home ? m->go_home_soc / m->go_home : 0,
            m->leave_base / m->days, m->leave_base ? m->leave_soc / m->leave_base : 0, m->off_base_s / (m->days * DAY));
    fprintf(f, "  \"fotos\": {\"por_dia\": %.2f, \"algo_enfrente_por_dia\": %.2f, \"fotos_tras_algo_enfrente\": %.2f},\n", m->photos / m->days,
            m->nears / m->days, m->nears ? (double)m->photos_near / m->nears : 0);
    fprintf(f, "  \"caricias_respondidas_6s\": [%ld, %.2f],\n", m->pets, m->pets ? (double)m->pets_reacted / m->pets : 0);
    fprintf(f, "  \"conductas\": {");
    int first = 1;
    for (int b = 0; b < ALMA_MAX_BEHAVIORS; b++)
        if (m->by_b[b]) fprintf(f, "%s\"%d\": %ld", first ? "" : ", ", b, m->by_b[b]), first = 0;
    fprintf(f, "}\n}\n");
    fclose(f);
}

int main(int argc, char **argv)
{
    if (argc < 6 || (strcmp(argv[1], "gen") && strcmp(argv[1], "eval"))) {
        fprintf(stderr, "uso: brain_gen gen <catalog.json> <inventario.json> <dir_escenarios> <salida.bin> [corridas] [días] [semilla]\n"
                        "     brain_gen eval <catalog.json> <inventario.json> <dir_escenarios> <dir_salida> <maestra|formula|pesos.bin> [corridas] [días] [semilla]\n");
        return 2;
    }
    static alma_catalog cat;
    if (catalog_load(argv[2], argv[3], &cat, 0) <= 0) { fprintf(stderr, "no pude leer el catálogo\n"); return 1; }
    if (load_dir(argv[4])) { fprintf(stderr, "sin escenarios en %s\n", argv[4]); return 1; }
    for (int k = 1; k < O_N; k++)
        if (alma_find(&cat, ALMA_BRAIN_OUT_ID[k]) < 0) fprintf(stderr, "aviso: %s no está en el catálogo\n", ALMA_BRAIN_OUT_ID[k]);
    int gen = !strcmp(argv[1], "gen");
    int ai = gen ? 6 : 7;
    int runs = argc > ai ? atoi(argv[ai]) : gen ? 400 : 60;
    int days = argc > ai + 1 ? atoi(argv[ai + 1]) : 7;
    uint32_t seed = argc > ai + 2 ? (uint32_t)atoi(argv[ai + 2]) : gen ? 1 : 7;
    alma_rng r;
    alma_rng_seed(&r, seed);
    static metrics m;
    if (gen) {
        FILE *out = fopen(argv[5], "wb");
        if (!out) return 1;
        rec_ctx rc = {0};
        rc.out = out;
        for (int i = 0; i < runs; i++) {
            int sc = pick_scen(&r);
            run(&cat, sc, seed * 100003u + i, days, teacher, NULL, &rc, &m, NULL);
            if ((i + 1) % 20 == 0) fprintf(stderr, "%d/%d corridas, %ld ejemplos (%ld decisiones)\n", i + 1, runs, rc.n_rec, rc.n_dec);
        }
        fclose(out);
        FILE *idx = NULL;
        char p[1024];
        snprintf(p, sizeof p, "%s.escenarios.txt", argv[5]);
        if ((idx = fopen(p, "w"))) { for (int i = 0; i < n_sc; i++) fprintf(idx, "%d %s\n", i, SC[i].id); fclose(idx); }
        printf("ok: %ld ejemplos de %ld decisiones en %d corridas\n", rc.n_rec, rc.n_dec, runs);
        return 0;
    }
    const char *pol = argv[6];
    alma_policy_fn fn = NULL;
    void *user = NULL;
    static alma_mlp mlp;
    void *blob = NULL;
    if (!strcmp(pol, "maestra")) fn = teacher;
    else if (strcmp(pol, "formula")) {
        FILE *f = fopen(pol, "rb");
        if (!f) { fprintf(stderr, "no encuentro %s\n", pol); return 1; }
        fseek(f, 0, SEEK_END);
        long n = ftell(f);
        fseek(f, 0, SEEK_SET);
        blob = malloc(n);
        if (fread(blob, 1, n, f) != (size_t)n) return 1;
        fclose(f);
        int e = alma_mlp_load(&mlp, blob, (uint32_t)n);
        if (e) { fprintf(stderr, "pesos inválidos (%d)\n", e); return 1; }
        fn = alma_mlp_policy;
        user = &mlp;
    }
    char path[1024];
    snprintf(path, sizeof path, "%s/bitacora.txt", argv[5]);
    FILE *log = fopen(path, "w");
    for (int i = 0; i < runs; i++) {
        int sc = pick_scen(&r);
        run(&cat, sc, seed * 100003u + i, days, fn, user, NULL, &m, i < 4 || getenv("BRAIN_LOG_ALL") ? log : NULL);
    }
    if (log) fclose(log);
    if (getenv("BRAIN_DEBUG")) {
        fprintf(stderr, "con el dueño y despierta: %.0f h, fuera de la base %.0f%%\n", m.mask_n / HR, 100 * m.off_base / (m.mask_n + 1e-9));
        for (int k = 0; k < ALMA_BRAIN_OUT; k++) fprintf(stderr, "  %-22s %3.0f%%\n", ALMA_BRAIN_OUT_ID[k], 100 * m.mask_ok[k] / (m.mask_n + 1e-9));
    }
    snprintf(path, sizeof path, "%s/metricas.json", argv[5]);
    write_metrics(&m, path, pol);
    printf("ok: %s\n", path);
    free(blob);
    return 0;
}
