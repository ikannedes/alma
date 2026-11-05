/* f2_hal.h — lo que alma-f2 necesita del hardware. La aplicación (app/) es C portable y se compila igual para
 * el ESP32 (main/hal_esp32.c) y para la PC (test/hal_fake.c, con un K210 falso, sensores falsos y servos que
 * registran los ángulos pedidos). Donde 02 dice PENDIENTE, la implementación del ESP32 lo marca con
 * "// PENDIENTE: 02" y alma/firmware/f2/PENDIENTES.md dice qué dato de la sesión 1 lo llena. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "alma_mem_flash.h"
#include "f2_config.h"

/* ---- memoria ----
 * EXT_RAM_BSS_ATTR (ESP-IDF, esp_attr.h): la variable va a la PSRAM y no a la DRAM interna (RAM-PROPUESTA.md, A).
 * Solo para variables que empiezan en cero y que ningún ISR toca con la caché apagada. En la PC no hace nada. */
#ifdef ESP_PLATFORM
#include "esp_attr.h"
#else
#define EXT_RAM_BSS_ATTR
#endif

/* ---- reloj y registro ---- */
int64_t hal_now_ms(void);                        /* monotónico desde el arranque */
void hal_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));   /* una línea con [segundos.ms] */
void *hal_big_alloc(size_t n);   /* búfer grande en PSRAM (la cara de una fiesta); NULL si no hay */
void hal_big_free(void *p);
size_t hal_big_largest(void);   /* el bloque libre más grande de la PSRAM (para el registro) */

/* ---- firmware nuevo por Wi-Fi (ota.h): se escribe la partición app que no corre ---- */
int  hal_ota_begin(size_t size);                 /* prepara la partición libre; −1 si no hay o no cabe */
int  hal_ota_write(const uint8_t *buf, size_t n);
int  hal_ota_end_and_check(const char *sha256_hex);   /* imagen válida y SHA-256 de lo escrito = el pedido; 0 = sí */
void hal_ota_abort(void);
void hal_ota_set_boot_and_restart(void);         /* arranque = la verificada, deja la prueba en RAM RTC, reinicia */
const char *hal_ota_running_label(void);
/* Corriente de las patas (servos y sensores de pie, GPIO0 en esta placa [BOBBY-ARTE]). Los servos guardan su posición sin
   señal: solo sin corriente quedan flojos (dueño, 2026-11-03, en la base). Al volver a 1 espera a que despierten; cualquier
   hal_servo_set la vuelve a prender. Sin corriente, los pies repiten su última lectura buena */
void hal_legs_power(int on);
int  hal_legs_on(void);
unsigned hal_keep_get(void);        /* banderas que sobreviven a un reinicio por software (no a un apagón); 0 al encender */
void hal_keep_set(unsigned v);
int  hal_ota_trial(char *prev, size_t cap);      /* 1 = este arranque es a prueba; prev = de dónde venía */
void hal_ota_trial_confirm(void);
void hal_ota_trial_revert(void);                 /* arranque = la anterior y reinicia */
int  hal_battery_mv(void);   /* voltaje de la batería (mV) o −1 si aún no hay lectura (prueba de batería, 2026-11-02) */
long hal_rlog_take(char *out, size_t cap);   /* registro por Wi-Fi (rlog.h), con el candado del registro */
void hal_heap_mark(const char *phase);           /* ALMA_HEAP en el arranque: heap interno libre por fase (3.1) */

/* ---- K210 (03): UART1 TX GPIO12 / RX GPIO4 a 1 Mbaud, RESETN GPIO22 ---- */
void hal_k210_tx(const uint8_t *frame, size_t n);
void hal_k210_resetn_pulse(int low_ms);          /* RESETN en bajo low_ms y de vuelta en alto */
/* SPI al K210 (HALLAZGOS §6 [BOBBY-ARTE]: HSPI, MOSI 15, MISO 2, SCLK 14, CS 13 a mano, modo 1, 8 MHz). Una
   transacción con CS bajo de principio a fin. 0 si se mandó. */
