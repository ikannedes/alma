/* hal_esp32.c — f2_hal.h en el ESP32. Lo que 02 deja PENDIENTE está aislado aquí y marcado "// PENDIENTE: 02";
 * alma/firmware/f2/PENDIENTES.md dice con qué resultado de la sesión 1 se llena cada hueco. */
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "driver/adc.h"           /* driver ADC heredado, como sesion1 */
#include "driver/gpio.h"
#include "driver/i2c.h"            /* driver heredado, como sesion1 */
#include "driver/spi_master.h"
#include "driver/touch_pad.h"
#include "vl53l0x.h"
#include "driver/uart.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_heap_caps.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"

#include "battery.h"
#include "sense.h"
#include "f2_config.h"
#include "f2_hal.h"
#include "hal_esp32.h"
#include "hal_k210.h"
#include "log_util.h"
#include "rlog.h"
#include "motion_player.h"

/* ---- reloj y registro (log_util de sesion1: [segundos.ms] y un mutex para no mezclar líneas) ---- */
int64_t hal_now_ms(void) { return esp_timer_get_time() / 1000; }

void hal_log(const char *fmt, ...)
{
    static char line[640];   /* bajo el mutex del registro */
    va_list ap;
    va_start(ap, fmt);
    log_lock();
    log_ts();
    if (rlog_on()) {   /* también por Wi-Fi (rlog.h) */
        int o = snprintf(line, sizeof line, "[%10.3f] ", hal_now_ms() / 1000.0);
        vsnprintf(line + o, sizeof line - (size_t)o, fmt, ap);
        printf("%s\n", line + o);
        rlog_push(line);
    } else {
        vprintf(fmt, ap);
        printf("\n");
    }
    log_unlock();
    va_end(ap);
}

void *hal_big_alloc(size_t n) { return heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); }
void hal_big_free(void *p) { heap_caps_free(p); }
size_t hal_big_largest(void) { return heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); }

/* ---- firmware nuevo por Wi-Fi (ota.h). El bootloader es el de fábrica (sin rollback): la prueba del arranque nuevo
   la lleva la app, con la partición anterior en RAM RTC (sobrevive a esp_restart, no a un apagón). Nada en NVS ---- */
#if ALMA_F2_API
#include "mbedtls/sha256.h"
#endif
#define OTA_TRIAL_MAGIC 0xA1A0F2A7u
static RTC_NOINIT_ATTR uint32_t ota_trial_magic, ota_trial_prev;
#define KEEP_MAGIC 0x4B33A11Au
static RTC_NOINIT_ATTR uint32_t keep_magic, keep_val;
unsigned hal_keep_get(void) { return keep_magic == KEEP_MAGIC ? keep_val : 0; }
void hal_keep_set(unsigned v) { keep_val = v; keep_magic = KEEP_MAGIC; }
static esp_ota_handle_t ota_h;
static const esp_partition_t *ota_part, *ota_done;
static size_t ota_size;

int hal_ota_begin(size_t size)
{
    hal_ota_abort();
    ota_done = NULL;
    const esp_partition_t *p = esp_ota_get_next_update_partition(NULL);
    if (!p || size > p->size) return -1;
    if (esp_ota_begin(p, OTA_WITH_SEQUENTIAL_WRITES, &ota_h) != ESP_OK) return -1;   /* borra a medida que escribe */
    ota_part = p;
    ota_size = size;
    return 0;
}

int hal_ota_write(const uint8_t *buf, size_t n) { return ota_part && esp_ota_write(ota_h, buf, n) == ESP_OK ? 0 : -1; }

void hal_ota_abort(void)
{
    if (ota_part) esp_ota_abort(ota_h);
    ota_part = NULL;
}

int hal_ota_end_and_check(const char *sha256_hex)
{
    const esp_partition_t *p = ota_part;
    ota_part = NULL;
    if (!p || esp_ota_end(ota_h) != ESP_OK) return -1;   /* esp_ota_end revisa que la imagen sea válida */
#if ALMA_F2_API
    /* el SHA-256 de lo que quedó en la flash, leído de vuelta (no de lo que se mandó) */
    static uint8_t rb[4096];
    uint8_t sum[32];
    mbedtls_sha256_context c;
    mbedtls_sha256_init(&c);
    mbedtls_sha256_starts(&c, 0);
    for (size_t off = 0; off < ota_size; off += sizeof rb) {
        size_t k = ota_size - off < sizeof rb ? ota_size - off : sizeof rb;
        if (esp_partition_read(p, off, rb, k) != ESP_OK) { mbedtls_sha256_free(&c); return -1; }
        mbedtls_sha256_update(&c, rb, k);
    }
    mbedtls_sha256_finish(&c, sum);
    mbedtls_sha256_free(&c);
    char hex[65];
    for (int i = 0; i < 32; i++) snprintf(hex + 2 * i, 3, "%02x", sum[i]);
    if (strcmp(hex, sha256_hex)) return -1;
    ota_done = p;
    return 0;
#else
    (void)sha256_hex;
    return -1;   /* sin enlace (sin -Api) no hay de dónde recibirla */
#endif
}

