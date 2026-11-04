"""Caras nuevas para la pantalla de EMO, dibujadas por código en su formato nativo (dueño, 2026-11-01: "caras
nuevas con el mismo estilo, sin perder detalle al escalar").

Formato de las caras de fábrica (medido): MJPEG 320×240, 15 fps, yuvj444p; ojos cian de 108×108 con esquinas
redondeadas, borde más oscuro y centro brillante (2, 251, 255), en x 33–140 y 179–286, y 54–161, sobre negro puro.
Se dibuja a 4× y se reduce con LANCZOS (solo hacia abajo: nítido al píxel); los negros quedan en 0.

Uso: python generar_cara.py <cara> <salida.avi> [--png carpeta] [--gif vista.gif]
Caras: navidad, muertos.
"""

import argparse
import math
import os
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageDraw

W, H, FPS, SS = 320, 240, 15, 4
EYES = [(33, 54, 108, 108), (179, 54, 108, 108)]          # x, y, ancho, alto (píxeles de 320×240)
CENTER, RIM = np.array([2, 251, 255]), np.array([33, 185, 188])
RADIUS = 30


def _smooth(t):
    t = np.clip(t, 0, 1)
    return t * t * (3 - 2 * t)


def eyes_layer(open_=1.0, dx=0.0, dy=0.0, under=None):
    """Los dos ojos (como los de fábrica) a 4×, encima de `under` (fondo a 4×, p. ej. la nieve); open_ < 1 los aplasta
    (parpadeo) hacia el centro."""
    w, h = W * SS, H * SS
    img = np.zeros((h, w, 3), np.float32) if under is None else under.astype(np.float32)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32) / SS
    for (x, y, ew, eh) in EYES:
        eh2 = max(eh * open_, 4.0)
        cx, cy = x + ew / 2 + dx, y + eh / 2 + dy
        hx, hy = ew / 2, eh2 / 2
        r = min(RADIUS, hx, hy)
        qx, qy = np.abs(xx - cx) - (hx - r), np.abs(yy - cy) - (hy - r)
        d = np.hypot(np.maximum(qx, 0), np.maximum(qy, 0)) + np.minimum(np.maximum(qx, qy), 0) - r   # <0 dentro
        inside = _smooth((-d) / 0.75)                       # borde suave de ~1 px
        glow = _smooth((-d) / 14.0)                         # del borde oscuro al centro brillante
        col = RIM[None, None, :] + (CENTER - RIM)[None, None, :] * glow[..., None]
        a = inside[..., None]
        img = img * (1 - a) + col * a
    return img


def _bezier(p0, p1, p2, n=24):
    return [((1 - u) ** 2 * p0[0] + 2 * (1 - u) * u * p1[0] + u * u * p2[0],
             (1 - u) ** 2 * p0[1] + 2 * (1 - u) * u * p1[1] + u * u * p2[1]) for u in np.linspace(0, 1, n)]


def santa_hat(draw, t, drop):
    """Gorro de Santa sobre el ojo izquierdo (a 4×): cono que se dobla hacia la derecha con la borla colgando.
    drop 0→1: baja desde arriba; t: segundos (la punta se bambolea)."""
    s = SS
    off = (1 - drop) * -150
    sway = math.sin(t * 2 * math.pi * 0.7) * 5
    by = 58 + off                                            # ala del gorro, sobre el borde de arriba del ojo
    tip = (168 + sway, 40 + off + abs(sway) * 0.4)           # la punta cae a la derecha
    left = _bezier((30, by), (52, by - 62), (118, by - 54))  # lomo del cono
    fold = _bezier((118, by - 54), (150, by - 50), tip)      # se dobla
    right = _bezier(tip, (132, by - 36), (140, by))          # vuelve por abajo
    pts = [(x * s, y * s) for x, y in left + fold + right]
    draw.polygon(pts, fill=(214, 28, 40))
    shade = _bezier((30, by), (50, by - 52), (98, by - 54)) + [(80, by)]   # sombra del lado izquierdo
    draw.polygon([(x * s, y * s) for x, y in shade], fill=(186, 18, 30))
    draw.rounded_rectangle([22 * s, (by - 9) * s, 150 * s, (by + 9) * s], radius=9 * s, fill=(244, 244, 250))
    draw.ellipse([(tip[0] - 10) * s, (tip[1] - 6) * s, (tip[0] + 10) * s, (tip[1] + 14) * s], fill=(250, 250, 255))


