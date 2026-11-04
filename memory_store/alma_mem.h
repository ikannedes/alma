/* alma_mem.h — memory_store: memoria persistente de Alma (06), C11 portable, sin ESP-IDF ni memoria dinámica.
 *
 * Cada bloque de 06 vive en dos ranuras con encabezado alma_rec_hdr_t; al leer se elige la copia válida
 * (magic y CRC-32 correctos) con seq mayor, y al escribir se usa siempre la otra ranura, así que la última
 * copia válida nunca se sobrescribe. Se escribe solo si el bloque cambió. Debajo va un alma_mem_flash.
 */
#ifndef ALMA_MEM_H
#define ALMA_MEM_H

#include <stdint.h>
#include "alma_core.h"
#include "alma_mem_flash.h"

#define ALMA_REC_MAGIC 0x414D4C41u   /* 'A','L','M','A' en el orden de los bytes del flash */
#define ALMA_MEM_PERIOD_S 600.0      /* guardado periódico: cada 10 min (06) */
#define ALMA_MEM_MAX_SLOTS 8          /* ranuras por bloque: 2, o 8 en affect */

typedef struct {
    uint32_t magic;        /* 'ALMA' */
    uint16_t schema;       /* versión de esquema del bloque */
    uint16_t len;          /* bytes del payload */
    uint32_t seq;          /* contador monotónico de escrituras */
    uint32_t crc32;        /* CRC-32 del payload */
} alma_rec_hdr_t;          /* en el flash: 16 bytes, little-endian, antes del payload */

typedef enum {
    MEM_IDENTITY, MEM_AFFECT, MEM_BONDS, MEM_LEARNING, MEM_RHYTHM, MEM_COUNTERS_TODAY,
    MEM_JOURNAL, MEM_COMPOSITIONS,   /* stub: esquema definido, sin codificador todavía */
    MEM_NET_CONFIG,                  /* stub: en esta región, nunca en la nvs original (06, 09 R15) */
    MEM_BODY,                        /* estado del cuerpo (PLAN-RELOJ-v2 5.7): nunca va en la exportación */
    ALMA_MEM_BLOCKS
} alma_mem_block;

#define MEM_BIT(b) (1u << (b))
#define MEM_ALL    0xFFFFFFFFu
#define MEM_PERIODIC (MEM_BIT(MEM_AFFECT) | MEM_BIT(MEM_BONDS) | MEM_BIT(MEM_COUNTERS_TODAY))

typedef enum {
    MEM_EMPTY,     /* nunca se escribió (ranuras en 0xFF) */
    MEM_OK,        /* hay al menos una copia válida */
    MEM_CORRUPT,   /* hay datos pero ninguna copia válida: valores por omisión, memory_recovered = false */
    MEM_KEEP       /* copia válida de un esquema más nuevo o sin migración: no se carga ni se sobrescribe */
} alma_mem_status;

typedef struct {
    uint8_t status;              /* alma_mem_status */
    int8_t latest;               /* ranura de la copia válida con seq mayor, o −1 */
    uint8_t valid[ALMA_MEM_MAX_SLOTS];      /* validez de cada ranura en el último escaneo o escritura */
    uint32_t slot_seq[ALMA_MEM_MAX_SLOTS];  /* seq de cada ranura válida */
    uint16_t schema, len;
    uint32_t seq, max_seq, crc;  /* de la copia en `latest`; max_seq incluye encabezados de copias dañadas */
} alma_mem_blk_state;

typedef struct {
    alma_mem_flash fl;
    alma_mem_blk_state b[ALMA_MEM_BLOCKS];
    int recovered;               /* memory_recovered de /api/state: 0 si algún bloque quedó MEM_CORRUPT */
    int64_t birth_unix;          /* fecha de nacimiento (identity); la pone el firmware al nacer */
    const char *fw;              /* versión de firmware para la exportación */
    /* calendario de guardado */
    int started, last_state, last_age;
    double next_periodic_s;
    /* estadística */
    uint32_t writes, write_errors, writes_by_block[ALMA_MEM_BLOCKS];
    uint8_t buf[ALMA_MEM_SECTOR];
} alma_mem;

uint32_t alma_crc32(uint32_t crc, const void *buf, uint32_t n);   /* = zlib/binascii; esp_rom_crc32_le en el ESP32 */

