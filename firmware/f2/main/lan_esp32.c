/* lan_esp32.c — el socket UDP de la red local de Alma (lan.h), para el robot y para alma-base. Un hilo: recibe (con
 * 50 ms de espera), manda lo que haya en la cola y se anuncia por difusión cada LAN_HELLO_MS. */
#include "f2_config.h"
#include "lan.h"

#if ALMA_F2_API   /* el robot solo con red (-Api); alma-base la define siempre (base/main/CMakeLists.txt) */
#include <stdio.h>
#include <string.h>

#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

#include "f2_hal.h"
#include "lan.h"

typedef struct { char to[16]; char body[LAN_MAX - 64]; } lan_out;

static int sk = -1;
static QueueHandle_t q;
static uint8_t key[LAN_KEY_LEN];
static char my_id[16], my_tipo[16];
static uint32_t boot, cnt;
static lan_peer peers[LAN_PEERS];
static void (*cb)(const char *json, const lan_peer *from);

static void send_to(uint32_t ip, const char *body)
{
    static uint8_t buf[LAN_MAX];
    long n = lan_pack(key, my_id, boot, &cnt, body, buf, sizeof buf);
    if (n < 0) return;
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(LAN_PORT), .sin_addr.s_addr = ip};
    sendto(sk, buf, (size_t)n, 0, (struct sockaddr *)&a, sizeof a);
}

static void lan_task(void *arg)
{
    (void)arg;
    static uint8_t in[LAN_MAX];
    static char js[LAN_MAX];
    static lan_out o;
    int64_t hello = 0;
    for (;;) {
        if (sk < 0) {   /* hasta que haya red */
            sk = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
            struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(LAN_PORT), .sin_addr.s_addr = htonl(INADDR_ANY)};
            int on = 1;
            struct timeval to = {0, 50000};
            if (sk < 0 || setsockopt(sk, SOL_SOCKET, SO_BROADCAST, &on, sizeof on) ||
                setsockopt(sk, SOL_SOCKET, SO_RCVTIMEO, &to, sizeof to) || bind(sk, (struct sockaddr *)&a, sizeof a)) {
                if (sk >= 0) close(sk);
                sk = -1;
                vTaskDelay(pdMS_TO_TICKS(2000));
                continue;
            }
            hal_log("lan: escuchando en UDP %d como \"%s\"", LAN_PORT, my_id);
        }
        int64_t now = hal_now_ms();
        if (now - hello >= LAN_HELLO_MS) {
            hello = now;
            char b[64];
            snprintf(b, sizeof b, "\"t\":\"hola\",\"tipo\":\"%s\"", my_tipo);
            send_to(htonl(INADDR_BROADCAST), b);
        }
        while (xQueueReceive(q, &o, 0) == pdTRUE) {
            const lan_peer *p = o.to[0] ? lan_find(peers, o.to, now) : NULL;
            if (o.to[0] && !p) continue;   /* aún no se le conoce: se pierde (quien manda repite) */
            send_to(p ? p->ip : htonl(INADDR_BROADCAST), o.body);
        }
        struct sockaddr_in from;
        socklen_t fl = sizeof from;
        int r = recvfrom(sk, in, sizeof in, 0, (struct sockaddr *)&from, &fl);
        if (r <= 0) continue;
        int who = -1;
        if (lan_unpack(key, in, (size_t)r, from.sin_addr.s_addr, hal_now_ms(), peers, js, sizeof js, my_id, &who) < 0) continue;
        if (cb && who >= 0) cb(js, &peers[who]);
    }
}

void lan_start(const char *id, const char *tipo, const uint8_t k[LAN_KEY_LEN],
               void (*on_msg)(const char *json, const lan_peer *from))
{
    memcpy(key, k, LAN_KEY_LEN);
    snprintf(my_id, sizeof my_id, "%s", id);
    snprintf(my_tipo, sizeof my_tipo, "%s", tipo);
    boot = esp_random();
    cb = on_msg;
    q = xQueueCreate(4, sizeof(lan_out));
    if (!q || xTaskCreate(lan_task, "lan", 4096, NULL, 4, NULL) != pdPASS) hal_log("lan: no pude arrancar");
}

int lan_send(const char *to_id, const char *body)
{
    static lan_out o;   /* lo copia la cola; un solo hilo manda (el de la app) */
    if (!q) return -1;
    snprintf(o.to, sizeof o.to, "%s", to_id ? to_id : "");
    snprintf(o.body, sizeof o.body, "%s", body);
    return xQueueSend(q, &o, 0) == pdTRUE ? 0 : -1;
}

int lan_peer_seen(const char *id, int64_t *age_ms)
{
    int64_t now = hal_now_ms();
    const lan_peer *p = lan_find(peers, id, now);
    if (!p) return 0;
    if (age_ms) *age_ms = now - p->seen_ms;
    return 1;
}
#else
void lan_start(const char *id, const char *tipo, const uint8_t key[LAN_KEY_LEN],
               void (*on_msg)(const char *json, const lan_peer *from)) { (void)id; (void)tipo; (void)key; (void)on_msg; }
int lan_send(const char *to_id, const char *body) { (void)to_id; (void)body; return -1; }
int lan_peer_seen(const char *id, int64_t *age_ms) { (void)id; (void)age_ms; return 0; }
#endif
