/* rlog.c — ver rlog.h */
#include "rlog.h"

#include <stdio.h>
#include <string.h>

#include "f2_hal.h"

#ifndef RLOG_CAP   /* la base: menos (sin PSRAM) */
#define RLOG_CAP   32768   /* en PSRAM; si se llena, se pierden las más viejas y se avisa */
#endif
#define RLOG_CHUNK 2048    /* texto por mensaje (antes de escapar) */

static EXT_RAM_BSS_ATTR char ring[RLOG_CAP];
static size_t head, used;
static int on, lost;

void rlog_set(int v) { on = v; head = used = 0; lost = 0; }
int rlog_on(void) { return on; }

void rlog_push(const char *line)
{
    if (!on) return;
    const char *m = strchr(line, ']');   /* después de "[  12.345] " */
    m = m ? m + 2 : line;
    if (!strncmp(m, "TX ", 3) || !strncmp(m, "RX ", 3)) return;
    size_t n = strlen(line);
    if (n > RLOG_CHUNK - 1) n = RLOG_CHUNK - 1;
    while (used + n + 1 > RLOG_CAP) {   /* fuera las más viejas, línea por línea */
        while (used && ring[head] != '\n') { head = (head + 1) % RLOG_CAP; used--; }
        if (used) { head = (head + 1) % RLOG_CAP; used--; }
        lost++;
    }
    for (size_t i = 0; i <= n; i++) ring[(head + used++) % RLOG_CAP] = i < n ? line[i] : '\n';
}

long rlog_take(char *out, size_t cap)
{
    if (!on || !used || cap < 64) return 0;
    int o = snprintf(out, cap, "{\"t\":\"log\",\"s\":\"");
    if (lost) { o += snprintf(out + o, cap - (size_t)o, "(se perdieron %d líneas)\\n", lost); lost = 0; }
    size_t took = 0;
    char c = '\n';
    /* líneas enteras (cortar a media línea podría partir una letra UTF-8 y el servidor no lo podría leer) */
    while (used && (took < RLOG_CHUNK || c != '\n') && (size_t)o + 8 < cap) {
        c = ring[head];
        if (c == '"' || c == '\\') { out[o++] = '\\'; out[o++] = c; }
        else if (c == '\n') { out[o++] = '\\'; out[o++] = 'n'; }
        else if ((unsigned char)c < 0x20) out[o++] = ' ';
        else out[o++] = c;
        head = (head + 1) % RLOG_CAP;
        used--;
        took++;
    }
    out[o++] = '"';
    out[o++] = '}';
    out[o] = 0;
    return o;
}
