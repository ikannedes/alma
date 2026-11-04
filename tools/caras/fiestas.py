"""Caras de festividades para EMO (dueño, 2026-11-02: "una por cada festividad del año, incluso las no tan importantes").

Cada cara es una receta: los ojos de siempre (generar_cara.eyes_layer), stickers de assets/stickers/ (generados con GPT
en Pixelcut en hojas de 3×3, recortados) que entran y se mueven, y partículas dibujadas aquí. Mismo formato que las de
fábrica: 320×240, 15 fps, negro puro.

Animaciones de un sticker: drop (baja desde arriba), pop (crece), bob (sube y baja), swing (se mece colgado),
rise (sube desde abajo y vuelve a empezar), fly (revolotea), spin (gira), pulse (late).
"""

import math
import os

import numpy as np
from PIL import Image, ImageDraw

import generar_cara as g

W, H, FPS, SS = g.W, g.H, g.FPS, g.SS
_cache = {}


def _sticker(name, width, angle=0.0):
    """name@x0,x1,y0,y1: solo ese recorte del sticker (fracciones), p. ej. una oreja de la diadema de conejo."""
    key = (name, int(width), round(angle))
    if key not in _cache:
        base, _, cut = name.partition("@")
        if cut:
            x0, x1, y0, y1 = (float(v) for v in cut.split(","))
            full = Image.open(os.path.join(g.ASSETS, "stickers", base + ".png")).convert("RGB")
            part = full.crop((int(x0 * full.width), int(y0 * full.height), int(x1 * full.width), int(y1 * full.height)))
            tmp = os.path.join(g.ASSETS, "stickers", f"_recorte_{abs(hash(name))}.png")
            part.save(tmp)
            rgb, a = g._sprite(os.path.relpath(tmp, g.ASSETS), int(width))
            os.remove(tmp)
        else:
            rgb, a = g._sprite(f"stickers/{name}.png", int(width))
        if round(angle):
            im = Image.fromarray(rgb.astype(np.uint8)).rotate(round(angle), resample=Image.BICUBIC, expand=True)
            am = Image.fromarray((a * 255).astype(np.uint8)).rotate(round(angle), resample=Image.BICUBIC, expand=True)
            rgb, a = np.asarray(im).astype(np.float32), np.asarray(am).astype(np.float32) / 255
        _cache[key] = (rgb, a)
    return _cache[key]


def _prop(img, p, i):
    """Un sticker de la receta en el cuadro i: (nombre, ancho, x, y, animación, retraso en cuadros)."""
    name, w, x, y = p[:4]
    anim, delay = (p[4] if len(p) > 4 else ""), (p[5] if len(p) > 5 else 0)
    t = max(0, i - delay) / FPS
    if i < delay:
        return img
    k = float(g._smooth(np.float32(min(1.0, (i - delay) / 10))))   # entrada en 10 cuadros
    ang, scale = 0.0, 1.0
    if anim == "drop":
        y -= (1 - k) * (y + 120)
    elif anim == "pop":
        scale = 0.3 + 0.7 * k + 0.08 * math.sin(min(1.0, (i - delay) / 10) * math.pi)
    elif anim == "bob":
        y += 3 * math.sin(t * 2 * math.pi * 0.6)
    elif anim == "swing":
        ang = 9 * math.sin(t * 2 * math.pi * 0.5)
    elif anim == "rise":
        y = H + 20 - ((t * 32) % (H + 90))
        x += 8 * math.sin(t * 1.7)
    elif anim == "fly":
        x += 26 * math.sin(t * 1.3 + w)
        y += 12 * math.sin(t * 2.6 + w)
        ang = 12 * math.sin(t * 6)
    elif anim == "spin":
        ang = -t * 40
    elif anim.startswith("asoma"):   # sale de detrás del ojo hacia arriba
        y += (1 - k) * 46 + 1.5 * math.sin(t * 2 * math.pi * 0.7)
        ang = 4 * math.sin(t * 2 * math.pi * 0.5 + x)
    elif anim == "bounce":
        y -= abs(math.sin(t * math.pi * 1.4)) * 16
    elif anim == "pulse":
        scale = 1 + 0.12 * max(0.0, math.sin(t * 2 * math.pi * 1.2)) ** 4
    ww = max(4, int(w * scale))
    rgb, a = _sticker(name, ww, ang)
    hh, w4 = a.shape[0] / SS, a.shape[1] / SS
    return g._paste(img, (rgb, a), x - w4 / 2, y - hh / 2)


