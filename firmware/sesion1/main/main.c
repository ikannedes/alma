/* alma-sesion1: firmware mínimo de la primera sesión en el robot (08: A1.3, A1.4, A1.5, mapa de servos y, en f),
   lectura de sensores).
   Menú de una tecla por la consola (COM9, 115200). No escribe en el flash: no inicia NVS, no monta la SPIFFS
   (la lee en crudo), no toca otadata ni Wi-Fi. */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "driver/uart.h"
#include "esp_app_desc.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_psram.h"
#include "esp_rom_gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "soc/gpio_periph.h"
#include "soc/gpio_struct.h"

#include "k210_link.h"
#include "log_util.h"
#include "mot.h"
#include "sensors.h"
#include "vivo.h"

/* Variante remota (sesion1a.md): ALMA_SERVOS_DISABLED=1 deja fuera del binario todo lo de servos: servo_pwm.c
   no se compila, los GPIO 5, 21, 25 y 26 no se inicializan y las teclas de d), e), paro y soltar no existen. */
#ifndef ALMA_SERVOS_DISABLED
#define ALMA_SERVOS_DISABLED 0
#endif
#if !ALMA_SERVOS_DISABLED
#include "servo_pwm.h"
#endif

#define PWR_EN 23

/* R13: GPIO23 (PWR_EN) en ALTO lo antes posible y nunca se vuelve a tocar. Corre antes de app_main, con
   registros directos para no depender de ningún driver. */
__attribute__((constructor(101))) static void pwr_en_early(void)
{
    esp_rom_gpio_pad_select_gpio(PWR_EN);
    GPIO.out_w1ts = 1u << PWR_EN;
    esp_rom_gpio_connect_out_signal(PWR_EN, SIG_GPIO_OUT_IDX, false, false);
    GPIO.enable_w1ts = 1u << PWR_EN;
}

#if !ALMA_SERVOS_DISABLED
/* .mot de la prueba e): pose pura de 0.8 s, ±10° (S0 80, S1 90, S2 100, S3 80 → todos a 90). */
#define MOT_FILE "/mot/ttt_my_turn.mot"
/* PENDIENTE (02): qué servo es cada Sn. Hipótesis DERIVADA del original: S0..S3 en el orden interno de servo_pwm
   (pierna izq., pierna der., pie izq., pie der.); los pares espejados S0/S1 y S2/S3 de 02 lo apoyan. */
static const int MOT_S_TO_SERVO[4] = {0, 1, 2, 3};
/* R10: rango observado por Sn en los 317 .mot (02). */
static const uint8_t MOT_MIN[4] = {40, 53, 0, 30}, MOT_MAX[4] = {160, 130, 150, 180};

static bool servo_ok;            /* al menos una prueba d) terminada sin paro */
#define SERVO_HELP \
    "  a  d) servo GPIO5  (pie izquierdo)      s  d) servo GPIO21 (S0; placa \"new servo\", medida con P)\n" \
    "  S  d) tambaleo de GPIO21: ±10°, ±25° y ±40° alrededor de 90°\n" \
    "  d  d) servo GPIO25 (pierna derecha)     f  d) servo GPIO26 (pie derecho)\n" \
    "  m  (deshabilitado: el .mot mueve GPIO21 y la duración del cuadro cambió, BOBBY-ARTE)\n" \
    "  0 o espacio  PARO: corta la rampa; los servos se quedan donde están\n" \
    "  x  soltar: deja de mandar pulsos a los 4 servos\n"
#define SERVO_KEYS "asdfS"
#else
#define SERVO_HELP "  (variante remota: sin servos; d), e), paro y soltar no están en este binario)\n"
#define SERVO_KEYS ""
#endif

static const char *boot_ok;      /* secuencia que funcionó, o NULL */
static QueueHandle_t jobs;

