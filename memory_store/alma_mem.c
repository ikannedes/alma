/* alma_mem.c — memory_store (06): bloques, ranuras, calendario de guardado, exportación e importación. */
#include <math.h>
#include <stddef.h>
#include <string.h>
#include "alma_mem.h"

_Static_assert(sizeof(int) == 4, "los campos int del núcleo se guardan como 32 bits");
_Static_assert(sizeof(float) == 4 && sizeof(double) == 8, "IEEE 754");

/* ---- CRC-32 ----
 * En el ESP32 se usa la del ROM (la misma que ya valida otadata, 02); esp_rom_crc32_le(0, …) = binascii.crc32. */
#ifdef ESP_PLATFORM
#include "esp_rom_crc.h"
uint32_t alma_crc32(uint32_t crc, const void *buf, uint32_t n) { return esp_rom_crc32_le(crc, buf, n); }
#else
uint32_t alma_crc32(uint32_t crc, const void *buf, uint32_t n)
{
    const uint8_t *p = buf;
    crc = ~crc;
    while (n--) {
        crc ^= *p++;
        for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320u & -(crc & 1u));
    }
    return ~crc;
}
#endif

/* ---- escritura y lectura little-endian con límites ---- */
typedef struct { uint8_t *p; uint32_t n, cap; int err; } wbuf;
typedef struct { const uint8_t *p; uint32_t n, len; int err; } rbuf;

static void w_bytes(wbuf *w, const void *src, uint32_t k)
{
    if (w->err || w->cap - w->n < k) { w->err = 1; return; }
    memcpy(w->p + w->n, src, k);
    w->n += k;
}
static void w_u8(wbuf *w, uint8_t v) { w_bytes(w, &v, 1); }
static void w_u16(wbuf *w, uint16_t v) { uint8_t b[2] = {(uint8_t)v, (uint8_t)(v >> 8)}; w_bytes(w, b, 2); }
static void w_u32(wbuf *w, uint32_t v) { uint8_t b[4] = {(uint8_t)v, (uint8_t)(v >> 8), (uint8_t)(v >> 16), (uint8_t)(v >> 24)}; w_bytes(w, b, 4); }
static void w_u64(wbuf *w, uint64_t v) { w_u32(w, (uint32_t)v); w_u32(w, (uint32_t)(v >> 32)); }
static void w_f32(wbuf *w, float v) { uint32_t u; memcpy(&u, &v, 4); w_u32(w, u); }

static const uint8_t *r_bytes(rbuf *r, uint32_t k)
{
    if (r->err || r->len - r->n < k) { r->err = 1; return NULL; }
    const uint8_t *q = r->p + r->n;
    r->n += k;
    return q;
}
static uint8_t r_u8(rbuf *r) { const uint8_t *q = r_bytes(r, 1); return q ? q[0] : 0; }
static uint16_t r_u16(rbuf *r) { const uint8_t *q = r_bytes(r, 2); return q ? (uint16_t)(q[0] | q[1] << 8) : 0; }
static uint32_t r_u32(rbuf *r)
{
    const uint8_t *q = r_bytes(r, 4);
    return q ? (uint32_t)q[0] | (uint32_t)q[1] << 8 | (uint32_t)q[2] << 16 | (uint32_t)q[3] << 24 : 0;
}
static uint64_t r_u64(rbuf *r) { uint64_t lo = r_u32(r); return lo | (uint64_t)r_u32(r) << 32; }
static float r_f32(rbuf *r) { uint32_t u = r_u32(r); float v; memcpy(&v, &u, 4); return v; }

/* ---- bloques: tabla de campos de alma_t ----
 * Los arreglos por conducta (keyed) se guardan en el orden de una lista de hashes FNV-1a de los id del
 * catálogo, así un catálogo reordenado o con conductas nuevas no mezcla los valores entre conductas. */
enum { FK_I32, FK_U32, FK_F32, FK_F64 };
typedef struct { uint32_t off; uint8_t kind, n, keyed; } fld;

#define F(field, kind, n) {offsetof(alma_t, field), kind, n, 0}
#define K(field, kind)    {offsetof(alma_t, field), kind, ALMA_MAX_BEHAVIORS, 1}
#define P(field, kind, n) {offsetof(alma_person, field), kind, n, 0}
#define PK(field, kind)   {offsetof(alma_person, field), kind, ALMA_MAX_BEHAVIORS, 1}

