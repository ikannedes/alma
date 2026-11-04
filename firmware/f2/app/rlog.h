/* rlog — registro por Wi-Fi (dueño, 2026-11-02: probar sin el USB). Mientras está prendido, cada línea de hal_log se
 * guarda en un anillo y el enlace la manda al servidor como {"t":"log","s":...}. Sin candado: el HAL lo protege
 * (hal_esp32.c, con el mutex del registro). Portable. */
#ifndef RLOG_H
#define RLOG_H

#include <stddef.h>

void rlog_set(int on);                   /* prender/apagar; al prender se vacía */
int  rlog_on(void);
void rlog_push(const char *line);        /* una línea, sin \n; las de tramas del K210 (TX/RX) no se guardan */
long rlog_take(char *out, size_t cap);   /* el siguiente mensaje {"t":"log","s":...} o 0 si no hay nada */

#endif
