/* Pruebas en la PC de lo portable de alma-sesion1: frames K210 (vectores de 03), parser con resincronización,
   .mot y lectura de la SPIFFS. Uso: test_sesion1 [storage.bin dir_mot_extraidos] */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "k210_frames.h"
#include "mot.h"

static int fails, checks;
#define CHECK(c, ...) do { checks++; if (!(c)) { fails++; printf("FALLA %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

static void hex(char *out, const uint8_t *p, size_t n)
{
    for (size_t i = 0; i < n; i++) sprintf(out + (i ? 3 * i - 1 : 0), i ? " %02x" : "%02x", p[i]);
    if (n == 0) out[0] = 0;
}

static void test_vectors(void)
{
    uint8_t f[K210_FRAME_MAX];
    char p[256], h[3 * K210_FRAME_MAX];
    /* (SEL, avi, mp3, modo, LEN, HDR_CS, PAYLOAD_CS): tabla "Vectores de prueba" de 03 */
    struct { int sel; const char *avi, *mp3; int mode, len, hcs, pcs; } v[] = {
        {0x02, "boot_start", "boot_start_000", 0, 0x4C, 0x4C, 0xC4},
        {0x02, "voice_wake_up", "voice_wake_up_000", 0, 0x52, 0x52, 0x54},
        {0x02, "stay_wink_1", NULL, 0, 0x26, 0x26, 0x04},
        {0x02, "stay_b_c", NULL, 0, 0x23, 0x23, 0xA2},
        {0x02, "listen_and_think", "listen_and_think_000", 1, 0x58, 0x58, 0x71},
        {0x02, "mood_happy", NULL, 0, 0x25, 0x25, 0xC5},
        {0x02, "stay_wink_3", NULL, 0, -1, -1, 0x81},
        {0x02, "stay_wink_4", NULL, 0, -1, -1, 0xD9},
        {0x02, "stay_wink_7", NULL, 0, -1, -1, 0x92},
        {0x02, "stay_a_c", NULL, 0, -1, -1, 0x1A},
    };
    for (size_t i = 0; i < sizeof v / sizeof v[0]; i++) {
        CHECK(k210_anim_payload(p, sizeof p, v[i].avi, v[i].mp3, v[i].mode) > 0, "payload %s", v[i].avi);
        size_t n = k210_ext(f, sizeof f, (uint8_t)v[i].sel, p, K210_CS_CRC8);
        CHECK(n == 7 + strlen(p) + 2, "largo %s", v[i].avi);
        if (v[i].len >= 0) CHECK(f[3] == v[i].len && f[4] == 0 && f[6] == v[i].hcs, "LEN/HDR_CS %s", v[i].avi);
        CHECK(f[n - 1] == v[i].pcs, "PAYLOAD_CS %s: %02x (esperado %02x)", v[i].avi, f[n - 1], v[i].pcs);
    }
    /* listen_and_think con la suma de [SAM-SPI]: 0x5C (03) */
    k210_anim_payload(p, sizeof p, "listen_and_think", "listen_and_think_000", 1);
    size_t n = k210_ext(f, sizeof f, 0x02, p, K210_CS_SUM);
    CHECK(f[n - 1] == 0x5C, "listen_and_think con suma: %02x", f[n - 1]);

    n = k210_ext(f, sizeof f, 0x03, "/spiffs/json/profile.json", K210_CS_CRC8);
    hex(h, f, n);
    CHECK(strcmp(h, "55 aa ff 1a 00 03 1b 2f 73 70 69 66 66 73 2f 6a 73 6f 6e 2f 70 72 6f 66 69 6c 65 2e 6a 73 6f 6e 00 10") == 0,
          "profile.json completo: %s", h);

    struct { uint8_t c, d0, d1, d2; const char *hx; } s[] = {
        {0x34, 0, 0, 0, "55 aa 34 00 00 00 33"}, {0x69, 1, 0, 0, "55 aa 69 01 00 00 69"},
        {0x2C, 0, 0, 0, "55 aa 2c 00 00 00 2b"}, {0x2D, 0, 0, 0, "55 aa 2d 00 00 00 2c"},
        {0x70, 0, 0, 0, "55 aa 70 00 00 00 6f"}, {0x38, 1, 0, 0, "55 aa 38 01 00 00 38"},
        {0x06, 1, 0, 0, "55 aa 06 01 00 00 06"}, {0x17, 0x68, 0, 0, "55 aa 17 68 00 00 7e"},
        {0x6A, 0x46, 0, 0, "55 aa 6a 46 00 00 af"}, {0x6C, 0, 0, 0, "55 aa 6c 00 00 00 6b"},
        {0x74, 0, 0, 0, "55 aa 74 00 00 00 73"}, {0x47, 0, 0, 0, "55 aa 47 00 00 00 46"},
        {0x06, 3, 0x10, 0, "55 aa 06 03 10 00 18"}, {0x65, 0xEB, 0, 0, "55 aa 65 eb 00 00 4f"},
    };
    for (size_t i = 0; i < sizeof s / sizeof s[0]; i++) {
        k210_small(f, s[i].c, s[i].d0, s[i].d1, s[i].d2);
        hex(h, f, 7);
        CHECK(strcmp(h, s[i].hx) == 0, "corto %s → %s", s[i].hx, h);
    }
}