void hal_ota_set_boot_and_restart(void)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    if (!ota_done || esp_ota_set_boot_partition(ota_done) != ESP_OK) { hal_log("ota: no se pudo cambiar el arranque"); return; }
    ota_trial_prev = run->address;
    ota_trial_magic = OTA_TRIAL_MAGIC;
    vTaskDelay(pdMS_TO_TICKS(300));   /* que salga el registro */
    esp_restart();
}

const char *hal_ota_running_label(void) { return esp_ota_get_running_partition()->label; }

static const esp_partition_t *ota_prev(void)
{
    esp_partition_iterator_t it = esp_partition_find(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_ANY, NULL);
    const esp_partition_t *r = NULL;
    for (; it && !r; it = esp_partition_next(it)) {
        const esp_partition_t *p = esp_partition_get(it);
        if (p->address == ota_trial_prev) r = p;
    }
    esp_partition_iterator_release(it);
    return r;
}

int hal_ota_trial(char *prev, size_t cap)
{
    if (ota_trial_magic != OTA_TRIAL_MAGIC) return 0;
    const esp_partition_t *p = ota_prev();
    if (!p || p->address == esp_ota_get_running_partition()->address) { ota_trial_magic = 0; return 0; }
    snprintf(prev, cap, "%s", p->label);
    return 1;
}

void hal_ota_trial_confirm(void) { ota_trial_magic = 0; }

void hal_ota_trial_revert(void)
{
    const esp_partition_t *p = ota_prev();
    ota_trial_magic = 0;
    if (!p || esp_ota_set_boot_partition(p) != ESP_OK) { hal_log("ota: no se pudo volver a la anterior; se queda"); return; }
    vTaskDelay(pdMS_TO_TICKS(300));
    esp_restart();
}

long hal_rlog_take(char *out, size_t cap)
{
    log_lock();
    long n = rlog_take(out, cap);
    log_unlock();
    return n;
}

/* RAM-PROPUESTA.md, 3.1 y C: heap interno de bytes (sin la región solo IRAM), su mínimo y el bloque libre más grande */
void hal_heap_mark(const char *phase)
{
    const uint32_t caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    hal_log("ALMA_HEAP fase=%s libre=%u min=%u bloque=%u", phase, (unsigned)heap_caps_get_free_size(caps),
            (unsigned)heap_caps_get_minimum_free_size(caps), (unsigned)heap_caps_get_largest_free_block(caps));
}

/* ---- K210 (03): UART1 TX GPIO12, RX GPIO4, 1 Mbaud 8N1; RESETN GPIO22 ---- */
#define K210_UART   UART_NUM_1
#define K210_TX     12
#define K210_RX     4
#define K210_RESETN 22
#define K210_BAUD   1000000
#define SILENCE_MS  50

static StreamBufferHandle_t rx_stream;
static volatile uint32_t rx_overflow;

/* Tarea propia: lee el UART y deja los bytes en un búfer; el bucle principal los pasa al parser (sin bloquear) */
static void k210_rx_task(void *arg)
{
    (void)arg;
    uint8_t buf[256];
    for (;;) {
        int n = uart_read_bytes(K210_UART, buf, sizeof buf, pdMS_TO_TICKS(10));
        if (n > 0 && xStreamBufferSend(rx_stream, buf, (size_t)n, 0) != (size_t)n) rx_overflow++;
    }
}