static const fld F_IDENTITY[] = {F(seed, FK_U32, 1), F(age_days, FK_I32, 1)};
static const fld F_AFFECT[] = {   /* v2 (2026-10-30): bienestar de largo plazo y días seguidos sin verte (04) */
    F(mood, FK_F32, 1), F(need_social, FK_F32, 1), F(wellbeing, FK_F32, 1), F(absent_days, FK_I32, 1),
    F(hunger, FK_F32, 1), F(sick, FK_I32, 1)};   /* v3 (2026-10-30): tamagotchi */
static const fld F_BONDS_P[] = {   /* por persona; seen_today agregado a 06: lo usa el pase nocturno */
    P(used, FK_I32, 1), P(id, FK_I32, 1), P(attachment, FK_F32, 1), P(floor, FK_F32, 1), P(last_seen_s, FK_F64, 1),
    P(first_seen_day, FK_I32, 1), P(wary_until_s, FK_F64, 1), P(greeted_this_visit, FK_I32, 1), P(seen_today, FK_I32, 1),
    PK(pref, FK_F32)};
static const fld F_LEARNING[] = {K(interest, FK_F32), F(trained, FK_F32, ACT_COUNT),
    F(food_like, FK_F32, FOOD_COUNT)};   /* v2 (2026-10-30): gustos de comida (tamagotchi) */
static const fld F_RHYTHM[] = {   /* night_done_for_day agregado a 06: evita repetir el pase nocturno tras un reinicio */
    F(home_presence_hist, FK_F32, 24), F(night_start_h, FK_I32, 1), F(night_done_for_day, FK_I32, 1)};
static const fld F_COUNTERS[] = {   /* pets … explore_ok son 9 int contiguos de alma_counters; hour_seen agregado a 06 */
    F(counts.pets, FK_I32, 9), K(counts.behaviors, FK_I32), F(servo_active_s_today, FK_F32, 1), F(hour_seen, FK_I32, 24),
    F(counts.lifts, FK_I32, 1),    /* v2 (2026-10-30): levantadas del día, para el bienestar */
    F(counts.meals, FK_I32, 5)};   /* v3 (2026-10-30): meals, treats, refused, starve_min, remote_play_s */
_Static_assert(offsetof(alma_counters, remote_play_s) - offsetof(alma_counters, meals) == 4 * sizeof(int), "alma_counters cambió");
_Static_assert(offsetof(alma_counters, explore_ok) - offsetof(alma_counters, pets) == 8 * sizeof(int), "alma_counters cambió");

typedef void (*enc_fn)(wbuf *, const alma_mem *, const alma_t *);
typedef void (*dec_fn)(rbuf *, alma_mem *, alma_t *, int apply);
typedef int (*migrate_fn)(uint8_t *payload, uint16_t *len, uint32_t cap);   /* vN → vN+1 en el mismo búfer; 0 = ok */

typedef struct {
    const char *name;
    uint16_t schema;               /* esquema actual */
    uint16_t sectors;              /* por ranura; 0 = no vive en esta región */
    const fld *f; uint8_t nf;      /* campos de alma_t */
    const fld *pf; uint8_t npf;    /* campos de cada alma_person (bonds) */
    enc_fn enc_x; dec_fn dec_x;    /* parte que no es tabla, antes de los campos */
    const migrate_fn *migrate;     /* migrate[i] = migrate_v{i+1}_to_v{i+2} */
    uint8_t n_migrate;
    int has_codec;                 /* 0 = stub: el esquema está definido pero aún no se guarda */
    uint8_t slots;                 /* ranuras en rotación; 0 = 2 */
} blk_def;

/* identity: fecha de nacimiento y rasgos por separado, con alma_traits_export / alma_traits_import (04, "Plasticidad") */
static void enc_identity(wbuf *w, const alma_mem *m, const alma_t *a)
{
    float base[TRAIT_COUNT], learned[TRAIT_COUNT];
    alma_traits_export(a, base, learned);
    w_u64(w, (uint64_t)m->birth_unix);
    for (int k = 0; k < TRAIT_COUNT; k++) w_f32(w, base[k]);
    for (int k = 0; k < TRAIT_COUNT; k++) w_f32(w, learned[k]);
}
static void dec_identity(rbuf *r, alma_mem *m, alma_t *a, int apply)
{
    float base[TRAIT_COUNT], learned[TRAIT_COUNT];
    int64_t birth = (int64_t)r_u64(r);
    for (int k = 0; k < TRAIT_COUNT; k++) base[k] = r_f32(r);
    for (int k = 0; k < TRAIT_COUNT; k++) learned[k] = r_f32(r);
    if (!apply || r->err) return;
    m->birth_unix = birth;
    alma_traits_import(a, base, learned);
}

