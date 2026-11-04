/* body — el robot como uno de los dos cuerpos de Alma (PLAN-RELOJ-v2.md: 5, 5.7, 6.2, 6.4, 7 y 17). Es el puerto a C
 * de android/protocolo/.../Cuerpo.kt (la lógica del cuerpo ya probada en el reloj); el árbitro vive en el servidor
 * (relay/alma_relay/body.py) y los mensajes con el robot están en relay/alma_relay/reloj.py (on_robot, robot_out).
 * Las cuatro reglas de 5.7 van marcadas con "regla N". Portable.
 *
 * Compatibilidad: el protocolo solo se enciende cuando el servidor contesta el primer {"t":"body",...}. Con un servidor
 * viejo (nunca contesta body_hello) Alma corre como siempre. Una vez encendido queda guardado (MEM_BODY) y el robot
 * arranca SIN Alma hasta que el servidor le diga "keep" (7: "Robot arranca sin red → arranca sin Alma"). No hay vuelta
 * automática al modo de siempre si el servidor deja de contestar: un servidor colgado con el enlace arriba no se distingue
 * de uno viejo, y volver a correr a Alma ahí podría dar dos Almas (5.2: todo corte termina en "Alma dormida").
 *
 * Robot → servidor: body_hello (cada BODY_HELLO_S y tras body_poke), body_pkg (respaldo o soltada, en trozos),
 * body_ack (tras importar un paquete) y body_move (llegada por la cara del dueño, 6.2).
 * Servidor → robot: body (keep, release, deliver, absent), body_pkg_in, body_pkg_result, body_poke, body_move_result. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#define BODY_LEASE_S         180    /* = ROBOT_LEASE_S del servidor; se cuenta desde que se MANDÓ el hello (5.7) */
#define BODY_SERVER_OFFLINE_S 300   /* = ROBOT_OFFLINE_S: el servidor manda a Alma al reloj tras 5 min sin el robot */
#define BODY_HELLO_S         20     /* un hello cada 20 s mientras hay enlace */
#define BODY_BACKUP_S        600    /* 5.5: respaldo cada 10 min mientras corre, y en cada evento importante */
#define BODY_LOG_MAX         48     /* eventos importantes en la memoria actual (5.6), en RAM */
#define BODY_CHUNK           2400   /* bytes del paquete por trozo, como mem_backup */
#define BODY_PKG_MAX         8192   /* el paquete ALMX es de ~4 KB */
#define BODY_BSEQ_RESERVE    32     /* regla 2: la numeración se guarda de a 32 para no escribir el flash en cada respaldo */
#define BODY_NIGHT_LOCK_MAX_S 900   /* el candado del pase nocturno se suelta solo si Haiku nunca contesta */
#define BODY_CATCHUP_MAX_S   (72 * 3600.0)   /* ponerse al día como mucho 3 días (el lease largo del reloj) */

/* Llegada por cara (6.2): el dueño (id del K210) visto de verdad por la cámara durante BODY_ARRIVAL_SUSTAIN_MS, sin
 * huecos de más de BODY_ARRIVAL_GAP_MS entre detecciones. Valor a calibrar en la fase 4 (5 a 10 s) */
#ifndef BODY_ARRIVAL_SUSTAIN_MS
#define BODY_ARRIVAL_SUSTAIN_MS 7000
#endif
#define BODY_ARRIVAL_GAP_MS  12000
#define BODY_OWNER_ID        0      /* el dueño es la cara 0 del K210 (03; registrada primero) */
#define BODY_MOVE_RETRY_MS   60000  /* entre dos pedidos de llegada */

_Static_assert(BODY_LEASE_S + 60 <= BODY_SERVER_OFFLINE_S,
               "el lease del robot debe caducar antes de que el servidor lo dé por desconectado (5.2)");

void body_init(void);              /* en app_init, con la memoria ya abierta */
void body_set_link(int up);        /* "welcome" del servidor (1) o enlace caído (0) */
void body_step(void);              /* en cada vuelta: lease, hello, respaldos, llegada por cara */
/* 1 = Alma corre en este cuerpo: sin protocolo (servidor viejo, como siempre) o con el turno vigente */
int  body_runs(void);
int  body_protocol(void);          /* 1 = el servidor ya habla el protocolo de mudanza */
/* 1 = sin Alma y con el dueño visto hace poco: la app no pone la cara de ausencia, así la cámara sigue buscándolo */
int  body_watching(void);
/* Algo importante que pasó aquí (comida, truco, juego…): a la memoria y respaldo inmediato (5.5). data = objeto JSON */
void body_event(const char *kind, const char *data_json);
void body_night(int on);           /* candado "noche": del pase nocturno hasta el night_result de Haiku */
/* Siguiente mensaje body_* para el servidor, o 0. Se llama justo antes de mandarlo: ahí se cuenta el envío del hello */
long body_take(char *out, size_t cap);
void body_msg(const char *json);   /* body, body_pkg_in, body_pkg_result, body_poke, body_move_result */