void hal_esp32_k210_init(void)
{
    gpio_config_t io = {.pin_bit_mask = 1ULL << K210_RESETN, .mode = GPIO_MODE_OUTPUT};
    ESP_ERROR_CHECK(gpio_config(&io));
    gpio_set_level(K210_RESETN, 1);   /* activo en bajo */
    uart_config_t c = {
        .baud_rate = K210_BAUD, .data_bits = UART_DATA_8_BITS, .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1, .flow_ctrl = UART_HW_FLOWCTRL_DISABLE, .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_driver_install(K210_UART, 4096, 2048, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(K210_UART, &c));
    ESP_ERROR_CHECK(uart_set_pin(K210_UART, K210_TX, K210_RX, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
    rx_stream = xStreamBufferCreate(16 * 1024, 1);
    xTaskCreate(k210_rx_task, "k210_rx", 3072, NULL, 10, NULL);
}

void hal_esp32_k210_pump(void)
{
    static int64_t last_rx;
    uint8_t buf[256];
    size_t n;
    while ((n = xStreamBufferReceive(rx_stream, buf, sizeof buf, 0)) > 0) {
        k210_rx_feed(buf, n);
        last_rx = hal_now_ms();
    }
    if (hal_now_ms() - last_rx > SILENCE_MS) k210_rx_silence();
}

uint32_t hal_esp32_k210_overflow(void) { return rx_overflow; }

void hal_k210_tx(const uint8_t *frame, size_t n) { uart_write_bytes(K210_UART, frame, n); }

/* ---- SPI al K210 (HALLAZGOS §6 [BOBBY-ARTE]): HSPI, MOSI 15, MISO 2, SCLK 14, CS 13 a mano, modo 1, 8 MHz, DMA.
   Se inicia la primera vez que se usa (envío de archivos), así el arranque no cambia. ---- */
#define K210_SPI_MOSI 15
#define K210_SPI_MISO 2
#define K210_SPI_SCLK 14
#define K210_SPI_CS   13
#define K210_SPI_MAX  (16384 + 64)  /* el trozo más grande: la foto (el K210 manda 10 240 B por trozo, medido 2026-11-01) */
static spi_device_handle_t k210_spi;
static uint8_t *spi_dma;

static int k210_spi_up(void)
{
    if (k210_spi) return 0;
    gpio_config_t io = {.pin_bit_mask = 1ULL << K210_SPI_CS, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&io);
    gpio_set_level(K210_SPI_CS, 1);
    spi_bus_config_t bus = {.mosi_io_num = K210_SPI_MOSI, .miso_io_num = K210_SPI_MISO, .sclk_io_num = K210_SPI_SCLK,
                            .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = K210_SPI_MAX};
    spi_device_interface_config_t dev = {.mode = 1, .clock_speed_hz = 8 * 1000 * 1000, .spics_io_num = -1, .queue_size = 1};
    spi_dma = heap_caps_malloc(K210_SPI_MAX, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (!spi_dma || spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO) != ESP_OK || spi_bus_add_device(SPI2_HOST, &dev, &k210_spi) != ESP_OK) {
        hal_log("SPI al K210: no pude iniciarlo");
        k210_spi = NULL;
        return -1;
    }
    hal_log("SPI al K210: listo (HSPI, 8 MHz, modo 1)");
    return 0;
}

int hal_k210_spi_write(const uint8_t *p, size_t n)
{
    if (n == 0 || n > K210_SPI_MAX || k210_spi_up()) return -1;
    memcpy(spi_dma, p, n);
    spi_transaction_t t = {.length = n * 8, .tx_buffer = spi_dma};
    gpio_set_level(K210_SPI_CS, 0);
    esp_err_t e = spi_device_transmit(k210_spi, &t);
    gpio_set_level(K210_SPI_CS, 1);
    return e == ESP_OK ? 0 : -1;
}

int hal_k210_spi_read(uint8_t *p, size_t n)
{
    if (n == 0 || n > K210_SPI_MAX || k210_spi_up()) return -1;
    memset(spi_dma, 0, n);
    spi_transaction_t t = {.length = n * 8, .tx_buffer = spi_dma, .rx_buffer = spi_dma};
    gpio_set_level(K210_SPI_CS, 0);
    esp_err_t e = spi_device_transmit(k210_spi, &t);
    gpio_set_level(K210_SPI_CS, 1);
    if (e != ESP_OK) return -1;
    memcpy(p, spi_dma, n);
    return 0;
}

void hal_delay_us(uint32_t us) { esp_rom_delay_us(us); }

extern const uint8_t alma_test_avi_start[] asm("_binary_alma_test_avi_start");
extern const uint8_t alma_test_avi_end[] asm("_binary_alma_test_avi_end");
const uint8_t *hal_test_avi(size_t *n) { *n = (size_t)(alma_test_avi_end - alma_test_avi_start); return alma_test_avi_start; }
extern const uint8_t sticker_test_png_start[] asm("_binary_sticker_test_png_start");
extern const uint8_t sticker_test_png_end[] asm("_binary_sticker_test_png_end");
const uint8_t *hal_test_sticker(size_t *n) { *n = (size_t)(sticker_test_png_end - sticker_test_png_start); return sticker_test_png_start; }
extern const uint8_t alma_brain_almb_start[] asm("_binary_alma_brain_almb_start");
extern const uint8_t alma_brain_almb_end[] asm("_binary_alma_brain_almb_end");
const uint8_t *hal_brain_weights(size_t *n) { *n = (size_t)(alma_brain_almb_end - alma_brain_almb_start); return alma_brain_almb_start; }

void hal_k210_resetn_pulse(int low_ms)
{
    gpio_set_level(K210_RESETN, 0);
    esp_rom_delay_us((uint32_t)low_ms * 1000);
    gpio_set_level(K210_RESETN, 1);
}

/* ---- servos ---- */
/* [BOBBY-ARTE], medido en 1B: en esta placa ("new servo") GPIO0 habilita las patas (los sensores de pie solo responden
   así). El firmware de fábrica lo pone en alto al arrancar; Alma también, en las dos variantes */
void hal_esp32_legs_enable(void)
{
    gpio_config_t io = {.pin_bit_mask = 1ULL << 0, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&io);
    gpio_set_level(0, 1);
}

#define LEGS_WAKE_MS 150   /* tras prenderlas: los servos y los sensores de pie listos */
static volatile int legs_on = 1;
static volatile int64_t legs_ready_ms;
int hal_legs_on(void) { return legs_on; }
void hal_legs_power(int on)
{
    if (on == legs_on) return;
#if !ALMA_SERVOS_DISABLED
    if (!on) for (int i = 0; i < HAL_SERVOS; i++) hal_servo_release(i);   /* el LEDC se vuelve a configurar al mandar */
#endif
    legs_ready_ms = hal_now_ms() + LEGS_WAKE_MS;
    gpio_set_level(0, on ? 1 : 0);
    legs_on = on;
    hal_log("patas: %s", on ? "con corriente" : "sin corriente (servos flojos)");
    if (on) vTaskDelay(pdMS_TO_TICKS(LEGS_WAKE_MS));
}

#if ALMA_SERVOS_DISABLED
/* Variante remota: sin LEDC ni ningún otro driver de salida; los GPIO 5, 21, 25 y 26 no se tocan.
   hal_servo_* y hal_esp32_servo_init son macros vacías (f2_hal.h, hal_esp32.h). */
#else
#include "driver/ledc.h"
/*
 * PENDIENTE: 02. PWM de 50 Hz con µs = 500 + grados · 2000 / 180, DERIVADO del original (sesion1/servo_pwm.h);
 * 02 dice RMT. Se confirma en la prueba d) de la sesión 1. */
static const int SERVO_GPIO[HAL_SERVOS] = {21, 25, 5, 26};
#define RES_BITS  14
#define PERIOD_US 20000
static int active[HAL_SERVOS];
static float last_deg[HAL_SERVOS] = {NAN, NAN, NAN, NAN};

static uint32_t duty_of(float deg)
{
    return (uint32_t)lroundf((500.0f + deg * 2000.0f / 180.0f) * (float)(1 << RES_BITS) / PERIOD_US);
}

void hal_esp32_servo_init(void)
{
    ledc_timer_config_t t = {.speed_mode = LEDC_LOW_SPEED_MODE, .duty_resolution = RES_BITS, .timer_num = LEDC_TIMER_0,
                             .freq_hz = 50, .clk_cfg = LEDC_AUTO_CLK};
    ESP_ERROR_CHECK(ledc_timer_config(&t));
}

void hal_servo_set(int idx, float deg)
{
    if (idx < 0 || idx >= HAL_SERVOS || deg < 0 || deg > 180) return;
    if (!legs_on) hal_legs_power(1);
    if (!active[idx]) {
        ledc_channel_config_t c = {.gpio_num = SERVO_GPIO[idx], .speed_mode = LEDC_LOW_SPEED_MODE, .channel = (ledc_channel_t)idx,
                                   .timer_sel = LEDC_TIMER_0, .duty = duty_of(deg), .hpoint = 0};
        ledc_channel_config(&c);
        active[idx] = 1;
    } else {
        ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)idx, duty_of(deg));
        ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)idx);
    }
    last_deg[idx] = deg;
}