/* Migraciones: hoy todos los bloques están en v1 y no hay ninguna. Un cambio de esquema sube `schema` y agrega
 * la función a la lista del bloque, por ejemplo:
 *     static int bonds_v1_to_v2(uint8_t *payload, uint16_t *len, uint32_t cap) { ... }
 *     static const migrate_fn MIG_BONDS[] = {bonds_v1_to_v2};
 * Nunca se descarta un bloque sin migrarlo: si falta el paso, el bloque queda en MEM_KEEP. */
#define MIG_NONE NULL, 0

/* v1 → v2 agregan campos al final con valor 0 (0.0f también es todo ceros): bienestar 0 = como al nacer */
static int append_zeros(uint8_t *payload, uint16_t *len, uint32_t cap, uint16_t n)
{
    if ((uint32_t)*len + n > cap) return -1;
    memset(payload + *len, 0, n);
    *len = (uint16_t)(*len + n);
    return 0;
}
static int affect_v1_to_v2(uint8_t *payload, uint16_t *len, uint32_t cap) { return append_zeros(payload, len, cap, 8); }
static int counters_v1_to_v2(uint8_t *payload, uint16_t *len, uint32_t cap) { return append_zeros(payload, len, cap, 4); }
/* v2 → v3 (tamagotchi, 2026-10-30): con 0 = sin hambre ni empacho, contadores en 0; gustos en 0 = se sacan de la semilla */
static int affect_v2_to_v3(uint8_t *payload, uint16_t *len, uint32_t cap) { return append_zeros(payload, len, cap, 8); }
static int counters_v2_to_v3(uint8_t *payload, uint16_t *len, uint32_t cap) { return append_zeros(payload, len, cap, 20); }
static int learning_v1_to_v2(uint8_t *payload, uint16_t *len, uint32_t cap) { return append_zeros(payload, len, cap, 4 * FOOD_COUNT); }
static const migrate_fn MIG_AFFECT[] = {affect_v1_to_v2, affect_v2_to_v3};
static const migrate_fn MIG_COUNTERS[] = {counters_v1_to_v2, counters_v2_to_v3};
static const migrate_fn MIG_LEARNING[] = {learning_v1_to_v2};

/* Esquemas de los stubs en alma_mem.h (06): journal, compositions y net_config.
 * affect rota entre 8 ranuras: es el bloque que más se escribe (06, "Desgaste del flash"). */
static const blk_def BLK[ALMA_MEM_BLOCKS] = {
    [MEM_IDENTITY]       = {"identity", 1, 1, F_IDENTITY, 2, NULL, 0, enc_identity, dec_identity, MIG_NONE, 1, 0},
    [MEM_AFFECT]         = {"affect", 3, 1, F_AFFECT, 6, NULL, 0, NULL, NULL, MIG_AFFECT, 2, 1, 8},
    [MEM_BONDS]          = {"bonds", 1, 1, NULL, 0, F_BONDS_P, sizeof F_BONDS_P / sizeof *F_BONDS_P, NULL, NULL, MIG_NONE, 1, 0},
    [MEM_LEARNING]       = {"learning", 2, 1, F_LEARNING, 3, NULL, 0, NULL, NULL, MIG_LEARNING, 1, 1, 0},
    [MEM_RHYTHM]         = {"rhythm", 1, 1, F_RHYTHM, 3, NULL, 0, NULL, NULL, MIG_NONE, 1, 0},
    [MEM_COUNTERS_TODAY] = {"counters_today", 3, 1, F_COUNTERS, 6, NULL, 0, NULL, NULL, MIG_COUNTERS, 2, 1, 0},
    [MEM_JOURNAL]        = {"journal", 1, 8, NULL, 0, NULL, 0, NULL, NULL, MIG_NONE, 0, 0},
    [MEM_COMPOSITIONS]   = {"compositions", 1, 3, NULL, 0, NULL, 0, NULL, NULL, MIG_NONE, 0, 0},
    [MEM_NET_CONFIG]     = {"net_config", 1, 1, NULL, 0, NULL, 0, NULL, NULL, MIG_NONE, 0, 0},
    /* body (PLAN-RELOJ-v2 5.7): sin codificador de alma_t; lo escriben alma_mem_body_get/put y nunca se exporta */
    [MEM_BODY]           = {"body", 1, 1, NULL, 0, NULL, 0, NULL, NULL, MIG_NONE, 0, 0},
};

