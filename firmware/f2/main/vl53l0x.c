/* vl53l0x.c — sensor de distancia de la cara (VL53L0X en 0x29; HALLAZGOS: responde con ID 0xEE).
 * El original lo inicializa con la secuencia estándar de ST (HARDWARE.md §1 [BOBBY-ARTE]: 0xFF páginas, 0x91, 0x4E = 0x2C,
 * 0xB6 = 0xB4…) y mide de a una: 0x00 = 0x01, espera, lee 0x1E (2 bytes) y limpia con 0x0B = 0x01. Aquí, la misma
 * secuencia (la versión compacta de la API de ST) y una medición sin bloquear, paso a paso desde la tarea de sensores. */
#include "vl53l0x.h"

#include "driver/i2c.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define ADDR 0x29
static int port, stop_var, ready;

static int wr(uint8_t reg, uint8_t v)
{
    uint8_t b[2] = {reg, v};
    return i2c_master_write_to_device(port, ADDR, b, 2, pdMS_TO_TICKS(20)) == ESP_OK ? 0 : -1;
}
static int rd(uint8_t reg, uint8_t *out, size_t n)
{
    if (i2c_master_write_to_device(port, ADDR, &reg, 1, pdMS_TO_TICKS(20)) != ESP_OK) return -1;
    return i2c_master_read_from_device(port, ADDR, out, n, pdMS_TO_TICKS(20)) == ESP_OK ? 0 : -1;
}
static int rd8(uint8_t reg) { uint8_t v; return rd(reg, &v, 1) ? -1 : v; }
static int wr16(uint8_t reg, uint16_t v)
{
    uint8_t b[3] = {reg, (uint8_t)(v >> 8), (uint8_t)v};
    return i2c_master_write_to_device(port, ADDR, b, 3, pdMS_TO_TICKS(20)) == ESP_OK ? 0 : -1;
}

/* espera a que (reg & mask) sea != 0 (want = 1) o == 0 (want = 0); −1 si pasan ~200 ms */
static int wait_bits(uint8_t reg, uint8_t mask, int want)
{
    for (int i = 0; i < 100; i++) {
        int v = rd8(reg);
        if (v < 0) return -1;
        if (((v & mask) != 0) == want) return 0;
        vTaskDelay(pdMS_TO_TICKS(2));
    }
    return -1;
}

static int single_ref_cal(uint8_t vhv_init)
{
    if (wr(0x00, 0x01 | vhv_init) || wait_bits(0x13, 0x07, 1)) return -1;
    return wr(0x0B, 0x01) || wr(0x00, 0x00) ? -1 : 0;
}

/* tabla de ajustes por omisión de ST (DefaultTuningSettings) */
static const uint8_t TUNING[][2] = {
    {0xFF, 0x01}, {0x00, 0x00}, {0xFF, 0x00}, {0x09, 0x00}, {0x10, 0x00}, {0x11, 0x00}, {0x24, 0x01}, {0x25, 0xFF},
    {0x75, 0x00}, {0xFF, 0x01}, {0x4E, 0x2C}, {0x48, 0x00}, {0x30, 0x20}, {0xFF, 0x00}, {0x30, 0x09}, {0x54, 0x00},
    {0x31, 0x04}, {0x32, 0x03}, {0x40, 0x83}, {0x46, 0x25}, {0x60, 0x00}, {0x27, 0x00}, {0x50, 0x06}, {0x51, 0x00},
    {0x52, 0x96}, {0x56, 0x08}, {0x57, 0x30}, {0x61, 0x00}, {0x62, 0x00}, {0x64, 0x00}, {0x65, 0x00}, {0x66, 0xA0},
    {0xFF, 0x01}, {0x22, 0x32}, {0x47, 0x14}, {0x49, 0xFF}, {0x4A, 0x00}, {0xFF, 0x00}, {0x7A, 0x0A}, {0x7B, 0x00},
    {0x78, 0x21}, {0xFF, 0x01}, {0x23, 0x34}, {0x42, 0x00}, {0x44, 0xFF}, {0x45, 0x26}, {0x46, 0x05}, {0x40, 0x40},
    {0x0E, 0x06}, {0x20, 0x1A}, {0x43, 0x40}, {0xFF, 0x00}, {0x34, 0x03}, {0x35, 0x44}, {0xFF, 0x01}, {0x31, 0x04},
    {0x4B, 0x09}, {0x4C, 0x05}, {0x4D, 0x04}, {0xFF, 0x00}, {0x44, 0x00}, {0x45, 0x20}, {0x47, 0x08}, {0x48, 0x28},
    {0x67, 0x00}, {0x70, 0x04}, {0x71, 0x01}, {0x72, 0xFE}, {0x76, 0x00}, {0x77, 0x00}, {0xFF, 0x01}, {0x0D, 0x01},
    {0xFF, 0x00}, {0x80, 0x01}, {0x01, 0xF8}, {0xFF, 0x01}, {0x8E, 0x01}, {0x00, 0x01}, {0xFF, 0x00}, {0x80, 0x00},
};