# ---- partículas (detrás de los ojos) ----
def _confeti(d, t, seed, cols):
    rng = np.random.default_rng(seed)
    for _ in range(30):
        x0, sp, ph, c = rng.uniform(0, W), rng.uniform(25, 45), rng.uniform(0, H), cols[rng.integers(len(cols))]
        y = (ph + sp * t) % (H + 10) - 5
        x = x0 + 5 * math.sin(t * 3 + ph)
        a = t * 5 + ph
        dx, dy = 3 * math.cos(a), 1.6 * math.sin(a)
        d.polygon([((x - dx) * SS, (y - dy) * SS), ((x + dy) * SS, (y - dx) * SS), ((x + dx) * SS, (y + dy) * SS),
                   ((x - dy) * SS, (y + dx) * SS)], fill=c)


def _heart(d, x, y, r, c):
    d.ellipse([(x - r) * SS, (y - r) * SS, x * SS, (y + r * 0.2) * SS], fill=c)
    d.ellipse([x * SS, (y - r) * SS, (x + r) * SS, (y + r * 0.2) * SS], fill=c)
    d.polygon([((x - r * 0.97) * SS, (y - r * 0.25) * SS), ((x + r * 0.97) * SS, (y - r * 0.25) * SS),
               (x * SS, (y + r * 1.15) * SS)], fill=c)


def _corazones(d, t, seed, cols):
    rng = np.random.default_rng(seed)
    for _ in range(14):
        x0, sp, ph, r = rng.uniform(10, W - 10), rng.uniform(15, 28), rng.uniform(0, H), rng.uniform(3, 6)
        y = H + 10 - ((ph + sp * t) % (H + 20))   # suben
        _heart(d, x0 + 6 * math.sin(t * 2 + ph), y, r, cols[int(ph) % len(cols)])


def _chispas(d, t, seed, cols):
    rng = np.random.default_rng(seed)
    for _ in range(22):
        x, y, ph, c = rng.uniform(0, W), rng.uniform(0, H), rng.uniform(0, 6.3), cols[rng.integers(len(cols))]
        k = max(0.0, math.sin(t * 4 + ph))
        r = 2.6 * k
        if r < 0.3:
            continue
        d.polygon([(x * SS, (y - r * 2) * SS), ((x + r * 0.5) * SS, (y - r * 0.5) * SS), ((x + r * 2) * SS, y * SS),
                   ((x + r * 0.5) * SS, (y + r * 0.5) * SS), (x * SS, (y + r * 2) * SS), ((x - r * 0.5) * SS, (y + r * 0.5) * SS),
                   ((x - r * 2) * SS, y * SS), ((x - r * 0.5) * SS, (y - r * 0.5) * SS)], fill=c)


def _cohetes(d, t, seed, cols):
    """Fuegos artificiales dibujados: estallidos que crecen y se apagan."""
    rng = np.random.default_rng(seed)
    for k in range(4):
        x, y, ph, c = rng.uniform(30, W - 30), rng.uniform(25, 110), rng.uniform(0, 2), cols[k % len(cols)]
        u = ((t + ph) % 2.0) / 2.0
        if u > 0.75:
            continue
        rad, fade = 6 + 34 * u, 1 - u / 0.75
        cc = tuple(int(v * fade) for v in c)
        for j in range(12):
            a = j * math.pi / 6
            x1, y1 = x + math.cos(a) * rad * 0.55, y + math.sin(a) * rad * 0.55
            x2, y2 = x + math.cos(a) * rad, y + math.sin(a) * rad + 4 * u
            d.line([(x1 * SS, y1 * SS), (x2 * SS, y2 * SS)], fill=cc, width=int(2 * SS))


