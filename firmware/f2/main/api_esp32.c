/* api_esp32.c — red del robot, solo con ALMA_F2_API=1 (apagada por omisión): Wi-Fi, hora por SNTP y el enlace con el
 * servidor (sin servidor HTTP en el robot desde el 2026-10-30: la app del celular está en el servidor).
 * Wi-Fi según R15: CONFIG_ESP_WIFI_NVS_ENABLED=n y CONFIG_ESP_PHY_CALIBRATION_AND_DATA_STORAGE=n (sdkconfig.defaults),
 * esp_wifi_set_storage(WIFI_STORAGE_RAM), y nunca nvs_flash_init. Las credenciales de desarrollo, el
 * servidor SNTP y la zona horaria vienen de alma_dev_creds.h, un archivo local FUERA del repo (dev_creds.example.h). */
#include "f2_config.h"

#if ALMA_F2_API
#include <stdio.h>
#include <string.h>
#include <time.h>

#include "esp_event.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_wifi.h"
#include "esp_random.h"
#include "freertos/event_groups.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"

#include "alma_dev_creds.h"   /* ALMA_DEV_WIFI_SSID, ALMA_DEV_WIFI_PASSWORD, ALMA_DEV_RELAY_*, ALMA_DEV_LINK_KEY, NTP, TZ */
#include "api.h"
#include "app.h"
#include "link.h"
#include "outbox.h"
#include "uplink.h"
#include "voice.h"
#include "f2_hal.h"
#include "f2_main.h"

#ifndef ALMA_DEV_NTP_SERVER
#define ALMA_DEV_NTP_SERVER "pool.ntp.org"
#endif
#ifndef ALMA_DEV_TZ
#define ALMA_DEV_TZ "UTC0"
#endif

static EventGroupHandle_t net_ev;
static char ip_str[16] = "sin";
const char *f2_net_ip(void) { return ip_str; }
#define GOT_IP 1

static void on_wifi(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) esp_wifi_connect();
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        snprintf(ip_str, sizeof ip_str, "sin");
        hal_log("api: Wi-Fi desconectado; reintento");
        esp_wifi_connect();
    }
    if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        const ip_event_got_ip_t *e = data;
        snprintf(ip_str, sizeof ip_str, IPSTR, IP2STR(&e->ip_info.ip));
        hal_log("api: Wi-Fi conectado, IP " IPSTR, IP2STR(&e->ip_info.ip));
        xEventGroupSetBits(net_ev, GOT_IP);
    }
}

double f2_net_start(void)
{
    net_ev = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();   /* .nvs_enable = 0 con CONFIG_ESP_WIFI_NVS_ENABLED=n */
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_wifi, NULL));
    wifi_config_t wc = {0};
    strncpy((char *)wc.sta.ssid, ALMA_DEV_WIFI_SSID, sizeof wc.sta.ssid);
    strncpy((char *)wc.sta.password, ALMA_DEV_WIFI_PASSWORD, sizeof wc.sta.password);
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wc));
    ESP_ERROR_CHECK(esp_wifi_start());

    /* hueco 16: hora local por SNTP, una vez, antes de app_init */
    if (!(xEventGroupWaitBits(net_ev, GOT_IP, pdFALSE, pdTRUE, pdMS_TO_TICKS(30000)) & GOT_IP)) {
        hal_log("api: sin IP en 30 s; Alma arranca a las 8:00 (sin hora real)");
        return -1;
    }
    esp_sntp_config_t sc = ESP_NETIF_SNTP_DEFAULT_CONFIG(ALMA_DEV_NTP_SERVER);
    esp_netif_sntp_init(&sc);
    setenv("TZ", ALMA_DEV_TZ, 1);
    tzset();
    if (esp_netif_sntp_sync_wait(pdMS_TO_TICKS(30000)) != ESP_OK) {
        hal_log("api: SNTP (%s) no respondió en 30 s; Alma arranca a las 8:00 (sin hora real)", ALMA_DEV_NTP_SERVER);
        return -1;
    }
    time_t now = time(NULL);
    struct tm lt;
    localtime_r(&now, &lt);
    char buf[40];
    strftime(buf, sizeof buf, "%Y-%m-%d %H:%M:%S", &lt);
    hal_log("api: hora por SNTP (%s, TZ %s): %s", ALMA_DEV_NTP_SERVER, ALMA_DEV_TZ, buf);
    /* segundos locales desde 1970 y no solo la hora del día: con memoria, cada arranque volvía al "día 0" y el pase
       nocturno podía darse por hecho (night_done_for_day) o repetirse (2026-10-30). alma_hour solo usa el resto del día */
    int y = lt.tm_year + 1900, m = lt.tm_mon + 1;
    y -= m <= 2;
    long era = (y >= 0 ? y : y - 399) / 400, yoe = y - era * 400;
    long doy = (153L * (m + (m > 2 ? -3 : 9)) + 2) / 5 + lt.tm_mday - 1, doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    double days = (double)(era * 146097 + doe - 719468);   /* días civiles desde 1970-01-01 (H. Hinnant) */
    return days * 86400.0 + lt.tm_hour * 3600.0 + lt.tm_min * 60.0 + lt.tm_sec;
}

