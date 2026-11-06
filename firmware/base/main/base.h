/* base.h — alma-base: el firmware de Alma para la Home Station (placa EMO_home_CTR V3.0). Pines (análisis del firmware
 * de fábrica, 2026-11-06; emo_backup/home_station/20261106_fabrica/LEEME.txt):
 *   GPIO5  datos de los 96 LEDs (12 x 8, WS2812 por SPI)     GPIO39 entrada: 1 = EMO cargando (el IP6806 carga solo)
 *   GPIO27 botón táctil (touch pad 7, pines T1/T2)            GPIO25/26 DAC -> amplificador, GPIO12 lo enciende
 * GPIO12 es pin de arranque: queda en 0 desde el primer instante (main.c). */
#pragma once
#include <stddef.h>
#include <stdint.h>

#define PIN_LEDS   5
#define PIN_CARGA  39
#define PIN_AMP    12
#define TOUCH_PAD  7   /* GPIO27 */

/* main.c: lo que el enlace pide y manda (uplink_cfg) */
long base_state(char *out, size_t cap);
long base_take(char *out, size_t cap);
long base_msg(const char *json, char *reply, size_t cap);
void base_link(int up);

/* main.c: un mensaje de la red local (lan.h), en el hilo de la red */
struct lan_peer_s;
void base_lan_msg(const char *json, const struct lan_peer_s *from);

/* red.c */
void red_start(void);
void red_link_start(void);
const char *red_ip(void);

/* leds.c: la matriz (brillo con tope) y las animaciones embebidas (alma_base.alb, tools/base_leds) */
void leds_init(void);
void leds_off(void);
int  leds_anim(const char *name);   /* 0 = empezó; −1 = no existe */
const char *leds_playing(void);     /* "" si nada */
int  leds_count(void);
void leds_live(const uint8_t *rgb);   /* un cuadro de 288 bytes ya (detiene la animación) */
void leds_comp(int r, int g, int b, int e);   /* % extra por canal en los LEDs gastados (desgaste.h); e = curva (100 recta) */
const char *leds_name(int i);

/* anuncio.c: el anuncio Bluetooth (el robot la reconoce por la dirección y lee el estado) */
void anuncio_start(void);
void anuncio_estado(uint8_t estado);   /* bit 0 = EMO cargando, bit 1 = toque reciente */
void anuncio_pong(const uint8_t st[8]); /* bx by vx vy pa pb sa sb de la partida, o NULL al terminar */
int  anuncio_robot(int *flags, int64_t *age_ms);   /* lo último que anunció el robot: bit 0 jugando, bit 1 música */

/* musica.c: el analizador de espectro mientras el robot pone música (no hay micrófono: barras animadas) */
void musica_step(int64_t now);
void musica_prueba(void);
void musica_lan(int on);    /* el robot dice por la red local si pone música */   /* 20 s de analizador aunque el robot no ponga música (orden "musica") */

/* pong.c: el juego con Alma (su paleta abajo, la de la base arriba) */
int  pong_start(void);       /* 0 = empezó; −1 = ya estaba jugando */
void pong_stop(void);
int  pong_running(void);
void pong_mover(int col);    /* la paleta de Alma: la columna (0-7) a la que el robot quiere llevarla */