def _caida(name, n, size):
    """Stickers chiquitos que caen (tréboles, mariposas, estrellas…)."""
    def f(img, t, seed):
        rng = np.random.default_rng(seed)
        for _ in range(n):
            x0, sp, ph = rng.uniform(0, W), rng.uniform(16, 30), rng.uniform(0, H)
            y = (ph + sp * t) % (H + 30) - 15
            img = _prop(img, (name, size, x0 + 6 * math.sin(t * 2 + ph), y, ""), 0)
        return img
    return f


DRAWN = {"confeti": _confeti, "corazones": _corazones, "chispas": _chispas, "cohetes": _cohetes}
TRICOLOR = [(0, 150, 70), (245, 245, 245), (220, 30, 40)]
FIESTA = [(255, 60, 160), (255, 200, 0), (40, 200, 255), (130, 230, 60), (190, 90, 255)]
ORO = [(255, 215, 80), (255, 240, 170)]

# nombre: (fecha aproximada para el calendario, partículas [(tipo, colores) | función de stickers], stickers delante de los ojos)
RECETAS = {
    "ano_nuevo": ("1 ene", [("cohetes", FIESTA), ("confeti", FIESTA)],
                  [("gorro_fiesta", 54, 70, 40, "drop"), ("fuegos", 46, 268, 32, "pulse", 6)]),
    "reyes": ("6 ene", [("chispas", ORO)],
              [("corona", 92, 160, 32, "drop"), ("rosca", 70, 160, 205, "pop", 8)]),
    "ano_nuevo_chino": ("ene–feb", [("cohetes", [(255, 60, 40), (255, 210, 60)])],
                        [("farol_chino", 46, 40, 58, "swing"), ("farol_chino", 46, 280, 58, "swing", 4)]),
    "candelaria": ("2 feb", [("chispas", ORO)],
                   [("tamal", 70, 108, 205, "pop"), ("chocolate", 58, 214, 203, "pop", 6)]),
    "san_valentin": ("14 feb", [("corazones", [(255, 50, 90), (255, 120, 170)])],
                     [("diadema_corazones", 120, 160, 30, "drop"), ("rosa", 46, 286, 190, "pop", 10)]),
    "bandera": ("24 feb", [("confeti", TRICOLOR)],
                [("bandera_mexico", 78, 160, 30, "swing")]),
    "carnaval": ("feb–mar", [("confeti", FIESTA)],
                 [("antifaz", 100, 160, 30, "drop"), ("serpentinas", 60, 40, 205, "pop", 8), ("serpentinas", 60, 280, 205, "pop", 12)]),
    "san_patricio": ("17 mar", [_caida("trebol", 9, 16)],
                     [("sombrero_san_patricio", 78, 92, 34, "drop")]),
    "primavera": ("21 mar", [("chispas", [(255, 230, 120), (180, 255, 180)])],
                  [("sol", 54, 288, 30, "spin"), ("mariposa", 40, 70, 30, "fly"), ("mariposa", 30, 220, 205, "fly", 6)]),
    "pascua": ("mar–abr", [("confeti", [(255, 190, 220), (190, 230, 255), (255, 240, 160), (200, 255, 200)])],
               [("orejas_conejo", 104, 160, 30, "drop"), ("huevo_pascua", 40, 160, 205, "bob")]),
    "dia_tierra": ("22 abr", [("chispas", [(120, 200, 255), (255, 255, 255)])],
                   [("tierra", 58, 160, 205, "spin")]),
    "dia_nino": ("30 abr", [("confeti", FIESTA)],
                 [("globos", 60, 40, 0, "rise"), ("globos", 54, 284, 0, "rise", 12), ("gorro_fiesta", 50, 230, 38, "drop")]),
    "dia_madres": ("10 may", [("corazones", [(255, 80, 140), (255, 160, 200)])],
                   [("claveles", 66, 160, 202, "pop")]),
    "dia_maestro": ("15 may", [("chispas", ORO)],
                    [("birrete", 90, 160, 34, "drop"), ("manzana", 44, 286, 200, "bob", 8)]),
    "dia_padre": ("3er dom jun", [("chispas", [(120, 180, 255), (255, 255, 255)])],
                  [("corbata_mono", 74, 160, 208, "pop"), ("estrella", 34, 30, 34, "pulse", 6)]),
    "verano": ("21 jun", [("chispas", ORO)],
               [("sol", 66, 160, 26, "spin"), ("lentes_corazon", 82, 160, 208, "pop", 8)]),
    "independencia": ("15–16 sep", [("cohetes", TRICOLOR), ("confeti", TRICOLOR)],
                      [("sombrero_charro", 118, 160, 30, "drop"), ("bandera_mexico", 48, 290, 196, "swing", 8)]),
    "halloween": ("31 oct", [_caida("murcielago", 4, 30)],
                  [("telarana", 70, 30, 30, ""), ("sombrero_bruja", 84, 236, 30, "drop"), ("calabaza", 50, 160, 206, "pulse", 8)]),
    "posadas": ("16–24 dic", [("chispas", ORO)],
                [("pinata", 70, 160, 30, "swing"), ("vela", 26, 30, 200, "bob"), ("vela", 26, 290, 200, "bob", 5)]),
    # sin diademas (dueño, 2026-11-02: "las diademas no le quedan bien"): dos propuestas de cada una
    "san_valentin_a": ("14 feb", [("corazones", [(255, 50, 90), (255, 120, 170)])],
                       [("rosa", 46, 286, 190, "pop", 10)], {"ojos": "corazon"}),
    "san_valentin_b": ("14 feb", [("corazones", [(255, 50, 90), (255, 120, 170)])],
                       [("corazon", 56, 160, 30, "pulse"), ("rosa", 44, 30, 195, "pop", 6), ("rosa", 44, 290, 195, "pop", 10)]),
    "pascua_a": ("mar–abr", [("confeti", [(255, 190, 220), (190, 230, 255), (255, 240, 160), (200, 255, 200)])],
                 [("orejas_conejo@0,0.5,0,0.66", 34, 80, 40, "asoma_detras"), ("orejas_conejo@0.5,1,0,0.66", 34, 240, 40, "asoma_detras", 3),
                  ("huevo_pascua", 40, 160, 210, "bounce", 8)]),
    "pascua_b": ("mar–abr", [("confeti", [(255, 190, 220), (190, 230, 255), (255, 240, 160), (200, 255, 200)])],
                 [("huevo_pascua", 38, 90, 212, "bounce"), ("huevo_pascua", 44, 160, 214, "bounce", 5), ("huevo_pascua", 38, 230, 212, "bounce", 10),
                  ("mariposa", 34, 50, 30, "fly"), ("mariposa", 28, 270, 30, "fly", 7)]),
    "carnaval_a": ("feb–mar", [("confeti", FIESTA), ("cohetes", FIESTA), _caida("serpentinas", 4, 26)],
                   [("antifaz", 62, 270, 34, "fly")]),
    "carnaval_b": ("feb–mar", [("confeti", FIESTA), ("cohetes", FIESTA), _caida("serpentinas", 6, 30)],
                   [("fuegos", 40, 36, 30, "pulse"), ("fuegos", 40, 284, 30, "pulse", 7)]),
    "cumpleanos": ("su cumpleaños", [("confeti", FIESTA)],
                   [("gorro_fiesta", 54, 86, 38, "drop"), ("pastel", 64, 160, 204, "pop", 8), ("globos", 52, 290, 0, "rise", 4)]),
}