static void help(void)
{
    log_lock();
    printf("\n=== alma-sesion1 === (ALMA_DEV_MOTION_ON_USB=%d, ALMA_SERVOS_DISABLED=%d)\n"
           "  h  esta ayuda              i  estado\n"
           "  b  a) k210_boot: [SAM-SPI] y, si no llega 0x47, [EL-GPIO]\n"
           "  1  a) solo [SAM-SPI]        2  a) solo [EL-GPIO]\n"
           "  w  control: stay_wink_1 (frame capturado, PAYLOAD_CS 0x04)\n"
           "  l  c) A1.4 listen_and_think con PAYLOAD_CS 0x71 (CRC-8/MAXIM)\n"
           "  L  c) A1.4 listen_and_think con PAYLOAD_CS 0x5C (suma)\n"
           SERVO_HELP
           "  g  f1) escaneo I2C en GPIO19/18 e IDs        G  f1) IMU: 2 escrituras mínimas (solo LSM6DS3TR-C apagado)\n"
           "  P  f1) variante de placa: habilitación de patas en GPIO21 o GPIO0 (tras g)\n"
           "  c  f2) lectura continua cada 50 ms on/off   p  (sin efecto: GPIO36 no tiene pull interno)\n"
           "  t  f2b) sensor táctil en GPIO27/32/33 on/off (con confirmación)\n"
           "  v  f3) registrar en RAM cada 1 s (20 min)   V  f3) imprimir lo registrado\n"
           "  b) el registro de frames RX/TX está siempre activo.\n",
           ALMA_DEV_MOTION_ON_USB, ALMA_SERVOS_DISABLED);
    log_unlock();
}

static void status(void)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    const esp_app_desc_t *app = esp_app_get_description();
    log_line("estado: app %s %s (IDF %s), partición %s @0x%lx, PSRAM %u bytes, frames RX %lu, desbordes RX %lu, "
             "arranque K210 %s%s",
             app->project_name, app->version, app->idf_ver, run ? run->label : "?", run ? (unsigned long)run->address : 0,
             (unsigned)esp_psram_get_size(), (unsigned long)k210_rx_frames(), (unsigned long)k210_rx_dropped(),
             boot_ok ? boot_ok : "no",
#if ALMA_SERVOS_DISABLED
             ", servos deshabilitados al compilar");
#else
             servo_ok ? ", prueba de servo sí" : ", prueba de servo no");
    for (int i = 0; i < SERVO_COUNT; i++) {
        float g = servo_get(i);
        if (!isnan(g)) log_line("  servo %s en %.1f°", SERVO_NAME[i], g);
    }
#endif
}

#if !ALMA_SERVOS_DISABLED

static void servo_test(int gpio)
{
    int i = servo_index_of_gpio(gpio);
    servo_clear_stop();
    log_line("== d) servo %s: 90 → 80 → 90 → 100 → 90, 1° cada 100 ms ==", SERVO_NAME[i]);
    static const float seq[] = {90, 80, 90, 100, 90};
    for (size_t k = 0; k < sizeof seq / sizeof seq[0]; k++) {
        if (!servo_ramp_to(i, seq[k], 1.0f, 100)) { log_line("PARO: servo %s quieto en %.1f°", SERVO_NAME[i], servo_get(i)); return; }
        log_line("  %s en %.0f° (%.0f µs)", SERVO_NAME[i], seq[k], 500 + seq[k] * 2000 / 180);
        vTaskDelay(pdMS_TO_TICKS(1000));
        if (servo_stop_requested()) { log_line("PARO"); return; }
    }
    servo_ok = true;
    log_line("d) terminado: %s queda en 90°. Anotar qué parte de EMO se movió.", SERVO_NAME[i]);
}

/* Tambaleo de GPIO21 (S0) para confirmarlo con el giroscopio: alrededor de 90°, 5 vaivenes por amplitud, ±10°, ±25° y
   ±40° (nunca fuera de 50°–130°), 1° cada 15 ms. Cada fase se marca en el log. Se corta con 0, espacio o x. */
static void servo_wiggle21(void)
{
    int i = servo_index_of_gpio(21);
    static const float AMP[] = {10, 25, 40};
    servo_clear_stop();
    log_line("== d) tambaleo de %s: 5 vaivenes a ±10°, ±25° y ±40° alrededor de 90°, 1° cada 15 ms ==", SERVO_NAME[i]);
    if (!servo_ramp_to(i, 90, 1.0f, 15)) { log_line("PARO"); return; }
    vTaskDelay(pdMS_TO_TICKS(1000));
    for (size_t a = 0; a < sizeof AMP / sizeof *AMP; a++) {
        log_line("  tambaleo ±%.0f° inicio", AMP[a]);
        for (int r = 0; r < 5; r++)
            if (!servo_ramp_to(i, 90 + AMP[a], 1.0f, 15) || !servo_ramp_to(i, 90 - AMP[a], 1.0f, 15)) {
                log_line("PARO: %s quieto en %.1f°", SERVO_NAME[i], servo_get(i));
                return;
            }
        if (!servo_ramp_to(i, 90, 1.0f, 15)) { log_line("PARO"); return; }
        log_line("  tambaleo ±%.0f° fin", AMP[a]);
        vTaskDelay(pdMS_TO_TICKS(1500));
    }
    log_line("d) tambaleo terminado: %s queda en 90°", SERVO_NAME[i]);
}