const char *alma_mem_block_name(int b) { return b >= 0 && b < ALMA_MEM_BLOCKS ? BLK[b].name : "?"; }

/* Layout fijo de la región: las ranuras de cada bloque, una tras otra. Solo se agregan bloques al final. */
static int nslots(int b) { return BLK[b].slots ? BLK[b].slots : 2; }
static uint32_t slot_off(int b, int s)
{
    uint32_t off = 0;
    for (int i = 0; i < b; i++) off += (uint32_t)nslots(i) * BLK[i].sectors * ALMA_MEM_SECTOR;
    return off + (uint32_t)s * BLK[b].sectors * ALMA_MEM_SECTOR;
}
int alma_mem_slot_count(int b) { return b >= 0 && b < ALMA_MEM_BLOCKS ? nslots(b) : 0; }
uint32_t alma_mem_slot_off(int b, int s) { return slot_off(b, s); }
static uint32_t slot_cap(int b) { return BLK[b].sectors * ALMA_MEM_SECTOR - 16u; }
static uint32_t region_bytes(void) { return slot_off(ALMA_MEM_BLOCKS - 1, nslots(ALMA_MEM_BLOCKS - 1)); }
uint32_t alma_mem_region_bytes(void) { return region_bytes(); }

static int has_keyed(const blk_def *d)
{
    for (int i = 0; i < d->nf; i++) if (d->f[i].keyed) return 1;
    for (int i = 0; i < d->npf; i++) if (d->pf[i].keyed) return 1;
    return 0;
}

static uint32_t fnv1a(const char *s)
{
    uint32_t h = 2166136261u;
    while (*s) { h ^= (uint8_t)*s++; h *= 16777619u; }
    return h;
}

static void enc_fields(wbuf *w, const fld *f, int nf, const uint8_t *base, int nkeys)
{
    for (int i = 0; i < nf; i++) {
        int n = f[i].keyed ? nkeys : f[i].n;
        const uint8_t *p = base + f[i].off;
        for (int j = 0; j < n; j++) {
            switch (f[i].kind) {
            case FK_I32: { int v; memcpy(&v, p + 4 * j, 4); w_u32(w, (uint32_t)v); break; }
            case FK_U32: { uint32_t v; memcpy(&v, p + 4 * j, 4); w_u32(w, v); break; }
            case FK_F32: { float v; memcpy(&v, p + 4 * j, 4); w_f32(w, v); break; }
            case FK_F64: { uint64_t v; memcpy(&v, p + 8 * j, 8); w_u64(w, v); break; }
            }
        }
    }
}

/* map[j] = índice en el catálogo del j-ésimo valor guardado, o −1 si esa conducta ya no existe */
static void dec_fields(rbuf *r, const fld *f, int nf, uint8_t *base, int nkeys, const int *map, int apply)
{
    for (int i = 0; i < nf; i++) {
        int n = f[i].keyed ? nkeys : f[i].n;
        uint32_t size = f[i].kind == FK_F64 ? 8 : 4;
        for (int j = 0; j < n; j++) {
            const uint8_t *q = r_bytes(r, size);
            int dst = f[i].keyed ? map[j] : j;
            if (!apply || !q || dst < 0) continue;
            /* el payload es little-endian, igual que el ESP32 y la PC */
            memcpy(base + f[i].off + size * (uint32_t)dst, q, size);
        }
    }
}

static int encode(int b, const alma_mem *m, const alma_t *a, wbuf *w)
{
    const blk_def *d = &BLK[b];
    int nkeys = 0;
    if (has_keyed(d)) {
        nkeys = a->cat->n;
        w_u16(w, (uint16_t)nkeys);
        for (int k = 0; k < nkeys; k++) w_u32(w, fnv1a(a->cat->b[k].id));
    }
    if (d->enc_x) d->enc_x(w, m, a);
    enc_fields(w, d->f, d->nf, (const uint8_t *)a, nkeys);
    if (d->npf) {
        w_u8(w, ALMA_MAX_PERSONS);
        for (int p = 0; p < ALMA_MAX_PERSONS; p++) enc_fields(w, d->pf, d->npf, (const uint8_t *)&a->person[p], nkeys);
    }
    return w->err ? -1 : 0;
}

