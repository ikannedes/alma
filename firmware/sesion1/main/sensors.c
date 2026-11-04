#include "sensors.h"

#include <stdio.h>
#include <string.h>

#include "driver/adc.h"           /* driver ADC heredado de ESP-IDF; ver sensors_init() */
#include "driver/gpio.h"
#include "driver/i2c.h"           /* driver I2C heredado de ESP-IDF; ver bus_open() */
#include "driver/touch_pad.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "log_util.h"

/* ---- candidatos (02): ADC1 en pines sin asignar. CH7 = GPIO35 queda fuera: es el I2S DIN 🧪 de 02 ---- */
static const struct { adc1_channel_t ch; int gpio; } ADC_PINS[] = {
    {ADC1_CHANNEL_0, 36}, {ADC1_CHANNEL_1, 37}, {ADC1_CHANNEL_2, 38}, {ADC1_CHANNEL_3, 39},   /* CH3: ¿batería? (02) */
    {ADC1_CHANNEL_4, 32}, {ADC1_CHANNEL_5, 33}, {ADC1_CHANNEL_6, 34},                        /* CH6: ¿toque? (02) */
};
/* ---- f2b: los tres pads táctiles del original [BOBBY-ARTE]: T7 = GPIO27, T8 = GPIO33 y T9 = GPIO32. GPIO27 no es I2S:
   el original no usa I2S con pines ---- */
static const struct { touch_pad_t pad; int gpio; } TOUCH_PINS[] = {{TOUCH_PAD_NUM7, 27}, {TOUCH_PAD_NUM8, 33}, {TOUCH_PAD_NUM9, 32}};
#define N_TOUCH (int)(sizeof TOUCH_PINS / sizeof *TOUCH_PINS)
#define N_ADC (int)(sizeof ADC_PINS / sizeof *ADC_PINS)
#define DIN_GPIO 36   /* [BOBBY-ARTE]: entrada digital "cargador presente" del original (alto = cargando, por confirmar) */

/* [BOBBY-ARTE]: el bus del original es I2C_NUM_0 con SDA en GPIO19 y SCL en GPIO18, pull-ups internos, 100 kHz.
   GPIO0 NO es I2C: es una salida (el primer servo o la habilitación de las patas, según la placa) y no se toca. */
#define I2C_SDA 19
#define I2C_SCL 18
#define LSM6_WHO_AM_I 0x0F   /* LSM6DS3TR-C: 0x6A */
#define LSM6_CTRL1_XL 0x10
#define LSM6_CTRL2_G  0x11
#define LSM6_OUTX_L_G 0x22   /* 12 bytes: giróscopo X, Y, Z y acelerómetro X, Y, Z */

#define I2C_PORT I2C_NUM_0

static adc_cali_handle_t cali;
static int bus_up, imu_addr, imu_on, pull_mode;
static volatile int streaming, touching, rec_n, recording;

void sensors_init(void)
{
    /* Driver heredado (adc1_get_raw) y no adc_oneshot: adc_oneshot_new_unit referencia
       esp_sleep_enable_adc_tsens_monitor, que deja una variable de 4 bytes en RTC FAST (0x3FF80000) y agrega a la
       imagen un segmento que el original no tiene (sesion1.md, "Encabezado"). La lectura es la misma. */
    ESP_ERROR_CHECK(adc1_config_width(ADC_WIDTH_BIT_12));
    for (int i = 0; i < N_ADC; i++) ESP_ERROR_CHECK(adc1_config_channel_atten(ADC_PINS[i].ch, ADC_ATTEN_DB_12));
    adc_cali_line_fitting_config_t lc = {.unit_id = ADC_UNIT_1, .atten = ADC_ATTEN_DB_12, .bitwidth = ADC_BITWIDTH_12};
    if (adc_cali_create_scheme_line_fitting(&lc, &cali) != ESP_OK) cali = NULL;
    gpio_config_t io = {.pin_bit_mask = 1ULL << DIN_GPIO, .mode = GPIO_MODE_INPUT,
                        .pull_up_en = GPIO_PULLUP_DISABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE};
    ESP_ERROR_CHECK(gpio_config(&io));
}

