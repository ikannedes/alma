# alma-f2. Se reusan sin copiar: k210_frames.c, mot.c y log_util.c de sesion1; alma_core, memory_store y
# catalog_load tal como están; catalog.json embebido; cJSON (MIT) de sim/third_party.
set(A ${CMAKE_CURRENT_LIST_DIR}/../../..)          # alma/
set(F2 ${CMAKE_CURRENT_LIST_DIR}/..)
set(S1 ${CMAKE_CURRENT_LIST_DIR}/../../sesion1/main)
file(GLOB APP_SRCS ${F2}/app/*.c)
file(GLOB CORE_SRCS ${A}/core/*.c)
set(CJSON ${A}/sim/third_party/cjson/cJSON.c)

# ALMA_F2_API y ALMA_F2_CREDS_DIR van por variable de entorno: ESP-IDF resuelve los REQUIRES en una pasada aparte
# que no ve los -D de idf.py (build_esp32.ps1 -Api las pone).
if(DEFINED ENV{ALMA_F2_API})
    set(ALMA_F2_API $ENV{ALMA_F2_API})
endif()
if(DEFINED ENV{ALMA_F2_CREDS_DIR})
    set(ALMA_F2_CREDS_DIR $ENV{ALMA_F2_CREDS_DIR})
endif()
if(NOT DEFINED ALMA_F2_API)
    set(ALMA_F2_API 0)
endif()
set(reqs driver esp_adc esp_timer esp_partition esp_psram spi_flash vfs esp_rom app_update esp_app_format)
set(incs . ${F2}/app ${S1} ${A}/core ${A}/memory_store ${A}/sim ${A}/sim/third_party/cjson)
if(ALMA_F2_API)
    # Credenciales de desarrollo en un archivo local fuera del repo (dev_creds.example.h)
    if(NOT DEFINED ALMA_F2_CREDS_DIR OR NOT EXISTS ${ALMA_F2_CREDS_DIR}/alma_dev_creds.h)
        message(FATAL_ERROR "ALMA_F2_API=1 necesita -DALMA_F2_CREDS_DIR=<carpeta fuera del repo con alma_dev_creds.h>")
    endif()
    get_filename_component(creds ${ALMA_F2_CREDS_DIR} ABSOLUTE)
    get_filename_component(repo ${A}/.. ABSOLUTE)
    string(FIND "${creds}" "${repo}" inside)
    if(inside EQUAL 0)
        message(FATAL_ERROR "las credenciales de desarrollo no pueden estar dentro del repo (${repo})")
    endif()
    list(APPEND reqs esp_wifi esp_netif esp_event mbedtls)
    list(APPEND incs ${creds})
endif()
# Escuchar la Home Station por Bluetooth (ble_base.c; dueño, 2026-11-05): ALMA_F2_BLE=1 por entorno (build_esp32.ps1 -Ble),
# con el sdkconfig de la variante (NimBLE solo observador). Sin ella, hal_home_ble dice que no la ve.
set(BLE_SRCS)
if("$ENV{ALMA_F2_BLE}" STREQUAL "1")
    list(APPEND reqs bt esp_coex)
    set(BLE_SRCS ble_base.c)
endif()

idf_component_register(
    SRCS main.c hal_esp32.c vl53l0x.c r15_guard.c api_esp32.c lan_esp32.c ${BLE_SRCS} ${APP_SRCS}
         ${S1}/k210_frames.c ${S1}/mot.c ${S1}/log_util.c ${S1}/vivo.c
         ${CORE_SRCS} ${A}/memory_store/alma_mem.c ${A}/memory_store/alma_mem_flash_esp32.c ${A}/sim/catalog_load.c ${CJSON}
    INCLUDE_DIRS ${incs}
    EMBED_TXTFILES ${A}/catalog/catalog.json
    EMBED_FILES alma_test.avi sticker_test.png alma_brain.almb
    REQUIRES ${reqs}
)
# memory_store lee y valida pero no escribe (06): la primera escritura tendrá su propio plan de sesión.
# R14: ALMA_DEV_MOTION_ON_USB queda en 0 (alma_params.h), salvo la variante de desarrollo (build_esp32.ps1 -MotionOnUsb),
# que deja mover servos con el USB puesto para probar la marcha con la consola abierta. Nunca para dejarla corriendo sola.
# PRUEBA-MEMORIA.md: la variante -MemWrite (build_esp32.ps1) enciende la escritura en 0xB60000–0xBE0000 (06). Por omisión, 0.
set(MEMW 0)
if("$ENV{ALMA_MEM_WRITE_ENABLED}" STREQUAL "1")
    set(MEMW 1)
endif()
target_compile_definitions(${COMPONENT_LIB} PRIVATE ALMA_MEM_WRITE_ENABLED=${MEMW} ALMA_F2_API=${ALMA_F2_API} VIVO_ELF_SHA_FULL=1)
# Variante remota (sesion1a.md): sin servos en el binario (ALMA_SERVOS_DISABLED por entorno, build_esp32.ps1 -Remota)
if("$ENV{ALMA_DEV_MOTION_ON_USB}" STREQUAL "1")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE ALMA_DEV_MOTION_ON_USB=1)
endif()
if("$ENV{ALMA_F2_BLE}" STREQUAL "1")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE ALMA_F2_BLE=1)
endif()
if("$ENV{ALMA_SERVOS_DISABLED}" STREQUAL "1")
    target_compile_definitions(${COMPONENT_LIB} PRIVATE ALMA_SERVOS_DISABLED=1)
endif()
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
# cJSON es de terceros: sus avisos no cuentan como código propio
set_source_files_properties(${CJSON} PROPERTIES COMPILE_OPTIONS "-Wno-error;-w")
# Candado de R15: cualquier llamada a estas funciones cae en r15_guard.c y aborta
target_link_libraries(${COMPONENT_LIB} INTERFACE
    "-Wl,--wrap=nvs_flash_init" "-Wl,--wrap=nvs_flash_erase"
    "-Wl,--wrap=nvs_flash_erase_partition" "-Wl,--wrap=nvs_flash_erase_partition_ptr")
