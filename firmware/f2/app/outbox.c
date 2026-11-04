/* outbox.c — ver outbox.h */
#include "outbox.h"

#include <stdio.h>
#include <string.h>

#include "f2_hal.h"

static EXT_RAM_BSS_ATTR char box[OUTBOX_N][OUTBOX_LEN];
static int head, count;

void outbox_put(const char *json)
{
    if (strlen(json) >= OUTBOX_LEN) { hal_log("enlace: mensaje de %u bytes, no cabe", (unsigned)strlen(json)); return; }
    if (count == OUTBOX_N) { head = (head + 1) % OUTBOX_N; count--; hal_log("enlace: cola llena, se pierde el más viejo"); }
    snprintf(box[(head + count++) % OUTBOX_N], OUTBOX_LEN, "%s", json);
}

void outbox_event(const char *ev, const char *extra)
{
    char j[256];
    snprintf(j, sizeof j, "{\"t\":\"event\",\"ev\":\"%s\"%s}", ev, extra ? extra : "");
    outbox_put(j);
}

long outbox_take(char *out, size_t cap)
{
    if (!count) return 0;
    size_t n = strlen(box[head]);
    if (n >= cap) n = cap - 1;
    memcpy(out, box[head], n);
    out[n] = 0;
    head = (head + 1) % OUTBOX_N;
    count--;
    return (long)n;
}

int outbox_count(void) { return count; }
void outbox_clear(void) { head = count = 0; }
