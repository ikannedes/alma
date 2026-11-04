/* alma_jni.c — el núcleo de Alma en el reloj (PLAN-RELOJ-v2.md, 8): alma_core + memory_store sobre un archivo.
 *
 * La memoria vive en una "flash" de archivo (alma_mem_flash_file.c) dentro de los archivos privados de la app:
 * el mismo formato que en el robot, así que un paquete ALMX exportado aquí se importa allá byte por byte.
 * El tiempo es local (segundos desde 1970 en la zona del dueño), igual que en el robot.
 */
#include <jni.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "alma_core.h"
#include "alma_internal.h"   /* alma_affect_tick: el ánimo al ponerse al día */
#include "alma_mem.h"
#include "catalog_load.h"

#define REGION (512u * 1024u)
#define STEP_S 1.0

typedef struct {
    alma_t a;
    alma_mem mem;
    alma_mem_file ff;
    alma_mem_flash fl;
    double now;
} cuerpo;

static alma_catalog cat;
static int cat_ok;

static const char *ST[] = {"ST_BOOT", "ST_AWAKE", "ST_PERFORMING", "ST_RESTING", "ST_SLEEPING", "ST_LISTENING", "ST_REFLEX"};
static const char *SM[] = {"SM_SCARED", "SM_SLEEPY", "SM_GRUMPY", "SM_BORED", "SM_PLAYFUL", "SM_HAPPY", "SM_CALM"};

#define FN(name) Java_mx_alma_nucleo_NucleoNativo_##name

JNIEXPORT jint JNICALL FN(catalogo)(JNIEnv *env, jclass cls, jstring jcat, jstring jinv)
{
    const char *c = (*env)->GetStringUTFChars(env, jcat, NULL), *i = (*env)->GetStringUTFChars(env, jinv, NULL);
    int n = catalog_load_text(c, i, &cat, 0);
    (*env)->ReleaseStringUTFChars(env, jcat, c);
    (*env)->ReleaseStringUTFChars(env, jinv, i);
    cat_ok = n > 0;
    return n;
}

static cuerpo *abrir_flash(JNIEnv *env, jstring jpath, int borrar)
{
    const char *p = (*env)->GetStringUTFChars(env, jpath, NULL);
    if (borrar) remove(p);
    cuerpo *b = calloc(1, sizeof *b);
    int err = !b || alma_mem_file_open(&b->ff, &b->fl, p, REGION) || alma_mem_open(&b->mem, &b->fl);
    (*env)->ReleaseStringUTFChars(env, jpath, p);
    if (err) { if (b) { alma_mem_file_close(&b->ff); free(b); } return NULL; }
    b->mem.fw = "alma-reloj";
    return b;
}

static int tiene_memoria(const cuerpo *b)
{
    for (int k = 0; k < ALMA_MEM_BLOCKS; k++) if (b->mem.b[k].status == MEM_OK) return 1;
    return 0;
}

static void preparar(cuerpo *b)
{
    b->a.care_enabled = 1;      /* en el reloj se le da de comer desde la app */
    b->a.forget_enabled = 1;
}

/* Nace una Alma de prueba (fase 1). La de verdad llega del robot con importar. */
JNIEXPORT jlong JNICALL FN(nacer)(JNIEnv *env, jclass cls, jstring jpath, jint seed, jdouble now)
{
    if (!cat_ok) return 0;
    cuerpo *b = abrir_flash(env, jpath, 1);
    if (!b) return 0;
    alma_init(&b->a, &cat, (uint32_t)seed, now, (alma_hooks){0});
    preparar(b);
    b->mem.birth_unix = (int64_t)now;
    b->now = now;
    alma_mem_flush(&b->mem, &b->a);
    return (jlong)(intptr_t)b;
}