/* apply = 0 solo valida la forma (y no necesita `a`); apply = 1 escribe en `a`. 0 = payload bien formado. */
static int decode(int b, const uint8_t *payload, uint32_t len, alma_mem *m, alma_t *a, int apply)
{
    const blk_def *d = &BLK[b];
    rbuf r = {payload, 0, len, 0};
    int nkeys = 0, map[ALMA_MAX_BEHAVIORS];
    if (has_keyed(d)) {
        nkeys = r_u16(&r);
        if (nkeys > ALMA_MAX_BEHAVIORS) return -1;
        for (int k = 0; k < nkeys; k++) {
            uint32_t h = r_u32(&r);
            map[k] = -1;
            if (apply)
                for (int c = 0; c < a->cat->n; c++) if (fnv1a(a->cat->b[c].id) == h) { map[k] = c; break; }
        }
    }
    if (d->dec_x) d->dec_x(&r, m, a, apply);
    dec_fields(&r, d->f, d->nf, (uint8_t *)a, nkeys, map, apply);
    if (d->npf) {
        int np = r_u8(&r);
        if (np > ALMA_MAX_PERSONS) return -1;
        for (int p = 0; p < np; p++) dec_fields(&r, d->pf, d->npf, apply ? (uint8_t *)&a->person[p] : NULL, nkeys, map, apply);
    }
    return r.err || r.n != len ? -1 : 0;
}

/* ---- ranuras ---- */
static void put_hdr(uint8_t out[16], const alma_rec_hdr_t *h)
{
    wbuf w = {out, 0, 16, 0};
    w_u32(&w, h->magic); w_u16(&w, h->schema); w_u16(&w, h->len); w_u32(&w, h->seq); w_u32(&w, h->crc32);
}
static void get_hdr(const uint8_t in[16], alma_rec_hdr_t *h)
{
    rbuf r = {in, 0, 16, 0};
    h->magic = r_u32(&r); h->schema = r_u16(&r); h->len = r_u16(&r); h->seq = r_u32(&r); h->crc32 = r_u32(&r);
}

/* 1 = copia válida, 0 = vacía, −1 = dañada, −2 = error de lectura. Deja el payload en m->buf si es válida. */
static int read_slot(alma_mem *m, int b, int s, alma_rec_hdr_t *h)
{
    uint8_t raw[16];
    uint32_t off = slot_off(b, s);
    if (m->fl.read(m->fl.ctx, off, raw, 16)) return -2;
    int blank = 1;
    for (int i = 0; i < 16; i++) blank &= raw[i] == 0xFF;
    get_hdr(raw, h);
    if (blank) return 0;
    if (h->magic != ALMA_REC_MAGIC || h->len > slot_cap(b) || h->len > sizeof m->buf) return -1;
    if (m->fl.read(m->fl.ctx, off + 16, m->buf, h->len)) return -2;
    return alma_crc32(0, m->buf, h->len) == h->crc32 ? 1 : -1;
}

static int scan_block(alma_mem *m, int b)
{
    alma_mem_blk_state *st = &m->b[b];
    memset(st, 0, sizeof *st);
    st->latest = -1;
    if (!BLK[b].sectors) return 0;
    int any_data = 0;
    for (int s = 0; s < nslots(b); s++) {
        alma_rec_hdr_t h;
        int v = read_slot(m, b, s, &h);
        if (v == -2) return -1;
        if (v != 0) any_data = 1;
        if (v != 0 && h.magic == ALMA_REC_MAGIC && h.seq > st->max_seq && h.seq != 0xFFFFFFFFu) st->max_seq = h.seq;
        st->valid[s] = v == 1;
        st->slot_seq[s] = v == 1 ? h.seq : 0;
        if (v == 1 && (st->latest < 0 || h.seq > st->seq)) {
            st->latest = (int8_t)s;
            st->seq = h.seq; st->schema = h.schema; st->len = h.len; st->crc = h.crc32;
        }
    }
    st->status = st->latest >= 0 ? (st->schema > BLK[b].schema ? MEM_KEEP : MEM_OK) : (any_data ? MEM_CORRUPT : MEM_EMPTY);
    return 0;
}

