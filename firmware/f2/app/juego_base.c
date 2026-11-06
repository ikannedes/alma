/* juego_base.c — ver juego_base.h */
#include "juego_base.h"

#include <stdio.h>
#include <string.h>

#include "app.h"
#include "cJSON.h"
#include "f2_hal.h"
#include "lan.h"

#define FW 10
#define FH 8
#define PALA 3
#define META 3
#define FRESH_MS 4000       /* sin anuncio de la base en este tiempo, la partida se dio por terminada (el Bluetooth
                                    a veces calla 1-2 s con el Wi-Fi ocupado) */
#define GAME_MOT_EVERY_MS 25000

static int playing, done, last_seq = -1, sa, sb, moves, target = -1, music_was;
static int64_t lan_sent_ms;
/* la partida por la red local (lan.h): lo último que mandó la base, y cuándo. La escribe el hilo de la red */
static hal_pong_t lan_pong;
static volatile int64_t lan_pong_ms = -1;
static volatile int lan_seq;

void juego_base_lan_msg(const char *json)
{
    cJSON *j = cJSON_Parse(json);
    const cJSON *t = cJSON_GetObjectItemCaseSensitive(j, "t");
    if (cJSON_IsString(t) && !strcmp(t->valuestring, "pong")) {
        const char *k[8] = {"bx", "by", "vx", "vy", "pa", "pb", "sa", "sb"};
        int v[8], ok = 1;
        for (int i = 0; i < 8; i++) {
            const cJSON *x = cJSON_GetObjectItemCaseSensitive(j, k[i]);
            ok &= cJSON_IsNumber(x);
            v[i] = ok ? x->valueint : 0;
        }
        if (ok) {
            lan_pong = (hal_pong_t){v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], 1000 + (++lan_seq & 0xFFFF)};
            lan_pong_ms = hal_now_ms();
        }
    }
    cJSON_Delete(j);
}

/* el estado más fresco: por la red local o por Bluetooth */
static int pong_state(hal_pong_t *p, int64_t *age)
{
    hal_pong_t b;
    int64_t ab = 0, al = lan_pong_ms < 0 ? -1 : hal_now_ms() - lan_pong_ms;
    int hb = hal_home_pong(&b, &ab);
    if (al >= 0 && (!hb || al <= ab)) { *p = lan_pong; *age = al; return 1; }
    if (hb) { *p = b; *age = ab; return 1; }
    return 0;
}

/* a la base: la jugada (columna) y la música, por las dos vías; por la red, cada 300 ms aunque no cambie */
static void tell_base(int col, int flags, int64_t now)
{
    hal_ble_to_base(col, flags);
    if (!flags && !music_was) return;
    if (now - lan_sent_ms < 300 && flags == music_was) return;
    lan_sent_ms = now;
    char b[64];
    snprintf(b, sizeof b, "\"t\":\"robot\",\"c\":%d,\"f\":%d", col, flags);
    lan_send("base", b);
    music_was = flags;
}
static int64_t mot_ms;
static uint32_t rs = 0x9E3779B9u;

static float u01(void)
{
    rs ^= rs << 13;
    rs ^= rs >> 17;
    rs ^= rs << 5;
    return (rs >> 8) / 16777216.0f;
}

static float clampf(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }

/* dónde cruzará la pelota la fila de Alma (con los rebotes en los lados), como la calcula la base */
static int landing(const hal_pong_t *p)
{
    int x = p->bx, y = p->by, dx = p->vx, dy = p->vy;
    for (int k = 0; k < 64 && y != FH - 1; k++) {
        if (x + dx < 0 || x + dx >= FW) dx = -dx;
        x += dx;
        y += dy;
        if (y < 0 || y >= FH) break;
    }
    return x;
}

float juego_base_skill(const alma_t *a)
{
    /* despierta (arousal) y con batería atina más; con buen ánimo, un poco más */
    return clampf(0.55f + 0.25f * a->affect_arousal + 0.15f * (a->soc_pct / 100.0f) + 0.10f * a->affect_valence, 0.35f, 0.95f);
}

