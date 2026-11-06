"""matriz — simulador de la matriz de LEDs de la Home Station (dueño, 2026-11-06: "podrías hacer un simulador para ti
para que hagas muchos dibujos y se los pases, incluso con animaciones").

La matriz es de 12 columnas x 8 filas de LEDs RGB (WS2812 en GPIO5, índice fila*12 + col, fila 0 arriba, sin zigzag,
bytes R,G,B: confirmado con la foto de las esquinas del dueño, 2026-11-06). Los puntos son más altos que anchos (~1.25). Las columnas 0 y 11 quedan en los costados curvos del cristal (dueño): de
frente se ven 10 x 8 (columnas 1 a 10); los costados son para brillos y marcos, no para lo que hay que leer. Un cuadro es un arreglo (8, 12, 3) de uint8; una animación, una lista de (cuadro, ms).

Vista previa: GIF animado y hoja de cuadros (PNG) con LEDs redondos, con el mismo tope de brillo que aplicará la base.
Paquete para el firmware (alma-base, archivo .alb):
    "ALB1" | u16 n_anim | n_anim x { char nombre[16], u16 n_cuadros, u8 repetir, u8 0, u32 offset }
    cuadros: u16 ms | 288 bytes R,G,B por LED en orden fila*12 + col  (little endian)
"""
import struct

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H = 12, 8
ASPECTO = 1.25     # alto / ancho de cada punto en la base (foto del dueño)
COSTADOS = (0, W - 1)   # columnas en el borde curvo: en la vista previa, angostas y más tenues
FRENTE = range(1, W - 1)
TOPE = 80          # brillo máximo por canal en la base (0-255): 96 LEDs en blanco a 255 piden ~5 A
FRAME_BYTES = W * H * 3


def nuevo(color=(0, 0, 0)):
    f = np.zeros((H, W, 3), np.uint8)
    f[:, :] = color
    return f


def pixel(f, x, y, color):
    if 0 <= x < W and 0 <= y < H:
        f[y, x] = color


def rect(f, x, y, w, h, color):
    for j in range(y, y + h):
        for i in range(x, x + w):
            pixel(f, i, j, color)


def mezcla(a, b, t):
    """color entre a y b (t de 0 a 1)"""
    return tuple(int(round(a[k] + (b[k] - a[k]) * t)) for k in range(3))


def escala(color, t):
    return tuple(int(round(c * t)) for c in color)


def hsv(h, s=1.0, v=1.0):
    i = int(h * 6) % 6
    fr = h * 6 - int(h * 6)
    p, q, t = v * (1 - s), v * (1 - fr * s), v * (1 - (1 - fr) * s)
    r, g, b = [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i]
    return (int(r * 255), int(g * 255), int(b * 255))


def dibujo(filas, paleta):
    """cuadro desde texto: filas de 12 caracteres; cada carácter es una clave de la paleta ('.' = apagado)"""
    f = nuevo()
    for y, fila in enumerate(filas[:H]):
        for x, c in enumerate(fila[:W]):
            if c not in '. ':
                f[y, x] = paleta[c]
    return f


# fuente de 3x5 (dígitos, letras y algunos signos) para relojes, marcadores y textos que corren
FUENTE = {
    '0': "111101101101111", '1': "010110010010111", '2': "111001111100111", '3': "111001111001111",
    '4': "101101111001001", '5': "111100111001111", '6': "111100111101111", '7': "111001010010010",
    '8': "111101111101111", '9': "111101111001111", ':': "000010000010000", ' ': "000000000000000",
    'A': "010101111101101", 'B': "110101110101110", 'C': "011100100100011", 'D': "110101101101110",
    'E': "111100110100111", 'F': "111100110100100", 'G': "011100101101011", 'H': "101101111101101",
    'I': "111010010010111", 'J': "001001001101010", 'K': "101101110101101", 'L': "100100100100111",
    'M': "101111111101101", 'N': "110101101101101", 'O': "010101101101010", 'P': "110101110100100",
    'Q': "010101101111011", 'R': "110101110101101", 'S': "011100010001110", 'T': "111010010010010",
    'U': "101101101101111", 'V': "101101101101010", 'W': "101101111111101", 'X': "101101010101101",
    'Y': "101101010010010", 'Z': "111001010100111", '!': "010010010000010", '?': "110001010000010",
    '-': "000000111000000", '+': "000010111010000", '<': "001010100010001", '>': "100010001010100",
    '.': "000000000000010", '♥': "000101111111010",
}


