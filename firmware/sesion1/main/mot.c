#include "mot.h"

#include <string.h>

int mot_parse_frame(const uint8_t f[MOT_FRAME_LEN], mot_frame *out)
{
    if (f[0] != 0x55 || f[1] != 0xAA || f[2] != 0x55 || f[3] != 0xAA || f[19] != 0xED) return -1;
    unsigned s = 0;
    for (int i = 4; i <= 17; i++) s += f[i];
    if ((uint8_t)s != f[18]) return -1;
    out->type = f[4];
    out->mode = f[5];
    for (int i = 0; i < 4; i++) out->s[i] = f[11 + i];
    out->ms = (uint16_t)(f[16] | (f[17] << 8));
    out->steps10 = f[6];
    for (int i = 0; i < 7; i++) out->gp[i] = f[6 + i];
    return 0;
}

uint32_t mot_frame_ms(const mot_frame *f)
{
    if (f->mode == MOT_MODE_POSE || f->mode == 0xFD) return f->ms;
    return (uint32_t)f->steps10 * f->ms / 10;
}

/* Layout verificado en la imagen de esta unidad (02, "Particiones"; emo_tools/spiffs_read.py). */
#define BLOCK      4096u
#define PAGE       256u
#define PPB        (BLOCK / PAGE)
#define HDR        5u
#define DATA       (PAGE - HDR)
#define NAME_LEN   32u
#define IX_FLAG    0x8000u
#define FLAG_DELET 0x80u
#define FLAG_FINAL 0x02u
#define FLAG_USED  0x01u

static int page_live(const uint8_t h[HDR])
{
    uint8_t flags = h[4];
    return (flags & FLAG_DELET) && !(flags & (FLAG_USED | FLAG_FINAL));   /* banderas activas en bajo */
}

static int name_eq(const uint8_t *raw, const char *name)
{
    size_t i = 0;
    for (; i < NAME_LEN && raw[i] > 0x20 && raw[i] < 0x7F; i++)   /* algunos nombres llenan los 32 bytes sin \0 */
        if (name[i] != (char)raw[i]) return 0;
    return name[i] == '\0';
}

long spiffs_find(spiffs_read_fn rd, void *ctx, uint32_t part_size, const char *name, uint8_t *out, size_t cap)
{
    uint8_t lu[PAGE], h[HDR + 3 + 4 + 1 + NAME_LEN];
    uint16_t oid = 0;
    uint32_t size = 0;
    int found = 0;
    uint32_t blocks = part_size / BLOCK;

    for (uint32_t b = 0; b < blocks && !found; b++) {
        if (rd(ctx, b * BLOCK, lu, PAGE)) return -1;
        for (uint32_t p = 1; p < PPB; p++) {
            uint16_t lid = (uint16_t)(lu[(p - 1) * 2] | (lu[(p - 1) * 2 + 1] << 8));
            if (lid == 0xFFFF || lid == 0x0000 || !(lid & IX_FLAG)) continue;
            if (rd(ctx, b * BLOCK + p * PAGE, h, sizeof h)) return -1;
            uint16_t id = (uint16_t)(h[0] | (h[1] << 8)), span = (uint16_t)(h[2] | (h[3] << 8));
            if (!page_live(h) || !(id & IX_FLAG) || span != 0) continue;
            if (!name_eq(h + 13, name)) continue;
            oid = (uint16_t)(id & ~IX_FLAG);
            size = (uint32_t)h[8] | ((uint32_t)h[9] << 8) | ((uint32_t)h[10] << 16) | ((uint32_t)h[11] << 24);
            found = 1;
            break;
        }
    }
    if (!found) return -1;
    if (size > cap || size > part_size) return -2;

    uint32_t spans = (size + DATA - 1) / DATA, got = 0;
    for (uint32_t b = 0; b < blocks && got < spans; b++) {
        if (rd(ctx, b * BLOCK, lu, PAGE)) return -1;
        for (uint32_t p = 1; p < PPB; p++) {
            uint16_t lid = (uint16_t)(lu[(p - 1) * 2] | (lu[(p - 1) * 2 + 1] << 8));
            if (lid != oid) continue;
            uint32_t off = b * BLOCK + p * PAGE;
            if (rd(ctx, off, h, HDR)) return -1;
            uint16_t id = (uint16_t)(h[0] | (h[1] << 8)), span = (uint16_t)(h[2] | (h[3] << 8));
            if (id != oid || !page_live(h) || span >= spans) continue;
            uint32_t at = span * DATA, n = size - at < DATA ? size - at : DATA;
            if (rd(ctx, off + HDR, out + at, n)) return -1;
            got++;
        }
    }
    return got == spans ? (long)size : -2;
}