/* Escribe un payload en la ranura que sigue a la de la última copia válida (nunca en esa): borrar, payload,
 * encabezado al final. Con 2 ranuras alterna; con más, rota y reparte el desgaste. */
static int write_block(alma_mem *m, int b, uint16_t schema, const uint8_t *payload, uint16_t len, uint32_t crc)
{
    alma_mem_blk_state *st = &m->b[b];
    int s = st->latest >= 0 ? (st->latest + 1) % nslots(b) : 0;
    uint32_t seq = (st->seq > st->max_seq ? st->seq : st->max_seq) + 1;
    alma_rec_hdr_t h = {ALMA_REC_MAGIC, schema, len, seq, crc};
    uint8_t raw[16];
    put_hdr(raw, &h);
    uint32_t off = slot_off(b, s);
    st->valid[s] = 0;
    m->writes++;
    m->writes_by_block[b]++;
    if (m->fl.erase(m->fl.ctx, off, BLK[b].sectors * ALMA_MEM_SECTOR) || m->fl.write(m->fl.ctx, off + 16, payload, len)
        || m->fl.write(m->fl.ctx, off, raw, 16)) {
        m->write_errors++;
        return -1;   /* la copia anterior sigue en la otra ranura */
    }
    st->valid[s] = 1;
    st->slot_seq[s] = seq;
    st->latest = (int8_t)s;
    st->seq = st->max_seq = seq;
    st->schema = schema; st->len = len; st->crc = crc;
    st->status = MEM_OK;
    return 0;
}

/* ---- API ---- */
int alma_mem_open(alma_mem *m, const alma_mem_flash *fl)
{
    memset(m, 0, sizeof *m);
    m->fl = *fl;
    m->fw = "";
    if (fl->size < region_bytes()) return -1;
    m->recovered = 1;
    for (int b = 0; b < ALMA_MEM_BLOCKS; b++) {
        if (scan_block(m, b)) return -1;
        if (m->b[b].status == MEM_CORRUPT) m->recovered = 0;
    }
    return 0;
}

/* Lleva el payload de m->buf a la versión actual. 0 = ok; −1 = falta una migración (el bloque queda en MEM_KEEP). */
static int migrate(int b, uint16_t *schema, uint16_t *len, uint8_t *buf)
{
    while (*schema < BLK[b].schema) {
        int i = *schema - 1;
        if (i < 0 || i >= BLK[b].n_migrate || !BLK[b].migrate[i] || BLK[b].migrate[i](buf, len, slot_cap(b))) return -1;
        (*schema)++;
    }
    return 0;
}

int alma_mem_load(alma_mem *m, alma_t *a)
{
    m->recovered = 1;
    for (int b = 0; b < ALMA_MEM_BLOCKS; b++) {
        alma_mem_blk_state *st = &m->b[b];
        if (st->status == MEM_CORRUPT || st->status == MEM_KEEP) m->recovered = 0;
        if (st->status != MEM_OK || !BLK[b].has_codec) continue;
        /* la copia más nueva primero; si no se puede usar, la siguiente válida por seq */
        unsigned tried = 0;
        int loaded = 0;
        for (;;) {
            int s = -1;
            for (int k = 0; k < nslots(b); k++)
                if (st->valid[k] && !(tried & 1u << k) && (s < 0 || st->slot_seq[k] > st->slot_seq[s])) s = k;
            if (s < 0 || loaded) break;
            tried |= 1u << s;
            alma_rec_hdr_t h;
            if (read_slot(m, b, s, &h) != 1) continue;
            uint16_t schema = h.schema, len = h.len;
            if (migrate(b, &schema, &len, m->buf) || decode(b, m->buf, len, m, NULL, 0)) continue;
            decode(b, m->buf, len, m, a, 1);
            loaded = 1;
        }
        if (!loaded) { st->status = MEM_KEEP; m->recovered = 0; }
    }
    m->started = 0;
    return m->recovered ? 0 : -1;
}

int alma_mem_save(alma_mem *m, const alma_t *a, uint32_t mask)
{
    int n = 0, err = 0;
    for (int b = 0; b < ALMA_MEM_BLOCKS; b++) {
        if (!(mask & MEM_BIT(b)) || !BLK[b].has_codec || !BLK[b].sectors) continue;
        alma_mem_blk_state *st = &m->b[b];
        if (st->status == MEM_KEEP) continue;   /* no se pisa una copia que este firmware no sabe leer */
        wbuf w = {m->buf, 0, slot_cap(b) < sizeof m->buf ? slot_cap(b) : sizeof m->buf, 0};
        if (encode(b, m, a, &w)) { err = 1; continue; }
        uint32_t crc = alma_crc32(0, m->buf, w.n);
        if (st->status == MEM_OK && st->schema == BLK[b].schema && st->len == w.n && st->crc == crc) continue;   /* sin cambios */
        if (write_block(m, b, BLK[b].schema, m->buf, (uint16_t)w.n, crc)) err = 1;
        else n++;
    }
    return err ? -1 : n;
}

