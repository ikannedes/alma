/* musica.c — analizador de espectro mientras el robot pone música (dueño, 2026-11-06: "si emo está poniendo música y
 * la base está conectada… un estilo de analizador de espectros para que se vea que la base reacciona a la música").
 * La base no tiene micrófono y la música suena en el robot: el robot solo avisa por Bluetooth que está bailando o
 * cantando (anuncio.c, bandera de música) y aquí las barras se inventan, con un pulso a ~125 por minuto para que se vea
 * con ritmo. Diez barras en el frente (columnas 1 a 10), de verde abajo a rojo arriba; los costados curvos laten con el
 * nivel. Si hay Pong, gana el Pong. */
#include <string.h>

#include "esp_random.h"

#include "base.h"
#include "f2_hal.h"

#define FRAME_MS 80
#define BEAT_MS 480
#define FRESH_MS 1200   /* el robot se anuncia cada 30 ms y aquí se escucha cada 200: al callarse, se apaga ya */

static int on;
static int64_t next_ms, beat_ms, prueba_until;
static float lvl[10], vel[10];

void musica_prueba(void) { prueba_until = hal_now_ms() + 20000; }

static volatile int lan_on;
static volatile int64_t lan_ms = -1;
void musica_lan(int on)
{
    lan_on = on;
    lan_ms = hal_now_ms();
}

static float rnd01(void) { return (esp_random() >> 8) / 16777216.0f; }

static void draw(void)
{
    uint8_t f[288] = {0};
    float avg = 0;
    for (int i = 0; i < 10; i++) {
        int h = (int)(lvl[i] + 0.5f);
        avg += lvl[i];
        for (int y = 0; y < h && y < 8; y++) {
            int row = 7 - y;   /* de abajo hacia arriba */
            uint8_t *p = f + (row * 12 + i + 1) * 3;
            p[0] = (uint8_t)(y < 4 ? y * 50 : 255);            /* verde → amarillo → rojo */
            p[1] = (uint8_t)(y < 4 ? 255 : 255 - (y - 4) * 60);
            p[2] = 0;
        }
    }
    avg /= 10.0f;
    uint8_t s = (uint8_t)(avg / 8.0f * 255);
    for (int y = 0; y < 8; y++) {   /* los costados laten con el nivel */
        uint8_t *l = f + (y * 12) * 3, *r = f + (y * 12 + 11) * 3;
        l[0] = r[0] = (uint8_t)(s / 3);
        l[1] = r[1] = 0;
        l[2] = r[2] = s;
    }
    leds_live(f);
}

void musica_step(int64_t now)
{
    int flags = 0;
    int64_t age = 0;
    int ble = anuncio_robot(&flags, &age) && age < FRESH_MS && (flags & 2);
    int lan = lan_ms >= 0 && now - lan_ms < FRESH_MS && lan_on;   /* el robot repite cada 300 ms */
    int want = (ble || lan || now < prueba_until) && !pong_running();
    if (want != on) {
        on = want;
        hal_log("musica: %s", on ? "el robot pone música: analizador" : "fin del analizador");
        if (!on) leds_off();
        memset(lvl, 0, sizeof lvl);
        beat_ms = now;
    }
    if (!on || now < next_ms) return;
    next_ms = now + FRAME_MS;
    int beat = now - beat_ms >= BEAT_MS;
    if (beat) beat_ms = now;
    for (int i = 0; i < 10; i++) {
        float bass = i < 3 ? 1.0f : i < 7 ? 0.7f : 0.45f;   /* los graves (izquierda) saltan más con el pulso */
        if (beat) vel[i] += (2.5f + 3.5f * rnd01()) * bass;
        vel[i] += (rnd01() - 0.45f) * 1.2f;
        lvl[i] += vel[i];
        vel[i] *= 0.55f;
        lvl[i] -= 0.6f;   /* caen solas */
        if (lvl[i] < 0.5f) { lvl[i] = 0.5f; vel[i] = vel[i] < 0 ? 0 : vel[i]; }
        if (lvl[i] > 8.0f) { lvl[i] = 8.0f; vel[i] = 0; }
    }
    draw();
}
