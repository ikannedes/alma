/* test_memory.c — pruebas de memory_store (06; 08 A2.8 y base de A4.4) sobre la flash simulada en archivo.
 * Uso: test_memory <catalog.json> <inventory.json> <archivo_flash_temporal> */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "alma_core.h"
#include "alma_mem.h"
#include "catalog_load.h"

static int fails, checks;
#define CHECK(cond, ...) do { checks++; if (!(cond)) { fails++; printf("FALLA %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

#define REGION (512u * 1024u)
static alma_catalog cat, cat_swapped;
static const char *flash_path;
static alma_mem_file ff;
static alma_mem_flash fl;
static alma_mem mem;

/* "encender": abre el archivo (lo que quedó tras el corte) y escanea las ranuras */
static void boot(int fresh)
{
    if (fresh) remove(flash_path);
    CHECK(alma_mem_file_open(&ff, &fl, flash_path, REGION) == 0, "abrir %s", flash_path);
    CHECK(alma_mem_open(&mem, &fl) == 0, "alma_mem_open");
}
static void power_off(void) { alma_mem_file_close(&ff); }

/* Un estado con historia: dos días con el dueño (person_id 1) cerca de 8 a 22 h, caricias y elogios */
static void grow(alma_t *a, uint32_t seed)
{
    alma_init(a, &cat, seed, 8 * 3600.0, (alma_hooks){0});
    alma_sensors s = {90, 1};
    for (double t = 8 * 3600.0; t < 2.5 * 86400.0; t += 1.0) {
        double h = fmod(t, 86400.0) / 3600.0;
        if (h >= 8 && h < 22) {
            if (fmod(t, 2.0) == 0) {
                alma_ev e = {EV_FACE_SEEN, 1, -1, -1, 160, 120, 70, 0};
                alma_event(a, &e, t);
            }
            if (fmod(t, 97.0) == 0) { alma_ev e = {EV_TOUCH_PET, 1, -1, -1, 0, 0, 0, 1500}; alma_event(a, &e, t); }
            if (fmod(t, 613.0) == 0) { alma_ev e = {EV_PRAISE, 1, -1, -1, 0, 0, 0, 0}; alma_event(a, &e, t); }
        }
        if (a->cur.active && t - a->cur.t_start >= a->cur.planned_s) {
            alma_ev e = {EV_BEHAVIOR_DONE, -1, -1, a->cur.behavior, 0, 0, 0, 0};
            alma_event(a, &e, t);
        }
        alma_tick(a, t, &s);
    }
}

/* restaurar en una copia con todos los campos persistentes borrados debe dar exactamente el original */
static int restores_exactly(const alma_t *orig, int64_t birth)
{
    static alma_t r;
    r = *orig;
    alma_mem_scrub(&mem, &r);
    alma_mem_load(&mem, &r);
    return memcmp(&r, orig, sizeof r) == 0 && mem.birth_unix == birth;
}

/* Lista de 06, escrita aparte de la tabla de alma_mem.c: si la tabla olvida un campo, esta prueba lo detecta */
static void scrub_06(alma_t *a)
{
    const float nf = NAN;
    const double nd = NAN;
    a->seed = 0x5A5A5A5A; a->age_days = -77;
    for (int k = 0; k < TRAIT_COUNT; k++) a->trait[k] = a->trait_base[k] = a->trait_learned[k] = nf;
    a->mood = a->need_social = nf;
    for (int p = 0; p < ALMA_MAX_PERSONS; p++) {
        alma_person *q = &a->person[p];
        q->used = q->id = q->first_seen_day = q->greeted_this_visit = q->seen_today = -77;
        q->attachment = q->floor = nf;
        q->last_seen_s = q->wary_until_s = nd;
        for (int b = 0; b < cat.n; b++) q->pref[b] = nf;
    }
    for (int b = 0; b < cat.n; b++) { a->interest[b] = nf; a->counts.behaviors[b] = -77; }
    for (int k = 0; k < ACT_COUNT; k++) a->trained[k] = nf;
    for (int h = 0; h < 24; h++) { a->home_presence_hist[h] = nf; a->hour_seen[h] = -77; }
    a->night_start_h = a->night_done_for_day = -77;
    alma_counters *c = &a->counts;
    c->pets = c->praises = c->scolds = c->shakes = c->play_done = c->play_ignored = c->scares = c->novel_ok = c->explore_ok = -77;
    a->servo_active_s_today = nf;
}

