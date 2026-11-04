"""PNG de "sticker" para encimarlo en la cara de EMO (dueño, 2026-11-02: la app original pone un dibujo sobre los ojos;
así la cara de hambre es una sola y solo cambia la comida del globo).

Formato que espera la pantalla [BOBBY-ARTE]: PNG de 320×240 con alfa; lo que tiene alfa ≤ 49 queda transparente y se ve
la animación de abajo, el resto se pinta encima. El robot lo sube como 0:/png/sticker.png y lo muestra con `59 01`.

Uso: python sticker_png.py <comida> <salida.png>     (comida: un sticker de assets/stickers, p. ej. hamburguesa)
     python sticker_png.py --globo <salida.png>        (solo el globo, vacío)
"""

import os
import sys

import numpy as np
from PIL import Image

W, H = 320, 240
STICKERS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "stickers")


def _rgba(name, width):
    """Sticker sobre negro → RGBA (el negro se vuelve transparente), escalado a `width` px."""
    im = Image.open(os.path.join(STICKERS, name + ".png")).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    alpha = np.clip((a.max(axis=2) - 12) / 40, 0, 1)
    rgba = np.dstack([a, alpha * 255]).astype(np.uint8)
    im = Image.fromarray(rgba, "RGBA")
    return im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)


def sticker(comida=None):
    """El globo de pensamiento arriba a la derecha (donde lo pone la cara de hambre) con la comida adentro."""
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    globo = _rgba("globo_pensamiento", 96)
    out.alpha_composite(globo, (266 - globo.width // 2, 34 - globo.height // 2))
    if comida:
        c = _rgba(comida, 44)
        out.alpha_composite(c, (270 - c.width // 2, 30 - c.height // 2))
    a = np.asarray(out).copy()
    a[a[..., 3] <= 49] = 0   # lo que la pantalla tomaría como transparente, transparente de verdad (y el PNG más chico)
    return Image.fromarray(a, "RGBA")


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    comida = None if sys.argv[1] == "--globo" else sys.argv[1]
    im = sticker(comida)
    im.save(sys.argv[2], optimize=True)
    print(f"{sys.argv[2]}: {W}×{H} RGBA, {os.path.getsize(sys.argv[2])} bytes")


if __name__ == "__main__":
    main()
