/* test_f2.c — alma-f2 completo en la PC con HAL falsos (hal_fake.c): misma aplicación que en el ESP32.
 * Uso: test_f2 <catalog.json> <storage.bin> <assets_inventory.json> <mot_tool.json>
 *   storage.bin y assets_inventory.json son privados (emo_backup, R5); mot_tool.json lo genera test/build.sh con
 *   alma/tools/mot_studio/test/dump_mot_tool.py (mot_tool.parse de cada .mot). */
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "alma_mem.h"
#include "api.h"
#include "app.h"
#include "battery.h"
#include "cJSON.h"
#include "catalog_load.h"
#include "expression.h"
#include "fiesta.h"
#include "gait.h"
#include "f2_config.h"
#include "hal_fake.h"
#include "mbedtls/sha256.h"
#include "hal_k210.h"
#include "home.h"
#include "link.h"
#include "ota.h"
#include "outbox.h"
#include "motion_player.h"
#include "perception.h"
#include "reflexes.h"
#include "sense.h"
#include "backup.h"
#include "body.h"
#include "uplink.h"
#include "rlog.h"
#include "vision.h"
#include "voice.h"
#include "ws.h"
static int tx_has_text(int from, const char *txt);

static int fails, checks;
#define CHECK(c, ...) do { checks++; if (!(c)) { fails++; printf("FALLA %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

static const char *catalog_path, *inventory_path;
static char *catalog_text;
static alma_catalog cat, cat_ref;
static cJSON *motref;   /* mot_tool.parse de cada archivo */

static char *read_text(const char *p)
{
    FILE *f = fopen(p, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *b = malloc((size_t)n + 1);
    if (fread(b, 1, (size_t)n, f) != (size_t)n) { free(b); fclose(f); return NULL; }
    b[n] = 0;
    fclose(f);
    return b;
}

/* ---- registro de conductas y cuadros ---- */
#define EXMAX 20000
static struct { int64_t t; alma_exec_info e; } ex[EXMAX];
static int n_ex;
static void on_exec(const alma_exec_info *e) { if (n_ex < EXMAX) { ex[n_ex].t = fake_ms; ex[n_ex++].e = *e; } }

#define FRMAX 20000
static struct { char mot[ALMA_MOT_LEN]; int k, executed; mot_frame f; float deg[4]; int64_t t; } fr[FRMAX];
static int n_fr;
static void on_frame(const char *mot, int k, const mot_frame *f, int executed)
{
    if (n_fr >= FRMAX) return;
    snprintf(fr[n_fr].mot, ALMA_MOT_LEN, "%s", mot);
    fr[n_fr].k = k;
    fr[n_fr].executed = executed;
    fr[n_fr].f = *f;
    fr[n_fr].t = fake_ms;
    for (int s = 0; s < 4; s++) fr[n_fr].deg[s] = fake_servo_deg[motion_s_to_servo[s]];
    n_fr++;
}

static int bx(const char *id) { return alma_find(app_catalog(), id); }

static int boot_rlog_was;
static void boot_app(fake_k210_mode mode)
{
    fake_reset();
    fake_k210 = mode;
    n_ex = n_fr = 0;
    app_set_exec_cb(on_exec);
    motion_set_frame_cb(on_frame);
    CHECK(app_init(catalog_text, &cat, 7) == 0, "app_init");
    boot_rlog_was = rlog_on();   /* al arrancar se prende solo (4 h); en las pruebas se apaga para no mezclarlo */
    rlog_set(0);
}

static int run_until_ready(int64_t max_ms)
{
    for (int64_t t = 0; t < max_ms; t += 10) {
        fake_run(10);
        if (k210_get_state() == K210_READY || k210_get_state() == K210_FAILED) break;
    }
    return k210_get_state() == K210_READY;
}

static int servo_sets_since(int from, int idx)
{
    int n = 0;
    for (int i = from; i < fake_n_servo; i++) n += fake_servo[i].op == 's' && (idx < 0 || fake_servo[i].idx == idx);
    return n;
}

static int first_exec_of(int b, int from)
{
    for (int i = from; i < n_ex; i++) if (ex[i].e.behavior == b) return i;
    return -1;
}

static int tx_eq(int i, const uint8_t *b, size_t n) { return i < fake_n_tx && fake_txs[i].n == n && memcmp(fake_txs[i].b, b, n) == 0; }

static int tx_find(const uint8_t *b, size_t n, int from)
{
    for (int i = from; i < fake_n_tx; i++) if (tx_eq(i, b, n)) return i;
    return -1;
}

static size_t anim(uint8_t *f, size_t cap, const char *avi, const char *mp3, int mode)
{
    char p[192];
    k210_anim_payload(p, sizeof p, avi, mp3, mode);
    return k210_ext(f, cap, 0x02, p, K210_CS_CRC8);
}

/* ---- 1. catálogo por el camino del firmware (catalog.json + inventario de la SPIFFS) = el del simulador ---- */
static void test_catalog(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(catalog_load(catalog_path, inventory_path, &cat_ref, 0) == 46, "catalog_load de referencia: 46 conductas (con bhv_trick)");
    CHECK(app_catalog()->n == 46 && memcmp(app_catalog(), &cat_ref, sizeof cat_ref) == 0,
          "el catálogo cargado con el inventario de la SPIFFS es idéntico byte por byte al del simulador");
    const expr_face *f;
    CHECK(expression_faces(bx("bhv_listen"), &f) == 1 && strcmp(f[0].avi, "listen_and_think") == 0 && f[0].mode == 1,
          "cara de bhv_listen: listen_and_think modo 1");
    CHECK(expression_faces(bx("bhv_blink_idle"), &f) == 6, "bhv_blink_idle: 6 caras");
    CHECK(expression_faces(bx("bhv_doze"), &f) == 3 && strcmp(f[0].avi, "sleep_get_in_Doze_off") == 0, "bhv_doze: sleep_get_in_Doze_off y despertares (dueño, 2026-10-30)");
    const expr_face *md = expression_media("explore_play1");
    CHECK(md && strcmp(md->avi, "explore_play1") == 0 && strcmp(md->mp3, "explore_play1_000") == 0, "media: explore_play1 con su cara y su sonido");
}

/* ---- 2. arranque del K210: frames de 03, sin respaldo ---- */
static void test_boot(void)
{
    /* (CMD, d0, hex esperado) de 03, "Secuencia de arranque" y "Vectores de prueba" */
    static const struct { uint8_t c, d0; const char *hx; } SMALL[] = {
        {0x34, 0, "55aa340000003" "3"}, {0x69, 1, "55aa6901000069"}, {0x69, 1, "55aa6901000069"}, {0x69, 1, "55aa6901000069"},
        {0x2C, 0, "55aa2c0000002b"}, {0, 0, "profile"}, {0x2D, 0, "55aa2d0000002c"}, {0x70, 0, "55aa700000006f"},
        {0x38, 1, "55aa3801000038"}, {0x06, 1, "55aa0601100016"}, {0x17, 0x68, "55aa176800007e"}, {0x6A, 0x46, "55aa6a460000af"},
        {0x6C, 0, "55aa6c0000006b"}, {0x74, 0, "55aa7400000073"}, {0, 0, "boot_start"}};
    static const uint8_t PROFILE[] = {0x55, 0xAA, 0xFF, 0x1A, 0x00, 0x03, 0x1B, 0x2F, 0x73, 0x70, 0x69, 0x66, 0x66, 0x73, 0x2F,
                                      0x6A, 0x73, 0x6F, 0x6E, 0x2F, 0x70, 0x72, 0x6F, 0x66, 0x69, 0x6C, 0x65, 0x2E, 0x6A, 0x73,
                                      0x6F, 0x6E, 0x00, 0x10};
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000) && strcmp(k210_boot_used(), "SAM-SPI") == 0, "K210 listo con [SAM-SPI]");
    CHECK(fake_n_tx >= 15, "frames enviados: %d", fake_n_tx);
    for (int i = 0; i < 15 && i < fake_n_tx; i++) {
        char hx[600] = {0};
        for (size_t k = 0; k < fake_txs[i].n; k++) sprintf(hx + 2 * k, "%02x", fake_txs[i].b[k]);
        if (strcmp(SMALL[i].hx, "profile") == 0) CHECK(tx_eq(i, PROFILE, sizeof PROFILE), "frame %d = profile.json capturado (03)", i);
        else if (strcmp(SMALL[i].hx, "boot_start") == 0) {
            const uint8_t *b = fake_txs[i].b;
            size_t n = fake_txs[i].n;
            CHECK(b[3] == 0x4C && b[6] == 0x4C && b[n - 1] == 0xC4, "boot_start: LEN 4C, HDR_CS 4C, PAYLOAD_CS C4 (03): %02x %02x %02x", b[3], b[6], b[n - 1]);
        } else CHECK(strcmp(hx, SMALL[i].hx) == 0, "frame %d: %s (esperado %s)", i, hx, SMALL[i].hx);
    }
    CHECK(fake_n_resetn == 1 && fake_txs[0].t - fake_resetn_t[0] == 3500, "[SAM-SPI]: RESETN y 3500 ms después 0x34 (%lld ms)",
          (long long)(fake_txs[0].t - fake_resetn_t[0]));
    CHECK(fake_log_contains("k210 listo (0x47) con [SAM-SPI]"), "registro del arranque");

    /* el K210 solo contestaría al orden de [EL-GPIO]: ya no hay segunda secuencia */
    boot_app(K_REPLY_EL);
    CHECK(!run_until_ready(30000) && k210_get_state() == K210_FAILED, "sin respaldo: K210_FAILED con el orden de [EL-GPIO]");
    CHECK(fake_n_resetn == 1 && fake_n_tx == 15, "una sola secuencia (%d frames, %d RESETN)", fake_n_tx, fake_n_resetn);

    boot_app(K_SILENT);
    CHECK(!run_until_ready(30000) && k210_get_state() == K210_FAILED, "sin 0x47: K210_FAILED");
    uint8_t f[256];
    int before = fake_n_tx;
    CHECK(k210_play("stay_wink_1", NULL, 0) == -1 && fake_n_tx == before, "sin K210 listo no se manda nada");
    (void)f;
}

/* ---- 3. "Hey EMO" (0x0B) → bhv_listen, GPIO26 bloqueado, orden, GPIO26 restaurado ---- */
static void run_k210(int64_t ms);

static void test_listen(void)
{
    boot_app(K_REPLY_SAM);
    fake_sensors.on_charger = 0;   /* antes de arrancar: en la base los servos se sueltan (base_servos) */
    run_until_ready(15000);
    /* con enlace y 3 s de audio (test_voice prueba la voz): la escucha dura lo que dura sin respuesta del servidor */
    char wl[64];
    api_link_msg("{\"t\":\"welcome\"}", wl, sizeof wl);
    fake_mic_chunks = 30;
    fake_run(2000);
    int s0 = fake_n_servo, t0 = fake_n_tx, e0 = n_ex;
    fake_k210_small(0, 0x0B, 10, 20, 30);
    fake_run(300);
    int il = first_exec_of(bx("bhv_listen"), e0);
    CHECK(il >= 0 && ex[il].e.kind == RUN_FORCED, "0x0B → EV_WAKE_WORD → bhv_listen forzada");
    CHECK(app_alma()->state == ST_LISTENING && motion_gpio26_locked(), "ST_LISTENING con GPIO26 bloqueado");
    uint8_t f[256];
    size_t n = anim(f, sizeof f, "listen_and_think", NULL, 1);
    CHECK(tx_find(f, n, t0) >= 0, "cara listen_and_think (modo 1, sin sonido todavía) enviada al K210");
    n = anim(f, sizeof f, "listen_and_think", "listen_and_think_000", 1);
    CHECK(tx_find(f, n, t0) < 0, "el sonido de escuchar no suena con la palabra");
    run_k210(1300);
    CHECK(tx_find(f, n, t0) >= 0, "a los 1.2 s, cuando ya graba: la cara con su sonido (la señal de que escucha)");
    int rel = -1;
    for (int i = s0; i < fake_n_servo; i++) if (fake_servo[i].op == 'r' && fake_servo[i].idx == HAL_SERVO_GPIO26) rel = i;
    CHECK(rel >= 0, "GPIO26 soltado al empezar a escuchar");
    fake_run(2000);
    CHECK(servo_sets_since(rel, HAL_SERVO_GPIO26) == 0, "ningún comando a GPIO26 mientras escucha");
    char out[256];
    int e1 = n_ex;
    CHECK(api_command("{\"action_id\":\"dance\"}", out, sizeof out) == 200, "/api/command dance: %s", out);
    fake_run(300);
    int ic = -1;
    for (int i = e1; i < n_ex; i++) if (ex[i].e.kind == RUN_COMMAND || ex[i].e.behavior == bx("bhv_refuse")) { ic = i; break; }
    CHECK(ic >= 0 && (ex[ic].e.behavior == bx("bhv_dance") || ex[ic].e.behavior == bx("bhv_refuse")),
          "la orden se obedece (bhv_dance) o se rechaza (bhv_refuse)");
    CHECK(app_alma()->state != ST_LISTENING && !motion_gpio26_locked(), "terminó la escucha: GPIO26 libre");
    int res = -1;
    for (int i = rel; i < fake_n_servo; i++) if (fake_servo[i].op == 'R' && fake_servo[i].idx == HAL_SERVO_GPIO26) { res = i; break; }
    int first26 = -1;
    for (int i = rel; i < fake_n_servo; i++) if (fake_servo[i].op == 's' && fake_servo[i].idx == HAL_SERVO_GPIO26) { first26 = i; break; }
    CHECK(res >= 0 && (first26 < 0 || res < first26), "GPIO26 restaurado antes de cualquier comando a ese servo");
    CHECK(api_command("{\"action_id\":\"volar\"}", out, sizeof out) == 400, "action_id desconocido: 400");

    /* una orden de la nube simulada, y un reflejo durante la escucha */
    fake_run(20000);
    e1 = n_ex;
    fake_k210_small(0, 0x0B, 1, 0, 0);
    fake_run(300);
    CHECK(app_alma()->state == ST_LISTENING, "segunda escucha");
    alma_ev v = {EV_VOICE_COMMAND, 1, ACT_STOP, -1, 0, 0, 0, 0};
    app_post(&v);
    fake_run(300);
    CHECK(app_alma()->state != ST_LISTENING && !motion_gpio26_locked(), "EV_VOICE_COMMAND termina la escucha y libera GPIO26");
    fake_run(20000);
    fake_k210_small(0, 0x0B, 1, 0, 0);
    fake_run(300);
    int stops = fake_audio_stops;
    fake_sensors.lifted = 1;
    fake_run(100);
    CHECK(app_alma()->state == ST_REFLEX && !motion_gpio26_locked() && fake_audio_stops > stops,
          "levantarla mientras escucha: reflejo, grabación cortada y GPIO26 restaurado");
    fake_sensors.lifted = 0;
    fake_run(5000);
}

/* compara los cuadros reproducidos desde fr[from] con mot_tool.parse de cada .mot de la opción */
static int compare_option(const alma_motion_opt *o, int from, int *frames_out)
{
    int i = from, bad = 0, total = 0;
    for (int m = 0; m < o->n; m++) {
        char path[40], key[48];
        motion_path(o->mot[m], path);
        snprintf(key, sizeof key, "%s", path + 5);
        const cJSON *ref = cJSON_GetObjectItemCaseSensitive(motref, key);
        if (!cJSON_IsArray(ref)) { printf("  sin referencia para %s\n", key); return -1; }
        const cJSON *rf;
        int k = 0;
        cJSON_ArrayForEach(rf, ref) {
            if (i >= n_fr) return -1;
            if (strcmp(fr[i].mot, o->mot[m]) != 0) return -1;   /* otra conducta la cortó: no es una ejecución completa */
            const char *mode = cJSON_GetObjectItemCaseSensitive(rf, "mode")->valuestring;
            int ms = cJSON_GetObjectItemCaseSensitive(rf, "ms")->valueint, pose = strcmp(mode, "pose") == 0;
            const cJSON *s = cJSON_GetObjectItemCaseSensitive(rf, "s");
            int ok = strcmp(fr[i].mot, o->mot[m]) == 0 && fr[i].k == k && fr[i].f.ms == ms && fr[i].executed == (pose || gait_supported(fr[i].f.mode));
            for (int q = 0; q < 4 && ok && pose; q++) ok = fr[i].deg[q] == (float)cJSON_GetArrayItem(s, q)->valueint;
            if (!ok && bad < 3)
                printf("  %s cuadro %d distinto de mot_tool (llegó %s %d, %d/%d ms, ejecutado %d)\n", o->mot[m], k, fr[i].mot, fr[i].k,
                       fr[i].f.ms, ms, fr[i].executed);
            bad += !ok;
            i++; k++; total++;
        }
    }
    *frames_out = total;
    return bad;
}

/* ---- 3b. marcha: gait.c contra la referencia (emo_backup/re/marcha_ref.c), muestra por muestra, en cada primitiva
   1, 2 y 14 de los .mot del catálogo (HALLAZGOS §5) ---- */
static const char *gait_ref_dir;

static void test_gait_ref(void)
{
    if (!gait_ref_dir) { printf("  marcha: sin referencia (falta emo_backup/re/marcha_ref.c); se omite\n"); return; }
    const alma_catalog *c = app_catalog();
    static mot_frame f[MOTION_MAX_FRAMES];
    char seen[400][ALMA_MOT_LEN];
    int n_seen = 0, recs = 0, samples = 0, bad = 0;
    for (int b = 0; b < c->n; b++)
        for (int k = 0; k < c->b[b].n_opt; k++)
            for (int m = 0; m < c->b[b].opt[k].n; m++) {
                const char *name = c->b[b].opt[k].mot[m];
                int dup = 0;
                for (int i = 0; i < n_seen; i++) dup |= strcmp(seen[i], name) == 0;
                if (dup || n_seen == 400) continue;
                snprintf(seen[n_seen++], ALMA_MOT_LEN, "%s", name);
                int n = motion_load(name, f, MOTION_MAX_FRAMES);
                char path[512];
                snprintf(path, sizeof path, "%s/%s.txt", gait_ref_dir, name);
                FILE *r = fopen(path, "r");
                if (n <= 0 || !r) { if (r) fclose(r); continue; }
                char line[128];
                int rec = -1, cur[4] = {90, 90, 90, 90};
                static gait_state g;
                int live = 0;
                while (fgets(line, sizeof line, r)) {
                    int t, a[4];
                    if (line[0] == '#') {
                        if (live && gait_next(&g, a)) { bad++; if (bad < 4) printf("  %s registro %d: gait da muestras de más\n", name, rec); }
                        rec++;
                        live = rec < n && gait_supported(f[rec].mode) && gait_begin(&g, &f[rec], cur) == 0;
                        recs += live;
                        continue;
                    }
                    if (sscanf(line, "%d %d %d %d %d", &t, &a[0], &a[1], &a[2], &a[3]) != 5) continue;
                    if (live) {
                        int o[4];
                        samples++;
                        if (!gait_next(&g, o) || memcmp(o, a, sizeof o)) {
                            bad++;
                            if (bad < 4) printf("  %s registro %d t=%d: gait %d/%d/%d/%d, referencia %d/%d/%d/%d\n", name, rec, t,
                                                o[0], o[1], o[2], o[3], a[0], a[1], a[2], a[3]);
                        }
                    }
                    memcpy(cur, a, sizeof cur);
                }
                if (live && gait_next(&g, cur)) bad++;
                fclose(r);
            }
    printf("  marcha: %d primitivas, %d muestras comparadas con la referencia, %d distintas\n", recs, samples, bad);
    CHECK(recs > 0 && bad == 0, "gait.c = referencia en %d primitivas (%d muestras)", recs, samples);
}

/* ---- 4. caricia → bhv_enjoy_pet con su .mot, que llega a los servos igual que en mot_tool ---- */
static void test_pet_and_lift(void)
{
    boot_app(K_REPLY_SAM);
    run_until_ready(15000);
    fake_sensors.on_charger = 0;
    fake_run(3000);
    int ip = -1;
    for (int tries = 0; tries < 40 && ip < 0; tries++) {
        int e0 = n_ex;
        fake_sensors.touch_pet = 1;
        fake_run(50);
        fake_sensors.touch_pet = 0;
        fake_run(150);
        int i = first_exec_of(bx("bhv_enjoy_pet"), e0);
        if (i >= 0 && ex[i].e.option >= 0) ip = i;
        else fake_run(8000);
    }
    CHECK(ip >= 0, "una caricia lleva a bhv_enjoy_pet con .mot");
    if (ip < 0) return;
    const alma_behavior *b = &app_catalog()->b[ex[ip].e.behavior];
    const alma_motion_opt *o = &b->opt[ex[ip].e.option];
    int fr0 = n_fr;
    CHECK(motion_active(), "el .mot de bhv_enjoy_pet está sonando (%s)", o->mot[0]);

    /* levantarla a media conducta: servos detenidos en < 50 ms de tiempo simulado; después, enojo y forcejeo
       (bhv_reflex_struggle, decisión del dueño 2026-10-30), y quietos al terminar mientras siga levantada */
    fake_run(300);
    int64_t T = fake_ms;
    int sv = fake_n_servo, e0 = n_ex;
    fake_sensors.lifted = 1;
    fake_run(100);
    int ir = first_exec_of(bx("bhv_reflex_struggle"), e0);
    CHECK(reflex_last_ms() - T <= 50 && reflex_last_ms() >= T, "servos detenidos %lld ms después de levantarla",
          (long long)(reflex_last_ms() - T));
    CHECK(ir >= 0 && ex[ir].e.kind == RUN_REFLEX && ex[ir].t - T <= 50 && ex[ir].e.option >= 0, "bhv_reflex_struggle con .mot en %lld ms",
          ir >= 0 ? (long long)(ex[ir].t - T) : -1LL);
    printf("  reflejo al levantarla: servos quietos a los %lld ms, bhv_reflex_struggle a los %lld ms (tiempo simulado)\n",
           (long long)(reflex_last_ms() - T), ir >= 0 ? (long long)(ex[ir].t - T) : -1LL);
    int stop_at = -1;
    for (int i = sv; i < fake_n_servo; i++) if (fake_servo[i].op == 'h') { stop_at = i; break; }
    CHECK(stop_at >= 0, "al levantarla, los servos se detienen primero");
    fake_run(1000);
    CHECK(servo_sets_since(stop_at, -1) > 0 && motion_active(), "después, forcejea (struggle_strong_*)");
    fake_run(7000);
    int quiet = fake_n_servo;
    fake_run(3000);
    CHECK(!motion_active() && servo_sets_since(quiet, -1) == 0, "terminado el forcejeo, quieta mientras siga levantada");
    fake_sensors.lifted = 0;
    fake_run(8000);
    (void)fr0;

    /* como en el robot (2026-10-30): al levantarla, los pies pierden el piso ~0.4 s antes que el IMU, y en la mano
       siguen llegando bordes. El forcejeo empieza igual y los bordes no lo cortan */
    fake_sensors.on_charger = 0;
    fake_run(20000);
    int e9 = n_ex;
    fake_sensors.floor[HAL_FOOT_L][0] = fake_sensors.floor[HAL_FOOT_L][1] = fake_sensors.floor[HAL_FOOT_R][0] = 0;
    fake_sensors.floor[HAL_FOOT_R][1] = 1;   /* tres de cuatro sin piso: borde adelante y atrás */
    fake_run(400);
    fake_sensors.lifted = 1;
    fake_run(300);
    int is = first_exec_of(bx("bhv_reflex_struggle"), e9);
    CHECK(is >= 0 && ex[is].e.option >= 0 && motion_active(), "borde y 0.4 s después levantada: forcejea igual");
    fake_sensors.floor[HAL_FOOT_R][1] = 0;
    fake_run(200);
    fake_sensors.floor[HAL_FOOT_R][1] = 1;   /* otro borde en la mano */
    fake_run(500);
    CHECK(motion_active() && first_exec_of(bx("bhv_reflex_freeze"), is) < 0, "en la mano, los bordes no cortan el forcejeo");
    fake_sensors.shaken = 1;
    fake_run(100);
    fake_sensors.shaken = 0;
    fake_run(100);
    CHECK(motion_active() && first_exec_of(bx("bhv_reflex_freeze"), is) < 0, "en la mano, sacudirlo no corta el forcejeo");
    for (int f = 0; f < 2; f++) fake_sensors.floor[f][0] = fake_sensors.floor[f][1] = 1;
    fake_sensors.lifted = 0;
    fake_run(8000);

    /* otra caricia, ahora sin interrupción: los cuadros que llegan a los servos son los de mot_tool */
    /* después del forcejeo, la regla 2 (necesidad de descanso) puede cambiarla por bhv_doze antes de terminar: se
       reintenta hasta tener una caricia completa */
    ip = -1;
    int frames = 0, bad = -1;
    for (int tries = 0; tries < 40 && bad < 0; tries++) {
        int e1 = n_ex, from = n_fr;
        fake_sensors.touch_pet = 1;
        fake_run(50);
        fake_sensors.touch_pet = 0;
        fake_run(150);
        int i = first_exec_of(bx("bhv_enjoy_pet"), e1);
        if (i < 0 || ex[i].e.option < 0 || !motion_active()) { fake_run(8000); continue; }
        ip = i;
        o = &app_catalog()->b[ex[ip].e.behavior].opt[ex[ip].e.option];
        for (int k = 0; k < 2000 && motion_active(); k++) fake_run(10);
        bad = compare_option(o, from, &frames);
        if (bad < 0) fake_run(8000);
    }
    CHECK(ip >= 0, "segunda bhv_enjoy_pet con .mot");
    if (ip < 0) return;
    CHECK(bad == 0 && frames > 0, "bhv_enjoy_pet (%s%s): %d cuadros, %d distintos de mot_tool", o->mot[0], o->n > 1 ? " …" : "", frames, bad);
}