static void test_fields_of_06(const alma_t *a)
{
    static alma_t r;
    boot(1);
    mem.birth_unix = 42;
    alma_mem_save(&mem, a, MEM_ALL);
    power_off();
    boot(0);
    r = *a;
    scrub_06(&r);
    alma_mem_load(&mem, &r);
    CHECK(memcmp(&r, a, sizeof r) == 0 && mem.birth_unix == 42, "todos los campos de 06 se restauran");
    power_off();
}

static void test_crc(void)
{
    CHECK(alma_crc32(0, "123456789", 9) == 0xCBF43926u, "CRC-32 de \"123456789\" = %08X", alma_crc32(0, "123456789", 9));
    uint32_t c = alma_crc32(0, "1234", 4);
    CHECK(alma_crc32(c, "56789", 5) == 0xCBF43926u, "CRC-32 por partes");
}

static void test_roundtrip_and_changed_only(const alma_t *a)
{
    boot(1);
    CHECK(mem.recovered == 1, "flash nueva: nada que recuperar, memory_recovered = true");
    for (int b = 0; b < ALMA_MEM_BLOCKS; b++) CHECK(mem.b[b].status == MEM_EMPTY, "flash nueva: %s vacío", alma_mem_block_name(b));
    mem.birth_unix = 1793404800;   /* 2026-10-30 */
    CHECK(alma_mem_save(&mem, a, MEM_ALL) == 6, "primer guardado: los 6 bloques con codificador");
    CHECK(alma_mem_save(&mem, a, MEM_ALL) == 0, "sin cambios no se escribe nada");
    static alma_t b;
    b = *a;
    b.mood += 0.01f;
    CHECK(alma_mem_save(&mem, &b, MEM_ALL) == 1 && mem.writes_by_block[MEM_AFFECT] == 2, "cambia mood: solo se escribe affect");
    CHECK(alma_mem_save(&mem, a, MEM_ALL) == 1, "vuelve a cambiar: otra escritura de affect");
    power_off();
    boot(0);
    CHECK(mem.recovered == 1 && mem.b[MEM_AFFECT].seq == 3 && mem.b[MEM_IDENTITY].seq == 1, "tras reiniciar: seq de affect 3, identity 1");
    CHECK(restores_exactly(a, 1793404800), "guardar y restaurar da el mismo estado, byte por byte");
    power_off();
}