/* Alma dice a qué columna quiere llevar su paleta (la base la lleva un paso por cuadro: el retraso del Bluetooth no la
   hace pasarse). −1 = sigue con la que tenía (duda) */
int juego_base_decide(const alma_t *a, const hal_pong_t *p)
{
    if (p->vy < 0)   /* la pelota se aleja: espera inquieta, a veces se acomoda al centro */
        return u01() < 0.25f * (0.5f + a->trait[TRAIT_IMPULSIVITY]) ? (FW - PALA) / 2 + (u01() < 0.5f ? -1 : 1) : -1;
    float skill = juego_base_skill(a);
    if (u01() < (1.0f - skill) * 0.4f) return -1;  /* duda: sigue con lo que tenía */
    int t = landing(p) - 1;                        /* la paleta mide 3: su centro bajo la pelota */
    if (u01() > skill) t += u01() < 0.5f ? -1 : 1;                 /* calcula mal */
    if (u01() < 0.3f * a->trait[TRAIT_IMPULSIVITY]) t += p->vx;    /* impulsiva: se adelanta */
    return t < 0 ? 0 : t > FW - PALA ? FW - PALA : t;
}

int juego_base_playing(void) { return playing; }

void juego_base_step(int64_t now, int music)
{
    hal_pong_t p;
    int64_t age = 0;
    int fresh = pong_state(&p, &age) && age < FRESH_MS;
    if (!fresh) {
        if (playing) hal_log("pong: la base dejó de anunciar la partida (Alma %d, base %d, %d jugadas)", sa, sb, moves);
        playing = done = 0;
        hal_ble_fast(0);
        tell_base(0, music ? BASE_F_MUSICA : 0, now);
        return;
    }
    if (done) {   /* ya terminó: hasta que la base deje de anunciarla */
        tell_base(0, music ? BASE_F_MUSICA : 0, now);
        return;
    }
    if (!playing) {
        playing = 1;
        last_seq = -1;
        target = -1;
        hal_ble_fast(1);
        if (p.sa || p.sb) {   /* la señal se cortó a media partida: se retoma, sin volver a empezar ni a reaccionar */
            sa = p.sa;
            sb = p.sb;
            hal_log("pong: Alma retoma la partida (Alma %d, base %d)", sa, sb);
        } else {
            sa = sb = moves = 0;
            mot_ms = now - GAME_MOT_EVERY_MS + 1500;   /* el primer movimiento de juego, en cuanto empieza */
            hal_log("pong: Alma juega con la base (atina %.0f %%)", 100 * juego_base_skill(app_alma()));
            app_game_event(GEV_EMPIEZA, "pong");
            app_play_mot("emo_play_a_game_start");
        }
    }
    if (now - mot_ms >= GAME_MOT_EVERY_MS && app_play_mot("pinball") == 0) mot_ms = now;   /* juega con el cuerpo */
    if (p.seq == last_seq) return;
    last_seq = p.seq;
    if (p.sa > sa) {
        sa = p.sa;
        hal_log("pong: punto de Alma (Alma %d, base %d)", sa, sb);
        if (sa < META) app_game_event(GEV_BUENA, "pong");
    }
    if (p.sb > sb) {
        sb = p.sb;
        hal_log("pong: punto de la base (Alma %d, base %d)", sa, sb);
        if (sb < META) app_game_event(GEV_MALA, "pong");
    }
    if (sa >= META || sb >= META) {
        hal_log("pong: %s (Alma %d, base %d, %d jugadas suyas)", sa > sb ? "ganó Alma" : "perdió Alma", sa, sb, moves);
        app_game_event(sa > sb ? GEV_GANA : GEV_PIERDE, "pong");
        if (sa > sb) app_play_mot("emo_play_a_game_end");
        done = 1;
        playing = 0;
        hal_ble_fast(0);
        tell_base(0, music ? BASE_F_MUSICA : 0, now);
        return;
    }
    int t = juego_base_decide(app_alma(), &p);
    if (t >= 0 && t != target) {
        target = t;
        moves++;
    }
    if (target < 0) target = p.pa;
    tell_base(target, BASE_F_PONG | (music ? BASE_F_MUSICA : 0), now);
}
