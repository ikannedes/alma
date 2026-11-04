/* fiesta — caras de festividades (dueño, 2026-11-02: "el 14 de febrero, que salga unas 10, 15 veces en la pantalla, como
 * sus actividades normales, recordando que hoy es ese día").
 *
 * El servidor (relay fiestas.py) manda la cara del día en trozos {"t":"cara","nombre","seq","last","b64"}; aquí se juntan
 * en PSRAM, se suben al K210 a /test/<nombre>.avi cuando está libre y se contesta {"t":"cara_ok"|"cara_error","nombre"}.
 * Con {"t":"fiesta","nombre"} la cara del día queda activa: de día y con Alma tranquila sale FIESTA_PLAYS veces, cada
 * 40–80 min al azar (la primera a los 2–10 min). "nombre":"" la apaga. Nada se guarda en flash: al reconectar, el
 * servidor la vuelve a mandar (y ya no manda la cara si el robot la confirmó). Portable.
 * El primer trozo trae "size" (bytes del archivo) y se reserva justo eso: 3 MB de una vez no cabían en la PSRAM que el
 * ESP32 alcanza (2026-11-03). Con "ext":"mp3" en los trozos, el archivo va a /test/<nombre>.mp3 (la marcha del truco de Darth Vader, 2026-11-03). */
#ifndef FIESTA_H
#define FIESTA_H

#include <stddef.h>
#include <stdint.h>

#define FIESTA_PLAYS    12
#define FIESTA_MAX      (3 * 1024 * 1024)   /* tope de "size" (lo que de verdad cabe lo dice la PSRAM libre) */
#define FIESTA_DEFAULT  (1700 * 1024)       /* sin "size" en el primer trozo (servidor de antes); muertos: ~1.55 MB */
#define FIESTA_NAME_MAX 24

void fiesta_init(void);
/* Un mensaje del servidor ("cara" o "fiesta"); si hay que contestar ya (error de un trozo), lo escribe en out. */
int  fiesta_msg(const char *type, const char *json, char *out, size_t cap);
void fiesta_step(int64_t now_ms);        /* en cada vuelta del bucle principal */
const char *fiesta_active(void);         /* "" si no hay */
int  fiesta_plays(void);                 /* veces que salió hoy */

#endif
