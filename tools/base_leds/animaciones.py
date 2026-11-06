"""animaciones — los dibujos de Alma para la matriz de la Home Station (12 x 8). Diseños propios (ojos originales de
Alma, nada copiado de la base de fábrica).

    python -I animaciones.py [salida]    → salida/<nombre>.gif, salida/<nombre>_hoja.png y salida/alma_base.alb
"""
import math
import os
import random
import sys

import numpy as np

import matriz as M

OJO = (40, 200, 255)       # el color de los ojos de Alma en la base
OJO_FELIZ = (255, 190, 40)
ROSA = (255, 40, 90)
VERDE = (40, 255, 80)
BLANCO = (255, 255, 255)
AZUL_NOCHE = (30, 40, 160)


def _ojo(f, cx, alto, color, mirar=0):
    """un ojo de 3 de ancho centrado en la columna cx; alto 1 (cerrado) a 6 (abierto), centrado en la fila 3.5"""
    y0 = int(round(4 - alto / 2))
    for y in range(y0, y0 + alto):
        for dx in (-1, 0, 1):
            esquina = alto >= 4 and (y == y0 or y == y0 + alto - 1) and dx != 0
            if not esquina:
                M.pixel(f, cx + dx + mirar, y, color)


def ojos(alto=6, mirar=0, color=OJO):
    f = M.nuevo()
    _ojo(f, 3, alto, color, mirar)
    _ojo(f, 8, alto, color, mirar)
    return f


def ojos_alma():
    """quieta, mira a los lados y parpadea (en bucle)"""
    a = [(ojos(), 1800)]
    a += [(ojos(alto=h), 50) for h in (4, 2, 1, 2, 4)]
    a += [(ojos(), 900), (ojos(mirar=-1), 700), (ojos(), 400), (ojos(mirar=1), 700), (ojos(), 1200)]
    a += [(ojos(alto=h), 50) for h in (4, 1, 4)] + [(ojos(alto=h), 50) for h in (4, 1, 4)]
    return a


def feliz():
    """ojos en arco (^ ^) que rebotan con destellos"""
    arco = ["............", "..##....##..", ".#..#..#..#.", "............"]
    a = []
    for k in range(8):
        dy = 1 if k % 2 else 2
        f = M.nuevo()
        for j, fila in enumerate(arco):
            for i, c in enumerate(fila):
                if c == '#':
                    M.pixel(f, i, j + dy, OJO_FELIZ)
        if k % 2 == 0:
            M.pixel(f, 0 if k % 4 == 0 else 11, 0, BLANCO)
            M.pixel(f, 11 if k % 4 == 0 else 0, 6, BLANCO)
        a.append((f, 160))
    return a