/* Abre la memoria guardada en el archivo; 0 si no hay. now = la hora de la última vez que vivió. */
JNIEXPORT jlong JNICALL FN(abrir)(JNIEnv *env, jclass cls, jstring jpath, jdouble now)
{
    if (!cat_ok) return 0;
    cuerpo *b = abrir_flash(env, jpath, 0);
    if (!b) return 0;
    if (!tiene_memoria(b)) { alma_mem_file_close(&b->ff); free(b); return 0; }
    alma_init(&b->a, &cat, 0, now, (alma_hooks){0});
    alma_mem_load(&b->mem, &b->a);
    preparar(b);
    b->now = now;
    return (jlong)(intptr_t)b;
}

/* Paquete ALMX → archivo nuevo (valida todo antes de escribir) → núcleo. 0 si el paquete no sirve. */
JNIEXPORT jlong JNICALL FN(importar)(JNIEnv *env, jclass cls, jstring jpath, jbyteArray jpkg, jdouble now)
{
    if (!cat_ok) return 0;
    jsize n = (*env)->GetArrayLength(env, jpkg);
    uint8_t *pkg = malloc((size_t)n);
    if (!pkg) return 0;
    (*env)->GetByteArrayRegion(env, jpkg, 0, n, (jbyte *)pkg);
    cuerpo *b = abrir_flash(env, jpath, 1);
    int ok = b && alma_mem_import(&b->mem, pkg, (uint32_t)n) == 0 && alma_mem_open(&b->mem, &b->fl) == 0;
    free(pkg);
    if (!ok) { if (b) { alma_mem_file_close(&b->ff); free(b); } return 0; }
    b->mem.fw = "alma-reloj";
    alma_init(&b->a, &cat, 0, now, (alma_hooks){0});
    alma_mem_load(&b->mem, &b->a);
    preparar(b);
    b->now = now;
    return (jlong)(intptr_t)b;
}

JNIEXPORT void JNICALL FN(cerrar)(JNIEnv *env, jclass cls, jlong h)
{
    cuerpo *b = (cuerpo *)(intptr_t)h;
    if (!b) return;
    alma_mem_flush(&b->mem, &b->a);
    alma_mem_file_close(&b->ff);
    free(b);
}

/* Vive hasta now en pasos fijos; termina las conductas a tiempo y guarda según el calendario de 06. */
JNIEXPORT void JNICALL FN(correr)(JNIEnv *env, jclass cls, jlong h, jdouble now)
{
    cuerpo *b = (cuerpo *)(intptr_t)h;
    alma_sensors s = {90, 0};
    while (b->now + STEP_S <= now) {
        b->now += STEP_S;
        if (b->a.cur.active && b->now - b->a.cur.t_start >= b->a.cur.planned_s) {
            alma_ev e = {EV_BEHAVIOR_DONE, -1, -1, b->a.cur.behavior, 0, 0, 0, 0};
            alma_event(&b->a, &e, b->now);
        }
        alma_tick(&b->a, b->now, &s);
        alma_mem_tick(&b->mem, &b->a, b->now);
    }
}

/* Ponerse al día sin conductas ni avisos (8.1): solo el estado continuo, en pasos fijos. */
JNIEXPORT void JNICALL FN(ponerseAlDia)(JNIEnv *env, jclass cls, jlong h, jdouble now)
{
    cuerpo *b = (cuerpo *)(intptr_t)h;
    while (b->now + STEP_S <= now) {
        b->now += STEP_S;
        alma_care_tick(&b->a, (float)STEP_S, b->now);
    }
    alma_affect_tick(&b->a, (float)STEP_S, b->now);   /* si no, el ánimo se queda en el de la carga (salía "asustada") */
    alma_mem_flush(&b->mem, &b->a);
}

/* Eventos del reloj al núcleo: tipo = alma_ev_type (EV_TOUCH_PET, EV_PRAISE, EV_SCOLD, …). */
JNIEXPORT void JNICALL FN(evento)(JNIEnv *env, jclass cls, jlong h, jint tipo, jint accion, jfloat valor)
{
    cuerpo *b = (cuerpo *)(intptr_t)h;
    if (tipo < 0 || tipo >= EV_COUNT) return;
    alma_ev e = {(alma_ev_type)tipo, 0, accion, -1, 0, 0, 0, valor};
    alma_event(&b->a, &e, b->now);
}