/* A2.8: 20 cortes de energía en puntos distintos de la escritura de bonds (el bloque más grande) */
static void test_power_cuts(const alma_t *a0)
{
    static alma_t prev, next;
    prev = *a0;
    boot(1);
    mem.birth_unix = 1;
    alma_mem_save(&mem, &prev, MEM_ALL);
    uint32_t L = mem.b[MEM_BONDS].len, H = ALMA_MEM_SECTOR + L;   /* costo de una ranura: borrar 4096, payload L, encabezado 16 */
    power_off();
    const long long cut[20] = {
        0, 1, 2048, ALMA_MEM_SECTOR - 1,                                       /* a mitad del borrado */
        ALMA_MEM_SECTOR, ALMA_MEM_SECTOR + 1, ALMA_MEM_SECTOR + L / 10, ALMA_MEM_SECTOR + L / 4,
        ALMA_MEM_SECTOR + L / 2, ALMA_MEM_SECTOR + 3 * L / 4, ALMA_MEM_SECTOR + L - 1,   /* a mitad del payload */
        H, H + 1, H + 3, H + 5, H + 7, H + 9, H + 12, H + 14, H + 15};          /* a mitad del encabezado */
    int got_old = 0, got_new_late = 0;
    for (int i = 0; i < 20; i++) {
        next = prev;
        next.person[0].attachment = 0.30f + 0.01f * i;
        next.person[0].last_seen_s += 100 * (i + 1);
        boot(0);
        alma_mem_file_cut(&ff, cut[i]);
        int before = mem.b[MEM_BONDS].latest;
        CHECK(alma_mem_save(&mem, &next, MEM_BIT(MEM_BONDS)) == -1, "corte %d en el byte %lld: la escritura falla", i, cut[i]);
        power_off();
        boot(0);   /* se enciende con lo que quedó en el flash */
        CHECK(mem.recovered == 1 && mem.b[MEM_BONDS].status == MEM_OK, "corte %d: hay una copia válida", i);
        if (mem.b[MEM_BONDS].latest == before) {
            got_old++;
            CHECK(restores_exactly(&prev, 1), "corte %d (byte %lld): se recupera la última copia válida", i, cut[i]);
        } else {
            /* solo vale si el corte fue en el último byte del CRC y ese byte quedó bien por azar */
            got_new_late++;
            CHECK(cut[i] == H + 15 && restores_exactly(&next, 1), "corte %d: copia nueva solo si el encabezado quedó completo", i);
        }
        /* la siguiente escritura sin corte llega completa y tampoco toca la copia válida anterior */
        CHECK(alma_mem_save(&mem, &next, MEM_BIT(MEM_BONDS)) >= 0, "corte %d: la escritura siguiente funciona", i);
        power_off();
        boot(0);
        CHECK(restores_exactly(&next, 1), "corte %d: tras escribir de nuevo se restaura la copia nueva", i);
        power_off();
        prev = next;
    }
    printf("A2.8: 20 cortes en bonds (payload %u B): %d recuperan la copia anterior, %d la nueva completa\n", L, got_old, got_new_late);

    /* además: 20 cortes al azar durante un guardado de todos los bloques; cada bloque queda viejo o nuevo, nunca mezclado */
    static alma_t base, mod;
    base = *a0;
    boot(1);
    mem.birth_unix = 1;
    alma_mem_save(&mem, &base, MEM_ALL);
    power_off();
    uint32_t rnd = 12345;
    int mixed = 0;
    for (int i = 0; i < 20; i++) {
        mod = base;
        mod.mood = -0.2f + 0.01f * i; mod.trait_learned[1] = 0.001f * i; mod.trait[1] = mod.trait_base[1] + mod.trait_learned[1];
        mod.person[0].attachment = 0.5f + 0.01f * i; mod.interest[2] = 0.5f; mod.home_presence_hist[3] = 0.1f * (i % 7);
        mod.counts.pets = i; mod.age_days = base.age_days + i + 1;
        boot(0);
        rnd = rnd * 1103515245u + 12345u;
        alma_mem_file_cut(&ff, (long long)(rnd % (6 * (ALMA_MEM_SECTOR + 3000))));
        alma_mem_save(&mem, &mod, MEM_ALL);
        power_off();
        boot(0);
        static alma_t r;
        r = base;
        alma_mem_load(&mem, &r);
        /* bloque a bloque: cada uno es el de `base` o el de `mod` */
        int ok = mem.recovered == 1
              && (r.mood == base.mood || r.mood == mod.mood)
              && (r.person[0].attachment == base.person[0].attachment || r.person[0].attachment == mod.person[0].attachment)
              && (r.age_days == base.age_days || (r.age_days == mod.age_days && r.trait_learned[1] == mod.trait_learned[1]))
              && (r.counts.pets == base.counts.pets || r.counts.pets == mod.counts.pets)
              && (r.home_presence_hist[3] == base.home_presence_hist[3] || r.home_presence_hist[3] == mod.home_presence_hist[3]);
        mixed += !ok;
        alma_mem_save(&mem, &mod, MEM_ALL);   /* termina el guardado tras encender */
        power_off();
        base = mod;
    }
    CHECK(mixed == 0, "cortes al azar en un guardado completo: %d estados mezclados", mixed);
}

