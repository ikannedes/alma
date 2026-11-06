/* lan — la red local de Alma (dueño, 2026-11-06: "probemos el pong y la comunicación a futuro por udp, para la base y
 * los demás juegos u otros dispositivos que usen esp"). Robot, Home Station (alma-base) y lo que venga se hablan por UDP
 * en la red de la casa, sin pasar por el servidor: pocos ms y el Wi-Fi reintenta lo que se pierde (los anuncios de
 * Bluetooth no). El Bluetooth sigue para "estás cerca / cargando" y de respaldo.
 *
 * Puerto LAN_PORT. Cada mensaje: "AL1" + 8 bytes de HMAC-SHA256(llave del enlace, "alma-lan" + json) + json. El json
 * lleva siempre "id" (quién: "robot", "base"…), "b" (al azar en cada arranque) y "n" (contador que solo sube): con la
 * firma, otro aparato de la red no se hace pasar por ellos; con b/n, un mensaje repetido no se acepta dos veces.
 * Cada LAN_HELLO_MS se manda {"t":"hola","tipo":…} por difusión: así se encuentran solos.
 *
 * Portable: el socket está en main/lan_esp32.c (robot y base lo comparten). */
#pragma once
#include <stddef.h>
#include <stdint.h>

#define LAN_PORT      47100
#define LAN_MAX       512        /* el mensaje más grande */
#define LAN_HELLO_MS  2000
#define LAN_PEER_MS   8000       /* sin noticias en este tiempo, el otro se dio por ido */
#define LAN_PEERS     6
#define LAN_KEY_LEN   32

typedef struct lan_peer_s {
    char id[16];
    uint32_t ip;                 /* orden de red */
    uint32_t boot, n;
    int64_t seen_ms;
} lan_peer;

/* El mensaje completo para mandar: añade id/b/n al cuerpo ("\"t\":\"pong\",\"bx\":3…", sin llaves) y lo firma. Largo, o −1 */
long lan_pack(const uint8_t key[LAN_KEY_LEN], const char *id, uint32_t boot, uint32_t *n, const char *body,
              uint8_t *out, size_t cap);
/* Verifica la firma y que no sea repetido (tabla de pares); escribe el json en out (con 0) y en *who el par que lo
   mandó. Largo, o −1 */
long lan_unpack(const uint8_t key[LAN_KEY_LEN], const uint8_t *in, size_t len, uint32_t ip, int64_t now_ms,
                lan_peer peers[LAN_PEERS], char *out, size_t cap, const char *my_id, int *who);
/* El par con ese id visto hace menos de LAN_PEER_MS, o NULL */
const lan_peer *lan_find(const lan_peer peers[LAN_PEERS], const char *id, int64_t now_ms);

/* ---- en el ESP32 (main/lan_esp32.c; el robot y la base lo comparten) ---- */
/* Arranca el hilo: escucha LAN_PORT y se anuncia cada LAN_HELLO_MS. on_msg corre en ese hilo, con el json ya verificado */
void lan_start(const char *id, const char *tipo, const uint8_t key[LAN_KEY_LEN],
               void (*on_msg)(const char *json, const lan_peer *from));
/* A la cola: a ese id (si se le conoce) o, con NULL, a todos por difusión. 0 = encolado */
int  lan_send(const char *to_id, const char *body);
int  lan_peer_seen(const char *id, int64_t *age_ms);   /* 1 si se le conoce; *age_ms hace cuánto */
