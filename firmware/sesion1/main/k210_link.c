#include "k210_link.h"

#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "log_util.h"

#define K210_UART   UART_NUM_1
#define K210_TX     12
#define K210_RX     4
#define K210_RESETN 22
#define K210_BAUD   1000000
#define GAP_MS      20      /* 03: entre frames sin tiempo conocido */
#define SILENCE_MS  50      /* lo que quede a medias tras este silencio se registra como INCOMPLETO */
#define READY_WAIT_MS 5000

static k210_parser parser;
static volatile int64_t ready_ms = -1;   /* última vez que llegó 55 AA 47 */
static volatile uint32_t rx_frames, rx_dropped;

static void on_rx(void *u, k210_rx_kind k, const uint8_t *p, size_t n, int flags)
{
    (void)u;
    static const char *const KIND[] = {"CORTO", "EXTENDIDO", "BASURA", "INCOMPLETO"};
    if (k == K210_RX_SMALL && p[2] == 0x47) ready_ms = now_ms();
    rx_frames++;
    log_lock();
    log_ts();
    printf("RX %s n=%u:", KIND[k], (unsigned)n);
    log_hex(p, n);
    if (k == K210_RX_EXT) {
        printf("  [sel %02x, payload_cs %s] \"", p[5],
               flags & K210_EXT_CRC8_OK ? "CRC-8" : flags & K210_EXT_SUM_OK ? "suma" : "NINGUNO");
        for (size_t i = 7; i + 1 < n; i++) putchar(p[i] >= 0x20 && p[i] < 0x7F ? p[i] : '.');
        putchar('"');
    }
    printf("\n");
    log_unlock();
}

static void rx_task(void *arg)
{
    (void)arg;
    uint8_t buf[256];
    int64_t last = 0;
    for (;;) {
        int n = uart_read_bytes(K210_UART, buf, sizeof buf, pdMS_TO_TICKS(10));
        if (n > 0) {
            k210_parser_feed(&parser, buf, (size_t)n);
            last = now_ms();
        } else if (parser.n && now_ms() - last > SILENCE_MS) {
            k210_parser_flush(&parser);
        }
        size_t pending = 0;
        uart_get_buffered_data_len(K210_UART, &pending);
        if (pending > 3500) rx_dropped++;   /* casi lleno: la consola a 115200 no da abasto */
    }
}