void alma_mem_tick(alma_mem *m, const alma_t *a, double now_s)
{
    if (!m->started) {
        m->started = 1;
        m->last_state = a->state;
        m->last_age = a->age_days;
        m->next_periodic_s = now_s + ALMA_MEM_PERIOD_S;
        /* nacimiento: sin identidad guardada se guarda todo en el primer tick. Antes la identidad esperaba al pase
           nocturno, y un reinicio antes de la primera noche hacía nacer otra Alma con otros rasgos (robot, 2026-10-30) */
        if (m->b[MEM_IDENTITY].status == MEM_EMPTY) alma_mem_save(m, a, MEM_ALL);
        return;
    }
    uint32_t mask = 0;
    if (a->age_days != m->last_age || (a->state == ST_SLEEPING && m->last_state != ST_SLEEPING)) mask = MEM_ALL;   /* pase nocturno */
    if (now_s >= m->next_periodic_s) {
        /* dormida, affect no entra al guardado periódico: la entrada a ST_SLEEPING ya lo guardó (06) */
        mask |= a->state == ST_SLEEPING ? MEM_PERIODIC & ~MEM_BIT(MEM_AFFECT) : MEM_PERIODIC;
        while (m->next_periodic_s <= now_s) m->next_periodic_s += ALMA_MEM_PERIOD_S;
    }
    m->last_state = a->state;
    m->last_age = a->age_days;
    if (mask) alma_mem_save(m, a, mask);
}

void alma_mem_on_event(alma_mem *m, const alma_t *a, alma_ev_type t)
{
    if (t == EV_BATTERY_LOW || t == EV_CHARGING_ON) alma_mem_save(m, a, MEM_ALL);
}

int alma_mem_flush(alma_mem *m, const alma_t *a) { return alma_mem_save(m, a, MEM_ALL) < 0 ? -1 : 0; }

/* ---- exportación e importación ----
 * 'ALMX' u32, formato u16, n u16, fw[16], n × {bloque u8, schema u16, len u16, payload}, CRC-32 de todo lo anterior.
 * No lleva seq ni marcas de tiempo: exportar → importar → exportar da los mismos bytes. */
#define EXPORT_MAGIC 0x584D4C41u
#define EXPORT_FORMAT 1

long alma_mem_export(alma_mem *m, uint8_t *out, uint32_t cap)
{
    wbuf w = {out, 0, cap, 0};
    int n = 0;
    for (int b = 0; b < ALMA_MEM_BLOCKS; b++) n += b != MEM_BODY && m->b[b].status == MEM_OK;
    char fw[16] = {0};
    strncpy(fw, m->fw ? m->fw : "", sizeof fw - 1);
    w_u32(&w, EXPORT_MAGIC); w_u16(&w, EXPORT_FORMAT); w_u16(&w, (uint16_t)n); w_bytes(&w, fw, sizeof fw);
    for (int b = 0; b < ALMA_MEM_BLOCKS; b++) {
        alma_mem_blk_state *st = &m->b[b];
        if (st->status != MEM_OK || b == MEM_BODY) continue;   /* el estado del cuerpo no viaja (5.7) */
        alma_rec_hdr_t h;
        if (read_slot(m, b, st->latest, &h) != 1) return -1;
        w_u8(&w, (uint8_t)b); w_u16(&w, h.schema); w_u16(&w, h.len); w_bytes(&w, m->buf, h.len);
    }
    w_u32(&w, alma_crc32(0, out, w.n));
    return w.err ? -1 : (long)w.n;
}

