/* alma-base v1 (dueño, 2026-11-06): el firmware de Alma para la Home Station. Lo mínimo para no volver a necesitar el
 * FTDI: Wi-Fi (el que la base ya tenía), enlace con el servidor (/v1/robot, id "base"), registro por Wi-Fi y firmware nuevo por
 * Wi-Fi con arranque a prueba (ota.h). Además: lee si EMO está cargando (GPIO39) y el botón táctil, se lo anuncia al
 * robot por Bluetooth y al servidor, y tiene las animaciones de Alma (se prenden solo cuando se piden: la calibración de
 * los LEDs va después de probar la OTA). La carga la hace el IP6806 solo; nada de aquí la toca. */
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "driver/gpio.h"
#include "driver/touch_pad.h"
#include "esp_app_desc.h"
#include "esp_heap_caps.h"
#include "esp_rom_gpio.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "soc/gpio_struct.h"

#include "base.h"
#include "f2_hal.h"
#include "ota.h"
#include "outbox.h"
#include "rlog.h"

long hal_rlog_take(char *out, size_t cap);

/* GPIO12 (amplificador) es pin de arranque: en 0 lo antes posible, como el firmware de fábrica */
__attribute__((constructor(101))) static void amp_off_early(void)
{
    esp_rom_gpio_pad_select_gpio(PIN_AMP);
    GPIO.out_w1tc = 1u << PIN_AMP;
    GPIO.enable_w1ts = 1u << PIN_AMP;
}

static SemaphoreHandle_t mx;   /* la OTA: el enlace (mensajes) y el bucle (prueba que vence) */
static int carga = -1, toques, link_up;
static int64_t toque_t = -1000000;

long base_state(char *out, size_t cap)
{
    return snprintf(out, cap, "{\"t\":\"state\",\"carga\":%d,\"toques\":%d,\"anim\":\"%s\",\"ip\":\"%s\",\"heap\":%u,"
                    "\"heap_min\":%u,\"ver\":\"%s\",\"part\":\"%s\",\"s\":%lld}",
                    carga, toques, leds_playing(), red_ip(), (unsigned)esp_get_free_heap_size(),
                    (unsigned)esp_get_minimum_free_heap_size(), esp_app_get_description()->version,
                    hal_ota_running_label(), (long long)(hal_now_ms() / 1000));
}

long base_take(char *out, size_t cap)
{
    long n = outbox_take(out, cap);
    return n > 0 ? n : hal_rlog_take(out, cap);
}

/* la red local: el robot manda {"t":"robot","c":columna,"f":banderas} (bit 0 jugando Pong, bit 1 música) */
void base_lan_msg(const char *json, const struct lan_peer_s *from)
{
    (void)from;
    cJSON *j = cJSON_Parse(json);
    const cJSON *t = cJSON_GetObjectItemCaseSensitive(j, "t"), *c = cJSON_GetObjectItemCaseSensitive(j, "c"),
                *f = cJSON_GetObjectItemCaseSensitive(j, "f");
    if (cJSON_IsString(t) && !strcmp(t->valuestring, "robot") && cJSON_IsNumber(c) && cJSON_IsNumber(f)) {
        if (f->valueint & 1) pong_mover(c->valueint);
        musica_lan((f->valueint & 2) != 0);
    }
    cJSON_Delete(j);
}

void base_link(int up)
{
    xSemaphoreTake(mx, portMAX_DELAY);
    link_up = up;
    ota_link(up);
    xSemaphoreGive(mx);
}

