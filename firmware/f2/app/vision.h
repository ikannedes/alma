/* vision — ver de cerca (dueño, 2026-11-01): cuando algo queda a 10 cm o menos (EV_OBSTACLE), y como mucho una vez cada
 * VISION_COOLDOWN_S, Alma pide una foto al K210, la manda al servidor en trozos y Haiku dice qué es y cómo reacciona;
 * la respuesta ({"t":"seen"}) llega por el enlace. Si ya vio, no vuelve a ver hasta que pase el tiempo. Portable.
 * Foto del dueño (dueño, 2026-11-02: "cuando me ve a mí, cada cierto tiempo tome una foto… sólo que haga un gesto de
 * tomar foto"): con su dueño (id 0) de frente VISION_OWNER_FACING_S seguidos, despierta, sin una orden en curso y fuera
 * de su ventana de noche, como mucho cada VISION_OWNER_EVERY_S: pone la cara de cámara, toma la foto y la manda con
 * "kind":"owner"; Haiku dice qué hace su dueño y cómo reacciona ella. */
#pragma once
#include <stddef.h>

#define VISION_COOLDOWN_S 180      /* dueño: cada 3 minutos como mucho */
#define VISION_CHUNK      2400     /* bytes de JPEG por mensaje: 3200 en base64, cabe en UPLINK_MAX */
#define VISION_WAIT_S     30       /* el servidor contesta en este tiempo o se da por perdida */
#define VISION_OWNER_EVERY_S  1800 /* foto del dueño: cada 30 minutos como mucho */
#define VISION_OWNER_FACING_S 5    /* de frente este tiempo seguido antes del gesto */
#define VISION_OWNER_GESTURE  "image_search"   /* "photo" no está en la SD de esta unidad (revisión de la SD, 2026-11-03) */
#define VISION_GESTURE_MS     1500 /* el gesto se ve antes de tomar la foto */

extern int vision_owner_on;        /* 1 = toma la foto del dueño; las pruebas que no son de eso la apagan */

void vision_init(void);
void vision_set_link(int up);
void vision_obstacle(void);        /* app: llegó EV_OBSTACLE (sin la red) */
/* La red decidió bhv_photo (dueño, 2026-11-05): foto de lo que tiene enfrente (o del dueño, owner = 1, si lo tiene de
   frente). Límites fijos: una cada VISION_COOLDOWN_S, despierta, con servidor y nunca de noche */
void vision_decide(int owner);
void vision_step(void);            /* en cada vuelta del bucle: también decide la foto del dueño */
/* El siguiente trozo para el enlace ({"t":"photo","seq":n,"last":0|1,"jpg":"<base64>"}; el primero de la foto del
   dueño lleva "kind":"owner"), o 0 si no hay */
long vision_take(char *out, size_t cap);
/* {"t":"seen","objeto":"…","reaccion":"curiosa|contenta|…","conducta":"bhv_…"} o {"t":"seen","error":"…"}; Haiku elige
   la conducta con la personalidad y el estado de Alma; el núcleo comprueba que se pueda hacer */
void vision_result(const char *json);