/* ---- 4b. su propio movimiento no es una sacudida (robot, 2026-11-02: react_look_down → EV_SHAKEN → bhv_dizzy) ---- */
static void test_own_shake(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;
    fake_run(2000);
    const alma_catalog *c = app_catalog();
    alma_motion_opt o = c->b[bx("bhv_look_around")].opt[0];
    CHECK(motion_play(&o, 0, 0) == MOTION_OK, "se mueve solo");
    fake_log_clear();
    fake_sensors.shaken = 1;
    fake_run(400);
    fake_sensors.shaken = 0;
    fake_run(1000);
    const alma_t *a = app_alma();
    CHECK(fake_log_count("REFLEJO EV_SHAKEN") == 0 && a->counts.shakes == 0, "moviéndose solo: el IMU agitado no es EV_SHAKEN");
    fake_sensors.lifted = 1;   /* levantada forcejea (se mueve): la sacudida en la mano va al forcejeo, sin REFLEJO */
    fake_run(300);
    CHECK(motion_active(), "forcejea en la mano");
    fake_sensors.shaken = 1;
    fake_run(100);
    CHECK(a->counts.shakes == 1, "en la mano sí cuenta, aunque se mueva");
    fake_sensors.shaken = 0;
    fake_sensors.lifted = 0;
    fake_run(5000);
    fake_sensors.on_charger = 1;   /* R14: cargando no hay servos, así que está quieto */
    motion_stop_now();
    fake_run(1500);
    fake_log_clear();
    fake_sensors.shaken = 1;
    fake_run(100);
    CHECK(fake_log_count("REFLEJO EV_SHAKEN") == 1, "quieto: la sacudida cuenta en el acto");
    fake_sensors.shaken = 0;
    fake_sensors.on_charger = 0;
    fake_run(5000);
}

/* ---- 4c. al dejarlo, 2 s antes de los bordes (dueño, 2026-11-02: lo levantó de acostado y saltó de lado en la mano) ---- */
static void test_put_down_edges(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;
    fake_run(2000);
    int e0 = n_ex, asks = 0;
    fake_sensors.tipped = 1;
    fake_run(20000);
    for (int i = e0; i < n_ex; i++) asks += ex[i].e.behavior == bx("bhv_ask_help");
    CHECK(asks >= 3, "volcado 20 s: sigue pidiendo ayuda (%d veces)", asks);
    fake_log_clear();

    fake_sensors.tipped = 0;                       /* derecho en la mano: cuenta como dejado */
    fake_sensors.floor[HAL_FOOT_L][0] = fake_sensors.floor[HAL_FOOT_L][1] = 1;
    fake_sensors.floor[HAL_FOOT_R][0] = fake_sensors.floor[HAL_FOOT_R][1] = 0;
    fake_run(1500);
    CHECK(fake_log_count("REFLEJO EV_CLIFF") == 0, "recién dejado: los bordes esperan");
    fake_run(2500);   /* la espera, más la de su reacción al dejarlo */
    CHECK(fake_log_count("REFLEJO EV_CLIFF") >= 1, "pasada la espera, si sigue sin piso, el borde cuenta (%d)", fake_log_count("REFLEJO EV_CLIFF"));
    for (int f = 0; f < 2; f++) fake_sensors.floor[f][0] = fake_sensors.floor[f][1] = 1;
    fake_run(5000);
}

/* ---- 5. todos los .mot del catálogo, directo al reproductor ---- */
static void test_all_mot(void)
{
    boot_app(K_REPLY_SAM);
    const alma_catalog *c = app_catalog();
    int opts = 0, frames_total = 0, bad_total = 0, gait = 0, timing_bad = 0;
    uint32_t sk0 = motion_skipped_gait_frames();
    for (int b = 0; b < c->n; b++)
        for (int k = 0; k < c->b[b].n_opt; k++) {
            n_fr = 0;
            CHECK(motion_play(&c->b[b].opt[k], 0, 0) == MOTION_OK, "%s opción %d", c->b[b].id, k);
            for (int t = 0; t < 400000 && motion_active(); t++) { fake_ms++; if (fake_ms % F2_MOTION_STEP_MS == 0) motion_step(); }
            int frames = 0, bad = compare_option(&c->b[b].opt[k], 0, &frames);
            CHECK(bad == 0, "%s opción %d: %d cuadros distintos de mot_tool", c->b[b].id, k, bad);
            /* [BOBBY-ARTE]: una pose dura ms (se mueve y pasa al siguiente); una primitiva, pasos × T. El cierre de
               cada cuadro llega en el primer paso del bucle después de su fin: ±1 paso */
            int late = 0;
            for (int i = 1; i < n_fr; i++) {
                int64_t want = mot_frame_ms(&fr[i].f), got = fr[i].t - fr[i - 1].t;
                if (got < want - F2_MOTION_STEP_MS || got > want + F2_MOTION_STEP_MS) late++;
            }
            timing_bad += late;
            CHECK(late == 0, "%s opción %d: %d cuadros con duración distinta de la real", c->b[b].id, k, late);
            opts++; frames_total += frames; bad_total += bad > 0 ? bad : 0;
            gait += c->b[b].opt[k].gait;
        }
    printf("  .mot del catálogo: %d opciones, %d cuadros iguales a mot_tool (%d con paso o giro, %u cuadros saltados), "
           "%d con duración distinta de la real\n",
           opts, frames_total - bad_total, gait, motion_skipped_gait_frames() - sk0, timing_bad);
    alma_motion_opt o = c->b[bx("bhv_enjoy_pet")].opt[0];
    CHECK(motion_play(&o, 1, 0) == MOTION_REFUSED_CHARGING, "motion_play cargando: rechazado (R14)");
    CHECK(motion_play(&o, 0, 1) == MOTION_REFUSED_BUDGET, "motion_play sin presupuesto: rechazado (budget_s)");
}

/* ---- 6. en la base: ni un comando a los servos ---- */
static void test_on_charger(void)
{
    boot_app(K_REPLY_SAM);
    run_until_ready(15000);
    int sv = fake_n_servo, e0 = n_ex;
    for (int m = 0; m < 30; m++) {   /* 30 min con caricias, toques, ruido y una orden */
        fake_sensors.touch_pet = 1; fake_run(50); fake_sensors.touch_pet = 0;
        if (m % 5 == 0) { char out[128]; api_command("{\"action_id\":\"dance\"}", out, sizeof out); }
        if (m % 7 == 0) { alma_ev e = {EV_LOUD_SOUND, -1, -1, -1, 0, 0, 0, 0}; app_post(&e); }
        fake_run(60000 - 50);
    }
    int with_charger_null = 0;
    for (int i = e0; i < n_ex; i++) with_charger_null += ex[i].e.motion_null_reason == 3;
    CHECK(n_ex - e0 > 20 && servo_sets_since(sv, -1) == 0, "30 min en la base: %d conductas y %d comandos a servos",
          n_ex - e0, servo_sets_since(sv, -1));
    printf("  30 min en la base: %d conductas, %d con .mot sin servos por cargar, %d comandos a servos\n", n_ex - e0,
           with_charger_null, servo_sets_since(sv, -1));
    CHECK(with_charger_null > 0, "%d conductas con .mot ejecutadas sin servos por estar cargando", with_charger_null);
}

/* ---- 7. perception: frames sin tabla al registro con marca de tiempo ---- */
static void test_perception(void)
{
    boot_app(K_REPLY_SAM);
    run_until_ready(15000);
    fake_log_clear();
    uint32_t u0 = perception_unknown_frames();
    fake_k210_small(0, 0x02, 1, 2, 3);                 /* "got face cmd"? formato PENDIENTE */
    uint8_t junk[] = {0x12, 0x34, 0x55, 0xAA, 0x13, 0, 0, 0, 0x00};
    fake_k210_send(5, junk, sizeof junk);
    fake_run(100);
    CHECK(perception_unknown_frames() - u0 >= 2, "frames desconocidos contados: %u", perception_unknown_frames() - u0);
    CHECK(fake_log_contains("perception: frame desconocido t=") && fake_log_contains(" 55 aa 02 01 02 03"),
          "frame 0x02 al registro con marca de tiempo");
    static const perc_rule T2[] = {{0x02, PERC_EVENT, EV_FACE_SEEN, "PRUEBA", "cara (tabla de prueba)"}};
    perception_set_table(T2, 1);
    int e0 = n_ex;
    (void)e0;
    u0 = perception_unknown_frames();
    fake_k210_small(0, 0x02, 1, 0, 0);
    fake_run(100);
    CHECK(perception_unknown_frames() == u0 && fake_log_contains("perception: 02"), "con otra tabla, 0x02 produce su evento");
    perception_set_table(NULL, 0);
}

/* ---- 7b. caras: sondeo 0A cada 200 ms, respuesta de 124 bytes y eventos (03, "Caras") ---- */
static int events_since(int64_t t0, int type, int person)
{
    const app_ev_log *l;
    int first, n = app_events(&l, &first), c = 0;
    for (int i = 0; i < n; i++) {
        const app_ev_log *e = &l[(first + i) % F2_LOG_EVENTS];
        c += e->t_ms >= t0 && e->type == type && (person == -9 || e->person == person);
    }
    return c;
}

static void test_faces(void)
{
    k210_scan_every_ms = 0;   /* vistazo continuo: estas pruebas son de la detección */
    boot_app(K_REPLY_SAM);
    /* con la persona 0 delante, bhv_routine (minutos de animación, sin vistazos) taparía la detección: fuera de juego aquí */
    ((alma_t *)app_alma())->last_exec_t[bx("bhv_routine")] = 1e12;
    CHECK(run_until_ready(15000), "K210 listo");
    /* como el original (CARAS2.md): 38 01, 3 s, 10 sondeos en el modo 1, 38 04 y el modo 4 para siempre */
    static const uint8_t MODE4[] = {0x55, 0xAA, 0x38, 0x04, 0x00, 0x00, 0x3B};
    int tr = fake_n_tx, p0 = fake_face_polls;
    fake_run(2900);
    CHECK(fake_face_polls == p0 && k210_face_phase() == 1, "listo: 38 01 y 3 s sin sondear (%d)", fake_face_polls - p0);
    fake_run(2300);
    CHECK(k210_face_phase() == 3 && fake_face_polls - p0 == 10 && tx_find(MODE4, sizeof MODE4, tr) >= 0,
          "10 sondeos en el modo 1 y después 38 04 (%d sondeos)", fake_face_polls - p0);
    p0 = fake_face_polls;
    fake_run(1000);
    CHECK(fake_face_polls - p0 >= 4 && fake_face_polls - p0 <= 6, "modo 4: 0A cada 200 ms: %d en 1 s", fake_face_polls - p0);
    CHECK(k210_face_replies() == 0 && events_since(0, EV_FACE_SEEN, -9) == 0, "sin respuesta del K210, ningún evento de cara");

    /* conocida, centrada: un EV_FACE_SEEN al llegar y después uno por segundo */
    fake_log_clear();
    int64_t t0 = fake_ms;
    fake_face_set(1, 0, 100, 80, 120, 120, "persona0");
    fake_run(3000);
    int seen = events_since(t0, EV_FACE_SEEN, 0);
    CHECK(seen >= 3 && seen <= 4, "EV_FACE_SEEN(0) uno por segundo: %d en 3 s", seen);
    CHECK(k210_face_replies() >= 14, "respuestas de cara recibidas: %u", (unsigned)k210_face_replies());
    CHECK(fake_log_contains("perception: cara conocida id=0 \"persona0\" x=100 y=80 w=120 h=120"), "el cambio se registra con los campos");
    CHECK(fake_log_contains("RX EXTENDIDO n=131: 55 aa ff 7c 00 0a"), "la primera respuesta va en crudo, completa (131 bytes)");
    CHECK(!fake_log_contains("INCOMPLETO") && !fake_log_contains("perception: frame"), "sin INCOMPLETO ni frames desconocidos");
    int s = alma_slot_of(app_alma(), 0);
    CHECK(s >= 0 && app_alma()->person[s].present && app_alma()->person[s].facing, "persona 0 presente y de frente (centro x = 160)");

    /* expresión (robot, 2026-10-30): el modo 4 deja los ojos fijos; para una animación, 38 01 y con su 08 00, 38 04 */
    {
        static const uint8_t M1[] = {0x55, 0xAA, 0x38, 0x01, 0x00, 0x00, 0x38}, M4b[] = {0x55, 0xAA, 0x38, 0x04, 0x00, 0x00, 0x3B};
        int tx0 = fake_n_tx, polls = fake_face_polls;
        CHECK(k210_play("stay_wink_1", NULL, 0) == 0 && k210_expressing() && tx_find(M1, sizeof M1, tx0) >= 0,
              "animación en el modo 4: antes 38 01");
        fake_run(500);
        CHECK(fake_face_polls == polls, "mostrando la animación no se piden caras");
        int tx1 = fake_n_tx;
        fake_k210_small(0, 0x08, 0, 0, 0);
        fake_run(50);
        CHECK(!k210_expressing() && tx_find(M4b, sizeof M4b, tx1) >= 0, "08 00: de vuelta al modo 4");
        /* .avi que no está en la SD: 08 00 enseguida → la cara de respaldo */
        k210_set_fallback("mood_happy", "mood_happy_000");
        k210_play("no_existe", NULL, 0);
        fake_k210_small(0, 0x08, 0, 0, 0);
        fake_run(20);
        CHECK(fake_log_contains("no está en la SD; va la cara de la conducta (mood_happy)") && k210_expressing(),
              "08 00 a los pocos ms: se pone la cara de respaldo y sigue en el modo 1");
        fake_run(1000);
        fake_k210_small(0, 0x08, 0, 0, 0);
        fake_run(600);
        CHECK(!k210_expressing(), "al terminar la de respaldo, modo 4 otra vez");
        /* una que reemplaza a otra en pantalla: el 08 00 de la reemplazada no es "no está" (2026-11-03) */
        fake_log_clear();
        k210_play("primera", NULL, 0);
        fake_run(300);
        k210_set_fallback("mood_happy", NULL);
        int tr = fake_n_tx;
        k210_play("segunda", NULL, 0);
        fake_run(10);
        fake_k210_small(0, 0x08, 0, 0, 0);   /* el de "primera" */
        fake_run(50);
        CHECK(!fake_log_contains("no está en la SD") && !tx_has_text(tr, "mood_happy") && k210_expressing(),
              "el 08 00 de la reemplazada no pone la cara de respaldo; sigue la nueva");
        fake_run(1000);
        fake_k210_small(0, 0x08, 0, 0, 0);   /* el de "segunda" */
        fake_run(600);
        CHECK(!k210_expressing(), "con el 08 00 de la nueva, modo 4 otra vez");
        /* reemplaza a otra y la nueva no está: el segundo 08 00 enseguida sí pone la de respaldo */
        k210_play("primera", NULL, 0);
        fake_run(300);
        k210_set_fallback("mood_happy", NULL);
        k210_play("no_existe", NULL, 0);
        fake_run(10);
        fake_k210_small(0, 0x08, 0, 0, 0);
        fake_run(10);
        fake_k210_small(0, 0x08, 0, 0, 0);
        fake_run(20);
        CHECK(fake_log_contains("no está en la SD; va la cara de la conducta (mood_happy)"), "reemplaza y no está: la de respaldo");
        fake_run(1000);
        fake_k210_small(0, 0x08, 0, 0, 0);
        fake_run(600);
    }
    /* revisión de la SD (tecla V, 2026-11-03): sin forma de listarla, se pide cada .avi y se mide su 08 00 */
    {
        static const char *const N[] = {"rev_si", "rev_no", "rev_si2", "rev_si"};
        fake_log_clear();
        CHECK(k210_check_avis(N, 4) == 3 && k210_checking(), "revisión de la SD: 3 animaciones (sin la repetida)");
        int t0 = fake_n_tx;
        CHECK(k210_play("stay_wink_1", NULL, 0) == 0 && !tx_has_text(t0, "stay_wink_1"), "revisando, las caras de las conductas esperan");
        fake_run(600);
        CHECK(tx_has_text(t0, "rev_si"), "revisión: la primera se pide a los 0.5 s");
        fake_run(400);
        fake_run(10);
        fake_k210_small(0, 0x08, 0, 0, 0);   /* rev_si, reemplazada */
        fake_run(10);
        fake_k210_small(0, 0x08, 0, 0, 0);   /* rev_no: 08 00 enseguida */
        fake_run(400);
        fake_run(400);
        CHECK(fake_log_contains("primera vuelta, 1 de 3 sospechosas"), "revisión: primera vuelta con una sospechosa (la reemplazada no cuenta)");
        int t1 = fake_n_tx;
        fake_k210_small(0, 0x08, 0, 0, 0);   /* termina rev_si2 (sí está) */
        fake_run(19000);
        CHECK(!tx_has_text(t1, "rev_no"), "segunda vuelta: antes, 20 s para que termine la que quedó");
        fake_run(900);
        CHECK(tx_has_text(t1, "rev_no"), "segunda vuelta: la sospechosa sola");
        fake_run(20);
        fake_k210_small(0, 0x08, 0, 0, 0);
        fake_run(1600);
        CHECK(fake_log_contains("revisión de la SD: rev_no no está") && fake_log_contains("terminada; 1 de 3 animaciones no están")
              && !fake_log_contains("rev_si no está") && !k210_checking(), "revisión: solo rev_no falta");
        CHECK(k210_play("stay_wink_1", NULL, 0) == 0 && k210_expressing(), "después de la revisión, las caras otra vez");
        fake_k210_small(0, 0x08, 0, 0, 0);
        fake_run(600);
    }

    /* el K210 alterna 0 y 255 para la misma cara (robot, 2026-10-30): en el mismo lugar sigue siendo la persona 0 */
    int64_t ts = fake_ms;
    fake_face_set(1, PERC_FACE_UNKNOWN_ID, 105, 85, 115, 118, "");
    fake_run(2000);
    CHECK(events_since(ts, EV_FACE_UNKNOWN, -9) == 0 && events_since(ts, EV_FACE_SEEN, 0) >= 1,
          "desconocida en el lugar de la 0, recién vista: se toma como la 0");

    /* desconocida: EV_FACE_UNKNOWN; la 0 se pierde 5 s después de su última vez */
    int64_t t1 = fake_ms;
    fake_face_set(1, PERC_FACE_UNKNOWN_ID, 10, 60, 50, 50, "");
    fake_run(2000);
    CHECK(events_since(t1, EV_FACE_UNKNOWN, -9) >= 2 && events_since(t1, EV_FACE_SEEN, -9) == 0, "cara 255 → EV_FACE_UNKNOWN, no EV_FACE_SEEN");
    CHECK(fake_log_contains("perception: cara desconocida id=255"), "cambio a desconocida registrado");
    fake_face_set(0, 0, 0, 0, 0, 0, "");
    fake_run(3500);
    CHECK(fake_log_contains("perception: sin cara"), "\"hay cara\" = 0 → sin cara");
    CHECK(events_since(t0, EV_FACE_LOST, 0) == 1 && fake_log_contains("perception: cara 0 perdida"), "EV_FACE_LOST(0) una vez, a los 5 s");
    CHECK(!app_alma()->person[s].present, "persona 0 ya no está presente");

    /* el K210 deja de contestar: la persona se pierde igual */
    int64_t t2 = fake_ms;
    fake_face_set(1, 3, 100, 80, 60, 60, "");
    fake_run(1000);
    fake_face_set(-1, 0, 0, 0, 0, 0, NULL);
    fake_run(6000);
    CHECK(events_since(t2, EV_FACE_SEEN, 3) >= 1 && events_since(t2, EV_FACE_LOST, 3) == 1, "sin respuestas, EV_FACE_LOST(3) igual");

    /* sondeo apagado */
    k210_face_poll_ms = 0;
    p0 = fake_face_polls;
    fake_run(1000);
    CHECK(fake_face_polls == p0, "k210_face_poll_ms = 0: no se pide la cara");
    k210_face_poll_ms = 200;

    /* parser: lo que no es la respuesta de cara se rechaza */
    perc_face f;
    uint8_t sm[K210_SMALL_LEN];
    k210_small(sm, 0x0A, 0, 0, 0);
    static const uint8_t SHORT[] = {0x55, 0xAA, 0xFF, 0x7C, 0x00, 0x0A, 0x82, 1, 2, 3};
    CHECK(perception_parse_face(sm, sizeof sm, &f) == -1 && perception_parse_face(SHORT, sizeof SHORT, &f) == -1, "corto o truncado: rechazado");

    /* el extendido de versión medido (sin byte final) ya no se come el frame siguiente */
    fake_log_clear();
    uint32_t u0 = perception_unknown_frames();
    static const uint8_t VER_08[] = {0x55, 0xAA, 0xFF, 0x06, 0x00, 0x69, 0x6D, 0x32, 0x2E, 0x39, 0x2E, 0x31, 0x00,
                                     0x55, 0xAA, 0x08, 0x00, 0x00, 0x00, 0x07};
    fake_k210_send(0, VER_08, sizeof VER_08);
    fake_run(100);
    CHECK(fake_log_contains("RX EXTENDIDO n=13") && fake_log_contains("RX CORTO n=7: 55 aa 08") && !fake_log_contains("INCOMPLETO")
          && perception_unknown_frames() == u0, "versión (13 bytes) y 0x08 seguido, los dos enteros");
}

/* ---- 7c. batería: fórmula y tablas del original (02 [BOBBY-ARTE]) ---- */
static void test_battery(void)
{
    CHECK(battery_mv(2208, 1) == 4286 && battery_pct(4286, 1) == 100, "medido [ALMA-1B]: 2208 mV en el pin con USB → 4286 mV, 100 %%");
    static const struct { int mv, chg; float pct; } P[] = {
        {3529, 0, 20}, {3589, 0, 40}, {3669, 0, 60}, {3999, 0, 100}, {3559, 0, 30}, {3400, 0, 0}, {3000, 0, 0}, {4300, 0, 100},
        {3629, 1, 20}, {3689, 1, 40}, {3769, 1, 60}, {4099, 1, 100}, {3500, 1, 0}};
    int bad = 0;
    for (size_t i = 0; i < sizeof P / sizeof *P; i++)
        if (fabsf(battery_pct(P[i].mv, P[i].chg) - P[i].pct) > 0.01f) {
            bad++;
            printf("  %d mV cargando=%d: %.2f %% (esperado %.0f)\n", P[i].mv, P[i].chg, battery_pct(P[i].mv, P[i].chg), P[i].pct);
        }
    CHECK(bad == 0, "tablas sin cargar y cargando, tramos lineales: %d fuera", bad);
    CHECK(battery_mv(1740, 0) == 3530 && battery_pct(battery_mv(1740, 0), 0) > 20, "sin cargar: 2·mV + 50");
}

/* ---- 7d. registro de cara (03, HALLAZGOS §7) y regla del borde ---- */
static void keys(const char *s) { for (; *s; s++) app_console_key(*s); }

static void test_face_register(void)
{
    static const uint8_t M4[] = {0x55, 0xAA, 0x38, 0x04, 0x00, 0x00, 0x3B}, M1[] = {0x55, 0xAA, 0x38, 0x01, 0x00, 0x00, 0x38};
    static const uint8_t ANA[] = {0x55, 0xAA, 0xFF, 0x04, 0x00, 0x0E, 0x10, 0x41, 0x6E, 0x61, 0x00, 0xA0};
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    int t0 = fake_n_tx;
    keys("RAna\r");
    int i4 = tx_find(M4, sizeof M4, t0);
    CHECK(i4 >= 0 && k210_face_register_state() == K210_REG_RUNNING, "R Ana Enter: 38 04 y registro en curso");
    int polls = fake_face_polls;
    fake_run(1400);
    CHECK(tx_find(ANA, sizeof ANA, t0) < 0, "antes de 1500 ms no se manda el nombre");
    fake_run(200);
    int ie = tx_find(ANA, sizeof ANA, t0);
    CHECK(ie > i4 && fake_txs[ie].t - fake_txs[i4].t >= 1500, "0E con \"Ana\" + 00, CRC A0, a los %lld ms",
          ie >= 0 ? (long long)(fake_txs[ie].t - fake_txs[i4].t) : -1LL);
    CHECK(fake_face_polls == polls, "sin sondeo de caras mientras espera el 0F (%d)", fake_face_polls - polls);
    fake_run(400);
    int i1 = tx_find(M1, sizeof M1, ie > 0 ? ie : t0);
    CHECK(k210_face_register_state() == K210_REG_OK && i1 > ie, "0F 01 → registrada y 38 01");
    fake_run(3500);
    CHECK(fake_face_polls > polls, "el sondeo vuelve al terminar (tras los 3 s del modo 1)");
    CHECK(fake_log_contains("registro de cara \"Ana\": REGISTRADA (0F 01)"), "resultado en el registro");

    fake_reg_reply = 2;
    CHECK(k210_face_register("Luis") == 0, "segundo registro");
    fake_run(2500);
    CHECK(k210_face_register_state() == K210_REG_FAILED, "0F 02 → falló");
    fake_reg_reply = -1;
    t0 = fake_n_tx;
    CHECK(k210_face_register("Pia") == 0, "tercer registro");
    fake_run(6400);
    CHECK(k210_face_register_state() == K210_REG_RUNNING, "a los 6.4 s todavía espera (1.5 + 5.1 s)");
    fake_run(400);
    CHECK(k210_face_register_state() == K210_REG_TIMEOUT && tx_find(M1, sizeof M1, t0) >= 0, "sin 0F en 5 s → TIMEOUT y 38 01");

    CHECK(k210_face_register("Ana Maria") == -1 && k210_face_register("") == -1 && k210_face_register("abcdefghijklmnopqrstuvwxyz0123456") == -1,
          "nombres inválidos rechazados (espacio, vacío, 33 caracteres)");
    t0 = fake_n_tx;
    keys("RBe\x1B");
    CHECK(tx_find(M4, sizeof M4, t0) < 0 && fake_log_contains("registro de cara: cancelado"), "Esc cancela sin mandar nada");
    boot_app(K_SILENT);
    CHECK(k210_face_register("Ana") == -1, "con el K210 sin arrancar, se rechaza");
}

/* .mot de la ejecución ex[i] del reflejo ("-" si va sin movimiento) */
static const char *reflex_mot(int i)
{
    if (i < 0 || ex[i].e.option < 0) return "-";
    return app_alma()->cat->b[ex[i].e.behavior].opt[ex[i].e.option].mot[0];
}

/* espera a que termine el movimiento en curso y los 500 ms de la máquina de estados de los bordes */
static void settle(void)
{
    for (int k = 0; k < 3000 && motion_active(); k++) fake_run(10);
    fake_run(700);
}

static void floor_all(int v) { for (int f = 0; f < 2; f++) fake_sensors.floor[f][0] = fake_sensors.floor[f][1] = v; }

