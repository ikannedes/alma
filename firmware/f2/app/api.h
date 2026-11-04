/* api — cuerpo de la API local de 07 (/api/state, /api/command, /api/log/today). Portable: arma y lee JSON;
 * el servidor HTTP y el Wi-Fi (R15) están en main/api_esp32.c, detrás de ALMA_F2_API. */
#pragma once
#include <stddef.h>

#include "alma_core.h"

/* Devuelven el largo del JSON escrito en out, o −1 si no cabe. */
long api_state(char *out, size_t cap);
long api_log_today(char *out, size_t cap);
/* {"action_id": "dance"} → EV_REMOTE_COMMAND. Devuelve el código HTTP (200, 400) y un JSON corto en out. */
int  api_command(const char *body, char *out, size_t cap);
/* Mensaje del servidor por el enlace (uplink.h): "command", "night_result", "reminder", "voice_result", "feed", "remote_play", "welcome". Devuelve el largo de la
 * respuesta escrita en out (> 0 se manda de vuelta) o 0. */
long api_link_msg(const char *json, char *out, size_t cap);
/* Lo siguiente que el robot manda por el enlace: avisos (outbox) y, después, los trozos de voz. 0 si no hay. */
long api_link_take(char *out, size_t cap);
/* {"t":"night","summary":{…}} del pase nocturno, para Haiku en el servidor (07). −1 si no cabe. */
long api_night(const alma_day_summary *s, char *out, size_t cap);
/* Authorization: Bearer <token> (07). 1 si coincide con el token del dispositivo. */
int  api_auth_ok(const char *authorization_header, const char *device_token);
