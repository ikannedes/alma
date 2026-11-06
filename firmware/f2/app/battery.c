#include "battery.h"

int battery_mv(int pin_mv, int charging) { return 2 * pin_mv + (charging ? -130 : 50); }

float battery_pct(int bat_mv, int charging)
{
    static const int MV[] = {3400, 3529, 3589, 3669, 3999};   /* sin cargar; cargando, cada punto + 100 mV */
    static const float PCT[] = {0, 20, 40, 60, 100};
    int off = charging ? 100 : 0;
    if (bat_mv <= MV[0] + off) return 0;
    for (int i = 1; i < (int)(sizeof MV / sizeof *MV); i++)
        if (bat_mv < MV[i] + off)
            return PCT[i - 1] + (PCT[i] - PCT[i - 1]) * (float)(bat_mv - MV[i - 1] - off) / (float)(MV[i] - MV[i - 1]);
    return 100;
}

int battery_charger_kind(int present, int rx0, int base, int64_t present_ms)
{
    if (!present) return 0;
    if (base == 1) return 1;                      /* la base lo ve: es ella, aunque RX0 esté en alto */
    if (base == 0) return present_ms >= BASE_LAG_MS ? 2 : -1;   /* corriente y la base dice que no: es el cable */
    return rx0 ? 2 : 1;                           /* sin noticias de la base: como antes */
}