void hal_servo_hold_all(void) { /* el PWM sigue con la última posición: cada servo se queda donde está */ }

void hal_servo_release(int idx)
{
    if (idx < 0 || idx >= HAL_SERVOS || !active[idx]) return;
    ledc_stop(LEDC_LOW_SPEED_MODE, (ledc_channel_t)idx, 0);
    gpio_reset_pin(SERVO_GPIO[idx]);
    active[idx] = 0;
}

void hal_servo_restore(int idx)
{
    if (idx >= 0 && idx < HAL_SERVOS && !active[idx] && !isnan(last_deg[idx])) hal_servo_set(idx, last_deg[idx]);
}
#endif

/* ---- audio: la ruta I2S directa es de la fase 3 (03, 07) ---- */
void hal_audio_stop(void) {}

/* ---- sensores del cuerpo: pies, IMU y toque, cada 10 ms en su propia tarea, como el original (HALLAZGOS §2-§4
   [BOBBY-ARTE]). La tarea solo lee y llama a app/sense.c; hal_sensors_read copia los resultados. ----
   I2C con el driver heredado, como sesion1/sensors.c (el nuevo dio pánico en 1A): SDA 19, SCL 18, 100 kHz. Lecturas de
   registro en dos transacciones con STOP. Los pies contestan con GPIO0 en alto (hal_esp32_legs_enable). */
#define I2C_PORT   I2C_NUM_0
#define I2C_SDA    19
#define I2C_SCL    18
#define IMU_ADDR   0x6B
#define FOOT_40    0x40
#define FOOT_41    0x41
static const touch_pad_t TOUCH_PADS[3] = {TOUCH_PAD_NUM7, TOUCH_PAD_NUM8, TOUCH_PAD_NUM9};   /* GPIO27, 33, 32 */
static portMUX_TYPE sense_mux = portMUX_INITIALIZER_UNLOCKED;
static sense_floor S_floor;
static sense_imu S_imu;
static sense_touch S_touch;
static int S_touch_raw[3] = {-1, -1, -1};   /* última lectura de cada pad (teclas g y G) */
static int bus_ok, imu_ok, touch_ok, tof_ok;
static volatile int tof_mm = -1;   /* última distancia del VL53L0X (mm; VL53_FAR = lejos) */
static volatile float yaw_deg;
float hal_yaw_deg(void) { return yaw_deg; }