void k210_link_init(void)
{
    gpio_config_t io = {.pin_bit_mask = 1ULL << K210_RESETN, .mode = GPIO_MODE_OUTPUT};
    ESP_ERROR_CHECK(gpio_config(&io));
    gpio_set_level(K210_RESETN, 1);      /* activo en bajo: en alto no resetea */

    uart_config_t c = {
        .baud_rate = K210_BAUD, .data_bits = UART_DATA_8_BITS, .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1, .flow_ctrl = UART_HW_FLOWCTRL_DISABLE, .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_driver_install(K210_UART, 4096, 0, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(K210_UART, &c));
    ESP_ERROR_CHECK(uart_set_pin(K210_UART, K210_TX, K210_RX, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
    k210_parser_init(&parser, on_rx, NULL);
    xTaskCreate(rx_task, "k210_rx", 4096, NULL, 10, NULL);
}

void k210_send(const uint8_t *frame, size_t n, const char *what)
{
    log_lock();
    log_ts();
    printf("TX %s n=%u:", what, (unsigned)n);
    log_hex(frame, n);
    printf("\n");
    log_unlock();
    uart_write_bytes(K210_UART, frame, n);
    uart_wait_tx_done(K210_UART, pdMS_TO_TICKS(100));
}

void k210_send_small(uint8_t cmd, uint8_t d0, uint8_t d1, uint8_t d2)
{
    uint8_t f[K210_SMALL_LEN];
    char what[16];
    snprintf(what, sizeof what, "corto %02x", cmd);
    k210_send(f, k210_small(f, cmd, d0, d1, d2), what);
}

void k210_send_ext(uint8_t sel, const char *payload, k210_cs_mode m)
{
    static uint8_t f[K210_FRAME_MAX];
    size_t n = k210_ext(f, sizeof f, sel, payload, m);
    if (!n) { log_line("ERROR: payload demasiado largo"); return; }
    k210_send(f, n, m == K210_CS_CRC8 ? "extendido (CRC-8)" : "extendido (suma)");
}

void k210_play(const char *avi, const char *mp3_or_null, int mode, k210_cs_mode m)
{
    char p[192];
    if (k210_anim_payload(p, sizeof p, avi, mp3_or_null, mode)) k210_send_ext(0x02, p, m);
}

static void ms(int t) { vTaskDelay(pdMS_TO_TICKS(t)); }

static void resetn_pulse(int low_ms)
{
    log_line("RESETN (GPIO22) en bajo %d ms", low_ms);
    gpio_set_level(K210_RESETN, 0);
    esp_rom_delay_us((uint32_t)low_ms * 1000);
    gpio_set_level(K210_RESETN, 1);
}

/* Secuencia capturada de 03, desde los 0x69. Tiempos: [SAM-SPI] 150 ms entre los 0x69 y 100 ms alrededor de
   profile.json y antes de boot_start; 20 ms en el resto. */
static void boot_commands(void)
{
    for (int i = 0; i < 3; i++) { ms(150); k210_send_small(0x69, 1, 0, 0); }
    ms(GAP_MS); k210_send_small(0x2C, 0, 0, 0);
    ms(100); k210_send_ext(0x03, "/spiffs/json/profile.json", K210_CS_CRC8);
    ms(100); k210_send_small(0x2D, 0, 0, 0);
    ms(GAP_MS); k210_send_small(0x70, 0, 0, 0);
    ms(GAP_MS); k210_send_small(0x38, 1, 0, 0);
    ms(GAP_MS); k210_send_small(0x06, 1, 0, 0);
    ms(GAP_MS); k210_send_small(0x17, 0x68, 0, 0);
    ms(GAP_MS); k210_send_small(0x6A, 0x46, 0, 0);
    ms(GAP_MS); k210_send_small(0x6C, 0, 0, 0);
    ms(GAP_MS); k210_send_small(0x74, 0, 0, 0);
    ms(100); k210_play("boot_start", "boot_start_000", 0, K210_CS_CRC8);
}

static bool wait_ready(int64_t since_ms)
{
    int64_t until = now_ms() + READY_WAIT_MS;
    while (now_ms() < until) {
        if (ready_ms >= since_ms) return true;
        ms(20);
    }
    return ready_ms >= since_ms;
}

bool k210_boot_sam(void)
{
    log_line("== k210_boot [SAM-SPI]: RESETN 1 ms, 3500 ms, 0x34, secuencia, esperar 0x47 hasta 5 s ==");
    int64_t t0 = now_ms();
    resetn_pulse(1);
    ms(3500);
    k210_send_small(0x34, 0, 0, 0);
    boot_commands();
    return wait_ready(t0);
}

bool k210_boot_el(void)
{
    log_line("== k210_boot [EL-GPIO]: 0x34, 500 ms, RESETN 1 ms, secuencia, esperar 0x47 hasta 5 s ==");
    int64_t t0 = now_ms();
    k210_send_small(0x34, 0, 0, 0);
    ms(500);
    resetn_pulse(1);   /* GPIO23 ya está en alto desde el arranque (R13) */
    boot_commands();
    return wait_ready(t0);
}

const char *k210_boot(void)
{
    if (k210_boot_sam()) return "SAM-SPI";
    log_line("No llegó 0x47 con [SAM-SPI]; pruebo [EL-GPIO]");
    if (k210_boot_el()) return "EL-GPIO";
    return NULL;
}

uint32_t k210_rx_frames(void) { return rx_frames; }
uint32_t k210_rx_dropped(void) { return rx_dropped; }
