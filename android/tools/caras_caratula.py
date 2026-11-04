"""Imágenes de la carátula WFF (PLAN-RELOJ-v2.md, 10), según la propuesta del dueño (2026-11-01): modo Alma y modo
reloj, expresiones solo con los ojos. Los ojos son los ORIGINALES de Alma (alma/tools/caras/generar_cara.py: cian
2,251,255 al centro, borde 33,185,188, esquinas redondeadas), con un halo suave; nada caricaturesco.

Uso: python caras_caratula.py <carpeta_drawable> [--muestra muestra.png]
"""

import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SS = 4
CENTRO = np.array([2, 251, 255], np.float32)
BORDE = np.array([33, 185, 188], np.float32)
HALO = (0, 229, 255)          # #00E5FF de la paleta
AZUL = (0, 134, 255)          # #0086FF
GRIS = (160, 174, 192)        # #A0AEC0

EXPR = ["neutral", "parpadeo", "feliz", "triste", "enojada", "sueno", "enamorada", "asustada"]


def _redondo(dr, x0, y0, x1, y1, r):
    dr.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=255)


def _corazon(dr, cx, cy, w):
    pts = []
    for t in np.linspace(0, 2 * np.pi, 200):
        x = 16 * np.sin(t) ** 3
        y = 13 * np.cos(t) - 5 * np.cos(2 * t) - 2 * np.cos(3 * t) - np.cos(4 * t)
        pts.append((cx + x * w / 34, cy - y * w / 34))
    dr.polygon(pts, fill=255)


def mascara(w, h, expr):
    """La forma de los dos ojos (0–255) a 4×."""
    W, H = w * SS, h * SS
    m = Image.new("L", (W, H), 0)
    dr = ImageDraw.Draw(m)
    e = h * 0.62 * SS                     # lado del ojo
    gap = e * 0.32
    r = e * 0.28
    for lado in (-1, 1):
        cx = W / 2 + lado * (gap / 2 + e / 2)
        cy = H / 2
        x0, y0, x1, y1 = cx - e / 2, cy - e / 2, cx + e / 2, cy + e / 2
        adentro_x = x1 if lado < 0 else x0
        afuera_x = x0 if lado < 0 else x1
        if expr == "neutral":
            _redondo(dr, x0, y0, x1, y1, r)
        elif expr == "asustada":
            s = 0.84
            _redondo(dr, cx - e * s / 2, cy - e * s / 2, cx + e * s / 2, cy + e * s / 2, r * s)
        elif expr in ("parpadeo", "feliz"):
            # un arco: delgado al parpadear, grueso de feliz (^ ^)
            grueso = e * (0.11 if expr == "parpadeo" else 0.2)
            alto = e * (0.32 if expr == "parpadeo" else 0.55)
            caja = [x0, cy - alto / 2, x1, cy + alto * 1.5]
            dr.arc(caja, 200, 340, fill=255, width=int(grueso))
            for ang in (200, 340):        # puntas redondeadas
                rx, ry = (caja[2] - caja[0]) / 2, (caja[3] - caja[1]) / 2
                px = (caja[0] + caja[2]) / 2 + (rx - grueso / 2) * np.cos(np.radians(ang))
                py = (caja[1] + caja[3]) / 2 + (ry - grueso / 2) * np.sin(np.radians(ang))
                dr.ellipse([px - grueso / 2, py - grueso / 2, px + grueso / 2, py + grueso / 2], fill=255)
        elif expr == "sueno":
            _redondo(dr, x0, y0, x1, y1, r)
            dr.rectangle([x0 - 2, y0 - 2, x1 + 2, cy - e * 0.05], fill=0)
            dr.rectangle([x0, cy - e * 0.05, x1, cy + e * 0.05], fill=255)
        elif expr == "triste":
            _redondo(dr, x0, y0, x1, y1, r)
            dr.polygon([(afuera_x + lado * 4, y0 - 4), (afuera_x + lado * 4, y0 + e * 0.5), (cx, y0 - 4)], fill=0)
        elif expr == "enojada":
            _redondo(dr, x0, y0, x1, y1, r)
            dr.polygon([(adentro_x - lado * 4, y0 - 4), (adentro_x - lado * 4, y0 + e * 0.5), (cx, y0 - 4)], fill=0)
        elif expr == "enamorada":
            _corazon(dr, cx, cy + e * 0.05, e * 1.05)
    return m


