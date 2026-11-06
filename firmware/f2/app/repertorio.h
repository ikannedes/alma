/* repertorio — los movimientos propios de Alma (dueño, 2026-11-05: "¿podría el robot inventar sus propios
 * movimientos?", las tres vías juntas). Portable.
 *
 * Inventos (vía 2, bhv_invent): arma una combinación nueva de poses seguras (dentro de R10, pies cerca de 90), la
 * reproduce y mide con el IMU si fue estable (la inclinación no cambió más de INV_MAX_DEV_DEG y no hubo borde). Se queda
 * con las estables (hasta REP_INV_MAX, se va la menos usada) y las manda al servidor para respaldarlas.
 *
 * La mitad de los inventos nuevos son ondas (vía 4; dueño, 2026-11-06): cada servo oscila con su amplitud, centro y
 * desfase (como las primitivas de marcha del original), muestreado en poses; se prueban y se guardan igual.
 *
 * Trucos (vía 3, bhv_new_trick): el servidor manda los que propuso Haiku de noche ({"t":"truco"}); Alma enseña el nuevo
 * y mira tu reacción REP_WATCH_MS: caricia o elogio → se queda ("gusta"), regaño → se borra, nada → otro intento; tres
 * sin reacción → se olvida. Cada resultado va al servidor ({"t":"event","ev":"truco_res"}).
 *
 * Formato de los cuadros (alma-anim/1, tools/mot_studio_3d): [{"pose":[S0,S1,S2,S3],"ms":n}, {"paso":"adelante"}…];
 * un "paso" (adelante, atras, izquierda, derecha) se arma con el .mot de fábrica que lo hace (explore_*). */
#pragma once
#include <stddef.h>
#include <stdint.h>
#include "alma_core.h"
#include "mot.h"

#define REP_INV_MAX      12
#define REP_TRICK_MAX    8
#define REP_FRAMES       32
#define INV_MAX_DEV_DEG  15.0f
#define REP_WATCH_MS     30000
#define REP_TRICK_TRIES  3

void repertorio_init(void);
/* bhv_invent: inventa uno nuevo (o, si ya tiene varios, a veces repite su favorito). 0 = empezó a moverse */
int  repertorio_invent(alma_rng *r, int on_charger);
/* bhv_new_trick: enseña el truco nuevo más viejo. 0 = empezó */
int  repertorio_show_trick(int on_charger);
int  repertorio_new_tricks(void);                 /* cuántos trucos nuevos hay por enseñar (alma_t.trick_new) */
/* para jugar: un invento estable o un truco que ya se quedó, al azar. 0 = empezó */
int  repertorio_play_own(alma_rng *r, int on_charger);
void repertorio_event(alma_ev_type t);            /* caricia, elogio o regaño mientras mira tu reacción */
void repertorio_step(int64_t now);                /* mide el invento en curso, cierra la ventana del truco */
/* {"t":"truco","id":"…","nombre":"…","estado":"nuevo|aprendido","cuadros":[…]} del servidor. 0 = aceptado */
int  repertorio_trick_msg(const char *json);
/* {"t":"invento","nombre":"…","cuadros":[…]} del servidor (respaldo de un invento estable tras reiniciar). 0 = aceptado */
int  repertorio_invent_msg(const char *json);
/* JSON alma-anim/1 → cuadros (−1 si algo sale de R10 o no se entiende). Lo usan los mensajes y las pruebas */
int  repertorio_parse_frames(const char *json_array, mot_frame *out, int max);
int  repertorio_inventions(void);                 /* inventos estables guardados */
/* una onda nueva en out (≤ REP_FRAMES cuadros, termina en 90/90/90/90); −1 si saliera del rango seguro */
int  repertorio_make_wave(alma_rng *r, mot_frame *out);
