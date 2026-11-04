/* ws.c — ver ws.h */
#include "ws.h"

#include <stdio.h>
#include <string.h>

static void b64(const uint8_t *in, size_t n, char *out)
{
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t o = 0;
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < n ? in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
        out[o++] = T[v >> 18 & 63];
        out[o++] = T[v >> 12 & 63];
        out[o++] = i + 1 < n ? T[v >> 6 & 63] : '=';
        out[o++] = i + 2 < n ? T[v & 63] : '=';
    }
    out[o] = 0;
}

long ws_request(char *out, size_t cap, const char *host, int port, const char *path, const uint8_t key16[16])
{
    char key[25];
    b64(key16, 16, key);
    int n = snprintf(out, cap,
                     "GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                     "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n",
                     path, host, port, key);
    return n < 0 || (size_t)n >= cap ? -1 : n;
}

int ws_accepted(const char *resp)
{
    /* el Sec-WebSocket-Accept no se revisa: quién es el servidor lo prueba el enlace cifrado (link.h) */
    return strncmp(resp, "HTTP/1.1 101", 12) == 0;
}

long ws_frame(uint8_t *out, size_t cap, int opcode, const uint8_t *p, size_t n, const uint8_t mask[4])
{
    size_t h = n < 126 ? 2 : n < 65536 ? 4 : 10;
    if (cap < h + 4 + n) return -1;
    out[0] = (uint8_t)(0x80 | opcode);
    if (n < 126) out[1] = (uint8_t)(0x80 | n);
    else if (n < 65536) { out[1] = 0x80 | 126; out[2] = (uint8_t)(n >> 8); out[3] = (uint8_t)n; }
    else {
        out[1] = 0x80 | 127;
        for (int i = 0; i < 8; i++) out[2 + i] = (uint8_t)((uint64_t)n >> (56 - 8 * i));
    }
    memcpy(out + h, mask, 4);
    for (size_t i = 0; i < n; i++) out[h + 4 + i] = p[i] ^ mask[i & 3];
    return (long)(h + 4 + n);
}

long ws_parse(const uint8_t *buf, size_t n, size_t max, int *op, size_t *off, size_t *len)
{
    if (n < 2) return 0;
    if (!(buf[0] & 0x80) || (buf[1] & 0x80)) return -1;   /* fragmentado o con máscara: el servidor no los manda */
    uint64_t l = buf[1] & 0x7f;
    size_t h = 2;
    if (l == 126) {
        if (n < 4) return 0;
        l = (uint64_t)buf[2] << 8 | buf[3];
        h = 4;
    } else if (l == 127) {
        if (n < 10) return 0;
        l = 0;
        for (int i = 0; i < 8; i++) l = l << 8 | buf[2 + i];
        h = 10;
    }
    if (l > max) return -1;
    if (n < h + l) return 0;
    *op = buf[0] & 0x0f;
    *off = h;
    *len = (size_t)l;
    return (long)(h + l);
}