def _heart_eyes(base, t, dy):
    """Los dos ojos en forma de corazón, con el mismo cian y el borde más oscuro que los de siempre."""
    im = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(im)
    beat = 1 + 0.1 * max(0.0, math.sin(t * 2 * math.pi * 1.3)) ** 3
    for (x, y, ew, eh) in g.EYES:
        cx, cy = x + ew / 2, y + eh / 2 + dy - 6
        for r, c in ((40 * beat, tuple(int(v) for v in g.RIM)), (34 * beat, tuple(int(v) for v in g.CENTER))):
            _heart(d, cx, cy, r, c)
    return np.asarray(im).astype(np.float32)


def make(nombre, n=60):
    receta = RECETAS[nombre]
    _, particulas, props = receta[:3]
    opts = receta[3] if len(receta) > 3 else {}
    seed = sum(map(ord, nombre))
    frames = []
    for i in range(n):
        t = i / FPS
        blink = 1.0
        if 40 <= i <= 44:
            blink = [0.6, 0.15, 0.05, 0.3, 0.75][i - 40]
        bg = Image.new("RGB", (W * SS, H * SS))
        d = ImageDraw.Draw(bg)
        for part in particulas:   # primero las dibujadas, luego los stickers que caen
            if not callable(part):
                DRAWN[part[0]](d, t, seed, part[1])
        base = np.asarray(bg).astype(np.float32)
        for part in particulas:
            if callable(part):
                base = part(base, t, seed)
        for p in props:   # los que van detrás de los ojos (las orejas)
            if len(p) > 4 and p[4].endswith("_detras"):
                base = _prop(base, p, i)
        dy = 2 * math.sin(t * 2 * math.pi * 0.5)
        dx = 0.0
        if "mirar" in opts:   # los ojos voltean hacia algo (el globo de pensamiento)
            k = float(g._smooth(np.float32(min(1.0, i / 8))))
            dx, dy = dx + opts["mirar"][0] * k, dy + opts["mirar"][1] * k
        if opts.get("ojos") == "corazon" and 18 <= i <= 37:   # los ojos se vuelven corazones y laten
            img = _heart_eyes(base, t, dy)
        else:
            if opts.get("ojos") == "corazon" and (15 <= i <= 17 or 38 <= i <= 40):
                blink = {15: 0.5, 16: 0.15, 17: 0.05, 38: 0.05, 39: 0.15, 40: 0.5}[i]
            img = g.eyes_layer(blink * opts.get("abiertos", 1.0), dx=dx, dy=dy, under=base)
        for p in props:
            if not (len(p) > 4 and p[4].endswith("_detras")):
                img = _prop(img, p, i)
        frames.append(Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).resize((W, H), Image.LANCZOS))
    return frames