static void test_floor_edge(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;   /* fuera de la base: si no, el núcleo nunca mueve servos (R14) */
    floor_all(1);
    fake_run(800);   /* si venía de la base: las patas vuelven a tener corriente y los pies esperan 600 ms */
    int64_t t0 = fake_ms;
    CHECK(!perception_forward_blocked() && !perception_backward_blocked(), "piso en los 4 sensores: libre");

    /* quieto, los dos pies apoyados: cualquier sensor sin piso es posible caída */
    fake_sensors.floor[HAL_FOOT_L][HAL_FLOOR_FRONT] = 0;
    fake_run(100);
    CHECK(perception_forward_blocked() && !perception_backward_blocked() && events_since(t0, EV_CLIFF, -9) == 1,
          "quieto, izquierdo sin piso adelante: EV_CLIFF, no avanza (sí puede retroceder)");
    CHECK(fake_log_contains("perception: borde adelante"), "registrado como borde adelante");
    fake_run(500);
    CHECK(events_since(t0, EV_CLIFF, -9) == 1, "un solo EV_CLIFF mientras dure");
    CHECK(fake_log_contains("motion: explore_back_away1"), "borde adelante: el reflejo camina hacia atrás (explore_back_away1)");
    floor_all(1);
    fake_run(4000);   /* que termine de retroceder: caminando, el pie en el aire no cuenta */
    fake_sensors.floor[HAL_FOOT_R][HAL_FLOOR_REAR] = 0;
    fake_run(100);
    CHECK(perception_backward_blocked() && !perception_forward_blocked() && events_since(t0, EV_CLIFF, -9) == 2,
          "quieto, derecho sin piso atrás: EV_CLIFF, no retrocede");
    floor_all(0);
    fake_run(100);
    floor_all(1);
    fake_run(100);
    int64_t t1 = fake_ms;
    floor_all(0);
    fake_run(100);
    CHECK(events_since(t1, EV_CLIFF, -9) == 0 && !perception_forward_blocked(), "ninguno ve piso (lo levantaron): no es borde");

    /* de frente: el pie en el aire no cuenta; al apoyarse, su sensor de adelante sí */
    floor_all(1);
    settle();
    int64_t t2 = fake_ms;
    perception_set_gait(1, HAL_FOOT_R);
    fake_sensors.floor[HAL_FOOT_R][HAL_FLOOR_FRONT] = fake_sensors.floor[HAL_FOOT_R][HAL_FLOOR_REAR] = 0;   /* en el aire */
    fake_run(100);
    CHECK(events_since(t2, EV_CLIFF, -9) == 0, "de frente, el pie derecho en el aire: sus sensores no cuentan");
    fake_sensors.floor[HAL_FOOT_R][HAL_FLOOR_REAR] = 1;   /* se apoya con el talón; la punta queda sin piso */
    perception_set_gait(1, -1);
    fake_run(100);
    CHECK(events_since(t2, EV_CLIFF, -9) == 1 && perception_forward_blocked(), "derecho apoyado sin piso adelante: se va a caer, EV_CLIFF");
    floor_all(1);
    perception_set_gait(0, -1);
    settle();
    perception_set_gait(1, HAL_FOOT_L);
    fake_run(100);
    int64_t t3 = fake_ms;
    perception_set_gait(1, -1);
    fake_sensors.floor[HAL_FOOT_L][HAL_FLOOR_REAR] = 0;
    fake_run(100);
    CHECK(events_since(t3, EV_CLIFF, -9) == 0, "de frente, izquierdo sin piso atrás: no cuenta para avanzar");
    fake_sensors.floor[HAL_FOOT_L][HAL_FLOOR_REAR] = 1;
    fake_sensors.floor[HAL_FOOT_L][HAL_FLOOR_FRONT] = 0;
    fake_run(100);
    CHECK(events_since(t3, EV_CLIFF, -9) == 1, "de frente, izquierdo sin piso adelante: EV_CLIFF");

    /* reversa: mismo patrón con los sensores de atrás, y el reflejo no retrocede */
    floor_all(1);
    perception_set_gait(0, -1);
    settle();
    perception_set_gait(-1, HAL_FOOT_L);
    fake_run(100);
    int64_t t4 = fake_ms;
    int e0 = n_ex;
    perception_set_gait(-1, -1);
    fake_sensors.floor[HAL_FOOT_L][HAL_FLOOR_REAR] = 0;
    fake_run(100);
    CHECK(events_since(t4, EV_CLIFF, -9) == 1 && perception_backward_blocked(), "reversa, izquierdo sin piso atrás: EV_CLIFF, no retrocede");
    int ix = -1;
    for (int i = e0; i < n_ex; i++) if (ex[i].e.kind == RUN_REFLEX) ix = i;
    CHECK(ix >= 0 && strcmp(reflex_mot(ix), "explore_foward1") == 0, "borde atrás: el reflejo camina hacia adelante (%s)", reflex_mot(ix));
    perception_set_gait(0, -1);
    floor_all(1);
    fake_run(20000);   /* que termine el reflejo */
    int e1 = n_ex;
    fake_sensors.floor[HAL_FOOT_R][HAL_FLOOR_FRONT] = 0;
    fake_run(100);
    ix = -1;
    for (int i = e1; i < n_ex; i++) if (ex[i].e.kind == RUN_REFLEX) ix = i;
    CHECK(ix >= 0 && strcmp(reflex_mot(ix), "explore_back_away1") == 0, "borde adelante: el reflejo camina hacia atrás (%s)", reflex_mot(ix));

    /* como en el robot: el pie sale de lado poco a poco; primero la punta (borde adelante), luego el talón: entonces
       es un pie entero en el aire y se avisa otra vez, con el paso de lado */
    floor_all(1);
    fake_run(20000);
    int e3 = n_ex;
    int64_t t6 = fake_ms;
    fake_sensors.floor[HAL_FOOT_R][HAL_FLOOR_FRONT] = 0;
    fake_run(100);
    fake_sensors.floor[HAL_FOOT_R][HAL_FLOOR_REAR] = 0;
    fake_run(100);
    CHECK(events_since(t6, EV_CLIFF, -9) == 1, "a media retirada no se dispara otro reflejo");
    for (int k = 0; k < 600 && events_since(t6, EV_CLIFF, -9) < 2; k++) fake_run(10);   /* termina, 0.5 s, se reevalúa */
    ix = -1;
    for (int i = e3; i < n_ex; i++) if (ex[i].e.kind == RUN_REFLEX) ix = i;
    CHECK(events_since(t6, EV_CLIFF, -9) == 2 && ix >= 0 && strcmp(reflex_mot(ix), "cliff_R") == 0,
          "punta y luego talón del pie derecho: al terminar y reevaluar, segundo EV_CLIFF y %s", reflex_mot(ix));

    /* el ciclo de hoy en el robot: el paso de lado inclina el pie y sus sensores dejan de ver la mesa. Durante el
       movimiento no se dispara otro; al terminar, 0.5 s quieto y se evalúa: con piso, nada más */
    fake_run(20);   /* que arranque el paso de lado (el aviso que lo disparó queda antes de la ventana) */
    int64_t t7 = fake_ms;
    for (int k = 0; k < 150; k++) {   /* 1.5 s de sensores que parpadean a media maniobra */
        fake_sensors.floor[HAL_FOOT_L][HAL_FLOOR_FRONT] = k % 20 < 10 ? 0 : 1;
        fake_run(10);
    }
    CHECK(events_since(t7, EV_CLIFF, -9) == 0 && motion_active(), "a media maniobra, los sensores que parpadean no reinician el reflejo (%d eventos, motion %d)", events_since(t7, EV_CLIFF, -9), motion_active());
    floor_all(1);
    for (int k = 0; k < 3000 && motion_active(); k++) fake_run(10);
    int64_t t8 = fake_ms;
    fake_run(400);
    CHECK(events_since(t8, EV_CLIFF, -9) == 0, "terminado, con piso: no hay otro reflejo");
    fake_sensors.floor[HAL_FOOT_L][HAL_FLOOR_FRONT] = 0;   /* sigue el borde después de la espera */
    fake_run(300);
    CHECK(events_since(t8, EV_CLIFF, -9) == 1, "si tras la espera de 0.5 s sigue el borde: un solo EV_CLIFF nuevo");

    /* un pie entero en el aire, el otro apoyado: de lado, hacia el pie apoyado (dueño, 2026-10-30) */
    for (int f = 0; f < 2; f++) {
        floor_all(1);
        fake_run(20000);
        settle();
        int e2 = n_ex;
        int64_t t5 = fake_ms;
        fake_sensors.floor[f][HAL_FLOOR_FRONT] = fake_sensors.floor[f][HAL_FLOOR_REAR] = 0;
        fake_run(100);
        ix = -1;
        for (int i = e2; i < n_ex; i++) if (ex[i].e.kind == RUN_REFLEX) ix = i;
        CHECK(events_since(t5, EV_CLIFF, -9) == 1 && ix >= 0 && strcmp(reflex_mot(ix), f == HAL_FOOT_L ? "cliff_L" : "cliff_R") == 0,
              "pie %s en el aire: EV_CLIFF y %s", f == HAL_FOOT_L ? "izquierdo" : "derecho", reflex_mot(ix));
        CHECK(fake_log_contains(f == HAL_FOOT_L ? "borde bajo el pie izquierdo" : "borde bajo el pie derecho"), "registrado con el pie");
    }
    floor_all(1);
    fake_run(20000);
    floor_all(-1);
    fake_run(100);
    CHECK(!perception_forward_blocked() && !perception_backward_blocked(), "sin dato: no bloquea");
}

/* ---- 7e. marcha y bordes: la primitiva se detiene con borde hacia donde va (regla del dueño) ---- */
static int walk(const char *mot, int ms)
{
    alma_motion_opt o;
    memset(&o, 0, sizeof o);
    o.n = 1;
    snprintf(o.mot[0], sizeof o.mot[0], "%s", mot);
    if (motion_play(&o, 0, 0) != MOTION_OK) return -1;
    for (int t = 0; t < ms && motion_active(); t++) {
        fake_ms++;
        if (fake_ms % F2_MOTION_STEP_MS == 0) { perception_poll_sensors(NULL); motion_step(); }
    }
    return motion_active();
}

/* gestos (dueño, 2026-11-02: saludarla con la tijera): la tecla T pone el modo 3 (38 03) 20 s; cada 3F se registra
   aunque no se haya pedido; al final, los ojos y el modo 1 */
static int sent_38(int from, int mode)
{
    for (int i = from; i < fake_n_tx && i < FAKE_TX_MAX; i++)
        if (fake_txs[i].n >= 7 && fake_txs[i].b[2] == 0x38 && fake_txs[i].b[3] == mode) return 1;
    return 0;
}
static void test_gestures(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_run(3000);
    int t0 = fake_n_tx, last = -9;
    uint32_t g0 = perception_gestures(NULL);
    app_console_key('T');
    CHECK(k210_gesture_probing() && sent_38(t0, 3), "T: modo 3 (38 03), el de piedra-papel-tijera");
    fake_run(2500);
    fake_log_clear();
    fake_k210_small(0, 0x3F, 2, 150, 90);   /* el K210 manda solo lo que ve */
    fake_run(100);
    CHECK(perception_gestures(&last) == g0 + 1 && last == 2 && fake_log_contains("gesto: tijera (clase 2, x 150, y 90)"),
          "3F 02: tijera registrada");
    CHECK(!fake_log_contains("frame desconocido"), "3F ya no sale como desconocido");
    int t1 = fake_n_tx;
    fake_run(18000);
    CHECK(!k210_gesture_probing() && sent_38(t1, 1) && fake_log_contains("gesto: fin de la prueba"), "a los 20 s: modo 1 y los ojos");
    fake_k210_small(0, 0x3F, 0, 10, 20);    /* aunque no se haya pedido, se registra */
    fake_run(100);
    CHECK(perception_gestures(&last) == g0 + 2 && last == 0 && fake_log_contains("gesto: papel"), "3F sin pedirlo: registrado");
}

/* depuración sin el USB (dueño, 2026-11-02): teclas y registro por Wi-Fi */
static void test_remote_debug(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    static char rep[256], out[UPLINK_MAX];
    CHECK(boot_rlog_was, "al arrancar, el registro por Wi-Fi se prende solo");
    fake_sensors.on_charger = 0; fake_sensors.on_usb = 0;
    fake_run(1000);
    while (api_link_take(out, sizeof out) > 0) {}
    api_link_msg("{\"t\":\"rlog\",\"on\":true}", rep, sizeof rep);
    api_link_msg("{\"t\":\"key\",\"k\":\"C\"}", rep, sizeof rep);
    CHECK(home_active(), "tecla C por Wi-Fi: vuelve a la base");
    api_link_msg("{\"t\":\"key\",\"k\":\"0\"}", rep, sizeof rep);
    CHECK(!home_active(), "tecla 0 por Wi-Fi: PARO");
    api_link_msg("{\"t\":\"key\",\"k\":\"R\"}", rep, sizeof rep);
    CHECK(fake_log_contains("enlace: tecla por Wi-Fi rechazada"), "R (registrar cara) no se acepta por Wi-Fi");
    hal_log("prueba: \"comillas\" y acentos ñ");
    int got = 0, ok = 1;
    long n;
    while ((n = api_link_take(out, sizeof out)) > 0) {
        if (strncmp(out, "{\"t\":\"log\"", 10)) continue;
        cJSON *j = cJSON_Parse(out);
        ok &= j != NULL;
        const cJSON *sv = cJSON_GetObjectItemCaseSensitive(j, "s");
        if (cJSON_IsString(sv) && strstr(sv->valuestring, "casa: volver a la Home Station (tecla C)")) got |= 1;
        if (cJSON_IsString(sv) && strstr(sv->valuestring, "prueba: \"comillas\" y acentos ñ")) got |= 2;
        cJSON_Delete(j);
    }
    CHECK(ok && got == 3, "el registro llega al servidor como JSON válido (%d)", got);
    api_link_msg("{\"t\":\"rlog\",\"on\":false}", rep, sizeof rep);
    hal_log("ya no");
    CHECK(api_link_take(out, sizeof out) == 0 || strncmp(out, "{\"t\":\"log\"", 10) != 0, "apagado: ya no manda registro");
}

/* cerca de la base, centrarla como mucho 2 giros (medido 2026-11-02: oscilaba 2 min a izquierda y derecha) */
static void test_home_no_oscillation(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0; fake_sensors.on_usb = 0;
    fake_run(6000);
    ((alma_t *)app_alma())->pause_until_s = 1e12;
    fake_base_set(1, 40, 70);          /* cerca y muy a un lado: no se centra nunca */
    fake_sensors.tof_mm = 250;
    home_start("prueba oscilación");
    int t0 = fake_log_count("motion: explore_turn_"), f0 = fake_log_count("motion: explore_foward1");
    for (int i = 0; i < 200; i++) fake_run(100);
    int turns = fake_log_count("motion: explore_turn_") - t0, fw = fake_log_count("motion: explore_foward1") - f0;
    CHECK(home_get() == HOME_APPROACH && fw > 0 && turns <= 4, "cerca y chueca: como mucho 3 medios giros (más el de buscarla) y luego avanza (%d giros, %d pasos)", turns, fw);
    CHECK(fake_log_contains("motion: explore_turn_right1_half"), "cerca: centra con medio giro");
    home_stop("fin");
    fake_sensors.tof_mm = -1;
    /* medio giro: el mismo .mot con la mitad de los ciclos (dueño, 2026-11-02: 2 pasos en lugar de 4) */
    static mot_frame full[MOTION_MAX_FRAMES], half[MOTION_MAX_FRAMES];
    int nf = motion_load("explore_turn_left1", full, MOTION_MAX_FRAMES), nh = motion_load("explore_turn_left1_half", half, MOTION_MAX_FRAMES);
    int halved = nf > 0 && nf == nh;
    for (int k = 0; k < nf && halved; k++)
        halved = gait_supported(full[k].mode) ? half[k].steps10 == full[k].steps10 / 2 && half[k].gp[0] == half[k].steps10 : half[k].steps10 == full[k].steps10;
    CHECK(halved, "explore_turn_left1_half: la mitad de los ciclos en la primitiva (%d cuadros)", nh);
    /* paso alto para la rampa (dueño, 2026-11-03): el balanceo de los pies de 10 a 15; lo demás igual; R10 lo acepta */
    static mot_frame hi[MOTION_MAX_FRAMES];
    nf = motion_load("explore_back_away1", full, MOTION_MAX_FRAMES);
    int nhi = motion_load("explore_back_away1_alto", hi, MOTION_MAX_FRAMES), walks = 0, ok_hi = nf > 0 && nf == nhi;
    for (int k = 0; k < nf && ok_hi; k++) {
        if (full[k].mode == 1) { walks++; ok_hi = full[k].gp[6] == 10 && hi[k].gp[6] == 15 && hi[k].gp[5] == full[k].gp[5]; }
        else ok_hi = !memcmp(&hi[k], &full[k], sizeof hi[k]);
    }
    CHECK(ok_hi && walks >= 1, "explore_back_away1_alto: el pie sube 15 en vez de 10 (%d pasos)", walks);
    alma_motion_opt oa;
    memset(&oa, 0, sizeof oa);
    oa.n = 1;
    oa.hhmm0 = oa.hhmm1 = -1;
    snprintf(oa.mot[0], sizeof oa.mot[0], "explore_back_away1_alto");
    CHECK(motion_play(&oa, 0, 0) == MOTION_OK, "el paso alto cabe en el rango observado (R10)");
    for (int i = 0; i < 60 && motion_active(); i++) fake_run(100);
    /* subiendo de espaldas, la rampa (borde atrás) no frena los pasos (medido 2026-11-02 sin el USB) */
    fake_base_set(1, 160, 130);
    home_start("prueba rampa");
    for (int i = 0; i < 300 && home_get() != HOME_DOCK; i++) { fake_yaw += 3; fake_run(100); }
    fake_sensors.floor[HAL_FOOT_L][HAL_FLOOR_REAR] = fake_sensors.floor[HAL_FOOT_R][HAL_FLOOR_REAR] = 0;
    fake_run(300);
    CHECK(home_get() == HOME_DOCK && !perception_backward_blocked(), "subiendo: la rampa no frena la marcha hacia atrás");
    home_stop("fin");
    fake_run(300);
    CHECK(perception_backward_blocked(), "fuera de la base, un borde atrás sí frena");
    for (int f = 0; f < 2; f++) fake_sensors.floor[f][0] = fake_sensors.floor[f][1] = 1;
    fake_run(3000);
}

/* caras de festividades (dueño, 2026-11-02): trozos del servidor → PSRAM → K210 → cara_ok; luego ~12 veces al día */
static int outbox_has(const char *sub);

static void b64enc(const uint8_t *in, size_t n, char *out)
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
    out[o] = 0;
}

/* ---- firmware nuevo por Wi-Fi (ota.h; dueño, 2026-11-02) ---- */
static long ota_send(const uint8_t *data, size_t n, int skip_seq, char *rep, size_t cap)
{
    static char b64[12400], msg[13000];
    long r = 0;
    int seq = 0;
    for (size_t off = 0; off < n; off += 9000, seq++) {
        size_t k = n - off < 9000 ? n - off : 9000;
        if (seq == skip_seq) continue;
        b64enc(data + off, k, b64);
        snprintf(msg, sizeof msg, "{\"t\":\"ota\",\"seq\":%d,\"last\":%s,\"b64\":\"%s\"}", seq, off + k >= n ? "true" : "false", b64);
        rep[0] = 0;
        r = api_link_msg(msg, rep, cap);
        if (strstr(rep, "ota_error")) return r;
    }
    return r;
}

static void test_ota(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    static uint8_t img[20000];
    for (size_t i = 0; i < sizeof img; i++) img[i] = (uint8_t)(i * 7 + 3);
    uint8_t sum[32];
    mbedtls_sha256(img, sizeof img, sum, 0);
    char sha[65], bad[65], msg[256], rep[512];
    for (int i = 0; i < 32; i++) snprintf(sha + 2 * i, 3, "%02x", sum[i]);
    snprintf(bad, sizeof bad, "%s", sha);
    bad[0] = bad[0] == '0' ? '1' : '0';
    snprintf(fake_ota_running, 8, "ota_1");
    snprintf(fake_ota_boot, 8, "ota_1");
    fake_ota_restarts = fake_ota_trial_flag = 0;
    /* camino feliz: verificada, sin reiniciar hasta ota_reboot */
    snprintf(msg, sizeof msg, "{\"t\":\"ota_begin\",\"size\":%u,\"sha256\":\"%s\",\"version\":\"prueba\"}", (unsigned)sizeof img, sha);
    api_link_msg(msg, rep, sizeof rep);
    CHECK(strstr(rep, "ota_ready") != NULL, "ota_begin → ota_ready (%s)", rep);
    ota_send(img, sizeof img, -1, rep, sizeof rep);
    CHECK(strstr(rep, "ota_ok") && strstr(rep, sha) && fake_ota_restarts == 0 && !strcmp(fake_ota_boot, "ota_1"),
          "3 trozos con el SHA correcto → ota_ok, sin cambiar el arranque ni reiniciar (%s)", rep);
    api_link_msg("{\"t\":\"ota_reboot\"}", rep, sizeof rep);
    CHECK(!strcmp(fake_ota_boot, "ota_0") && fake_ota_restarts == 1 && fake_ota_trial_flag, "ota_reboot: arranca ota_0, a prueba");
    /* arranque a prueba sin servidor: a los 3 min vuelve a la anterior */
    snprintf(fake_ota_running, 8, "ota_0");
    ota_init();
    fake_run(OTA_TRIAL_MS + 1000);
    CHECK(!strcmp(fake_ota_boot, "ota_1") && fake_ota_restarts == 2 && fake_log_contains("ota: 180 s sin servidor"),
          "a prueba y sin welcome en 3 min: vuelve a ota_1");
    /* con welcome se confirma y se queda */
    snprintf(fake_ota_prev, 8, "ota_1");
    fake_ota_trial_flag = 1;
    ota_init();
    api_link_msg("{\"t\":\"welcome\",\"time\":1793600000}", rep, sizeof rep);
    fake_run(OTA_TRIAL_MS + 1000);
    CHECK(!fake_ota_trial_flag && fake_ota_restarts == 2, "a prueba con welcome: confirmada, no vuelve");
    /* SHA equivocado: error y el arranque no se toca */
    snprintf(fake_ota_running, 8, "ota_1");
    snprintf(fake_ota_boot, 8, "ota_1");
    snprintf(msg, sizeof msg, "{\"t\":\"ota_begin\",\"size\":%u,\"sha256\":\"%s\"}", (unsigned)sizeof img, bad);
    api_link_msg(msg, rep, sizeof rep);
    ota_send(img, sizeof img, -1, rep, sizeof rep);
    CHECK(strstr(rep, "ota_error") != NULL, "SHA-256 distinto → ota_error (%s)", rep);
    api_link_msg("{\"t\":\"ota_reboot\"}", rep, sizeof rep);
    CHECK(!strcmp(fake_ota_boot, "ota_1") && fake_ota_restarts == 2 && strstr(rep, "ota_error"), "sin firmware verificado, ota_reboot no cambia nada");
    /* trozo fuera de orden */
    snprintf(msg, sizeof msg, "{\"t\":\"ota_begin\",\"size\":%u,\"sha256\":\"%s\"}", (unsigned)sizeof img, sha);
    api_link_msg(msg, rep, sizeof rep);
    ota_send(img, sizeof img, 1, rep, sizeof rep);
    CHECK(strstr(rep, "ota_error") && strstr(rep, "fuera de orden") && !ota_receiving(), "trozo fuera de orden → ota_error (%s)", rep);
    /* se corta el enlace a la mitad */
    api_link_msg(msg, rep, sizeof rep);
    {
        static char b64[12400], m2[13000];
        b64enc(img, 9000, b64);
        snprintf(m2, sizeof m2, "{\"t\":\"ota\",\"seq\":0,\"last\":false,\"b64\":\"%s\"}", b64);
        api_link_msg(m2, rep, sizeof rep);
    }
    CHECK(ota_receiving(), "el primer trozo llegó: sigue recibiendo");
    app_set_link(0);
    CHECK(!ota_receiving() && fake_log_contains("ota: se cortó el enlace"), "sin enlace a media recepción: se aborta");
    app_set_link(1);
}

static void test_fiesta(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;
    fake_run(2000);
    ((alma_t *)app_alma())->pause_until_s = 1e12;   /* sin conductas propias: está tranquila */
    static uint8_t cara[20000];
    static char b64[12400], msg[13000], rep[256];
    for (size_t i = 0; i < sizeof cara; i++) cara[i] = (uint8_t)(i * 7 + 3);
    fake_file_ack_cmd = 0x21;
    fake_file_rx_n = 0;
    outbox_clear();
    int seq = 0;
    for (size_t off = 0; off < sizeof cara; off += 9000, seq++) {
        size_t k = sizeof cara - off < 9000 ? sizeof cara - off : 9000;
        b64enc(cara + off, k, b64);
        snprintf(msg, sizeof msg, "{\"t\":\"cara\",\"nombre\":\"san_valentin\",\"seq\":%d,\"last\":%s,\"b64\":\"%s\"}", seq,
                 off + k >= sizeof cara ? "true" : "false", b64);
        for (char *c = msg; *c; c++) if (*c == '\"') *c = '"';
        api_link_msg(msg, rep, sizeof rep);
    }
    api_link_msg("{\"t\":\"fiesta\",\"nombre\":\"san_valentin\"}", rep, sizeof rep);
    for (int i = 0; i < 100 && !fake_log_contains("ya está en la SD"); i++) fake_run(100);
    CHECK(fake_file_rx_n == sizeof cara && !memcmp(fake_file_rx, cara, sizeof cara) && outbox_has("{\"t\":\"cara_ok\",\"nombre\":\"san_valentin\"}"),
          "la cara llega en 3 trozos, se sube al K210 y contesta cara_ok");
    for (int m = 0; m < 12 * 60; m++) fake_run(60000);   /* 12 h de día */
    int n = fake_log_count("fiesta: san_valentin (");
    CHECK(n >= 8 && n <= 12 && fiesta_plays() == n, "en el día sale varias veces, como mucho 12 (%d)", n);
    CHECK(fake_log_contains("fiesta: san_valentin (1/12)"), "la registra con su cuenta");
    /* un trozo fuera de orden: cara_error y no se sube */
    outbox_clear();
    api_link_msg("{\"t\":\"cara\",\"nombre\":\"reyes\",\"seq\":1,\"last\":true,\"b64\":\"AAAA\"}", rep, sizeof rep);
    CHECK(outbox_has("{\"t\":\"cara_error\",\"nombre\":\"reyes\"}"), "trozo fuera de orden: cara_error");
    /* sin fiesta: ya no sale; de noche tampoco */
    api_link_msg("{\"t\":\"fiesta\",\"nombre\":\"\"}", rep, sizeof rep);
    int n0 = fake_log_count("fiesta: san_valentin (");
    for (int m = 0; m < 180; m++) fake_run(60000);
    CHECK(fake_log_count("fiesta: san_valentin (") == n0 && !*fiesta_active(), "sin fiesta: no sale");
}

