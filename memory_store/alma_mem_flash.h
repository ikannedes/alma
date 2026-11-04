/* alma_mem_flash.h — almacenamiento por debajo de memory_store (06): leer, escribir y borrar por sector.
 *
 * Semántica de flash NOR: borrar deja 0xFF; escribir solo baja bits (1 → 0). Implementaciones:
 *   - alma_mem_flash_file.c: imagen en la PC (archivo o RAM), con cortes de energía simulados para las pruebas;
 *   - alma_mem_flash_esp32.c: región libre del flash del ESP32 (06, "Dónde se guarda"): partición registrada en
 *     0xB60000 (512 KB); escribe solo con ALMA_MEM_WRITE_ENABLED = 1 (variante -MemWrite, PRUEBA-MEMORIA.md).
 */
#ifndef ALMA_MEM_FLASH_H
#define ALMA_MEM_FLASH_H

#include <stdint.h>

#define ALMA_MEM_SECTOR 4096u

typedef struct {
    int (*read)(void *ctx, uint32_t off, void *buf, uint32_t n);
    int (*write)(void *ctx, uint32_t off, const void *buf, uint32_t n);
    int (*erase)(void *ctx, uint32_t off, uint32_t n);   /* off y n múltiplos de ALMA_MEM_SECTOR */
    uint32_t size;                                       /* bytes de la región */
    void *ctx;
} alma_mem_flash;                                        /* las tres funciones devuelven 0 si todo salió bien */

/* ---- PC (alma_mem_flash_file.c) ---- */
typedef struct {
    uint8_t *img;           /* imagen en RAM */
    uint32_t size;
    void *file;             /* FILE *: si no es NULL, cada cambio se escribe también al archivo */
    /* corte de energía simulado: tras cut_after bytes programados o borrados, la operación queda a medias
     * y todas las siguientes fallan hasta alma_mem_file_power_on (reinicio) */
    long long cut_after;    /* −1 = sin corte */
    long long programmed;   /* bytes programados o borrados desde el último encendido */
    int dead;
    uint32_t noise;         /* semilla del estado indefinido del byte cortado */
    uint32_t n_write, n_erase;
    uint32_t erase_count[512];   /* borrados por sector (los primeros 2 MB), para medir el desgaste */
} alma_mem_file;

/* path NULL = solo RAM. Si el archivo existe y tiene el tamaño, se carga; si no, la región empieza borrada. */
int  alma_mem_file_open(alma_mem_file *f, alma_mem_flash *out, const char *path, uint32_t size);
void alma_mem_file_close(alma_mem_file *f);
void alma_mem_file_cut(alma_mem_file *f, long long after_bytes);   /* programa un corte; −1 lo quita */
void alma_mem_file_power_on(alma_mem_file *f);                      /* "reinicio": vuelve a aceptar operaciones */

/* ---- ESP32 (alma_mem_flash_esp32.c) ---- */
int  alma_mem_esp32_open(alma_mem_flash *out);   /* hoy devuelve −1: stub hasta implementar la opción elegida en 06 */

#endif
