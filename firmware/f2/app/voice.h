/* voice — lo que dice el dueño tras "Hey EMO" (07; dueño, 2026-10-30): con ST_LISTENING abre el micrófono del K210,
 * graba hasta LISTEN_RECORD_MAX_S o el fin que avisa el K210, lo manda al servidor por el enlace en trozos
 * {"t":"voice"} y convierte el "voice_result" en EV_VOICE_COMMAND, EV_PRAISE, EV_SCOLD o EV_VOICE_FAILED (07). Portable. */
#pragma once
#include <stddef.h>

#define VOICE_CHUNK 9000          /* bytes de PCM por mensaje (~280 ms): 12 000 en base64, cabe en UPLINK_MAX. Antes 2400 */
#define VOICE_MIN_CONF 0.6f       /* 07: menos que esto es EV_VOICE_FAILED */

void voice_init(void);
void voice_step(void);                       /* en cada vuelta de app_step */
void voice_set_link(int up);                 /* el enlace con el servidor está (1) o no (0) */
long voice_take(char *out, size_t cap);      /* siguiente trozo para el enlace, 0 si no hay */
void voice_result(const char *json);         /* {"t":"voice_result", …} del servidor */