/* sticker encima de la cara (dueño, 2026-11-02; [BOBBY-ARTE]): 57 "sticker.png" → 54 (acuse 55) → trozos modo 9 con
   acuse 55 = 0x400 → 56; luego 59 01 lo pone encima y 59 03 lo quita */
static int tx_small_since(int from, uint8_t cmd, int d0)
{
    for (int i = from; i < fake_n_tx && i < FAKE_TX_MAX; i++)
        if (fake_txs[i].n == K210_SMALL_LEN && fake_txs[i].b[2] == cmd && (d0 < 0 || fake_txs[i].b[3] == d0)) return i;
    return -1;
}

static void test_sticker(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_run(2000);
    int t0 = fake_n_tx;
    fake_file_rx_n = 0;
    app_console_key('K');
    for (int i = 0; i < 100 && k210_file_state_get() == K210_FILE_BUSY; i++) fake_run(50);
    size_t n;
    const uint8_t *png = hal_test_sticker(&n);
    int i57 = -1;
    for (int i = t0; i < fake_n_tx; i++) if (fake_txs[i].b[2] == 0xFF && fake_txs[i].b[5] == 0x57) { i57 = i; break; }
    int i54 = tx_small_since(t0, 0x54, -1), i56 = tx_small_since(t0, 0x56, -1), i59 = tx_small_since(t0, 0x59, 1);
    CHECK(i57 >= 0 && memcmp(fake_txs[i57].b + 7, "sticker.png", 11) == 0 && i54 > i57 && i56 > i54,
          "sticker: 57 \"sticker.png\", 54 y 56 en orden");
    CHECK(k210_file_state_get() == K210_FILE_OK && fake_file_rx_n == n && memcmp(fake_file_rx, png, n) == 0 && fake_file_bad == 0,
          "sticker: el PNG llega completo en modo 9 (%u de %u bytes)", (unsigned)fake_file_rx_n, (unsigned)n);
    fake_run(200);
    i59 = tx_small_since(t0, 0x59, 1);
    CHECK(i59 > i56, "sticker: 59 01 lo pone encima al terminar de subir");
    int t1 = fake_n_tx;
    app_console_key('U');
    CHECK(tx_small_since(t1, 0x59, 3) >= 0, "sticker: U manda 59 03 (quitarlo)");
    /* un trozo rechazado (55 ≠ 0x400) se reenvía */
    fake_file_rx_n = 0;
    fake_file_reject = 1;
    CHECK(k210_image_send("sticker.png", png, n) == 0, "sticker: segunda subida");
    for (int i = 0; i < 100 && k210_file_state_get() == K210_FILE_BUSY; i++) fake_run(50);
    CHECK(k210_file_state_get() == K210_FILE_OK && fake_log_contains("trozo en 0 rechazado; reintento 1"), "sticker: el trozo rechazado se reenvía");
    fake_file_reject = 0;
    fake_run(1000);
}

/* batería (dueño, 2026-11-02): a casa con menos de 35 %; siesta de día si está cansada y con menos de 60 %; cargada y
   viéndote, se baja sola de la base */
static void test_battery_life(void)
{
    fake_mem_ok = 0;   /* sin memoria guardada: sin el protocolo de mudanza de otras pruebas (Alma se quedaría sin turno) */
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    alma_t *a = (alma_t *)app_alma();
    a->pause_until_s = 1e12;   /* sin conductas propias: solo lo de la batería */
    /* en la Home Station no se mueve (con el USB sí, para las pruebas): moverse ahí soltaba los contactos (2026-11-03) */
    fake_sensors.on_charger = 1; fake_sensors.on_usb = 0;
    fake_sensors.soc_pct = 34;
    fake_run(3000);
    alma_motion_opt ob;
    memset(&ob, 0, sizeof ob);
    ob.n = 1;
    ob.hhmm0 = ob.hhmm1 = -1;
    snprintf(ob.mot[0], sizeof ob.mot[0], "gohome_connect");
    CHECK(motion_play(&ob, a->on_charger, 0) == MOTION_REFUSED_CHARGING, "en la Home Station: sin servos (R14)");
    /* un parpadeo de los contactos (3 s) no la manda a buscar la base; 10 s sin cargador, sí */
    fake_sensors.on_charger = 0;
    fake_run(3000);
    fake_sensors.on_charger = 1;
    fake_run(2000);
    CHECK(!home_active(), "un parpadeo de 3 s sin cargador: sigue en la base");
    fake_sensors.on_charger = 0;
    fake_run(12000);
    CHECK(home_active() && fake_log_contains("casa: volver a la Home Station (batería baja)"), "con 34 %% y 10 s sin cargador: a casa");
    home_stop("fin");
    fake_sensors.soc_pct = 55;
    a->servo_active_s_today = 1e6;   /* cansada: gastó todo su presupuesto de movimiento */
    fake_run(200000);
    CHECK(home_active() && fake_log_contains("casa: volver a la Home Station (siesta"), "de día, cansada y con 55 %%: siesta en la base");
    home_stop("fin");
    a->servo_active_s_today = 0;
    /* en la base y cargada: si te ve, se baja */
    fake_sensors.on_charger = 1;
    fake_sensors.soc_pct = 95;
    fake_run(3000);
    CHECK(fake_log_contains("base: cargando (cara de carga)"), "al ponerla en la base: la cara de carga");
    int r0 = fake_n_servo;
    fake_run(4000);
    int rel4 = 0;
    for (int i = r0; i < fake_n_servo; i++) if (fake_servo[i].op == 'r') rel4++;
    CHECK((motion_all_released() && rel4 >= HAL_SERVOS) || fake_log_contains("motion: servos sueltos (en la base)"), "en la base: los 4 servos sueltos (%d)", rel4);
    CHECK(!fake_legs_on && fake_legs_offs >= 1, "en la base: las patas sin corriente (servos flojos)");
    fake_sensors.on_charger = 0;
    fake_run(300);
    CHECK(fake_legs_on, "fuera de la base: las patas con corriente otra vez");
    fake_sensors.on_charger = 1;
    fake_run(4000);
    int f0 = fake_log_count("motion: explore_foward1");
    fake_face_set(1, 0, 120, 60, 90, 90, "duena");
    fake_sensors.floor[HAL_FOOT_L][HAL_FLOOR_FRONT] = fake_sensors.floor[HAL_FOOT_R][HAL_FLOOR_FRONT] = 0;   /* la orilla de la base */
    k210_scan_every_ms = 0;
    for (int i = 0; i < 300 && fake_log_count("motion: explore_foward1") - f0 < 3; i++) fake_run(100);
    CHECK(fake_log_contains("base: cargada (95 %) y te ve: se baja") && fake_log_count("motion: explore_foward1") - f0 >= 3,
          "cargada y viéndote: se baja de la base (%d pasos)", fake_log_count("motion: explore_foward1") - f0);
    for (int f = 0; f < 2; f++) fake_sensors.floor[f][0] = fake_sensors.floor[f][1] = 1;
    fake_run(3000);
    fake_sensors.floor[HAL_FOOT_L][HAL_FLOOR_FRONT] = fake_sensors.floor[HAL_FOOT_R][HAL_FLOOR_FRONT] = 0;
    fake_run(300);
    CHECK(perception_forward_blocked(), "ya abajo, una orilla de enfrente vuelve a frenar");
    for (int f = 0; f < 2; f++) fake_sensors.floor[f][0] = fake_sensors.floor[f][1] = 1;
    fake_face_set(-1, 0, 0, 0, 0, 0, "");
    k210_scan_every_ms = 15000;
    /* prueba de batería (dueño, 2026-11-02: "quiero saber cuánto le dura la batería") */
    static char one[OUTBOX_LEN], rep[256];
    while (outbox_take(one, sizeof one) > 0) {}
    fake_run(310000);
    int bat_ev = 0;
    while (outbox_take(one, sizeof one) > 0) if (strstr(one, "\"ev\":\"bateria\"") && strstr(one, "\"mv\":")) bat_ev++;
    CHECK(bat_ev >= 1, "cada 5 min, la batería al servidor (%d avisos)", bat_ev);
    api_link_msg("{\"t\":\"prueba_bateria\",\"on\":true}", rep, sizeof rep);
    fake_sensors.on_charger = 0;
    fake_sensors.soc_pct = 30;
    a->servo_active_s_today = 1e6;
    fake_run(200000);
    CHECK(!home_active(), "en la prueba de batería: con 30 %% y cansada, ni a casa ni siesta");
    fake_sensors.soc_pct = 14;
    fake_run(3000);
    CHECK(home_active(), "en la prueba de batería: con 14 %% sí vuelve a casa");
    home_stop("fin");
    while (outbox_take(one, sizeof one) > 0) {}
    fake_run(310000);
    bat_ev = 0;
    while (outbox_take(one, sizeof one) > 0) if (strstr(one, "\"prueba\":1")) bat_ev++;
    CHECK(bat_ev >= 4, "en la prueba, el aviso cada minuto y dice que es la prueba (%d en 5 min)", bat_ev);
    /* sobrevive a un reinicio por software (OTA): sin siesta desde el arranque */
    fake_mem_ok = 0;
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo tras el reinicio");
    a = (alma_t *)app_alma();
    a->pause_until_s = 1e12;
    CHECK(fake_log_contains("la prueba sigue prendida"), "la prueba de batería sigue tras el reinicio");
    fake_sensors.on_charger = 0; fake_sensors.on_usb = 0;
    fake_sensors.soc_pct = 30;
    a->servo_active_s_today = 1e6;
    fake_run(200000);
    CHECK(!home_active(), "tras el reinicio, con 30 %% y cansada, tampoco se va de siesta");
    api_link_msg("{\"t\":\"usb_mueve\",\"on\":true}", rep, sizeof rep);
    CHECK(fake_log_contains("usb: se mueve con el cable") && (hal_keep_get() & 2u), "usb on por Wi-Fi: se mueve con el cable");
    api_link_msg("{\"t\":\"usb_mueve\",\"on\":false}", rep, sizeof rep);
    CHECK(fake_log_contains("usb: con el cable cuenta como base") && !(hal_keep_get() & 2u), "usb off: quieta con el cable");
    api_link_msg("{\"t\":\"prueba_bateria\",\"on\":false}", rep, sizeof rep);
    home_stop("fin");
    a->servo_active_s_today = 0;
    fake_sensors.on_charger = 1;
    fake_sensors.soc_pct = 90;
    a->pause_until_s = 0;
}

/* girando en el sitio, un solo sensor sin piso no es borde (medido 2026-11-02: cancelaba la vuelta a casa) */
static void test_turn_edges(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;
    for (int f = 0; f < 2; f++) fake_sensors.floor[f][0] = fake_sensors.floor[f][1] = 1;
    fake_run(1000);
    perception_set_gait(0, HAL_FOOT_L);   /* girando: pie izquierdo en el aire */
    fake_sensors.floor[HAL_FOOT_L][0] = fake_sensors.floor[HAL_FOOT_L][1] = 0;
    fake_sensors.floor[HAL_FOOT_R][HAL_FLOOR_FRONT] = 0;
    perception_poll_sensors(NULL);
    CHECK(!perception_forward_blocked(), "girando: el pie apoyado pierde un solo sensor: no es borde");
    fake_sensors.floor[HAL_FOOT_R][0] = fake_sensors.floor[HAL_FOOT_R][1] = 0;
    perception_poll_sensors(NULL);
    CHECK(perception_forward_blocked(), "girando: el pie apoyado pierde los dos: borde");
    perception_set_gait(0, -1);
    for (int f = 0; f < 2; f++) fake_sensors.floor[f][0] = fake_sensors.floor[f][1] = 1;
    fake_run(3000);
}

static void test_gait_edges(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;
    floor_all(1);
    perception_poll_sensors(NULL);
    uint32_t g0 = motion_gait_frames(), s0 = motion_gait_stops();
    CHECK(walk("explore_foward1", 10000) == 0 && motion_gait_frames() - g0 >= 2 && motion_gait_stops() == s0,
          "explore_foward1 con piso: camina completo (%u primitivas)", motion_gait_frames() - g0);

    fake_sensors.floor[HAL_FOOT_L][HAL_FLOOR_FRONT] = 0;   /* borde adelante, quieto */
    perception_poll_sensors(NULL);
    CHECK(perception_forward_blocked(), "borde adelante presente");
    g0 = motion_gait_frames();
    walk("explore_foward1", 10000);
    CHECK(motion_gait_stops() == s0 + 1 && !motion_active() && fake_log_contains("borde u obstáculo adelante, la marcha se detiene"),
          "de frente con borde adelante: se detiene al empezar a caminar");

    floor_all(1);
    fake_sensors.floor[HAL_FOOT_R][HAL_FLOOR_REAR] = 0;    /* borde atrás */
    perception_poll_sensors(NULL);
    walk("explore_foward1", 10000);
    CHECK(motion_gait_stops() == s0 + 1, "de frente con borde atrás: sigue (solo cuentan los sensores de adelante)");
    walk("explore_back_away1", 10000);
    CHECK(motion_gait_stops() == s0 + 2 && fake_log_contains("borde atrás, la marcha se detiene"), "en reversa con borde atrás: se detiene");
    floor_all(-1);
    /* 'i' cuenta las desconexiones del cargador (PRUEBA-ROBOT.md 2.2) */
    fake_sensors.on_charger = 1;
    fake_run(1500);
    fake_sensors.on_charger = 0;
    fake_run(1500);
    fake_sensors.on_charger = 1;
    fake_run(1500);
    fake_log_clear();
    app_console_key('i');
    CHECK(fake_log_contains("cargador: ") && !fake_log_contains("cargador: 0 desconexiones"), "'i' muestra las desconexiones del cargador");
    /* teclas de marcha: en la base no se mueve (R14); fuera de la base sí */
    fake_sensors.on_charger = 1;
    fake_run(1500);
    fake_log_clear();
    app_console_key('W');
    CHECK(fake_log_contains("cargando, sin servos (R14)") && !motion_active(), "W en la base: rechazada (R14)");
    fake_sensors.on_charger = 0;
    fake_run(1500);
    floor_all(1);
    uint32_t g1 = motion_gait_frames();
    app_console_key('D');
    fake_run(4000);
    CHECK(motion_gait_frames() > g1, "D fuera de la base: gira (%u primitivas)", motion_gait_frames() - g1);
    floor_all(-1);
}

/* ---- 7f. sensores del cuerpo (app/sense.c, HALLAZGOS §2-§4): señales armadas ---- */
static void ticks(int n, sense_floor *f, sense_imu *m, const int raw[4], int16_t ax, int16_t ay, int16_t az, int flat)
{
    int16_t acc[3] = {ax, ay, az};
    for (int i = 0; i < n; i++) { sense_floor_update(f, raw, flat); sense_imu_update(m, acc, 1, f); }
}

static void test_sense(void)
{
    static sense_floor f;
    static sense_imu m;
    int fl[2][2];
    sense_floor_init(&f);
    sense_imu_init(&m);
    const int on_floor[4] = {600, 600, 600, 600};
    ticks(50, &f, &m, on_floor, 0, 4096, 0, 1);
    sense_floor_out(&f, fl);
    CHECK(fl[0][0] == -1, "piso: sin línea base aprendida, sin dato");
    ticks(400, &f, &m, on_floor, 0, 4096, 0, 1);
    sense_floor_out(&f, fl);
    CHECK(f.thr[0] == 180 && fl[0][0] == 1 && fl[0][1] == 1 && fl[1][0] == 1 && fl[1][1] == 1, "piso: base 600 → umbral 180 (30 %%), los 4 con piso");
    int one_off[4] = {600, 600, 600, 600};
    one_off[SENSE_A41] = 40;
    ticks(20, &f, &m, one_off, 0, 4096, 0, 1);
    sense_floor_out(&f, fl);
    CHECK(fl[HAL_FOOT_L][HAL_FLOOR_FRONT] == 1 && fl[HAL_FOOT_L][HAL_FLOOR_REAR] == 0 && fl[HAL_FOOT_R][0] == 1 && fl[HAL_FOOT_R][1] == 1,
          "piso: A41 sin piso → izquierdo, atrás (medido: adelante es B41/A40)");
    CHECK(m.pose == SENSE_STAND, "un canal sin piso no es levantado");
    const int none[4] = {-1, -1, -1, -1};
    ticks(5, &f, &m, none, 0, 4096, 0, 1);
    sense_floor_out(&f, fl);
    CHECK(fl[0][0] == -1 && fl[1][1] == -1, "piso: 5 lecturas fallidas → sin dato");
    static sense_floor hb;
    sense_floor_init(&hb);
    const int high[4] = {1500, 1500, 1500, 1500};
    for (int i = 0; i < 450; i++) sense_floor_update(&hb, high, 1);
    CHECK(hb.thr[0] == 975, "piso: base 1500 → umbral 65 %% (975): %d", hb.thr[0]);
    static sense_floor nf;
    sense_floor_init(&nf);
    for (int i = 0; i < 450; i++) sense_floor_update(&nf, on_floor, 0);
    CHECK(nf.thr[0] == 0, "piso: con los pies no planos no se aprende");

    /* IMU: levantado (los 4 pies sin nada debajo, nivelado), dejado, volcado y sacudido */
    sense_floor_init(&f);
    sense_imu_init(&m);
    ticks(450, &f, &m, on_floor, 0, 4096, 0, 1);
    CHECK(m.pose == SENSE_STAND && abs(m.A) <= 1 && abs(m.B) <= 1, "IMU: de pie, nivelado (A=%d, B=%d)", m.A, m.B);
    const int air[4] = {30, 30, 30, 30};
    ticks(20, &f, &m, air, 0, 4096, 0, 1);
    CHECK(m.pose == SENSE_STAND, "IMU: todavía no (el filtro de los pies tarda)");
    ticks(15, &f, &m, air, 0, 4096, 0, 1);
    CHECK(m.pose == SENSE_AIR, "IMU: los 4 pies ≤ 99 durante 200 ms → levantado (pose %d, c_air %d)", m.pose, m.c_air);
    ticks(30, &f, &m, air, 0, 4096, 0, 1);
    CHECK(m.pose == SENSE_STAND, "IMU: levantado pero perfectamente quieto y nivelado 300 ms cuenta como dejado (como el original)");
    ticks(20, &f, &m, air, 0, 4096, 0, 1);
    CHECK(m.pose == SENSE_AIR, "IMU: y vuelve a levantado si los pies siguen sin piso 200 ms");
    ticks(60, &f, &m, on_floor, 0, 4096, 0, 1);
    CHECK(m.pose == SENSE_STAND, "IMU: pies con piso 300 ms → dejado");
    ticks(40, &f, &m, air, 4096, 0, 0, 1);   /* de lado: B ≈ 90° */
    CHECK(m.pose == SENSE_TIPPED && abs(m.B) > 70, "IMU: de lado > 70° 200 ms con los pies sin piso → volcado (B=%d)", m.B);
    ticks(10, &f, &m, air, 0, 4096, 0, 1);
    CHECK(m.pose == SENSE_TIPPED, "IMU: el volcado no se recupera de inmediato");
    ticks(60, &f, &m, air, 0, 4096, 0, 1);
    CHECK(m.pose == SENSE_STAND, "IMU: quieto y nivelado 300 ms → recuperado");
    /* levantado y luego dejado acostado de lado (en el robot no pasaba a volcado, 2026-10-30) */
    ticks(40, &f, &m, air, 0, 4096, 0, 1);
    for (int i = 0; i < 40; i++) ticks(1, &f, &m, air, 0, (i & 1) ? 5500 : 2700, 0, 1);   /* en la mano: se mueve */
    CHECK(m.pose == SENSE_AIR, "IMU: en la mano, levantado (pose %d)", m.pose);
    ticks(10, &f, &m, air, 3000, 2800, 0, 1);
    CHECK(m.pose == SENSE_AIR, "IMU: inclinado en la mano un instante: sigue levantado");
    ticks(60, &f, &m, air, 4096, 0, 0, 1);
    CHECK(m.pose == SENSE_TIPPED && abs(m.B) > 70, "IMU: levantado y dejado de lado, quieto > 70° → volcado (B=%d)", m.B);
    ticks(80, &f, &m, on_floor, 0, 4096, 0, 1);
    CHECK(m.pose == SENSE_STAND, "IMU: parado otra vez → de pie");
    for (int i = 0; i < 100; i++) ticks(1, &f, &m, on_floor, 0, (i & 1) ? 12288 : 4096, 0, 1);   /* 1 g ↔ 3 g */
    CHECK(m.shaken, "IMU: desviación > 8000 durante 500 ms → sacudido");
    ticks(60, &f, &m, on_floor, 0, 4096, 0, 1);
    CHECK(!m.shaken, "IMU: desviación < 3000 → fin de la sacudida");

    /* toque */
    static sense_touch t;
    sense_touch_init(&t);
    int r[3] = {1000, 1000, 1000};
    for (int i = 0; i < 20; i++) sense_touch_update(&t, r);
    r[0] = 900;   /* T7: 100 por debajo de la base, umbral 50 */
    for (int i = 0; i < 10; i++) sense_touch_update(&t, r);
    r[0] = 1000;
    sense_touch_update(&t, r);
    CHECK(t.taps == 0 && t.pets == 0, "toque de 100 ms: no cuenta (mínimo 150 ms en T7)");
    r[0] = 900;
    for (int i = 0; i < 30; i++) sense_touch_update(&t, r);
    r[0] = 1000;
    sense_touch_update(&t, r);
    CHECK(t.taps == 1 && t.pets == 0, "toque de 300 ms: golpecito al soltar");
    r[2] = 980;   /* T9: 20 por debajo, umbral 30: no es toque */
    for (int i = 0; i < 30; i++) sense_touch_update(&t, r);
    r[2] = 1000;
    sense_touch_update(&t, r);
    CHECK(t.taps == 1, "T9 a 20 por debajo de su base: no es toque (umbral 30)");
    r[1] = 950;   /* T8: 50 por debajo */
    for (int i = 0; i < 200; i++) sense_touch_update(&t, r);
    CHECK(t.pets == 1, "T8 sostenido 2 s: una caricia a los 1500 ms");
    r[1] = 1000;
    sense_touch_update(&t, r);
    CHECK(t.taps == 1 && t.pets == 1, "al soltar la caricia no se cuenta además un golpecito");
    /* pasadas (dueño, 2026-10-30): la mano entra y sale del pad; 3 en 4 s son una caricia */
    for (int k = 0; k < 3; k++) {
        r[0] = 900;
        for (int i = 0; i < 30; i++) sense_touch_update(&t, r);
        r[0] = 1000;
        for (int i = 0; i < 70; i++) sense_touch_update(&t, r);
    }
    CHECK(t.taps == 4 && t.pets == 2, "3 pasadas en 3 s: caricia (toques %d, caricias %d)", t.taps, t.pets);
    for (int i = 0; i < 500; i++) sense_touch_update(&t, r);   /* 5 s sin tocar */
    for (int k = 0; k < 3; k++) {
        r[0] = 900;
        for (int i = 0; i < 30; i++) sense_touch_update(&t, r);
        r[0] = 1000;
        for (int i = 0; i < 250; i++) sense_touch_update(&t, r);
    }
    CHECK(t.pets == 2, "3 toques separados 2.8 s (más de 4 s en total): no es caricia (%d)", t.pets);
}

/* ---- ojos vivos (dueño, 2026-10-30): vistazos de 3.5 s en el modo 4 cada 15 s; entre medio, stay_X_Y en el modo 1 ---- */
static int tx_has_text(int from, const char *txt)
{
    for (int i = from; i < fake_n_tx; i++) {
        char buf[600] = {0};
        size_t n = fake_txs[i].n < sizeof buf - 1 ? fake_txs[i].n : sizeof buf - 1;
        memcpy(buf, fake_txs[i].b, n);
        for (size_t k = 0; k < n; k++) if (!buf[k]) buf[k] = ' ';
        if (strstr(buf, txt)) return 1;
    }
    return 0;
}

/* truco de Darth Vader (dueño, 2026-11-03): la marcha llega como "cara" con "ext":"mp3"; el truco pone /test/vader.avi con
   /test/vader_marcha.mp3, camina al frente y termina a los 18.7 s */
