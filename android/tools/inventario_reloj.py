"""Inventario reducido para el núcleo del reloj (PLAN-RELOJ-v2.md, 8).

El cargador del catálogo necesita la duración y si es marcha de cada movimiento que nombra el catálogo. El reloj no
lleva ningún archivo del robot: solo esta lista de nombres con su duración, sacada del inventario de la PC.

Uso: python inventario_reloj.py <catalog.json> <assets_inventory.json> <salida.json>
"""

import json
import sys


def mots(catalog: dict) -> set[str]:
    out = set()
    for b in catalog["behaviors"]:
        for o in (b.get("motion") or {}).get("options", []):
            out.update(o if isinstance(o, list) else [o])
    return out


def main():
    cat_p, inv_p, out_p = sys.argv[1:4]
    with open(cat_p, encoding="utf-8") as f:
        catalog = json.load(f)
    with open(inv_p, encoding="utf-8") as f:
        inv = json.load(f)["mot"]
    need = mots(catalog)
    missing = sorted(need - set(inv))
    if missing:
        sys.exit(f"faltan en el inventario: {missing[:10]}")
    out = {"mot": {m: {"dur_s": inv[m]["dur_s"], "gait": bool(inv[m]["gait"])} for m in sorted(need)}}
    with open(out_p, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{out_p}: {len(need)} movimientos")


if __name__ == "__main__":
    main()
