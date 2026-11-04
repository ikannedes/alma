/* hal_k210 — enlace con el K210 (03, "Interfaz del componente hal_k210"). Portable: la plataforma solo pone y saca
 * bytes (f2_hal.h). Usa el constructor y el parser de frames de sesion1 (k210_frames.c), con ext_tail = 0. Nada bloquea:
 * el arranque es una máquina de estados que avanza en k210_poll. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "k210_frames.h"

typedef enum { K210_OFF, K210_BOOTING_SAM, K210_READY, K210_FAILED } k210_state;

/* Frames crudos recibidos (03): corto válido, extendido, basura o incompleto, sin filtrar. */
typedef void (*k210_raw_cb)(void *user, k210_rx_kind kind, const uint8_t *p, size_t n, int flags);

void k210_init(void);
void k210_set_rx_handler(k210_raw_cb cb, void *user);
/* [SAM-SPI], esperando 0x47 hasta 5 s; si no llega, K210_FAILED. El respaldo [EL-GPIO] se quitó tras medir [ALMA-1A] (03). */
void k210_boot(void);
void k210_poll(void);                       /* avanza el arranque y, con el K210 listo, pide la cara; en cada vuelta */
k210_state k210_get_state(void);
const char *k210_state_name(void);
uint32_t k210_rx_count(void);      /* frames recibidos (de cualquier tipo) desde el arranque */
uint32_t k210_face_polls(void);    /* 0A enviados */
uint32_t k210_face_replies(void);  /* extendidos 0A recibidos */
const char *k210_boot_used(void);           /* "SAM-SPI" o NULL */

void k210_send_small(uint8_t cmd, uint8_t d0, uint8_t d1, uint8_t d2);
void k210_send_path(const char *path);      /* SEL 0x03 */
/* SEL 0x02. Devuelve 0 si se mandó; −1 si el K210 no está listo o el payload no cabe. */
int  k210_play(const char *avi, const char *mp3_or_null, int mode);
/* Fase del modo de caras del reposo: 0 sin empezar, 1 y 2 en el modo 1, 3 en el modo 4 (CARAS2.md) */
int  k210_face_phase(void);
/* 1 mientras se muestra una animación en el modo 1 (el modo 4 deja los ojos fijos); perception no da caras por perdidas */
int  k210_expressing(void);
/* 1 durante un vistazo en el modo 4 (la detección corre); 0 con los ojos vivos en el modo 1 */
int  k210_scanning(void);
/* Prueba de la base (tecla H): ¿el K210 ve la Home Station? 65 01, 35 01 cada 100 ms, al final 65 FF ×3 y el modo 1 */
int  k210_base_probe(int secs);
/* Prueba de gestos (tecla T): el modo 3 (38 03, piedra-papel-tijera) durante secs; el K210 manda solo un 3F por gesto
   (perception lo registra) y al final vuelven los ojos y el modo 1 */
int  k210_gesture_probe(int secs);
int  k210_gesture_probing(void);
/* Modo base para volver a casa: on = 65 01 y 35 01 cada 100 ms (sin ojos ni vistazos); off = 65 FF ×3 y los ojos */
typedef struct { int found, x, y, w, h, cx, cy; } k210_base_det;
int     k210_base_mode(int on);
int64_t k210_base_last(k210_base_det *out);   /* ms desde la última respuesta 35 (−1 si ninguna) */
int  k210_expr_pending(void);   /* animaciones mandadas sin su 08 00 todavía */
/* Movimientos de ojos en reposo (stay_X_Y y guiños); el ejecutor los apaga al dormir */
void k210_set_idle_eyes(int on);
/* Estilo de los ojos según la personalidad: scale multiplica la pausa entre movimientos (1 = 1.5–4 s); wink = probabilidad de guiño */
void k210_set_eye_style(float scale, float wink);
/* Se llama con cada 08 00 (fin de animación); la secuencia de una rutina manda aquí la siguiente */
void k210_set_done_cb(int (*cb)(void));
/* Cara de respaldo para la siguiente animación: si el K210 contesta 08 00 enseguida (el .avi no está en la SD), va esta */
void k210_set_fallback(const char *avi, const char *mp3_or_null);
/* Revisión de la SD (tecla V): pide cada .avi sin sonido y registra las que no están (08 00 en < 300 ms). Los nombres
   repetidos se quitan; las cadenas deben durar hasta el final. Número de animaciones, o −1 si el K210 está ocupado */
int  k210_check_avis(const char *const *names, int n);
int  k210_checking(void);

/* Registro de una cara nueva: la que está frente a la cámara, con ese nombre (1–31 letras, números, _ o -).
   0 si empezó; −1 si el K210 no está listo, ya hay uno en curso o el nombre no sirve. El resultado, en el estado. */
