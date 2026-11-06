/* lan.c — ver lan.h */
#include "lan.h"

#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "mbedtls/md.h"

static const char MAGIC[3] = {'A', 'L', '1'};
#define MAC_LEN 8

static void mac(const uint8_t key[LAN_KEY_LEN], const char *json, size_t n, uint8_t out[MAC_LEN])
{
    uint8_t full[32];
    mbedtls_md_context_t c;
    mbedtls_md_init(&c);
    mbedtls_md_setup(&c, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
    mbedtls_md_hmac_starts(&c, key, LAN_KEY_LEN);
    mbedtls_md_hmac_update(&c, (const unsigned char *)"alma-lan", 8);
    mbedtls_md_hmac_update(&c, (const unsigned char *)json, n);
    mbedtls_md_hmac_finish(&c, full);
    mbedtls_md_free(&c);
    memcpy(out, full, MAC_LEN);
}

long lan_pack(const uint8_t key[LAN_KEY_LEN], const char *id, uint32_t boot, uint32_t *n, const char *body,
              uint8_t *out, size_t cap)
{
    if (cap < sizeof MAGIC + MAC_LEN + 2) return -1;
    char *js = (char *)out + sizeof MAGIC + MAC_LEN;
    size_t room = cap - sizeof MAGIC - MAC_LEN;
    int k = snprintf(js, room, "{\"id\":\"%s\",\"b\":%lu,\"n\":%lu%s%s}", id, (unsigned long)boot,
                     (unsigned long)++*n, body && body[0] ? "," : "", body ? body : "");
    if (k < 0 || (size_t)k >= room) return -1;
    memcpy(out, MAGIC, sizeof MAGIC);
    mac(key, js, (size_t)k, out + sizeof MAGIC);
    return (long)(sizeof MAGIC + MAC_LEN) + k;
}

long lan_unpack(const uint8_t key[LAN_KEY_LEN], const uint8_t *in, size_t len, uint32_t ip, int64_t now_ms,
                lan_peer peers[LAN_PEERS], char *out, size_t cap, const char *my_id, int *who)
{
    if (len < sizeof MAGIC + MAC_LEN + 2 || memcmp(in, MAGIC, sizeof MAGIC)) return -1;
    size_t n = len - sizeof MAGIC - MAC_LEN;
    if (n + 1 > cap) return -1;
    uint8_t m[MAC_LEN];
    mac(key, (const char *)in + sizeof MAGIC + MAC_LEN, n, m);
    uint8_t diff = 0;
    for (int i = 0; i < MAC_LEN; i++) diff |= m[i] ^ in[sizeof MAGIC + i];
    if (diff) return -1;   /* firma de otra llave, o alterado */
    memcpy(out, in + sizeof MAGIC + MAC_LEN, n);
    out[n] = 0;
    cJSON *j = cJSON_Parse(out);
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(j, "id"), *b = cJSON_GetObjectItemCaseSensitive(j, "b"),
                *c = cJSON_GetObjectItemCaseSensitive(j, "n");
    long r = -1;
    if (cJSON_IsString(id) && cJSON_IsNumber(b) && cJSON_IsNumber(c) && strlen(id->valuestring) < sizeof peers[0].id &&
        strcmp(id->valuestring, my_id) != 0) {   /* lo que uno mismo manda por difusión también llega: se ignora */
        uint32_t boot = (uint32_t)b->valuedouble, cnt = (uint32_t)c->valuedouble;
        lan_peer *p = NULL, *free_p = NULL, *oldest = &peers[0];
        for (int i = 0; i < LAN_PEERS; i++) {
            if (!strcmp(peers[i].id, id->valuestring)) p = &peers[i];
            if (!peers[i].id[0] && !free_p) free_p = &peers[i];
            if (peers[i].seen_ms < oldest->seen_ms) oldest = &peers[i];
        }
        if (!p) {
            p = free_p ? free_p : oldest;
            memset(p, 0, sizeof *p);
            snprintf(p->id, sizeof p->id, "%s", id->valuestring);
        }
        if (p->boot != boot || cnt > p->n) {   /* arrancó de nuevo, o es nuevo: se acepta */
            p->boot = boot;
            p->n = cnt;
            p->ip = ip;
            p->seen_ms = now_ms;
            if (who) *who = (int)(p - peers);
            r = (long)n;
        }
    }
    cJSON_Delete(j);
    return r;
}

const lan_peer *lan_find(const lan_peer peers[LAN_PEERS], const char *id, int64_t now_ms)
{
    for (int i = 0; i < LAN_PEERS; i++)
        if (!strcmp(peers[i].id, id) && now_ms - peers[i].seen_ms < LAN_PEER_MS) return &peers[i];
    return NULL;
}