/* Enlace con el servidor (relay /v1/robot, 2026-10-30): reemplaza al servidor HTTP y a la página del robot. Un hilo
 * conecta por TCP sin TLS; el cifrado es el de link.h (AES-256-GCM con la llave del enlace). Estado cada
 * F2_LINK_STATE_MS, la cola de avisos (outbox.h) y las órdenes y el pase nocturno de vuelta. */
#if defined(ALMA_DEV_RELAY_HOST) && defined(ALMA_DEV_LINK_KEY)
#ifndef ALMA_DEV_RELAY_PORT
#define ALMA_DEV_RELAY_PORT 80
#endif
#ifndef ALMA_DEV_ROBOT_ID
#define ALMA_DEV_ROBOT_ID "alma"
#endif
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

/* la app corre en el bucle principal: todo lo que la toca, con su candado */
static long st(char *o, size_t cap)
{
    xSemaphoreTake(f2_app_mutex, portMAX_DELAY);
    long n = api_state(o, cap);
    xSemaphoreGive(f2_app_mutex);
    return n;
}

static long take(char *o, size_t cap)
{
    xSemaphoreTake(f2_app_mutex, portMAX_DELAY);
    long n = api_link_take(o, cap);
    xSemaphoreGive(f2_app_mutex);
    return n;
}

static long on_msg(const char *j, char *reply, size_t cap)
{
    xSemaphoreTake(f2_app_mutex, portMAX_DELAY);
    long n = api_link_msg(j, reply, cap);
    xSemaphoreGive(f2_app_mutex);
    return n;
}

static uplink_cfg link_cfg = {.host = ALMA_DEV_RELAY_HOST, .path = "/v1/robot", .robot_id = ALMA_DEV_ROBOT_ID,
                              .port = ALMA_DEV_RELAY_PORT, .state_every_ms = F2_LINK_STATE_MS,
                              .state = st, .take = take, .on_msg = on_msg};

static void link_task(void *arg)
{
    (void)arg;
    const uplink_io io = {tx, rx, rnd, now_ms, NULL};
    int wait_s = F2_LINK_RETRY_MIN_S;
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
                xSemaphoreTake(f2_app_mutex, portMAX_DELAY);
                app_set_link(0);
                xSemaphoreGive(f2_app_mutex);
            }
            if (sk >= 0) close(sk);
            sk = -1;
        }
        if (ai) freeaddrinfo(ai);
        wait_s = authed ? F2_LINK_RETRY_MIN_S : wait_s * 2 > F2_LINK_RETRY_MAX_S ? F2_LINK_RETRY_MAX_S : wait_s * 2;
        hal_log("enlace: %s; reintento en %d s", why, wait_s);
        vTaskDelay(pdMS_TO_TICKS(wait_s * 1000));
    }
}

void f2_link_start(void)
{
    /* la llave y el servidor no se imprimen (credenciales) */
    if (link_key_hex(ALMA_DEV_LINK_KEY, link_cfg.key)) { hal_log("enlace: ALMA_DEV_LINK_KEY no son 64 caracteres hexadecimales; sin servidor"); return; }
    if (xTaskCreate(link_task, "enlace", F2_LINK_STACK, NULL, 4, NULL) != pdPASS) hal_log("enlace: no pude crear el hilo");
    else hal_log("enlace: hilo iniciado (servidor de alma_dev_creds.h)");
}
#else
void f2_link_start(void) { hal_log("enlace: sin ALMA_DEV_RELAY_HOST/ALMA_DEV_LINK_KEY en alma_dev_creds.h; sin servidor"); }
#endif
#endif
