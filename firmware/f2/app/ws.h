/* ws — lo mínimo de WebSocket (RFC 6455) para el enlace con el servidor: saludo HTTP, frames del cliente con máscara
 * y lectura de frames del servidor. Portable; el socket está en main/link_esp32.c (y en la prueba de la PC). */
#pragma once
#include <stddef.h>
#include <stdint.h>

enum { WS_TEXT = 1, WS_BIN = 2, WS_CLOSE = 8, WS_PING = 9, WS_PONG = 10 };

/* GET path con Upgrade; key16 = 16 bytes aleatorios. Devuelve el largo, o −1 si no cabe. */
long ws_request(char *out, size_t cap, const char *host, int port, const char *path, const uint8_t key16[16]);
/* Con la respuesta completa (hasta "\r\n\r\n"): 1 si es "101", 0 si no. */
int  ws_accepted(const char *resp);
/* Frame del cliente (FIN, con máscara). Devuelve el largo, o −1 si no cabe. */
long ws_frame(uint8_t *out, size_t cap, int opcode, const uint8_t *p, size_t n, const uint8_t mask[4]);
/* Frame del servidor al inicio de buf: devuelve el largo total si está completo, 0 si faltan bytes, −1 si no se
 * entiende (fragmentado, con máscara o más grande que max). *op, *off y *len: tipo, inicio y largo de los datos. */
long ws_parse(const uint8_t *buf, size_t n, size_t max, int *op, size_t *off, size_t *len);
