#!/usr/bin/env python3
"""Genera assets_inventory.json (privado, 02) a partir de una carpeta de .mot.

Por cada .mot: número de cuadros, duración (02 [BOBBY-ARTE]: pose y pausa = bytes 16-17; primitiva de marcha =
pasos × T, con pasos = byte 6 / 10 y T = bytes 16-17) y si tiene cuadros de paso, giro o modo raro (marca † de 05).

Uso: python -I make_inventory.py <carpeta_mot> <salida.json>
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "alma-spec", "tools"))
from mot_tool import parse  # noqa: E402

mot_dir, out = sys.argv[1], sys.argv[2]
inv = {}
for name in sorted(os.listdir(mot_dir)):
    raw = open(os.path.join(mot_dir, name), "rb").read()
    frames = parse(raw)
    ms = sum(f["ms"] if f["mode"] == "pose" or raw[20 * i + 5] == 0xFD else raw[20 * i + 6] / 10 * f["ms"]
             for i, f in enumerate(frames))
    inv[os.path.splitext(name)[0]] = {
        "frames": len(frames),
        "dur_s": round(ms / 1000, 3),
        "gait": any(f["mode"] != "pose" for f in frames),
    }
with open(out, "w", newline="\n") as f:
    json.dump({"mot": inv, "avi": {}, "mp3": {}}, f, indent=1)
print(f"{len(inv)} .mot -> {out}")
