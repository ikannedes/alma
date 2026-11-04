/* backup — respaldo de la memoria de Alma en el servidor (dueño, 2026-11-01: "no quiero perder el avance").
 * Manda la exportación de memory_store (alma_mem_export, ~4 KB) al conectar, cada BACKUP_EVERY_S y después de cada pase
 * nocturno. Si el robot arranca con la memoria vacía (todos los bloques sin escribir: flash borrada o robot nuevo), pide
 * la última copia y la importa; si tiene memoria, nunca la sobrescribe. Portable. */
#pragma once
#include <stddef.h>

#define BACKUP_FIRST_S  120             /* primera copia, a los 2 min de conectar */
#define BACKUP_EVERY_S  (6 * 3600)
#define BACKUP_NIGHT_S  120             /* tras el pase nocturno (ya guardado en flash al dormir) */
#define BACKUP_CHUNK    2400
#define BACKUP_MAX      8192

void backup_init(void);
void backup_set_link(int up);
void backup_after_night(void);
void backup_step(void);
/* {"t":"mem_restore_req"} una vez si la memoria está vacía, o el siguiente trozo
   {"t":"mem_backup","seq":n,"last":0|1,"age":d,"data":"<base64>"}; 0 si no hay nada */
long backup_take(char *out, size_t cap);
/* {"t":"mem_restore","seq":n,"last":0|1,"data":"<base64>"} o {"t":"mem_restore","none":1} */
void backup_restore_msg(const char *json);