int  hal_k210_spi_write(const uint8_t *p, size_t n);
int  hal_k210_spi_read(uint8_t *p, size_t n);   /* el K210 → ESP32 (micrófono, fotos); n múltiplo de 64, hasta 16384 + 64 */
/* alma_test.avi incrustado (tools/make_test_avi.py): la animación propia de prueba para la pantalla */
const uint8_t *hal_test_avi(size_t *n);
const uint8_t *hal_test_sticker(size_t *n);   /* PNG de prueba (globo con hamburguesa) para encimar: tecla K */
/* pesos de la red que decide (alma_brain.almb incrustado; tools/brain/train.py). NULL si no hay */
const uint8_t *hal_brain_weights(size_t *n);
void hal_delay_us(uint32_t us);
/* Los bytes recibidos los entrega la plataforma con hal_k210_rx_feed (hal_k210.h), desde su propia tarea. */

/* ---- servos (02): índice interno del original: 0 GPIO21 pierna izq., 1 GPIO25 pierna der., 2 GPIO5 pie izq.,
 * 3 GPIO26 pie der. ---- */
#define HAL_SERVOS 4
#define HAL_SERVO_GPIO26 3
#if ALMA_SERVOS_DISABLED
/* Variante remota: ningún comando de servo existe en el binario (sesion1a.md; tools/check_servos_off.py) */
#define hal_servo_set(idx, deg) ((void)(idx), (void)(deg))
#define hal_servo_hold_all() ((void)0)
#define hal_servo_release(idx) ((void)(idx))
#define hal_servo_restore(idx) ((void)(idx))
#else
void hal_servo_set(int idx, float deg);          /* manda la posición; activa el pin si estaba suelto */
void hal_servo_hold_all(void);                   /* reflejo: deja de cambiar posiciones (cada servo se queda donde está) */
void hal_servo_release(int idx);                 /* deja de mandar pulsos a ese pin */
void hal_servo_restore(int idx);                 /* vuelve a mandar pulsos en la última posición (GPIO26 tras escuchar) */
#endif

/* ---- audio: ruta I2S directa de la fase 3 (03, 07). En la F2 no se graba: solo el bloqueo de GPIO26 ---- */
void hal_audio_stop(void);                       /* corta una grabación en curso (regla del ejecutor, 04) */

/* ---- sensores: cada función devuelve el estado ya clasificado; perception detecta los flancos ---- */
enum { HAL_FOOT_L, HAL_FOOT_R };
enum { HAL_FLOOR_FRONT, HAL_FLOOR_REAR };

typedef struct {
    int lifted, shaken, tipped;                  /* IMU (02: chip y dirección PENDIENTE) */
    int touch_pet, touch_tap;                    /* 3 pads (02: pines PENDIENTE) */
    int floor[2][2];                             /* sensores de piso [HAL_FOOT_L/R][HAL_FLOOR_FRONT/REAR]: 1 hay piso,
                                                    0 no, −1 sin dato. Pies 0x40/0x41 (02: qué byte es cuál, PENDIENTE f2) */
    int tof_mm;                                  /* VL53 (02: pines PENDIENTE); −1 = sin lectura */
    float soc_pct;                               /* batería (02: ADC y unidad PENDIENTE) */
    int on_charger;                              /* GPIO36 > 1.2 V: USB o Home Station (medido 2026-10-30: ~2.5 V; sin nada, 0.14 V) */
    int on_usb;                                  /* con cargador y RX0 en alto: USB (el chip USB-serie tiene corriente); en la Home Station, RX0 = 0 */
} hal_sensors;
void hal_sensors_read(hal_sensors *out);
void hal_sensors_debug(void);   /* tecla g: registra lo que ve cada sensor */
void hal_touch_debug(void);     /* teclas g y G: los 3 pads de toque */
/* ¿Home Station o USB? (dueño, 2026-10-30). Los dos suben GPIO36; se miden los otros pines para buscar la diferencia:
   mv[0..3] = GPIO36, 37, 38, 39 en mV (−1 si falla); rx0 = nivel de GPIO3 (RX de la consola, el chip USB lo sostiene
   en alto si tiene corriente); charger = GPIO36 digital. 0 = ok */
typedef struct { int mv[4]; int rx0, charger; } hal_power_probe_t;
int  hal_power_probe(hal_power_probe_t *out);
/* Rumbo integrado del giroscopio (grados, eje vertical = Y del IMU, como la gravedad). Deriva: sirve para giros cortos */
float hal_yaw_deg(void);

/* ---- flash ---- */
/* SPIFFS original, solo lectura en crudo (como sesion1). 0 = leyó n bytes. */
int hal_spiffs_read(uint32_t off, void *buf, size_t n);
uint32_t hal_spiffs_size(void);
/* Región de memory_store (06). Devuelve 0 y llena *out, o −1. */
int hal_mem_flash(alma_mem_flash *out);