def triste():
    """ojos caídos y una lágrima que baja"""
    base = ["............", "............", ".###....###.", "..##....##..", "...#....#...",
            "............", "............", "............"]
    a = []
    for k in range(6):
        f = M.dibujo(base, {'#': (60, 90, 200)})
        if k < 5:
            M.pixel(f, 3, 5 + k // 2 if k < 5 else 7, (120, 180, 255))
        a.append((f, 260 if k < 5 else 900))
    return a


def dormir():
    """ojos cerrados y zetas que suben"""
    a = []
    for k in range(12):
        f = M.nuevo()
        M.rect(f, 2, 5, 3, 1, escala_ojo(0.6))
        M.rect(f, 7, 5, 3, 1, escala_ojo(0.6))
        y = 4 - (k % 6) // 1
        x = 8 + (k % 6) // 3   # zetas dentro del frente (columnas 1 a 10)
        if 0 <= y:
            for (i, j) in ((0, 0), (1, 0), (1, 1), (0, 2), (1, 2)):   # una z de 2x3
                M.pixel(f, x + i, y - 2 + j, M.escala(AZUL_NOCHE, 0.4 + 0.1 * (k % 6)))
        a.append((f, 380))
    return a


def escala_ojo(t):
    return M.escala(OJO, t)


def carga():
    """EMO cargándose: columnas verdes que suben y una onda que recorre (en bucle)"""
    a = []
    for k in range(12):
        f = M.nuevo()
        for x in range(M.W):
            nivel = 2 + int(round(2.5 + 2.5 * math.sin((x + k) * 2 * math.pi / 12)))
            for y in range(M.H - nivel, M.H):
                t = (M.H - y) / M.H
                M.pixel(f, x, y, M.mezcla((10, 120, 30), VERDE, t))
        a.append((f, 90))
    return a


def lleno():
    """la batería de EMO llena: un verde que respira"""
    return [(M.nuevo(M.escala(VERDE, 0.15 + 0.85 * (0.5 - 0.5 * math.cos(k * 2 * math.pi / 16)))), 90)
            for k in range(16)]


def corazon():
    """un corazón que late (cariño, caricias)"""
    chico = ["............", "............", "...##.##....", "...#####....", "....###.....",
             ".....#......", "............", "............"]
    grande = ["............", "..##...##...", ".####.####..", ".#########..", "..#######...",
              "...#####....", "....###.....", ".....#......"]
    chico = [" " + fila[:-1] for fila in chico]   # centrados
    grande = [" " + fila[:-1] for fila in grande]
    p = {'#': ROSA}
    return [(M.dibujo(chico, p), 420), (M.dibujo(grande, p), 140), (M.dibujo(chico, p), 140),
            (M.dibujo(grande, p), 160)]


def pensando():
    """tres puntos que se encienden (esperando respuesta del servidor)"""
    a = []
    for k in range(4):
        f = M.nuevo()
        for i in range(3):
            c = OJO if i < k else M.escala(OJO, 0.15)
            M.rect(f, 2 + 3 * i, 3, 2, 2, c)
        a.append((f, 300))
    return a


def arcoiris():
    """arcoíris que corre (festejo)"""
    a = []
    for k in range(16):
        f = M.nuevo()
        for y in range(M.H):
            for x in range(M.W):
                f[y, x] = M.hsv(((x + y * 0.5) / 12 + k / 16) % 1.0, 1.0, 1.0)
        a.append((f, 70))
    return a


def fuegos(semilla=7):
    """fuegos artificiales: sube una chispa y estalla (deterministas, para que la vista previa sea la de la base)"""
    rnd = random.Random(semilla)
    a = []
    for _ in range(3):
        x, top = rnd.randint(2, 9), rnd.randint(1, 3)
        color = M.hsv(rnd.random())
        for y in range(M.H - 1, top, -1):
            f = M.nuevo()
            M.pixel(f, x, y, (255, 200, 120))
            a.append((f, 60))
        for r in range(1, 5):
            f = M.nuevo()
            luz = 1.0 - (r - 1) / 4
            for ang in range(0, 360, 45):
                px = x + int(round(r * math.cos(math.radians(ang))))
                py = top + int(round(r * math.sin(math.radians(ang)) * 0.8))
                M.pixel(f, px, py, M.escala(color, luz))
            a.append((f, 90))
        a.append((M.nuevo(), 200))
    return a


def lluvia(semilla=3):
    """lluvia tranquila (aburrida o lloviendo afuera)"""
    rnd = random.Random(semilla)
    gotas = [(rnd.randint(0, 11), rnd.randint(-8, 7)) for _ in range(9)]
    a = []
    for k in range(16):
        f = M.nuevo()
        for (x, y0) in gotas:
            y = (y0 + k) % 16 - 8
            M.pixel(f, x, y, (60, 110, 255))
            M.pixel(f, x, y - 1, (20, 40, 110))
        a.append((f, 110))
    return a


def texto_corre(s, color, ms=110):
    """texto de 3x5 que corre de derecha a izquierda"""
    a = []
    for x in range(M.W, -M.ancho_texto(s) - 1, -1):
        f = M.nuevo()
        M.texto(f, s, x, 1, color)
        a.append((f, ms))
    return a


def llegaste():
    """cuando el dueño llega: un anillo que se abre y HOLA"""
    a = []
    for r in range(1, 9):
        f = M.nuevo()
        for y in range(M.H):
            for x in range(M.W):
                d = math.hypot(x - 5.5, (y - 3.5) * 1.3)
                if abs(d - r) < 0.7:
                    f[y, x] = OJO_FELIZ
        a.append((f, 70))
    return a + texto_corre("HOLA ♥", OJO_FELIZ, 100)


def punto(color):
    """punto en un juego: destello y franjas"""
    a = []
    for k in range(6):
        f = M.nuevo(color if k % 2 == 0 else (0, 0, 0))
        a.append((f, 90))
    for k in range(6):
        f = M.nuevo()
        for x in range(M.W):
            if (x + k) % 3 == 0:
                M.rect(f, x, 0, 1, M.H, color)
        a.append((f, 70))
    return a


def prueba():
    """patrón de prueba de alma-base: las 4 esquinas de colores (foto de calibración), filas rojo/verde/azul, la esquina 0 en blanco y un punto que recorre fila*12+col
    (para confirmar el orden de colores, dónde queda la fila 0 y si va fila por fila)"""
    esquinas = M.nuevo()   # para la foto de calibración: índice 0 blanco, 11 rojo, 84 verde, 95 azul
    for (x, y), c in (((0, 0), BLANCO), ((11, 0), (255, 0, 0)), ((0, 7), (0, 255, 0)), ((11, 7), (0, 0, 255))):
        M.pixel(esquinas, x, y, c)
    a = [(esquinas, 5000)]
    for k, c in enumerate(((255, 0, 0), (0, 255, 0), (0, 0, 255))):
        f = M.nuevo()
        M.rect(f, 0, k, M.W, 1, c)
        M.pixel(f, 0, 0, BLANCO)
        a.append((f, 700))
    for i in range(M.W * M.H):
        f = M.nuevo()
        M.pixel(f, i % M.W, i // M.W, BLANCO)
        a.append((f, 25))
    return a


def esquinas():
    """solo el cuadro de las esquinas, en bucle hasta "leds off" (para la foto de calibración con calma)"""
    return prueba()[:1]


def todo():
    """los 96 LEDs en blanco tenue, en bucle hasta "leds off": el tamaño real de la pantalla (dueño, 2026-11-06).
    Tenue: con el tope de la base son ~4.5 mA por LED, ~0.45 A en total"""
    return [(M.nuevo((60, 60, 60)), 5000)]


def lleno_de(color):
    """toda la pantalla de un color, tenue, en bucle: para medir el desgaste por canal (foto del dueño)"""
    return [(M.nuevo(color), 5000)]


# nombre (≤ 15 letras), animación, repetir
TODAS = [
    ("prueba", prueba(), False),
    ("esquinas", esquinas(), True),
    ("todo", todo(), True),
    ("rojo", lleno_de((60, 0, 0)), True),
    ("verde", lleno_de((0, 60, 0)), True),
    ("azul", lleno_de((0, 0, 60)), True),
    ("ojos", ojos_alma(), True),
    ("feliz", feliz(), True),
    ("triste", triste(), False),
    ("dormir", dormir(), True),
    ("carga", carga(), True),
    ("lleno", lleno(), True),
    ("corazon", corazon(), True),
    ("pensando", pensando(), True),
    ("arcoiris", arcoiris(), True),
    ("fuegos", fuegos(), False),
    ("lluvia", lluvia(), True),
    ("llegaste", llegaste(), False),
    ("punto_alma", punto(OJO), False),
    ("punto_base", punto(ROSA), False),
]

if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'salida')
    os.makedirs(out, exist_ok=True)
    for nombre, anim, _ in TODAS:
        M.gif(anim, os.path.join(out, nombre + '.gif'))
        M.hoja(anim, os.path.join(out, nombre + '_hoja.png'))
    n = M.paquete(TODAS, os.path.join(out, 'alma_base.alb'))
    vuelta = M.leer_paquete(os.path.join(out, 'alma_base.alb'))
    assert [v[0] for v in vuelta] == [t[0] for t in TODAS]
    assert all(np.array_equal(a[0], b[0]) and a[1] == b[1] for t, v in zip(TODAS, vuelta) for a, b in zip(t[1], v[1]))
    print(f"{len(TODAS)} animaciones, {sum(len(t[1]) for t in TODAS)} cuadros, alma_base.alb = {n} bytes (ida y vuelta ok)")
