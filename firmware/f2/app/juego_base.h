/* juego_base — Alma juega Pong con la Home Station (dueño, 2026-11-06: "quiero que el robot juegue literalmente… se
 * pueden conectar por bluetooth"). La partida vive en la base (alma-base, pong.c: pelota, paletas, marcador, la paleta
 * de la base); la base la anuncia por Bluetooth y el robot la escucha (hal_home_pong). Aquí Alma decide su jugada
 * (a qué columna lleva su paleta) según dónde caerá la pelota y cómo está ella (despierta, con batería y de buen ánimo
 * atina más; impulsiva, se adelanta) y la anuncia (hal_ble_to_base). Con el cuerpo: emo_play_a_game_start al empezar,
 * pinball mientras juega (si no está en la base: R14), y reacciona a cada punto y al final como a los juegos del reloj
 * (alma_game_event). Portable. También le avisa a la base cuando pone música (analizador de espectro). */
#pragma once
#include <stdint.h>

#include "alma_core.h"
#include "f2_hal.h"

void  juego_base_step(int64_t now, int music);   /* cada vuelta: music = 1 si está poniendo música */
int   juego_base_playing(void);
/* un mensaje de la red local (lan.h) con "t":"pong" de la base: el estado de la partida (lo llama el hilo de la red) */
void  juego_base_lan_msg(const char *json);
/* para las pruebas: la columna a la que quiere ir (−1 = duda, sigue con la de antes) y qué tan bien atina (0.35-0.95) */
int   juego_base_decide(const alma_t *a, const hal_pong_t *p);
float juego_base_skill(const alma_t *a);