static int part_read(void *ctx, uint32_t off, void *buf, size_t n)
{
    return esp_partition_read((const esp_partition_t *)ctx, off, buf, n) != ESP_OK;
}

static void play_mot(void)
{
    if (!boot_ok || !servo_ok) { log_line("e) bloqueado: hace falta a) con 0x47 y d) terminado sin paro"); return; }
    const esp_partition_t *st = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, "storage");
    if (!st) { log_line("e) no encuentro la partición storage"); return; }
    static uint8_t buf[4096];
    long n = spiffs_find(part_read, (void *)st, st->size, MOT_FILE, buf, sizeof buf);
    if (n <= 0 || n % MOT_FRAME_LEN) { log_line("e) no pude leer %s (%ld)", MOT_FILE, n); return; }
    int frames = (int)(n / MOT_FRAME_LEN);
    mot_frame f[16];
    if (frames > 16) { log_line("e) %s tiene %d cuadros; máximo 16", MOT_FILE, frames); return; }
    for (int k = 0; k < frames; k++) {
        if (mot_parse_frame(buf + k * MOT_FRAME_LEN, &f[k]) || f[k].mode != MOT_MODE_POSE) {
            log_line("e) cuadro %d inválido o no es pose: no se reproduce nada", k);
            return;
        }
        for (int s = 0; s < 4; s++)
            if (f[k].s[s] < MOT_MIN[s] || f[k].s[s] > MOT_MAX[s]) { log_line("e) S%d=%u fuera del rango observado", s, f[k].s[s]); return; }
    }
    servo_clear_stop();
    log_line("== e) %s: %d cuadros (la duración se toma como tiempo de transición: PENDIENTE 02) ==", MOT_FILE, frames);
    for (int s = 0; s < 4; s++)        /* a 90° primero, en rampa, los que estén activos; los demás arrancan en 90 */
        if (!servo_ramp_to(MOT_S_TO_SERVO[s], 90, 1.0f, 50)) { log_line("PARO"); return; }
    for (int k = 0; k < frames; k++) {
        log_line("  cuadro %d: S0 %u S1 %u S2 %u S3 %u en %u ms", k, f[k].s[0], f[k].s[1], f[k].s[2], f[k].s[3], f[k].ms);
        float from[4];
        for (int s = 0; s < 4; s++) from[s] = servo_get(MOT_S_TO_SERVO[s]);
        int steps = f[k].ms / 20 > 0 ? f[k].ms / 20 : 1;
        for (int j = 1; j <= steps; j++) {
            if (servo_stop_requested()) { log_line("PARO"); return; }
            for (int s = 0; s < 4; s++) servo_set(MOT_S_TO_SERVO[s], from[s] + (f[k].s[s] - from[s]) * j / steps);
            vTaskDelay(pdMS_TO_TICKS(20));
        }
    }
    log_line("e) terminado");
}
#endif

/* ALMA_VIVO cada 60 s (sesion1a.md): esta app no tiene núcleo, Wi-Fi ni hora */
static void vivo_task(void *arg)
{
    (void)arg;
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(60000));
        char f[128];
        snprintf(f, sizeof f, "estado=- on_charger=- wifi=- hora=- k210_rx=%lu k210=%s", (unsigned long)k210_rx_frames(),
                 boot_ok ? boot_ok : "no");
        vivo_line(f);
    }
}