static int feet_flat(void)
{
#if ALMA_SERVOS_DISABLED
    return 1;
#else
    for (int i = 2; i < 4; i++)   /* S2 y S3, los pies: entre 86 y 94 como el original; nunca mandado = neutro */
        if (!isnan(last_deg[i]) && fabsf(last_deg[i] - 90.0f) > 4.0f) return 0;
    return 1;
#endif
}

static int reg_write(uint8_t reg, uint8_t v)
{
    uint8_t w[2] = {reg, v};
    return i2c_master_write_to_device(I2C_PORT, IMU_ADDR, w, 2, pdMS_TO_TICKS(20)) == ESP_OK ? 0 : -1;
}

static int reg_read(uint8_t reg, uint8_t *out, size_t n)
{
    if (i2c_master_write_to_device(I2C_PORT, IMU_ADDR, &reg, 1, pdMS_TO_TICKS(20)) != ESP_OK) return -1;
    return i2c_master_read_from_device(I2C_PORT, IMU_ADDR, out, n, pdMS_TO_TICKS(20)) == ESP_OK ? 0 : -1;
}

/* LSM6DS3TR-C como el original (reinicio, BDU, 1.66 kHz, ±8 g, ±2000 °/s), salvo el paso alto del acelerómetro
   (CTRL8_XL): Alma necesita la gravedad para la inclinación. Son registros volátiles del IMU, no flash. */
static int imu_setup(void)
{
    uint8_t who = 0, c3 = 0;
    if (reg_read(0x0F, &who, 1) || who != 0x6A) { hal_log("sensores: IMU 0x6B no contesta (WHO_AM_I 0x%02x)", who); return 0; }
    reg_write(0x12, 0x01);   /* CTRL3_C: SW_RESET */
    for (int i = 0; i < 10; i++) { vTaskDelay(pdMS_TO_TICKS(10)); if (!reg_read(0x12, &c3, 1) && !(c3 & 1)) break; }
    int ok = !reg_write(0x12, 0x44) && !reg_write(0x10, 0x8D) && !reg_write(0x11, 0x8C);   /* BDU|IF_INC; XL; G */
    hal_log("sensores: IMU LSM6DS3TR-C configurado (%s)", ok ? "ok" : "ERROR");
    return ok;
}

static void touch_setup(void)
{
    if (touch_pad_init() != ESP_OK) { hal_log("sensores: no pude iniciar el toque"); return; }
    /* el modo va ANTES de touch_pad_config: en IDF 5.2 touch_pad_init deja el modo SW, y config en SW saca el pad de la
       máscara de grupo; al pasar luego a TIMER la FSM no medía ningún pad y las tres lecturas daban 0 →
       ESP_ERR_INVALID_STATE (robot, 2026-10-30). Mismo orden que el ejemplo de IDF */
    touch_pad_set_fsm_mode(TOUCH_FSM_MODE_TIMER);
    touch_pad_set_voltage(TOUCH_HVOLT_2V7, TOUCH_LVOLT_0V5, TOUCH_HVOLT_ATTEN_1V);
    for (int i = 0; i < 3; i++) touch_pad_config(TOUCH_PADS[i], 0);   /* umbral 0: sin interrupción */
    touch_ok = touch_pad_filter_start(10) == ESP_OK;
}