/* affect rota entre 8 ranuras: reparte los borrados, y un corte en cualquier ranura recupera la copia anterior */
static void test_affect_ring(const alma_t *a)
{
    static alma_t b, r;
    b = *a;
    boot(1);
    alma_mem_save(&mem, &b, MEM_ALL);
    float last_ok = b.mood;
    uint32_t rnd = 777;
    int cuts = 0, bad = 0;
    for (int i = 1; i <= 40; i++) {
        b.mood = 0.001f * i;
        int cut = i % 3 == 0;
        if (cut) {
            rnd = rnd * 1103515245u + 12345u;
            alma_mem_file_cut(&ff, (long long)(rnd % (ALMA_MEM_SECTOR + 40)));
        }
        int w = alma_mem_save(&mem, &b, MEM_BIT(MEM_AFFECT));
        power_off();
        boot(0);
        r = b;
        r.mood = NAN;
        alma_mem_load(&mem, &r);
        /* tras un corte vale la copia anterior; sin corte, la nueva */
        float want = w < 0 ? last_ok : b.mood;
        if (r.mood != want || mem.recovered != 1) bad++;
        if (w >= 0) last_ok = b.mood;
        cuts += cut;
        if (w < 0) b.mood = last_ok;   /* el estado vivo se pierde con el corte */
    }
    CHECK(bad == 0, "anillo de affect: 40 escrituras con %d cortes, %d recuperaciones malas", cuts, bad);
    uint32_t mn = 0xFFFFFFFFu, mx = 0;
    for (int s = 0; s < alma_mem_slot_count(MEM_AFFECT); s++) {
        uint32_t c = ff.erase_count[alma_mem_slot_off(MEM_AFFECT, s) / ALMA_MEM_SECTOR];
        if (c < mn) mn = c;
        if (c > mx) mx = c;
    }
    (void)mn; (void)mx;   /* erase_count se reinicia en cada boot(); el reparto se mide abajo sin reiniciar */
    power_off();

    boot(1);
    for (int i = 0; i < 80; i++) { b.mood = 0.5f + 0.001f * i; alma_mem_save(&mem, &b, MEM_BIT(MEM_AFFECT)); }
    mn = 0xFFFFFFFFu; mx = 0;
    for (int s = 0; s < alma_mem_slot_count(MEM_AFFECT); s++) {
        uint32_t c = ff.erase_count[alma_mem_slot_off(MEM_AFFECT, s) / ALMA_MEM_SECTOR];
        if (c < mn) mn = c;
        if (c > mx) mx = c;
    }
    CHECK(alma_mem_slot_count(MEM_AFFECT) == 8 && mn == 10 && mx == 10, "80 escrituras de affect: 10 borrados en cada una de sus 8 ranuras (%u a %u)", mn, mx);
    CHECK(alma_mem_region_bytes() <= 512u * 1024u, "el layout cabe en 512 KB (%u)", alma_mem_region_bytes());
    power_off();
}

/* Las dos ranuras dañadas: valores por omisión y memory_recovered = false */
static void test_both_slots_corrupt(const alma_t *a)
{
    static alma_t b, fresh, r;
    b = *a;
    boot(1);
    alma_mem_save(&mem, &b, MEM_ALL);
    b.mood += 0.1f; b.need_social += 0.1f; b.person[0].attachment += 0.05f; b.interest[0] *= 0.5f;
    b.home_presence_hist[0] += 0.1f; b.counts.pets++; b.trait_learned[0] += 0.001f; b.age_days++;
    alma_mem_save(&mem, &b, MEM_ALL);   /* ahora las dos ranuras de cada bloque tienen copia válida */
    power_off();
    /* daño en un byte del payload de cada ranura de cada bloque */
    FILE *f = fopen(flash_path, "r+b");
    for (int k = 0; k < MEM_JOURNAL; k++)
        for (int s = 0; s < alma_mem_slot_count(k); s++) {
            long off = (long)alma_mem_slot_off(k, s) + 16 + 5;
            fseek(f, off, SEEK_SET);
            int c = fgetc(f);
            fseek(f, off, SEEK_SET);
            fputc(c ^ 0x10, f);
        }
    fclose(f);
    boot(0);
    alma_init(&fresh, &cat, a->seed, 8 * 3600.0, (alma_hooks){0});
    r = fresh;
    alma_mem_load(&mem, &r);
    CHECK(mem.recovered == 0, "las dos ranuras dañadas: memory_recovered = false");
    for (int k = 0; k < MEM_JOURNAL; k++) CHECK(mem.b[k].status == MEM_CORRUPT, "%s: MEM_CORRUPT", alma_mem_block_name(k));
    CHECK(memcmp(&r, &fresh, sizeof r) == 0, "arranca con los valores por omisión de alma_init");
    /* al guardar otra vez se recupera la normalidad */
    CHECK(alma_mem_save(&mem, &r, MEM_ALL) == 6, "guardar tras el daño escribe los 6 bloques");
    power_off();
    boot(0);
    CHECK(mem.recovered == 1, "después de guardar: memory_recovered = true");
    power_off();

    /* solo affect dañado: los demás bloques se restauran */
    boot(1);
    alma_mem_save(&mem, a, MEM_ALL);
    b = *a; b.mood += 0.2f;
    alma_mem_save(&mem, &b, MEM_ALL);
    power_off();
    f = fopen(flash_path, "r+b");
    for (int s = 0; s < 2; s++) { fseek(f, (long)alma_mem_slot_off(MEM_AFFECT, s) + 16, SEEK_SET); fputc(0x00, f); fputc(0x00, f); }
    fclose(f);
    boot(0);
    r = fresh;
    alma_mem_load(&mem, &r);
    CHECK(mem.recovered == 0 && mem.b[MEM_AFFECT].status == MEM_CORRUPT, "affect dañado: memory_recovered = false");
    CHECK(r.mood == fresh.mood && r.need_social == fresh.need_social, "affect por omisión");
    CHECK(r.person[0].attachment == a->person[0].attachment && r.trait_learned[0] == a->trait_learned[0]
          && r.age_days == a->age_days && r.interest[3] == a->interest[3], "los otros bloques se restauran");
    power_off();
}