int alma_mem_import(alma_mem *m, const uint8_t *in, uint32_t len)
{
    if (len < 28 || alma_crc32(0, in, len - 4) != (uint32_t)(in[len - 4] | in[len - 3] << 8 | in[len - 2] << 16 | (uint32_t)in[len - 1] << 24))
        return -1;
    /* dos pasadas: primero se valida todo, después se escribe; un archivo malo no toca el flash */
    for (int pass = 0; pass < 2; pass++) {
        rbuf r = {in, 0, len - 4, 0};
        if (r_u32(&r) != EXPORT_MAGIC || r_u16(&r) != EXPORT_FORMAT) return -1;
        int n = r_u16(&r);
        r_bytes(&r, 16);
        for (int i = 0; i < n; i++) {
            int b = r_u8(&r);
            uint16_t schema = r_u16(&r), plen = r_u16(&r);
            const uint8_t *p = r_bytes(&r, plen);
            if (r.err || b >= ALMA_MEM_BLOCKS || b == MEM_BODY || !BLK[b].sectors || plen > slot_cap(b) || plen > sizeof m->buf || schema > BLK[b].schema)
                return -1;
            memcpy(m->buf, p, plen);
            if (migrate(b, &schema, &plen, m->buf) || (BLK[b].has_codec && decode(b, m->buf, plen, m, NULL, 0))) return -1;
            if (pass == 1 && write_block(m, b, schema, m->buf, plen, alma_crc32(0, m->buf, plen))) return -1;
        }
        if (r.err || r.n != r.len) return -1;
    }
    return 0;
}

/* ---- estado del cuerpo (MEM_BODY) ----
 * n u32, bseq u32, proto u8, copy u8, en little-endian como los demás bloques. */
#define BODY_LEN 10

int alma_mem_body_get(alma_mem *m, alma_mem_body_v1 *out)
{
    memset(out, 0, sizeof *out);
    alma_mem_blk_state *st = &m->b[MEM_BODY];
    alma_rec_hdr_t h;
    if (st->status != MEM_OK || st->schema != 1 || read_slot(m, MEM_BODY, st->latest, &h) != 1 || h.len < BODY_LEN) return -1;
    rbuf r = {m->buf, 0, h.len, 0};
    out->n = r_u32(&r); out->bseq = r_u32(&r); out->proto = r_u8(&r); out->copy = r_u8(&r);
    return r.err ? -1 : 0;
}

int alma_mem_body_put(alma_mem *m, const alma_mem_body_v1 *b)
{
    uint8_t p[BODY_LEN];
    wbuf w = {p, 0, BODY_LEN, 0};
    w_u32(&w, b->n); w_u32(&w, b->bseq); w_u8(&w, b->proto); w_u8(&w, b->copy);
    uint32_t crc = alma_crc32(0, p, BODY_LEN);
    alma_mem_blk_state *st = &m->b[MEM_BODY];
    if (st->status == MEM_KEEP) return -1;   /* un esquema más nuevo: no se pisa */
    if (st->status == MEM_OK && st->schema == 1 && st->len == BODY_LEN && st->crc == crc) return 0;   /* sin cambios */
    return write_block(m, MEM_BODY, 1, p, BODY_LEN, crc);
}

/* ---- solo pruebas ---- */
static void scrub_fields(const fld *f, int nf, uint8_t *base, int nkeys)
{
    for (int i = 0; i < nf; i++) {
        int n = f[i].keyed ? nkeys : f[i].n;
        for (int j = 0; j < n; j++) {
            if (f[i].kind == FK_F64) { double v = NAN; memcpy(base + f[i].off + 8 * j, &v, 8); }
            else if (f[i].kind == FK_F32) { float v = NAN; memcpy(base + f[i].off + 4 * j, &v, 4); }
            else { uint32_t v = 0x5A5A5A5Au; memcpy(base + f[i].off + 4 * j, &v, 4); }
        }
    }
}

void alma_mem_scrub(alma_mem *m, alma_t *a)
{
    for (int b = 0; b < ALMA_MEM_BLOCKS; b++) {
        if (!BLK[b].has_codec) continue;
        int nkeys = has_keyed(&BLK[b]) ? a->cat->n : 0;
        scrub_fields(BLK[b].f, BLK[b].nf, (uint8_t *)a, nkeys);
        for (int p = 0; p < ALMA_MAX_PERSONS && BLK[b].npf; p++) scrub_fields(BLK[b].pf, BLK[b].npf, (uint8_t *)&a->person[p], nkeys);
    }
    m->birth_unix = 0x5A5A5A5A5A5A5A5ALL;
    for (int k = 0; k < TRAIT_COUNT; k++) a->trait[k] = a->trait_base[k] = a->trait_learned[k] = NAN;
}
