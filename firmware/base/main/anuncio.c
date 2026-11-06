/* anuncio.c — el Bluetooth de la base, sin conexiones: se anuncia y escucha.
 *
 * Se anuncia: el robot la reconoce por su dirección pública (la de fábrica, ALMA_DEV_HOME_BLE_MAC del robot) y por el
 * servicio Mesh 0x1828, mide qué tan cerca está y lee el estado (dueño, 2026-11-06: "aprovecha el GPIO39 para avisarle
 * a emo que ya está cargando, que lo sepa al 100 %"). Datos del fabricante: FF FF 'A' 'B' estado contador, y durante
 * una partida de Pong además bx by vx vy pa pb sa sb (pong.c; el robot juega con eso: "quiero que el robot juegue
 * literalmente… se pueden conectar por bluetooth"). Estado: bit 0 = EMO cargando, bit 1 = toque reciente.
 *
 * Escucha: el anuncio del robot, FF FF 'A' 'R' seq jugada banderas (f2/main/ble_base.c): la jugada de Alma en el Pong
 * y si está poniendo música (bit 1: el analizador, musica.c). A ratos (30 ms cada 200 ms) y siempre durante una partida. */
#include <string.h>

#include "esp_bt.h"
#include "esp_coexist.h"
#include "host/ble_hs.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"

#include "base.h"
#include "f2_hal.h"

#define ADV_ITVL 160   /* x 0.625 ms = 100 ms: el robot escucha 50 ms cada segundo (siempre, en una partida) */

static uint8_t mfg[14] = {0xFF, 0xFF, 'A', 'B', 0, 0};
static int mfg_len = 6, ready, fast;
static volatile int robot_seq = -1, robot_dir, robot_flags;
static volatile int64_t robot_ms = -1;

static void advertise(void)
{
    struct ble_hs_adv_fields f = {0};
    f.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    if (mfg_len == 6) {   /* con los datos del Pong no cabe el nombre (31 bytes) */
        f.name = (const uint8_t *)"alma-base";
        f.name_len = 9;
        f.name_is_complete = 1;
    }
    static const ble_uuid16_t mesh = BLE_UUID16_INIT(0x1828);   /* el robot (ble_base.c) reconoce a la base como proxy de
                                                                  BLE Mesh, como era la de fábrica; sin esto la descarta */
    f.uuids16 = &mesh;
    f.num_uuids16 = 1;
    f.uuids16_is_complete = 1;
    f.mfg_data = mfg;
    f.mfg_data_len = (uint8_t)mfg_len;
    if (ble_gap_adv_active()) ble_gap_adv_stop();
    int rc = ble_gap_adv_set_fields(&f);
    struct ble_gap_adv_params p = {.conn_mode = BLE_GAP_CONN_MODE_NON, .disc_mode = BLE_GAP_DISC_MODE_GEN,
                                   .itvl_min = ADV_ITVL, .itvl_max = ADV_ITVL};
    if (!rc) rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, NULL, BLE_HS_FOREVER, &p, NULL, NULL);
    if (rc) hal_log("ble: no pude anunciarme (%d)", rc);
}

static void start_scan(void);

static int on_gap(struct ble_gap_event *ev, void *arg)
{
    (void)arg;
    if (ev->type == BLE_GAP_EVENT_DISC) {
        struct ble_hs_adv_fields f;
        if (ble_hs_adv_parse_fields(&f, ev->disc.data, ev->disc.length_data) == 0 && f.mfg_data && f.mfg_data_len >= 7 &&
            f.mfg_data[0] == 0xFF && f.mfg_data[1] == 0xFF && f.mfg_data[2] == 'A' && f.mfg_data[3] == 'R') {
            robot_flags = f.mfg_data[6];
            robot_ms = hal_now_ms();
            robot_seq = f.mfg_data[4];
            robot_dir = (int8_t)f.mfg_data[5];
            if (robot_flags & 1) pong_mover(robot_dir);   /* cada anuncio: la columna de Alma y que sigue ahí */
        }
    } else if (ev->type == BLE_GAP_EVENT_DISC_COMPLETE) {
        start_scan();
    }
    return 0;
}

static void start_scan(void)
{
    struct ble_gap_disc_params p = {.itvl = fast ? 48 : 320, .window = 48, .passive = 1, .filter_duplicates = 0};
    int rc = ble_gap_disc(BLE_OWN_ADDR_PUBLIC, BLE_HS_FOREVER, &p, on_gap, NULL);
    if (rc) hal_log("ble: no pude escuchar (%d)", rc);
}

static void on_sync(void)
{
    ready = 1;
    uint8_t a[6];
    if (ble_hs_id_copy_addr(BLE_ADDR_PUBLIC, a, NULL) == 0)
        hal_log("ble: anunciándome como %02x:%02x:%02x:%02x:%02x:%02x", a[5], a[4], a[3], a[2], a[1], a[0]);
    advertise();
    start_scan();
}

static void host_task(void *arg)
{
    (void)arg;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

void anuncio_start(void)
{
    esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);
    if (nimble_port_init() != ESP_OK) { hal_log("ble: no arrancó; el robot no me verá por Bluetooth"); return; }
    ble_hs_cfg.sync_cb = on_sync;
    nimble_port_freertos_init(host_task);
}

void anuncio_estado(uint8_t estado)
{
    if (mfg[4] == estado) return;
    mfg[4] = estado;
    mfg[5]++;
    if (ready) advertise();
}

void anuncio_pong(const uint8_t st[8])
{
    if (st) memcpy(mfg + 6, st, 8);
    int len = st ? 14 : 6;
    if (!st && mfg_len == 6) return;
    int same = len == mfg_len;
    mfg_len = len;
    mfg[5]++;
    if (!ready) return;
    if (same && ble_gap_adv_active()) {   /* solo los datos: sin detener el anuncio (cada reinicio dejaba un hueco) */
        struct ble_hs_adv_fields f = {0};
        static const ble_uuid16_t mesh = BLE_UUID16_INIT(0x1828);
        f.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
        f.uuids16 = &mesh;
        f.num_uuids16 = 1;
        f.uuids16_is_complete = 1;
        f.mfg_data = mfg;
        f.mfg_data_len = (uint8_t)mfg_len;
        if (ble_gap_adv_set_fields(&f) != 0) advertise();
    } else {
        advertise();
    }
    if (fast != !!st) {   /* en la partida se escucha siempre y la radio prefiere al Bluetooth sobre el Wi-Fi */
        fast = !!st;
        esp_coex_preference_set(fast ? ESP_COEX_PREFER_BT : ESP_COEX_PREFER_BALANCE);
        ble_gap_disc_cancel();
        start_scan();
    }
}

int anuncio_robot(int *flags, int64_t *age_ms)
{
    int64_t t = robot_ms;
    if (t < 0) return 0;
    if (flags) *flags = robot_flags;
    if (age_ms) *age_ms = hal_now_ms() - t;
    return 1;
}
