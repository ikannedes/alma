/* Enlace UART1 con el K210 (03): GPIO12 TX, GPIO4 RX, 1 Mbaud 8N1. Registra por consola todo lo que entra y sale. */
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "k210_frames.h"

void k210_link_init(void);
void k210_send(const uint8_t *frame, size_t n, const char *what);
void k210_send_small(uint8_t cmd, uint8_t d0, uint8_t d1, uint8_t d2);
void k210_send_ext(uint8_t sel, const char *payload, k210_cs_mode m);
void k210_play(const char *avi, const char *mp3_or_null, int mode, k210_cs_mode m);

/* Secuencias de arranque (03, "Secuencia de arranque"). Devuelven true si llegó 55 AA 47 en el plazo. */
bool k210_boot_sam(void);
bool k210_boot_el(void);
/* Decisión del dueño (2026-10-27): [SAM-SPI] primero, esperando 0x47 hasta 5 s; si no llega, [EL-GPIO]. */
const char *k210_boot(void);

uint32_t k210_rx_frames(void);
uint32_t k210_rx_dropped(void);
