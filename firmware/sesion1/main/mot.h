/* .mot (02, "Formato .mot") y lectura de solo lectura de la SPIFFS original. C portable: se prueba en la PC. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#define MOT_FRAME_LEN 20
#define MOT_MODE_POSE 0xFE

typedef struct {
    uint8_t type, mode;
    uint8_t s[4];        /* S0..S3; en pose: grados, 90 = neutro */
    uint16_t ms;
    uint8_t steps10;     /* byte 6: en una primitiva de marcha, pasos × 10 (02 [BOBBY-ARTE]) */
    uint8_t gp[7];       /* bytes 6..12: parámetros de la primitiva (HALLAZGOS §5) */
} mot_frame;

/* Duración real de un cuadro (02 [BOBBY-ARTE]; coincide con su .avi en 282 de 290 .mot): pose y pausa, ms;
   primitiva de marcha, pasos × T = steps10 × ms / 10. */
uint32_t mot_frame_ms(const mot_frame *f);

/* 0 si la firma 55 AA 55 AA, el checksum (suma de bytes 4..17) y el cierre 0xED son válidos. */
int mot_parse_frame(const uint8_t f[MOT_FRAME_LEN], mot_frame *out);

/* Lector de solo lectura: devuelve 0 si pudo leer n bytes en off. */
typedef int (*spiffs_read_fn)(void *ctx, uint32_t off, void *buf, size_t n);

/* Busca `name` (p. ej. "/mot/ttt_my_turn.mot") en una imagen SPIFFS de bloque 4096, página 256, nombre 32
   (geometría de 02) y copia su contenido. Devuelve el tamaño, o -1 si no está, o -2 si no cabe o está incompleto.
   Nunca escribe. */
long spiffs_find(spiffs_read_fn rd, void *ctx, uint32_t part_size, const char *name, uint8_t *out, size_t cap);
