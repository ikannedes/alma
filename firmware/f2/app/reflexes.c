#include "reflexes.h"

#include "app.h"
#include "f2_hal.h"
#include "motion_player.h"

static int64_t last_ms = -1;

int reflex_is(alma_ev_type t) { return t == EV_CLIFF || t == EV_PICKED_UP || t == EV_SHAKEN || t == EV_TIPPED_OVER; }

void reflex_fire(alma_ev_type t)
{
    motion_stop_now();
    hal_servo_hold_all();
    last_ms = hal_now_ms();
    hal_log("REFLEJO %s: servos quietos", app_ev_name(t));
}

int64_t reflex_last_ms(void) { return last_ms; }
