#include "api.h"

/* teclas de prueba que se aceptan por Wi-Fi (las mismas que por el USB; 0 = PARO) */
#define REMOTE_KEYS "CHgiAWSDJTKUVx0?"

#include <stdio.h>
#include <string.h>
#include <time.h>

#include "app.h"
#include "cJSON.h"
#include "f2_config.h"
#include "f2_hal.h"
#include "fiesta.h"
#include "ota.h"
#include "home.h"
#include "outbox.h"
#include "perception.h"
#include "rlog.h"
#include "backup.h"
#include "body.h"
#include "vision.h"
#include "voice.h"

static const char *const TR[] = {"trait_boldness", "trait_energy", "trait_sociability", "trait_playfulness", "trait_impulsivity"};

static long print(cJSON *j, char *out, size_t cap)
{
    long n = cJSON_PrintPreallocated(j, out, (int)cap, 0) ? (long)strlen(out) : -1;
    cJSON_Delete(j);
    return n;
}

/* ---- plan v2: comida, peso y salud desde el servidor ---- */

static const char *const SICK_ID[] = {"", "empacho", "sobrepeso", "debil", "resfriado"};
static const char *const BAND_ID[] = {"bajo", "sano", "sobrepeso", "obesidad"};

static int index_of(const char *const *ids, int n, const char *s, int dflt)
{
    for (int i = 0; s && i < n; i++)
        if (strcmp(ids[i], s) == 0) return i;
    return dflt;
}

static float num(const cJSON *j, const char *k, float dflt)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(j, k);
    return cJSON_IsNumber(v) ? (float)v->valuedouble : dflt;
}

static const char *str(const cJSON *j, const char *k)
{
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(j, k);
    return cJSON_IsString(v) ? v->valuestring : NULL;
}

/* care_state: cómo está; care_feed: además, qué hacer con la comida que le dieron */
static void care_msg(const cJSON *j)
{
    const cJSON *sick = cJSON_GetObjectItemCaseSensitive(j, "sick");
    int cause = cJSON_IsTrue(sick) ? index_of(SICK_ID, 5, str(j, "cause"), SICK_EMPACHO) : SICK_NONE;
    if (cause == SICK_NONE && cJSON_IsTrue(sick)) cause = SICK_EMPACHO;
    app_care_state(num(j, "hunger", app_alma()->hunger), (alma_sick_cause)cause,
                   (alma_weight_band)index_of(BAND_ID, 4, str(j, "weight_band"), WB_SANO), num(j, "energy", 1.0f));
    if (strcmp(str(j, "t"), "care_feed") == 0) {
        int food = alma_food_of(str(j, "food"));
        const cJSON *ok = cJSON_GetObjectItemCaseSensitive(j, "accepted");
        if (food >= 0) app_care_feed(food, cJSON_IsTrue(ok), num(j, "joy", 0), num(j, "bond", 0), num(j, "frust", 0));
    }
}

static long care_import(char *out, size_t cap)
{
    const alma_t *a = app_alma();
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "t", "care_import");
    cJSON *l = cJSON_AddObjectToObject(j, "likes");
    for (int f = 0; f < FOOD_COUNT; f++) cJSON_AddNumberToObject(l, alma_food_id(f), a->food_like[f]);
    cJSON_AddNumberToObject(j, "hunger", a->hunger);
    cJSON_AddBoolToObject(j, "sick", a->sick);
    return print(j, out, cap);
}