JNIEXPORT jint JNICALL FN(comer)(JNIEnv *env, jclass cls, jlong h, jstring jfood)
{
    cuerpo *b = (cuerpo *)(intptr_t)h;
    const char *f = (*env)->GetStringUTFChars(env, jfood, NULL);
    int food = alma_food_of(f);
    (*env)->ReleaseStringUTFChars(env, jfood, f);
    if (food < 0) return -1;
    alma_feed_result r = alma_feed(&b->a, food, b->now);
    alma_mem_flush(&b->mem, &b->a);
    return r.accepted ? 1 : 0;
}

/* Lo que diga el cuidado del servidor (hambre, enfermedad, energía) cuando hay conexión. */
JNIEXPORT void JNICALL FN(cuidado)(JNIEnv *env, jclass cls, jlong h, jfloat hunger, jint sick, jfloat energy)
{
    cuerpo *b = (cuerpo *)(intptr_t)h;
    b->a.hunger = hunger < 0 ? 0 : hunger > 1 ? 1 : hunger;
    b->a.sick = sick;
    if (energy > 0) b->a.care_energy = energy;
}

JNIEXPORT jbyteArray JNICALL FN(exportar)(JNIEnv *env, jclass cls, jlong h)
{
    cuerpo *b = (cuerpo *)(intptr_t)h;
    static uint8_t buf[64 * 1024];
    if (alma_mem_flush(&b->mem, &b->a)) return NULL;
    long n = alma_mem_export(&b->mem, buf, sizeof buf);
    if (n < 0) return NULL;
    jbyteArray out = (*env)->NewByteArray(env, (jsize)n);
    (*env)->SetByteArrayRegion(env, out, 0, (jsize)n, (const jbyte *)buf);
    return out;
}

JNIEXPORT jdouble JNICALL FN(ahora)(JNIEnv *env, jclass cls, jlong h)
{
    return ((cuerpo *)(intptr_t)h)->now;
}

/* Estado para dibujar la cara y para la complicación (JSON chico). */
JNIEXPORT jstring JNICALL FN(estado)(JNIEnv *env, jclass cls, jlong h)
{
    const alma_t *a = &((cuerpo *)(intptr_t)h)->a;
    char out[700];
    const char *bhv = a->cur.active && a->cur.behavior >= 0 && a->cur.behavior < a->cat->n ? a->cat->b[a->cur.behavior].id : "";
    snprintf(out, sizeof out,
             "{\"state\":\"%s\",\"mood\":\"%s\",\"behavior\":\"%s\",\"hunger\":%.3f,\"sick\":%d,\"energy\":%.3f,"
             "\"joy\":%.3f,\"fear\":%.3f,\"frust\":%.3f,\"valence\":%.3f,\"arousal\":%.3f,\"boredom\":%.3f,"
             "\"age_days\":%d,\"wellbeing\":%.1f}",
             a->state >= 0 && a->state < 7 ? ST[a->state] : "?", a->simple_mood >= 0 && a->simple_mood < 7 ? SM[a->simple_mood] : "?",
             bhv, a->hunger, a->sick, a->care_energy, a->emo_joy, a->emo_fear, a->emo_frustration,
             a->affect_valence, a->affect_arousal, a->boredom, a->age_days, a->wellbeing);
    return (*env)->NewStringUTF(env, out);
}

/* Juegos del reloj (dueño, 2026-11-01): "empieza", "buena_jugada", "mala_jugada", "gana_alma", "pierde_alma", "empate".
   Mismo efecto que los juegos de la app en el robot (alma_game_event). */
JNIEXPORT jint JNICALL FN(juego)(JNIEnv *env, jclass cls, jlong h, jstring jtipo)
{
    cuerpo *b = (cuerpo *)(intptr_t)h;
    const char *t = (*env)->GetStringUTFChars(env, jtipo, NULL);
    int e = alma_game_ev_of(t);
    (*env)->ReleaseStringUTFChars(env, jtipo, t);
    if (e < 0) return -1;
    alma_game_event(&b->a, (alma_game_ev)e, b->now);
    return 0;
}