/* ---- I2C ----
 * En la 1A (A9) el escaneo dio pánico por dos causas que se juntaron: los pines estaban mal (GPIO0/19, cuando el bus
 * del original es GPIO19/18 [BOBBY-ARTE]) y i2c_new_master_bus de ESP-IDF v5.2.1 habilitó las interrupciones del bus
 * antes de cualquier transacción (i2c_master.c:864), con las líneas en drenaje abierto sin pull-up.
 * Driver heredado (driver/i2c.h) y no i2c_master: En modo síncrono su manejador solo borra la causa y devuelve el semáforo (i2c_master.c:571 y 638): si la
 * causa se repite, la interrupción vuelve a entrar sin fin y salta el watchdog de interrupciones. El heredado instala
 * su manejador con todas las interrupciones apagadas (i2c.c:380), las habilita solo durante cada comando (1416, 1433)
 * y, ante un tiempo agotado, reinicia la máquina de estados y libera el bus (i2c_hw_fsm_reset). Además, antes de abrir
 * el bus se mira que las dos líneas lean 1 en reposo. Los dos drivers no pueden estar juntos en el binario
 * (i2c.c:1651, aborta al arrancar): tools/check_i2c_driver.py lo revisa en el ELF. */
static void bus_close(void)
{
    if (bus_up) i2c_driver_delete(I2C_PORT);
    bus_up = imu_on = 0;
}

/* SDA y SCL como entradas, con o sin el pull-up débil; en reposo las dos deben leer 1 */
static int lines_idle(int pullup, int *sda, int *scl)
{
    gpio_config_t io = {.pin_bit_mask = 1ULL << I2C_SDA | 1ULL << I2C_SCL, .mode = GPIO_MODE_INPUT,
                        .pull_up_en = pullup ? GPIO_PULLUP_ENABLE : GPIO_PULLUP_DISABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE};
    gpio_config(&io);
    vTaskDelay(pdMS_TO_TICKS(2));
    *sda = gpio_get_level(I2C_SDA);
    *scl = gpio_get_level(I2C_SCL);
    return *sda && *scl;
}

static int bus_open(int pullup)
{
    bus_close();
    i2c_config_t c = {.mode = I2C_MODE_MASTER, .sda_io_num = I2C_SDA, .scl_io_num = I2C_SCL,
                      .sda_pullup_en = pullup, .scl_pullup_en = pullup, .master.clk_speed = 100000};
    if (i2c_param_config(I2C_PORT, &c) != ESP_OK || i2c_driver_install(I2C_PORT, I2C_MODE_MASTER, 0, 0, 0) != ESP_OK) return -1;
    bus_up = 1;
    return 0;
}

/* sondeo: dirección con bit de lectura y 1 byte leído con NACK */
static int probe(int addr)
{
    uint8_t link[I2C_LINK_RECOMMENDED_SIZE(3)], b;
    i2c_cmd_handle_t cmd = i2c_cmd_link_create_static(link, sizeof link);
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (uint8_t)(addr << 1 | I2C_MASTER_READ), true);
    i2c_master_read_byte(cmd, &b, I2C_MASTER_NACK);
    i2c_master_stop(cmd);
    esp_err_t e = i2c_master_cmd_begin(I2C_PORT, cmd, pdMS_TO_TICKS(20));
    i2c_cmd_link_delete_static(cmd);
    return e == ESP_OK;
}

/* lectura de registro: se escribe solo el puntero (1 o 2 bytes) y se lee, en dos transacciones con STOP entre
   medias, como lo hace el original [BOBBY-ARTE] (sin repeated-start) */
static int reg_read(int addr, const uint8_t *idx, size_t idx_n, uint8_t *out, size_t n)
{
    if (i2c_master_write_to_device(I2C_PORT, (uint8_t)addr, idx, idx_n, pdMS_TO_TICKS(50)) != ESP_OK) return -1;
    return i2c_master_read_from_device(I2C_PORT, (uint8_t)addr, out, n, pdMS_TO_TICKS(50)) == ESP_OK ? 0 : -1;
}

