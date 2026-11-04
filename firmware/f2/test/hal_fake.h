/* hal_fake — HAL de la PC para alma-f2: reloj simulado, K210 falso con guion, sensores falsos, servos que
 * registran los ángulos pedidos, SPIFFS leída de storage.bin y flash de memory_store en RAM. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "alma_mem_flash.h"
#include "f2_hal.h"

/* ---- reloj: fake_run avanza de a 1 ms, entrega los bytes del K210 que tocan y llama app_step cada F2_STEP_MS ---- */
void fake_run(int64_t ms);
extern int64_t fake_ms;

/* ---- K210 falso ---- */
typedef enum { K_REPLY_SAM, K_REPLY_EL, K_SILENT } fake_k210_mode;
extern fake_k210_mode fake_k210;
void fake_k210_send(int64_t delay_ms, const uint8_t *p, size_t n);   /* bytes del K210 al ESP32 */
void fake_k210_small(int64_t delay_ms, uint8_t cmd, uint8_t d0, uint8_t d1, uint8_t d2);
/* Respuesta del K210 falso a cada 0A (124 bytes, 03 "Caras"). has_face = −1: no contesta. */
void fake_face_set(int has_face, int id, int x, int y, int w, int h, const char *name);
extern char fake_ota_running[8], fake_ota_boot[8], fake_ota_prev[8];   /* firmware por Wi-Fi (ota.h) */
extern int fake_ota_restarts, fake_ota_trial_flag;
extern int fake_face_polls;          /* 0A recibidos (no van a fake_txs) */
#define FAKE_FILE_MAX 300000
extern int fake_file_ack_cmd;        /* CMD del acuse (21, 24 o 33); 0 = el K210 no contesta */
extern int fake_file_reject, fake_file_fatal;   /* trozos que rechaza antes de aceptar; 1 = contesta 0x7FF */
extern int fake_spi_n, fake_file_bad;            /* transacciones SPI; cabeceras o sumas mal formadas */
extern uint8_t fake_file_rx[FAKE_FILE_MAX];      /* el archivo tal como lo reconstruye el K210 falso */
extern size_t fake_file_rx_n;
#define FAKE_MIC_LEN 3200            /* 100 ms de PCM de 16 kHz */
/* foto: a ext 40 contesta 04 len (1024 B cada 20 ms) y 05; los bytes van invertidos por palabra, como el micrófono.
   fake_photo_late = n: las primeras n peticiones contestan 05 sin datos (la foto aún no estaba) */
#define FAKE_PHOTO_LEN 25000   /* tres trozos de 10 240 como el K210 de verdad */
#define FAKE_PHOTO_CHUNK 10240
extern uint8_t fake_photo[FAKE_PHOTO_LEN];
extern int fake_photo_late, fake_photo_reads, fake_photo_bad_hdr;
extern int fake_mic_chunks, fake_mic_reads, fake_mic_bad_hdr;   /* trozos que manda tras 4B 00; lecturas; cabeceras malas */
extern int fake_mic_on_4b;          /* 1 = manda el audio al recibir 4B 00 (por omisión); 0 = lo ignora */
extern int fake_mic_on_06;          /* 1 = manda el audio al recibir 06 con bit0, bit1 y bit12 (por omisión) */
extern int fake_mic_06;             /* 06 recibidos */
extern int fake_legs_on, fake_legs_offs;   /* corriente de las patas (hal_legs_power) */
void fake_mic_stream(int64_t ms);   /* el K210 falso empuja fake_mic_chunks trozos (01 len) y 0B 00, desde ms */
extern int fake_del_reply;           /* 1 = contesta el extendido 4F al borrar una cara (50 id); 0 = no contesta */
extern int fake_reg_reply;           /* d0 del 0F con que contesta al registro de cara; −1 = no contesta */
#define FAKE_TX_MAX 4096
typedef struct { int64_t t; uint8_t b[256]; size_t n; } fake_tx;
extern fake_tx fake_txs[FAKE_TX_MAX];
extern int fake_n_tx;
extern int64_t fake_resetn_t[8];
extern int fake_n_resetn;

/* ---- servos ---- */
#define FAKE_SERVO_MAX 200000
typedef struct { int64_t t; int idx; float deg; char op; } fake_servo_ev;   /* op: 's' set, 'h' hold, 'r' release, 'R' restore */
extern fake_servo_ev fake_servo[FAKE_SERVO_MAX];
extern int fake_n_servo;
extern float fake_servo_deg[HAL_SERVOS];
extern int fake_audio_stops;

/* ---- sensores ---- */
extern hal_sensors fake_sensors;
extern float fake_yaw;   /* rumbo del giroscopio (home.c) */
extern int fake_base_polls;
void fake_base_set(int found, int cx, int h);   /* found −1 = el K210 no contesta 35 */

/* ---- flash ---- */
int  fake_spiffs_load(const char *storage_bin);
extern alma_mem_file fake_mem;      /* región de memory_store en RAM; cuenta borrados y escrituras */
extern int fake_mem_ok;

/* ---- registro ---- */
int  fake_log_contains(const char *s);
int  fake_log_count(const char *s);   /* veces que aparece en el registro */
void fake_log_clear(void);
void fake_log_echo(int on);
void fake_reset(void);               /* deja todo como recién encendido (salvo SPIFFS y flash) */