static void test_vader(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0; fake_sensors.on_usb = 0;
    fake_run(2000);
    static uint8_t mp3[3000];
    static char b64[4200], msg[4600], rep[256];
    for (size_t i = 0; i < sizeof mp3; i++) mp3[i] = (uint8_t)(i * 5 + 1);
    b64enc(mp3, sizeof mp3, b64);
    snprintf(msg, sizeof msg, "{\"t\":\"cara\",\"nombre\":\"vader_marcha\",\"ext\":\"mp3\",\"size\":3000,\"seq\":0,\"last\":true,\"b64\":\"%s\"}", b64);
    fake_file_ack_cmd = 0x21;
    fake_file_rx_n = 0;
    outbox_clear();
    fake_log_clear();
    int tp = fake_n_tx;
    api_link_msg(msg, rep, sizeof rep);
    for (int i = 0; i < 100 && !fake_log_contains("ya está en la SD"); i++) fake_run(100);
    CHECK(fake_file_rx_n == sizeof mp3 && tx_has_text(tp, "vader_marcha.mp3") && outbox_has("{\"t\":\"cara_ok\",\"nombre\":\"vader_marcha\"}"),
          "la marcha llega como mp3 y se sube a /test/vader_marcha.mp3 (%d bytes, nombre %d, ok %d)", (int)fake_file_rx_n, tx_has_text(tp, "vader_marcha.mp3"), outbox_has("{\"t\":\"cara_ok\",\"nombre\":\"vader_marcha\"}"));
    fake_run(3000);
    tp = fake_n_tx;
    int f0 = fake_log_count("motion: explore_foward1");
    api_link_msg("{\"t\":\"trick\",\"mot\":\"vader\",\"req\":7}", rep, sizeof rep);
    CHECK(strstr(rep, "\"done\":true") != NULL, "el truco vader se acepta (%s)", rep);
    CHECK(tx_has_text(tp, "/test/vader.avi") && tx_has_text(tp, "/test/vader_marcha.mp3"), "pone la cara con la marcha");
    for (int i = 0; i < 175; i++) fake_run(100);
    int steps = fake_log_count("motion: explore_foward1") - f0;
    CHECK(steps >= 3 && !fake_log_contains("truco: Darth Vader terminó"), "camina al frente mientras suena (%d pasos)", steps);
    for (int i = 0; i < 20; i++) fake_run(100);
    CHECK(fake_log_contains("truco: Darth Vader terminó"), "a los 18.7 s termina");
    api_link_msg("{\"t\":\"trick\",\"mot\":\"vader\",\"req\":8}", rep, sizeof rep);
    CHECK(strstr(rep, "\"done\":true") != NULL, "se puede pedir otra vez");
    for (int i = 0; i < 200; i++) fake_run(100);
}
static void test_eyes_and_routine(void)
{
    k210_scan_every_ms = 15000;
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    ((alma_t *)app_alma())->pause_until_s = 1e12;   /* sin conductas: solo el ciclo de ojos y vistazos */
    ((alma_t *)app_alma())->last_exec_t[bx("bhv_routine")] = 1e12;
    fake_run(5300);   /* 3 s en el modo 1 + 10 sondeos: primer vistazo */
    CHECK(k210_scanning(), "primer vistazo en el modo 4");
    int tx0 = fake_n_tx;
    fake_run(4000);
    CHECK(!k210_scanning() && tx_has_text(tx0, "stay_"), "a los 3.5 s, modo 1 y los ojos se mueven (stay_)");
    int polls = fake_face_polls;
    for (int i = 0; i < 8; i++) { fake_run(1000); fake_k210_small(0, 0x08, 0, 0, 0); }
    CHECK(fake_face_polls == polls, "con los ojos vivos no se piden caras");
    for (int i = 0; i < 7 && !k210_scanning(); i++) { fake_run(1000); fake_k210_small(0, 0x08, 0, 0, 0); }
    CHECK(k210_scanning(), "a los 15 s, otro vistazo");
    /* la persona 0 sigue presente entre vistazos */
    fake_face_set(1, 0, 100, 80, 120, 120, "persona0");
    fake_run(1000);
    fake_face_set(0, 0, 0, 0, 0, 0, "");
    fake_run(3000);
    int64_t t0 = fake_ms;
    for (int i = 0; i < 10; i++) { fake_run(1000); fake_k210_small(0, 0x08, 0, 0, 0); }
    CHECK(events_since(t0, EV_FACE_LOST, 0) == 0 && events_since(t0, EV_FACE_SEEN, 0) >= 5,
          "entre vistazos la 0 sigue presente (EV_FACE_SEEN cada segundo)");
    /* rutina: inicio, repeticiones y final, con cada 08 00 */
    int r = bx("bhv_routine");
    CHECK(r >= 0, "bhv_routine en el catálogo");
    int tx1 = fake_n_tx;
    CHECK(expression_play_seq(r, 1545, 30) == 0, "rutina de las 15:45");
    CHECK(tx_has_text(tx1, "_start"), "empieza con el inicio");
    fake_run(800); fake_k210_small(0, 0x08, 0, 0, 0); fake_run(50);
    CHECK(tx_has_text(tx1, "_loop1"), "después, la repetición");
    for (int i = 0; i < 40; i++) { fake_run(800); fake_k210_small(0, 0x08, 0, 0, 0); }
    CHECK(tx_has_text(tx1, "_end"), "a los 30 s, el final");
    int tx2 = fake_n_tx;
    fake_run(800); fake_k210_small(0, 0x08, 0, 0, 0); fake_run(50);
    CHECK(!tx_has_text(tx2, "Daily_"), "después del final, nada más de la rutina");
    /* una repetición que no está en la SD (08 00 a los pocos ms): no da vueltas; va el final (2026-11-03) */
    tx1 = fake_n_tx;
    expression_play_seq(r, 1545, 200);
    fake_run(800); fake_k210_small(0, 0x08, 0, 0, 0); fake_run(50);   /* el inicio sí está */
    fake_run(40); fake_k210_small(0, 0x08, 0, 0, 0); fake_run(50);    /* la repetición no */
    CHECK(tx_has_text(tx1, "_end") && fake_log_contains("no está en la SD; va el final"), "falta la repetición: el final");
    tx2 = fake_n_tx;
    fake_run(800); fake_k210_small(0, 0x08, 0, 0, 0); fake_run(50);
    CHECK(!tx_has_text(tx2, "Daily_"), "y ahí termina");
    k210_scan_every_ms = 0;
}

/* ---- 7g. archivo al K210 (HALLAZGOS §14): tipo, nombre, 23, trozos por SPI con acuse, 25 ---- */
static void test_file_send(void)
{
    static uint8_t data[2500];
    for (size_t i = 0; i < sizeof data; i++) data[i] = (uint8_t)(i * 7 + (i >> 8));
    static const uint8_t TYPE[] = {0x55, 0xAA, 0xFF, 0x04, 0x00, 0x28, 0x2A, 't', 'e', 's', 't'};
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    int t0 = fake_n_tx, polls = fake_face_polls;
    CHECK(k210_file_send("test", "alma_test.avi", data, sizeof data) == 0, "empieza el envío");
    CHECK(k210_file_send("test", "otro.avi", data, 10) == -1, "uno a la vez");
    for (int t = 0; t < 2000 && k210_file_state_get() == K210_FILE_BUSY; t += 10) fake_run(10);
    int busy_polls = fake_face_polls - polls;
    fake_run(500);
    CHECK(k210_file_state_get() == K210_FILE_OK && k210_file_chunks() == 3, "2500 bytes en 3 trozos de 1024: enviado (%u)", k210_file_chunks());
    CHECK(fake_file_rx_n == sizeof data && memcmp(fake_file_rx, data, sizeof data) == 0 && fake_file_bad == 0,
          "el K210 falso reconstruye el archivo idéntico (cabeceras, sumas e inversión por palabra bien)");
    CHECK(t0 < fake_n_tx && fake_txs[t0].n == sizeof TYPE + 1 && memcmp(fake_txs[t0].b, TYPE, sizeof TYPE) == 0,
          "extendido 28 con \"test\" sin 00 (LEN 4)");
    CHECK(fake_txs[t0 + 1].b[5] == 0x26 && fake_txs[t0 + 1].b[3] == 14 && memcmp(fake_txs[t0 + 1].b + 7, "alma_test.avi", 14) == 0,
          "extendido 26 con el nombre y su 00");
    int i23 = -1, i25 = -1, i2b = -1, i2d = -1;
    for (int i = t0; i < fake_n_tx; i++) {
        if (fake_txs[i].n == 7 && fake_txs[i].b[2] == 0x23) i23 = i;
        if (fake_txs[i].n == 7 && fake_txs[i].b[2] == 0x25) i25 = i;
        if (fake_txs[i].n == 7 && fake_txs[i].b[2] == 0x2B) i2b = i;
        if (fake_txs[i].n == 7 && fake_txs[i].b[2] == 0x2D) i2d = i;
    }
    CHECK(i23 > t0 && i25 > i23, "23 al abrir y 25 al cerrar");
    CHECK(i2b > i25 && i2d > i2b, "después del 25, 2B y 2D cierran la subida (para salir de \"Updating step 1\")");
    CHECK(busy_polls == 0, "sin sondeo de caras durante el envío (%d)", busy_polls);

    fake_file_rx_n = 0;
    fake_file_reject = 2;
    fake_file_ack_cmd = 0x33;   /* el acuse en 33 también vale */
    fake_log_clear();
    k210_file_send("test", "b.avi", data, sizeof data);
    fake_run(2000);
    CHECK(k210_file_state_get() == K210_FILE_OK && fake_file_rx_n == sizeof data && fake_log_contains("reintento 2"),
          "dos trozos rechazados: se reenvían y llega completo");
    fake_file_fatal = 1;
    k210_file_send("test", "c.avi", data, sizeof data);
    fake_run(2000);
    CHECK(k210_file_state_get() == K210_FILE_FAILED && fake_log_contains("0x7FF"), "0x7FF: falla sin reintentar");
    fake_file_fatal = 0;
    fake_file_ack_cmd = 0;
    k210_file_send("test", "d.avi", data, sizeof data);
    fake_run(11000);
    CHECK(k210_file_state_get() == K210_FILE_FAILED && fake_log_contains("sin acuse al abrir"), "sin acuse en 10 s: falla");

    int tp = fake_n_tx, play_ok = k210_play_path("/test/alma_test.avi", NULL, 0) == 0, found = 0;
    for (int i = tp; i < fake_n_tx; i++) found |= memcmp(fake_txs[i].b + 7, "[0,[[\"/test/alma_test.avi\"]]]", 29) == 0;
    CHECK(play_ok && found, "se reproduce desde /test/ con el extendido 02");
    /* tecla J: sube la animación de prueba y, al confirmar, la reproduce desde /test/ */
    fake_file_ack_cmd = 0x21;
    fake_file_rx_n = 0;
    int tj = fake_n_tx;
    app_console_key('J');
    fake_run(3000);
    size_t an;
    const uint8_t *avi = hal_test_avi(&an);
    int played = 0;
    for (int i = tj; i < fake_n_tx; i++) played |= fake_txs[i].b[5] == 0x02 && memcmp(fake_txs[i].b + 7, "[0,[[\"/test/alma_test.avi\"]]]", 29) == 0;
    CHECK(fake_file_rx_n == an && memcmp(fake_file_rx, avi, an) == 0 && played, "J: alma_test.avi llega completa y se reproduce");
}

/* ---- 8. memory_store: lee y valida la región, nunca escribe ---- */
static void test_memory(void)
{
    /* la región ya tiene una Alma guardada (como si la hubiera escrito una versión con escritura habilitada) */
    static alma_t prev;
    alma_mem_flash fl;
    CHECK(hal_mem_flash(&fl) == 0, "flash falsa");
    static alma_mem m;
    alma_mem_open(&m, &fl);
    alma_init(&prev, &cat_ref, 99, 0, (alma_hooks){0});
    prev.age_days = 41;
    prev.trait_learned[2] = 0.07f;
    prev.trait[2] = prev.trait_base[2] + 0.07f;
    m.birth_unix = 1793404800;
    CHECK(alma_mem_save(&m, &prev, MEM_ALL) == 6, "región preparada con 6 bloques");
    uint32_t w0 = fake_mem.n_write, er0 = fake_mem.n_erase;
    boot_app(K_REPLY_SAM);
    CHECK(app_mem()->recovered && app_alma()->age_days == 41 && app_alma()->trait_learned[2] == 0.07f
          && memcmp(app_alma()->trait_base, prev.trait_base, sizeof prev.trait_base) == 0,
          "al arrancar restaura identity (día 41, rasgos)");
    run_until_ready(15000);
    fake_sensors.on_charger = 0;
    for (int h = 0; h < 4; h++) {   /* 4 h con eventos que fuerzan guardado: carga, batería baja */
        fake_sensors.on_charger = h % 2;
        fake_sensors.touch_pet = 1; fake_run(50); fake_sensors.touch_pet = 0;
        fake_run(3600000 - 50);
    }
    fake_sensors.soc_pct = 15;
    fake_run(1000);
    CHECK(fake_mem.n_write == w0 && fake_mem.n_erase == er0,
          "ALMA_MEM_WRITE_ENABLED=0: ni un borrado ni una escritura en 4 h (%u escrituras, %u borrados)",
          fake_mem.n_write - w0, fake_mem.n_erase - er0);
}

#if ALMA_MEM_WRITE_ENABLED
/* ---- 8b. memoria con la escritura encendida (variante test_f2_memw de build.sh): un día, reinicio y cortes ---- */
static float bond_of(int id)
{
    int s = alma_slot_of(app_alma(), id);
    return s >= 0 ? app_alma()->person[s].attachment : -1;
}

static void test_mem_write(void)
{
    /* una región con datos ajenos (no 0xFF y sin registros de Alma): nunca se escribe */
    fake_mem_ok = 0;
    alma_mem_flash tmp;
    hal_mem_flash(&tmp);
    memset(fake_mem.img + 300000, 0x00, 64);
    fake_log_clear();
    boot_app(K_REPLY_SAM);
    uint32_t fw0 = fake_mem.n_write, fe0 = fake_mem.n_erase;
    fake_sensors.on_charger = 0;
    fake_run(3600000);
    fake_sensors.on_charger = 1;
    fake_run(60000);
    CHECK(fake_mem.n_write == fw0 && fake_mem.n_erase == fe0 && fake_log_contains("escritura BLOQUEADA"),
          "región con datos ajenos: escritura bloqueada, ni un byte en 1 h (%u escrituras)", fake_mem.n_write - fw0);

    fake_mem_ok = 0;   /* flash nueva: toda en 0xFF */
    boot_app(K_REPLY_SAM);
    CHECK(app_mem()->recovered, "flash vacía: memory_recovered = true, arranca con valores por omisión");
    CHECK(run_until_ready(15000), "K210 listo");
    uint32_t w0 = fake_mem.n_write, e0 = fake_mem.n_erase;
    /* un día: la dueña 2 h en la mañana y 2 h en la noche, con caricias; de noche en la base */
    for (int h = 0; h < 24; h++) {
        int present = (h >= 1 && h < 3) || (h >= 12 && h < 14);
        fake_face_set(present ? 1 : -1, 0, 100, 80, 120, 120, "duena");
        fake_sensors.on_charger = h >= 14;
        if (!present) { fake_run(3600000); continue; }
        for (int p = 0; p < 6; p++) {
            fake_sensors.touch_pet = 1;
            fake_run(50);
            fake_sensors.touch_pet = 0;
            fake_run(600000 - 50);
        }
    }
    uint32_t writes = fake_mem.n_write - w0, erases = fake_mem.n_erase - e0, worst = 0;
    for (uint32_t s = 0; s < alma_mem_region_bytes() / ALMA_MEM_SECTOR; s++) if (fake_mem.erase_count[s] > worst) worst = fake_mem.erase_count[s];
    double years = worst ? 100000.0 / ((double)worst * 365.0) : 1e9;   /* 100 000 borrados por sector (hoja del GD25Q128) */
    printf("  memoria, un día: %u escrituras, %u borrados; el sector más usado, %u borrados → ~%.0f años hasta 100 000\n",
           writes, erases, worst, years);
    CHECK(writes > 0 && erases > 0, "con la escritura encendida, guarda (%u escrituras)", writes);
    CHECK(years >= 10, "desgaste: el sector más usado aguanta ≥ 10 años (%.0f)", years);
    float a0 = bond_of(0);
    int age0 = app_alma()->age_days;
    CHECK(a0 > 0, "la dueña tiene apego después del día (%.3f)", a0);

    /* reinicio: lo aprendido sigue */
    alma_mem_flush(app_mem(), app_alma());
    a0 = bond_of(0);
    boot_app(K_REPLY_SAM);
    CHECK(app_mem()->recovered && fabsf(bond_of(0) - a0) < 1e-6f && app_alma()->age_days == age0,
          "tras reiniciar: apego de la dueña (%.3f = %.3f) y edad (%d) restaurados", bond_of(0), a0, app_alma()->age_days);

    /* cortes de luz en medio de una escritura de todos los bloques: siempre arranca con una copia válida */
    int ok = 0;
    for (int i = 0; i < 10; i++) {
        alma_mem_file_cut(&fake_mem, 997LL * (i + 1));
        alma_mem_save(app_mem(), app_alma(), 0xFFFFFFFFu);
        alma_mem_file_power_on(&fake_mem);
        boot_app(K_REPLY_SAM);
        ok += app_mem()->recovered && fabsf(bond_of(0) - a0) < 1e-6f && app_alma()->age_days == age0;
    }
    CHECK(ok == 10, "10 cortes en medio de la escritura: %d de 10 arrancan con la memoria intacta", ok);

    /* noches con la fecha real (SNTP: segundos locales desde 1970, 2026-10-30): una sola vez cada noche, aunque se
       reinicie a media noche, y la edad y el bienestar sobreviven al reinicio */
    const double D = 20756.0 * 86400.0;   /* 2026-10-30 00:00 local */
    fake_mem_ok = 0;
    app_preset_clock(D + 18 * 3600.0);
    boot_app(K_REPLY_SAM);   /* en la Home Station (fake_reset: cargador, sin USB) */
    CHECK(run_until_ready(15000), "K210 listo");
    fake_run(8LL * 3600000);   /* 18:00 → 02:00 */
    int age1 = app_alma()->age_days;
    float wb1 = app_alma()->wellbeing;
    CHECK(age1 == 1 && app_alma()->state == ST_SLEEPING, "la primera noche: pase nocturno y dormida (edad %d, estado %d, bienestar %.1f)",
          age1, (int)app_alma()->state, wb1);
    alma_mem_flush(app_mem(), app_alma());
    app_preset_clock(D + 86400.0 + 2 * 3600.0 + 60);   /* reinicio a las 2:01 del 31 */
    boot_app(K_REPLY_SAM);
    CHECK(app_alma()->age_days == age1 && fabsf(app_alma()->wellbeing - wb1) < 1e-3f, "tras reiniciar a media noche: misma edad y bienestar");
    fake_run(6LL * 3600000);   /* 2:01 → 8:01: no repite la noche */
    CHECK(app_alma()->age_days == age1, "la misma noche no se repite tras el reinicio (edad %d)", app_alma()->age_days);
    fake_run(16LL * 3600000);   /* hasta la noche siguiente */
    CHECK(app_alma()->age_days == age1 + 1, "la noche siguiente sí (edad %d)", app_alma()->age_days);
    app_preset_clock(-1);
}
#endif

/* ---- 9. API local ---- */
/* lo que espera en la cola del enlace (la vacía) */
static int outbox_has(const char *sub)
{
    static char all[OUTBOX_N * OUTBOX_LEN], one[OUTBOX_LEN];
    all[0] = 0;
    while (outbox_take(one, sizeof one) > 0) strcat(all, one);
    return strstr(all, sub) != NULL;
}

static void unhex(const char *h, uint8_t *out, size_t *n)
{
    *n = strlen(h) / 2;
    for (size_t i = 0; i < *n; i++) { unsigned v; sscanf(h + 2 * i, "%2x", &v); out[i] = (uint8_t)v; }
}

/* el enlace cifrado contra relay/alma_relay/link.py (vectores sacados de ahí, 2026-10-30) */
static void test_link(void)
{
    static const char A_HEX[] = "41c8c9cacbcccdcecfd0d1d2d3d4d5d6d732333435363738393a3b3c3da73782a1e85df49705638fe03c8596920ddf76"
                                "efe63dd699a27b67f5d6b9816969859a37538dc21c98eaf3a9e1";
    static const char S2R_HEX[] = "44000000000000000129a369a81f1d3bf522c4868a378dd18d15847ae93aadf12bd75779e326e9845ba65e9b995c3f"
                                  "6241760a4d41ecad1e84b21e74";
    static const char R2S_HEX[] = "440000000000000001ff4c48eca9cec547adf0fbf9c49c38420de35dd544419655674769f526";
    uint8_t k[32], hello[17] = {'H'}, rnd[28], out[256], exp[256];
    size_t n;
    for (int i = 0; i < 32; i++) k[i] = (uint8_t)i;
    for (int i = 0; i < 16; i++) hello[1 + i] = (uint8_t)(100 + i);
    for (int i = 0; i < 16; i++) rnd[i] = (uint8_t)(200 + i);
    for (int i = 0; i < 12; i++) rnd[16 + i] = (uint8_t)(50 + i);
    link_sess s, t;
    long m = link_auth(k, hello, sizeof hello, "alma", rnd, &s, out, sizeof out);
    unhex(A_HEX, exp, &n);
    CHECK(m == (long)n && memcmp(out, exp, n) == 0, "frame A igual al de link.py");
    char pt[128];
    unhex(S2R_HEX, exp, &n);
    t = s;
    CHECK(link_open(&s, exp, n, pt, sizeof pt) > 0 && strcmp(pt, "{\"t\":\"command\",\"action_id\":\"dance\"}") == 0,
          "frame del servidor descifrado (llave de sesión HMAC igual)");
    CHECK(link_open(&s, exp, n, pt, sizeof pt) < 0, "el mismo frame otra vez: rechazado (contador)");
    m = link_seal(&s, "{\"t\":\"state\"}", 13, out, sizeof out);
    unhex(R2S_HEX, exp, &n);
    CHECK(m == (long)n && memcmp(out, exp, n) == 0, "frame D del robot igual al de link.py");
    unhex(S2R_HEX, exp, &n);
    exp[20] ^= 1;
    CHECK(link_open(&t, exp, n, pt, sizeof pt) < 0, "frame alterado: rechazado");
    exp[20] ^= 1;
    k[0] ^= 1;
    link_auth(k, hello, sizeof hello, "alma", rnd, &t, out, sizeof out);
    CHECK(link_open(&t, exp, n, pt, sizeof pt) < 0, "con otra llave no se abre");
    CHECK(link_key_hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1F", k) == 0 && k[31] == 0x1f && k[10] == 10,
          "llave en hexadecimal");
    CHECK(link_key_hex("00", k) < 0 && link_key_hex("zz0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", k) < 0,
          "llave mal escrita: rechazada");

    /* WebSocket: saludo, frame con máscara y lectura de frames del servidor */
    uint8_t key16[16] = {0}, mask[4] = {1, 2, 3, 4}, f[300];
    char req[256];
    CHECK(ws_request(req, sizeof req, "alma.example", 8080, "/v1/robot", key16) > 0 && strstr(req, "GET /v1/robot HTTP/1.1\r\n")
          && strstr(req, "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n") && strstr(req, "Host: alma.example:8080\r\n"),
          "saludo WebSocket");
    CHECK(ws_accepted("HTTP/1.1 101 Switching Protocols\r\n\r\n") && !ws_accepted("HTTP/1.1 403 Forbidden\r\n\r\n"), "101 sí, 403 no");
    uint8_t pl[200];
    for (int i = 0; i < 200; i++) pl[i] = (uint8_t)i;
    m = ws_frame(f, sizeof f, WS_BIN, pl, 200, mask);
    CHECK(m == 208 && f[0] == 0x82 && f[1] == (0x80 | 126) && f[2] == 0 && f[3] == 200 && f[8] == (0 ^ 1) && f[9] == (1 ^ 2),
          "frame del cliente: largo de 16 bits y máscara");
    uint8_t sv[300] = {0x82, 126, 0, 200};
    memcpy(sv + 4, pl, 200);
    int op;
    size_t off, len;
    CHECK(ws_parse(sv, 3, 4096, &op, &off, &len) == 0 && ws_parse(sv, 100, 4096, &op, &off, &len) == 0, "frame incompleto: espera");
    CHECK(ws_parse(sv, 204, 4096, &op, &off, &len) == 204 && op == WS_BIN && off == 4 && len == 200, "frame del servidor completo");
    CHECK(ws_parse(sv, 204, 100, &op, &off, &len) < 0, "más grande que el máximo: error");
    uint8_t ping[] = {0x89, 0};
    CHECK(ws_parse(ping, 2, 4096, &op, &off, &len) == 2 && op == WS_PING && len == 0, "ping vacío");

    /* mensajes del servidor y cola de avisos, con la app corriendo */
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;
    static char st[16384];
    char rep[256];
    CHECK(api_state(st, sizeof st) > 0 && strncmp(st, "{\"t\":\"state\"", 12) == 0, "el estado sale con \"t\":\"state\"");
    int e1 = n_ex;
    m = api_link_msg("{\"t\":\"command\",\"action_id\":\"dance\"}", rep, sizeof rep);
    CHECK(m > 0 && strstr(rep, "\"t\":\"command_result\",\"code\":200"), "orden del celular por el enlace: %s", rep);
    fake_run(300);
    int ic = -1;
    for (int i = e1; i < n_ex; i++) if (ex[i].e.behavior == bx("bhv_dance") || ex[i].e.behavior == bx("bhv_refuse")) { ic = i; break; }
    CHECK(ic >= 0, "la orden llega al núcleo (bhv_dance o bhv_refuse)");
    api_link_msg("{\"t\":\"welcome\",\"time\":1}", rep, sizeof rep);   /* contesta con sus gustos (care_import) */
    CHECK(fake_log_contains("enlace: conectada"), "welcome");
    float w0 = app_alma()->wellbeing;
    api_link_msg("{\"t\":\"night_result\",\"wellbeing_adjust\":10,\"wellbeing_reason\":\"jugó mucho\",\"journal_es\":\"Hoy jugué.\","
                 "\"trait_nudges\":{\"trait_energy\":0.01}}", rep, sizeof rep);
    CHECK(app_alma()->wellbeing > w0 && app_alma()->wb_day_adjust == 10 && fake_log_contains("diario: Hoy jugué."),
          "night_result: ajuste de Haiku al bienestar (%.1f → %.1f)", w0, app_alma()->wellbeing);
    /* recordatorio del calendario: bhv_reminder forzada, con la alarma del original */
    e1 = n_ex;
    int t1 = fake_n_tx;
    m = api_link_msg("{\"t\":\"reminder\",\"title\":\"Junta\",\"minutes\":10}", rep, sizeof rep);
    fake_run(500);
    int ir = -1;
    for (int i = e1; i < n_ex; i++) if (ex[i].e.behavior == bx("bhv_reminder")) { ir = i; break; }
    CHECK(m > 0 && ir >= 0 && ex[ir].e.kind == RUN_FORCED, "recordatorio: bhv_reminder forzada");
    int alarm = 0;
    for (int i = t1; i < fake_n_tx; i++)
        for (size_t k = 0; k + 19 <= fake_txs[i].n; k++) alarm |= memcmp(fake_txs[i].b + k, "alarm_shock_start_1", 19) == 0;
    CHECK(alarm, "al K210: la animación de alarma (alarm_shock_start_1)");
    api_link_msg("{\"t\":\"night_result\",\"error\":\"APIError\"}", rep, sizeof rep);
    CHECK(fake_log_contains("queda la cuenta local"), "night_result con error: queda la cuenta local");

    /* el resumen nocturno para Haiku */
    alma_day_summary ds;
    memset(&ds, 0, sizeof ds);
    ds.age_days = 3;
    ds.counts.pets = 4;
    ds.counts.behaviors[bx("bhv_dance")] = 2;
    for (int i = 0; i < ALMA_MAX_PERSONS; i++) ds.attachment[i] = -1;
    m = api_night(&ds, st, sizeof st);
    cJSON *j = cJSON_Parse(st);
    const cJSON *sm = cJSON_GetObjectItem(j, "summary");
    CHECK(m > 0 && m < OUTBOX_LEN && cJSON_GetObjectItem(cJSON_GetObjectItem(sm, "counts"), "pets")->valueint == 4
          && cJSON_GetObjectItem(cJSON_GetObjectItem(sm, "behaviors"), "bhv_dance")->valueint == 2
          && cJSON_IsObject(cJSON_GetObjectItem(sm, "traits")) && cJSON_IsNumber(cJSON_GetObjectItem(sm, "day_points")),
          "resumen nocturno para Haiku: counts, behaviors, traits, day_points");
    cJSON_Delete(j);
    for (int i = 0; i < app_catalog()->n; i++) ds.counts.behaviors[i] = 999;   /* el peor caso: todas las conductas */
    m = api_night(&ds, st, sizeof st);
    CHECK(m > 0 && m < OUTBOX_LEN, "el resumen más largo cabe en la cola (%ld de %d bytes)", m, OUTBOX_LEN);

    /* tres bordes en 10 min: aviso de caídas */
    outbox_clear();
    alma_ev c = {EV_CLIFF, -1, -1, -1, 0, 0, 0, 0};
    for (int i = 0; i < 3; i++) { app_post(&c); fake_run(20000); }
    CHECK(outbox_has("\"ev\":\"falls\""), "tres bordes en un minuto: aviso falls");
    app_post(&c);
    fake_run(20000);
    CHECK(!outbox_has("\"ev\":\"falls\""), "un borde más: sin otro aviso");

    /* no encuentra la base: aviso con la batería */
    fake_base_set(0, 0, 0);
    home_start("prueba");
    fake_run(310000);
    CHECK(home_get() == HOME_FAIL && outbox_has("\"ev\":\"home_failed\",\"battery_pct\":"), "no llegó a la base: aviso home_failed");
    fake_base_set(-1, 0, 0);

    /* la cola guarda los últimos OUTBOX_N */
    outbox_clear();
    for (int i = 0; i < OUTBOX_N + 2; i++) { char e[32]; snprintf(e, sizeof e, ",\"i\":%d", i); outbox_event("x", e); }
    char one[OUTBOX_LEN];
    CHECK(outbox_count() == OUTBOX_N && outbox_take(one, sizeof one) > 0 && strstr(one, "\"i\":2}"), "cola llena: se pierde el más viejo");
    outbox_clear();
}