static void id_report(int addr)
{
    uint8_t v0 = 0, vf = 0;
    uint8_t r0 = 0x00, rf = 0x0F;
    int ok0 = reg_read(addr, &r0, 1, &v0, 1) == 0, okf = reg_read(addr, &rf, 1, &vf, 1) == 0;
    log_line("  0x%02x responde: reg 0x00 = %s%02x, reg 0x0F = %s%02x", addr, ok0 ? "0x" : "error ", v0, okf ? "0x" : "error ", vf);
    if ((addr == 0x6A || addr == 0x6B) && okf)
        log_line("    LSM6DS3TR-C: WHO_AM_I (0x0F) = 0x%02x → %s", vf, vf == 0x6A ? "COINCIDE (0x6A)" : "no coincide (se espera 0x6A)");
    if (addr == 0x28 && ok0)
        log_line("    0x28 (EL-GPIO): reg 0x00 = 0x%02x (BNO055 daría 0xA0; QMA6100P, 0x90)", v0);
    if (addr == 0x29) {
        uint8_t l0 = 0, l1[2] = {0}, c0 = 0xC0, i1[2] = {0x01, 0x0F};
        int a = reg_read(addr, &c0, 1, &l0, 1) == 0, b = reg_read(addr, i1, 2, l1, 2) == 0;
        log_line("    VL53: VL53L0X reg 0xC0 = %s%02x (se espera 0xEE); VL53L1X índice 0x010F = %s%02x %02x (se espera EA CC)",
                 a ? "0x" : "error ", l0, b ? "" : "error ", l1[0], l1[1]);
    }
}

void sensors_i2c_scan(void)
{
    int opened = 0;
    imu_addr = 0;
    for (int pass = 0; pass < 2; pass++) {
        int pull = pass == 1, sda, scl;
        const char *pull_name = pull ? "débil (~45 kΩ)" : "apagado";
        bus_close();   /* los pines se miran con el driver desinstalado */
        if (!lines_idle(pull, &sda, &scl)) {   /* una línea en 0: sin pull-up externo, o algo la sostiene en bajo */
            log_line("f1) pull-up interno %s: SDA (GPIO%d) = %d, SCL (GPIO%d) = %d; en reposo deben leer 1. No abro el bus",
                     pull_name, I2C_SDA, sda, I2C_SCL, scl);
            continue;
        }
        if (bus_open(pull)) { log_line("f1) no pude abrir el I2C en GPIO%d/GPIO%d", I2C_SDA, I2C_SCL); return; }
        opened = 1;
        log_line("== f1) escaneo I2C SDA GPIO%d, SCL GPIO%d, 100 kHz, pull-up interno %s; las dos líneas en 1; sondeo por "
                 "lectura de 1 byte ==", I2C_SDA, I2C_SCL, pull_name);
        int found = 0;
        for (int a = 0x08; a <= 0x77; a++) {
            if (!probe(a)) continue;
            found++;
            id_report(a);
            uint8_t r = LSM6_WHO_AM_I, v = 0;
            if ((a == 0x6A || a == 0x6B) && reg_read(a, &r, 1, &v, 1) == 0 && v == 0x6A && !imu_addr) imu_addr = a;
        }
        log_line("f1) %d direcciones responden%s", found, imu_addr ? "; LSM6DS3TR-C encontrado" : "");
        if (found) break;   /* sin respuestas sin pull-up: se repite una vez con el pull-up débil */
    }
    if (!opened) {
        log_line("f1) ni con el pull-up débil quedan las dos líneas en 1: algo sostiene el bus en bajo. No se escanea");
        return;
    }
    if (imu_addr) {
        uint8_t r = LSM6_CTRL1_XL, v[2] = {0};
        if (reg_read(imu_addr, &r, 1, v, 2) == 0) {
            imu_on = v[0] != 0 || v[1] != 0;
            log_line("f1) IMU 0x%02x: CTRL1_XL = 0x%02x, CTRL2_G = 0x%02x → %s", imu_addr, v[0], v[1],
                     imu_on ? "ya configurado (no se escribe nada; f2 lo lee así)" : "apagado; para leerlo hace falta G (2 escrituras)");
        }
    }
}

/* ---- variante de placa [BOBBY-ARTE]: GPIO0 y GPIO21 se reparten la habilitación de las patas y la señal del servo
 * S0. Los sensores de pie (0x40 y 0x41) solo responden con la habilitación en alto, y devuelven su propia dirección
 * como ID. Es la misma prueba que hace el firmware de fábrica al arrancar: solo niveles fijos (sin PWM) y una lectura
 * de 1 byte. Al terminar, la habilitación queda en alto (patas alimentadas, para f2) y el pin del servo como entrada. */
#define PIN_A 21
#define PIN_B 0
#define FOOT_L 0x40
#define FOOT_R 0x41
static int foot_en = -1;   /* GPIO de la habilitación de las patas, si ya se supo */

