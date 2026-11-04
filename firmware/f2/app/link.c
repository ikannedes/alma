/* link.c — ver link.h */
#include "link.h"

#include <string.h>

#include "mbedtls/gcm.h"
#include "mbedtls/md.h"

static const uint8_t R2S[4] = {'R', '2', 'S', 0}, S2R[4] = {'S', '2', 'R', 0};
static const char AUTH[] = "alma-auth", SESS[] = "alma-session";

static int gcm(int enc, const uint8_t *key, const uint8_t iv[12], const uint8_t *aad, size_t aad_n,
               const uint8_t *in, size_t n, uint8_t *out, uint8_t tag[16])
{
    mbedtls_gcm_context g;
    mbedtls_gcm_init(&g);
    int r = mbedtls_gcm_setkey(&g, MBEDTLS_CIPHER_ID_AES, key, LINK_KEY_LEN * 8);
    if (r == 0)
        r = enc ? mbedtls_gcm_crypt_and_tag(&g, MBEDTLS_GCM_ENCRYPT, n, iv, 12, aad, aad_n, in, out, 16, tag)
                : mbedtls_gcm_auth_decrypt(&g, n, iv, 12, aad, aad_n, tag, 16, in, out);
    mbedtls_gcm_free(&g);
    return r;
}

static void be64(uint8_t *p, uint64_t v)
{
    for (int i = 7; i >= 0; i--, v >>= 8) p[i] = (uint8_t)v;
}

long link_auth(const uint8_t k[LINK_KEY_LEN], const uint8_t *hello, size_t hello_n, const char *robot_id,
               const uint8_t rnd[LINK_AUTH_RAND], link_sess *s, uint8_t *out, size_t cap)
{
    if (hello_n != 17 || hello[0] != 'H') return -1;
    const uint8_t *ns = hello + 1, *nr = rnd, *iv = rnd + 16;
    size_t id_n = strlen(robot_id), pt_n = sizeof AUTH - 1 + 16 + id_n;
    uint8_t pt[96];
    if (pt_n > sizeof pt || cap < 1 + 16 + 12 + pt_n + 16) return -1;
    memcpy(pt, AUTH, sizeof AUTH - 1);
    memcpy(pt + sizeof AUTH - 1, ns, 16);
    memcpy(pt + sizeof AUTH - 1 + 16, robot_id, id_n);
    uint8_t aad[17] = {'A'};
    memcpy(aad + 1, nr, 16);
    out[0] = 'A';
    memcpy(out + 1, nr, 16);
    memcpy(out + 17, iv, 12);
    if (gcm(1, k, iv, aad, sizeof aad, pt, pt_n, out + 29, out + 29 + pt_n)) return -1;
    /* Ks = HMAC-SHA256(K, "alma-session" + ns + nr) */
    uint8_t msg[sizeof SESS - 1 + 32];
    memcpy(msg, SESS, sizeof SESS - 1);
    memcpy(msg + sizeof SESS - 1, ns, 16);
    memcpy(msg + sizeof SESS - 1 + 16, nr, 16);
    if (mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), k, LINK_KEY_LEN, msg, sizeof msg, s->ks)) return -1;
    s->out_n = s->in_n = 0;
    return (long)(29 + pt_n + 16);
}

long link_seal(link_sess *s, const char *json, size_t n, uint8_t *out, size_t cap)
{
    if (cap < n + LINK_D_OVERHEAD) return -1;
    uint8_t iv[12];
    out[0] = 'D';
    be64(out + 1, ++s->out_n);
    memcpy(iv, R2S, 4);
    memcpy(iv + 4, out + 1, 8);
    if (gcm(1, s->ks, iv, out, 9, (const uint8_t *)json, n, out + 9, out + 9 + n)) return -1;
    return (long)(n + LINK_D_OVERHEAD);
}

long link_open(link_sess *s, const uint8_t *frame, size_t n, char *out, size_t cap)
{
    if (n < LINK_D_OVERHEAD || frame[0] != 'D') return -1;
    size_t pt_n = n - LINK_D_OVERHEAD;
    if (cap < pt_n + 1) return -1;
    uint64_t c = 0;
    for (int i = 1; i <= 8; i++) c = c << 8 | frame[i];
    if (c <= s->in_n) return -1;   /* repetido o viejo */
    uint8_t iv[12];
    memcpy(iv, S2R, 4);
    memcpy(iv + 4, frame + 1, 8);
    if (gcm(0, s->ks, iv, frame, 9, frame + 9, pt_n, (uint8_t *)out, (uint8_t *)frame + 9 + pt_n)) return -1;
    s->in_n = c;
    out[pt_n] = 0;
    return (long)pt_n;
}

int link_key_hex(const char *hex, uint8_t k[LINK_KEY_LEN])
{
    if (!hex || strlen(hex) != 2 * LINK_KEY_LEN) return -1;
    for (int i = 0; i < 2 * LINK_KEY_LEN; i++) {
        char c = hex[i];
        int v = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
        if (v < 0) return -1;
        k[i / 2] = (uint8_t)(i % 2 ? (k[i / 2] << 4 | v) : v);
    }
    return 0;
}