static void sense_task(void *arg)
{
    (void)arg;
    TickType_t wake = xTaskGetTickCount();
    for (;;) {
        int raw[4] = {-1, -1, -1, -1}, tr[3] = {-1, -1, -1};
        static int last_raw[4] = {-1, -1, -1, -1};
        int feet = legs_on && hal_now_ms() >= legs_ready_ms;   /* sin corriente en las patas, los pies no contestan */
        int16_t acc[3] = {0, 0, 0};
        int acc_ok = 0;
        if (bus_ok) {
            uint8_t b[5];
            if (feet && i2c_master_read_from_device(I2C_PORT, FOOT_41, b, 5, pdMS_TO_TICKS(10)) == ESP_OK) {
                raw[SENSE_A41] = b[1] | b[2] << 8;
                raw[SENSE_B41] = b[3] | b[4] << 8;
            }
            if (feet && i2c_master_read_from_device(I2C_PORT, FOOT_40, b, 5, pdMS_TO_TICKS(10)) == ESP_OK) {
                raw[SENSE_A40] = b[1] | b[2] << 8;
                raw[SENSE_B40] = b[3] | b[4] << 8;
            }
            for (int i = 0; i < 4; i++) {
                if (feet && raw[i] >= 0) last_raw[i] = raw[i];
                else if (!feet) raw[i] = last_raw[i];
            }
            uint8_t d[12];
            if (imu_ok && !reg_read(0x22, d, 12)) {   /* giro 0x22..0x27, aceleración 0x28..0x2D */
                for (int i = 0; i < 3; i++) acc[i] = (int16_t)(d[6 + 2 * i] | d[7 + 2 * i] << 8);
                acc_ok = 1;
                /* rumbo (home.c): giro Y (vertical, como la gravedad) a 2000 dps de escala (CTRL2_G 0x8C) = 70 mdps/LSB */
                /* con el tiempo real entre lecturas (dueño, 2026-11-02: "registra 180 si dio más vuelta"; antes se suponían
                   10 ms por vuelta y la tarea puede tardar más) */
                static int64_t last_us;
                int64_t now_us = esp_timer_get_time();
                float dt = last_us ? (now_us - last_us) / 1e6f : SENSE_TICK_MS / 1000.0f;
                last_us = now_us;
                if (dt > 0.1f) dt = 0.1f;
                int16_t gy = (int16_t)(d[2] | d[3] << 8);
                /* desviación en reposo (medido 2026-11-02: quieta, el rumbo corría ~3°/s): se mide con la tarea quieta
                   (sin movimiento y el acelerómetro tranquilo) y se descuenta; al arrancar, el promedio del primer segundo */
                static float bias;
                static int bias_n;
                float rate = (float)gy * 0.070f;
                int quiet = !motion_active() && S_imu.dev[0] < 50 && S_imu.dev[1] < 50 && S_imu.dev[2] < 50;
                if (bias_n < 100) { bias += (rate - bias) / (float)++bias_n; }
                else if (quiet) bias += 0.002f * (rate - bias);   /* ~5 s */
                if (bias_n >= 100) yaw_deg += (rate - bias) * dt;
            }
        }
        if (touch_ok)
            for (int i = 0; i < 3; i++) {
                /* medido 2026-10-30: la lectura filtrada fallaba siempre (−1 en los 3 pads). Se prueba la cruda del
                   filtro y la medición directa; el primer fallo de cada camino queda en el registro una sola vez */
                static int logged[3];
                uint16_t v = 0;
                esp_err_t e1 = touch_pad_read_filtered(TOUCH_PADS[i], &v), e2 = ESP_OK, e3 = ESP_OK;
                if (e1 != ESP_OK) e2 = touch_pad_read_raw_data(TOUCH_PADS[i], &v);
                if (e1 != ESP_OK && e2 != ESP_OK) e3 = touch_pad_read(TOUCH_PADS[i], &v);
                if (e1 == ESP_OK || e2 == ESP_OK || e3 == ESP_OK) tr[i] = v;
                if (e1 != ESP_OK && !logged[i]) {
                    logged[i] = 1;
                    hal_log("toque T%d: filtrada %s, cruda %s, directa %s (valor %u)", 7 + i, esp_err_to_name(e1),
                            e2 == ESP_OK ? "ok" : esp_err_to_name(e2), e1 != ESP_OK && e2 != ESP_OK ? esp_err_to_name(e3) : "-", v);
                }
            }
        if (tof_ok) { int mm = vl53_step(); if (mm >= 0) tof_mm = mm; }
        else if (bus_ok) {
            /* medido 2026-11-02: al arrancar a veces no contesta (ID ≠ 0xEE o falla un paso) y quedaba sin distancia
               hasta el siguiente reinicio. Se reintenta cada 5 s durante 2 min */
            static int tries;
            static int64_t next_try;
            int64_t now = hal_now_ms();
            if (tries < 24 && now >= next_try) {
                next_try = now + 5000;
                int r = vl53_init(I2C_PORT);
                tof_ok = r == 0;
                if (tof_ok || ++tries == 24) hal_log("sensores: distancia VL53L0X %s (reintento %d)", tof_ok ? "lista" : "sigue sin responder", tries + tof_ok);
            }
        }
        int flat = feet_flat();
        portENTER_CRITICAL(&sense_mux);
        sense_floor_update(&S_floor, raw, flat);
        sense_imu_update(&S_imu, acc, acc_ok, &S_floor);
        sense_touch_update(&S_touch, tr);
        memcpy(S_touch_raw, tr, sizeof S_touch_raw);
        portEXIT_CRITICAL(&sense_mux);
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(SENSE_TICK_MS));
    }
}

/* teclas g y G: los 3 pads de toque (T7 cabeza, T8, T9): lectura, base y el valor bajo el que cuenta como toque */
void hal_touch_debug(void)
{
    sense_touch t;
    int r[3];
    portENTER_CRITICAL(&sense_mux);
    t = S_touch;
    memcpy(r, S_touch_raw, sizeof r);
    portEXIT_CRITICAL(&sense_mux);
    static const int THR[3] = {50, 30, 30};   /* los de sense.c */
    hal_log("toque: T7 %d (base %.0f, toca < %.0f, %d ms) | T8 %d (base %.0f, < %.0f, %d ms) | T9 %d (base %.0f, < %.0f, %d ms) | toques %d caricias %d",
            r[0], t.base[0], t.base[0] - THR[0], t.held_ms[0], r[1], t.base[1], t.base[1] - THR[1], t.held_ms[1],
            r[2], t.base[2], t.base[2] - THR[2], t.held_ms[2], t.taps, t.pets);
}

