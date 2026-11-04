/* expression — caras y sonidos del K210 por nombre de animación (03, 05), con los "faces" de catalog.json.
 * Lee también los .mot que cita el catálogo para armar el inventario que catalog_load valida (05). */
#pragma once
#include <stddef.h>

#include "alma_core.h"

#define EXPR_MAX_FACES 24
#define EXPR_MAX_SEQ   7
#define EXPR_NAME_LEN  40
#define EXPR_MAX_MEDIA 160
#define EXPR_MOOD_EVERY_MS 90000
#define EXPR_SAD_VALENCE  -0.2f

typedef struct {
    char avi[EXPR_NAME_LEN], mp3[EXPR_NAME_LEN];   /* mp3 vacío = solo cara */
    int mode;
    /* rutina (bhv_routine): inicio, repeticiones y final; snd = el .avi tiene NOMBRE_000.mp3; horas HHMM o −1 */
    char seq[EXPR_MAX_SEQ][EXPR_NAME_LEN];
    unsigned char snd[EXPR_MAX_SEQ];
    int n_seq, hhmm0, hhmm1;
} expr_face;

/* Lee "faces" de cada conducta de catalog.json. Las caras con "avi": null ("tbd") se omiten. 0 = ok. */
int  expression_init(const char *catalog_text, const alma_catalog *cat);
/* Manda la siguiente cara de la conducta (en rotación). Devuelve 0 si mandó algo. */
int  expression_play(int behavior);
/* Cara de una ejecución (dueño, 2026-10-30): si el .mot tiene cara o sonido del mismo nombre en "media" del catálogo,
 * van juntos, como en el original; si no, la cara de la conducta. En las conductas de reposo (idle), con valencia
 * clara pone la cara del ánimo (mood_happy / mood_sad) a lo sumo cada EXPR_MOOD_EVERY_MS. mot puede ser NULL. */
int  expression_play_exec(int behavior, const char *mot, float valence);
/* Rutina: elige la secuencia de la hora (hhmm) y la reproduce durante planned_s; −1 si la conducta no tiene secuencias */
int  expression_play_seq(int behavior, int hhmm, float planned_s);
/* La conducta terminó (graceful = 1: pone el final de la rutina) o la cortaron (0) */
void expression_stop(int graceful);
/* Hasta until_ms las caras salen sin sonido (música de afuera); −1 lo quita */
void expression_mute_until(int64_t until_ms);
/* La app reproduce el .mot del mismo nombre que cada animación de una secuencia, si existe y se puede (2026-10-30) */
void expression_set_seq_motion(void (*cb)(const char *mot));
/* Cara y sonido del .mot en "media" (NULL si no tiene) */
const expr_face *expression_media(const char *mot);
int  expression_faces(int behavior, const expr_face **out);
/* Todos los .avi del catálogo (caras, rutinas y los de los .mot), con repetidos; para la revisión de la SD */
int  expression_avis(const char **out, int max);

/* Inventario de .mot en el formato de assets_inventory.json ({"mot": {nombre: {frames, dur_s, gait}}}), solo con
 * los .mot que cita el catálogo, leídos de la SPIFFS de esta unidad. Devuelve el largo o −1. */
long expression_build_inventory(const char *catalog_text, char *out, size_t cap);
