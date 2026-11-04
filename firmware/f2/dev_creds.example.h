/* Plantilla de credenciales de desarrollo para ALMA_F2_API=1. NO pongas credenciales reales en el repo:
 * copia este archivo FUERA del repo como alma_dev_creds.h (por ejemplo en C:\Users\ikann\emo_tools\f2_creds)
 * y compila con:  build_esp32.ps1 -Api [-Remota] -CredsDir C:\Users\ikann\emo_tools\f2_creds
 * main/CMakeLists.txt se niega a compilar si la carpeta está dentro del repo. El binario que resulta lleva la
 * contraseña del Wi-Fi: es privado como la nvs (R6) y la restauración de la sesión lo borra de ota_1. */
#pragma once
#define ALMA_DEV_WIFI_SSID     "cambiar"
#define ALMA_DEV_WIFI_PASSWORD "cambiar"
/* Enlace con el servidor (relay /v1/robot, sin TLS; cifrado con la llave del enlace, link.h). La misma llave se pone en
   la app del servidor (Ajustes → llave del enlace). Sin estas dos líneas el robot no se conecta. */
#define ALMA_DEV_RELAY_HOST    "alma.example.com"
#define ALMA_DEV_RELAY_PORT    8080
#define ALMA_DEV_LINK_KEY      "cambiar-por-64-caracteres-hexadecimales-(32-bytes-aleatorios)"
/* SNTP (hueco 16): público; alma-f2 solo sale a este servidor, nunca a *.living.ai (R3) */
#define ALMA_DEV_NTP_SERVER    "pool.ntp.org"
/* Zona horaria POSIX, por ejemplo "CST6" (centro de México, sin horario de verano) */
#define ALMA_DEV_TZ            "CST6"