long api_state(char *out, size_t cap)
{
    static const char *const ST[] = {"ST_BOOT", "ST_AWAKE", "ST_PERFORMING", "ST_RESTING", "ST_SLEEPING", "ST_LISTENING", "ST_REFLEX"};
    static const char *const SM[] = {"SM_SCARED", "SM_SLEEPY", "SM_GRUMPY", "SM_BORED", "SM_PLAYFUL", "SM_HAPPY", "SM_CALM"};
    static const char *const NEED[] = {"need_social", "need_stimulation", "need_rest", "need_boredom"};
    const alma_t *a = app_alma();
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "t", "state");   /* así lo manda el enlace (uplink.h) */
    cJSON_AddStringToObject(j, "state", ST[a->state]);
    cJSON_AddStringToObject(j, "simple_mood", SM[a->simple_mood]);
    cJSON_AddNumberToObject(j, "mood", a->mood);
    cJSON *n = cJSON_AddObjectToObject(j, "needs");
    for (int k = 0; k < NEED_COUNT; k++) cJSON_AddNumberToObject(n, NEED[k], alma_need(a, k));
    cJSON *t = cJSON_AddObjectToObject(j, "traits");
    for (int k = 0; k < TRAIT_COUNT; k++) cJSON_AddNumberToObject(t, TR[k], a->trait[k]);
    cJSON_AddNumberToObject(j, "age_days", a->age_days);
    cJSON_AddNumberToObject(j, "battery_pct", a->soc_pct);
    cJSON_AddBoolToObject(j, "on_charger", a->on_charger);
    cJSON_AddBoolToObject(j, "memory_recovered", app_mem()->recovered);
    cJSON_AddBoolToObject(j, "alma_here", body_runs());   /* mudanza (PLAN-RELOJ-v2): false = modo "Alma no está" */
    /* para la página del celular (2026-10-30) */
    cJSON_AddNumberToObject(j, "wellbeing", a->wellbeing);
    cJSON_AddNumberToObject(j, "valence", a->affect_valence);
    cJSON_AddNumberToObject(j, "arousal", a->affect_arousal);
    cJSON_AddStringToObject(j, "doing", a->cur.active ? app_catalog()->b[a->cur.behavior].id : "");
    /* tamagotchi (2026-10-30) */
    cJSON_AddNumberToObject(j, "hunger", a->care_enabled ? a->hunger : -1);
    cJSON_AddBoolToObject(j, "sick", a->sick);
    cJSON_AddNumberToObject(j, "meals_today", a->counts.meals);
    cJSON_AddNumberToObject(j, "treats_today", a->counts.treats);
    /* plan v2 (2026-10-31): el servidor lleva comida, peso y salud; el robot le cuenta su ejercicio */
    cJSON_AddNumberToObject(j, "care_v", 2);
    cJSON_AddNumberToObject(j, "fiesta_v", 1);   /* sabe recibir caras de festividades (fiesta.c): el servidor solo se las manda así */
    cJSON_AddNumberToObject(j, "ota_v", 1);      /* sabe actualizarse por Wi-Fi (ota.c) */
    cJSON_AddNumberToObject(j, "energy", a->care_energy);
    cJSON *ex = cJSON_AddObjectToObject(j, "exercise");
    for (int k = 0; k < EX_COUNT; k++) cJSON_AddNumberToObject(ex, alma_exercise_id(k), (int)a->ex_s[k]);
    hal_sensors hs;
    hal_sensors_read(&hs);
    cJSON_AddStringToObject(j, "power", !hs.on_charger ? "battery" : hs.on_usb ? "usb" : "home_station");
    static const char *const HOME[] = {"off", "searching", "approaching", "turning", "docking", "docked", "failed"};
    cJSON_AddStringToObject(j, "going_home", HOME[home_get()]);
    perc_face lf;
    int64_t seen_ms = perception_last_face(&lf);
    if (seen_ms >= 0) {
        cJSON *f = cJSON_AddObjectToObject(j, "last_face");
        cJSON_AddNumberToObject(f, "person_id", lf.person_id);
        cJSON_AddStringToObject(f, "name", lf.name);
        cJSON_AddNumberToObject(f, "seconds_ago", (double)((hal_now_ms() - seen_ms) / 1000));
    }
    hal_power_probe_t pp;   /* ¿Home Station o USB? (diagnóstico, 2026-10-30) */
    if (hal_power_probe(&pp) == 0) {
        cJSON *w = cJSON_AddObjectToObject(j, "power_probe");
        cJSON_AddNumberToObject(w, "gpio36_mv", pp.mv[0]);
        cJSON_AddNumberToObject(w, "gpio37_mv", pp.mv[1]);
        cJSON_AddNumberToObject(w, "gpio38_mv", pp.mv[2]);
        cJSON_AddNumberToObject(w, "gpio39_mv", pp.mv[3]);
        cJSON_AddNumberToObject(w, "rx0", pp.rx0);
        cJSON_AddNumberToObject(w, "charger", pp.charger);
    }
    cJSON *p = cJSON_AddArrayToObject(j, "people_present");
    for (int s = 0; s < ALMA_MAX_PERSONS; s++)
        if (a->person[s].used && a->person[s].present) {
            cJSON *o = cJSON_CreateObject();
            cJSON_AddNumberToObject(o, "person_id", a->person[s].id);
            cJSON_AddNumberToObject(o, "attachment", a->person[s].attachment);
            cJSON_AddItemToArray(p, o);
        }
    return print(j, out, cap);
}