long base_msg(const char *json, char *reply, size_t cap)
{
    cJSON *j = cJSON_Parse(json);
    const cJSON *t = cJSON_GetObjectItemCaseSensitive(j, "t");
    long n = 0;
    if (cJSON_IsString(t)) {
        const char *ty = t->valuestring;
        xSemaphoreTake(mx, portMAX_DELAY);
        if (!strcmp(ty, "welcome")) {
            if (!link_up) hal_log("enlace: conectada al servidor");
            link_up = 1;
            ota_link(1);
            ota_welcome();
        } else if (!strncmp(ty, "ota", 3)) {
            n = ota_msg(ty, json, reply, cap);
        }
        xSemaphoreGive(mx);
        if (!strcmp(ty, "pong")) {
            if (pong_start()) hal_log("pong: ya estaba jugando");
        } else if (!strcmp(ty, "pong_stop")) {
            pong_stop();
            leds_off();
        } else if (!strcmp(ty, "musica")) {   /* prueba del analizador desde el servidor: 1 = 20 s */
            musica_prueba();
        } else if (!strcmp(ty, "pong_mover")) {
            const cJSON *d = cJSON_GetObjectItemCaseSensitive(j, "d");
            if (cJSON_IsNumber(d)) pong_mover(d->valueint);
        } else if (!strcmp(ty, "anim")) {
            pong_stop();
            const cJSON *nm = cJSON_GetObjectItemCaseSensitive(j, "n");
            if (!cJSON_IsString(nm) || leds_anim(nm->valuestring)) hal_log("leds: no tengo la animación pedida");
        } else if (!strcmp(ty, "leds_off")) {
            pong_stop();
            leds_off();
        } else if (!strcmp(ty, "comp")) {
            const cJSON *r = cJSON_GetObjectItemCaseSensitive(j, "r"), *g = cJSON_GetObjectItemCaseSensitive(j, "g"),
                        *b = cJSON_GetObjectItemCaseSensitive(j, "b");
            const cJSON *e = cJSON_GetObjectItemCaseSensitive(j, "e");
            if (cJSON_IsNumber(r) && cJSON_IsNumber(g) && cJSON_IsNumber(b))
                leds_comp(r->valueint, g->valueint, b->valueint, cJSON_IsNumber(e) ? e->valueint : 250);
        } else if (!strcmp(ty, "anims")) {
            for (int i = 0; i < leds_count(); i++) hal_log("leds: animación %d: %s", i, leds_name(i));
        }
    }
    cJSON_Delete(j);
    return n;
}

/* ---- sensores: carga (GPIO39) y botón táctil (touch pad 7) ---- */
static uint16_t touch_base;

static void sensors_init(void)
{
    gpio_config_t c = {.pin_bit_mask = 1ULL << PIN_CARGA, .mode = GPIO_MODE_INPUT};
    gpio_config(&c);
    touch_pad_init();
    touch_pad_set_voltage(TOUCH_HVOLT_2V7, TOUCH_LVOLT_0V5, TOUCH_HVOLT_ATTEN_1V);   /* como el de fábrica */
    touch_pad_config(TOUCH_PAD, 0);
    touch_pad_filter_start(10);
    vTaskDelay(pdMS_TO_TICKS(100));
    uint32_t s = 0;
    for (int i = 0; i < 10; i++) {
        uint16_t v = 0;
        touch_pad_read_filtered(TOUCH_PAD, &v);
        s += v;
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    touch_base = (uint16_t)(s / 10);
    hal_log("toque: base del sensor %u", touch_base);
}

static void sensors_step(int64_t now)
{
    static int last = -1, same;
    int c = gpio_get_level(PIN_CARGA);
    same = c == last ? same + 1 : 0;
    last = c;
    if (same == 10 && c != carga) {   /* 10 lecturas iguales (200 ms) */
        carga = c;
        hal_log("carga: %s", c ? "EMO se está cargando" : "EMO no se está cargando");
        char e[24];
        snprintf(e, sizeof e, ",\"on\":%d", c);
        outbox_event("carga", e);
    }
    static int touching, held;
    uint16_t v = 0;
    touch_pad_read_filtered(TOUCH_PAD, &v);
    int now_touch = v + 50 < touch_base;   /* el de fábrica: 50 por debajo de la base */
    if (!now_touch && !touching) touch_base = (uint16_t)((touch_base * 49u + v) / 50u);   /* la base se mueve lento */
    if (now_touch && !touching) held = 0;
    if (now_touch) held++;
    if (!now_touch && touching) {
        toques++;
        toque_t = now;
        hal_log("toque: %s (%d ms)", held >= 50 ? "largo" : "corto", held * 20);
        outbox_event("toque", held >= 50 ? ",\"largo\":1" : ",\"largo\":0");
        if (held >= 50 && !pong_running()) pong_start();   /* toque largo: a jugar */
    }
    touching = now_touch;
    anuncio_estado((uint8_t)((carga == 1) | (now - toque_t < 3000) << 1));
}

void app_main(void)
{
    mx = xSemaphoreCreateMutex();
    rlog_set(1);
    const esp_app_desc_t *d = esp_app_get_description();
    hal_log("alma-base %s (%s %s) en %s", d->version, d->date, d->time, hal_ota_running_label());
    ota_init();
    leds_init();
    sensors_init();
    anuncio_start();
    red_start();
    red_link_start();
    for (;;) {
        int64_t now = hal_now_ms();
        sensors_step(now);
        musica_step(now);
        xSemaphoreTake(mx, portMAX_DELAY);
        ota_step(now);
        xSemaphoreGive(mx);
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}
