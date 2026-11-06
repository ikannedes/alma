/* leds.c — la matriz de 12 x 8 WS2812 por SPI, como el firmware de fábrica: GPIO5 (MOSI de SPI2), 3.2 MHz, cada bit
 * del LED son 4 bits SPI (0 = 1000, 1 = 1100), bytes R, G, B en orden fila*12 + col. Brillo con tope LEDS_TOPE (96 en
 * blanco a 255 pedirían ~5 A del cargador). Las animaciones vienen embebidas (alma_base.alb, tools/base_leds/matriz.py:
 * "ALB1" | u16 n | n x {nombre[16], u16 cuadros, u8 repetir, u8 0, u32 offset} | cuadros {u16 ms, 288 bytes}). */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "driver/spi_master.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "base.h"
#include "desgaste.h"
#include "f2_hal.h"

#define N_LEDS     96
#define FRAME      (N_LEDS * 3)
#define LEDS_TOPE  80
#define SPI_BYTES  (N_LEDS * 12 + 24)   /* + 60 µs en bajo: el reinicio de los WS2812 */

extern const uint8_t alb_start[] asm("_binary_alma_base_alb_start");
extern const uint8_t alb_end[] asm("_binary_alma_base_alb_end");

static spi_device_handle_t dev;
static uint8_t *spi_buf;   /* DMA */
static volatile int want = -1, stop;   /* la animación pedida (índice), o −1 */
static int playing = -1;
/* Compensación del desgaste (desgaste.h; dueño, 2026-11-06: "se ve un poco amarilla la casa"): a los LEDs que mostraron
   la casita de fábrica se les sube cada canal según cuánto trabajó: +comp % con desgaste máximo, en curva
   (uso/255)^(curva/100): el desgaste crece más rápido que el uso (con la recta, los de abajo, a 159, quedaban azules).
   Se afina con la orden "comp" del servidor mirando una foto en blanco */
static float gain[288];   /* multiplicador de cada canal de cada LED */
static int comp_r = 0, comp_g = 0, comp_b = 170, comp_e = 250;   /* afinado con fotos del dueño, 2026-11-06 */

static int clampi(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

void leds_comp(int r, int g, int b, int e)
{
    comp_r = clampi(r, 0, 300), comp_g = clampi(g, 0, 300), comp_b = clampi(b, 0, 300), comp_e = clampi(e, 50, 400);
    const int pct[3] = {comp_r, comp_g, comp_b};
    for (int i = 0; i < 288; i++)
        gain[i] = 1.0f + (DESGASTE[i] ? powf(DESGASTE[i] / 255.0f, comp_e / 100.0f) * pct[i % 3] / 100.0f : 0.0f);
    hal_log("leds: compensación del desgaste R %d %% G %d %% B %d %%, curva %d", comp_r, comp_g, comp_b, comp_e);
}

static uint16_t u16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }
static uint32_t u32(const uint8_t *p) { return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24; }

int leds_count(void)
{
    return alb_end - alb_start > 6 && !memcmp(alb_start, "ALB1", 4) ? u16(alb_start + 4) : 0;
}

static const uint8_t *entry(int i) { return alb_start + 6 + 24 * i; }
const char *leds_name(int i) { return (const char *)entry(i); }   /* nombre[16] con 0 al final (matriz.py) */
const char *leds_playing(void) { return playing >= 0 ? leds_name(playing) : ""; }

static void show(const uint8_t *rgb)
{
    static const uint8_t NIB[4] = {0x88, 0x8C, 0xC8, 0xCC};   /* dos bits del LED → un byte SPI */
    uint8_t *o = spi_buf;
    for (int i = 0; i < FRAME; i++) {
        float f = rgb[i] * (LEDS_TOPE / 255.0f) * gain[i];
        uint8_t v = f >= 255.0f ? 255 : (uint8_t)(f + 0.5f);
        for (int s = 6; s >= 0; s -= 2) *o++ = NIB[(v >> s) & 3];
    }
    memset(o, 0, 24);
    spi_transaction_t t = {.length = SPI_BYTES * 8, .tx_buffer = spi_buf};
    spi_device_transmit(dev, &t);
}

static const uint8_t black[FRAME];
#define WANT_OFF (-2)   /* solo el hilo de las luces habla con el SPI: apagar también se le pide */
static uint8_t live[FRAME];   /* el cuadro en vivo (pong.c): lo muestra el hilo de las luces */
static volatile int live_dirty;

void leds_live(const uint8_t *rgb)
{
    memcpy(live, rgb, FRAME);
    stop = 1;   /* la animación que hubiera se detiene */
    want = -1;
    live_dirty = 1;
}

void leds_off(void)
{
    stop = 1;
    want = WANT_OFF;
}

int leds_anim(const char *name)
{
    for (int i = 0; i < leds_count(); i++)
        if (!strncmp(leds_name(i), name, 16)) {
            stop = 0;
            want = i;
            return 0;
        }
    return -1;
}

static void anim_task(void *arg)
{
    (void)arg;
    for (;;) {
        int i = want;
        if (i == WANT_OFF) { want = -1; live_dirty = 0; show(black); continue; }
        if (i < 0 && live_dirty) { live_dirty = 0; show(live); continue; }
        if (i < 0) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
        want = -1;
        playing = i;
        const uint8_t *e = entry(i);
        int n = u16(e + 16), rep = e[18];
        const uint8_t *f0 = alb_start + u32(e + 20);
        hal_log("leds: %s (%d cuadros%s)", leds_name(i), n, rep ? ", en bucle" : "");
        do {
            for (int k = 0; k < n && !stop && want < 0; k++) {
                const uint8_t *f = f0 + k * (2 + FRAME);
                show(f + 2);
                vTaskDelay(pdMS_TO_TICKS(u16(f)));
            }
        } while (rep && !stop && want < 0);
        if (want < 0 && !stop) show(black);   /* terminó sola: se apaga */
        playing = -1;
    }
}

void leds_init(void)
{
    spi_bus_config_t bus = {.mosi_io_num = PIN_LEDS, .miso_io_num = -1, .sclk_io_num = -1, .quadwp_io_num = -1,
                            .quadhd_io_num = -1, .max_transfer_sz = SPI_BYTES};
    spi_device_interface_config_t d = {.clock_speed_hz = 3200000, .mode = 0, .spics_io_num = -1, .queue_size = 1};
    spi_buf = heap_caps_malloc(SPI_BYTES, MALLOC_CAP_DMA);
    if (!spi_buf || spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO) != ESP_OK ||
        spi_bus_add_device(SPI2_HOST, &d, &dev) != ESP_OK) {
        hal_log("leds: no arrancó el SPI; sin luces");
        return;
    }
    leds_comp(comp_r, comp_g, comp_b, comp_e);
    show(black);   /* lo que dejó el firmware anterior se borra */
    xTaskCreate(anim_task, "leds", 3072, NULL, 3, NULL);
    hal_log("leds: matriz 12x8 en GPIO%d, tope %d, %d animaciones", PIN_LEDS, LEDS_TOPE, leds_count());
}