long api_log_today(char *out, size_t cap)
{
    const alma_t *a = app_alma();
    const alma_counters *c = &a->counts;
    cJSON *j = cJSON_CreateObject(), *k = cJSON_AddObjectToObject(j, "counts");
    cJSON_AddNumberToObject(k, "pets", c->pets);
    cJSON_AddNumberToObject(k, "praises", c->praises);
    cJSON_AddNumberToObject(k, "scolds", c->scolds);
    cJSON_AddNumberToObject(k, "shakes", c->shakes);
    cJSON_AddNumberToObject(k, "play_done", c->play_done);
    cJSON_AddNumberToObject(k, "play_ignored", c->play_ignored);
    cJSON_AddNumberToObject(k, "scares", c->scares);
    cJSON_AddNumberToObject(k, "novel_ok", c->novel_ok);
    cJSON_AddNumberToObject(k, "explore_ok", c->explore_ok);
    cJSON_AddNumberToObject(j, "servo_active_s", a->servo_active_s_today);
    cJSON *ev = cJSON_AddArrayToObject(j, "events");
    const app_ev_log *l;
    int first, n = app_events(&l, &first);
    for (int i = 0; i < n; i++) {
        const app_ev_log *e = &l[(first + i) % F2_LOG_EVENTS];
        cJSON *o = cJSON_CreateObject();
        cJSON_AddNumberToObject(o, "t_ms", (double)e->t_ms);
        cJSON_AddStringToObject(o, "type", app_ev_name(e->type));
        if (e->person >= 0) cJSON_AddNumberToObject(o, "person_id", e->person);
        if (e->action >= 0) cJSON_AddStringToObject(o, "action_id", app_action_name(e->action));
        cJSON_AddItemToArray(ev, o);
    }
    return print(j, out, cap);
}

int api_command(const char *body, char *out, size_t cap)
{
    cJSON *j = cJSON_Parse(body);
    const cJSON *a = cJSON_GetObjectItemCaseSensitive(j, "action_id");
    int act = cJSON_IsString(a) ? app_action_of(a->valuestring) : -1;
    cJSON_Delete(j);
    if (act < 0) { snprintf(out, cap, "{\"error\":\"action_id desconocido\"}"); return 400; }
    alma_ev e = {EV_REMOTE_COMMAND, -1, act, -1, 0, 0, 0, 0};
    app_post(&e);
    snprintf(out, cap, "{\"ok\":true,\"action_id\":\"%s\"}", app_action_name(act));
    return 200;
}

/* Sin Alma en este cuerpo (está en el reloj, body.c): lo que es para ella no se aplica aquí */
static int away(const char *what)
{
    if (body_runs()) return 0;
    hal_log("enlace: '%s' sin Alma en este cuerpo; no se aplica", what);
    return 1;
}