def snow(draw, t, seed=7):
    rng = np.random.default_rng(seed)
    for _ in range(26):
        x0, sp, sz, ph = rng.uniform(0, W), rng.uniform(18, 40), rng.uniform(1.2, 2.6), rng.uniform(0, H)
        y = (ph + sp * t) % (H + 10) - 5
        x = x0 + 4 * math.sin(t * 2 + ph)
        draw.ellipse([(x - sz) * SS, (y - sz) * SS, (x + sz) * SS, (y + sz) * SS], fill=(235, 245, 255))


def navidad(n=45):
    frames = []
    for i in range(n):
        t = i / FPS
        drop = _smooth(np.float32(min(1.0, i / 10)))        # el gorro baja en los primeros 10 cuadros
        blink = 1.0
        if 30 <= i <= 34:                                   # parpadeo: cierra y abre en 5 cuadros
            blink = [0.6, 0.15, 0.05, 0.3, 0.75][i - 30]
        bg = Image.new("RGB", (W * SS, H * SS))
        snow(ImageDraw.Draw(bg), t)                         # la nieve cae detrás de los ojos
        eyes = eyes_layer(blink, dy=2 * math.sin(t * 2 * math.pi * 0.5), under=np.asarray(bg))
        im = Image.fromarray(np.clip(eyes, 0, 255).astype(np.uint8))
        santa_hat(ImageDraw.Draw(im), t, float(drop))
        frames.append(im.resize((W, H), Image.LANCZOS))
    return frames


# ---- Día de Muertos (dueño, 2026-11-02): papel picado y cempasúchil generados con GPT en Pixelcut (assets/), el resto
# dibujado aquí. Los PNG vienen sobre negro: el negro se vuelve transparente ----
ASSETS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")


def _sprite(name, width):
    """PNG de assets/ recortado a lo que no es negro, escalado a `width` px (a 4×), con alfa sacada del negro."""
    im = Image.open(os.path.join(ASSETS, name)).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    mask = a.max(axis=2) > 12
    ys, xs = np.where(mask)
    im = im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    h = round(im.height * width * SS / im.width)
    im = im.resize((width * SS, h), Image.LANCZOS)
    rgb = np.asarray(im).astype(np.float32)
    alpha = np.clip((rgb.max(axis=2) - 12) / 40, 0, 1)
    return rgb, alpha


def _paste(img, sprite, x, y):
    """Pone un sprite (rgb, alfa) en img (a 4×) con la esquina en (x, y) en píxeles de 320×240."""
    rgb, a = sprite
    x0, y0 = int(round(x * SS)), int(round(y * SS))
    h, w = a.shape
    H4, W4 = img.shape[:2]
    sx0, sy0 = max(0, -x0), max(0, -y0)
    dx0, dy0 = max(0, x0), max(0, y0)
    dx1, dy1 = min(W4, x0 + w), min(H4, y0 + h)
    if dx1 <= dx0 or dy1 <= dy0:
        return img
    sub = (slice(sy0, sy0 + dy1 - dy0), slice(sx0, sx0 + dx1 - dx0))
    aa = a[sub][..., None]
    img[dy0:dy1, dx0:dx1] = img[dy0:dy1, dx0:dx1] * (1 - aa) + rgb[sub] * aa
    return img


def petals(draw, t, seed=11):
    """Pétalos de cempasúchil que caen y giran (detrás de los ojos)."""
    rng = np.random.default_rng(seed)
    for _ in range(16):
        x0, sp, sz, ph = rng.uniform(0, W), rng.uniform(14, 30), rng.uniform(2.2, 3.6), rng.uniform(0, H)
        y = (ph + sp * t) % (H + 12) - 6
        x = x0 + 6 * math.sin(t * 1.6 + ph)
        ang = t * 3 + ph
        dx, dy = math.cos(ang) * sz, math.sin(ang) * sz * 0.5
        col = (255, 140, 0) if ph % 2 < 1 else (255, 186, 20)
        draw.polygon([((x - dx) * SS, (y - dy) * SS), ((x + dy) * SS, (y - dx * 0.5) * SS),
                      ((x + dx) * SS, (y + dy) * SS), ((x - dy) * SS, (y + dx * 0.5) * SS)], fill=col)


