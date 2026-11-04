/* home — volver sola a la Home Station (dueño, 2026-10-30: "debe ir sola a la base cuando tiene menos de 20 %").
 * Como el original (emo_backup/re/CASA.md [BOBBY-ARTE]) pero sin BLE Mesh: el K210 ve la base en el modo 65 01 (medido
 * en el robot: 187 de 193 respuestas "encontrada" a ~40 cm). Busca girando, se acerca centrándola, da media vuelta con el
 * giroscopio y se sube de espaldas hasta que el cargador marca Home Station (GPIO36 alto y RX0 en 0). */
#pragma once

typedef enum { HOME_OFF, HOME_SEARCH, HOME_APPROACH, HOME_TURN, HOME_DOCK, HOME_DONE, HOME_FAIL } home_state;

void home_start(const char *why);
void home_stop(const char *why);      /* reflejo, caricia u orden: se cancela y el K210 vuelve a los ojos */
void home_step(void);                 /* en cada vuelta del bucle principal */
home_state home_get(void);
int  home_active(void);
int  home_near_base(void);            /* pegada a la base (la ve cerca, media vuelta o subiendo): un borde no cancela */