long api_link_msg(const char *json, char *out, size_t cap)
{
    cJSON *j = cJSON_Parse(json);
    const cJSON *t = cJSON_GetObjectItemCaseSensitive(j, "t");
    int n = 0;
    if (!cJSON_IsString(t)) hal_log("enlace: mensaje sin tipo");
    else if (strncmp(t->valuestring, "body", 4) == 0) body_msg(json);   /* mudanza entre cuerpos (body.h) */
    else if (strcmp(t->valuestring, "command") == 0 && away("command"))
        n = snprintf(out, cap, "{\"t\":\"command_result\",\"code\":409,\"result\":{\"error\":\"Alma no está en el robot\"}}");
    else if (strcmp(t->valuestring, "command") == 0) {
        char r[128];
        int code = api_command(json, r, sizeof r);
        hal_log("enlace: orden del celular %s", r);
        n = snprintf(out, cap, "{\"t\":\"command_result\",\"code\":%d,\"result\":%s}", code, r);
    } else if (strcmp(t->valuestring, "night_result") == 0) {
        const cJSON *e = cJSON_GetObjectItemCaseSensitive(j, "error");
        body_night(0);   /* el candado del pase nocturno se suelta con la respuesta, buena o mala */
        if (away("night_result")) {}
        else if (cJSON_IsString(e)) hal_log("enlace: el pase nocturno de Haiku falló (%s); queda la cuenta local", e->valuestring);
        else {
            const cJSON *adj = cJSON_GetObjectItemCaseSensitive(j, "wellbeing_adjust");
            const cJSON *tn = cJSON_GetObjectItemCaseSensitive(j, "trait_nudges");
            float nudges[TRAIT_COUNT] = {0};
            for (int k = 0; k < TRAIT_COUNT; k++) {
                const cJSON *v = cJSON_GetObjectItemCaseSensitive(tn, TR[k]);
                if (cJSON_IsNumber(v)) nudges[k] = (float)v->valuedouble;
            }
            app_night_result(cJSON_IsNumber(adj) ? adj->valueint : 0, nudges);
            const cJSON *why = cJSON_GetObjectItemCaseSensitive(j, "wellbeing_reason");
            const cJSON *jr = cJSON_GetObjectItemCaseSensitive(j, "journal_es");
            hal_log("enlace: pase nocturno de Haiku: ajuste %d (%s)", cJSON_IsNumber(adj) ? adj->valueint : 0,
                    cJSON_IsString(why) ? why->valuestring : "");
            if (cJSON_IsString(jr)) hal_log("diario: %s", jr->valuestring);
        }
    } else if (strcmp(t->valuestring, "reminder") == 0) {
        /* alarma del dueño (07; dueño, 2026-10-30): el título solo va al registro, la alarma la hace el núcleo */
        const cJSON *ti = cJSON_GetObjectItemCaseSensitive(j, "title"), *mi = cJSON_GetObjectItemCaseSensitive(j, "minutes");
        hal_log("enlace: recordatorio \"%.60s\" (en %d min)", cJSON_IsString(ti) ? ti->valuestring : "",
                cJSON_IsNumber(mi) ? mi->valueint : 0);
        alma_ev e = {EV_REMINDER, -1, -1, -1, 0, 0, 0, 0};
        if (!away("reminder")) app_post(&e);
        n = snprintf(out, cap, "{\"t\":\"reminder_ack\"}");
    } else if (strcmp(t->valuestring, "voice_result") == 0) { if (!away("voice_result")) voice_result(json); }
    else if (strcmp(t->valuestring, "seen") == 0) { if (!away("seen")) vision_result(json); }
    else if (strcmp(t->valuestring, "trick") == 0) {   /* trucos (dueño, 2026-11-01): el servidor decide; aquí se hace */
        const char *why = NULL;
        const cJSON *rq = cJSON_GetObjectItemCaseSensitive(j, "req");
        int ok = away("trick") ? (why = "Alma no está en el robot", 0) : app_trick(str(j, "mot"), &why);
        hal_log("enlace: truco %s: %s", str(j, "mot") ? str(j, "mot") : "?", ok ? "lo hace" : why);
        n = snprintf(out, cap, "{\"t\":\"trick_result\",\"req\":%d,\"done\":%s,\"why\":\"%s\"}",
                     cJSON_IsNumber(rq) ? rq->valueint : 0, ok ? "true" : "false", ok ? "" : why);
    }
    else if (strcmp(t->valuestring, "mem_restore") == 0) {
        /* con el protocolo de mudanza, la memoria llega solo por "deliver" (body.c), nunca por la copia de mem_backups */
        if (body_protocol()) hal_log("enlace: mem_restore ignorado: la memoria la manda el árbitro de cuerpo");
        else backup_restore_msg(json);
    }
    else if (strcmp(t->valuestring, "welcome") == 0) {
        hal_log("enlace: conectada al servidor");
        const cJSON *loc = cJSON_GetObjectItemCaseSensitive(j, "local");
        if (!app_clock_real() && cJSON_IsNumber(loc)) app_clock_from_server(loc->valuedouble);
        app_set_link(1);
        ota_welcome();   /* un arranque a prueba (ota.h) queda confirmado */
        n = care_import(out, cap);   /* sus gustos, una vez: el servidor los ignora si ya los tiene */
    } else if (strcmp(t->valuestring, "care_state") == 0 || strcmp(t->valuestring, "care_feed") == 0) { if (!away(t->valuestring)) care_msg(j); }
    else if (strcmp(t->valuestring, "game_event") == 0) {   /* juegos de la app (PLAN-JUEGOS, 2026-10-31) */
        int e = alma_game_ev_of(str(j, "tipo"));
        if (away("game_event")) {}
        else if (e >= 0) app_game_event((alma_game_ev)e, str(j, "juego"));
        else hal_log("enlace: game_event '%s' desconocido", str(j, "tipo") ? str(j, "tipo") : "");
    }
    else if (strcmp(t->valuestring, "feed") == 0) {
        const cJSON *f = cJSON_GetObjectItemCaseSensitive(j, "food"), *rq = cJSON_GetObjectItemCaseSensitive(j, "req");
        int food = cJSON_IsString(f) ? alma_food_of(f->valuestring) : -1;
        const alma_t *a = app_alma();
        if (food < 0) n = snprintf(out, cap, "{\"t\":\"feed_result\",\"req\":%d,\"error\":\"comida desconocida\"}",
                                   cJSON_IsNumber(rq) ? rq->valueint : 0);
        else if (away("feed")) n = snprintf(out, cap, "{\"t\":\"feed_result\",\"req\":%d,\"error\":\"Alma no está en el robot\"}",
                                   cJSON_IsNumber(rq) ? rq->valueint : 0);
        else {
            alma_feed_result r = app_feed(food);
            n = snprintf(out, cap, "{\"t\":\"feed_result\",\"req\":%d,\"food\":\"%s\",\"accepted\":%s,\"why\":\"%s\","
                         "\"like\":%.2f,\"hunger\":%.2f,\"sick\":%d,\"got_sick\":%d}",
                         cJSON_IsNumber(rq) ? rq->valueint : 0, alma_food_id(food), r.accepted ? "true" : "false",
                         alma_feed_why_id(r.why), r.like, a->hunger, a->sick, r.got_sick);
        }
    } else if (!strcmp(t->valuestring, "ota_begin") || !strcmp(t->valuestring, "ota") || !strcmp(t->valuestring, "ota_reboot")) {
        n = ota_msg(t->valuestring, json, out, cap);   /* firmware nuevo por Wi-Fi (ota.h); también sin Alma en el robot */
    } else if (strcmp(t->valuestring, "cara") == 0 || strcmp(t->valuestring, "fiesta") == 0) {   /* fiesta.h */
        /* los archivos ("cara") se reciben aunque Alma esté en el reloj: el cuerpo los sube al K210 (2026-11-03: sin Alma no
           llegaba ausente_reloj y se veía dormido); la fiesta del día solo con ella */
        if (!strcmp(t->valuestring, "cara") || !away(t->valuestring)) n = fiesta_msg(t->valuestring, json, out, cap);
    } else if (strcmp(t->valuestring, "rlog") == 0) {   /* depuración sin el USB (dueño, 2026-11-02; robot_debug.py) */
        const cJSON *on = cJSON_GetObjectItemCaseSensitive(j, "on");
        rlog_set(cJSON_IsTrue(on));
        hal_log("enlace: registro por Wi-Fi %s", cJSON_IsTrue(on) ? "prendido" : "apagado");
    } else if (strcmp(t->valuestring, "patas") == 0) {   /* robot_debug.py: "patas on|off" (on = no apagarlas en la base) */
        app_legs_keep_on(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j, "on")));
    } else if (strcmp(t->valuestring, "usb_mueve") == 0) {   /* robot_debug.py: "usb on|off" */
        app_usb_motion(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j, "on")));
    } else if (strcmp(t->valuestring, "prueba_bateria") == 0) {   /* robot_debug.py: "bateria on|off" */
        app_battery_test(cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(j, "on")));
    } else if (strcmp(t->valuestring, "key") == 0) {   /* una tecla de prueba por Wi-Fi: solo las de la lista */
        const char *k = str(j, "k");
        if (k && k[0] && !k[1] && strchr(REMOTE_KEYS, k[0])) { hal_log("enlace: tecla por Wi-Fi '%c'", k[0]); app_console_key(k[0]); }
        else hal_log("enlace: tecla por Wi-Fi rechazada");
    } else if (strcmp(t->valuestring, "remote_play") == 0) {
        const cJSON *sv = cJSON_GetObjectItemCaseSensitive(j, "add_s");
        if (cJSON_IsNumber(sv) && !away("remote_play")) app_remote_play(sv->valueint);
    }
    else hal_log("enlace: mensaje '%s' desconocido", t->valuestring);
    cJSON_Delete(j);
    return n > 0 && (size_t)n < cap ? n : 0;
}

