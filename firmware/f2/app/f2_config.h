/* f2_config.h — opciones de compilación de alma-f2. Todas se pueden cambiar con -D. */
#pragma once
#include "alma_params.h"   /* ALMA_DEV_MOTION_ON_USB (09, R14): 0 por omisión */

/* memory_store: lee y valida la región de 06, pero no escribe (la primera escritura tiene su propio plan de sesión) */
#define HOME_BATTERY_PCT 35.0f   /* dueño, 2026-11-02: a casa sola con menos de 35 % (antes 20) */
#define NAP_BATTERY_PCT  60.0f   /* dueño, 2026-11-02: de día, cansada o aburrida y con menos de 60 %: siesta en la base */
#define NAP_REST         0.6f    /* necesidad de descanso que cuenta como "cansada" */
#define NAP_RETRY_MS     1800000 /* una siesta cada 30 min como mucho */
#define LEAVE_BASE_PCT   90.0f   /* dueño, 2026-11-02: cargada (≥ 90 %), de día y viéndote, se baja sola */
#define LEAVE_STEPS      3       /* pasos al frente (se sube de espaldas: queda mirando hacia afuera) */
#define LEAVE_RETRY_MS   600000  /* si no se bajó, otro intento a los 10 min */
#define HOME_NIGHT_TRIES 3       /* dueño, 2026-11-01: a las 20:00 va sola a la base; si no llega en 3 intentos, duerme ahí */
#define HOME_RETRY_MS    180000  /* 3 min entre intentos, como el original */

#ifndef ALMA_MEM_WRITE_ENABLED
#define ALMA_MEM_WRITE_ENABLED 0
#endif

/* Variante remota (sesion1a.md): sin servos en el binario. Los GPIO 5, 21, 25 y 26 no se inicializan;
 * motion_play rechaza todo y hal_servo_* no hacen nada. */
#ifndef ALMA_SERVOS_DISABLED
#define ALMA_SERVOS_DISABLED 0
#endif

/* API local de 07 (/api/state, /api/command, /api/log/today) con Wi-Fi según R15. Apagada por omisión. */
#ifndef ALMA_F2_API
#define ALMA_F2_API 0
#endif

#define F2_STEP_MS        10    /* periodo del bucle principal */
#define F2_TICK_MS        100   /* alma_tick */
#define F2_MOTION_STEP_MS 20    /* paso de interpolación del reproductor de .mot */
#define F2_LOG_EVENTS     100   /* /api/log/today: últimos 100 eventos (07) */

/* Hora local al arrancar, en segundos. PENDIENTE: no hay fuente de hora sin Wi-Fi (SNTP) ni RTC conocido (02).
 * Mientras tanto se arranca a las 8:00 del día 0, como el simulador, y la consola permite ajustarla. */
#ifndef F2_BOOT_LOCAL_S
#define F2_BOOT_LOCAL_S (8 * 3600.0)
#endif

/* Aviso de caídas al celular (dueño, 2026-10-30): FALLS_N bordes o vuelcos en FALLS_WINDOW_MS */
#define FALLS_N 3
#define FALLS_WINDOW_MS (10 * 60 * 1000)

/* Enlace con el servidor (main/api_esp32.c, 2026-10-30): estado cada F2_LINK_STATE_MS; si no conecta o la llave no
   sirve, reintento con espera doble cada vez hasta F2_LINK_RETRY_MAX_S */
#define F2_LINK_STATE_MS 5000
#define F2_LINK_RETRY_MIN_S 5
#define F2_LINK_RETRY_MAX_S 300
#define F2_LINK_STACK 6144
