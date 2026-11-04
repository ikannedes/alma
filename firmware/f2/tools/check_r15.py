#!/usr/bin/env python3
"""Revisa una compilación de alma-f2 contra R15 (09; 06, "La partición nvs original").

1. sdkconfig final: CONFIG_ESP_WIFI_NVS_ENABLED y CONFIG_ESP_PHY_CALIBRATION_AND_DATA_STORAGE apagadas.
2. El enlace lleva -Wl,--wrap= de nvs_flash_init, nvs_flash_erase, nvs_flash_erase_partition y _ptr.
3. El ELF no trae las funciones reales que inicializan o borran una NVS (las arrastraría quien las llame
   sin pasar por el candado). Con --allow-own-nvs se acepta nvs_flash_init_partition_ptr (NVS propia, 06).

Uso: python -I check_r15.py <carpeta build> [--allow-own-nvs]
Sale con 1 si algo falla. Necesita xtensa-esp32-elf-nm en el PATH (export.ps1 de ESP-IDF).
"""
import glob
import json
import os
import shutil
import subprocess
import sys

build = sys.argv[1]
allow_own = "--allow-own-nvs" in sys.argv
errors = []

cfg = json.load(open(os.path.join(build, "config", "sdkconfig.json"), encoding="utf-8"))
for k in ("ESP_WIFI_NVS_ENABLED", "ESP_PHY_CALIBRATION_AND_DATA_STORAGE"):
    if cfg.get(k, False):
        errors.append(f"CONFIG_{k}=y en el sdkconfig final")

ninja = open(os.path.join(build, "build.ninja"), encoding="utf-8", errors="replace").read()
WRAPS = ("nvs_flash_init", "nvs_flash_erase", "nvs_flash_erase_partition", "nvs_flash_erase_partition_ptr")
for w in WRAPS:
    if f"--wrap={w} " not in ninja and f"--wrap={w}\"" not in ninja and f"--wrap={w}\n" not in ninja:
        errors.append(f"falta -Wl,--wrap={w} en el enlace")

elfs = [e for e in glob.glob(os.path.join(build, "*.elf")) if "bootloader" not in e]
nm = shutil.which("xtensa-esp32-elf-nm")
if not elfs or not nm:
    errors.append("no encuentro el ELF o xtensa-esp32-elf-nm")
else:
    syms = subprocess.run([nm, elfs[0]], capture_output=True, text=True, check=True).stdout.split()
    banned = {"nvs_flash_init_partition", "nvs_flash_secure_init_partition", "nvs_flash_erase_partition",
              "nvs_flash_erase_partition_ptr", "nvs_flash_init", "nvs_flash_erase"}
    if not allow_own:
        banned.add("nvs_flash_init_partition_ptr")
    for s in sorted(banned & set(syms)):
        errors.append(f"el ELF trae {s}")

if errors:
    print("R15: FALLA")
    for e in errors:
        print("  -", e)
    sys.exit(1)
print(f"R15: ok (sdkconfig sin NVS de Wi-Fi ni de PHY; {len(WRAPS)} --wrap en el enlace; "
      f"ninguna función que inicialice o borre NVS en {os.path.basename(elfs[0])})")
