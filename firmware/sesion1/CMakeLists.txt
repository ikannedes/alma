cmake_minimum_required(VERSION 3.16)
# Variante remota (sesion1a.md): ALMA_SERVOS_DISABLED=1 por variable de entorno (build_variants.ps1). Va por entorno
# porque ESP-IDF resuelve los componentes en una pasada que no ve los -D.
if("$ENV{ALMA_SERVOS_DISABLED}" STREQUAL "1")
    set(PROJECT_VER "0.1.3-remota")
else()
    set(PROJECT_VER "0.1.3")
endif()
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(alma-sesion1)
