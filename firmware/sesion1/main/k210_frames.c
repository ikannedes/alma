#include "k210_frames.h"

#include <stdio.h>
#include <string.h>

uint8_t k210_crc8_maxim(const uint8_t *p, size_t n)
{
    uint8_t crc = 0;
    while (n--) {
        crc ^= *p++;
        for (int i = 0; i < 8; i++) crc = (crc & 1) ? (crc >> 1) ^ 0x8C : crc >> 1;
    }
    return crc;
}

uint8_t k210_payload_cs(const uint8_t *payload_with_nul, size_t n, k210_cs_mode m)
{
    if (m == K210_CS_CRC8) return k210_crc8_maxim(payload_with_nul, n);
    uint8_t s = 0;
    for (size_t i = 0; i + 1 < n; i++) s += payload_with_nul[i];   /* sin el 00 final */
    return s;
}

static uint8_t sum6(const uint8_t *p)
{
    unsigned s = 0;
    for (int i = 0; i < 6; i++) s += p[i];
    return (uint8_t)s;
}

size_t k210_small(uint8_t out[K210_SMALL_LEN], uint8_t cmd, uint8_t d0, uint8_t d1, uint8_t d2)
{
    out[0] = 0x55; out[1] = 0xAA; out[2] = cmd; out[3] = d0; out[4] = d1; out[5] = d2;
    out[6] = sum6(out);
    return K210_SMALL_LEN;
}

size_t k210_ext_bytes(uint8_t *out, size_t cap, uint8_t sel, const uint8_t *body, size_t n, k210_cs_mode m)
{
    if (n == 0 || n > K210_EXT_MAX || 7 + n + 1 > cap) return 0;
    out[0] = 0x55; out[1] = 0xAA; out[2] = 0xFF;
    out[3] = (uint8_t)(n & 0xFF); out[4] = (uint8_t)(n >> 8); out[5] = sel;
    out[6] = sum6(out);
    memmove(out + 7, body, n);
    out[7 + n] = k210_payload_cs(out + 7, n, m);
    return 7 + n + 1;
}

size_t k210_ext(uint8_t *out, size_t cap, uint8_t sel, const char *payload, k210_cs_mode m)
{
    return k210_ext_bytes(out, cap, sel, (const uint8_t *)payload, strlen(payload) + 1, m);   /* con el 00 */
}

size_t k210_anim_payload_path(char *out, size_t cap, const char *avi_path, const char *mp3_path_or_null, int mode)
{
    int n = mp3_path_or_null ? snprintf(out, cap, "[%d,[[\"%s\",[[0,\"%s\"]]]]]", mode, avi_path, mp3_path_or_null)
                             : snprintf(out, cap, "[%d,[[\"%s\"]]]", mode, avi_path);
    return (n < 0 || (size_t)n >= cap) ? 0 : (size_t)n;
}

size_t k210_anim_payload(char *out, size_t cap, const char *avi, const char *mp3_or_null, int mode)
{
    int n = mp3_or_null
        ? snprintf(out, cap, "[%d,[[\"/spiffs/avi/%s.avi\",[[0,\"/spiffs/mp3/%s.mp3\"]]]]]", mode, avi, mp3_or_null)
        : snprintf(out, cap, "[%d,[[\"/spiffs/avi/%s.avi\"]]]", mode, avi);
    return (n < 0 || (size_t)n >= cap) ? 0 : (size_t)n;
}

void k210_parser_init(k210_parser *ps, k210_rx_cb cb, void *user)
{
    ps->n = 0;
    ps->ext_tail = 1;
    ps->cb = cb;
    ps->user = user;
}

static void consume(k210_parser *ps, size_t k)
{
    memmove(ps->buf, ps->buf + k, ps->n - k);
    ps->n -= k;
}

/* Saca del búfer todo lo que ya se puede decidir. Parser recomendado por [SAM-SPI]:
   buscar 55 AA, verificar el checksum y, si falla, avanzar un byte. */
static void drain(k210_parser *ps)
{
    for (;;) {
        size_t s = 0;
        while (s + 1 < ps->n && !(ps->buf[s] == 0x55 && ps->buf[s + 1] == 0xAA)) s++;
        if (s + 1 >= ps->n && ps->n > 0 && ps->buf[ps->n - 1] == 0x55) s = ps->n - 1;   /* 55 al final: puede venir AA */
        else if (s + 1 >= ps->n) s = ps->n;
        if (s > 0) {
            ps->cb(ps->user, K210_RX_JUNK, ps->buf, s, 0);
            consume(ps, s);
        }
        if (ps->n < K210_SMALL_LEN) return;
        const uint8_t *b = ps->buf;
        if (sum6(b) != b[6]) {            /* ni frame corto ni cabecera extendida válida */
            ps->cb(ps->user, K210_RX_JUNK, b, 1, 0);
            consume(ps, 1);
            continue;
        }
        if (b[2] != 0xFF) {
            ps->cb(ps->user, K210_RX_SMALL, b, K210_SMALL_LEN, 0);
            consume(ps, K210_SMALL_LEN);
            continue;
        }
        size_t body = (size_t)b[3] | ((size_t)b[4] << 8);
        if (body == 0 || body > K210_EXT_MAX) {   /* CMD 0xFF con largo imposible: se entrega como frame corto */
            ps->cb(ps->user, K210_RX_SMALL, b, K210_SMALL_LEN, 0);
            consume(ps, K210_SMALL_LEN);
            continue;
        }
        size_t total = 7 + body + (ps->ext_tail ? 1 : 0);
        if (ps->n < total) return;           /* falta el resto */
        int flags = 0;
        if (ps->ext_tail && k210_payload_cs(b + 7, body, K210_CS_CRC8) == b[total - 1]) flags |= K210_EXT_CRC8_OK;
        if (ps->ext_tail && k210_payload_cs(b + 7, body, K210_CS_SUM) == b[total - 1]) flags |= K210_EXT_SUM_OK;
        ps->cb(ps->user, K210_RX_EXT, b, total, flags);
        consume(ps, total);
    }
}

void k210_parser_feed(k210_parser *ps, const uint8_t *p, size_t n)
{
    while (n) {
        size_t room = sizeof ps->buf - ps->n;
        size_t k = n < room ? n : room;
        memcpy(ps->buf + ps->n, p, k);
        ps->n += k;
        p += k;
        n -= k;
        drain(ps);
        if (ps->n == sizeof ps->buf) {       /* no debería pasar: un frame máximo cabe entero */
            ps->cb(ps->user, K210_RX_INCOMPLETE, ps->buf, ps->n, 0);
            ps->n = 0;
        }
    }
}

void k210_parser_flush(k210_parser *ps)
{
    if (ps->n == 0) return;
    ps->cb(ps->user, K210_RX_INCOMPLETE, ps->buf, ps->n, 0);
    ps->n = 0;
}
