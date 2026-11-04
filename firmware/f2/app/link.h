/* link — cifrado del enlace con el servidor (relay/alma_relay/link.py; decisión del dueño, 2026-10-30: llave simétrica
 * precompartida, sin TLS en el robot para no gastar RAM). Portable: solo AES-256-GCM y HMAC-SHA256 de mbedTLS.
 *   servidor → robot  "H" + ns(16)
 *   robot → servidor  "A" + nr(16) + iv(12) + GCM_K(iv, "alma-auth" + ns + id, aad "A" + nr) + tag(16)
 *   Ks = HMAC-SHA256(K, "alma-session" + ns + nr)
 *   datos             "D" + n(8, big endian, solo sube) + GCM_Ks(sentido(4) + n, json, aad "D" + n) + tag(16) */
#pragma once
#include <stddef.h>
#include <stdint.h>

#define LINK_KEY_LEN 32
#define LINK_AUTH_RAND 28            /* nr (16) + iv (12) */
#define LINK_D_OVERHEAD (1 + 8 + 16)

typedef struct {
    uint8_t ks[LINK_KEY_LEN];
    uint64_t out_n, in_n;
} link_sess;

/* Responde al saludo "H": escribe el frame "A" en out y deja lista la sesión. rnd = 28 bytes aleatorios.
 * Devuelve el largo del frame, o −1 (saludo inválido o no cabe). */
long link_auth(const uint8_t k[LINK_KEY_LEN], const uint8_t *hello, size_t hello_n, const char *robot_id,
               const uint8_t rnd[LINK_AUTH_RAND], link_sess *s, uint8_t *out, size_t cap);
/* Cifra json (n bytes) en un frame "D". Devuelve el largo, o −1 si no cabe. */
long link_seal(link_sess *s, const char *json, size_t n, uint8_t *out, size_t cap);
/* Descifra un frame "D" del servidor en out (terminado en 0). −1 si está alterado, repetido o no cabe. */
long link_open(link_sess *s, const uint8_t *frame, size_t n, char *out, size_t cap);
/* "a1b2…" (64 caracteres) → 32 bytes. 0 si está bien. */
int  link_key_hex(const char *hex, uint8_t k[LINK_KEY_LEN]);