/* Exportar → importar → exportar da los mismos bytes (base de A4.4) */
static void test_export_import(const alma_t *a)
{
    static uint8_t e1[64 * 1024], e2[64 * 1024];
    boot(1);
    mem.birth_unix = 1793404800;
    mem.fw = "alma-0.1";
    alma_mem_save(&mem, a, MEM_ALL);
    long n1 = alma_mem_export(&mem, e1, sizeof e1);
    power_off();
    CHECK(n1 > 0, "exportar");
    boot(1);   /* "otra unidad": flash vacía */
    mem.fw = "alma-0.1";
    CHECK(alma_mem_import(&mem, e1, (uint32_t)n1) == 0, "importar");
    power_off();
    boot(0);
    mem.fw = "alma-0.1";
    long n2 = alma_mem_export(&mem, e2, sizeof e2);
    CHECK(n2 == n1 && memcmp(e1, e2, (size_t)n1) == 0, "exportar → importar → exportar: %ld y %ld bytes, idénticos", n1, n2);
    CHECK(restores_exactly(a, 1793404800), "lo importado restaura el mismo estado");
    printf("exportación: %ld bytes\n", n1);
    power_off();

    /* un byte alterado o un esquema más nuevo: se rechaza sin tocar el flash */
    boot(1);
    e1[40] ^= 1;
    CHECK(alma_mem_import(&mem, e1, (uint32_t)n1) == -1 && mem.writes == 0, "CRC global malo: se rechaza y no escribe");
    e1[40] ^= 1;
    e1[24 + 1] = 9;   /* esquema del primer bloque = 9, con el CRC global corregido */
    uint32_t c = alma_crc32(0, e1, (uint32_t)n1 - 4);
    for (int k = 0; k < 4; k++) e1[n1 - 4 + k] = (uint8_t)(c >> 8 * k);
    CHECK(alma_mem_import(&mem, e1, (uint32_t)n1) == -1 && mem.writes == 0, "esquema más nuevo que el firmware: se rechaza");
    power_off();
}

/* El estado del cuerpo (MEM_BODY, PLAN-RELOJ-v2 5.7): sobrevive al reinicio, nunca va en la exportación (la de los
   demás bloques no cambia) y un paquete que lo traiga se rechaza */
