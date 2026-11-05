"""Entrena la red de Alma con los ejemplos de sim/brain_gen (dueño, 2026-11-04).

Aprendizaje por imitación: la red aprende la distribución de la maestra (entropía cruzada contra probabilidades, no contra
una sola respuesta), con la máscara de reglas del cuerpo y el peso de cada ejemplo (los segundos tranquilos guardados 1 de
cada 20 pesan 20). Solo numpy.

Uso: python tools/brain/train.py <ejemplos.bin> <salida.almb> [--h1 64] [--h2 32] [--epocas 20] [--semilla 1]

Formato de ejemplos.bin (sim/brain_gen.c, rec_policy): por registro x float32[IN], p float32[OUT], máscara uint64,
peso float32, escenario uint16, minuto del día uint16.
Formato de salida (core/alma_brain.c, alma_mlp_load): cabecera uint32[8] ("ALMB", 1, versión de entradas, IN, H1, H2,
OUT, versión del modelo AAAAMMDD), OUT nombres de 32 bytes, float32 mu, sd, w1, b1, w2, b2, w3, b3 y CRC32 al final.
"""

import argparse
import datetime
import json
import re
import struct
import zlib
from pathlib import Path

import numpy as np

ALMA = Path(__file__).resolve().parents[2]


def core_consts():
    h = (ALMA / "core" / "alma_core.h").read_text(encoding="utf-8")
    n_in = int(re.search(r"#define ALMA_BRAIN_IN\s+(\d+)", h).group(1))
    n_out = int(re.search(r"#define ALMA_BRAIN_OUT\s+(\d+)", h).group(1))
    fv = int(re.search(r"#define ALMA_BRAIN_FEAT_VERSION\s+(\d+)", h).group(1))
    c = (ALMA / "core" / "alma_brain.c").read_text(encoding="utf-8")
    body = re.search(r"ALMA_BRAIN_OUT_ID\[ALMA_BRAIN_OUT\] = \{(.*?)\};", c, re.S).group(1)
    ids = re.findall(r'"([^"]+)"', body)
    assert len(ids) == n_out, (len(ids), n_out)
    return n_in, n_out, fv, ids


def load(path, n_in, n_out, quiet_keep=1.0, seed=1):
    dt = np.dtype([("x", "<f4", (n_in,)), ("p", "<f4", (n_out,)), ("m", "<u8"), ("w", "<f4"), ("meta", "<u2", (2,))])
    d = np.memmap(path, dtype=dt, mode="r")
    if quiet_keep < 1.0:
        # más submuestreo de los segundos tranquilos, con su peso inverso: el total de cada situación no cambia
        rng = np.random.default_rng(seed)
        w0 = np.asarray(d["w"])
        keep = (w0 <= 1.0) | (rng.random(len(d)) < quiet_keep)
        d = np.array(d[keep])
        d["w"] = np.where(d["w"] > 1.0, d["w"] / quiet_keep, d["w"])
    else:
        d = np.array(d)
    mask = ((d["m"][:, None] >> np.arange(n_out, dtype=np.uint64)) & np.uint64(1)).astype(bool)
    p = d["p"] * mask
    p /= p.sum(1, keepdims=True)
    return d["x"].astype(np.float32), p.astype(np.float32), mask, d["w"].astype(np.float32), d["meta"]


def forward(params, xz, mask):
    w1, b1, w2, b2, w3, b3 = params
    z1 = xz @ w1.T + b1
    a1 = np.maximum(z1, 0)
    z2 = a1 @ w2.T + b2
    a2 = np.maximum(z2, 0)
    z3 = a2 @ w3.T + b3
    z3 = np.where(mask, z3, -1e9)
    z3 -= z3.max(1, keepdims=True)
    q = np.exp(z3) * mask
    q /= q.sum(1, keepdims=True)
    return q, (z1, a1, z2, a2)


def loss_of(q, p, w):
    ce = -(p * np.log(np.clip(q, 1e-12, 1))).sum(1)
    ent = -(p * np.log(np.clip(p, 1e-12, 1))).sum(1)
    return float((w * ce).sum() / w.sum()), float((w * (ce - ent)).sum() / w.sum())


