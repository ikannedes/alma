/* ble_base.c — escucha los anuncios Bluetooth de la Home Station (dueño, 2026-11-05: "la home station se conecta por
 * bluetooth, así podría saber si está o no en la base"). Solo escucha: no se conecta, no aprovisiona ni manda nada, y no
 * toca la NVS de fábrica (R15; el original le habla por BLE Mesh con las claves de mesh_core, [BOBBY-ARTE] CASA.md §5).
 * La base se anuncia como proxy de BLE Mesh (servicio 0x1828, "ESP-BLE-MESH"; visto desde la PC a −47 dBm). Con
 * ALMA_DEV_HOME_BLE_MAC en alma_dev_creds.h solo cuenta esa dirección; sin ella, cualquier proxy Mesh (en casa solo está
 * la base). Escaneo pasivo con poco ciclo (50 ms cada 1 s) para no estorbar al Wi-Fi. */
#include <string.h>

#include "esp_bt.h"
#include "esp_coexist.h"
#include "esp_err.h"
#include "f2_hal.h"
#include "host/ble_gap.h"
#include "host/ble_hs.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"

#if __has_include("alma_dev_creds.h")
#include "alma_dev_creds.h"
#endif

#define MESH_PROXY_UUID 0x1828
#define SCAN_ITVL       1600   /* 1 s, en unidades de 0.625 ms */
#define SCAN_WINDOW     80     /* 50 ms */

static volatile int base_rssi = -127;
static volatile int64_t base_seen_ms = -1;
/* alma-base (firmware/base, 2026-11-06) anuncia su estado: datos del fabricante FF FF 'A' 'B' estado contador;
   estado bit 0 = EMO cargándose en ella (su GPIO39). La de fábrica no lo trae: entonces se queda en "no sé" */
static volatile int base_flags = -1;
static volatile int64_t base_flags_ms = -1;
/* Pong por Bluetooth (dueño, 2026-11-06: "quiero que el robot juegue literalmente… se pueden conectar por bluetooth"):
   durante una partida la base agrega al anuncio bx by vx vy pa pb sa sb; el robot anuncia su jugada y si pone música
   (FF FF 'A' 'R' seq dir banderas). Sin conexión: los dos solo se anuncian y se escuchan */
static hal_pong_t pong;
static volatile int64_t pong_ms = -1;
static uint8_t my_adv[7] = {0xFF, 0xFF, 'A', 'R', 0, 0, 0};
static int my_adv_on, fast;
static int started;

#ifdef ALMA_DEV_HOME_BLE_MAC
static const uint8_t WANT[6] = ALMA_DEV_HOME_BLE_MAC;   /* {0x62, 0x90, …}: el orden de NimBLE (al revés del texto) */
#endif

static void start_scan(void);

static int is_base(const struct ble_gap_disc_desc *d)
{
#ifdef ALMA_DEV_HOME_BLE_MAC
    if (memcmp(d->addr.val, WANT, 6) != 0) return 0;
#endif
    struct ble_hs_adv_fields f;
    if (ble_hs_adv_parse_fields(&f, d->data, d->length_data) != 0) return 0;
    for (int i = 0; i < f.num_uuids16; i++)
        if (ble_uuid_u16(&f.uuids16[i].u) == MESH_PROXY_UUID) return 1;
    if (f.svc_data_uuid16 && f.svc_data_uuid16_len >= 2 && (f.svc_data_uuid16[0] | f.svc_data_uuid16[1] << 8) == MESH_PROXY_UUID)
        return 1;
    return f.name && f.name_len == 12 && memcmp(f.name, "ESP-BLE-MESH", 12) == 0;
}

static int on_gap(struct ble_gap_event *ev, void *arg)
{
    (void)arg;
    if (ev->type == BLE_GAP_EVENT_DISC && is_base(&ev->disc)) {
        base_rssi = ev->disc.rssi;
        base_seen_ms = hal_now_ms();
        struct ble_hs_adv_fields f;
        if (ble_hs_adv_parse_fields(&f, ev->disc.data, ev->disc.length_data) == 0 && f.mfg_data && f.mfg_data_len >= 6 &&
            f.mfg_data[0] == 0xFF && f.mfg_data[1] == 0xFF && f.mfg_data[2] == 'A' && f.mfg_data[3] == 'B') {
            base_flags = f.mfg_data[4];
            base_flags_ms = base_seen_ms;
            if (f.mfg_data_len >= 14) {
                const uint8_t *m = f.mfg_data;
                pong = (hal_pong_t){m[6], m[7], (int8_t)m[8], (int8_t)m[9], m[10], m[11], m[12], m[13], m[5]};
                pong_ms = base_seen_ms;
            }
        }
    } else if (ev->type == BLE_GAP_EVENT_DISC_COMPLETE) {
        start_scan();
    }
    return 0;
}