static void test_body_block(const alma_t *a)
{
    static uint8_t e1[64 * 1024], e2[64 * 1024], bad[64 * 1024];
    boot(1);
    mem.fw = "alma-0.1";
    alma_mem_body_v1 b;
    CHECK(alma_mem_body_get(&mem, &b) == -1 && b.n == 0 && b.copy == 0, "flash nueva: sin estado del cuerpo");
    alma_mem_save(&mem, a, MEM_ALL);
    long n1 = alma_mem_export(&mem, e1, sizeof e1);
    uint32_t w0 = mem.writes;
    alma_mem_body_v1 put = {7, 96, 1, 1};
    CHECK(alma_mem_body_put(&mem, &put) == 0 && mem.writes == w0 + 1, "se guarda el estado del cuerpo");
    CHECK(alma_mem_body_put(&mem, &put) == 0 && mem.writes == w0 + 1, "sin cambios no se vuelve a escribir");
    CHECK(alma_mem_save(&mem, a, MEM_ALL) == 0, "alma_mem_save no toca el bloque del cuerpo");
    long n2 = alma_mem_export(&mem, e2, sizeof e2);
    CHECK(n2 == n1 && memcmp(e1, e2, (size_t)n1) == 0, "la exportación no cambia con el bloque del cuerpo (%ld = %ld bytes)", n2, n1);
    power_off();
    boot(0);
    CHECK(alma_mem_body_get(&mem, &b) == 0 && b.n == 7 && b.bseq == 96 && b.proto == 1 && b.copy == 1,
          "tras reiniciar: n %u, bseq %u, proto %d, copia %d", b.n, b.bseq, b.proto, b.copy);
    put.copy = 0;
    put.n = 8;
    CHECK(alma_mem_body_put(&mem, &put) == 0 && alma_mem_body_get(&mem, &b) == 0 && b.n == 8 && b.copy == 0, "segunda escritura (otra ranura)");
    power_off();
    /* un paquete con un bloque MEM_BODY agregado al final (CRC global correcto): se rechaza sin escribir */
    memcpy(bad, e1, (size_t)n1 - 4);
    long k = n1 - 4;
    bad[k++] = MEM_BODY; bad[k++] = 1; bad[k++] = 0; bad[k++] = 10; bad[k++] = 0;
    memset(bad + k, 0, 10);
    k += 10;
    bad[6] = (uint8_t)(e1[6] + 1);   /* un bloque más en la cuenta */
    uint32_t c = alma_crc32(0, bad, (uint32_t)k);
    for (int i = 0; i < 4; i++) bad[k++] = (uint8_t)(c >> 8 * i);
    boot(1);
    CHECK(alma_mem_import(&mem, bad, (uint32_t)k) == -1 && mem.writes == 0, "un paquete con el estado del cuerpo se rechaza y no escribe");
    CHECK(alma_mem_import(&mem, e1, (uint32_t)n1) == 0 && alma_mem_body_get(&mem, &b) == -1, "importar no crea estado del cuerpo");
    power_off();
}

/* Un catálogo reordenado (firmware nuevo) no mezcla los valores por conducta */
static void test_catalog_reorder(const alma_t *a)
{
    static alma_t r;
    boot(1);
    alma_mem_save(&mem, a, MEM_ALL);
    power_off();
    cat_swapped = cat;
    cat_swapped.b[0] = cat.b[cat.n - 1];
    cat_swapped.b[cat.n - 1] = cat.b[0];
    boot(0);
    alma_init(&r, &cat_swapped, a->seed, 0, (alma_hooks){0});
    alma_mem_load(&mem, &r);
    int last = cat.n - 1;
    CHECK(r.interest[0] == a->interest[last] && r.interest[last] == a->interest[0], "interest sigue al id de la conducta");
    CHECK(r.counts.behaviors[0] == a->counts.behaviors[last] && r.person[0].pref[last] == a->person[0].pref[0], "contadores y pref también");
    power_off();
}

