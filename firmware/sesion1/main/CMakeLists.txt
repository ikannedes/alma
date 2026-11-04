set(srcs "main.c" "k210_frames.c" "k210_link.c" "log_util.c" "mot.c" "sensors.c" "vivo.c")
if("$ENV{ALMA_SERVOS_DISABLED}" STREQUAL "1")
    set(servos_off 1)
else()
    set(servos_off 0)
    list(APPEND srcs "servo_pwm.c")   # la variante remota no lo compila: ningún GPIO de servo se inicializa
endif()
idf_component_register(
    SRCS ${srcs}
    INCLUDE_DIRS "."
    REQUIRES driver esp_timer esp_partition app_update esp_psram esp_app_format esp_adc
)
if(servos_off)
    target_compile_definitions(${COMPONENT_LIB} PRIVATE ALMA_SERVOS_DISABLED=1 ALMA_DEV_MOTION_ON_USB=0)
else()
    # 09, R14: esta compilación mueve servos con el USB del puente conectado.
    target_compile_definitions(${COMPONENT_LIB} PRIVATE ALMA_DEV_MOTION_ON_USB=1)
endif()
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
