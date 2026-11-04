/* uplink_pc — el enlace del robot (uplink.c, ws.c, link.c sin cambios) contra el relay de verdad, en la PC.
 * Lo corre relay/tests/test_uplink_c.py. Uso: uplink_pc <host> <puerto> <llave hex> <segundos>
 * La app es falsa: un estado fijo, tres mensajes en la cola y lo que llega del servidor se imprime ("<< json"). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
typedef SOCKET sock_t;
#else
#include <netdb.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
typedef int sock_t;
#define closesocket close
#endif

#include "uplink.h"

static sock_t sk;
static int64_t t_end;

static int64_t now_ms(void *u)
{
    (void)u;
    struct timespec ts;
    timespec_get(&ts, TIME_UTC);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static int tx(void *u, const uint8_t *p, size_t n)
{
    (void)u;
    while (n) {
        int r = send(sk, (const char *)p, (int)n, 0);
        if (r <= 0) return -1;
        p += r;
        n -= (size_t)r;
    }
    return 0;
}

static long rx(void *u, uint8_t *p, size_t cap, int wait_ms)
{
    (void)u;
    fd_set f;
    FD_ZERO(&f);
    FD_SET(sk, &f);
    struct timeval tv = {wait_ms / 1000, (wait_ms % 1000) * 1000};
    int r = select((int)sk + 1, &f, NULL, NULL, &tv);
    if (r < 0) return -1;
    if (r == 0) return 0;
    r = recv(sk, (char *)p, (int)cap, 0);
    return r <= 0 ? -1 : r;
}

static void rnd(void *u, uint8_t *p, size_t n)
{
    (void)u;
    for (size_t i = 0; i < n; i++) p[i] = (uint8_t)(rand() >> 7);
}

static long state(char *out, size_t cap)
{
    return snprintf(out, cap, "{\"t\":\"state\",\"state\":\"ST_AWAKE\",\"battery_pct\":8,\"power\":\"battery\",\"wellbeing\":-500}");
}

static const char *const Q[] = {
    "{\"t\":\"event\",\"ev\":\"new_face\",\"name\":\"amigo_7\"}",
    "{\"t\":\"night\",\"summary\":{\"age_days\":3,\"counts\":{\"pets\":4},\"wellbeing\":120,\"day_points\":9,\"absent_days\":0}}",
    "{\"t\":\"event\",\"ev\":\"home_failed\",\"battery_pct\":12,\"why\":\"más de 300 s\"}",
};
static int qi;

static long take(char *out, size_t cap)
{
    if (qi == (int)(sizeof Q / sizeof *Q)) return 0;
    return snprintf(out, cap, "%s", Q[qi++]);
}

static long on_msg(const char *json, char *reply, size_t cap)
{
    printf("<< %s\n", json);
    fflush(stdout);
    if (strstr(json, "\"t\":\"command\"")) return snprintf(reply, cap, "{\"t\":\"command_result\",\"code\":200}");
    return 0;
}

static int keep_going(void) { return now_ms(NULL) < t_end; }

int main(int argc, char **argv)
{
    if (argc != 5) { fprintf(stderr, "uso: uplink_pc <host> <puerto> <llave hex> <segundos>\n"); return 2; }
    srand((unsigned)time(NULL));
#ifdef _WIN32
    WSADATA wd;
    WSAStartup(MAKEWORD(2, 2), &wd);
#endif
    uplink_cfg c = {.host = argv[1], .path = "/v1/robot", .robot_id = "alma-pc", .port = atoi(argv[2]),
                    .state_every_ms = 500, .state = state, .take = take, .on_msg = on_msg, .keep_going = keep_going};
    if (link_key_hex(argv[3], c.key)) { fprintf(stderr, "llave inválida\n"); return 2; }
    struct addrinfo hints = {0}, *ai;
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(argv[1], argv[2], &hints, &ai) || !ai) { fprintf(stderr, "sin dirección\n"); return 1; }
    sk = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (connect(sk, ai->ai_addr, (int)ai->ai_addrlen)) { fprintf(stderr, "no conecta\n"); return 1; }
    freeaddrinfo(ai);
    t_end = now_ms(NULL) + atoi(argv[4]) * 1000LL;
    uplink_io io = {tx, rx, rnd, now_ms, NULL};
    int authed;
    const char *why = uplink_run(&io, &c, &authed);
    printf("fin: %s (autenticado %d)\n", why, authed);
    closesocket(sk);
    return authed ? 0 : 1;
}
