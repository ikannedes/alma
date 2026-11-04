#!/usr/bin/env python3
"""Genera alma_test.avi: animación propia de prueba para la pantalla de EMO, con el formato de las de fábrica
(AVI MJPEG 320×240 a 15 fps, sin audio; HALLAZGOS §7). Dos ojos que parpadean y "ALMA" abajo, 1 s.

Uso: python make_test_avi.py <salida.avi>   (necesita Pillow y ffmpeg en el PATH)
"""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

W, H, FPS, N = 320, 240, 15, 15
CYAN, BG = (56, 225, 255), (4, 6, 10)


def frame(i):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    # parpadeo en los cuadros 6 a 8: los ojos se cierran y se abren
    open_ = {6: 0.45, 7: 0.08, 8: 0.45}.get(i, 1.0)
    eh = max(6, int(92 * open_))
    for cx in (100, 220):
        d.rounded_rectangle((cx - 34, 98 - eh // 2, cx + 34, 98 + eh // 2), radius=min(26, eh // 2), fill=CYAN)
    try:
        font = ImageFont.truetype("arialbd.ttf", 34)
    except OSError:
        font = ImageFont.load_default()
    t = "ALMA"
    tw = d.textlength(t, font=font)
    d.text(((W - tw) / 2, 178), t, fill=CYAN, font=font)
    return im


def main(out):
    ff = shutil.which("ffmpeg")
    if not ff:
        sys.exit("falta ffmpeg en el PATH")
    with tempfile.TemporaryDirectory() as tmp:
        for i in range(N):
            frame(i).save(os.path.join(tmp, f"f{i:02d}.png"))
        subprocess.run([ff, "-y", "-loglevel", "error", "-framerate", str(FPS), "-i", os.path.join(tmp, "f%02d.png"),
                        "-c:v", "mjpeg", "-q:v", "5", "-pix_fmt", "yuvj420p", "-an", out], check=True)
    print(f"{out}: {os.path.getsize(out)} bytes, {N} cuadros, {W}x{H} a {FPS} fps")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "alma_test.avi")
