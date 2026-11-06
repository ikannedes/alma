/* uplink — una conexión del robot con el servidor (relay /v1/robot): saludo WebSocket, autenticación con la llave del
 * enlace (link.h) y mensajes cifrados en los dos sentidos. Portable: el socket y la hora llegan por uplink_io
 * (main/link_esp32.c en el robot; test/uplink_pc.c contra el relay real en la PC). */
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "link.h"

#ifndef UPLINK_MAX   /* la base (firmware/base) usa uno menor: no tiene PSRAM */
#define UPLINK_MAX 16384         /* el mensaje más grande en cualquier sentido (el hello con los eventos de la mudanza, body.h) */
#endif
#define UPLINK_SILENCE_MS 90000  /* sin nada del servidor (ni ping) en este tiempo: la conexión se da por muerta */

typedef struct {
    int  (*send)(void *u, const uint8_t *p, size_t n);            /* todo, o −1 */
    long (*recv)(void *u, uint8_t *p, size_t cap, int wait_ms);   /* bytes; 0 = nada en wait_ms; −1 = cerrada */
    void (*rand)(void *u, uint8_t *p, size_t n);
    int64_t (*now_ms)(void *u);
    void *u;
} uplink_io;

typedef struct {
    const char *host, *path, *robot_id;
    int port;
    uint8_t key[LINK_KEY_LEN];
    int state_every_ms;
    long (*state)(char *out, size_t cap);                         /* JSON con "t":"state" */
    long (*take)(char *out, size_t cap);                          /* siguiente de la cola (outbox), 0 si no hay */
    long (*on_msg)(const char *json, char *reply, size_t cap);    /* del servidor; > 0 = respuesta que se manda */
    int  (*keep_going)(void);                                     /* NULL o 1 = seguir; 0 = cerrar */
} uplink_cfg;

/* Sobre un TCP ya conectado, hasta que se cierra. Devuelve el motivo ("cerrada", "llave"…). *authed: 1 si el servidor
 * contestó cifrado (la llave es la buena) (para el respiro entre reintentos). */
const char *uplink_run(const uplink_io *io, const uplink_cfg *c, int *authed);