static void run_k210(int64_t ms);

/* olvidar a quien no se ve en 28 días (06; dueño, 2026-10-30): núcleo → on_forget → 4F 00, 50 id, 4F, 38 01 */
static void test_forget_faces(void)
{
    app_preset_clock(1.79e9);   /* hora real (SNTP) */
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    alma_t *a = (alma_t *)app_alma();
    CHECK(a->forget_enabled, "con hora real, el olvido está encendido");
    double now = app_now_s();
    for (int id = 0; id <= 2; id++) {
        alma_ev f = {EV_FACE_SEEN, id, -1, -1, 160, 120, 80, 0};
        app_post(&f);
        run_k210(200);
        alma_ev l = {EV_FACE_LOST, id, -1, -1, 0, 0, 0, 0};
        app_post(&l);
        run_k210(200);
    }
    a->person[alma_slot_of(a, 1)].last_seen_s = now - 29 * 86400.0;
    a->person[alma_slot_of(a, 0)].last_seen_s = now - 300 * 86400.0;
    outbox_clear();
    int t0 = fake_n_tx;
    CHECK(alma_forget_unseen(a, app_now_s()) == 1, "la persona 1, 29 días sin verse, se olvida; el dueño no");
    run_k210(6000);
    uint8_t f4f[K210_SMALL_LEN], f50[K210_SMALL_LEN];
    k210_small(f4f, 0x4F, 0, 0, 0);
    k210_small(f50, 0x50, 1, 0, 0);
    int i4f = tx_find(f4f, sizeof f4f, t0), i50 = tx_find(f50, sizeof f50, t0);
    CHECK(i4f >= 0 && i50 > i4f, "al K210: 4F 00 y después 50 01 00");
    CHECK(k210_face_delete_state() == K210_REG_OK && fake_log_contains("el K210 contestó 4F"), "el K210 contesta 4F: borrada");
    CHECK(outbox_has("\"ev\":\"forgot_face\",\"person_id\":1"), "aviso forgot_face al celular");
    CHECK(alma_slot_of(a, 1) < 0 && alma_slot_of(a, 0) >= 0, "lugar libre; el dueño sigue");
    CHECK(k210_face_delete(0) < 0, "la cara del dueño (id 0) nunca se borra");
    fake_del_reply = 0;
    CHECK(k210_face_delete(5) == 0, "borrar otra");
    run_k210(6000);
    CHECK(k210_face_delete_state() == K210_REG_TIMEOUT && fake_log_contains("sin respuesta 4F"), "sin 4F en 5 s: se rinde y vuelve al sondeo");
    fake_del_reply = 1;
    app_preset_clock(-1);
    boot_app(K_REPLY_SAM);
    CHECK(!app_alma()->forget_enabled, "sin hora real: el olvido se apaga");
}

/* voz tras "Hey EMO" (07; dueño, 2026-10-30): micrófono del K210 → trozos por el enlace → voice_result → evento */
static void test_voice(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;
    char rep[64], m[4200];
    api_link_msg("{\"t\":\"welcome\",\"time\":1}", rep, sizeof rep);   /* enlace arriba */
    int t0 = fake_n_tx;
    alma_ev w = {EV_WAKE_WORD, -1, -1, -1, 1, 5, 0, 0};
    uint8_t f4b[K210_SMALL_LEN];
    k210_small(f4b, 0x4B, 0, 0, 0);
    /* como el original [BOBBY-ARTE]: tras la palabra de activación el K210 empuja el audio solo; no se le manda 4B 00 */
    fake_mic_on_4b = 0;
    app_post(&w);
    fake_mic_stream(50);
    run_k210(1500);
    CHECK(tx_find(f4b, sizeof f4b, t0) < 0, "el audio llegó solo: sin 4B 00");
    CHECK(fake_mic_reads == 10 && fake_mic_bad_hdr == 0, "10 trozos leídos por SPI con la cabecera del modo 1 (%d, malas %d)",
          fake_mic_reads, fake_mic_bad_hdr);
    long nn;
    while ((nn = api_link_take(m, sizeof m)) > 0) {}
    api_link_msg("{\"t\":\"voice_result\",\"intent\":\"none\",\"confidence\":0.9}", rep, sizeof rep);
    fake_run(20000);
    /* como el original [BOBBY-ARTE]: a los 1.2 s, 06 03 10 00 ("quiero el audio"); el K210 lo empuja; al cerrar, 06 01 10 00.
       Nunca 4B 00 (es para cuando Alma pregunta) */
    uint8_t f06m[K210_SMALL_LEN], f06[K210_SMALL_LEN];
    k210_small(f06m, 0x06, 0x03, 0x10, 0);
    k210_small(f06, 0x06, 0x01, 0x10, 0);
    fake_mic_reads = 0;
    t0 = fake_n_tx;
    app_post(&w);
    run_k210(1000);
    CHECK(tx_find(f06m, sizeof f06m, t0) < 0, "a 1 s de la palabra todavía no pide el audio (el K210 aún no graba)");
    run_k210(1500);
    CHECK(tx_find(f06m, sizeof f06m, t0) >= 0 && tx_find(f4b, sizeof f4b, t0) < 0, "a los 1.2 s: 06 03 10 00, sin 4B 00");
    CHECK(fake_mic_reads == 10 && fake_mic_bad_hdr == 0, "10 trozos con la cabecera del modo 1 (%d, malas %d)",
          fake_mic_reads, fake_mic_bad_hdr);
    CHECK(tx_find(f06, sizeof f06, tx_find(f06m, sizeof f06m, t0)) >= 0, "al cerrar: 06 01 10 00 (ya no quiere el audio)");
    int chunks = 0, last = 0, first_ok = 0;
    long n;
    while ((n = api_link_take(m, sizeof m)) > 0) {
        if (strstr(m, "\"t\":\"body_")) continue;   /* el hello de la mudanza (body.c) */
        if (chunks == 0) first_ok = strstr(m, "\"t\":\"voice\",\"seq\":0,\"last\":0,\"rate\":16000,\"pcm\":\"AAABAAIA") != NULL;
        last = strstr(m, "\"last\":1") != NULL;
        chunks++;
    }
    CHECK(chunks == 14 && last && first_ok, "32000 bytes en 14 trozos de 2400 (base64), el último con last 1 (%d)", chunks);
    int e1 = n_ex;
    api_link_msg("{\"t\":\"voice_result\",\"intent\":\"action\",\"action_id\":\"dance\",\"confidence\":0.9,"
                 "\"transcript\":\"baila\"}", rep, sizeof rep);
    fake_run(300);
    int ic = -1;
    for (int i = e1; i < n_ex; i++) if (ex[i].e.behavior == bx("bhv_dance") || ex[i].e.behavior == bx("bhv_refuse")) { ic = i; break; }
    CHECK(ic >= 0 && fake_log_contains("voz: \"baila\" → action dance"), "\"baila\" → EV_VOICE_COMMAND: baila o se niega");

    /* poca confianza: no entendió (antes, que acabe el baile si obedeció: una orden obedecida no la corta la escucha) */
    for (int k = 0; k < 150 && app_alma()->cur.active && app_alma()->cur.behavior == bx("bhv_dance"); k++) fake_run(1000);
    fake_run(20000);
    app_post(&w);
    run_k210(2500);
    while (api_link_take(m, sizeof m) > 0) {}
    e1 = n_ex;
    api_link_msg("{\"t\":\"voice_result\",\"intent\":\"action\",\"action_id\":\"dance\",\"confidence\":0.3}", rep, sizeof rep);
    fake_run(300);
    ic = -1;
    for (int i = e1; i < n_ex; i++) if (ex[i].e.behavior == bx("bhv_confused")) ic = i;
    CHECK(ic >= 0, "confianza 0.3 (< 0.6): EV_VOICE_FAILED → bhv_confused");

    /* si el K210 no empuja nada: 06 03 10 00 tres veces (cada 300 ms) y luego, sin audio, no entendió */
    fake_run(20000);
    fake_mic_on_06 = 0;
    int c06 = fake_mic_06;
    fake_log_clear();
    app_post(&w);
    run_k210(5000);
    CHECK(fake_mic_06 - c06 == 4 && fake_log_contains("casi nada de audio"), "sin audio: 3 pedidos + el de cerrar (%d) y EV_VOICE_FAILED", fake_mic_06 - c06);
    fake_mic_on_06 = 1;

    /* un elogio entendido: guiño al instante (que se note que entendió) */
    fake_run(20000);
    app_post(&w);
    run_k210(2500);
    while (api_link_take(m, sizeof m) > 0) {}
    int tw = fake_n_tx;
    api_link_msg("{\"t\":\"voice_result\",\"intent\":\"praise\",\"confidence\":0.9,\"transcript\":\"estás bien guapo\"}", rep, sizeof rep);
    CHECK(tx_has_text(tw, "stay_wink_1"), "elogio entendido: guiño al instante");
    fake_run(20000);
    app_post(&w);
    run_k210(2500);
    while (api_link_take(m, sizeof m) > 0) {}
    tw = fake_n_tx;
    api_link_msg("{\"t\":\"voice_result\",\"intent\":\"scold\",\"confidence\":0.9}", rep, sizeof rep);
    CHECK(tx_has_text(tw, "mood_sad"), "regaño entendido: carita triste al instante");

    /* sin enlace: no_network */
    fake_run(20000);
    app_set_link(0);
    fake_log_clear();
    app_post(&w);
    run_k210(2500);
    CHECK(fake_log_contains("sin enlace con el servidor") && api_link_take(m, sizeof m) == 0, "sin enlace: EV_VOICE_FAILED, nada que mandar");

    /* el servidor no contesta en 6 s */
    fake_run(20000);
    app_set_link(1);
    fake_log_clear();
    app_post(&w);
    run_k210(2500);
    while (api_link_take(m, sizeof m) > 0) {}
    run_k210(6500);
    CHECK(fake_log_contains("no contestó en 6 s"), "sin respuesta en 6 s: timeout");

    /* 0B 00 (fin de escucha) suelto no es otra palabra de activación */
    fake_run(20000);
    e1 = n_ex;
    fake_k210_small(0, 0x0B, 0, 0, 0);
    run_k210(500);
    ic = -1;
    for (int i = e1; i < n_ex; i++) if (ex[i].e.behavior == bx("bhv_listen")) ic = i;
    CHECK(ic < 0, "0B 00 no dispara otra escucha");
}

/* tamagotchi (dueño, 2026-10-30): comida real desde la app por el enlace; ella decide */
static void test_tamagotchi(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;
    alma_t *a = (alma_t *)app_alma();
    static char st[16384];
    char rep[256];
    api_state(st, sizeof st);
    CHECK(!a->care_enabled && strstr(st, "\"hunger\":-1"), "sin enlace: el hambre no corre (hunger -1 en el estado)");
    api_link_msg("{\"t\":\"welcome\"}", rep, sizeof rep);
    CHECK(a->care_enabled, "con enlace: el hambre corre");
    a->hunger = 0.69f;
    outbox_clear();
    fake_run(600000);
    CHECK(outbox_has("\"ev\":\"hungry\""), "cruza 0.7: aviso hungry al celular (%.2f)", a->hunger);
    a->hunger = 0.9f;
    a->food_like[FOOD_PIZZA] = 0.95f;
    a->last_food = -1;
    int e1 = n_ex, t1 = fake_n_tx;
    long m = api_link_msg("{\"t\":\"feed\",\"food\":\"pizza\",\"req\":7}", rep, sizeof rep);
    fake_run(500);
    CHECK(m > 0 && strstr(rep, "\"t\":\"feed_result\",\"req\":7,\"food\":\"pizza\""), "respuesta feed_result: %s", rep);
    if (strstr(rep, "\"accepted\":true")) {
        int ie = -1;
        for (int i = e1; i < n_ex; i++) if (ex[i].e.behavior == bx("bhv_eat")) ie = i;
        int eat = 0;
        for (int i = t1; i < fake_n_tx; i++)
            for (size_t k = 0; k + 18 <= fake_txs[i].n; k++) eat |= memcmp(fake_txs[i].b + k, "Daily_Eating", 12) == 0;
        CHECK(ie >= 0 && eat && a->hunger < 0.4f, "la acepta: bhv_eat con la escena de comer del original y baja el hambre");
    } else CHECK(0, "con hambre y su favorita debería aceptar: %s", rep);
    api_link_msg("{\"t\":\"feed\",\"food\":\"tornillos\",\"req\":8}", rep, sizeof rep);
    CHECK(strstr(rep, "\"error\":\"comida desconocida\""), "comida desconocida: error");
    api_link_msg("{\"t\":\"remote_play\",\"add_s\":120}", rep, sizeof rep);
    api_link_msg("{\"t\":\"remote_play\",\"add_s\":99999}", rep, sizeof rep);
    CHECK(a->counts.remote_play_s == 120, "juegos desde la app: suma los segundos (y descarta valores absurdos)");
    api_state(st, sizeof st);
    CHECK(strstr(st, "\"hunger\":") && strstr(st, "\"meals_today\":") && strstr(st, "\"sick\":false"), "estado: hambre, comidas, empacho");

    /* plan v2 (dueño, 2026-10-31): el servidor decide la comida y lleva peso y salud; el robot lo vive */
    static char big[2048];
    long mi = api_link_msg("{\"t\":\"welcome\"}", big, sizeof big);
    CHECK(mi > 0 && strstr(big, "\"t\":\"care_import\"") && strstr(big, "\"pizza\":0.9") && strstr(big, "\"medicina\":"),
          "welcome: le manda sus gustos al servidor (%.80s)", big);
    int e2 = n_ex;
    api_link_msg("{\"t\":\"care_state\",\"hunger\":0.6,\"sick\":true,\"cause\":\"sobrepeso\",\"weight_band\":\"obesidad\","
                 "\"energy\":0.35}", rep, sizeof rep);
    fake_run(300);
    CHECK(a->care_remote && a->sick && a->sick_cause == SICK_SOBREPESO && a->weight_band == WB_OBESIDAD
          && a->care_energy > 0.34f && a->care_energy < 0.36f && a->hunger > 0.59f && a->hunger < 0.61f, "care_state: lo aplica");
    int isk = -1;
    for (int i = e2; i < n_ex; i++) if (ex[i].e.behavior == bx("bhv_sick")) isk = i;
    CHECK(isk >= 0, "al enfermarse: bhv_sick");
    float hs = a->hunger;
    fake_run(600000);
    CHECK(a->hunger == hs, "con el servidor al mando, el robot ya no sube el hambre");
    api_state(st, sizeof st);
    CHECK(strstr(st, "\"care_v\":2") && strstr(st, "\"exercise\":{\"dance\":") && strstr(st, "\"energy\":"),
          "estado: care_v, ejercicio y energía para el servidor");
    int e3 = n_ex;
    api_link_msg("{\"t\":\"care_feed\",\"food\":\"brocoli\",\"accepted\":true,\"joy\":-0.07,\"bond\":-0.01,\"frust\":0,"
                 "\"hunger\":0.3,\"sick\":false,\"cause\":\"\",\"weight_band\":\"sano\",\"energy\":1}", rep, sizeof rep);
    fake_run(500);
    int ie3 = -1;
    for (int i = e3; i < n_ex; i++) if (ex[i].e.behavior == bx("bhv_eat")) ie3 = i;
    CHECK(ie3 >= 0 && !a->sick && a->hunger < 0.31f && a->weight_band == WB_SANO, "care_feed: come lo que dijo el servidor");
    int e4 = n_ex, r0 = a->counts.refused;
    fake_run(20000);
    api_link_msg("{\"t\":\"care_feed\",\"food\":\"helado\",\"accepted\":false,\"joy\":0,\"bond\":0,\"frust\":0.1,"
                 "\"hunger\":0.3,\"sick\":false,\"weight_band\":\"sano\",\"energy\":1}", rep, sizeof rep);
    fake_run(500);
    int ir4 = -1;
    for (int i = e4; i < n_ex; i++) if (ex[i].e.behavior == bx("bhv_refuse")) ir4 = i;
    CHECK(ir4 >= 0 && a->counts.refused == r0 + 1, "care_feed rechazado: bhv_refuse");

    /* juegos de la app (PLAN-JUEGOS, 2026-10-31): game_event */
    fake_run(120000);
    int e5 = n_ex, pd5 = a->counts.play_done;
    api_link_msg("{\"t\":\"game_event\",\"juego\":\"dados\",\"tipo\":\"gana_alma\",\"reaccion\":\"presumida\"}", rep, sizeof rep);
    fake_run(500);
    int iw5 = -1;
    for (int i = e5; i < n_ex; i++) if (ex[i].e.behavior == bx("bhv_happy_wiggle")) iw5 = i;
    CHECK(a->counts.play_done == pd5 + 1 && fake_log_contains("juego (app): dados"), "game_event gana_alma: cuenta como jugar con el dueño");
    CHECK(iw5 >= 0, "game_event gana_alma: se menea contenta");
    api_link_msg("{\"t\":\"game_event\",\"juego\":\"dados\",\"tipo\":\"trampa\"}", rep, sizeof rep);
    CHECK(fake_log_contains("game_event 'trampa' desconocido"), "game_event desconocido: solo se anota");
    app_set_link(0);
    CHECK(!a->care_enabled, "se cae el enlace: el hambre se detiene");
}

static void test_api(void)
{
    static char out[16384];
    CHECK(api_state(out, sizeof out) > 0, "/api/state");
    cJSON *j = cJSON_Parse(out);
    CHECK(j && cJSON_IsString(cJSON_GetObjectItem(j, "state")) && cJSON_IsObject(cJSON_GetObjectItem(j, "traits"))
          && cJSON_IsBool(cJSON_GetObjectItem(j, "memory_recovered")), "/api/state: state, traits, memory_recovered");
    CHECK(j && cJSON_IsNumber(cJSON_GetObjectItem(j, "wellbeing")) && cJSON_IsString(cJSON_GetObjectItem(j, "power"))
          && cJSON_IsString(cJSON_GetObjectItem(j, "going_home")) && cJSON_IsString(cJSON_GetObjectItem(j, "doing")),
          "/api/state: bienestar, alimentación, vuelta a casa y conducta (página del celular)");
    cJSON_Delete(j);
    CHECK(api_log_today(out, sizeof out) > 0, "/api/log/today");
    j = cJSON_Parse(out);
    int n = cJSON_GetArraySize(cJSON_GetObjectItem(j, "events"));
    CHECK(j && n > 0 && n <= F2_LOG_EVENTS, "/api/log/today: %d eventos (máx. %d)", n, F2_LOG_EVENTS);
    cJSON_Delete(j);
    CHECK(api_auth_ok("Bearer abc123", "abc123") && !api_auth_ok("Bearer abc124", "abc123") && !api_auth_ok("abc123", "abc123")
          && !api_auth_ok("Bearer ", ""), "token del dispositivo (07)");
}

/* ---- 10. consola: cada byte recibido queda en el log (1A, A10) ---- */
/* ---- música (dueño, 2026-10-30): el K210 manda 37 64 mientras suena; baila un rato y no otra vez en 5 min ---- */
static void test_music(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_run(60000);
    int d = bx("bhv_dance"), e0 = n_ex, t0 = fake_n_tx;
    fake_k210_small(0, 0x37, 100, 0, 0);
    fake_run(300);
    CHECK(first_exec_of(d, e0) >= 0, "37 64 (oigo música): baila");
    /* dueño, 2026-11-02: "él no debe poner música, sólo bailar": mientras suena la de afuera, las caras sin su .mp3 */
    fake_run(15000);
    int anims = 0, with_mp3 = 0;
    for (int i = t0; i < fake_n_tx && i < FAKE_TX_MAX; i++) {
        if (fake_txs[i].n < 8 || fake_txs[i].b[5] != 0x02) continue;
        anims++;
        for (size_t k = 0; k + 4 <= fake_txs[i].n; k++) if (!memcmp(fake_txs[i].b + k, ".mp3", 4)) { with_mp3++; break; }
    }
    CHECK(anims > 0 && with_mp3 == 0, "con música de afuera: %d caras, %d con su sonido (debe ser 0)", anims, with_mp3);
    int e1 = n_ex;
    for (int i = 0; i < 6; i++) { fake_run(10000); fake_k210_small(0, 0x37, 1, 0, 0); }   /* sigue la música 1 min */
    fake_run(300);
    CHECK(first_exec_of(d, e1) < 0, "la música sigue: no vuelve a bailar antes de 5 min");
    for (int i = 0; i < 25; i++) { fake_run(10000); fake_k210_small(0, 0x37, 1, 0, 0); }   /* 4 min más */
    fake_run(300);
    CHECK(first_exec_of(d, e1) >= 0, "a los 5 min, con la música sonando, baila otra vez");
    int e2 = n_ex;
    fake_k210_small(0, 0x37, 2, 0, 0);
    fake_run(300);
    CHECK(first_exec_of(d, e2) < 0, "37 02 (terminó): no baila");
    /* con caricias recientes no baila "de la nada" (dueño) */
    fake_run(310000);
    fake_sensors.touch_pet = 1; fake_run(50); fake_sensors.touch_pet = 0;
    fake_run(20000);
    int e3 = n_ex;
    fake_k210_small(0, 0x37, 100, 0, 0);
    fake_run(300);
    CHECK(first_exec_of(d, e3) < 0, "música 20 s después de una caricia: no baila");
    fake_run(110000);
    int e4 = n_ex;
    fake_k210_small(0, 0x37, 1, 0, 0);
    fake_run(300);
    int busy = app_alma()->cur.active && app_catalog()->b[app_alma()->cur.behavior].category != CAT_IDLE
               && app_catalog()->b[app_alma()->cur.behavior].category != CAT_EXPLORE;
    CHECK(busy || first_exec_of(d, e4) >= 0, "2 min después de la caricia, sin estar ocupada con él: baila");
}

/* ---- registro automático de una cara desconocida (dueño, 2026-10-30) ---- */
/* como el K210 real: cada animación termina con 08 00 (el falso no lo manda solo) */
static void run_k210(int64_t ms)
{
    for (int64_t t = 0; t < ms; t += 1000) { fake_run(ms - t < 1000 ? ms - t : 1000); fake_k210_small(0, 0x08, 0, 0, 0); }
}
static void test_autoregister(void)
{
    k210_scan_every_ms = 0;   /* vistazo continuo */
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    run_k210(6000);
    ((alma_t *)app_alma())->pause_until_s = 1e12;
    ((alma_t *)app_alma())->last_exec_t[bx("bhv_routine")] = 1e12;
    /* el dueño estuvo hace 30 s: una desconocida 65 s no se registra */
    fake_face_set(1, 0, 100, 80, 120, 120, "ivan");
    run_k210(2000);
    fake_face_set(0, 0, 0, 0, 0, 0, "");
    run_k210(30000);
    fake_face_set(1, PERC_FACE_UNKNOWN_ID, 20, 60, 90, 100, "");
    run_k210(65000);
    CHECK(!fake_log_contains("se registra como"), "con el dueño visto hace menos de 2 min: no registra");
    /* sin el dueño en 2 min: a los 60 s de verla, la registra */
    fake_face_set(0, 0, 0, 0, 0, 0, "");
    run_k210(130000);
    fake_face_set(1, PERC_FACE_UNKNOWN_ID, 20, 60, 90, 100, "");
    run_k210(50000);
    CHECK(!fake_log_contains("se registra como"), "a los 50 s todavía no");
    run_k210(12000);
    CHECK(fake_log_contains("se registra como \"amigo_"), "a los 60 s, sin el dueño: la registra (amigo_…)");
    run_k210(8000);
    CHECK(k210_face_register_state() == K210_REG_OK, "el K210 contesta 0F 01: registrada");
    /* lejos (recuadro chico): no */
    fake_log_clear();
    fake_face_set(-1, 0, 0, 0, 0, 0, "");
    run_k210(700000);
    fake_face_set(1, PERC_FACE_UNKNOWN_ID, 20, 60, 30, 30, "");
    run_k210(70000);
    CHECK(!fake_log_contains("se registra como"), "una cara lejana (30 px) no se registra");
    fake_face_set(-1, 0, 0, 0, 0, 0, "");
    CHECK(outbox_has("\"ev\":\"new_face\",\"name\":\"amigo_"), "aviso new_face al celular cuando el K210 confirma el registro");
}