static void worker(void *arg)
{
    (void)arg;
    char c;
    for (;;) {
        xQueueReceive(jobs, &c, portMAX_DELAY);
        switch (c) {
        case 'b': boot_ok = k210_boot(); log_line("a) resultado: %s", boot_ok ? boot_ok : "NINGUNA secuencia recibió 0x47"); break;
        case '1': if (k210_boot_sam()) boot_ok = "SAM-SPI"; log_line("a) [SAM-SPI]: %s", boot_ok ? "0x47 recibido" : "sin 0x47"); break;
        case '2': if (k210_boot_el()) boot_ok = "EL-GPIO"; log_line("a) [EL-GPIO]: %s", boot_ok ? "0x47 recibido" : "sin 0x47"); break;
        case 'w': k210_play("stay_wink_1", NULL, 0, K210_CS_CRC8); break;
        case 'l': log_line("c) A1.4 con CRC-8/MAXIM (0x71)"); k210_play("listen_and_think", "listen_and_think_000", 1, K210_CS_CRC8); break;
        case 'L': log_line("c) A1.4 con suma (0x5C)"); k210_play("listen_and_think", "listen_and_think_000", 1, K210_CS_SUM); break;
#if !ALMA_SERVOS_DISABLED
        case 'a': servo_test(5); break;
        case 's': servo_test(21); break;
        case 'S': servo_wiggle21(); break;
        case 'd': servo_test(25); break;
        case 'f': servo_test(26); break;
        case 'm': (void)play_mot; log_line("e) deshabilitada en esta versión (BOBBY-ARTE: mueve GPIO21 y la duración del cuadro es transición + espera)"); break;
#endif
        case 'g': sensors_i2c_scan(); break;
        case 'G': sensors_imu_enable(); break;
        case 'P': sensors_board_variant(); break;
        case 'V': sensors_rec_print(); break;
        }
    }
}

void app_main(void)
{
    log_init();
    vivo_boot_line();
#if !ALMA_SERVOS_DISABLED
    servo_init();
#endif
    sensors_init();
    sensors_legs_enable();   /* GPIO0 en alto: habilitación de las patas en esta placa ("new servo", medido con P) */
    k210_link_init();
    ESP_ERROR_CHECK(uart_driver_install(UART_NUM_0, 256, 0, 0, NULL, 0));
    jobs = xQueueCreate(8, 1);
    xTaskCreate(worker, "worker", 6144, NULL, 5, NULL);
    xTaskCreate(vivo_task, "vivo", 3072, NULL, 3, NULL);
    help();
    status();
    for (;;) {
        uint8_t c;
        if (uart_read_bytes(UART_NUM_0, &c, 1, portMAX_DELAY) != 1) continue;
        /* cada byte recibido queda en el log (1A, A10: una 'c' que no llegó a la app no dejó rastro) */
#if !ALMA_SERVOS_DISABLED
        if (c == '0' || c == ' ') {   /* inmediato, fuera de la cola: el paro va antes que el registro */
            servo_request_stop();
            log_line("tecla recibida 0x%02x '%c'", c, c);
            log_line("tecla PARO");
            continue;
        }
#endif
#if !ALMA_SERVOS_DISABLED
        if (c == 'x') {
            servo_request_stop();
            log_line("tecla recibida 0x%02x '%c'", c, c);
            vTaskDelay(pdMS_TO_TICKS(150));   /* más que un paso de rampa (100 ms): la prueba en curso ya salió */
            servo_release_all();
            log_line("servos sueltos (sin pulsos)");
            continue;
        }
#endif
        log_line("tecla recibida 0x%02x '%c'", c, c >= 0x20 && c < 0x7F ? c : '?');
        if (c == 'h' || c == '?') { help(); continue; }
        if (c == 'i') { status(); continue; }
        if (c == '\r' || c == '\n') continue;
        if (c == 'c') { sensors_stream_toggle(); continue; }
        if (c == 'p') { sensors_pull_cycle(); continue; }
        if (c == 't') { sensors_touch_toggle(); continue; }
        if (c == 'v') { sensors_rec_start(); continue; }
        /* !c: strchr encuentra el \0 final con c == 0 */
        if (!c || !strchr("b12wlLgGVP" SERVO_KEYS, c)) { log_line("tecla '%c' sin uso (h = ayuda)", c >= 0x20 && c < 0x7F ? c : '?'); continue; }
        if (xQueueSend(jobs, &c, 0) != pdTRUE) log_line("ocupado: espera a que termine la prueba en curso");
        else log_line("tecla '%c' a la cola de pruebas", c);
    }
}
