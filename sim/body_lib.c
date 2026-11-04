/* body_lib.c — un "cuerpo" de Alma para la fase 0 del plan del reloj (PLAN-RELOJ-v2.md, sección 19).
 *
 * Envuelve el núcleo real (alma_core) y memory_store con la flash simulada en RAM, para que el árbitro
 * del servidor (relay/alma_relay/body.py) se pruebe con mudanzas de verdad: exportar ALMX en un cuerpo,
 * importarlo en otro y seguir viviendo. Se compila como biblioteca compartida y se usa desde Python (ctypes).
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "alma_core.h"
#include "alma_mem.h"
#include "catalog_load.h"

#if defined(_WIN32)
#define API __declspec(dllexport)
#else
#define API __attribute__((visibility("default")))
#endif

#define REGION (512u * 1024u)
#define STEP_S 1.0             /* paso fijo del núcleo, también al ponerse al día (8.1) */

typedef struct {
    alma_t a;
    alma_mem mem;
    alma_mem_file ff;
    alma_mem_flash fl;
    double now;
} body_t;

static alma_catalog cat;
static int cat_ok;

API int body_catalog(const char *catalog_path, const char *inventory_path)
{
    cat_ok = catalog_load(catalog_path, inventory_path, &cat, 0) > 0;
    return cat_ok ? 0 : -1;
}

static int open_ram(body_t *b)
{
    if (alma_mem_file_open(&b->ff, &b->fl, NULL, REGION)) return -1;
    if (alma_mem_open(&b->mem, &b->fl)) return -1;
    b->mem.fw = "sim-body";
    return 0;
}

/* Nace una Alma nueva en la hora local now_s (segundos desde 1970). */
API body_t *body_new(uint32_t seed, double now_s)
{
    if (!cat_ok) return NULL;
    body_t *b = calloc(1, sizeof *b);
    if (!b || open_ram(b)) { free(b); return NULL; }
    alma_init(&b->a, &cat, seed, now_s, (alma_hooks){0});
    b->mem.birth_unix = (int64_t)now_s;
    b->now = now_s;
    alma_mem_flush(&b->mem, &b->a);
    return b;
}

API void body_free(body_t *b)
{
    if (!b) return;
    alma_mem_file_close(&b->ff);
    free(b);
}

/* Vive hasta now_s en pasos fijos: termina las conductas a tiempo y guarda según el calendario de 06. */
API void body_run(body_t *b, double now_s)
{
    alma_sensors s = {90, 0};
    while (b->now + STEP_S <= now_s) {
        b->now += STEP_S;
        if (b->a.cur.active && b->now - b->a.cur.t_start >= b->a.cur.planned_s) {
            alma_ev e = {EV_BEHAVIOR_DONE, -1, -1, b->a.cur.behavior, 0, 0, 0, 0};
            alma_event(&b->a, &e, b->now);
        }
        alma_tick(&b->a, b->now, &s);
        alma_mem_tick(&b->mem, &b->a, b->now);
    }
}

/* Ponerse al día sin conductas (8.1): el estado continuo avanza, nada se dispara de forma retroactiva. */
API void body_catch_up(body_t *b, double now_s)
{
    while (b->now + STEP_S <= now_s) {
        b->now += STEP_S;
        alma_care_tick(&b->a, (float)STEP_S, b->now);
    }
}

API int body_pet(body_t *b)
{
    alma_ev e = {EV_TOUCH_PET, 0, -1, -1, 0, 0, 0, 1500};
    alma_event(&b->a, &e, b->now);
    return 0;
}

API int body_feed(body_t *b, int food)
{
    if (food < 0 || food >= FOOD_COUNT) return -1;
    alma_feed_result r = alma_feed(&b->a, food, b->now);
    alma_mem_flush(&b->mem, &b->a);    /* evento importante: respaldo inmediato (5.5) */
    return r.accepted;
}

API float body_hunger(const body_t *b) { return b->a.hunger; }
API int body_age_days(const body_t *b) { return b->a.age_days; }
API double body_now(const body_t *b) { return b->now; }

/* Exporta el paquete ALMX tras guardar todo. Devuelve bytes o −1. */
API long body_export(body_t *b, uint8_t *out, uint32_t cap)
{
    if (alma_mem_flush(&b->mem, &b->a)) return -1;
    return alma_mem_export(&b->mem, out, cap);
}

/* Nuevo cuerpo desde un paquete: flash vacía, importar (valida antes de escribir), cargar.
 * now_s = hora del servidor del paquete; luego se pone al día con body_catch_up (5.4). */
API body_t *body_from_package(const uint8_t *pkg, uint32_t n, double now_s)
{
    if (!cat_ok) return NULL;
    body_t *b = calloc(1, sizeof *b);
    if (!b || open_ram(b)) { free(b); return NULL; }
    if (alma_mem_import(&b->mem, pkg, n)) { body_free(b); return NULL; }
    alma_mem_open(&b->mem, &b->fl);
    b->mem.fw = "sim-body";
    alma_init(&b->a, &cat, 0, now_s, (alma_hooks){0});
    alma_mem_load(&b->mem, &b->a);
    b->now = now_s;
    return b;
}
