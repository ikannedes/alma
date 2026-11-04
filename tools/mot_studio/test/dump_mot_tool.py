"""Vuelca a JSON lo que mot_tool.parse da para cada .mot de una carpeta (referencia para test_mot_studio.js).

Uso: dump_mot_tool.py <alma-spec/tools> <carpeta_mot> <salida.json>
"""
import json
import os
import sys

sys.path.insert(0, sys.argv[1])
import mot_tool  # noqa: E402

out = {}
for name in sorted(os.listdir(sys.argv[2])):
    if not name.endswith((".mot", ".mo", ".m")):
        continue
    try:
        frames = mot_tool.parse(open(os.path.join(sys.argv[2], name), "rb").read())
        out[name] = [{"type": f["type"], "mode": f["mode"], "gait": list(f["gait"]), "s": list(f["s"]), "ms": f["ms"]} for f in frames]
    except ValueError as e:
        out[name] = {"error": str(e)}
json.dump(out, open(sys.argv[3], "w", encoding="utf-8"))
print(len(out), "archivos")