/* ---- parser ---- */
typedef struct { int kind, flags; size_t n; uint8_t b[64]; } ev;
static ev evs[64];
static int nev;
static void cb(void *u, k210_rx_kind k, const uint8_t *p, size_t n, int flags)
{
    (void)u;
    if (nev < 64) {
        evs[nev].kind = k; evs[nev].flags = flags; evs[nev].n = n;
        memcpy(evs[nev].b, p, n < 64 ? n : 64);
    }
    nev++;
}

static void test_parser(void)
{
    k210_parser ps;
    uint8_t ready[] = {0x55, 0xAA, 0x47, 0x00, 0x00, 0x00, 0x46};

    k210_parser_init(&ps, cb, NULL); nev = 0;
    k210_parser_feed(&ps, ready, 7);
    CHECK(nev == 1 && evs[0].kind == K210_RX_SMALL && evs[0].b[2] == 0x47, "frame 0x47 limpio");

    /* basura antes, frame partido byte a byte, y 55 AA falso dentro de la basura */
    uint8_t s[] = {0x00, 0x13, 0x55, 0xAA, 0x01, 0x55, 0xAA, 0x0B, 0x10, 0x20, 0x30, 0x00};
    s[11] = (uint8_t)(0x55 + 0xAA + 0x0B + 0x10 + 0x20 + 0x30);
    k210_parser_init(&ps, cb, NULL); nev = 0;
    for (size_t i = 0; i < sizeof s; i++) k210_parser_feed(&ps, s + i, 1);
    int small = -1; size_t junk = 0;
    for (int i = 0; i < nev; i++) {
        if (evs[i].kind == K210_RX_SMALL) small = i;
        if (evs[i].kind == K210_RX_JUNK) junk += evs[i].n;
    }
    CHECK(small >= 0 && evs[small].b[2] == 0x0B && evs[small].b[3] == 0x10, "resincroniza y encuentra 0x0B");
    CHECK(junk == 5, "los 5 bytes previos se entregan como basura (%zu)", junk);
    CHECK(ps.n == 0, "no queda nada en el búfer");

    /* checksum malo: se avanza un byte y no se pierde el frame bueno que sigue */
    uint8_t bad[] = {0x55, 0xAA, 0x47, 0x00, 0x00, 0x00, 0x99, 0x55, 0xAA, 0x47, 0x00, 0x00, 0x00, 0x46};
    k210_parser_init(&ps, cb, NULL); nev = 0;
    k210_parser_feed(&ps, bad, sizeof bad);
    int nsmall = 0;
    for (int i = 0; i < nev; i++) nsmall += evs[i].kind == K210_RX_SMALL;
    CHECK(nsmall == 1 && evs[nev - 1].kind == K210_RX_SMALL, "checksum malo descartado, el bueno llega");

    /* extendido: CRC-8 válido, entregado entero aunque llegue en dos partes */
    uint8_t f[K210_FRAME_MAX];
    size_t n = k210_ext(f, sizeof f, 0x02, "[0,[[\"/spiffs/avi/stay_wink_1.avi\"]]]", K210_CS_CRC8);
    k210_parser_init(&ps, cb, NULL); nev = 0;
    k210_parser_feed(&ps, f, 10);
    CHECK(nev == 0, "extendido a medias: espera");
    k210_parser_feed(&ps, f + 10, n - 10);
    CHECK(nev == 1 && evs[0].kind == K210_RX_EXT && evs[0].n == n && (evs[0].flags & K210_EXT_CRC8_OK), "extendido completo con CRC-8");

    /* silencio a mitad de frame */
    k210_parser_init(&ps, cb, NULL); nev = 0;
    k210_parser_feed(&ps, ready, 4);
    k210_parser_flush(&ps);
    CHECK(nev == 1 && evs[0].kind == K210_RX_INCOMPLETE && evs[0].n == 4, "flush entrega el frame cortado");

    /* 55 suelto al final no se pierde */
    k210_parser_init(&ps, cb, NULL); nev = 0;
    uint8_t a[] = {0x01, 0x55};
    k210_parser_feed(&ps, a, 2);
    k210_parser_feed(&ps, ready + 1, 6);
    CHECK(nev == 2 && evs[0].kind == K210_RX_JUNK && evs[0].n == 1 && evs[1].kind == K210_RX_SMALL, "55 al final de un trozo");
}