def letra(f, c, x, y, color):
    patron = FUENTE.get(c.upper(), FUENTE['?'])
    for j in range(5):
        for i in range(3):
            if patron[j * 3 + i] == '1':
                pixel(f, x + i, y + j, color)


def texto(f, s, x, y, color):
    for k, c in enumerate(s):
        letra(f, c, x + 4 * k, y, color)


def ancho_texto(s):
    return 4 * len(s) - 1


# ---- vista previa ----

def _con_tope(f):
    return (f.astype(np.uint16) * TOPE // 255).astype(np.uint8)


def _render(f, led=18, sep=6):
    """imagen de un cuadro como se vería: LEDs redondos con su brillo real (tope incluido) y un poco de halo"""
    paso = led + sep
    paso_y = int(round(paso * ASPECTO))
    img = Image.new('RGB', (W * paso + sep, H * paso_y + sep), (14, 14, 18))
    d = ImageDraw.Draw(img)
    real = _con_tope(f).astype(np.float32)
    vis = np.clip(real * (255.0 / TOPE), 0, 255).astype(np.uint8)   # se ve como la base a su tope, no oscuro
    for y in range(H):
        for x in range(W):
            c = tuple(int(v) for v in vis[y, x])
            x0, y0 = sep + x * paso, sep + y * paso_y
            alto, ancho = paso_y - sep, led
            if x in COSTADOS:   # el costado se ve de lado: angosto y más tenue
                ancho = led // 2
                x0 += led // 2 if x == 0 else 0
                c = tuple(int(v * 0.6) for v in c)
            if sum(c) < 6:
                d.ellipse([x0, y0, x0 + ancho, y0 + alto], outline=(40, 40, 46), width=1)
            else:
                d.ellipse([x0, y0, x0 + ancho, y0 + alto], fill=c)
    glow = img.filter(ImageFilter.GaussianBlur(4))
    return Image.blend(img, Image.composite(img, glow, img.convert('L').point(lambda v: 255 if v > 30 else 0)), 0.35)


def gif(anim, ruta):
    imgs = [_render(f) for f, _ in anim]
    imgs[0].save(ruta, save_all=True, append_images=imgs[1:], duration=[max(20, ms) for _, ms in anim], loop=0)


def hoja(anim, ruta, por_fila=8, max_cuadros=48):
    cuadros = anim[:max_cuadros]
    imgs = [_render(f, led=10, sep=4) for f, _ in cuadros]
    w, h = imgs[0].size
    filas = (len(imgs) + por_fila - 1) // por_fila
    out = Image.new('RGB', (por_fila * (w + 6), filas * (h + 6)), (40, 40, 40))
    for k, im in enumerate(imgs):
        out.paste(im, ((k % por_fila) * (w + 6), (k // por_fila) * (h + 6)))
    out.save(ruta)


# ---- paquete para el firmware ----

def paquete(anims, ruta):
    """anims: lista de (nombre, animación, repetir). Escribe el .alb y devuelve su tamaño"""
    cab = b'ALB1' + struct.pack('<H', len(anims))
    tabla_len = len(anims) * 24
    datos, tabla = b'', b''
    off = len(cab) + tabla_len
    for nombre, anim, repetir in anims:
        n = nombre.encode('ascii')
        assert len(n) < 16, nombre
        tabla += struct.pack('<16sHBBI', n, len(anim), 1 if repetir else 0, 0, off + len(datos))
        for f, ms in anim:
            assert f.shape == (H, W, 3) and 0 < ms < 65536
            datos += struct.pack('<H', ms) + f.astype(np.uint8).tobytes()   # (fila, col, RGB) = fila*12 + col
    blob = cab + tabla + datos
    open(ruta, 'wb').write(blob)
    return len(blob)


def leer_paquete(ruta):
    """lo inverso de paquete (para las pruebas): lista de (nombre, [(cuadro, ms)], repetir)"""
    b = open(ruta, 'rb').read()
    assert b[:4] == b'ALB1'
    n = struct.unpack_from('<H', b, 4)[0]
    out = []
    for k in range(n):
        nombre, nc, rep, _, off = struct.unpack_from('<16sHBBI', b, 6 + 24 * k)
        anim = []
        for j in range(nc):
            p = off + j * (2 + FRAME_BYTES)
            ms = struct.unpack_from('<H', b, p)[0]
            f = np.frombuffer(b, np.uint8, FRAME_BYTES, p + 2).reshape(H, W, 3).copy()
            anim.append((f, ms))
        out.append((nombre.rstrip(b'\0').decode(), anim, bool(rep)))
    return out