/* tecla g: lo que ve cada sensor ahora (para medir umbrales y qué canal es adelante) */
void hal_sensors_debug(void)
{
    hal_log("distancia: %s %d mm; rumbo (giroscopio) %.1f°", tof_ok ? "VL53L0X" : "sin sensor", tof_mm, yaw_deg);   /* ya sin la desviación en reposo */
    hal_power_probe_t pp;
    if (hal_power_probe(&pp) == 0)
        hal_log("alimentación: GPIO36 %d mV, GPIO37 %d mV, GPIO38 %d mV, GPIO39 %d mV, RX0 %d, cargador %d",
                pp.mv[0], pp.mv[1], pp.mv[2], pp.mv[3], pp.rx0, pp.charger);
    sense_floor f;
    sense_imu m;
    portENTER_CRITICAL(&sense_mux);
    f = S_floor;
    m = S_imu;
    portEXIT_CRITICAL(&sense_mux);
    static const char *const CH[4] = {"A41", "B41", "A40", "B40"};
    for (int i = 0; i < 4; i++)
        hal_log("piso %s: crudo %d, filtrado %d, umbral %d%s, fallas %d", CH[i], f.last[i], f.v[i], f.thr[i],
                f.thr[i] == 0 ? " (sin aprender)" : f.v[i] < f.thr[i] ? " -> SIN PISO" : "", f.fails[i]);
    static const char *const POSE[] = {"de pie", "en el aire", "volcado"};
    hal_log("IMU: g = %.0f %.0f %.0f (1/1024 g), inclinación A %d° B %d°, %s, desviación %.0f %.0f %.0f", m.g[0], m.g[1], m.g[2],
            m.A, m.B, POSE[m.pose], m.dev[0], m.dev[1], m.dev[2]);
    hal_touch_debug();
}

static void body_sensors_init(void)
{
    sense_floor_init(&S_floor);
    sense_imu_init(&S_imu);
    sense_touch_init(&S_touch);
    i2c_config_t c = {.mode = I2C_MODE_MASTER, .sda_io_num = I2C_SDA, .scl_io_num = I2C_SCL,
                      .sda_pullup_en = GPIO_PULLUP_ENABLE, .scl_pullup_en = GPIO_PULLUP_ENABLE, .master.clk_speed = 100000};
    bus_ok = i2c_param_config(I2C_PORT, &c) == ESP_OK && i2c_driver_install(I2C_PORT, I2C_MODE_MASTER, 0, 0, 0) == ESP_OK;
    if (!bus_ok) hal_log("sensores: no pude abrir el I2C; sin pies ni IMU");
    else {
        imu_ok = imu_setup();
        int r = vl53_init(I2C_PORT);
        tof_ok = r == 0;
        hal_log("sensores: distancia VL53L0X %s", tof_ok ? "lista" : r == -1 ? "no responde (ID ≠ 0xEE)" : "falló al iniciar");
        if (!tof_ok && r != -1) hal_log("sensores: VL53L0X, paso %d", r);
    }
    touch_setup();
    xTaskCreate(sense_task, "sense", 4096, NULL, 5, NULL);
    hal_log("sensores: tarea de 10 ms (I2C %s, IMU %s, toque %s)", bus_ok ? "ok" : "no", imu_ok ? "ok" : "no", touch_ok ? "ok" : "no");
}

/* ---- sensores: batería y cargador (02 [BOBBY-ARTE]; medido [ALMA-1B]) ----
   GPIO39 = ADC1 CH3, promedio de 64 muestras con la calibración de línea; GPIO36 digital, 1 con el USB.
   Driver ADC heredado, como sesion1/sensors.c: adc_oneshot agrega un segmento RTC FAST que el original no tiene.
   Hasta la primera lectura (y si el ADC falla), "en la base" y 100 %: con R14, Alma no mueve servos. */
#define BAT_CH         ADC1_CHANNEL_3
#define CHARGER_GPIO   36
#define BAT_EVERY_MS   1000
#define CHG_EVERY_MS   500
#define CHARGER_MV     1200   /* GPIO36 analógico: con USB ~2500 mV */
static adc_cali_handle_t bat_cali;
static int sensors_up, charger = 1, charger_last = 1;
static float bat_pct = 100;
static int bat_mv = -1;
int hal_battery_mv(void) { return bat_mv; }
static int64_t bat_next, chg_next;