/* Calendario de 06: cada 10 min (affect, bonds y counters_today si cambiaron) y eventos que fuerzan guardado */
static void test_schedule(const alma_t *a)
{
    static alma_t b;
    b = *a;
    boot(1);
    alma_mem_save(&mem, &b, MEM_ALL);
    uint32_t w0 = mem.writes;
    double t = 1e6;
    alma_mem_tick(&mem, &b, t);
    for (int i = 1; i <= 3600; i++) { b.mood = 0.1f + i * 1e-5f; alma_mem_tick(&mem, &b, t + i); }
    CHECK(mem.writes - w0 == 6 && mem.writes_by_block[MEM_AFFECT] == 7, "1 h con mood cambiando: 6 escrituras de affect (%u)", mem.writes - w0);
    b.interest[1] *= 0.9f;
    alma_mem_on_event(&mem, &b, EV_TOUCH_PET);
    CHECK(mem.writes - w0 == 6, "un evento cualquiera no guarda");
    alma_mem_on_event(&mem, &b, EV_CHARGING_ON);
    CHECK(mem.writes_by_block[MEM_LEARNING] == 2, "EV_CHARGING_ON guarda todo lo que cambió (learning incluido)");
    b.interest[1] *= 0.9f;
    alma_mem_tick(&mem, &b, t + 3601);
    CHECK(mem.writes_by_block[MEM_LEARNING] == 2, "learning no entra en el guardado periódico");
    b.state = ST_SLEEPING;
    alma_mem_tick(&mem, &b, t + 3602);
    CHECK(mem.writes_by_block[MEM_LEARNING] == 3, "entrar a ST_SLEEPING guarda todo");
    /* dormida: affect no se guarda cada 10 min; bonds y counters_today sí, si cambiaron */
    uint32_t aff = mem.writes_by_block[MEM_AFFECT], cnt = mem.writes_by_block[MEM_COUNTERS_TODAY];
    for (int i = 1; i <= 3600; i++) { b.mood = 0.3f + i * 1e-5f; if (i == 1000) b.counts.scares++; alma_mem_tick(&mem, &b, t + 3602 + i); }
    CHECK(mem.writes_by_block[MEM_AFFECT] == aff && mem.writes_by_block[MEM_COUNTERS_TODAY] == cnt + 1,
          "1 h dormida: 0 escrituras de affect y 1 de counters_today");
    b.state = ST_AWAKE;
    alma_mem_tick(&mem, &b, t + 3602 + 3601);
    for (int i = 2; i <= 600; i++) alma_mem_tick(&mem, &b, t + 3602 + 3600 + i);
    CHECK(mem.writes_by_block[MEM_AFFECT] == aff + 1, "al despertar, affect vuelve al periodo de 10 min");
    b.counts.pets++;
    CHECK(alma_mem_flush(&mem, &b) == 0 && mem.writes_by_block[MEM_COUNTERS_TODAY] == cnt + 2, "flush (actualización, apagado) guarda counters_today");
    power_off();
}

/* Nacimiento (robot, 2026-10-30): un reinicio antes de la primera noche renacía con otros rasgos */
static void test_birth(void)
{
    static alma_t a, r;
    alma_init(&a, &cat, 77, 8 * 3600.0, (alma_hooks){0});
    boot(1);
    alma_mem_tick(&mem, &a, 8 * 3600.0);
    CHECK(mem.b[MEM_IDENTITY].status == MEM_OK, "nacimiento: la identidad se guarda en el primer tick (%d)", mem.b[MEM_IDENTITY].status);
    power_off();
    boot(0);
    alma_init(&r, &cat, 999, 9 * 3600.0, (alma_hooks){0});   /* otra semilla: otros rasgos si no se restaura */
    alma_mem_load(&mem, &r);
    int same = 1;
    for (int k = 0; k < TRAIT_COUNT; k++) same &= r.trait[k] == a.trait[k] && r.trait_base[k] == a.trait_base[k];
    CHECK(same, "reinicio antes de la primera noche: la misma Alma (valentía %.2f = %.2f)", r.trait[0], a.trait[0]);
    power_off();
}

/* Lleva las copias de un bloque a un esquema viejo: quita los últimos `cut` bytes y rehace encabezado y CRC */
static void downgrade(int b, uint16_t schema, uint16_t cut)
{
    for (int s = 0; s < alma_mem_slot_count(b); s++) {
        uint32_t off = alma_mem_slot_off(b, s);
        uint8_t h[16];
        static uint8_t pay[ALMA_MEM_SECTOR];
        fl.read(fl.ctx, off, h, 16);
        uint32_t magic = h[0] | h[1] << 8 | h[2] << 16 | (uint32_t)h[3] << 24;
        uint16_t len = (uint16_t)(h[6] | h[7] << 8);
        if (magic != ALMA_REC_MAGIC || len < cut) continue;
        fl.read(fl.ctx, off + 16, pay, len);
        len = (uint16_t)(len - cut);
        uint32_t crc = alma_crc32(0, pay, len);
        h[4] = (uint8_t)schema; h[5] = (uint8_t)(schema >> 8); h[6] = (uint8_t)len; h[7] = (uint8_t)(len >> 8);
        for (int i = 0; i < 4; i++) h[12 + i] = (uint8_t)(crc >> (8 * i));
        fl.erase(fl.ctx, off, ALMA_MEM_SECTOR);
        fl.write(fl.ctx, off + 16, pay, len);
        fl.write(fl.ctx, off, h, 16);
    }
}