/* ---- .mot y SPIFFS ---- */
static void test_mot_frame(void)
{
    const uint8_t fr[20] = {0x55, 0xAA, 0x55, 0xAA, 0x02, 0xFE, 0x14, 0x02, 0x00, 0x0C, 0x02, 0x50, 0x5A, 0x64, 0x50, 0x00, 0x90, 0x01, 0x13, 0xED};
    mot_frame m;
    CHECK(mot_parse_frame(fr, &m) == 0 && m.mode == MOT_MODE_POSE && m.s[0] == 80 && m.s[2] == 100 && m.ms == 400, "cuadro de ttt_my_turn");
    uint8_t bad[20];
    memcpy(bad, fr, 20);
    bad[12] ^= 1;
    CHECK(mot_parse_frame(bad, &m) != 0, "checksum malo se rechaza");
}

static FILE *img;
static int rd_file(void *ctx, uint32_t off, void *buf, size_t n)
{
    (void)ctx;
    return fseek(img, (long)off, SEEK_SET) || fread(buf, 1, n, img) != n;
}

static void test_spiffs(const char *storage, const char *motdir)
{
    img = fopen(storage, "rb");
    CHECK(img != NULL, "abrir %s", storage);
    if (!img) return;
    const char *names[] = {"ttt_my_turn.mot", "emo_play_a_game_start.mot", "Fit_Rest.mot", "system_start.mot", "react_put_down_1.mot"};
    static uint8_t got[65536], want[65536];
    for (size_t i = 0; i < sizeof names / sizeof names[0]; i++) {
        char path[512], sp[64];
        snprintf(path, sizeof path, "%s/%s", motdir, names[i]);
        snprintf(sp, sizeof sp, "/mot/%s", names[i]);
        FILE *f = fopen(path, "rb");
        size_t wn = f ? fread(want, 1, sizeof want, f) : 0;
        if (f) fclose(f);
        long n = spiffs_find(rd_file, NULL, 0x100000, sp, got, sizeof got);
        CHECK(n == (long)wn && wn > 0 && memcmp(got, want, wn) == 0, "SPIFFS %s: %ld bytes (esperado %zu)", sp, n, wn);
    }
    CHECK(spiffs_find(rd_file, NULL, 0x100000, "/mot/no_existe.mot", got, sizeof got) == -1, "archivo inexistente");
    CHECK(spiffs_find(rd_file, NULL, 0x100000, "/mot/ttt_my_turn.mot", got, 10) == -2, "no cabe en el búfer");
    fclose(img);
}

int main(int argc, char **argv)
{
    test_vectors();
    test_parser();
    test_mot_frame();
    if (argc >= 3) test_spiffs(argv[1], argv[2]);
    else printf("(sin storage.bin: se omite la prueba de SPIFFS)\n");
    printf("%d comprobaciones, %d fallas\n", checks, fails);
    return fails != 0;
}
