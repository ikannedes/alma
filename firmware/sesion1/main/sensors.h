/* Prueba f) de la sesión 1: lectura de sensores para llenar los huecos 10 a 15 de f2/PENDIENTES.md. Solo lectura.
 * - Pines desconocidos: solo entradas, sin pull (o pull débil, a pedido); nunca salidas. No se tocan los pines
 *   asignados en 02 (servos 5/21/25/26, UART 1/3/4/12, SPI 2/13/14/15, RESETN 22, GPIO23, I2S 27/35, flash y PSRAM).
 * - I2C solo en GPIO19 (SDA) / GPIO18 (SCL), el bus del original [BOBBY-ARTE]; GPIO0 no se toca. El sondeo es una lectura de 1 byte; los registros
 *   se leen escribiendo solo el puntero de registro. La única escritura de configuración es sensors_imu_enable(),
 *   documentada en sesion1.md, y solo si el chip responde como LSM6DS3TR-C y está apagado.
 * - f2b: sensor táctil capacitivo interno en GPIO27/32/33, los tres pads del original [BOBBY-ARTE]. */
#pragma once

void sensors_init(void);
void sensors_i2c_scan(void);        /* f1: direcciones que responden y registros de ID */
void sensors_legs_enable(void);    /* GPIO0 en alto al arrancar, como el firmware de fábrica [BOBBY-ARTE] */
void sensors_board_variant(void);  /* P: variante de placa (GPIO21/GPIO0) con los sensores de pie [BOBBY-ARTE] */
void sensors_imu_enable(void);      /* f1: 2 escrituras mínimas en el LSM6DS3TR-C (ver sesion1.md) */
void sensors_stream_toggle(void);   /* f2: una línea cada 50 ms con ADC, GPIO36 (cargador) e IMU */
void sensors_pull_cycle(void);      /* f2: sin efecto (GPIO36 no tiene pull interno); se conserva la tecla */
void sensors_touch_toggle(void);    /* f2b: sensor táctil en GPIO27/32/33, encender y apagar */
void sensors_rec_start(void);       /* f3: registro en RAM cada 1 s, hasta 20 min */
void sensors_rec_print(void);       /* f3: imprime lo registrado */