def train(x, p, mask, wt, xv, pv, mv, wv, h1, h2, epochs, seed, lr=2e-3, batch=2048):
    rng = np.random.default_rng(seed)
    n_in, n_out = x.shape[1], p.shape[1]

    def init(o, i):
        return (rng.standard_normal((o, i)) * np.sqrt(2.0 / i)).astype(np.float32)

    params = [init(h1, n_in), np.zeros(h1, np.float32), init(h2, h1), np.zeros(h2, np.float32),
              init(n_out, h2) * 0.1, np.zeros(n_out, np.float32)]
    # sesgo inicial: la frecuencia media de cada salida (casi siempre "seguir")
    prior = (p * wt[:, None]).sum(0) / wt.sum()
    params[5] = np.log(np.clip(prior, 1e-6, 1)).astype(np.float32)
    m = [np.zeros_like(a) for a in params]
    v = [np.zeros_like(a) for a in params]
    b1m, b2m, eps, step = 0.9, 0.999, 1e-8, 0
    best = (1e9, None)
    wn = wt / wt.mean()
    for ep in range(epochs):
        idx = rng.permutation(len(x))
        for s in range(0, len(x), batch):
            j = idx[s:s + batch]
            xb, pb, mb, wb = x[j], p[j], mask[j], wn[j]
            q, (z1, a1, z2, a2) = forward(params, xb, mb)
            g3 = (q - pb) * wb[:, None] / len(j)
            gw3 = g3.T @ a2
            gb3 = g3.sum(0)
            ga2 = g3 @ params[4]
            gz2 = ga2 * (z2 > 0)
            gw2 = gz2.T @ a1
            gb2 = gz2.sum(0)
            ga1 = gz2 @ params[2]
            gz1 = ga1 * (z1 > 0)
            gw1 = gz1.T @ xb
            gb1 = gz1.sum(0)
            grads = [gw1, gb1, gw2, gb2, gw3, gb3]
            step += 1
            for k, g in enumerate(grads):
                if k in (0, 2, 4):
                    g = g + 1e-5 * params[k]   # un poco de regularización
                m[k] = b1m * m[k] + (1 - b1m) * g
                v[k] = b2m * v[k] + (1 - b2m) * g * g
                mh = m[k] / (1 - b1m ** step)
                vh = v[k] / (1 - b2m ** step)
                params[k] -= (lr * mh / (np.sqrt(vh) + eps)).astype(np.float32)
        qv, _ = forward(params, xv, mv)
        lv, klv = loss_of(qv, pv, wv)
        print(f"época {ep + 1:2d}: pérdida val {lv:.4f}, KL con la maestra {klv:.4f}", flush=True)
        if klv < best[0]:
            best = (klv, [a.copy() for a in params])
        lr *= 0.85
    return best[1]


def export(path, params, mu, sd, ids, fv, n_in, n_out):
    w1, b1, w2, b2, w3, b3 = params
    ver = int(datetime.date.today().strftime("%Y%m%d"))
    head = struct.pack("<8I", 0x424D4C41, 1, fv, n_in, w1.shape[0], w2.shape[0], n_out, ver)
    names = b"".join(i.encode().ljust(32, b"\0")[:32] for i in ids)
    floats = np.concatenate([a.astype("<f4").ravel() for a in (mu, sd, w1, b1, w2, b2, w3, b3)]).tobytes()
    blob = head + names + floats
    blob += struct.pack("<I", zlib.crc32(blob) & 0xFFFFFFFF)
    Path(path).write_bytes(blob)
    return len(blob), ver


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ejemplos")
    ap.add_argument("salida")
    ap.add_argument("--h1", type=int, default=64)
    ap.add_argument("--h2", type=int, default=32)
    ap.add_argument("--epocas", type=int, default=20)
    ap.add_argument("--semilla", type=int, default=1)
    ap.add_argument("--tranquilos", type=float, default=1.0, help="fracción de los segundos tranquilos que se usa")
    a = ap.parse_args()
    n_in, n_out, fv, ids = core_consts()
    x, p, mask, w, meta = load(a.ejemplos, n_in, n_out, a.tranquilos, a.semilla)
    n = len(x)
    # las corridas van una tras otra en el archivo: cortes contiguos = corridas distintas en cada parte
    i1, i2 = int(n * 0.8), int(n * 0.9)
    mu = x[:i1].mean(0)
    sd = np.maximum(x[:i1].std(0), 1e-3)
    z = (x - mu) / sd
    print(f"{n} ejemplos ({w.sum():.0f} con peso); entrenamiento {i1}, validación {i2 - i1}, prueba {n - i2}")
    params = train(z[:i1], p[:i1], mask[:i1], w[:i1], z[i1:i2], p[i1:i2], mask[i1:i2], w[i1:i2], a.h1, a.h2, a.epocas, a.semilla)
    qt, _ = forward(params, z[i2:], mask[i2:])
    lt, klt = loss_of(qt, p[i2:], w[i2:])
    pt, wt_ = p[i2:], w[i2:]
    top_agree = float((wt_ * (qt.argmax(1) == pt.argmax(1))).sum() / wt_.sum())
    seg_t = float((wt_ * pt[:, 0]).sum() / wt_.sum())
    seg_q = float((wt_ * qt[:, 0]).sum() / wt_.sum())
    # "cambiar" en momentos con evento: lo que más importa que imite bien
    ev = pt[:, 0] < 0.5
    top_ev = float((qt[ev].argmax(1) == pt[ev].argmax(1)).mean()) if ev.any() else 0.0
    tv_ev = float(0.5 * np.abs(qt[ev] - pt[ev]).sum(1).mean()) if ev.any() else 0.0
    size, ver = export(a.salida, params, mu, sd, ids, fv, n_in, n_out)
    rep = {"ejemplos": n, "h1": a.h1, "h2": a.h2, "prueba_perdida": lt, "prueba_KL": klt, "acuerdo_top1": top_agree,
           "p_seguir_maestra": seg_t, "p_seguir_red": seg_q, "momentos_de_cambio": int(ev.sum()),
           "acuerdo_top1_en_cambios": top_ev, "distancia_total_en_cambios": tv_ev, "bytes": size, "version": ver}
    Path(a.salida + ".json").write_text(json.dumps(rep, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(rep, ensure_ascii=False))


if __name__ == "__main__":
    main()
