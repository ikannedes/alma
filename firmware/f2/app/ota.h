/* ota — firmware nuevo por Wi-Fi (dueño, 2026-11-02: "me late… lo anterior ya puede irse").
 *
 * El servidor (relay robot_debug.py, solo por SSH) manda {"t":"ota_begin","size","sha256","version"} → "ota_ready";
 * luego {"t":"ota","seq","last","b64"} en orden estricto (≤ 9 KB de datos cada uno), que se escriben directo en la
 * partición que NO corre (hoy Alma corre en ota_1: se escribe ota_0, donde estaba el original). Al último trozo se
 * revisan tamaño y SHA-256 de lo escrito y se contesta "ota_ok"; el arranque NO cambia hasta que llegue
 * {"t":"ota_reboot"} (el dueño confirma). Cualquier error → "ota_error" y el arranque queda como estaba.
 *
 * Arranque a prueba (el bootloader de fábrica no tiene rollback): antes de reiniciar se deja en RAM RTC cuál era la
 * partición anterior. Si la nueva arranca pero en OTA_TRIAL_MS no recibe "welcome" del servidor, vuelve a poner la
 * anterior y reinicia; con "welcome" se confirma y se queda. NO protege si la imagen nueva truena antes de llegar a
 * ota_init (o si se va la luz durante la prueba: la RAM RTC se borra y se queda la nueva): eso se recupera por USB.
 * Portable: lo de la flash va por el HAL (hal_ota_*). */
#ifndef OTA_H
#define OTA_H

#include <stddef.h>
#include <stdint.h>

#define OTA_TRIAL_MS (3 * 60 * 1000)

void ota_init(void);                                       /* al arrancar: ¿es un arranque a prueba? */
long ota_msg(const char *type, const char *json, char *out, size_t cap);   /* ota_begin, ota, ota_reboot */
void ota_link(int up);                                     /* sin enlace: se aborta la recepción */
void ota_welcome(void);                                    /* el servidor contestó: confirma el arranque a prueba */
void ota_step(int64_t now_ms);                             /* vence la prueba: vuelve a la anterior */
int  ota_receiving(void);

#endif
