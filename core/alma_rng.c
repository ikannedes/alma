/* alma_rng.c — RNG portable: xoroshiro128+ sembrado con splitmix64. */
#include "alma_core.h"

static uint64_t splitmix64(uint64_t *x)
{
    uint64_t z = (*x += 0x9E3779B97F4A7C15ULL);
    z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
    z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
    return z ^ (z >> 31);
}

static uint64_t rotl(uint64_t x, int k) { return (x << k) | (x >> (64 - k)); }

void alma_rng_seed(alma_rng *r, uint64_t seed)
{
    r->s[0] = splitmix64(&seed);
    r->s[1] = splitmix64(&seed);
}

float alma_rng_u01(alma_rng *r)
{
    uint64_t s0 = r->s[0], s1 = r->s[1], out = s0 + s1;
    s1 ^= s0;
    r->s[0] = rotl(s0, 24) ^ s1 ^ (s1 << 16);
    r->s[1] = rotl(s1, 37);
    return (float)((out >> 40) * (1.0 / 16777216.0));   /* 24 bits en [0, 1) */
}

/* Beta(2, 2) = mediana de 3 uniformes (estadístico de orden 2 de 3) — 04, "Rasgos" */
float alma_rng_beta22(alma_rng *r)
{
    float x = alma_rng_u01(r), y = alma_rng_u01(r), z = alma_rng_u01(r), t;
    if (x > y) { t = x; x = y; y = t; }
    if (y > z) { y = z; }
    return x > y ? x : y;
}