/* ---- distancia (VL53L0X): obstáculo y freno al caminar hacia adelante ---- */
static void test_obstacle(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;
    fake_sensors.tof_mm = 500;
    fake_run(500);
    CHECK(perception_front_mm() == 500, "distancia leída: 500 mm");
    fake_log_clear();
    app_console_key('W');   /* paso adelante de prueba */
    fake_run(300);
    fake_sensors.tof_mm = 50;
    fake_run(300);
    CHECK(!motion_active() && fake_log_contains("borde u obstáculo adelante, la marcha se detiene"), "algo a 5 cm: la marcha hacia adelante se detiene");
    CHECK(fake_log_contains("EV_OBSTACLE") || app_alma()->last_ev_t[EV_OBSTACLE] > -1e11, "EV_OBSTACLE al acercarse a menos de 10 cm");
    fake_sensors.tof_mm = -1;
    fake_sensors.on_charger = 1;
}

/* ---- volver a casa (home.c; CASA.md [BOBBY-ARTE]) ---- */
static void test_home(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0; fake_sensors.on_usb = 0;
    fake_run(6000);
    ((alma_t *)app_alma())->pause_until_s = 1e12;   /* sin conductas propias durante la prueba */
    /* no la ve: busca girando de a 15° */
    fake_base_set(0, 160, 30);
    home_start("prueba");
    CHECK(home_get() == HOME_SEARCH, "empieza buscando");
    fake_run(1500);
    CHECK(fake_base_polls > 5 && motion_active(), "modo base (35 01) y gira buscando");
    int turns0 = fake_log_count("motion: explore_turn_left1");
    for (int i = 0; i < 60; i++) { fake_yaw += 4; fake_run(100); }
    CHECK(fake_log_count("motion: explore_turn_left1") - turns0 >= 3, "cada ~15° del giroscopio corta el giro y sigue buscando (%d giros)",
          fake_log_count("motion: explore_turn_left1") - turns0);
    /* la ve lejos y a la derecha: gira hacia ella, luego avanza */
    fake_base_set(1, 290, 30);
    for (int i = 0; i < 80 && home_get() == HOME_SEARCH; i++) { fake_yaw += 4; fake_run(100); }
    CHECK(home_get() == HOME_APPROACH, "la ve: se acerca");
    for (int i = 0; i < 40 && motion_active(); i++) { fake_yaw -= 3; fake_run(100); }
    fake_base_set(1, 162, 30);
    for (int i = 0; i < 300 && home_get() == HOME_APPROACH; i++) {
        fake_run(100);
        if (i == 100) fake_base_set(1, 160, 45);
        if (i == 150) { fake_base_set(1, 159, 70); fake_sensors.tof_mm = 250; }   /* cerca pero a 25 cm: otro paso */
        if (i == 199) CHECK(home_get() == HOME_APPROACH, "a 250 mm no gira todavía: un paso más");
        if (i == 200) { fake_base_set(1, 158, 100); fake_sensors.tof_mm = 140; }   /* a 14 cm: aquí gira */
    }
    CHECK(home_get() == HOME_TURN, "a 140 mm del láser (120–160): media vuelta");
    /* medido 2026-11-02: un giro de fábrica da ~32° y la media vuelta se quedaba en uno: si acaba antes, otro */
    int tl0 = fake_log_count("motion: explore_turn_left1");
    fake_yaw += 30;
    for (int i = 0; i < 40 && home_get() == HOME_TURN; i++) fake_run(100);
    CHECK(home_get() == HOME_TURN && fake_log_count("motion: explore_turn_left1") > tl0,
          "media vuelta: el giro acaba con 30° y gira otra vez (%d giros)", fake_log_count("motion: explore_turn_left1") - tl0);
    for (int i = 0; i < 100 && home_get() == HOME_TURN; i++) { fake_yaw += 5; fake_run(100); }
    CHECK(home_get() == HOME_DOCK, "con ~170° de giro: sube de espaldas");
    fake_sensors.tof_mm = -1;
    app_post(&(alma_ev){EV_CLIFF, -1, -1, -1, 0, 0, 0, ALMA_CLIFF_REAR});   /* la rampa de la base, de espaldas */
    fake_run(100);
    CHECK(home_get() == HOME_DOCK && fake_log_contains("casa: borde junto a la base"), "subiendo: la rampa no cancela la vuelta");
    fake_run(5000);
    fake_sensors.on_charger = 1; fake_sensors.on_usb = 0;   /* llegó: cargador y RX0 en 0 */
    fake_run(500);
    CHECK(home_get() == HOME_DONE && fake_log_contains("casa: en la Home Station"), "Home Station detectada: llegó");
    /* con "usb on" (pruebas con el cable) el USB no cuenta como Home Station; un borde la cancela */
    app_usb_motion(1);
    fake_sensors.on_charger = 0;
    fake_base_set(-1, 0, 0);
    home_start("prueba 2");
    fake_sensors.on_charger = 1; fake_sensors.on_usb = 1;
    fake_run(500);
    CHECK(home_active(), "con el USB no se da por llegada");
    fake_sensors.on_charger = 0; fake_sensors.on_usb = 0;
    app_post(&(alma_ev){EV_CLIFF, -1, -1, -1, 0, 0, 0, 1});
    fake_run(100);
    CHECK(!home_active() && fake_log_contains("casa: cancelada"), "un borde cancela la vuelta a casa");
    /* con el USB puesto (dueño, 2026-11-02: para depurar): la vuelta se prueba igual; al terminar los intentos de subir
       no se puede saber si llegó, así que termina sin aviso de falla y deja los pines en el registro */
    fake_sensors.on_charger = 1; fake_sensors.on_usb = 1;
    outbox_clear();
    fake_base_set(1, 158, 130);   /* sin láser: con el tamaño en la cámara */
    home_start("prueba USB");
    for (int i = 0; i < 300 && home_get() != HOME_TURN; i++) fake_run(100);
    for (int i = 0; i < 100 && home_get() == HOME_TURN; i++) { fake_yaw += 5; fake_run(100); }
    CHECK(home_get() == HOME_DOCK, "con USB: llega a subir de espaldas");
    for (int i = 0; i < 1200 && home_active(); i++) fake_run(100);
    CHECK(home_get() == HOME_DONE && fake_log_contains("casa (USB): terminó") && !outbox_has("home_failed")
          && fake_log_contains("casa: intento 8 de subir; GPIO36"), "con USB: intenta subir 8 veces, registra los pines y no avisa falla");
    /* atorada en la media vuelta (dueño, 2026-11-02): si en 3 giros no avanza ni 5°, salta de lado y vuelve a buscar */
    fake_log_clear();
    home_start("prueba atorada");
    for (int i = 0; i < 300 && home_get() != HOME_TURN; i++) fake_run(100);
    for (int i = 0; i < 400 && home_get() == HOME_TURN; i++) fake_run(100);   /* el giroscopio no se mueve */
    CHECK(fake_log_contains("casa: no gira (3 giros") && fake_log_contains("casa: atorada: 2 saltos de lado (cliff_L)")
          && home_get() == HOME_SEARCH, "atorada al girar a la izquierda: salta a la derecha y vuelve a buscar");
    for (int i = 0; i < 60; i++) fake_run(100);
    CHECK(fake_log_count("motion: cliff_L") == 2, "dos saltos (%d)", fake_log_count("motion: cliff_L"));
    app_console_key('0');
    fake_run(100);
    CHECK(!home_active() && fake_log_contains("casa: cancelada (PARO)"), "0 (PARO) cancela la vuelta a casa");
    fake_sensors.on_usb = 0;
    app_usb_motion(0);
    /* sin "usb on" cualquier cargador es casa (con la base inalámbrica RX0 a veces sale alto, 2026-11-03) */
    fake_sensors.on_charger = 1; fake_sensors.on_usb = 1;
    home_start("prueba usb");
    CHECK(!home_active() && fake_log_contains("casa: ya está en la Home Station (prueba usb)"), "con un cargador que parece USB: ya está en casa");
    fake_sensors.on_usb = 0;
}

/* hora de dormir (dueño, 2026-11-01): a las 20:00 va sola a la base; si no llega en 3 intentos duerme donde está; con
   el USB puesto duerme ahí mismo; a las 8:00 despierta */
static void test_bedtime(void)
{
    const double D = 20758.0 * 86400.0;   /* 2026-11-01 00:00 local */
    app_preset_clock(D + 19 * 3600.0 + 50 * 60);
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0; fake_sensors.on_usb = 0;
    fake_base_set(0, 160, 30);   /* no ve la base */
    fake_log_clear();
    fake_run(9LL * 60000);   /* 19:59 */
    CHECK(!fake_log_contains("hora de dormir"), "antes de las 20:00 no se va a la base");
    for (int i = 0; i < 60 * 60 && app_alma()->state != ST_SLEEPING; i++) { fake_yaw += 2; fake_run(1000); }
    CHECK(fake_log_count("casa: volver a la Home Station (hora de dormir)") == 3, "a las 20:00 va sola a la base: 3 intentos (%d)",
          fake_log_count("casa: volver a la Home Station (hora de dormir)"));
    CHECK(fake_log_contains("duerme aquí") && app_alma()->state == ST_SLEEPING, "no llegó: duerme donde está (estado %d)",
          (int)app_alma()->state);
    /* con el USB puesto: duerme ahí, sin ir a la base */
    app_preset_clock(D + 19 * 3600.0 + 55 * 60);
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 1; fake_sensors.on_usb = 1;
    fake_log_clear();
    fake_run(30LL * 60000);   /* 20:25 */
    CHECK(app_alma()->state == ST_SLEEPING && !fake_log_contains("hora de dormir"), "con el USB: duerme ahí mismo (estado %d)",
          (int)app_alma()->state);
    fake_run(11LL * 3600000);   /* 7:25 */
    CHECK(app_alma()->state == ST_SLEEPING, "a las 7:25 sigue dormida");
    fake_log_clear();
    fake_run(3600000);   /* 8:25 */
    CHECK(app_alma()->state != ST_SLEEPING && fake_log_contains("conducta bhv_stretch"), "a las 8:00 despierta y se estira (estado %d)",
          (int)app_alma()->state);
    app_preset_clock(-1);
    fake_sensors.on_usb = 0;
}

/* ver de cerca (dueño, 2026-11-01): EV_OBSTACLE → foto del K210 (como la pintura del original) → trozos al servidor →
   "seen" → reacción; como mucho una foto cada 3 minutos */
static int b64_dec(const char *s, uint8_t *out, size_t cap)
{
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t o = 0;
    uint32_t v = 0;
    int bits = 0;
    for (; *s && *s != '"'; s++) {
        const char *q = strchr(T, *s);
        if (*s == '=' || !q) continue;
        v = v << 6 | (uint32_t)(q - T);
        bits += 6;
        if (bits >= 8) { bits -= 8; if (o < cap) out[o++] = (uint8_t)(v >> bits); }
    }
    return (int)o;
}

static int tx_count(const uint8_t *b, size_t n, int from)
{
    int c = 0;
    for (int i = from; i < fake_n_tx; i++) c += tx_eq(i, b, n);
    return c;
}

static void test_vision(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;
    static char rep[64], m[4200];
    api_link_msg("{\"t\":\"welcome\",\"time\":1}", rep, sizeof rep);
    while (api_link_take(m, sizeof m) > 0) {}
    fake_photo_late = 1;   /* la primera petición llega antes de que la foto esté */
    int t0 = fake_n_tx;
    alma_ev ob = {EV_OBSTACLE, -1, -1, -1, 60, 0, 0, 0};
    app_post(&ob);
    run_k210(6000);
    uint8_t f[96];
    size_t n;
    k210_small(f, 0x67, 0x65, 0, 0);
    CHECK(tx_find(f, K210_SMALL_LEN, t0) >= 0, "algo a 10 cm: 67 65 (modo cámara)");
    n = k210_ext(f, sizeof f, 0x49, "alma_1", k210_payload_mode);
    CHECK(tx_find(f, n, t0) >= 0, "ext 49 \"alma_1\" (tomar la foto)");
    n = k210_ext(f, sizeof f, 0x40, "/photo/alma_1.jpg", k210_payload_mode);
    CHECK(tx_count(f, n, t0) == 2, "ext 40 con la ruta, otra vez tras un 05 vacío (%d)", tx_count(f, n, t0));
    CHECK(fake_photo_reads == 3 && fake_photo_bad_hdr == 0, "3 trozos de hasta 10 240 bytes por SPI, cabecera del modo 2 (%d, malas %d)",
          fake_photo_reads, fake_photo_bad_hdr);
    CHECK(fake_log_contains("foto: 1D 12 (lista)"), "pide el archivo cuando el K210 avisa 1D 12");
    k210_small(f, 0x67, 0x00, 0, 0);
    int closed = tx_find(f, K210_SMALL_LEN, t0) >= 0;
    n = k210_ext(f, sizeof f, 0x4E, "alma_1", k210_payload_mode);
    CHECK(closed && tx_find(f, n, t0) >= 0 && fake_log_contains("foto \"alma_1\": lista (25000 bytes"),
          "foto lista: sale del modo cámara (67 00) y la borra de la SD (ext 4E)");
    static uint8_t got[FAKE_PHOTO_LEN + 16];
    int chunks = 0, got_n = 0, last = 0;
    long k;
    while ((k = api_link_take(m, sizeof m)) > 0) {
        const char *j = strstr(m, "\"t\":\"photo\"") ? strstr(m, "\"jpg\":\"") : NULL;
        if (!j) continue;
        got_n += b64_dec(j + 7, got + got_n, sizeof got - (size_t)got_n);
        last = strstr(m, "\"last\":1") != NULL;
        chunks++;
    }
    CHECK(chunks == (FAKE_PHOTO_LEN + VISION_CHUNK - 1) / VISION_CHUNK && last && got_n == FAKE_PHOTO_LEN
          && memcmp(got, fake_photo, FAKE_PHOTO_LEN) == 0,
          "la foto llega entera al servidor, con los bytes en orden (%d trozos, %d bytes)", chunks, got_n);
    int novel = app_alma()->counts.novel_ok;
    int e1 = n_ex;
    api_link_msg("{\"t\":\"seen\",\"objeto\":\"una pelota roja\",\"reaccion\":\"contenta\",\"conducta\":\"bhv_play_bow\"}",
                 rep, sizeof rep);
    fake_run(300);
    CHECK(fake_log_contains("vista: una pelota roja → contenta, bhv_play_bow") && app_alma()->counts.novel_ok == novel + 1,
          "\"seen\": contenta, y cuenta como novedad bien llevada");
    CHECK(first_exec_of(bx("bhv_play_bow"), e1) >= 0, "hace la conducta que eligió Haiku (bhv_play_bow: invita a jugar)");
    /* dentro de 3 minutos no vuelve a ver */
    fake_run(60000);
    t0 = fake_n_tx;
    app_post(&ob);
    run_k210(3000);
    k210_small(f, 0x67, 0x65, 0, 0);
    CHECK(tx_find(f, K210_SMALL_LEN, t0) < 0, "al minuto: no toma otra foto");
    fake_run(120000);
    t0 = fake_n_tx;
    app_post(&ob);
    run_k210(3000);
    n = k210_ext(f, sizeof f, 0x49, "alma_2", k210_payload_mode);
    CHECK(tx_find(f, n, t0) >= 0, "pasados 3 minutos: otra foto (alma_2)");
    while (api_link_take(m, sizeof m) > 0) {}
}

/* foto del dueño (dueño, 2026-11-02): de frente 5 s → gesto de cámara → foto con "kind":"owner"; cada 30 min y de día */
static void test_vision_owner(void)
{
    k210_scan_every_ms = 0;   /* vistazo continuo: la cara se ve todo el tiempo */
    vision_owner_on = 1;
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;
    static char rep[64], m[4200];
    api_link_msg("{\"t\":\"welcome\",\"time\":1}", rep, sizeof rep);
    while (api_link_take(m, sizeof m) > 0) {}
    fake_run(60000);
    fake_log_clear();
    int t0 = fake_n_tx;
    fake_face_set(1, 0, 100, 80, 120, 120, "persona0");
    run_k210(3000);
    CHECK(!fake_log_contains("gesto de cámara"), "su dueño de frente 3 s: todavía no");
    run_k210(9000);
    uint8_t f[200];
    size_t n = anim(f, sizeof f, VISION_OWNER_GESTURE, NULL, 0);
    int ig = tx_find(f, n, t0);
    size_t n49 = k210_ext(f, sizeof f, 0x49, "alma_1", k210_payload_mode);
    int ip = tx_find(f, n49, t0);
    CHECK(fake_log_count("gesto de cámara") == 1 && ig >= 0 && ip > ig, "de frente 5 s: gesto de cámara y después la foto (%d, %d)", ig, ip);
    int chunks = 0, owner = 0;
    while (api_link_take(m, sizeof m) > 0)
        if (strstr(m, "\"t\":\"photo\"")) { chunks++; owner += strstr(m, "\"kind\":\"owner\"") != NULL; }
    CHECK(chunks > 1 && owner == 1, "la foto va al servidor marcada como del dueño en el primer trozo (%d trozos, %d)", chunks, owner);
    api_link_msg("{\"t\":\"seen\",\"objeto\":\"trabajando en la compu\",\"reaccion\":\"curiosa\",\"conducta\":\"bhv_babble\"}",
                 rep, sizeof rep);
    fake_run(300);
    CHECK(fake_log_contains("vista: trabajando en la compu → curiosa, bhv_babble"), "reacciona a lo que hace su dueño");
    run_k210(20 * 60000);   /* 20 min de frente */
    CHECK(fake_log_count("gesto de cámara") == 1, "dentro de 30 min no toma otra");
    run_k210(11 * 60000);
    CHECK(fake_log_count("gesto de cámara") == 2, "pasados 30 min, otra");
    while (api_link_take(m, sizeof m) > 0) {}
    fake_face_set(-1, 0, 0, 0, 0, 0, "");

    /* de noche no (su ventana de 20:00 a 8:00) */
    const double D = 20756.0 * 86400.0;   /* 2026-10-30 00:00 local */
    app_preset_clock(D + 22 * 3600.0);
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;
    api_link_msg("{\"t\":\"welcome\",\"time\":1}", rep, sizeof rep);
    fake_log_clear();
    fake_face_set(1, 0, 100, 80, 120, 120, "persona0");
    run_k210(30000);
    CHECK(!fake_log_contains("gesto de cámara"), "a las 22:00, aunque la vea de frente: no");
    while (api_link_take(m, sizeof m) > 0) {}
    fake_face_set(-1, 0, 0, 0, 0, 0, "");
    app_preset_clock(-1);
    k210_scan_every_ms = 15000;
    vision_owner_on = 0;
}

/* trucos (dueño, 2026-11-01): el servidor manda el movimiento y el robot lo hace con su cara; la foto que sube el dueño
   desde la app ("seen" con origen "app") hace reaccionar al robot aunque él no haya tomado ninguna */
static void test_tricks(void)
{
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;
    fake_run(5000);
    static char rep[160];
    const alma_behavior *t = &app_catalog()->b[bx("bhv_trick")];
    int cat = -1;
    for (int i = 0; i < t->n_opt; i++) if (strcmp(t->opt[i].mot[0], "Cat") == 0) cat = i;
    CHECK(t->n_opt == 32 && cat >= 0, "bhv_trick: 32 movimientos, entre ellos Cat (%d)", t->n_opt);
    int e1 = n_ex;
    api_link_msg("{\"t\":\"trick\",\"mot\":\"Cat\",\"req\":7}", rep, sizeof rep);
    CHECK(strcmp(rep, "{\"t\":\"trick_result\",\"req\":7,\"done\":true,\"why\":\"\"}") == 0, "contesta que lo hace: %s", rep);
    fake_run(300);
    int i = first_exec_of(bx("bhv_trick"), e1);
    CHECK(i >= 0 && ex[i].e.option == cat, "hace bhv_trick con la opción de Cat");
    api_link_msg("{\"t\":\"trick\",\"mot\":\"bailar_inventado\",\"req\":8}", rep, sizeof rep);
    CHECK(strstr(rep, "\"done\":false") && strstr(rep, "no conoce ese movimiento"), "un movimiento que no existe: no (%s)", rep);
    /* nunca lo elige sola */
    fake_run(10 * 60 * 1000);
    int own = 0;
    for (int k = i + 1; k < n_ex; k++) own += ex[k].e.behavior == bx("bhv_trick");
    CHECK(own == 0, "en 10 min no hace trucos por su cuenta (%d)", own);
    int e2 = n_ex;
    api_link_msg("{\"t\":\"seen\",\"origen\":\"app\",\"objeto\":\"Alma con gorro\",\"reaccion\":\"contenta\",\"conducta\":\"bhv_happy_wiggle\"}",
                 rep, sizeof rep);
    fake_run(300);
    CHECK(fake_log_contains("vista: Alma con gorro → contenta, bhv_happy_wiggle") && first_exec_of(bx("bhv_happy_wiggle"), e2) >= 0,
          "foto de la app: reacciona sin haber tomado foto");
}

/* sin SNTP, la hora local que manda el servidor al conectar (2026-11-01: un arranque quedó en las 8:00) */
static void test_clock_from_server(void)
{
    app_preset_clock(-1);
    boot_app(K_REPLY_SAM);
    CHECK(!app_clock_real(), "sin SNTP: hora de respaldo");
    static char rep[64];
    const double L = 20758.0 * 86400.0 + 12 * 3600.0 + 34 * 60;   /* 2026-11-01 12:34 local */
    api_link_msg("{\"t\":\"welcome\",\"time\":1793558040,\"local\":1793536440}", rep, sizeof rep);
    CHECK(app_clock_real() && fabs(app_now_s() - L) < 2 && fake_log_contains("hora: sin SNTP; la del servidor (12:34)"),
          "al conectar toma la hora local del servidor (%.0f)", app_now_s());
    fake_run(5000);
    api_link_msg("{\"t\":\"welcome\",\"time\":1,\"local\":1700000000}", rep, sizeof rep);
    CHECK(fabs(app_now_s() - (L + 5)) < 2, "con hora real no la vuelve a cambiar");
    app_preset_clock(-1);
}

#if ALMA_MEM_WRITE_ENABLED
/* respaldo de la memoria en el servidor (dueño, 2026-11-01): manda la copia; con la memoria borrada la pide y la carga;
   con memoria, nunca la pisa */
static void test_backup(void)
{
    static char rep[64], m[4200], chunk[4][4200];
    fake_mem_ok = 0;   /* flash nueva */
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    CHECK(app_mem_empty(), "flash nueva: memoria vacía");
    api_link_msg("{\"t\":\"welcome\",\"time\":1}", rep, sizeof rep);
    int req = 0;
    while (api_link_take(m, sizeof m) > 0) req += strstr(m, "\"t\":\"mem_restore_req\"") != NULL;
    CHECK(req == 1, "memoria vacía al conectar: pide la última copia una vez (%d)", req);
    api_link_msg("{\"t\":\"mem_restore\",\"none\":1}", rep, sizeof rep);
    CHECK(fake_log_contains("el servidor no tiene copias"), "sin copias en el servidor: empieza de cero");
    /* vive, aprende y se guarda */
    alma_t *a = (alma_t *)app_alma();
    a->age_days = 7;
    a->wellbeing = 321;
    alma_mem_flush(app_mem(), a);
    CHECK(app_mem()->b[MEM_AFFECT].status == MEM_OK, "ya tiene memoria escrita");
    fake_run((BACKUP_FIRST_S + 5) * 1000LL);
    int nc = 0, last = 0, age_ok = 0;
    long k;
    static uint8_t exp[BACKUP_MAX];
    int exp_n = 0;
    while ((k = api_link_take(m, sizeof m)) > 0) {
        const char *d = strstr(m, "\"t\":\"mem_backup\"") ? strstr(m, "\"data\":\"") : NULL;
        if (!d || nc >= 4) continue;
        age_ok = strstr(m, "\"age\":7") != NULL;
        last = strstr(m, "\"last\":1") != NULL;
        exp_n += b64_dec(d + 8, exp + exp_n, sizeof exp - (size_t)exp_n);
        snprintf(chunk[nc], sizeof chunk[0], "{\"t\":\"mem_restore\",\"seq\":%d,\"last\":%d,%s", nc, last, d);
        nc++;
    }
    CHECK(nc >= 1 && last && age_ok && exp_n > 1000 && memcmp(exp, "ALMX", 4) == 0,
          "a los 2 min de conectar manda su memoria (%d trozos, %d bytes, formato de exportación)", nc, exp_n);
    /* la reprograman y la memoria queda en blanco: pide la copia y la carga */
    fake_mem_ok = 0;
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000) && app_mem_empty() && app_alma()->age_days == 0, "memoria borrada: día 0");
    api_link_msg("{\"t\":\"welcome\",\"time\":1}", rep, sizeof rep);
    while (api_link_take(m, sizeof m) > 0) {}
    for (int i = 0; i < nc; i++) api_link_msg(chunk[i], rep, sizeof rep);
    CHECK(fake_log_contains("memoria restaurada desde el servidor") && app_alma()->age_days == 7 && !app_mem_empty(),
          "con la copia del servidor vuelve a su día 7 (día %d, bienestar %.0f)", app_alma()->age_days, app_alma()->wellbeing);
    int ev = 0;
    while (api_link_take(m, sizeof m) > 0) ev += strstr(m, "\"ev\":\"mem_restored\"") != NULL;
    CHECK(ev == 1, "avisa al servidor que se restauró");
    /* con memoria: no pide copias y una copia que llegue no la pisa */
    a->age_days = 9;
    alma_mem_flush(app_mem(), a);
    boot_app(K_REPLY_SAM);
    api_link_msg("{\"t\":\"welcome\",\"time\":1}", rep, sizeof rep);
    req = 0;
    while (api_link_take(m, sizeof m) > 0) req += strstr(m, "mem_restore_req") != NULL;
    for (int i = 0; i < nc; i++) api_link_msg(chunk[i], rep, sizeof rep);
    CHECK(req == 0 && app_alma()->age_days == 9, "con memoria no pide copia ni se deja pisar (día %d)", app_alma()->age_days);
}
#endif

/* ---- mudanza entre cuerpos (body.c, PLAN-RELOJ-v2 5, 5.7, 6.2, 6.4 y 7): el robot contra un servidor de mentira ---- */
#define BMSG 400
static char bmsg[BMSG][UPLINK_MAX + 1];   /* lo que el robot mandó (solo body_*) */
static int64_t bmsg_t[BMSG];
static int nbmsg;