/* Tamagotchi (2026-10-30): la memoria que ya tiene el robot (affect v2, counters_today v2, learning v1) se lee con la
   versión nueva sin perder nada; lo agregado queda en 0 y los gustos de comida salen de la semilla */
static void test_migrate_tamagotchi(const alma_t *a0)
{
    static alma_t a, r, fresh;
    a = *a0;
    a.hunger = 0.8f; a.sick = 1; a.faint_s = 1.79e9; a.counts.meals = 2; a.counts.remote_play_s = 600; a.food_like[FOOD_PIZZA] = 0.9f;
    boot(1);
    CHECK(alma_mem_save(&mem, &a, MEM_ALL) >= 0, "guardar");
    r = a;
    alma_mem_scrub(&mem, &r);
    alma_mem_load(&mem, &r);
    CHECK(r.hunger == 0.8f && r.sick == 1 && r.counts.meals == 2 && r.counts.remote_play_s == 600 && r.food_like[FOOD_PIZZA] == 0.9f,
          "v3: hambre, empacho, contadores y gustos sobreviven al reinicio");
    CHECK(r.faint_s == 1.79e9, "v4: el desmayo sobrevive al reinicio");
    downgrade(MEM_AFFECT, 2, 16);   /* v4 → v2: sin desmayo (8) ni tamagotchi (8) */
    downgrade(MEM_COUNTERS_TODAY, 2, 20);
    downgrade(MEM_LEARNING, 1, 4 * FOOD_COUNT);
    power_off();
    boot(0);
    CHECK(mem.b[MEM_AFFECT].schema == 2 && mem.b[MEM_LEARNING].schema == 1 && mem.b[MEM_COUNTERS_TODAY].schema == 2,
          "en el flash: los esquemas de antes (affect 2, learning 1, counters 2)");
    r = a;
    alma_mem_scrub(&mem, &r);
    alma_mem_load(&mem, &r);
    CHECK(mem.recovered && mem.b[MEM_AFFECT].status == MEM_OK && mem.b[MEM_LEARNING].status == MEM_OK,
          "las migraciones leen los bloques viejos (memory_recovered)");
    CHECK(r.wellbeing == a.wellbeing && r.mood == a.mood && r.counts.lifts == a.counts.lifts && r.counts.pets == a.counts.pets
          && memcmp(r.interest, a.interest, sizeof r.interest) == 0 && memcmp(r.trained, a.trained, sizeof r.trained) == 0,
          "lo de antes queda igual (bienestar, ánimo, contadores, intereses)");
    int zero = 1;
    for (int f = 0; f < FOOD_COUNT; f++) zero &= r.food_like[f] == 0;
    CHECK(r.hunger == 0 && r.sick == 0 && r.faint_s == 0 && r.counts.meals == 0 && r.counts.remote_play_s == 0 && zero, "lo nuevo en 0");
    alma_food_prefs_init(&r);
    alma_init(&fresh, &cat, r.seed, 0, (alma_hooks){0});
    CHECK(memcmp(r.food_like, fresh.food_like, sizeof r.food_like) == 0 && r.food_like[FOOD_PIZZA] != 0,
          "los gustos se sacan de la semilla: los mismos que al nacer");
    power_off();
}

int main(int argc, char **argv)
{
    if (argc < 4) { fprintf(stderr, "uso: %s <catalog.json> <inventory.json> <archivo_flash_temporal>\n", argv[0]); return 2; }
    if (catalog_load(argv[1], argv[2], &cat, 0) <= 0) return 1;
    flash_path = argv[3];
    static alma_t a;
    grow(&a, 3);
    CHECK(a.age_days >= 2 && a.person[0].used && a.counts.pets > 0, "estado con historia (día %d, %d caricias)", a.age_days, a.counts.pets);
    test_crc();
    test_roundtrip_and_changed_only(&a);
    test_fields_of_06(&a);
    test_power_cuts(&a);
    test_affect_ring(&a);
    test_both_slots_corrupt(&a);
    test_export_import(&a);
    test_body_block(&a);
    test_catalog_reorder(&a);
    test_schedule(&a);
    test_birth();
    test_migrate_tamagotchi(&a);
    remove(flash_path);
    printf("%d comprobaciones, %d fallas\n", checks, fails);
    return fails != 0;
}
