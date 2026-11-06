/* red.c — Wi-Fi y enlace con el servidor de Alma (relay /v1/robot con el id "base"). El Wi-Fi es el que la base ya tenía guardado
 * (nvs.net80211, sta.ssid/sta.pswd, lo escribió el firmware de fábrica): se lee y se usa en RAM, sin escribir ni borrar
 * la NVS (guard.c). Si no se puede leer, las credenciales de desarrollo (alma_dev_creds.h, fuera del repo). El enlace es
 * el del robot (uplink.h: WebSocket + AES-256-GCM con la llave del enlace), con el id "base". */
#include <stdio.h>
#include <string.h>

#include "esp_event.h"
#include "esp_netif.h"
#include "esp_random.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "alma_dev_creds.h"
#include "base.h"
#include "f2_hal.h"
#include "lan.h"
#include "link.h"
#include "uplink.h"

#ifndef ALMA_DEV_RELAY_PORT
#define ALMA_DEV_RELAY_PORT 80
#endif
#define LINK_STATE_MS 10000
#define RETRY_MIN_S 5
#define RETRY_MAX_S 120

static EventGroupHandle_t net_ev;
#define GOT_IP 1
static char ip_str[16] = "sin";
const char *red_ip(void) { return ip_str; }

static void on_wifi(void *arg, esp_event_base_t b, int32_t id, void *data)
{
    (void)arg;
    if (b == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
    if (b == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(net_ev, GOT_IP);
        snprintf(ip_str, sizeof ip_str, "sin");
        vTaskDelay(pdMS_TO_TICKS(1000));
        esp_wifi_connect();
    }
    if (b == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *e = data;
        snprintf(ip_str, sizeof ip_str, IPSTR, IP2STR(&e->ip_info.ip));
        hal_log("red: Wi-Fi conectado, IP %s", ip_str);
        xEventGroupSetBits(net_ev, GOT_IP);
    }
}

/* la red que guardó el firmware de fábrica: sta.ssid = {u32 largo, 32 bytes}, sta.pswd = 64 bytes + 0. Solo lectura */
static int saved_wifi(wifi_config_t *wc)
{
    esp_err_t e = nvs_flash_init();   /* nunca se borra si falla (guard.c) */
    if (e != ESP_OK) { hal_log("red: la NVS de la base no abrió (%s); no se toca", esp_err_to_name(e)); return -1; }
    nvs_handle_t h;
    if (nvs_open("nvs.net80211", NVS_READONLY, &h) != ESP_OK) { hal_log("red: la base no tiene Wi-Fi guardado"); return -1; }
    uint8_t ssid[36] = {0}, pswd[65] = {0};
    size_t ns = sizeof ssid, np = sizeof pswd;
    int ok = nvs_get_blob(h, "sta.ssid", ssid, &ns) == ESP_OK && nvs_get_blob(h, "sta.pswd", pswd, &np) == ESP_OK;
    nvs_close(h);
    uint32_t len;
    memcpy(&len, ssid, 4);
    if (!ok || ns != sizeof ssid || len == 0 || len > 32) { hal_log("red: el Wi-Fi guardado no se entiende"); return -1; }
    memcpy(wc->sta.ssid, ssid + 4, len);
    memcpy(wc->sta.password, pswd, sizeof wc->sta.password);   /* 64; el 65.º es el 0 final */
    hal_log("red: uso el Wi-Fi que la base ya tenía guardado (%u letras de nombre)", (unsigned)len);
    return 0;
}

void red_start(void)
{
    net_ev = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, NULL);
    esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi, NULL);
    wifi_config_t wc = {0};
    if (saved_wifi(&wc)) {
#if defined(ALMA_DEV_WIFI_SSID) && defined(ALMA_DEV_WIFI_PASSWORD)
        hal_log("red: uso el Wi-Fi de desarrollo (alma_dev_creds.h)");
        strncpy((char *)wc.sta.ssid, ALMA_DEV_WIFI_SSID, sizeof wc.sta.ssid);
        strncpy((char *)wc.sta.password, ALMA_DEV_WIFI_PASSWORD, sizeof wc.sta.password);
#else
        hal_log("red: sin Wi-Fi; la base sigue sin servidor");
        return;
#endif
    }
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());
}

/* ---- enlace (como main/api_esp32.c del robot) ---- */
#if defined(ALMA_DEV_RELAY_HOST) && defined(ALMA_DEV_LINK_KEY)
static int sk = -1;

static int tx(void *u, const uint8_t *p, size_t n)
{
    (void)u;
    while (n) {
        int r = send(sk, p, n, 0);
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
    int r = select(sk + 1, &f, NULL, NULL, &tv);
    if (r < 0) return -1;
    if (r == 0) return 0;
    r = recv(sk, p, cap, 0);
    return r <= 0 ? -1 : r;
}

static void rnd(void *u, uint8_t *p, size_t n) { (void)u; esp_fill_random(p, n); }
static int64_t now_ms(void *u) { (void)u; return hal_now_ms(); }

static uplink_cfg link_cfg = {.host = ALMA_DEV_RELAY_HOST, .path = "/v1/robot", .robot_id = "base",   /* el proxy del 8080 solo abre /v1/robot; el servidor la separa por el id */
                              .port = ALMA_DEV_RELAY_PORT, .state_every_ms = LINK_STATE_MS,
                              .state = base_state, .take = base_take, .on_msg = base_msg};

static void link_task(void *arg)
{
    (void)arg;
    const uplink_io io = {tx, rx, rnd, now_ms, NULL};
    int wait_s = RETRY_MIN_S;
    for (;;) {
        while (!(xEventGroupGetBits(net_ev) & GOT_IP)) vTaskDelay(pdMS_TO_TICKS(2000));
        char port[8];
        snprintf(port, sizeof port, "%d", ALMA_DEV_RELAY_PORT);
        struct addrinfo hints = {.ai_family = AF_INET, .ai_socktype = SOCK_STREAM}, *ai = NULL;
        const char *why;
        int authed = 0;
        if (getaddrinfo(ALMA_DEV_RELAY_HOST, port, &hints, &ai) != 0 || !ai) why = "no se encontró el servidor (DNS)";
        else {
            sk = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
            if (sk < 0) why = "sin socket";
            else if (connect(sk, ai->ai_addr, ai->ai_addrlen) != 0) why = "el servidor no contesta";
            else {
                hal_log("enlace: conectando con el servidor");
                why = uplink_run(&io, &link_cfg, &authed);
                base_link(0);
            }
            if (sk >= 0) close(sk);
            sk = -1;
        }
        if (ai) freeaddrinfo(ai);
        wait_s = authed ? RETRY_MIN_S : wait_s * 2 > RETRY_MAX_S ? RETRY_MAX_S : wait_s * 2;
        hal_log("enlace: %s; reintento en %d s", why, wait_s);
        vTaskDelay(pdMS_TO_TICKS(wait_s * 1000));
    }
}

void red_link_start(void)
{
    if (link_key_hex(ALMA_DEV_LINK_KEY, link_cfg.key)) { hal_log("enlace: ALMA_DEV_LINK_KEY no es válida; sin servidor"); return; }
    lan_start("base", "base", link_cfg.key, base_lan_msg);   /* la red local de Alma (lan.h): el robot y lo que venga */
    if (xTaskCreate(link_task, "enlace", 6144, NULL, 4, NULL) != pdPASS) hal_log("enlace: no pude crear el hilo");
}
#else
void red_link_start(void) { hal_log("enlace: sin ALMA_DEV_RELAY_HOST/ALMA_DEV_LINK_KEY; sin servidor"); }
#endif