int vl53_init(int i2c_port)
{
    port = i2c_port;
    ready = 0;
    /* medido 2026-11-02: tras un reinicio solo del ESP32 el sensor sigue encendido y puede quedar a media medida o en
       otra página de registros (0xFF ≠ 0): el ID no se leía y se quedaba sin distancia (a veces 2 min de reintentos).
       Antes de leerlo: página 0, parar, y el reinicio por software del sensor (0xBF = 0, luego 1). Errores aquí no
       cuentan (en reinicio no contesta). Luego, como el original, el ID hasta 5 veces cada 50 ms [BOBBY-ARTE] */
    wr(0xFF, 0x00);
    wr(0x80, 0x00);
    wr(0x00, 0x00);
    wr(0xBF, 0x00);
    vTaskDelay(pdMS_TO_TICKS(2));
    wr(0xBF, 0x01);
    vTaskDelay(pdMS_TO_TICKS(5));
    int id = -1;
    for (int i = 0; i < 5 && (id = rd8(0xC0)) != 0xEE; i++) vTaskDelay(pdMS_TO_TICKS(50));
    if (id != 0xEE) return -1;          /* ID del modelo */
    int v = rd8(0x89);                  /* E/S a 2.8 V */
    if (v < 0 || wr(0x89, (uint8_t)(v | 0x01)) || wr(0x88, 0x00)) return -2;
    if (wr(0x80, 0x01) || wr(0xFF, 0x01) || wr(0x00, 0x00)) return -2;
    stop_var = rd8(0x91);
    if (stop_var < 0 || wr(0x00, 0x01) || wr(0xFF, 0x00) || wr(0x80, 0x00)) return -2;
    v = rd8(0x60);                      /* sin los límites MSRC y PRE_RANGE */
    if (v < 0 || wr(0x60, (uint8_t)(v | 0x12)) || wr16(0x44, 32) || wr(0x01, 0xFF)) return -3;   /* tasa mínima 0.25 MCPS */

    /* SPAD de referencia (como el original: 0x4E = 0x2C, 0xB6 = 0xB4) */
    if (wr(0x80, 0x01) || wr(0xFF, 0x01) || wr(0x00, 0x00) || wr(0xFF, 0x06)) return -4;
    v = rd8(0x83);
    if (v < 0 || wr(0x83, (uint8_t)(v | 0x04)) || wr(0xFF, 0x07) || wr(0x81, 0x01) || wr(0x80, 0x01) || wr(0x94, 0x6B) ||
        wr(0x83, 0x00) || wait_bits(0x83, 0xFF, 1) || wr(0x83, 0x01))
        return -4;
    int t = rd8(0x92);
    if (t < 0 || wr(0x81, 0x00) || wr(0xFF, 0x06)) return -4;
    v = rd8(0x83);
    if (v < 0 || wr(0x83, (uint8_t)(v & ~0x04)) || wr(0xFF, 0x01) || wr(0x00, 0x01) || wr(0xFF, 0x00) || wr(0x80, 0x00)) return -4;
    int count = t & 0x7F, aperture = (t >> 7) & 1;
    uint8_t map[6];
    if (rd(0xB0, map, 6) || wr(0xFF, 0x01) || wr(0x4F, 0x00) || wr(0x4E, 0x2C) || wr(0xFF, 0x00) || wr(0xB6, 0xB4)) return -4;
    int first = aperture ? 12 : 0, on = 0;
    for (int i = 0; i < 48; i++) {
        if (i < first || on == count) map[i / 8] &= (uint8_t)~(1 << (i % 8));
        else if ((map[i / 8] >> (i % 8)) & 1) on++;
    }
    uint8_t b[7] = {0xB0, map[0], map[1], map[2], map[3], map[4], map[5]};
    if (i2c_master_write_to_device(port, ADDR, b, 7, pdMS_TO_TICKS(20)) != ESP_OK) return -4;

    for (size_t i = 0; i < sizeof TUNING / sizeof *TUNING; i++)
        if (wr(TUNING[i][0], TUNING[i][1])) return -5;
    v = rd8(0x84);   /* interrupción "medida lista", activa en bajo */
    if (wr(0x0A, 0x04) || v < 0 || wr(0x84, (uint8_t)(v & ~0x10)) || wr(0x0B, 0x01)) return -6;
    /* calibraciones VHV y de fase */
    if (wr(0x01, 0x01) || single_ref_cal(0x40) || wr(0x01, 0x02) || single_ref_cal(0x00) || wr(0x01, 0xE8)) return -7;
    ready = 1;
    return 0;
}

/* Medición sin bloquear. Cada llamada avanza un paso; devuelve mm cuando hay una nueva, −1 si todavía no.
   Fuera de alcance: VL53_FAR. */
int vl53_step(void)
{
    static int phase;
    if (!ready) return -1;
    if (phase == 0) {
        if (wr(0x80, 0x01) || wr(0xFF, 0x01) || wr(0x00, 0x00) || wr(0x91, (uint8_t)stop_var) || wr(0x00, 0x01) ||
            wr(0xFF, 0x00) || wr(0x80, 0x00) || wr(0x00, 0x01))
            return -1;
        phase = 1;
        return -1;
    }
    int st = rd8(0x13);
    if (st < 0 || !(st & 0x07)) return -1;   /* todavía midiendo (~33 ms) */
    uint8_t r[2];
    int mm = rd(0x1E, r, 2) ? -1 : (r[0] << 8 | r[1]);
    wr(0x0B, 0x01);
    phase = 0;
    if (mm < 0) return -1;
    return mm >= 8190 || mm == 20 ? VL53_FAR : mm;   /* 8190/8191 = sin eco; 20 = medida inválida */
}