static int feet_answer(void)
{
    uint8_t l = 0, r = 0;
    int okl = i2c_master_read_from_device(I2C_PORT, FOOT_L, &l, 1, pdMS_TO_TICKS(50)) == ESP_OK;
    int okr = i2c_master_read_from_device(I2C_PORT, FOOT_R, &r, 1, pdMS_TO_TICKS(50)) == ESP_OK;
    log_line("    pies: 0x40 %s%02x, 0x41 %s%02x", okl ? "= 0x" : "error ", l, okr ? "= 0x" : "error ", r);
    return okl && okr && l == FOOT_L && r == FOOT_R;
}

static int try_enable(int en, int other)
{
    gpio_config_t io = {.pin_bit_mask = 1ULL << en | 1ULL << other, .mode = GPIO_MODE_OUTPUT,
                        .pull_up_en = GPIO_PULLUP_DISABLE, .pull_down_en = GPIO_PULLDOWN_DISABLE};
    gpio_config(&io);
    gpio_set_level(other, 0);
    gpio_set_level(en, 1);
    vTaskDelay(pdMS_TO_TICKS(100));
    log_line("  GPIO%d alto, GPIO%d bajo, 100 ms:", en, other);
    return feet_answer();
}

void sensors_legs_enable(void)
{
    gpio_config_t io = {.pin_bit_mask = 1ULL << PIN_B, .mode = GPIO_MODE_OUTPUT};
    gpio_config(&io);
    gpio_set_level(PIN_B, 1);
    foot_en = PIN_B;
    log_line("patas: GPIO%d en alto (habilitación, placa \"new servo\")", PIN_B);
}

void sensors_board_variant(void)
{
    if (!bus_up) { log_line("P) primero g: hace falta el bus I2C abierto"); return; }
    log_line("== P) variante de placa: habilitación de patas en GPIO21 o en GPIO0 (sensores de pie 0x40/0x41) ==");
    int en = -1;
    if (try_enable(PIN_A, PIN_B)) en = PIN_A;
    else if (try_enable(PIN_B, PIN_A)) en = PIN_B;
    int servo = en == PIN_A ? PIN_B : PIN_A;
    if (en < 0) {
        gpio_reset_pin(PIN_A);
        gpio_set_direction(PIN_A, GPIO_MODE_INPUT);
        gpio_reset_pin(PIN_B);
        gpio_set_direction(PIN_B, GPIO_MODE_INPUT);
        log_line("P) los pies no responden con ninguno de los dos: variante sin resolver. GPIO0 y GPIO21 vuelven a ser entradas");
        return;
    }
    gpio_set_level(en, 1);
    gpio_reset_pin(servo);
    gpio_set_direction(servo, GPIO_MODE_INPUT);
    foot_en = en;
    log_line("P) placa \"%s servo\": habilitación de patas = GPIO%d (queda en alto); servo S0 = GPIO%d (queda como entrada)",
             en == PIN_A ? "old" : "new", en, servo);
}

void sensors_imu_enable(void)
{
    if (!bus_up || !imu_addr) { log_line("f1) G: primero g, y solo si respondió un LSM6DS3TR-C"); return; }
    if (imu_on) { log_line("f1) G: el IMU ya está configurado; no se escribe nada"); return; }
    /* Las 2 escrituras documentadas en sesion1.md: acelerómetro y giróscopo a 104 Hz, ±2 g y 250 °/s. Son volátiles:
       el original vuelve a configurar el IMU al arrancar. */
    uint8_t w1[2] = {LSM6_CTRL1_XL, 0x40}, w2[2] = {LSM6_CTRL2_G, 0x40};
    int ok = i2c_master_write_to_device(I2C_PORT, (uint8_t)imu_addr, w1, 2, pdMS_TO_TICKS(50)) == ESP_OK &&
             i2c_master_write_to_device(I2C_PORT, (uint8_t)imu_addr, w2, 2, pdMS_TO_TICKS(50)) == ESP_OK;
    uint8_t r = LSM6_CTRL1_XL, v[2] = {0};
    reg_read(imu_addr, &r, 1, v, 2);
    imu_on = ok && v[0] == 0x40 && v[1] == 0x40;
    log_line("f1) G: CTRL1_XL = 0x40 y CTRL2_G = 0x40 escritos (%s); se leen 0x%02x y 0x%02x", ok ? "ok" : "ERROR", v[0], v[1]);
}

