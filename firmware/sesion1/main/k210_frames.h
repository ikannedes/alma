/* Frames UART ESP32 <-> K210 (03-protocolo-k210.md). C portable: sin ESP-IDF, se prueba en la PC. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#define K210_SMALL_LEN   7
#define K210_EXT_MAX     1024                       /* PENDIENTE: 03 "Tamaño máximo por paquete" */
#define K210_FRAME_MAX   (7 + K210_EXT_MAX + 1)

typedef enum {
    K210_CS_CRC8 = 0,   /* CRC-8/MAXIM sobre payload + 00 (DERIVADO, 9/9 capturas) */
    K210_CS_SUM  = 1,   /* suma de los bytes del payload sin el 00 [SAM-SPI] */
} k210_cs_mode;

uint8_t k210_crc8_maxim(const uint8_t *p, size_t n);
uint8_t k210_payload_cs(const uint8_t *payload_with_nul, size_t n, k210_cs_mode m);

/* 55 AA CMD D0 D1 D2 CS. Devuelve 7. */
size_t k210_small(uint8_t out[K210_SMALL_LEN], uint8_t cmd, uint8_t d0, uint8_t d1, uint8_t d2);

/* 55 AA FF LEN_LO LEN_HI SEL HDR_CS <payload> 00 PAYLOAD_CS. Devuelve el largo, o 0 si no cabe. */
size_t k210_ext(uint8_t *out, size_t cap, uint8_t sel, const char *payload, k210_cs_mode m);

/* Extendido con estos bytes tal cual (LEN = n): para cargas sin 00 final, como el tipo del envío de archivos (28) */
size_t k210_ext_bytes(uint8_t *out, size_t cap, uint8_t sel, const uint8_t *body, size_t n, k210_cs_mode m);
/* Como k210_anim_payload, con rutas completas (p. ej. "/test/x.avi") */
size_t k210_anim_payload_path(char *out, size_t cap, const char *avi_path, const char *mp3_path_or_null, int mode);

/* Payload de animación como en las capturas: [MODO,[["/spiffs/avi/<avi>.avi"(,[[0,"/spiffs/mp3/<mp3>.mp3"]])]]] */
size_t k210_anim_payload(char *out, size_t cap, const char *avi, const char *mp3_or_null, int mode);

/* ---- Recepción con resincronización ---- */
typedef enum {
    K210_RX_SMALL,       /* frame corto con checksum válido */
    K210_RX_EXT,         /* frame extendido con HDR_CS válido; ver flags */
    K210_RX_JUNK,        /* bytes que no forman un frame (se registran igual) */
    K210_RX_INCOMPLETE,  /* frame cortado por silencio en la línea (k210_parser_flush) */
} k210_rx_kind;

#define K210_EXT_CRC8_OK 1   /* PAYLOAD_CS coincide con CRC-8/MAXIM */
#define K210_EXT_SUM_OK  2   /* PAYLOAD_CS coincide con la suma */

typedef void (*k210_rx_cb)(void *user, k210_rx_kind kind, const uint8_t *p, size_t n, int flags);

typedef struct {
    uint8_t buf[K210_FRAME_MAX];
    size_t n;
    int ext_tail;        /* 1: el extendido trae PAYLOAD_CS al final (omisión). 0: no lo trae, como los que
                            manda el K210 (medido [ALMA-1A]: 55 aa ff 06 00 69 6d + 6 bytes, sin byte final) */
    k210_rx_cb cb;
    void *user;
} k210_parser;

void k210_parser_init(k210_parser *ps, k210_rx_cb cb, void *user);
void k210_parser_feed(k210_parser *ps, const uint8_t *p, size_t n);
/* La línea quedó en silencio: lo que esté a medias se entrega como K210_RX_INCOMPLETE. */
void k210_parser_flush(k210_parser *ps);