# las elegidas por el dueño (2026-11-02: "Valentín b, Pascua b, carnaval a"): las de diadema quedan fuera
RECETAS["san_valentin"] = RECETAS.pop("san_valentin_b")
RECETAS["pascua"] = RECETAS.pop("pascua_b")
RECETAS["carnaval"] = RECETAS.pop("carnaval_a")
for _k in ("san_valentin_a", "pascua_a", "carnaval_b"):
    RECETAS.pop(_k)

FIESTAS = {k: (lambda k=k: make(k)) for k in RECETAS}


# ---- hambre (dueño, 2026-11-02: "un globo de pensamiento con una hamburguesa que me indique que tiene hambre") ----
# Una por comida de su menú (care.py FOODS): el globo con lo que se le antoja; los ojos lo miran, un poco caídos.
COMIDAS = ["hamburguesa", "pizza", "tacos", "sushi", "sopa", "galleta", "helado", "pastel", "manzana", "platano",
           "zanahoria", "brocoli", "leche", "jugo", "te"]


def hambre(comida, n=60):
    receta = ("con hambre", [],
              [("globo_pensamiento", 96, 266, 34, "pop"), (comida, 44, 270, 30, "bob", 6)],
              {"mirar": (-6, 14), "abiertos": 0.8})   # los ojos bajan un poco: el globo arriba a la derecha
    RECETAS["_hambre"] = receta
    try:
        return make("_hambre", n)
    finally:
        RECETAS.pop("_hambre")