def ojos(w, h, expr, halo=True):
    """Los ojos con el color original: del borde más oscuro al centro brillante, y un halo suave detrás."""
    m = mascara(w, h, expr)
    a = np.asarray(m, np.float32) / 255
    e = h * 0.62 * SS
    delgado = expr in ("parpadeo", "feliz")              # los arcos son delgados: el brillo se mide más cerca
    interior = np.asarray(m.filter(ImageFilter.GaussianBlur(e * (0.05 if delgado else 0.16))), np.float32) / 255
    t = np.clip((interior - (0.3 if delgado else 0.45)) / 0.5, 0, 1)
    col = BORDE + (CENTRO - BORDE) * t[..., None]
    rgba = np.zeros(a.shape + (4,), np.float32)
    if halo:
        g = np.asarray(m.filter(ImageFilter.GaussianBlur(e * 0.22)), np.float32) / 255 * 0.55
        rgba[..., :3] = np.array(HALO, np.float32)
        rgba[..., 3] = g * 255
    rgba[..., :3] = rgba[..., :3] * (1 - a[..., None]) + col * a[..., None]
    rgba[..., 3] = np.maximum(rgba[..., 3], a * 255)
    if expr == "asustada":                    # rayitas de susto afuera de las esquinas de arriba
        im = Image.fromarray(np.clip(rgba, 0, 255).astype(np.uint8), "RGBA")
        dr = ImageDraw.Draw(im)
        W, H = w * SS, h * SS
        gap = e * 0.32
        for lado in (-1, 1):
            ox = W / 2 + lado * (gap / 2 + e * 0.92)
            oy = H / 2 - e * 0.52
            for dx, dy in ((0.0, -0.22), (0.16, -0.08)):
                dr.line([(ox, oy), (ox + lado * dx * e, oy + dy * e)], fill=HALO + (255,), width=int(e * 0.06))
                ox += lado * e * 0.08
        return im.resize((w, h), Image.LANCZOS)
    return Image.fromarray(np.clip(rgba, 0, 255).astype(np.uint8), "RGBA").resize((w, h), Image.LANCZOS)


def icono(nombre, tam, color):
    W = tam * SS
    im = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    dr = ImageDraw.Draw(im)
    c = color + (255,)
    if nombre == "pulso":
        m = Image.new("L", (W, W), 0)
        _corazon(ImageDraw.Draw(m), W / 2, W / 2, W * 0.95)
        im.paste(Image.new("RGBA", (W, W), c), (0, 0), m)
    elif nombre == "pasos":             # tenis de perfil
        dr.rounded_rectangle([W * 0.08, W * 0.55, W * 0.92, W * 0.78], radius=W * 0.1, fill=c)
        dr.polygon([(W * 0.1, W * 0.6), (W * 0.18, W * 0.22), (W * 0.42, W * 0.25), (W * 0.5, W * 0.45),
                    (W * 0.85, W * 0.55), (W * 0.1, W * 0.62)], fill=c)
        for k in range(3):
            x = W * (0.3 + k * 0.08)
            dr.line([(x, W * 0.36 + k * 3), (x + W * 0.06, W * 0.33 + k * 3)], fill=(0, 0, 0, 255), width=SS * 2)
    elif nombre == "bateria":
        dr.rounded_rectangle([W * 0.05, W * 0.28, W * 0.85, W * 0.72], radius=W * 0.08, outline=c, width=int(W * 0.07))
        dr.rectangle([W * 0.86, W * 0.4, W * 0.95, W * 0.6], fill=c)
        dr.rounded_rectangle([W * 0.15, W * 0.37, W * 0.62, W * 0.63], radius=W * 0.03, fill=c)
    elif nombre == "acentos":           # dos rayitas inclinadas
        for k in range(2):
            x = W * (0.3 + k * 0.3)
            dr.line([(x, W * 0.75), (x + W * 0.22, W * 0.25)], fill=c, width=int(W * 0.12))
            dr.ellipse([x - W * 0.06, W * 0.69, x + W * 0.06, W * 0.81], fill=c)
            dr.ellipse([x + W * 0.16, W * 0.19, x + W * 0.28, W * 0.31], fill=c)
    elif nombre == "chispa":
        p = [(W / 2, 0), (W * 0.6, W * 0.4), (W, W / 2), (W * 0.6, W * 0.6), (W / 2, W), (W * 0.4, W * 0.6), (0, W / 2),
             (W * 0.4, W * 0.4)]
        dr.polygon(p, fill=c)
    return im.resize((tam, tam), Image.LANCZOS)


def guardar(out):
    os.makedirs(out, exist_ok=True)
    for x in EXPR:
        ojos(340, 190, x).save(os.path.join(out, f"ojos_{x}.png"))
        ojos(110, 62, x, halo=False).save(os.path.join(out, f"ojitos_{x}.png"))
    icono("pasos", 44, HALO).save(os.path.join(out, "ico_pasos.png"))
    icono("pulso", 40, (110, 200, 255)).save(os.path.join(out, "ico_pulso.png"))
    icono("bateria", 40, HALO).save(os.path.join(out, "ico_bateria.png"))
    icono("acentos", 44, HALO).save(os.path.join(out, "acentos_der.png"))
    icono("acentos", 44, HALO).transpose(Image.FLIP_LEFT_RIGHT).save(os.path.join(out, "acentos_izq.png"))
    icono("chispa", 18, AZUL).save(os.path.join(out, "chispa.png"))
    prev = Image.new("RGB", (450, 450), "black")
    o = ojos(340, 190, "neutral")
    prev.paste(o, (55, 180), o)
    prev.save(os.path.join(out, "vista_previa.png"))


def muestra(path):
    """Lámina para revisar las expresiones de un vistazo (no va en la app)."""
    hoja = Image.new("RGB", (4 * 360, 2 * 230 + 20), "black")
    for i, x in enumerate(EXPR):
        o = ojos(340, 190, x)
        hoja.paste(o, ((i % 4) * 360 + 10, (i // 4) * 230 + 10), o)
        ImageDraw.Draw(hoja).text(((i % 4) * 360 + 150, (i // 4) * 230 + 205), x, fill=GRIS)
    hoja.save(path)


if __name__ == "__main__":
    guardar(sys.argv[1])
    if "--muestra" in sys.argv:
        muestra(sys.argv[sys.argv.index("--muestra") + 1])
    print("listo")
