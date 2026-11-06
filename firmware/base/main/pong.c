/* pong.c — Alma y la base juegan Pong en la matriz (dueño, 2026-11-06: "que juegue pong con la base, como si fuera su
 * amigo, que emo le diga derecha, izquierda y la base responda"). El campo es el frente de la base: columnas 1 a 10
 * (los costados curvos, 0 y 11, son para los brillos de cada punto) y las 8 filas. La paleta de la base va arriba (fila
 * 0) y la de Alma abajo (fila 7), de 3 de ancho, y se mueven a izquierda y derecha.
 *
 * La base juega sola, con su carácter: sigue la pelota pero a veces se distrae. La paleta de Alma la mueve el robot:
 * cada cuadro se anuncia por Bluetooth (anuncio_pong) y el robot anuncia su jugada (−1, 0, +1; anuncio.c → pong_mover;
 * f2/app/juego_base.c decide con el estado de Alma). Si no llega ninguna en PONG_ALMA_MS, la mueve un jugador
 * automático con el estilo de Alma (impulsiva: se adelanta y a veces se pasa). Gana quien llega a PONG_META. Cada
 * cuadro sale al servidor como evento "pong" (pelota, paletas, marcador) para que el robot sepa dónde está la pelota. */
#include <stdio.h>
#include <string.h>

#include "esp_random.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "base.h"
#include "f2_hal.h"
#include "lan.h"
#include "outbox.h"

#define FX0 1            /* primera columna del campo */
#define FW 10            /* ancho del campo */
#define FH 8
#define PALA 3
#define PONG_META 3
#define PONG_ALMA_MS 2000
#define TICK0_MS 260     /* la pelota empieza lenta y acelera un poco con cada rebote */
#define TICK_MIN_MS 140

static const uint8_t C_BASE[3] = {255, 40, 90}, C_ALMA[3] = {40, 200, 255}, C_BOLA[3] = {255, 255, 255};

static volatile int running, alma_target = -1;
static volatile int64_t alma_cmd_ms = -1000000;
static int bx, by, vx, vy, pb, pa, sb, sa, tick_ms;   /* pelota, velocidad, paletas (columna izquierda), marcador */

int pong_running(void) { return running; }

static int robot_moves;

void pong_mover(int col)
{
    if (col != alma_target) robot_moves++;
    alma_target = col;
    alma_cmd_ms = hal_now_ms();
}

