/* reflexes — ruta prioritaria de EV_CLIFF, EV_PICKED_UP, EV_SHAKEN y EV_TIPPED_OVER, fuera del sorteo (05).
 * Los servos se quedan quietos en el acto; después el evento entra al núcleo, que arranca el reflejo (04). */
#pragma once
#include <stdint.h>

#include "alma_core.h"

int  reflex_is(alma_ev_type t);
void reflex_fire(alma_ev_type t);
int64_t reflex_last_ms(void);      /* hora de la última detención (pruebas: latencia, A2.5) */