/* saca todo lo que el robot manda y guarda los body_*; devuelve el nonce del último hello, o −1 */
static int body_drain(void)
{
    static char m[UPLINK_MAX + 1];
    int nonce = -1;
    while (api_link_take(m, sizeof m) > 0) {
        if (!strstr(m, "\"t\":\"body_")) continue;
        if (strstr(m, "\"t\":\"body_hello\"")) {
            cJSON *j = cJSON_Parse(m);
            nonce = cJSON_GetObjectItem(j, "nonce")->valueint;
            cJSON_Delete(j);
        }
        if (nbmsg < BMSG) { snprintf(bmsg[nbmsg], sizeof bmsg[0], "%s", m); bmsg_t[nbmsg++] = fake_ms; }
    }
    return nonce;
}

static void body_say(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void body_say(const char *fmt, ...)
{
    static char m[UPLINK_MAX + 1], rep[UPLINK_MAX];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(m, sizeof m, fmt, ap);
    va_end(ap);
    api_link_msg(m, rep, sizeof rep);
}

static int bmsg_find(const char *needle, int from)
{
    for (int i = from; i < nbmsg; i++) if (strstr(bmsg[i], needle)) return i;
    return -1;
}

static int bmsg_count(const char *needle, int from)
{
    int n = 0;
    for (int i = from; i < nbmsg; i++) n += strstr(bmsg[i], needle) != NULL;
    return n;
}

static int last_hello(void)
{
    for (int i = nbmsg - 1; i >= 0; i--) if (strstr(bmsg[i], "\"t\":\"body_hello\"")) return i;
    return -1;
}

/* un hello ahora (body_poke) y su nonce */
static int body_hello_now(void)
{
    body_say("{\"t\":\"body_poke\"}");
    return body_drain();
}

/* corre ms en pasos de 1 s; a cada hello le contesta reply (con %d para el nonce), o nada si es NULL */
static void body_pump(int64_t ms, const char *reply)
{
    for (int64_t t = 0; t < ms; t += 1000) {
        fake_run(1000);
        int nonce = body_drain();
        if (nonce > 0 && reply) body_say(reply, nonce);
    }
}

/* junta el paquete de tipo kind ("backup"/"release") desde el mensaje from; head = su primer trozo. Bytes o 0 */
static int pkg_bytes(const char *kind, int from, uint8_t *out, size_t cap, char *head, size_t hcap, int *chunks)
{
    char k[32];
    snprintf(k, sizeof k, "\"kind\":\"%s\"", kind);
    int n = 0;
    *chunks = 0;
    for (int i = from; i < nbmsg; i++) {
        if (!strstr(bmsg[i], "\"t\":\"body_pkg\"") || !strstr(bmsg[i], k)) continue;
        if (strstr(bmsg[i], "\"seq\":0,")) { n = 0; *chunks = 0; snprintf(head, hcap, "%s", bmsg[i]); }
        n += b64_dec(strstr(bmsg[i], "\"data\":\"") + 8, out + n, cap - (size_t)n);
        (*chunks)++;
        if (strstr(bmsg[i], "\"last\":1")) return n;
    }
    return 0;
}

static size_t b64_enc(const uint8_t *in, size_t len, char *out)
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
    out[o] = 0;
    return o;
}

/* el servidor entrega un paquete: la directiva deliver y los trozos body_pkg_in (reloj.robot_out) */
static void body_deliver(int nonce, const char *mid, int n, const char *meta, int seq, const uint8_t *p, int len)
{
    static char b[BODY_CHUNK / 3 * 4 + 8];
    body_say("{\"t\":\"body\",\"nonce\":%d,\"d\":\"deliver\",\"mid\":\"%s\",\"n\":%d,\"meta\":%s,\"at\":1000,\"now\":4600,"
             "\"reason\":\"boton\",\"seq\":%d}", nonce, mid, n, meta, seq);
    int parts = (len + BODY_CHUNK - 1) / BODY_CHUNK;
    for (int k = 0; k < parts; k++) {
        int m = len - k * BODY_CHUNK < BODY_CHUNK ? len - k * BODY_CHUNK : BODY_CHUNK;
        b64_enc(p + k * BODY_CHUNK, (size_t)m, b);
        body_say("{\"t\":\"body_pkg_in\",\"mid\":\"%s\",\"seq\":%d,\"last\":%d,\"data\":\"%s\"}", mid, k, k == parts - 1, b);
    }
}

#define KEEP1  "{\"t\":\"body\",\"nonce\":%d,\"d\":\"keep\",\"n\":1,\"lease_s\":180,\"events\":[]}"
#define ABSENT5 "{\"t\":\"body\",\"nonce\":%d,\"d\":\"absent\",\"n\":5}"

/* sin Alma (se mudó al reloj), fuera de la base el cuerpo vuelve solo a su casa; al llegar, la animación de carga y luego
   el reloj con los ojitos (dueño, 2026-11-02) */
static void test_body_goes_home(void)
{
    k210_scan_every_ms = 15000;
    fake_mem_ok = 0;
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0; fake_sensors.on_usb = 0;
    nbmsg = 0;
    body_say("{\"t\":\"welcome\",\"time\":1}");
    body_pump(20000, KEEP1);
    CHECK(body_protocol() && body_runs(), "con el protocolo de mudanza, Alma aquí");
    fake_run(200000);   /* sin renovar el turno: a los 180 s se duerme sola (Alma está en el otro cuerpo) */
    CHECK(app_body_asleep() && fake_log_contains("casa: volver a la Home Station (Alma no está"),
          "sin Alma y fuera de la base: el cuerpo vuelve a su casa");
    int t0 = fake_n_tx;
    fake_sensors.on_charger = 1;   /* llegó: cargador y RX0 en 0 */
    fake_run(3000);
    uint8_t fa[256];
    size_t fan = anim(fa, sizeof fa, "charge_get_in_new", NULL, 0);
    CHECK(home_get() == HOME_DONE && tx_find(fa, fan, t0) >= 0, "llegó sola a la base sin Alma: la animación de carga");
    run_k210(20000);   /* el K210 avisa al terminar cada animación (08 00) */
    int clock = 0;
    for (int k = t0; k < fake_n_tx && !clock; k++)
        for (size_t b = 0; b + 22 <= fake_txs[k].n; b++) if (!memcmp(fake_txs[k].b + b, "/test/ausente_reloj.avi", 22)) { clock = 1; break; }
    CHECK(clock, "después, el reloj con los ojitos");
    /* sin Alma también recibe caras y las sube al K210 (2026-11-03: ausente_reloj no llegaba y se veía dormido) */
    static char rep2[256];
    fake_file_ack_cmd = 0x21;
    fake_file_rx_n = 0;
    outbox_clear();
    fake_log_clear();
    api_link_msg("{\"t\":\"cara\",\"nombre\":\"ausente_reloj\",\"size\":3,\"seq\":0,\"last\":true,\"b64\":\"AAEC\"}", rep2, sizeof rep2);
    for (int i = 0; i < 200 && !fake_log_contains("ya está en la SD"); i++) fake_run(100);
    CHECK(app_body_asleep() && fake_file_rx_n == 3 && outbox_has("{\"t\":\"cara_ok\",\"nombre\":\"ausente_reloj\"}"), "sin Alma: la cara se sube al K210");
    fake_sensors.soc_pct = 42; fake_sensors.on_charger = 1; fake_sensors.on_usb = 0;
    fake_run(4000);
    CHECK(fabsf(app_alma()->soc_pct - 42) < 1 && app_alma()->on_charger && !fake_legs_on,
          "sin Alma: batería y cargador al día, y en la base las patas sin corriente");
    /* con el USB puesto (mesa de pruebas) no se va */
    boot_app(K_REPLY_SAM);
    run_until_ready(15000);
    fake_sensors.on_charger = 1; fake_sensors.on_usb = 1;
    fake_run(3000);
    app_body_sleep("prueba: con USB");
    CHECK(!home_active(), "con el USB puesto no se va (mesa de pruebas)");
    fake_sensors.on_usb = 0;
}

static void test_body(void)
{
    static uint8_t pkg[BODY_PKG_MAX], pkg2[BODY_PKG_MAX];
    static char head[UPLINK_MAX + 1];
    int chunks;
    k210_scan_every_ms = 15000;   /* el de reposo del robot */

    /* 1. compatibilidad: un servidor viejo nunca contesta body_hello → Alma corre exactamente como siempre */
    fake_mem_ok = 0;
    boot_app(K_REPLY_SAM);
    CHECK(run_until_ready(15000), "K210 listo");
    fake_sensors.on_charger = 0;
    nbmsg = 0;
    body_say("{\"t\":\"welcome\",\"time\":1}");
    int e0 = n_ex;
    body_pump(10 * 60000, NULL);
    CHECK(bmsg_count("\"t\":\"body_hello\"", 0) >= 25 && !body_protocol() && body_runs() && !app_body_asleep()
          && n_ex - e0 > 0 && !fake_log_contains("Alma no está en este cuerpo"),
          "servidor viejo (%d hellos sin respuesta): Alma corre como siempre (%d conductas en 10 min)",
          bmsg_count("\"t\":\"body_hello\"", 0), n_ex - e0);
    CHECK(strstr(bmsg[0], "\"n\":1,") && strstr(bmsg[0], "\"locks\":{\"noche\":false,\"ota\":false}"),
          "el hello lleva n 1 y los candados: %.120s", bmsg[0]);

    /* 2. keep: el protocolo se enciende; el lease se cuenta desde que se MANDÓ el hello y, sin renovarlo, se duerme sola */
    nbmsg = 0;
    body_pump(20000, KEEP1);
    int64_t t_hello = bmsg_t[bmsg_find("\"t\":\"body_hello\"", 0)];
    CHECK(body_protocol() && body_runs() && !app_body_asleep(), "primer keep: el protocolo se enciende y Alma sigue aquí");
    int ib0 = bmsg_find("\"kind\":\"backup\",\"seq\":0,", 0);
    CHECK(ib0 >= 0 && strstr(bmsg[ib0], "\"n\":1,\"bseq\":1,\"meta\":[]"),
          "con el turno, respaldo numerado (bseq 1, n 1) en trozos");
    CHECK(fake_log_contains("cuerpo: respaldo 1 al servidor"), "el respaldo se registra");
    for (int i = bmsg_find("\"t\":\"body_hello\"", 0) + 1; i < nbmsg; i++)
        if (strstr(bmsg[i], "body_hello")) t_hello = bmsg_t[i];
    fake_sensors.on_charger = 1;   /* en la base: sin Alma no tiene a dónde ir */
    fake_run(t_hello + 179000 - fake_ms);
    CHECK(body_runs(), "a los 179 s del último hello con keep, sigue con el turno");
    int sv = fake_n_servo;
    fake_run(2000);
    CHECK(!body_runs() && app_body_asleep() && fake_log_contains("se durmió: no renovó el turno"),
          "a los 180 s sin renovar, se duerme sola sin esperar al servidor (6.4)");
    CHECK(!home_active(), "en la base: sin Alma se queda ahí (la vuelta a casa sin Alma: test_body_goes_home)");
    int e1 = n_ex;
    fake_run(5 * 60000);
    CHECK(n_ex == e1 && servo_sets_since(sv, -1) == 0, "dormida: ni conductas (%d) ni servos (%d) en 5 min", n_ex - e1,
          servo_sets_since(sv, -1));
    int clock = 0;   /* dueño, 2026-11-02: sin Alma, el reloj con los ojitos (/test/ausente_reloj.avi) */
    for (int i = 0; i < fake_n_tx && i < FAKE_TX_MAX; i++)
        for (size_t k = 0; k + 22 <= fake_txs[i].n; k++) if (!memcmp(fake_txs[i].b + k, "/test/ausente_reloj.avi", 22)) { clock = 1; break; }
    CHECK(clock, "sin Alma: el reloj con los ojitos en la pantalla");
    char rep[160];
    api_link_msg("{\"t\":\"feed\",\"food\":\"manzana\",\"req\":4}", rep, sizeof rep);
    CHECK(strstr(rep, "Alma no está en el robot") != NULL, "sin Alma, la comida de la app no se le da: %s", rep);

    /* 3. regla 1 y soltar: un keep atrasado a un hello de antes de soltarla no la despierta */
    nbmsg = 0;
    body_pump(3000, KEEP1);   /* el poke de abajo no hace falta: al contestar sigue el ciclo de 20 s */
    int hk = body_hello_now();
    body_say(KEEP1, hk);
    CHECK(body_runs(), "otro keep: despierta");
    fake_run(500);
    app_care_feed(alma_food_of("manzana"), 1, 0.1f, 0.1f, 0);   /* evento importante: a la memoria y respaldo */
    body_drain();
    CHECK(bmsg_find("\"kind\":\"comida\"", 0) >= 0 && bmsg_find("\"id\":\"robot-", 0) >= 0, "la comida va al respaldo con su id");
    int hA = body_hello_now();
    fake_run(1000);
    int hB = body_hello_now();
    int from = nbmsg;
    body_say("{\"t\":\"body\",\"nonce\":%d,\"d\":\"release\",\"mid\":\"m1\",\"n\":2}", hB);
    CHECK(!body_runs() && app_body_asleep(), "release: deja de correr el núcleo");
    body_drain();
    int pn = pkg_bytes("release", from, pkg, sizeof pkg, head, sizeof head, &chunks);
    CHECK(pn >= 28 && memcmp(pkg, "ALMX", 4) == 0 && chunks == (pn + BODY_CHUNK - 1) / BODY_CHUNK
          && strstr(head, "\"kind\":\"release\",\"seq\":0,") && strstr(head, "\"mid\":\"m1\",\"meta\":[{\"id\":\"robot-"),
          "release: el paquete ALMX (%d bytes) en %d trozos; el primero con mid y meta", pn, chunks);
#if ALMA_MEM_WRITE_ENABLED
    CHECK(pn > 1000 && chunks == 2, "release: guarda todo antes de exportar (%d bytes en %d trozos de %d)", pn, chunks, BODY_CHUNK);
#endif
    body_say(KEEP1, hA);
    CHECK(!body_runs() && fake_log_contains("(regla 1): no cuenta"), "regla 1: el keep de un hello de antes de soltarla no la despierta");
    from = nbmsg;
    body_say("{\"t\":\"body\",\"nonce\":%d,\"d\":\"release\",\"mid\":\"m1\",\"n\":2}", body_hello_now());
    body_drain();
    int pn2 = pkg_bytes("release", from, pkg2, sizeof pkg2, head, sizeof head, &chunks);
    CHECK(pn2 == pn && memcmp(pkg, pkg2, (size_t)pn) == 0, "release repetido: el mismo paquete otra vez");
    body_say("{\"t\":\"body_pkg_result\",\"kind\":\"release\",\"mid\":\"m1\",\"ok\":true}");

    /* 4. absent con n mayor: lo no respaldado va como evento por recuperar (5.6) y luego se descarta la copia */
    from = nbmsg;
    body_say(ABSENT5, body_hello_now());
    CHECK(!fake_log_contains("se descarta la copia local") && fake_log_contains("eventos por recuperar"),
          "absent n 5: primero manda la comida no respaldada");
    int hE = body_drain();
    int ie = last_hello();
    CHECK(hE > 0 && ie >= 0 && strstr(bmsg[ie], "\"events\":[{\"id\":\"robot-") && strstr(bmsg[ie], "\"kind\":\"comida\""),
          "el hello siguiente lleva el evento: %.160s", ie >= 0 ? bmsg[ie] : "");
    body_say(ABSENT5, hE);
    CHECK(fake_log_contains("se descarta la copia local") && !body_runs(), "con los eventos ya enviados, descarta su copia");
    from = nbmsg;
    body_say(KEEP1, body_hello_now());
    body_drain();
    CHECK(!body_runs() && bmsg_find("\"events\":[]", from) >= 0, "sin copia, un keep de su n viejo no la despierta");

    /* 5. llegada por cara (6.2): solo la cara 0, sostenida 7 s, y solo sin Alma */
    nbmsg = 0;
    fake_face_set(1, 1, 100, 80, 120, 120, "otra");
    from = nbmsg;
    body_pump(40000, ABSENT5);
    CHECK(bmsg_find("\"t\":\"body_move\"", from) < 0, "otra persona registrada frente a la cámara: no pide la llegada");
    fake_face_set(-1, 0, 0, 0, 0, 0, "");
    body_pump(20000, ABSENT5);
    fake_face_set(1, 0, 100, 80, 120, 120, "duena");
    int64_t t_face = fake_ms;
    from = nbmsg;
    body_pump(45000, ABSENT5);
    int im = bmsg_find("\"t\":\"body_move\",\"mid\":\"cara-robot-", from);
    CHECK(im >= 0 && bmsg_t[im] - t_face >= BODY_ARRIVAL_SUSTAIN_MS && bmsg_count("body_move", from) == 1,
          "el dueño frente a la cámara: un body_move a los %lld ms", im >= 0 ? (long long)(bmsg_t[im] - t_face) : -1LL);
    body_say("{\"t\":\"body_move_result\",\"mid\":\"x\",\"ok\":true,\"why\":\"en_curso\"}");
    /* pasar frente al robot 2 s no la jala */
    fake_face_set(-1, 0, 0, 0, 0, 0, "");
    body_pump(70000, ABSENT5);
    from = nbmsg;
    fake_face_set(1, 0, 100, 80, 120, 120, "duena");
    body_pump(2000, ABSENT5);
    fake_face_set(-1, 0, 0, 0, 0, 0, "");
    body_pump(40000, ABSENT5);
    CHECK(bmsg_find("body_move", from) < 0, "el dueño pasa 2 s frente al robot: no pide la llegada");

    /* 6. deliver: importa (valida antes de escribir), se pone al día y confirma */
    nbmsg = 0;
    from = nbmsg;
    body_deliver(body_hello_now(), "m2", 3, "[{\"id\":\"reloj-7\",\"kind\":\"caricia\",\"data\":{\"de\":\"reloj\"},\"at\":5}]", 40, pkg, pn);
    body_drain();
#if ALMA_MEM_WRITE_ENABLED
    CHECK(bmsg_find("{\"t\":\"body_ack\",\"mid\":\"m2\",\"ok\":true", from) >= 0 && body_runs() && fake_log_contains("se pone al día 3600 s"),
          "deliver: importa, se pone al día 1 h sin conductas y confirma");
    fake_run(2000);
    CHECK(!app_body_asleep(), "con Alma de vuelta, el núcleo corre");
    from = nbmsg;
    body_say("{\"t\":\"body\",\"nonce\":%d,\"d\":\"keep\",\"n\":3,\"lease_s\":180,\"events\":[{\"id\":\"srv-1\",\"kind\":\"caricia\","
             "\"data\":{},\"at\":9}]}", body_hello_now());
    app_care_feed(alma_food_of("manzana"), 1, 0.1f, 0.1f, 0);
    int hN = body_hello_now();
    ie = last_hello();
    CHECK(hN > 0 && ie >= 0 && strstr(bmsg[ie], "\"n\":3,") && strstr(bmsg[ie], "\"acked\":[\"srv-1\"]"),
          "regla 4: el hello confirma el evento del servidor que está en su memoria: %.200s", ie >= 0 ? bmsg[ie] : "");
    int bmin = 1 << 30, nb = 0;   /* un respaldo sin mandar lo reemplaza el siguiente: cuenta el primero que salió */
    for (int i = 0; i < nbmsg; i++) {
        const char *q = strstr(bmsg[i], "\"bseq\":");
        if (q && atoi(q + 7) < bmin) bmin = atoi(q + 7);
        nb += q != NULL;
    }
    CHECK(nb >= 1 && bmin > 40 && bmin <= 43, "regla 2: tras recibirla, los respaldos siguen desde el seq del servidor (40 → %d)", bmin);
    /* regla 3: la suelta otra vez y le llega una copia sin la comida de aquí: la comida vuelve como recuerdo */
    from = nbmsg;
    body_say("{\"t\":\"body\",\"nonce\":%d,\"d\":\"release\",\"mid\":\"m3\",\"n\":4}", hN);
    body_drain();
    pn2 = pkg_bytes("release", from, pkg2, sizeof pkg2, head, sizeof head, &chunks);
    CHECK(pn2 > 1000, "soltada m3");
    from = nbmsg;
    body_deliver(body_hello_now(), "m4", 5, "[]", 0, pkg2, pn2);
    body_drain();
    int ib = bmsg_find("\"kind\":\"backup\",\"seq\":0", from);
    CHECK(bmsg_find("\"mid\":\"m4\",\"ok\":true", from) >= 0 && ib >= 0 && strstr(bmsg[ib], "\"recuerdo_de\":\"robot\"")
          && fake_log_contains("3 recuerdos de la copia vieja"),
          "regla 3: lo que la copia vieja vivió y la nueva no trae vuelve como recuerdo (respaldo con recuerdo_de)");
    /* solo sin Alma: con ella aquí, el dueño frente a la cámara no pide nada */
    fake_face_set(1, 0, 100, 80, 120, 120, "duena");
    from = nbmsg;
    body_pump(40000, "{\"t\":\"body\",\"nonce\":%d,\"d\":\"keep\",\"n\":5,\"lease_s\":180,\"events\":[]}");
    CHECK(body_runs() && bmsg_find("body_move", from) < 0, "con Alma aquí, la cara del dueño no pide la llegada");
    fake_face_set(-1, 0, 0, 0, 0, 0, "");

    /* 7. arranque con el protocolo guardado y sin red: sin Alma (7) */
    boot_app(K_REPLY_SAM);
    CHECK(body_protocol() && !body_runs() && app_body_asleep() && fake_log_contains("arranca sin Alma"),
          "reinicio con el protocolo guardado (MEM_BODY): arranca sin Alma");
    run_until_ready(15000);
    fake_run(10 * 60000);
    CHECK(n_ex == 0 && !body_runs(), "10 min sin red: sigue sin Alma y sin conductas (%d)", n_ex);
    nbmsg = 0;
    body_say("{\"t\":\"welcome\",\"time\":1}");
    int h7 = body_drain();
    CHECK(h7 > 0 && strstr(bmsg[0], "\"n\":5,"), "al conectar pregunta con su n guardado (5)");
    body_say("{\"t\":\"body\",\"nonce\":%d,\"d\":\"keep\",\"n\":5,\"lease_s\":180,\"events\":[]}", h7);
    fake_run(1000);
    CHECK(body_runs() && !app_body_asleep(), "el servidor confirma el turno: Alma despierta");
    alma_mem_body_v1 st;
    CHECK(alma_mem_body_get(app_mem(), &st) == 0 && st.n == 5 && st.proto == 1 && st.copy == 1 && st.bseq > 41,
          "n y numeración de respaldos guardados en MEM_BODY (n %u, bseq %u)", st.n, st.bseq);
#else
    CHECK(bmsg_find("{\"t\":\"body_ack\",\"mid\":\"m2\",\"ok\":false,\"why\":\"no se pudo importar el paquete\"}", from) >= 0 && !body_runs(),
          "sin escritura de memoria, el paquete no se puede importar: acuse ok=false");
    /* sin escritura, el protocolo no se guarda: el siguiente arranque es el de siempre */
    boot_app(K_REPLY_SAM);
    CHECK(!body_protocol() && body_runs(), "sin escritura de memoria, tras reiniciar arranca como siempre");
#endif
    fake_face_set(-1, 0, 0, 0, 0, 0, "");
}

static void test_console(void)
{
    fake_log_clear();
    const char keys[] = {'i', '\r', '\n', 'Y', '0', 'k'};
    for (size_t i = 0; i < sizeof keys; i++) app_console_key(keys[i]);
    app_console_key('\0');
    CHECK(fake_log_contains("tecla recibida 0x69 'i'") && fake_log_contains("estado:"), "'i': registrada y atendida");
    CHECK(fake_log_contains("tecla recibida 0x0d '?'") && fake_log_contains("tecla recibida 0x0a '?'"), "\\r y \\n registradas");
    CHECK(fake_log_contains("tecla recibida 0x59 'Y'") && fake_log_contains("tecla 'Y' sin uso"), "tecla sin uso: registrada");
    CHECK(fake_log_contains("tecla recibida 0x30 '0'") && fake_log_contains("PARO") && !motion_active(), "'0': registrada, PARO");
    CHECK(fake_log_contains("tecla recibida 0x6b 'k'") && fake_log_contains("consola: EV_WAKE_WORD"), "'k': registrada y evento");
    CHECK(fake_log_contains("tecla recibida 0x00 '?'"), "byte 0x00 registrado");
    fake_log_clear();
    app_console_help();
    CHECK(!fake_log_contains("tecla recibida") && fake_log_contains("h ayuda"), "la ayuda del arranque no es una tecla");
}

int main(int argc, char **argv)
{
    if (argc >= 6) gait_ref_dir = argv[5];
    if (argc < 5) { fprintf(stderr, "uso: %s <catalog.json> <storage.bin> <assets_inventory.json> <mot_tool.json>\n", argv[0]); return 2; }
    catalog_path = argv[1];
    inventory_path = argv[3];
    catalog_text = read_text(argv[1]);
    char *mt = read_text(argv[4]);
    motref = mt ? cJSON_Parse(mt) : NULL;
    if (!catalog_text || !motref || fake_spiffs_load(argv[2])) { fprintf(stderr, "no pude leer las entradas\n"); return 2; }
    vision_owner_on = 0;   /* la foto del dueño solo en test_vision_owner: con su cara de frente cambiaría las demás */
#if ALMA_MEM_WRITE_ENABLED
    test_catalog();
    test_mem_write();
    test_backup();
    test_body();
    printf("%d comprobaciones, %d fallas\n", checks, fails);
    return fails ? 1 : 0;
#endif
    test_catalog();
    test_boot();
    test_listen();
    test_pet_and_lift();
    test_own_shake();
    test_put_down_edges();
    test_all_mot();
    test_gait_ref();
    test_on_charger();
    test_perception();
    test_faces();
    test_eyes_and_routine();
    test_battery();
    test_face_register();
    test_floor_edge();
    test_gait_edges();
    test_turn_edges();
    test_sticker();
    test_remote_debug();
    test_gestures();
    test_home_no_oscillation();
    test_battery_life();   /* antes de test_body_goes_home: esa deja el protocolo de mudanza en la memoria */
    test_body_goes_home();
    test_sense();
    test_file_send();
    test_memory();
    test_api();
    test_link();
    test_forget_faces();
    test_voice();
    test_tamagotchi();
    test_music();
    test_autoregister();
    test_obstacle();
    test_home();
    test_bedtime();
    test_vision();
    test_vision_owner();
    test_tricks();
    test_clock_from_server();
    test_body();
    test_console();
    test_fiesta();
    test_vader();
    test_ota();
    printf("%d comprobaciones, %d fallas\n", checks, fails);
    return fails != 0;
}
