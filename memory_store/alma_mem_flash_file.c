/* alma_mem_flash_file.c — flash NOR simulada en la PC para memory_store (pruebas y simulador). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "alma_mem_flash.h"

static uint32_t xorshift(uint32_t *s) { *s ^= *s << 13; *s ^= *s >> 17; *s ^= *s << 5; return *s; }

static void sync_file(alma_mem_file *f, uint32_t off, uint32_t n)
{
    if (!f->file) return;
    fseek((FILE *)f->file, (long)off, SEEK_SET);
    fwrite(f->img + off, 1, n, (FILE *)f->file);
    fflush((FILE *)f->file);
}

/* cuántos bytes de esta operación caben antes del corte; −1 = todos */
static long long budget(alma_mem_file *f, uint32_t n)
{
    if (f->cut_after < 0 || f->programmed + n <= f->cut_after) { f->programmed += n; return -1; }
    long long k = f->cut_after - f->programmed;
    f->programmed = f->cut_after;
    f->dead = 1;
    return k < 0 ? 0 : k;
}

static int fl_read(void *ctx, uint32_t off, void *buf, uint32_t n)
{
    alma_mem_file *f = ctx;
    if (f->dead || off > f->size || n > f->size - off) return -1;
    memcpy(buf, f->img + off, n);
    return 0;
}

static int fl_write(void *ctx, uint32_t off, const void *buf, uint32_t n)
{
    alma_mem_file *f = ctx;
    if (f->dead || off > f->size || n > f->size - off) return -1;
    f->n_write++;
    const uint8_t *src = buf;
    long long k = budget(f, n);
    uint32_t done = k < 0 ? n : (uint32_t)k;
    for (uint32_t i = 0; i < done; i++) f->img[off + i] &= src[i];
    if (k >= 0 && done < n) f->img[off + done] &= (uint8_t)(src[done] | xorshift(&f->noise));   /* byte a medio programar */
    sync_file(f, off, n);
    return k < 0 ? 0 : -1;
}

static int fl_erase(void *ctx, uint32_t off, uint32_t n)
{
    alma_mem_file *f = ctx;
    if (f->dead || off % ALMA_MEM_SECTOR || n % ALMA_MEM_SECTOR || off > f->size || n > f->size - off) return -1;
    f->n_erase++;
    for (uint32_t s = off / ALMA_MEM_SECTOR; s < (off + n) / ALMA_MEM_SECTOR && s < 512; s++) f->erase_count[s]++;
    long long k = budget(f, n);
    uint32_t done = k < 0 ? n : (uint32_t)k;
    memset(f->img + off, 0xFF, done);
    if (k >= 0)   /* borrado interrumpido: el resto del sector queda indefinido */
        for (uint32_t i = done; i < n && (off + i) % ALMA_MEM_SECTOR; i++) f->img[off + i] = (uint8_t)xorshift(&f->noise);
    sync_file(f, off, n);
    return k < 0 ? 0 : -1;
}

int alma_mem_file_open(alma_mem_file *f, alma_mem_flash *out, const char *path, uint32_t size)
{
    memset(f, 0, sizeof *f);
    f->img = malloc(size);
    if (!f->img) return -1;
    f->size = size;
    f->cut_after = -1;
    f->noise = 0x2545F491u;
    memset(f->img, 0xFF, size);
    if (path) {
        FILE *fp = fopen(path, "r+b");
        if (fp) {
            if (fread(f->img, 1, size, fp) != size) memset(f->img, 0xFF, size);
        } else {
            fp = fopen(path, "w+b");
            if (!fp) { free(f->img); return -1; }
        }
        f->file = fp;
        sync_file(f, 0, size);
    }
    *out = (alma_mem_flash){fl_read, fl_write, fl_erase, size, f};
    return 0;
}

void alma_mem_file_close(alma_mem_file *f)
{
    if (f->file) fclose((FILE *)f->file);
    free(f->img);
    memset(f, 0, sizeof *f);
}

void alma_mem_file_cut(alma_mem_file *f, long long after_bytes) { f->cut_after = after_bytes; f->programmed = 0; }
void alma_mem_file_power_on(alma_mem_file *f) { f->dead = 0; f->cut_after = -1; f->programmed = 0; }