HAMBRE = {f"hambre_{c}": (lambda c=c: hambre(c)) for c in COMIDAS}


# ---- sin Alma en el robot (dueño, 2026-11-02): "una pantalla estilo emo… algo como el robot caminando al reloj" ----
# Líneas cian como los ojos: un EMO chiquito camina hacia el reloj, se mete en él y en la pantalla del reloj le salen
# los ojitos. Sin los ojos grandes. Va en /test/ausente_reloj.avi (la pone el robot sin Alma, ya en la base).
def _robotito(d, x, y, s, paso, c):
    """EMO chiquito de perfil-frente: cabeza con dos ojitos, cuerpo y dos patas que alternan (a 4×)."""
    S = SS
    w, h = 34 * s, 26 * s
    d.rounded_rectangle([(x - w / 2) * S, (y - h) * S, (x + w / 2) * S, y * S], radius=8 * s * S, outline=c, width=int(3 * S))
    for ex in (-8, 8):
        d.rounded_rectangle([(x + ex * s - 4 * s) * S, (y - h / 2 - 5 * s) * S, (x + ex * s + 4 * s) * S, (y - h / 2 + 5 * s) * S],
                            radius=2 * s * S, fill=c)
    d.rounded_rectangle([(x - 12 * s) * S, y * S, (x + 12 * s) * S, (y + 14 * s) * S], radius=4 * s * S, outline=c, width=int(3 * S))
    for k, lx in enumerate((-6, 6)):
        lift = (6 * s) * max(0.0, math.sin(paso + k * math.pi))
        d.line([((x + lx * s) * S, (y + 14 * s) * S), ((x + lx * s) * S, (y + 26 * s - lift) * S)], fill=c, width=int(4 * S))
        d.line([((x + lx * s - 3 * s) * S, (y + 26 * s - lift) * S), ((x + lx * s + 5 * s) * S, (y + 26 * s - lift) * S)],
               fill=c, width=int(4 * S))