static void start_scan(void)
{
    /* en una partida se escucha siempre (ventana = intervalo): la pelota cambia cada ~0.2 s */
    struct ble_gap_disc_params p = {.itvl = fast ? 48 : SCAN_ITVL, .window = fast ? 48 : SCAN_WINDOW, .passive = 1,
                                    .filter_duplicates = 0};
    int rc = ble_gap_disc(BLE_OWN_ADDR_PUBLIC, BLE_HS_FOREVER, &p, on_gap, NULL);
    if (rc != 0) hal_log("ble: no pude escuchar (%d)", rc);
}

static void on_sync(void)
{
    hal_log("ble: escuchando a la Home Station (pasivo, 50 ms cada 1 s)");
    start_scan();
}

static void host_task(void *arg)
{
    (void)arg;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void ble_base_start(void)
{
    if (started) return;
    esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);   /* solo BLE: la memoria del Bluetooth clásico vuelve al heap */
    esp_err_t e = nimble_port_init();
    if (e != ESP_OK) { hal_log("ble: no arrancó (%d); sin Home Station por Bluetooth", e); return; }
    started = 1;
    ble_hs_cfg.sync_cb = on_sync;
    nimble_port_freertos_init(host_task);
}

int hal_home_ble(int *rssi, int64_t *age_ms)
{
    int64_t t = base_seen_ms;
    if (t < 0) return 0;
    if (rssi) *rssi = base_rssi;
    if (age_ms) *age_ms = hal_now_ms() - t;
    return 1;
}

int hal_home_ble_charging(void)
{
    int64_t t = base_flags_ms;
    if (t < 0 || hal_now_ms() - t > HOME_BLE_FLAGS_MS) return -1;
    return base_flags & 1;
}

int hal_home_pong(hal_pong_t *p, int64_t *age_ms)
{
    int64_t t = pong_ms;
    if (t < 0) return 0;
    *p = pong;
    if (age_ms) *age_ms = hal_now_ms() - t;
    return 1;
}

void hal_ble_fast(int on)
{
    if (!started || fast == !!on) return;
    fast = !!on;
    /* en la partida la radio prefiere al Bluetooth: el Wi-Fi y el Bluetooth se turnan la misma antena */
    esp_coex_preference_set(fast ? ESP_COEX_PREFER_BT : ESP_COEX_PREFER_BALANCE);
    ble_gap_disc_cancel();   /* DISC_COMPLETE no llega al cancelar: se vuelve a empezar aquí con la ventana nueva */
    start_scan();
}

static void advertise_mine(void)
{
    struct ble_hs_adv_fields f = {0};
    f.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    f.mfg_data = my_adv;
    f.mfg_data_len = sizeof my_adv;
    if (ble_gap_adv_active()) ble_gap_adv_stop();
    struct ble_gap_adv_params p = {.conn_mode = BLE_GAP_CONN_MODE_NON, .disc_mode = BLE_GAP_DISC_MODE_GEN,
                                   .itvl_min = 48, .itvl_max = 48};   /* 30 ms: la base escucha a ratos */
    int rc = ble_gap_adv_set_fields(&f);
    if (!rc) rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, NULL, BLE_HS_FOREVER, &p, NULL, NULL);
    if (rc) hal_log("ble: no pude anunciarme (%d)", rc);
}

void hal_ble_to_base(int dir, int flags)
{
    if (!started) return;
    if (!flags) {   /* nada que decirle: callado */
        if (my_adv_on) ble_gap_adv_stop();
        my_adv_on = 0;
        return;
    }
    if (my_adv_on && (int8_t)my_adv[5] == dir && my_adv[6] == flags) return;
    my_adv[4]++;
    my_adv[5] = (uint8_t)(int8_t)dir;
    my_adv[6] = (uint8_t)flags;
    my_adv_on = 1;
    advertise_mine();
}
