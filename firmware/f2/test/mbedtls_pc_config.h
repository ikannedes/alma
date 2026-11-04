/* mbedTLS para las pruebas en la PC: solo lo que usa el enlace (link.c). En el robot se usa la configuración de ESP-IDF. */
#define MBEDTLS_AES_C
#define MBEDTLS_CIPHER_C
#define MBEDTLS_GCM_C
#define MBEDTLS_MD_C
#define MBEDTLS_SHA256_C
#define MBEDTLS_PLATFORM_C   /* check_config.h lo pide en Windows */
