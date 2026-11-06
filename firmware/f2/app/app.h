/* app — bucle de alma-f2: reloj, cola de eventos, alma_tick y ejecución de conductas (08, F2). Portable.
 * La plataforma llama app_step cada F2_STEP_MS; nada adentro bloquea, así la recepción del K210 nunca espera. */
#pragma once
#include <stddef.h>
#include <stdint.h>

#include "alma_core.h"
#include "alma_mem.h"

/* catalog_text: catalog.json completo. alma_catalog va en `catalog_mem` (215 KB: en el ESP32, PSRAM). 0 = ok. */
int  app_init(const char *catalog_text, alma_catalog *catalog_mem, uint32_t seed);
void app_step(void);
/* Encola un evento. Los reflejos (EV_CLIFF, EV_PICKED_UP, EV_SHAKEN, EV_TIPPED_OVER) no esperan: paran los servos
 * y entran al núcleo en el acto, fuera del sorteo (05). */
void app_post(const alma_ev *e);
int  app_fainted(void);             /* 1 = desmayada sin batería, esperando el cargador */
void app_note_moved(int64_t now);   /* el IMU dice que la mueven: las patas vuelven (base_servos) */
void app_legs_keep_on(int on);   /* 1 = en la base las patas siguen con corriente (si lo de apagarlas falla) */
void app_usb_motion(int on);
int  app_usb_motion_on(void);     /* con el USB: 1 = se mueve (pruebas), 0 = cuenta como base (por omisión) */
void app_battery_test(int on);   /* prueba de batería: sin siesta y a casa hasta el 15 % (dueño, 2026-11-02) */
void app_console_key(char c);      /* consola de desarrollo (la de sesion1, con teclas para inyectar eventos) */
void app_console_help(void);       /* la ayuda de la consola, sin pasar por app_console_key (no es una tecla) */
void app_set_clock(double local_s);   /* ajusta la hora local (PENDIENTE: no hay fuente de hora, f2_config.h) */
/* Hora local de arranque (segundos desde la medianoche del día 0) antes de app_init, p. ej. desde SNTP. Sin esto,
 * F2_BOOT_LOCAL_S. Se fija una sola vez al arrancar: un salto de reloj a media vida confundiría al núcleo. */
void app_preset_clock(double local_s);
int  app_mem_empty(void);                  /* 1 si la memoria estaba vacía al arrancar y no se ha restaurado */
int  app_mem_restore(const uint8_t *p, size_t n);   /* importa una exportación y la carga; 0 = ok */
int  app_clock_real(void);                 /* 1 si la hora es real (SNTP o servidor) */
/* Hora local que manda el servidor al conectar: solo si el SNTP no contestó (2026-11-01: un arranque quedó en las 8:00) */
void app_clock_from_server(double local_s);

const alma_t *app_alma(void);
/* decisiones de la red desde la última llamada, su promedio y su máximo en µs; vuelve a cero (ALMA_TIEMPOS) */
void app_brain_time(uint32_t *n, uint32_t *avg_us, uint32_t *max_us);
/* ajuste de Haiku al bienestar del día y nudges de rasgos (07), del "night_result" del enlace */
void app_night_result(int wb_adjust, const float nudges[TRAIT_COUNT]);
/* enlace con el servidor arriba o abajo: la voz y el hambre (tamagotchi) dependen de él */
void app_set_link(int up);
/* tamagotchi: el dueño le ofrece comida desde la app; ella decide (alma_feed) */
alma_feed_result app_feed(int food);
/* plan v2 (2026-10-31): el servidor decide la comida y lleva peso y salud; la app lo aplica al núcleo */
void app_care_state(float hunger, alma_sick_cause cause, alma_weight_band band, float energy);
void app_care_feed(int food, int accepted, float joy, float bond, float frust);
/* juegos de la app (PLAN-JUEGOS, 2026-10-31): reacción a lo que pasó en la partida */
void app_game_event(alma_game_ev e, const char *juego);
int  app_play_mot(const char *mot);   /* un movimiento por nombre (juego_base.c); 0 = en marcha */
/* vision.c: la reacción a lo que vio de cerca (Haiku) */
void app_vision_event(alma_vision_ev e, const char *behavior);
/* segundos que el dueño jugó con Alma desde la app (los manda el servidor): bienestar del día */
void app_remote_play(int seconds);
/* trucos (dueño, 2026-11-01): hace el movimiento que pidió el servidor (opción de bhv_trick); 0 y why si no puede */
int app_trick(const char *mot, const char **why);
/* Mudanza entre cuerpos (body.c, PLAN-RELOJ-v2): lo que el protocolo le pide al núcleo de este cuerpo */
int  app_mem_writable(void);                 /* la región se lee y se puede escribir (ALMA_MEM_WRITE_ENABLED, 06) */
long app_body_export(uint8_t *out, size_t cap, int flush);   /* flush: guarda todo antes de exportar */
/* Importa el paquete (valida antes de escribir), la carga de cero y se pone al día elapsed_s sin conductas. 0 = ok */
int  app_body_import(const uint8_t *p, size_t n, double elapsed_s);
void app_body_sleep(const char *why);        /* modo "Alma no está": para la conducta, guarda y deja de correr el núcleo */
int  app_body_asleep(void);
const alma_catalog *app_catalog(void);
alma_mem *app_mem(void);
double app_now_s(void);

/* Registro del día para /api/log/today */
typedef struct { int64_t t_ms; int type, person, action, behavior; } app_ev_log;
int app_events(const app_ev_log **out, int *first);   /* anillo de F2_LOG_EVENTS; devuelve cuántos hay */

/* Pruebas y consola: cada conducta que el núcleo arranca */
typedef void (*app_exec_cb)(const alma_exec_info *e);
void app_set_exec_cb(app_exec_cb cb);
const char *app_ev_name(int type);
const char *app_action_name(int action);
int  app_action_of(const char *name);    /* "dance" → ACT_DANCE, o −1 */
