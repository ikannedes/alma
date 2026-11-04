cmake_minimum_required(VERSION 3.22.1)
project(alma_nucleo C)

# alma/ (el núcleo, la memoria y el cargador del catálogo son los mismos del robot y del simulador)
get_filename_component(ALMA "${CMAKE_CURRENT_SOURCE_DIR}/../../../../.." ABSOLUTE)

add_library(alma_nucleo SHARED
    alma_jni.c
    ${ALMA}/core/alma_core.c ${ALMA}/core/alma_emotion.c ${ALMA}/core/alma_bonds.c ${ALMA}/core/alma_select.c
    ${ALMA}/core/alma_rhythm.c ${ALMA}/core/alma_rng.c ${ALMA}/core/alma_care.c
    ${ALMA}/memory_store/alma_mem.c ${ALMA}/memory_store/alma_mem_flash_file.c
    ${ALMA}/sim/catalog_load.c ${ALMA}/sim/third_party/cjson/cJSON.c)
target_include_directories(alma_nucleo PRIVATE ${ALMA}/core ${ALMA}/memory_store ${ALMA}/sim ${ALMA}/sim/third_party/cjson)
target_compile_options(alma_nucleo PRIVATE -std=c11 -O2 -Wall)
target_link_libraries(alma_nucleo m log)