/* Escanea las ranuras de todos los bloques. 0 = ok (aunque haya bloques dañados), −1 = la región no alcanza o falla la lectura */
int  alma_mem_open(alma_mem *m, const alma_mem_flash *fl);
/* Carga en `a` (ya inicializado con alma_init) los bloques válidos; los demás quedan con los valores por omisión. */
int  alma_mem_load(alma_mem *m, alma_t *a);
/* Guarda los bloques de `mask` que cambiaron. Devuelve el número de ranuras escritas o −1 si alguna escritura falló. */
int  alma_mem_save(alma_mem *m, const alma_t *a, uint32_t mask);

/* Calendario de 06: llamar en cada tick y con cada evento entregado al núcleo */
void alma_mem_tick(alma_mem *m, const alma_t *a, double now_s);              /* cada 10 min, pase nocturno, ST_SLEEPING */
void alma_mem_on_event(alma_mem *m, const alma_t *a, alma_ev_type t);       /* EV_BATTERY_LOW, EV_CHARGING_ON */
int  alma_mem_flush(alma_mem *m, const alma_t *a);                          /* antes de actualizar firmware y al apagar */

/* Exportación binaria de las copias válidas (base del JSON de /api/memory/export, 06). Devuelve bytes o −1. */
long alma_mem_export(alma_mem *m, uint8_t *out, uint32_t cap);
/* Valida CRC global y esquemas, migra y escribe cada bloque en su ranura alterna. Después: alma_mem_load. */
int  alma_mem_import(alma_mem *m, const uint8_t *in, uint32_t n);

/* Esquemas v1 de los stubs (06). En el flash se serializan campo por campo en little-endian, como los demás. */
typedef struct {               /* journal: anillo de 30 días, uno por pase nocturno (06, "Resumen diario") */
    int32_t day, age_days;
    float traits[TRAIT_COUNT], mood_end, servo_active_s;
    int32_t counts[9];         /* pets, praises, scolds, shakes, play_done, play_ignored, scares, novel_ok, explore_ok */
    uint16_t n_behaviors;
    struct { uint32_t id_hash; uint16_t n; } behaviors[ALMA_MAX_BEHAVIORS];
    uint8_t n_people;
    struct { int32_t person_id; uint16_t minutes_present, pets; float attachment_start, attachment_end; } people[ALMA_MAX_PERSONS];
    uint8_t n_moments;
    struct { uint16_t t_min; uint8_t type; int8_t person_id; float intensity; uint8_t result; } moments[20];
} alma_mem_journal_day_v1;
typedef struct {               /* compositions: hasta 30 conductas compuestas aceptadas (05) */
    char id[ALMA_ID_LEN];
    uint16_t len;
    uint8_t def[300];          /* definición JSON de 05 */
} alma_mem_composition_v1;
typedef struct {               /* net_config: bloque de esta región (06); nunca en la nvs original */
    char ssid[33], password[65], relay_url[96], device_token[64];
} alma_mem_net_config_v1;

/* Estado del cuerpo para la mudanza entre robot y reloj (PLAN-RELOJ-v2.md 5.1 y 5.7). Vive en su propio bloque al
 * final de la región (MEM_BODY) y es de ESTE cuerpo, no de Alma: alma_mem_export no lo incluye y alma_mem_import
 * rechaza un paquete que lo traiga, así nunca viaja entre cuerpos. alma_mem_save/load no lo tocan (no es de alma_t).
 * Va aquí y no en la nvs original (R15): es la región propia de Alma, con sus dos ranuras y su CRC. */
typedef struct {
    uint32_t n;          /* número de mudanza del linaje que tiene (o tuvo) este cuerpo */
    uint32_t bseq;       /* numeración de respaldos reservada hasta aquí (regla 2): al arrancar se sigue desde este */
    uint8_t proto;       /* 1 = el servidor ya contestó el protocolo de mudanza alguna vez */
    uint8_t copy;        /* 1 = la memoria de la región es una copia vigente de Alma (0 = se descartó, 6.4) */
} alma_mem_body_v1;
/* 0 y *out si hay una copia válida; −1 si el bloque está vacío o dañado (*out queda en ceros) */
int alma_mem_body_get(alma_mem *m, alma_mem_body_v1 *out);
/* Escribe el bloque solo si cambió. 0 = guardado o sin cambios; −1 si falló la escritura */
int alma_mem_body_put(alma_mem *m, const alma_mem_body_v1 *b);

/* Solo pruebas: pone un valor imposible (NaN o 0x5A5A5A5A) en cada campo que guarda memory_store */
void alma_mem_scrub(alma_mem *m, alma_t *a);
const char *alma_mem_block_name(int b);
uint32_t alma_mem_slot_off(int b, int s);       /* posición de la ranura s del bloque b en la región */
int      alma_mem_slot_count(int b);
uint32_t alma_mem_region_bytes(void);           /* bytes que ocupa el layout */

#endif
