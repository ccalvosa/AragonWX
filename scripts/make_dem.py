"""Genera assets/dem.png: modelo digital del terreno de Aragón en rejilla lat/lon.

Fuente: AWS Terrain Tiles (formato terrarium; en Europa, EU-DEM de Copernicus y SRTM),
zoom 10 (~115 m en Aragón), remuestreado bilineal a una rejilla de STEP grados.
Codificación: altitud en metros + 500, como entero de 16 bits en R (alto) y G (bajo).
La caja y el paso se guardan en assets/dem.json. Se ejecuta una sola vez:

    python scripts/make_dem.py
"""
import io
import json
import math
from pathlib import Path

import numpy as np
import requests
from PIL import Image

S, W, N, E = 39.80, -2.25, 43.00, 0.85
STEP = 0.0025
Z = 10
URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
OUT = Path(__file__).resolve().parents[1] / "assets"


def gx(lon):
    return (lon + 180) / 360 * 2 ** Z * 256


def gy(lat):
    r = math.radians(lat)
    return (1 - math.log(math.tan(r) + 1 / math.cos(r)) / math.pi) / 2 * 2 ** Z * 256


def main():
    x0, x1 = int(gx(W) // 256), int(gx(E) // 256)
    y0, y1 = int(gy(N) // 256), int(gy(S) // 256)
    mos = np.zeros(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256), np.float32)
    ses = requests.Session()
    for ty in range(y0, y1 + 1):
        for tx in range(x0, x1 + 1):
            r = ses.get(URL.format(z=Z, x=tx, y=ty), timeout=60)
            r.raise_for_status()
            a = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"), np.float32)
            h = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
            mos[(ty - y0) * 256:(ty - y0 + 1) * 256, (tx - x0) * 256:(tx - x0 + 1) * 256] = h
    print(f"mosaico {mos.shape}, {(y1 - y0 + 1) * (x1 - x0 + 1)} teselas")

    cols = round((E - W) / STEP)
    rows = round((N - S) / STEP)
    lons = W + (np.arange(cols) + 0.5) * STEP
    lats = N - (np.arange(rows) + 0.5) * STEP
    px = np.array([gx(v) for v in lons]) - x0 * 256 - 0.5
    py = np.array([gy(v) for v in lats]) - y0 * 256 - 0.5
    PX, PY = np.meshgrid(px, py)
    i0, j0 = np.floor(PX).astype(int), np.floor(PY).astype(int)
    fx, fy = PX - i0, PY - j0
    v = (mos[j0, i0] * (1 - fx) * (1 - fy) + mos[j0, i0 + 1] * fx * (1 - fy)
         + mos[j0 + 1, i0] * (1 - fx) * fy + mos[j0 + 1, i0 + 1] * fx * fy)
    v = np.maximum(v, 0)   # el mar (esquina sureste) a nivel 0
    code = np.clip(np.round(v + 500), 0, 65535).astype(np.uint16)
    rgb = np.zeros((rows, cols, 3), np.uint8)
    rgb[..., 0] = code >> 8
    rgb[..., 1] = code & 255
    Image.fromarray(rgb, "RGB").save(OUT / "dem.png", optimize=True)
    json.dump({"bbox": [S, W, N, E], "step": STEP, "cols": cols, "rows": rows, "offset": 500,
               "source": "AWS Terrain Tiles (EU-DEM de Copernicus, SRTM), z10"},
              open(OUT / "dem.json", "w"))
    print(f"dem.png {cols}×{rows}, {(OUT / 'dem.png').stat().st_size // 1000} KB, "
          f"altitud {v.min():.0f}–{v.max():.0f} m")


if __name__ == "__main__":
    main()
