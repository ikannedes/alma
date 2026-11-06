# alma-base. Se reusan sin copiar del robot (f2/app): el enlace cifrado (link, ws, uplink), la OTA, el registro por Wi-Fi
# (rlog) y la cola de avisos (outbox); cJSON (MIT) de sim/third_party.
set(A ${CMAKE_CURRENT_LIST_DIR}/../../..)          # alma/
set(F2 ${A}/firmware/f2)
set(CJSON ${A}/sim/third_party/cjson/cJSON.c)
if(NOT DEFINED ENV{ALMA_F2_CREDS_DIR} OR NOT EXISTS $ENV{ALMA_F2_CREDS_DIR}/alma_dev_creds.h)
    message(FATAL_ERROR "alma-base necesita ALMA_F2_CREDS_DIR=<carpeta fuera del repo con alma_dev_creds.h> (build_base.ps1 -CredsDir)")
endif()
get_filename_component(creds $ENV{ALMA_F2_CREDS_DIR} ABSOLUTE)
get_filename_component(repo ${A}/.. ABSOLUTE)
string(FIND "${creds}" "${repo}" inside)
if(inside EQUAL 0)
    message(FATAL_ERROR "las credenciales no pueden estar dentro del repo (${repo})")
endif()

idf_component_register(
    SRCS main.c hal_base.c red.c leds.c anuncio.c guard.c pong.c musica.c ${F2}/main/lan_esp32.c
         ${F2}/app/link.c ${F2}/app/ws.c ${F2}/app/uplink.c ${F2}/app/ota.c ${F2}/app/rlog.c ${F2}/app/outbox.c ${F2}/app/lan.c ${CJSON}
    INCLUDE_DIRS . ${F2}/app ${A}/core ${A}/memory_store ${F2}/../sesion1/main ${A}/sim/third_party/cjson ${creds}
    EMBED_FILES alma_base.alb
    REQUIRES driver esp_timer esp_wifi esp_netif esp_event mbedtls nvs_flash bt esp_coex app_update esp_partition spi_flash
)
# Sin PSRAM: los búferes del robot, más chicos (el trozo de OTA del servidor es de 4000 bytes, ~5.4 KB en base64)
target_compile_definitions(${COMPONENT_LIB} PRIVATE ALMA_F2_API=1 UPLINK_MAX=6144 RLOG_CAP=8192 OUTBOX_N=4 OUTBOX_LEN=512 OTA_CHUNK_MAX=4096)
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra -Werror)
set_source_files_properties(${CJSON} PROPERTIES COMPILE_OPTIONS "-Wno-error;-w")
# Nunca borrar la NVS de la base (ahí está el Wi-Fi de la casa): estas llamadas caen en guard.c y abortan
target_link_libraries(${COMPONENT_LIB} INTERFACE
    "-Wl,--wrap=nvs_flash_erase" "-Wl,--wrap=nvs_flash_erase_partition" "-Wl,--wrap=nvs_flash_erase_partition_ptr")