#define K210_FACE_NAME_MAX 31
typedef enum { K210_REG_IDLE, K210_REG_RUNNING, K210_REG_OK, K210_REG_FAILED, K210_REG_TIMEOUT } k210_reg_state;
int k210_face_register(const char *name);
k210_reg_state k210_face_register_state(void);
/* Olvidar una cara (06, 28 días sin verla): 4F 00, 50 id, espera el extendido 4F, 38 01. Nunca el dueño (id 0).
 * 0 = empezó; −1 = id 0, K210 no listo u ocupado (se reintenta después). */
int k210_face_delete(int id);
/* Micrófono (07, voz tras "Hey EMO"): on = cada trozo de PCM que mande el K210 llega a cb (sin 4B, como el original tras
   la palabra de activación); off = se siguen leyendo pero se tiran. 0 = ok. */
int k210_mic(int on, void (*cb)(const uint8_t *p, size_t n));
int k210_mic_want(void);    /* 06 con bit1: "quiero el audio" (tras la palabra de activación); −1 si no está listo o no armado */
int k210_mic_open(void);    /* 4B 00: abrir el micrófono cuando Alma pregunta (no tras la palabra de activación) */
int k210_mic_ended(void);   /* 1 si el K210 avisó fin de la escucha (0B 00) */
uint32_t k210_mic_chunks(void);   /* trozos recibidos desde k210_mic(1) */
k210_reg_state k210_face_delete_state(void);   /* K210_REG_OK = contestó 4F; K210_REG_TIMEOUT = no contestó */

/* Mandar un archivo al K210 (HALLAZGOS §14): tipo ("test", "avi", "mp3"…), nombre con extensión y los datos, que
   deben seguir vivos hasta que termine. 0 si empezó. Con tipo "test" se reproduce de /test/<nombre>. */
typedef enum { K210_FILE_IDLE, K210_FILE_BUSY, K210_FILE_OK, K210_FILE_FAILED } k210_file_state;
int k210_file_send(const char *type, const char *name, const uint8_t *data, size_t n);
/* Una imagen PNG a 0:/png/<nombre> del K210 (57/54/modo 9/56; mismo estado que k210_file_send). Con "sticker.png" (320×240
   con alfa), k210_sticker(1) la pone encima de la cara que se esté reproduciendo y k210_sticker(0) la quita. */
int k210_image_send(const char *name, const uint8_t *data, size_t n);
void k210_sticker(int on);
k210_file_state k210_file_state_get(void);
uint32_t k210_file_chunks(void);
/* Foto de la cámara del K210 (dueño, 2026-11-01: ver lo que tiene a 10 cm o menos). Como la actividad de pintura del
   original [BOBBY-ARTE]: 67 65 → ext 49 "<nombre>" (la toma y la guarda en /photo/<nombre>.jpg) → 2C → ext 40 con la
   ruta → trozos 04 (SPI, modo 2) hasta 05 → 2D → 67 00 → ext 4E (la borra). name: sin extensión. 0 si empezó. */
typedef enum { K210_PHOTO_IDLE, K210_PHOTO_BUSY, K210_PHOTO_OK, K210_PHOTO_FAILED } k210_photo_state;
#define K210_PHOTO_MAX (128 * 1024)
int k210_photo_take(const char *name);
k210_photo_state k210_photo_state_get(void);
const uint8_t *k210_photo_data(size_t *n);   /* el JPEG, válido hasta k210_photo_release */
void k210_photo_release(void);               /* vuelve a IDLE */
/* Animación por ruta completa (p. ej. "/test/alma_test.avi"); SEL 0x02 */
int k210_play_path(const char *avi_path, const char *mp3_path_or_null, int mode);

/* Pone el modo de caras (38 01) y registra completas las siguientes `dump` respuestas de cara (tecla f) */
void k210_face_mode(int dump);
/* Orden corta de prueba (tecla X + 4 hex): solo órdenes de estado de una lista; 0 si se mandó */
int k210_send_debug(uint8_t cmd, uint8_t d0);

/* Bytes recibidos del UART. La plataforma los entrega desde el bucle principal (nunca desde una interrupción). */
void k210_rx_feed(const uint8_t *p, size_t n);
void k210_rx_silence(void);                 /* la línea quedó en silencio: lo que esté a medias sale como INCOMPLETO */

/* PENDIENTE: 03, A1.4. Checksum del payload extendido: CRC-8/MAXIM (DERIVADO) o suma [SAM-SPI]. */
extern k210_cs_mode k210_payload_mode;
/* Registro de cada frame crudo en la consola (A1.3). Encendido por omisión en esta fase. */
extern int k210_log_raw;
/* Cada cuánto se pide la cara con el K210 listo (ms); 0 = no se pide. PENDIENTE: 03. Si el K210 contesta
   mientras reproduce una animación se mide en el robot. */
extern int k210_face_poll_ms;
extern int k210_scan_every_ms;   /* cada cuánto un vistazo en el modo 4; 0 = continuo (pruebas) */
