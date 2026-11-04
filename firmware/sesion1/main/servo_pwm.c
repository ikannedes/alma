#include "servo_pwm.h"

#include <math.h>
#include <stdio.h>

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#if !ALMA_DEV_MOTION_ON_USB
#error "alma-sesion1 mueve servos con el USB del puente conectado: compilar con ALMA_DEV_MOTION_ON_USB=1 (09, R14)"
#endif

const int SERVO_GPIO[SERVO_COUNT] = {21, 25, 5, 26};
const char *const SERVO_NAME[SERVO_COUNT] = {"pierna izquierda (GPIO21)", "pierna derecha (GPIO25)",
                                             "pie izquierdo (GPIO5)", "pie derecho (GPIO26)"};

#define RES_BITS   14
#define PERIOD_US  20000
#define DEG_MIN    0.0f      /* R10: además, cada prueba limita su propio rango */
#define DEG_MAX    180.0f

static bool active[SERVO_COUNT];
static float cur[SERVO_COUNT];
static volatile bool stop_req;

static uint32_t duty_of(float deg)
{
    float us = 500.0f + deg * 2000.0f / 180.0f;
    return (uint32_t)lroundf(us * (float)(1 << RES_BITS) / PERIOD_US);
}

void servo_init(void)
{
    ledc_timer_config_t t = {
        .speed_mode = LEDC_LOW_SPEED_MODE, .duty_resolution = RES_BITS, .timer_num = LEDC_TIMER_0,
        .freq_hz = 50, .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&t));
}

int servo_index_of_gpio(int gpio)
{
    for (int i = 0; i < SERVO_COUNT; i++)
        if (SERVO_GPIO[i] == gpio) return i;
    return -1;
}

bool servo_set(int idx, float deg)
{
    if (idx < 0 || idx >= SERVO_COUNT || deg < DEG_MIN || deg > DEG_MAX) return false;
    if (!active[idx]) {
        ledc_channel_config_t c = {
            .gpio_num = SERVO_GPIO[idx], .speed_mode = LEDC_LOW_SPEED_MODE, .channel = (ledc_channel_t)idx,
            .timer_sel = LEDC_TIMER_0, .duty = duty_of(deg), .hpoint = 0,
        };
        ESP_ERROR_CHECK(ledc_channel_config(&c));
        active[idx] = true;
    } else {
        ESP_ERROR_CHECK(ledc_set_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)idx, duty_of(deg)));
        ESP_ERROR_CHECK(ledc_update_duty(LEDC_LOW_SPEED_MODE, (ledc_channel_t)idx));
    }
    cur[idx] = deg;
    return true;
}

float servo_get(int idx) { return active[idx] ? cur[idx] : NAN; }

bool servo_ramp_to(int idx, float deg, float step_deg, int step_ms)
{
    if (!active[idx]) return servo_set(idx, deg) && !stop_req;
    while (!stop_req && fabsf(cur[idx] - deg) > 1e-3f) {
        float d = deg - cur[idx];
        float s = fabsf(d) < step_deg ? d : copysignf(step_deg, d);
        servo_set(idx, cur[idx] + s);
        vTaskDelay(pdMS_TO_TICKS(step_ms));
    }
    return !stop_req;
}

void servo_request_stop(void) { stop_req = true; }
void servo_clear_stop(void) { stop_req = false; }
bool servo_stop_requested(void) { return stop_req; }

void servo_release_all(void)
{
    for (int i = 0; i < SERVO_COUNT; i++) {
        if (!active[i]) continue;
        ledc_stop(LEDC_LOW_SPEED_MODE, (ledc_channel_t)i, 0);
        gpio_reset_pin(SERVO_GPIO[i]);        /* vuelve a entrada: sin pulsos */
        active[i] = false;
    }
}
