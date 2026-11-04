#!/usr/bin/env python3
"""Comprueba en el ELF que una variante "remota" no puede mover servos (sesion1a.md).

Falla si el ELF trae algún símbolo de los drivers que pueden generar una señal de servo en un GPIO (LEDC, MCPWM o
RMT, en sus capas driver, HAL y LL) o del código de servos de Alma (servo_pwm.c de sesion1, el LEDC de
hal_esp32.c de f2). Sin esos drivers no hay nada en el binario que configure GPIO 5, 21, 25 o 26 como salida de
PWM o de RMT. Además lista cualquier referencia a gpio_config que quede, para revisar a mano que no toque esos pines.

Uso: python -I check_servos_off.py <archivo.elf> [--expect-servos]
  --expect-servos: prueba negativa; con el ELF normal (con servos) debe encontrarlos y salir con 0.
Necesita xtensa-esp32-elf-nm en el PATH (export.ps1 de ESP-IDF) o en la carpeta de herramientas de .espressif.
"""
import glob
import os
import re
import shutil
import subprocess
import sys

elf = sys.argv[1]
expect = "--expect-servos" in sys.argv
nm = shutil.which("xtensa-esp32-elf-nm") or next(iter(glob.glob(os.path.expanduser(
    "~/.espressif/tools/xtensa-esp-elf/*/xtensa-esp-elf/bin/xtensa-esp32-elf-nm*"))), None)
if not nm:
    sys.exit("no encuentro xtensa-esp32-elf-nm")
syms = [l.split()[-1] for l in subprocess.run([nm, elf], capture_output=True, text=True, check=True).stdout.splitlines() if l.strip()]
BAD = re.compile(r"^(ledc_|mcpwm_|rmt_|_?ledc_hal|mcpwm_hal|rmt_hal|ledc_ll|mcpwm_ll|rmt_ll|servo_|hal_esp32_servo_init$|duty_of$)")
found = sorted({s for s in syms if BAD.match(s)})
gpio = sorted({s for s in syms if s in ("gpio_config", "gpio_set_direction", "gpio_matrix_out", "esp_rom_gpio_connect_out_signal")})
name = os.path.basename(elf)
if expect:
    print(f"{name}: {len(found)} símbolos de servo (se esperaban: prueba negativa)")
    sys.exit(0 if found else 1)
if found:
    print(f"{name}: FALLA, el ELF trae símbolos de servo:")
    for s in found[:40]:
        print("  -", s)
    sys.exit(1)
print(f"{name}: ok, sin LEDC, MCPWM, RMT ni código de servos. Funciones de GPIO presentes (otros pines): {', '.join(gpio) or 'ninguna'}")