def _reloj(d, cx, cy, r, c, ojos, abiertos):
    S = SS
    d.rounded_rectangle([(cx - r * 0.55) * S, (cy - r * 1.75) * S, (cx + r * 0.55) * S, (cy - r * 0.8) * S], radius=6 * S,
                        outline=c, width=int(3 * S))   # correa de arriba
    d.rounded_rectangle([(cx - r * 0.55) * S, (cy + r * 0.8) * S, (cx + r * 0.55) * S, (cy + r * 1.75) * S], radius=6 * S,
                        outline=c, width=int(3 * S))   # correa de abajo
    d.ellipse([(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S], fill=(0, 0, 0), outline=c, width=int(4 * S))
    d.ellipse([(cx - r + 7) * S, (cy - r + 7) * S, (cx + r - 7) * S, (cy + r - 7) * S], outline=(20, 90, 100), width=int(2 * S))
    if ojos > 0:   # los ojitos de Alma en la pantalla del reloj
        for ex in (-13, 13):
            hh = 16 * ojos * abiertos
            d.rounded_rectangle([(cx + ex - 8) * S, (cy - max(hh, 2)) * S, (cx + ex + 8) * S, (cy + max(hh, 2)) * S],
                                radius=5 * S, fill=tuple(int(v) for v in g.CENTER))


def ausente_reloj(n=60):
    """Dueño (2026-11-02): "mejor sólo pon el reloj con los ojos parpadeando en el centro". El reloj apagado de GPT y,
    encima, los ojitos cian sacados de su versión con ojos, que parpadean aplastándose."""
    w = 150
    reloj = _sticker("reloj_apagado", w)
    con = _sticker("reloj_ojos", w)
    rgb, a = con
    cian = (rgb[..., 2] > 150) & (rgb[..., 1] > 150) & (rgb[..., 0] < 140)   # solo los ojitos
    ys, xs = np.where(cian)
    y0, y1, x0, x1 = ys.min() - 6, ys.max() + 7, xs.min() - 6, xs.max() + 7
    ojos_rgb = rgb[y0:y1, x0:x1].copy()
    ojos_a = np.clip((ojos_rgb[..., 2] - 60) / 120, 0, 1) * a[y0:y1, x0:x1]
    hh, ww = reloj[1].shape
    ox, oy = 160 - ww / SS / 2, 120 - hh / SS / 2   # el reloj al centro
    frames = []
    for i in range(n):
        img = g._paste(np.zeros((H * SS, W * SS, 3), np.float32), reloj, ox, oy)
        blink = 1.0
        for b0 in (24, 50):   # dos parpadeos, el segundo doble
            if b0 <= i <= b0 + 4:
                blink = [0.6, 0.15, 0.05, 0.3, 0.75][i - b0]
        if 54 <= i <= 58:
            blink = [0.6, 0.15, 0.05, 0.3, 0.75][i - 54]
        eh = max(1, int(round(ojos_a.shape[0] * blink)))
        er = np.asarray(Image.fromarray(ojos_rgb.astype(np.uint8)).resize((ojos_a.shape[1], eh), Image.LANCZOS)).astype(np.float32)
        ea = np.asarray(Image.fromarray((ojos_a * 255).astype(np.uint8)).resize((ojos_a.shape[1], eh), Image.LANCZOS)).astype(np.float32) / 255
        cy = oy + (y0 + y1) / 2 / SS
        img = g._paste(img, (er, ea), ox + x0 / SS, cy - eh / SS / 2)
        frames.append(Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).resize((W, H), Image.LANCZOS))
    return frames


# ---- Truco de Darth Vader (dueño, 2026-11-03: imprimió el casco en 3D): los ojos de siempre, suben y se entrecierran, y
# aparece la rejilla triangular de la boca (GPT en Pixelcut, assets/vader_boca_1.png), que "respira" con un brillo. Dura lo
# que la marcha imperial (/test/vader_marcha.mp3, 18.7 s); el robot camina al frente mientras tanto (app.c, truco "vader").
VADER_S = 18.7


def vader(n=int(VADER_S * FPS)):
    boca = g._sprite("vader_boca_1.png", 112)
    bh = boca[1].shape[0] / SS
    bx, by = 160 - 56, 236 - bh                      # abajo al centro
    cache = {}
    frames = []
    for i in range(n):
        u = g._smooth((i - 12) / 22.0)                # 0 → 1 entre los cuadros 12 y 34: la boca aparece
        dy = -22 * u
        open_ = 1.0 - 0.3 * u
        for b0 in (120, 215):                         # dos parpadeos lentos
            if b0 <= i <= b0 + 4:
                open_ *= [0.6, 0.2, 0.08, 0.35, 0.75][i - b0]
        key = (round(open_, 2), round(dy, 1))
        if key not in cache:
            cache[key] = g.eyes_layer(open_, 0, dy)
        img = cache[key].copy()
        if u > 0:
            breath = 0.86 + 0.14 * (0.5 + 0.5 * math.sin(2 * math.pi * max(0, i - 34) / (2.2 * FPS)))   # respira
            rgb, a = boca
            img = g._paste(img, (rgb * breath, a * u), bx, by + 40 * (1 - u))
        frames.append(Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).resize((W, H), Image.LANCZOS))
    return frames


OTRAS = {"ausente_reloj": ausente_reloj, "vader": vader}
CALIDAD = {"vader": 5}   # 18.7 s: con q 5 queda en ~1.7 MB, lo que ya cabía en la PSRAM del robot (con q 2, 2.56 MB no)
