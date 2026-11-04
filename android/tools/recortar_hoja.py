"""Recorta una hoja de íconos generada (cuadrícula sobre negro) en PNG con transparencia para la app del reloj.

El negro del fondo pasa a transparente: alfa = brillo del pixel y el color se "des-multiplica" para que el borde no
quede oscuro. Uso: python recortar_hoja.py <hoja.png> <columnas> <filas> <carpeta> <tamaño> nombre1 nombre2 …
(los nombres van por filas; "-" salta una celda). --relleno: para ilustraciones a color.
"""

import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def _fondo_desde_orilla(celda):
    """Alfa por relleno: solo el negro conectado a la orilla es fondo (las partes oscuras adentro se quedan)."""
    m = Image.fromarray(((celda.max(axis=2) > 18) * 255).astype(np.uint8), "L").copy()   # copia: el relleno escribe
    w, h = m.size
    for p in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if m.getpixel(p) == 0:
            ImageDraw.floodfill(m, p, 128)
    a = (np.asarray(m) != 128).astype(np.float32) * 255
    return np.asarray(Image.fromarray(a.astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)), np.float32) / 255


def recortar(hoja, cols, filas, out, tam, nombres, relleno=False):
    im = Image.open(hoja).convert("RGB")
    W, H = im.size
    cw, ch = W / cols, H / filas
    os.makedirs(out, exist_ok=True)
    for i, n in enumerate(nombres):
        if n == "-":
            continue
        c, f = i % cols, i // cols
        celda = np.asarray(im.crop((int(c * cw), int(f * ch), int((c + 1) * cw), int((f + 1) * ch))), np.float32)
        if relleno:                                           # ilustraciones a color (comida)
            a = _fondo_desde_orilla(celda)
            b = int(min(a.shape) * 0.045)                     # lo que asoma de la celda vecina, fuera
            a[:b, :] = a[-b:, :] = a[:, :b] = a[:, -b:] = 0
            rgb = celda
        else:                                                 # íconos de un color: alfa por brillo
            a = celda.max(axis=2)
            a = np.clip((a - 12) / (255 - 12), 0, 1)          # el negro casi puro también es fondo
            rgb = np.where(a[..., None] > 0, celda / np.maximum(a[..., None], 1e-3), 0)
        rgba = np.dstack([np.clip(rgb, 0, 255), a * 255]).astype(np.uint8)
        img = Image.fromarray(rgba, "RGBA")
        caja = img.getbbox()                                  # recorte ajustado y cuadrado, con margen
        if caja:
            x0, y0, x1, y1 = caja
            lado = int(max(x1 - x0, y1 - y0) * 1.12)
            cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
            img = img.crop((cx - lado // 2, cy - lado // 2, cx + lado // 2, cy + lado // 2))
        img.resize((tam, tam), Image.LANCZOS).save(os.path.join(out, f"{n}.png"))
    print(out, len([n for n in nombres if n != "-"]), "imágenes")


if __name__ == "__main__":
    a = [x for x in sys.argv if x != "--relleno"]
    recortar(a[1], int(a[2]), int(a[3]), a[4], int(a[5]), a[6:], relleno="--relleno" in sys.argv)
