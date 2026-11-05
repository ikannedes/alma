/* ble_base.c — escucha los anuncios Bluetooth de la Home Station (dueño, 2026-11-05: "la home station se conecta por
 * bluetooth, así podría saber si está o no en la base"). Solo escucha: no se conecta, no aprovisiona ni manda nada, y no
 * toca la NVS de fábrica (R15; el original le habla por BLE Mesh con las claves de mesh_core, [BOBBY-ARTE] CASA.md §5).
 * La base se anuncia como proxy de BLE Mesh (servicio 0x1828, "ESP-BLE-MESH"; visto desde la PC a −47 dBm). Con
 * ALMA_DEV_HOME_BLE_MAC en alma_dev_creds.h solo cuenta esa dirección; sin ella, cualquier proxy Mesh (en casa solo está
 * la base). Escaneo pasivo con poco ciclo (50 ms cada 1 s) para no estorbar al Wi-Fi. */
#include <string.h>

#include "esp_bt.h"
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
    } else if (ev->type == BLE_GAP_EVENT_DISC_COMPLETE) {
        start_scan();
    }
    return 0;
}

static void start_scan(void)
{
    struct ble_gap_disc_params p = {.itvl = SCAN_ITVL, .window = SCAN_WINDOW, .passive = 1, .filter_duplicates = 0};
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
