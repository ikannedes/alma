/* outbox — mensajes del robot al servidor que esperan al enlace (eventos para las notificaciones y el pase nocturno).
 * Si el enlace no está, se guardan los últimos OUTBOX_N; el más viejo se pierde. Portable. */
#pragma once
#include <stddef.h>

#define OUTBOX_N   6
#define OUTBOX_LEN 3072   /* el resumen nocturno con las conductas del día */

/* Un objeto JSON completo, con "t". */
void outbox_put(const char *json);
/* {"t":"event","ev":"<ev>", ...extra}: extra son pares JSON sin llaves (",\"name\":\"amigo_1\""), o "" */
void outbox_event(const char *ev, const char *extra);
/* Copia el más viejo en out y lo saca. Devuelve el largo, o 0 si no hay. */
long outbox_take(char *out, size_t cap);
int  outbox_count(void);
void outbox_clear(void);
