/* uplink.c — ver uplink.h */
#include "uplink.h"

#include <string.h>

#include "f2_hal.h"
#include "ws.h"

/* una conexión a la vez: los búferes en la PSRAM (~16 KB) */
static EXT_RAM_BSS_ATTR uint8_t rx[UPLINK_MAX + 64], fr[UPLINK_MAX + 64];
static EXT_RAM_BSS_ATTR char js[UPLINK_MAX + 1];

static int send_frame(const uplink_io *io, int op, const uint8_t *p, size_t n)
{
    uint8_t mask[4];
    io->rand(io->u, mask, 4);
    long m = ws_frame(fr, sizeof fr, op, p, n, mask);
    return m < 0 ? -1 : io->send(io->u, fr, (size_t)m);
}

static int send_json(const uplink_io *io, link_sess *s, const char *j, size_t n)
{
    static EXT_RAM_BSS_ATTR uint8_t sealed[UPLINK_MAX + LINK_D_OVERHEAD];
    long m = link_seal(s, j, n, sealed, sizeof sealed);
    return m < 0 ? -1 : send_frame(io, WS_BIN, sealed, (size_t)m);
}

const char *uplink_run(const uplink_io *io, const uplink_cfg *c, int *authed)
{
    *authed = 0;
    uint8_t key16[16];
    io->rand(io->u, key16, sizeof key16);
    long n = ws_request(js, sizeof js, c->host, c->port, c->path, key16);
    if (n < 0 || io->send(io->u, (const uint8_t *)js, (size_t)n) < 0) return "no se pudo mandar el saludo";

    /* respuesta HTTP: hasta "\r\n\r\n"; lo que venga después ya es WebSocket */
    size_t rn = 0;
    int64_t t0 = io->now_ms(io->u);
    char *end = NULL;
    while (!end) {
        if (io->now_ms(io->u) - t0 > 10000 || rn >= 1024) return "sin respuesta al saludo";
        long r = io->recv(io->u, rx + rn, 1024 - rn, 200);
        if (r < 0) return "cerrada en el saludo";
        rn += (size_t)r;
        rx[rn] = 0;
        end = strstr((char *)rx, "\r\n\r\n");
    }
    if (!ws_accepted((char *)rx)) return "el servidor no aceptó el WebSocket";
    size_t hdr = (size_t)(end + 4 - (char *)rx);
    memmove(rx, rx + hdr, rn - hdr);
    rn -= hdr;

    link_sess s;
    int sent_auth = 0;
    int64_t last_rx = io->now_ms(io->u), next_state = 0;
    for (;;) {
        int op;
        size_t off, len;
        long fl;
        while ((fl = ws_parse(rx, rn, UPLINK_MAX + LINK_D_OVERHEAD, &op, &off, &len)) > 0) {
            const uint8_t *p = rx + off;
            if (op == WS_CLOSE) return *authed ? "el servidor cerró" : "el servidor cerró (¿llave del enlace?)";
            if (op == WS_PING && send_frame(io, WS_PONG, p, len) < 0) return "no se pudo mandar pong";
            if (op == WS_BIN && !sent_auth) {
                uint8_t rnd[LINK_AUTH_RAND];
                io->rand(io->u, rnd, sizeof rnd);
                long m = link_auth(c->key, p, len, c->robot_id, rnd, &s, fr + 64, sizeof fr - 64);
                if (m < 0) return "saludo del servidor inválido";
                memcpy(js, fr + 64, (size_t)m);   /* send_frame usa fr */
                if (send_frame(io, WS_BIN, (const uint8_t *)js, (size_t)m) < 0) return "no se pudo autenticar";
                sent_auth = 1;
            } else if (op == WS_BIN) {
                if (link_open(&s, p, len, js, sizeof js) < 0) return "frame alterado o repetido";
                *authed = 1;   /* el servidor ya habló con la llave de sesión: la llave del enlace es la buena */
                static EXT_RAM_BSS_ATTR char reply[UPLINK_MAX];
                long m = c->on_msg(js, reply, sizeof reply);
                if (m > 0 && send_json(io, &s, reply, (size_t)m) < 0) return "no se pudo responder";
            }
            memmove(rx, rx + fl, rn - (size_t)fl);
            rn -= (size_t)fl;
        }
        if (fl < 0) return "frame WebSocket inválido";

        int64_t now = io->now_ms(io->u);
        if (*authed) {
            if (now >= next_state) {
                long m = c->state(js, sizeof js);
                if (m > 0 && send_json(io, &s, js, (size_t)m) < 0) return "no se pudo mandar el estado";
                next_state = now + c->state_every_ms;
            }
            long m;
            while ((m = c->take(js, sizeof js)) > 0)
                if (send_json(io, &s, js, (size_t)m) < 0) return "no se pudo mandar un evento";
        } else if (now - t0 > 15000) return "sin autenticación en 15 s";
        if (c->keep_going && !c->keep_going()) {
            send_frame(io, WS_CLOSE, (const uint8_t *)"\x03\xe8", 2);
            return "cerrada por el robot";
        }
        if (now - last_rx > UPLINK_SILENCE_MS) return "el servidor no responde";
        /* lleno después de sacar los frames completos (arriba): uno solo no cabe. Antes se revisaba después de recv y un
           frame completo más el principio del siguiente cortaba el enlace (la OTA, 2026-11-03) */
        if (rn == sizeof rx) return "frame demasiado grande";
        long r = io->recv(io->u, rx + rn, sizeof rx - rn, 200);
        if (r < 0) return "cerrada";
        if (r > 0) last_rx = io->now_ms(io->u);
        rn += (size_t)r;
    }
}