void hal_esp32_sensors_init(void)
{
    body_sensors_init();
    if (adc1_config_width(ADC_WIDTH_BIT_12) != ESP_OK || adc1_config_channel_atten(BAT_CH, ADC_ATTEN_DB_12) != ESP_OK) {
        hal_log("batería: no pude configurar el ADC; queda 100 %% y en la base");
        return;
    }
    adc_cali_line_fitting_config_t lc = {.unit_id = ADC_UNIT_1, .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
    if (adc_cali_create_scheme_line_fitting(&lc, &bat_cali) != ESP_OK) bat_cali = NULL;
    gpio_config_t io = {.pin_bit_mask = 1ULL << CHARGER_GPIO, .mode = GPIO_MODE_INPUT,
                        .pull_up_en = GPIO_PULLUP_DISABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE};
    gpio_config(&io);
    /* diagnóstico Home Station / USB: GPIO36, 37, 38 = ADC1 CH0, CH1, CH2 (solo entrada; leerlos no cambia nada) */
    for (int ch = 0; ch < 3; ch++) adc1_config_channel_atten((adc1_channel_t)ch, ADC_ATTEN_DB_12);
    sensors_up = 1;
}

static int adc_mv(int ch, int samples)
{
    int sum = 0, n = 0, mv;
    for (int i = 0; i < samples; i++) {
        int raw = adc1_get_raw((adc1_channel_t)ch);
        if (raw >= 0 && bat_cali && adc_cali_raw_to_voltage(bat_cali, raw, &mv) == ESP_OK) { sum += mv; n++; }
    }
    return n ? sum / n : -1;
}
static int charger_mv(void) { return adc_mv(0, 8); }

int hal_power_probe(hal_power_probe_t *out)
{
    if (!sensors_up) return -1;
    for (int ch = 0; ch < 4; ch++) out->mv[ch] = adc_mv(ch, 16);
    out->rx0 = gpio_get_level(GPIO_NUM_3);
    out->charger = charger;   /* 0 nada, 1 Home Station, 2 USB */
    return 0;
}

static void battery_update(void)
{
    int sum = 0, n = 0;
    for (int i = 0; i < 64; i++) {
        int raw = adc1_get_raw(BAT_CH), mv;
        if (raw < 0) continue;
        if (!bat_cali || adc_cali_raw_to_voltage(bat_cali, raw, &mv) != ESP_OK) return;   /* sin calibración no hay mV */
        sum += mv;
        n++;
    }
    if (!n) return;
    int pin = sum / n, mv = battery_mv(pin, charger != 0);
    float pct = battery_pct(mv, charger != 0);
    static int64_t last_log = -600000;
    if (hal_now_ms() - last_log >= 600000) {   /* cada 10 min, para ver la curva en el registro */
        hal_log("batería: pin %d mV → %d mV, %.0f %%, cargador %d", pin, mv, pct, charger);
        last_log = hal_now_ms();
    }
    bat_pct = pct;
    bat_mv = mv;
}

void hal_sensors_read(hal_sensors *out)
{
    /* cuerpo (app/sense.c). PENDIENTE: 02 (f2 y f2b con el dueño): ejes del IMU, qué byte de los pies es cada sensor
       y si los umbrales del original sirven tal cual */
    static int taps_seen, pets_seen;
    portENTER_CRITICAL(&sense_mux);
    out->lifted = S_imu.pose == SENSE_AIR;
    out->tipped = S_imu.pose == SENSE_TIPPED;
    out->shaken = S_imu.shaken;
    out->touch_tap = S_touch.taps != taps_seen;
    out->touch_pet = S_touch.pets != pets_seen;
    taps_seen = S_touch.taps;
    pets_seen = S_touch.pets;
    sense_floor_out(&S_floor, out->floor);
    portEXIT_CRITICAL(&sense_mux);
    out->tof_mm = tof_ok ? tof_mm : -1;            /* VL53L0X en 0x29 (vl53l0x.c) */
    int64_t now = hal_now_ms();
    if (sensors_up && now >= chg_next) {
        chg_next = now + CHG_EVERY_MS;
        /* GPIO36 ahora es analógico (diagnóstico Home Station / USB, 2026-10-30): con el ADC configurado la lectura
           digital da 0 siempre. Cargador = más de CHARGER_MV (medido con USB: ~2500 mV; sin nada, a medir) */
        int c = charger_mv() > CHARGER_MV;
        c = c ? (gpio_get_level(GPIO_NUM_3) ? 2 : 1) : 0;   /* 0 nada, 1 Home Station, 2 USB (RX0 alto) */
        if (c == charger_last && c != charger) {
            hal_log("cargador: %s", c == 2 ? "USB" : c == 1 ? "Home Station" : "sin cargador");
            charger = c;
        }
        charger_last = c;
    }
    if (sensors_up && now >= bat_next) {
        bat_next = now + BAT_EVERY_MS;
        battery_update();
    }
    /* PENDIENTE: 02 (f3). Que GPIO36 baje a 0 sin el USB está por medir; si no bajara, Alma seguiría "en la base",
       que es el valor seguro */
    out->soc_pct = bat_pct;
    out->on_charger = charger != 0;
    out->on_usb = charger == 2;
}

/* ---- flash ---- */
static const esp_partition_t *storage;

int hal_spiffs_read(uint32_t off, void *buf, size_t n)
{
    if (!storage) storage = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, "storage");
    return storage && esp_partition_read(storage, off, buf, n) == ESP_OK ? 0 : -1;
}

uint32_t hal_spiffs_size(void)
{
    if (!storage) storage = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, "storage");
    return storage ? storage->size : 0;
}

int hal_mem_flash(alma_mem_flash *out) { return alma_mem_esp32_open(out); }