long api_link_take(char *out, size_t cap)
{
    long n = body_take(out, cap);   /* primero: la hora de envío del hello cuenta para el lease (5.7) */
    if (n > 0) return n;
    n = outbox_take(out, cap);
    if (n > 0) return n;
    n = voice_take(out, cap);
    if (n > 0) return n;
    n = vision_take(out, cap);
    if (n > 0) return n;
    n = hal_rlog_take(out, cap);   /* registro por Wi-Fi, si está prendido */
    return n > 0 ? n : backup_take(out, cap);
}

long api_night(const alma_day_summary *s, char *out, size_t cap)
{
    const alma_catalog *cat = app_catalog();
    const alma_t *a = app_alma();
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "t", "night");
    cJSON *m = cJSON_AddObjectToObject(j, "summary");
    time_t now = time(NULL);
    const struct tm *lt = localtime(&now);   /* bajo f2_app_mutex: sin carreras */
    char date[16];
    if (lt && lt->tm_year + 1900 >= 2025 && strftime(date, sizeof date, "%Y-%m-%d", lt))
        cJSON_AddStringToObject(m, "date", date);
    cJSON_AddNumberToObject(m, "age_days", s->age_days);
    cJSON *tr = cJSON_AddObjectToObject(m, "traits");
    for (int k = 0; k < TRAIT_COUNT; k++) cJSON_AddNumberToObject(tr, TR[k], s->traits[k]);
    cJSON_AddNumberToObject(m, "mood_end", s->mood_end);
    const alma_counters *c = &s->counts;
    cJSON *k = cJSON_AddObjectToObject(m, "counts");
    cJSON_AddNumberToObject(k, "pets", c->pets);
    cJSON_AddNumberToObject(k, "praises", c->praises);
    cJSON_AddNumberToObject(k, "scolds", c->scolds);
    cJSON_AddNumberToObject(k, "shakes", c->shakes);
    cJSON_AddNumberToObject(k, "lifts", c->lifts);
    cJSON_AddNumberToObject(k, "play_done", c->play_done);
    cJSON_AddNumberToObject(k, "play_ignored", c->play_ignored);
    cJSON_AddNumberToObject(k, "scares", c->scares);
    cJSON_AddNumberToObject(k, "novel_ok", c->novel_ok);
    cJSON_AddNumberToObject(k, "explore_ok", c->explore_ok);
    cJSON_AddNumberToObject(k, "meals", c->meals);
    cJSON_AddNumberToObject(k, "treats", c->treats);
    cJSON_AddNumberToObject(k, "refused_food", c->refused);
    cJSON_AddNumberToObject(k, "starving_min", c->starve_min);
    cJSON_AddNumberToObject(k, "remote_play_min", c->remote_play_s / 60);
    cJSON *b = cJSON_AddObjectToObject(m, "behaviors");
    for (int i = 0; i < cat->n; i++)
        if (c->behaviors[i]) cJSON_AddNumberToObject(b, cat->b[i].id, c->behaviors[i]);
    cJSON *p = cJSON_AddArrayToObject(m, "people");
    for (int i = 0; i < ALMA_MAX_PERSONS; i++)
        if (s->attachment[i] >= 0) {
            cJSON *o = cJSON_CreateObject();
            cJSON_AddNumberToObject(o, "person_id", a->person[i].id);
            cJSON_AddNumberToObject(o, "attachment", s->attachment[i]);
            cJSON_AddItemToArray(p, o);
        }
    cJSON_AddNumberToObject(m, "servo_active_s", s->servo_active_s);
    cJSON_AddNumberToObject(m, "wellbeing", s->wellbeing);
    cJSON_AddNumberToObject(m, "day_points", s->day_points);
    cJSON_AddNumberToObject(m, "absent_days", s->absent_days);
    return print(j, out, cap);
}

int api_auth_ok(const char *h, const char *token)
{
    static const char P[] = "Bearer ";
    if (!h || !token || !token[0] || strncmp(h, P, sizeof P - 1)) return 0;
    const char *t = h + sizeof P - 1;
    size_t n = strlen(token);
    if (strlen(t) != n) return 0;
    unsigned d = 0;   /* comparación en tiempo constante */
    for (size_t i = 0; i < n; i++) d |= (unsigned)(t[i] ^ token[i]);
    return d == 0;
}