def sugar_skull(draw, glow):
    """Adorno de calaverita bajo cada ojo: un arco de puntos y una florecita en la esquina de afuera."""
    for k, (x, y, ew, eh) in enumerate(EYES):
        cx = x + ew / 2
        for j in range(7):   # arco de puntos bajo el ojo
            ang = math.pi * (0.2 + 0.6 * j / 6)
            px, py = cx + math.cos(ang) * 50, y + eh + 2 + math.sin(ang) * 10
            r = 2.6 if j % 2 == 0 else 1.8
            c = (255, 255, 255) if j % 2 == 0 else (255, 70, 170)
            c = tuple(int(v * glow) for v in c)
            draw.ellipse([(px - r) * SS, (py - r) * SS, (px + r) * SS, (py + r) * SS], fill=c)
        fx = x - 9 if k == 0 else x + ew + 9   # florecita de 5 pétalos afuera del ojo
        fy = y + eh * 0.55
        for j in range(5):
            ang = j * 2 * math.pi / 5
            px, py = fx + math.cos(ang) * 4.2, fy + math.sin(ang) * 4.2
            draw.ellipse([(px - 3) * SS, (py - 3) * SS, (px + 3) * SS, (py + 3) * SS],
                         fill=tuple(int(v * glow) for v in (180, 90, 255)))
        draw.ellipse([(fx - 2.4) * SS, (fy - 2.4) * SS, (fx + 2.4) * SS, (fy + 2.4) * SS],
                     fill=tuple(int(v * glow) for v in (255, 210, 40)))


def muertos(n=60):
    papel = _sprite("papel_2.png", 236)
    flor = _sprite("flor_1.png", 50)
    frames = []
    for i in range(n):
        t = i / FPS
        drop = float(_smooth(np.float32(min(1.0, i / 12))))   # el papel picado baja en los primeros 12 cuadros
        pop = float(_smooth(np.float32(max(0.0, min(1.0, (i - 8) / 8)))))   # la flor aparece después
        blink = 1.0
        if 40 <= i <= 44:
            blink = [0.6, 0.15, 0.05, 0.3, 0.75][i - 40]
        bg = Image.new("RGB", (W * SS, H * SS))
        petals(ImageDraw.Draw(bg), t)
        img = eyes_layer(blink, dy=2 * math.sin(t * 2 * math.pi * 0.5), under=np.asarray(bg))
        sway = 2.5 * math.sin(t * 2 * math.pi * 0.4)
        img = _paste(img, papel, 42 + sway, -12 - (1 - drop) * 60)   # cuelga arriba sin tapar los ojos
        if pop > 0:   # cempasúchil sobre el ojo derecho, como flor en el pelo
            size = max(2, int(50 * (0.6 + 0.4 * pop)))
            f = flor if size == 50 else _sprite("flor_1.png", size)
            img = _paste(img, f, 274 - size / 2, 52 - size / 2)
        im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
        sugar_skull(ImageDraw.Draw(im), min(1.0, i / 10))
        frames.append(im.resize((W, H), Image.LANCZOS))
    return frames


FACES = {"navidad": navidad, "muertos": muertos}


def to_avi(frames, out, q=2):
    """MJPEG como las de fábrica: 320×240, 15 fps, yuvj444p, calidad alta (q 2; más alto = más chico)."""
    with tempfile.TemporaryDirectory() as d:
        for i, f in enumerate(frames):
            a = np.asarray(f).copy()
            a[a.max(axis=2) < 6] = 0                        # negro puro (sin grises de la compresión)
            Image.fromarray(a).save(os.path.join(d, f"f_{i:03d}.png"))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", str(FPS), "-i", os.path.join(d, "f_%03d.png"),
                        "-c:v", "mjpeg", "-pix_fmt", "yuvj444p", "-q:v", str(q), "-an", out], check=True)


def main():
    import fiestas   # las de festividades (fiestas.py) usan este módulo
    FACES.update(fiestas.FIESTAS)
    FACES.update(fiestas.HAMBRE)
    FACES.update(fiestas.OTRAS)
    ap = argparse.ArgumentParser()
    ap.add_argument("cara", choices=sorted(FACES))
    ap.add_argument("salida")
    ap.add_argument("--png")
    ap.add_argument("--gif")
    a = ap.parse_args()
    frames = FACES[a.cara]()
    to_avi(frames, a.salida, fiestas.CALIDAD.get(a.cara, 2))
    if a.png:
        os.makedirs(a.png, exist_ok=True)
        for i, f in enumerate(frames):
            f.save(os.path.join(a.png, f"{a.cara}_{i:03d}.png"))
    if a.gif:
        frames[0].save(a.gif, save_all=True, append_images=frames[1:], duration=int(1000 / FPS), loop=0)
    print(f"{a.salida}: {len(frames)} cuadros {W}×{H} a {FPS} fps")


if __name__ == "__main__":
    main()