/* ---- muestras ---- */
typedef struct {
    uint32_t t_ms; uint16_t mv[N_ADC]; uint8_t din; int16_t imu[6]; uint8_t imu_ok;
    uint8_t foot[2][5]; uint8_t foot_ok;   /* sensores de pie 0x40/0x41, 5 bytes crudos cada uno, si P los encendió */
} sample;

static void take(sample *s)
{
    s->t_ms = (uint32_t)now_ms();
    for (int i = 0; i < N_ADC; i++) {
        int raw = adc1_get_raw(ADC_PINS[i].ch), mv = 0;
        if (raw < 0) raw = 0;
        if (cali && adc_cali_raw_to_voltage(cali, raw, &mv) == ESP_OK) s->mv[i] = (uint16_t)mv;
        else s->mv[i] = (uint16_t)raw;
    }
    s->din = (uint8_t)gpio_get_level(DIN_GPIO);
    s->imu_ok = 0;
    if (bus_up && imu_addr && imu_on) {
        uint8_t r = LSM6_OUTX_L_G, b[12];
        if (reg_read(imu_addr, &r, 1, b, 12) == 0) {
            for (int k = 0; k < 6; k++) s->imu[k] = (int16_t)(b[2 * k] | b[2 * k + 1] << 8);
            s->imu_ok = 1;
        }
    }
    /* [BOBBY-ARTE]: 5 bytes por sensor, leídos sin registro (probable: dos valores de 16 bits y un byte de validez) */
    s->foot_ok = bus_up && foot_en >= 0 &&
                 i2c_master_read_from_device(I2C_PORT, FOOT_L, s->foot[0], 5, pdMS_TO_TICKS(20)) == ESP_OK &&
                 i2c_master_read_from_device(I2C_PORT, FOOT_R, s->foot[1], 5, pdMS_TO_TICKS(20)) == ESP_OK;
}

static void print_sample(const char *tag, const sample *s)
{
    char line[256];
    int o = snprintf(line, sizeof line, "%s t=%lu", tag, (unsigned long)s->t_ms);
    for (int i = 0; i < N_ADC; i++) o += snprintf(line + o, sizeof line - o, " a%d=%u", ADC_PINS[i].gpio, s->mv[i]);
    o += snprintf(line + o, sizeof line - o, " d%d=%u", DIN_GPIO, s->din);
    if (s->imu_ok)   /* con G: ±2 g (0.061 mg) y 250 °/s; con la configuración de fábrica [BOBBY-ARTE]: ±8 g (4096 = 1 g) y ±2000 °/s */
        o += snprintf(line + o, sizeof line - o, " g=%d,%d,%d a=%d,%d,%d", s->imu[0], s->imu[1], s->imu[2], s->imu[3], s->imu[4], s->imu[5]);
    if (s->foot_ok)
        for (int k = 0; k < 2; k++)
            o += snprintf(line + o, sizeof line - o, " pie%c=%02x%02x%02x%02x%02x", k ? 'R' : 'L', s->foot[k][0], s->foot[k][1],
                          s->foot[k][2], s->foot[k][3], s->foot[k][4]);
    log_line("%s", line);
}

static void stream_task(void *arg)
{
    (void)arg;
    TickType_t wake = xTaskGetTickCount();
    for (;;) {
        if (streaming) { sample s; take(&s); print_sample("f2", &s); }
        if (touching) {
            char line[128];
            int o = snprintf(line, sizeof line, "f2b t=%lu", (unsigned long)now_ms());
            for (int i = 0; i < N_TOUCH; i++) {
                uint16_t v = 0;
                esp_err_t e = touch_pad_read_raw_data(TOUCH_PINS[i].pad, &v);
                o += snprintf(line + o, sizeof line - o, e == ESP_OK ? " t%d=%u" : " t%d=error", TOUCH_PINS[i].gpio, v);
            }
            log_line("%s", line);
        }
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(50));
    }
}

static void stream_task_start(void)
{
    static TaskHandle_t task;
    if (!task) xTaskCreate(stream_task, "f2", 4096, NULL, 4, &task);
}

void sensors_stream_toggle(void)
{
    stream_task_start();
    if (!streaming && touching) { log_line("f2) primero apaga f2b (t): usan los mismos pines 32 y 33"); return; }   /* 27 no es ADC */
    streaming = !streaming;
    log_line("f2) lectura continua %s (ADC en mV%s; d%d = GPIO%d cargador; g/a = IMU crudo)", streaming ? "ENCENDIDA" : "apagada",
             cali ? ", calibrado" : " sin calibrar: valores crudos", DIN_GPIO, DIN_GPIO);
}

