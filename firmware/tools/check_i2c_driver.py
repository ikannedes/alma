#!/usr/bin/env python3
"""Comprueba en el ELF que el I2C usa solo el driver heredado de ESP-IDF (driver/i2c.h), como pide sensors.c.

En ESP-IDF v5.2.1 los dos drivers no pueden estar juntos: el constructor check_i2c_driver_conflict del heredado
(components/driver/i2c/i2c.c:1651) aborta al arrancar si encuentra i2c_acquire_bus_handle, del driver nuevo
(i2c_master). Falla si el ELF trae algún símbolo del driver nuevo, o si falta el heredado.

Uso: python -I check_i2c_driver.py <archivo.elf>
Necesita xtensa-esp32-elf-nm en el PATH (export.ps1 de ESP-IDF) o en la carpeta de herramientas de .espressif.
"""
import glob
import os
import re
import shutil
import subprocess
import sys

elf = sys.argv[1]
nm = shutil.which("xtensa-esp32-elf-nm") or next(iter(glob.glob(os.path.expanduser(
    "~/.espressif/tools/xtensa-esp-elf/*/xtensa-esp-elf/bin/xtensa-esp32-elf-nm*"))), None)
if not nm:
    sys.exit("no encuentro xtensa-esp32-elf-nm")
# solo símbolos definidos: los débiles sin definir (como la referencia del constructor) salen con "w" o "U"
defined = {l.split()[-1] for l in subprocess.run([nm, "--defined-only", elf], capture_output=True, text=True, check=True).stdout.splitlines()
           if l.strip()}
NEW = re.compile(r"^(i2c_acquire_bus_handle|i2c_new_master_bus|i2c_del_master_bus|i2c_master_bus_add_device|i2c_master_transmit"
                 r"|i2c_master_receive|i2c_master_isr_handler_default)$")
new = sorted(s for s in defined if NEW.match(s))
legacy = {"i2c_driver_install", "i2c_master_cmd_begin"} <= defined
name = os.path.basename(elf)
if new:
    print(f"{name}: FALLA, el ELF trae el driver I2C nuevo (i2c_master); con el heredado aborta al arrancar:")
    for s in new:
        print("  -", s)
    sys.exit(1)
if not legacy:
    print(f"{name}: FALLA, no está el driver I2C heredado (i2c_driver_install, i2c_master_cmd_begin)")
    sys.exit(1)
print(f"{name}: ok, I2C solo con el driver heredado (sin i2c_master)")