static int rnd(int n) { return (int)(esp_random() % (uint32_t)n); }
static int clampi(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

static void px(uint8_t *f, int x, int y, const uint8_t c[3])
{
    if (x < 0 || x > 11 || y < 0 || y >= FH) return;
    memcpy(f + (y * 12 + x) * 3, c, 3);
}

static void draw(void)
{
    uint8_t f[288] = {0};
    for (int i = 0; i < PALA; i++) {
        px(f, FX0 + pb + i, 0, C_BASE);
        px(f, FX0 + pa + i, FH - 1, C_ALMA);
    }
    px(f, FX0 + bx, by, C_BOLA);
    if (running) leds_live(f);   /* detenido (otra animación pedida), ya no se dibuja encima */
}

static void flash(const uint8_t c[3], int times)
{
    for (int k = 0; k < times && running; k++) {
        uint8_t f[288] = {0};
        for (int y = 0; y < FH; y++) {   /* los costados curvos del color de quien anotó */
            px(f, 0, y, c);
            px(f, 11, y, c);
        }
        leds_live(f);
        vTaskDelay(pdMS_TO_TICKS(180));
        memset(f, 0, sizeof f);
        if (running) leds_live(f);
        vTaskDelay(pdMS_TO_TICKS(120));
    }
}

static void serve(int toward_alma)
{
    bx = FW / 2 - 1 + rnd(2);
    by = toward_alma ? 2 : FH - 3;
    vy = toward_alma ? 1 : -1;
    vx = rnd(2) ? 1 : -1;
    tick_ms = TICK0_MS;
}

/* dónde caerá la pelota en la fila de una paleta (con los rebotes en los lados) */
static int landing(int row)
{
    int x = bx, y = by, dx = vx, dy = vy;
    for (int k = 0; k < 64 && y != row; k++) {
        if (x + dx < 0 || x + dx >= FW) dx = -dx;
        x += dx;
        y += dy;
        if (y < 0 || y >= FH) return x;
    }
    return x;
}

/* la base: va hacia donde caerá la pelota, pero 1 de cada 12 veces se distrae y no se mueve */
static void base_ai(void)
{
    if (vy > 0 || rnd(12) == 0) return;
    int t = clampi(landing(0) - 1, 0, FW - PALA);
    pb += t > pb ? 1 : t < pb ? -1 : 0;
}

/* Alma automática: impulsiva, se adelanta un lugar hacia donde va la pelota (a veces se pasa) */
static int alma_ai(void)
{
    if (vy < 0) return rnd(4) == 0 ? (rnd(2) ? 1 : -1) : 0;   /* la pelota se aleja: se mueve inquieta */
    if (rnd(10) == 0) return 0;   /* a veces duda */
    int t = clampi(landing(FH - 1) - 1 + (rnd(5) == 0 ? vx : 0), 0, FW - PALA);
    return t > pa ? 1 : t < pa ? -1 : 0;
}

static void send_state(void)
{
    const uint8_t st[8] = {(uint8_t)bx, (uint8_t)by, (uint8_t)(int8_t)vx, (uint8_t)(int8_t)vy, (uint8_t)pa, (uint8_t)pb,
                           (uint8_t)sa, (uint8_t)sb};
    char b[96];   /* por la red local, al robot (lan.h): la vía principal; el Bluetooth queda de respaldo */
    snprintf(b, sizeof b, "\"t\":\"pong\",\"bx\":%d,\"by\":%d,\"vx\":%d,\"vy\":%d,\"pa\":%d,\"pb\":%d,\"sa\":%d,\"sb\":%d",
             bx, by, vx, vy, pa, pb, sa, sb);
    lan_send("robot", b);
    anuncio_pong(st);   /* el robot la escucha por Bluetooth y juega con esto. Al servidor solo van los puntos: cada mensaje
                           por Wi-Fi le quita la radio al Bluetooth (2026-11-06: "¿por qué se pierde tanto la conexión?") */
}

static void pong_task(void *arg)
{
    (void)arg;
    sa = sb = 0;
    robot_moves = 0;
    alma_target = -1;
    pa = pb = (FW - PALA) / 2;
    serve(rnd(2));
    hal_log("pong: empieza (a %d puntos)", PONG_META);
    while (running) {
        int64_t now = hal_now_ms();
        int d = alma_ai();
        if (now - alma_cmd_ms < PONG_ALMA_MS && alma_target >= 0)   /* la manda el robot: un paso hacia su columna */
            d = alma_target > pa ? 1 : alma_target < pa ? -1 : 0;
        pa = clampi(pa + d, 0, FW - PALA);
        base_ai();
        /* la pelota */
        if (bx + vx < 0 || bx + vx >= FW) vx = -vx;
        int nx = bx + vx, ny = by + vy;
        if (ny == FH - 1 || ny == 0) {
            int p = ny == 0 ? pb : pa;
            if (nx >= p - 1 && nx <= p + PALA) {   /* le pega (un lugar más allá de cada orilla también cuenta) */
                vy = -vy;
                if (nx < p) vx = -1;
                else if (nx >= p + PALA) vx = 1;
                else if (nx == p + 1) vx = rnd(3) == 0 ? -vx : vx;   /* el centro: a veces cambia de lado */
                if (tick_ms > TICK_MIN_MS) tick_ms -= 10;
                ny = by + vy;
                nx = clampi(bx + vx, 0, FW - 1);
            } else {   /* punto */
                int for_alma = ny == 0;
                if (for_alma) sa++;
                else sb++;
                hal_log("pong: punto para %s (Alma %d, base %d)", for_alma ? "Alma" : "la base", sa, sb);
                char e[48];
                snprintf(e, sizeof e, ",\"quien\":\"%s\",\"sa\":%d,\"sb\":%d", for_alma ? "alma" : "base", sa, sb);
                outbox_event("pong_punto", e);
                send_state();   /* el robot se entera del punto ya */
                flash(for_alma ? C_ALMA : C_BASE, 3);
                if (sa >= PONG_META || sb >= PONG_META) break;
                serve(!for_alma);
                draw();
                vTaskDelay(pdMS_TO_TICKS(700));
                continue;
            }
        }
        bx = nx;
        by = ny;
        draw();
        send_state();
        vTaskDelay(pdMS_TO_TICKS(tick_ms));
    }
    {   /* el marcador final 5 s, para que el robot lo lea aunque el Bluetooth calle un rato (2026-11-06: con 1.2 s no vio
           el último punto); luego el anuncio vuelve a lo de siempre */
        const uint8_t st[8] = {(uint8_t)bx, (uint8_t)by, 0, 0, (uint8_t)pa, (uint8_t)pb, (uint8_t)sa, (uint8_t)sb};
        anuncio_pong(st);
        for (int k = 0; k < 10; k++) {   /* y por la red, cada medio segundo */
            vx = vy = 0;
            send_state();
            vTaskDelay(pdMS_TO_TICKS(500));
        }
        anuncio_pong(NULL);
    }
    hal_log("pong: Alma jugó desde el robot %d veces", robot_moves);
    if (sa >= PONG_META || sb >= PONG_META) {
        int alma_gana = sa > sb;
        hal_log("pong: gana %s (Alma %d, base %d)", alma_gana ? "Alma" : "la base", sa, sb);
        char e[48];
        snprintf(e, sizeof e, ",\"gana\":\"%s\",\"sa\":%d,\"sb\":%d", alma_gana ? "alma" : "base", sa, sb);
        outbox_event("pong_fin", e);
        leds_anim(alma_gana ? "fuegos" : "feliz");
    } else {
        hal_log("pong: se detuvo");   /* lo que se muestre ahora lo decide quien lo detuvo */
    }
    running = 0;
    vTaskDelete(NULL);
}

int pong_start(void)
{
    if (running) return -1;
    running = 1;
    if (xTaskCreate(pong_task, "pong", 3072, NULL, 3, NULL) != pdPASS) {
        running = 0;
        return -1;
    }
    return 0;
}

void pong_stop(void) { running = 0; }