void sensors_pull_cycle(void)
{
    /* GPIO36 es solo entrada y no tiene pull interno: la tecla queda sin efecto */
    (void)pull_mode;
    log_line("f2) GPIO%d no tiene pull-up ni pull-down internos: sin cambio", DIN_GPIO);
}

/* ---- f2b: sensor táctil capacitivo interno en los tres pads del original, GPIO27/32/33 [BOBBY-ARTE] ----
 * El periférico carga y descarga el pin entre 0.5 V y 2.7 V (valores por omisión de ESP-IDF) con fuentes de corriente
 * del orden de µA, y cuenta los ciclos. No lo maneja como salida digital. Al apagarlo, los dos pines vuelven a ser
 * entradas sin pull. */
void sensors_touch_toggle(void)
{
    stream_task_start();
    if (!touching) {
        if (streaming) { log_line("f2b) primero apaga f2 (c): usan los pines 32 y 33"); return; }
        if (recording) { log_line("f2b) f3 está registrando: espera a que termine"); return; }
        if (touch_pad_init() != ESP_OK) { log_line("f2b) no pude iniciar el sensor táctil"); return; }
        touch_pad_set_voltage(TOUCH_PAD_HIGH_VOLTAGE_THRESHOLD, TOUCH_PAD_LOW_VOLTAGE_THRESHOLD, TOUCH_PAD_ATTEN_VOLTAGE_THRESHOLD);
        for (int i = 0; i < N_TOUCH; i++) touch_pad_config(TOUCH_PINS[i].pad, 0);   /* umbral 0: sin interrupción */
        touch_pad_set_fsm_mode(TOUCH_FSM_MODE_TIMER);
        touching = 1;
        log_line("f2b) sensor táctil ENCENDIDO en GPIO27 (T7), GPIO33 (T8) y GPIO32 (T9); valor crudo cada 50 ms (baja al tocar)");
    } else {
        touching = 0;
        vTaskDelay(pdMS_TO_TICKS(60));   /* deja terminar la lectura en curso */
        touch_pad_deinit();
        for (int i = 0; i < N_TOUCH; i++) {
            gpio_reset_pin(TOUCH_PINS[i].gpio);
            gpio_set_direction(TOUCH_PINS[i].gpio, GPIO_MODE_INPUT);
            gpio_set_pull_mode(TOUCH_PINS[i].gpio, GPIO_FLOATING);
        }
        /* los dos pines vuelven al ADC de f2 */
        adc1_config_channel_atten(ADC1_CHANNEL_4, ADC_ATTEN_DB_12);
        adc1_config_channel_atten(ADC1_CHANNEL_5, ADC_ATTEN_DB_12);
        log_line("f2b) sensor táctil APAGADO; GPIO27, 32 y 33 de vuelta como entradas sin pull");
    }
}

/* ---- f3: registro en RAM, para leer con el USB desconectado (sin consola) ---- */
#define REC_MAX 1200   /* 20 min a 1 s */
static sample rec[REC_MAX];

static void rec_task(void *arg)
{
    (void)arg;
    TickType_t wake = xTaskGetTickCount();
    while (recording && rec_n < REC_MAX) {
        take(&rec[rec_n]);
        rec_n++;
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(1000));
    }
    recording = 0;
    vTaskDelete(NULL);
}

void sensors_rec_start(void)
{
    if (recording) { log_line("f3) ya está registrando (%d muestras)", rec_n); return; }
    rec_n = 0;
    recording = 1;
    xTaskCreate(rec_task, "f3", 4096, NULL, 4, NULL);
    log_line("f3) registro en RAM cada 1 s, hasta %d min. Ya puedes desconectar el USB; al volver, V imprime todo", REC_MAX / 60);
}

void sensors_rec_print(void)
{
    int n = rec_n;
    log_line("== f3) %d muestras%s ==", n, recording ? " (sigue registrando)" : "");
    for (int i = 0; i < n; i++) {
        print_sample("f3", &rec[i]);
        if (i % 20 == 19) vTaskDelay(pdMS_TO_TICKS(30));   /* deja respirar a la consola */
    }
    log_line("== f3) fin ==");
}
