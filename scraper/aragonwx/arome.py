#!/usr/bin/env python3
"""
AROME France HD (Météo-France, 0,01° ≈ 1,3 km) recortado a Aragón para la web.

Fuente: paquetes horarios abiertos de Météo-France (Licence Ouverte 2.0) en
https://meteofrance-pnt.s3.rbx.io.cloud.ovh.net/pnt/<pasada>/arome/001/<SP1|SP2>/…
Pasadas cada 3 h, de H+00 a H+51, publicadas poco a poco ~1,5–3 h después.

Cada fichero cubre toda Francia (2801×1791 puntos), así que no se descarga
entero: con una petición de 160 bytes por mensaje se lee su cabecera (longitud y
parámetro) y luego solo se bajan los mensajes que interesan (~16 MB por hora).

Campos que se publican (PNG en escala de grises, un valor codificado por píxel,
255 = sin dato; filas reproyectadas a Mercator para superponer sin deformación):
  pr1   lluvia total de la hora (mm)       código = √p · 25
  pacc  lluvia acumulada desde H+00 (mm)   código = √p · 16
  gust  racha máxima de la hora (km/h)     código = g
  t2m   temperatura a 2 m (°C)             código = (T + 40) · 2,5

La pasada se procesa por partes en cada vuelta del bucle (límite de tiempo) en
--stage; cuando están las 52 horas, se escribe en --publish con manifest.json y
el workflow lo sube a la rama «arome».

    python -m aragonwx.arome --stage ../out/arome_stage --publish ../out/arome_pub --published-run <run>
"""

import argparse
import io
import json
import math
import re
import shutil
import struct
import time
from pathlib import Path

import numpy as np
import requests

from .common import dump_json, log

BUCKET = "https://meteofrance-pnt.s3.rbx.io.cloud.ovh.net"
NHOURS = 52
# rejilla de los ficheros 0,01°
LAT0, LON0, STEP, NI, NJ = 55.4, -12.0, 0.01, 2801, 1791
# recorte: Aragón y alrededores
S, N, W, E = 39.3, 43.4, -2.8, 1.6
# (paquete, disciplina, categoría, número) -> nombre interno
WANTED = {
    ("SP1", 0, 0, 0): "t2m",
    ("SP1", 0, 2, 23): "ugust",
    ("SP1", 0, 2, 24): "vgust",
    ("SP2", 0, 1, 65): "rain",      # lluvia acumulada (kg m-2)
    ("SP2", 0, 1, 66): "snow",      # nieve acumulada
    ("SP2", 0, 1, 75): "graupel",   # nieve granulada acumulada
}
ENC = {
    "pr1": lambda p: np.sqrt(np.clip(p, 0, None)) * 25,
    "pacc": lambda p: np.sqrt(np.clip(p, 0, None)) * 16,
    "gust": lambda g: g,
    "t2m": lambda t: (t + 40) * 2.5,
}

http = requests.Session()
http.headers["User-Agent"] = "AragonWX (+https://github.com/ccalvosa/AragonWX)"


# ------------------------------------------------------------------ S3
def list_keys(prefix):
    keys, token = {}, None
    while True:
        params = {"list-type": "2", "prefix": prefix}
        if token:
            params["continuation-token"] = token
        r = http.get(BUCKET + "/", params=params, timeout=30)
        r.raise_for_status()
        for k, sz in re.findall(r"<Key>([^<]+)</Key>.*?<Size>(\d+)</Size>", r.text, re.S):
            keys[k] = int(sz)
        m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", r.text)
        if not m:
            return keys
        token = m.group(1)


def latest_runs(n=4):
    r = http.get(BUCKET + "/", params={"list-type": "2", "prefix": "pnt/", "delimiter": "/"}, timeout=30)
    r.raise_for_status()
    runs = sorted(re.findall(r"<Prefix>pnt/([^/<]+)/</Prefix>", r.text))
    return runs[-n:][::-1]


def run_hours(run):
    """{paquete: {hora: (url, tamaño)}} de una pasada."""
    out = {}
    for pk in ("SP1", "SP2"):
        keys = list_keys(f"pnt/{run}/arome/001/{pk}/")
        out[pk] = {}
        for k, sz in keys.items():
            m = re.search(r"__(\d+)H__", k)
            if m:
                out[pk][int(m.group(1))] = (f"{BUCKET}/{k}", sz)
    return out


def complete_run(runs_info):
    for run, info in runs_info:
        if all(len(info.get(pk, {})) >= NHOURS for pk in ("SP1", "SP2")):
            return run, info
    return None, None


# ------------------------------------------------------------------ GRIB por trozos
def message_table(url, size):
    """[(offset, longitud, (disciplina, categoría, número))] leyendo solo las cabeceras."""
    out, off = [], 0
    while off < size:
        r = http.get(url, headers={"Range": f"bytes={off}-{off + 159}"}, timeout=30)
        r.raise_for_status()
        b = r.content
        if b[:4] != b"GRIB":
            raise ValueError(f"no hay mensaje GRIB en {off}")
        length = struct.unpack(">Q", b[8:16])[0]
        disc, p, key = b[6], 16, None
        while p + 11 <= len(b):
            sl, sn = struct.unpack(">I", b[p:p + 4])[0], b[p + 4]
            if sn == 4:
                key = (disc, b[p + 9], b[p + 10])
                break
            p += sl
        out.append((off, length, key))
        off += length
    return out


def crop_index():
    j0, j1 = round((LAT0 - N) / STEP), round((LAT0 - S) / STEP)
    i0, i1 = round((W - LON0) / STEP), round((E - LON0) / STEP)
    lats = LAT0 - STEP * np.arange(j0, j1 + 1)
    # filas uniformes en Mercator (de norte a sur) -> fila de origen más cercana
    merc = lambda la: math.log(math.tan(math.pi / 4 + math.radians(la) / 2))
    y0, y1 = merc(S), merc(N)
    nrows = round((y1 - y0) / math.radians(STEP))
    ys = y1 - (np.arange(nrows) + 0.5) * (y1 - y0) / nrows
    tlat = np.degrees(2 * np.arctan(np.exp(ys)) - math.pi / 2)
    rows = np.clip(np.round((LAT0 - tlat) / STEP).astype(int) - j0, 0, len(lats) - 1)
    return slice(j0, j1 + 1), slice(i0, i1 + 1), rows


JS, IS, ROWS = crop_index()


def decode(buf):
    # pygrib: sus ruedas incluyen ecCodes con soporte CCSDS (la compresión de Météo-France)
    import pygrib
    g = pygrib.fromstring(buf)
    if (g.Ni, g.Nj) != (NI, NJ):
        raise ValueError("rejilla inesperada")
    v = np.ma.filled(np.ma.asarray(g.values, dtype=np.float32), np.nan)
    return v[JS, IS][ROWS]


def fetch_hour(info, hour):
    fields = {}
    for pk in ("SP1", "SP2"):
        url, size = info[pk][hour]
        for off, length, key in message_table(url, size):
            name = WANTED.get((pk, *key)) if key else None
            if not name:
                continue
            r = http.get(url, headers={"Range": f"bytes={off}-{off + length - 1}"}, timeout=120)
            r.raise_for_status()
            fields[name] = decode(r.content)
    return fields


# ------------------------------------------------------------------ salida
def to_png(path, arr, enc):
    from PIL import Image
    code = np.where(np.isfinite(arr), np.clip(np.round(ENC[enc](arr)), 0, 254), 255).astype(np.uint8)
    Image.fromarray(code, mode="L").save(path, optimize=True)


def process(stage, publish, published_run, budget):
    t_start = time.time()
    runs = latest_runs()
    info_all = []
    for run in runs:
        try:
            info_all.append((run, run_hours(run)))
        except Exception as e:
            log(f"  AROME: no se pudo listar {run}: {e}")
    run, info = complete_run(info_all)
    if not run:
        log("  AROME: ninguna pasada completa todavía")
        return False
    if run == published_run:
        log(f"  AROME: la pasada {run} ya está publicada")
        return False
    sdir = stage / run.replace(":", "")
    if stage.exists():   # restos de pasadas anteriores
        for d in stage.iterdir():
            if d != sdir:
                shutil.rmtree(d, ignore_errors=True)
    sdir.mkdir(parents=True, exist_ok=True)
    done = {int(p.stem[1:]) for p in sdir.glob("h*.done")}
    for hour in range(NHOURS):
        if hour in done:
            continue
        if time.time() - t_start > budget:
            log(f"  AROME {run}: {len(done)}/{NHOURS} horas; se sigue en la próxima vuelta")
            return False
        f = fetch_hour(info, hour)
        acc = sum(f[k] for k in ("rain", "snow", "graupel") if k in f) if any(k in f for k in ("rain", "snow", "graupel")) else None
        if acc is not None:
            np.save(sdir / f"acc{hour:02d}.npy", acc)
            to_png(sdir / f"pacc_{hour:02d}.png", acc, "pacc")
            prev = sdir / f"acc{hour - 1:02d}.npy"
            if hour > 0 and (prev.exists() or hour == 1):   # en H+00 no suele haber acumulado
                base = np.load(prev) if prev.exists() else 0.0
                to_png(sdir / f"pr1_{hour:02d}.png", np.clip(acc - base, 0, None), "pr1")
        if "ugust" in f and "vgust" in f:
            to_png(sdir / f"gust_{hour:02d}.png", np.hypot(f["ugust"], f["vgust"]) * 3.6, "gust")
        if "t2m" in f:
            to_png(sdir / f"t2m_{hour:02d}.png", f["t2m"] - 273.15, "t2m")
        (sdir / f"h{hour:02d}.done").touch()
        done.add(hour)
    # pasada completa: se publica
    if publish.exists():
        shutil.rmtree(publish)
    publish.mkdir(parents=True)
    hours = {v: sorted(int(p.stem.split("_")[1]) for p in sdir.glob(f"{v}_*.png")) for v in ENC}
    for p in sdir.glob("*.png"):
        shutil.copy(p, publish / p.name)
    h, w = len(ROWS), IS.stop - IS.start
    dump_json(publish / "manifest.json", {
        "model": "AROME France HD 0,01° (Météo-France)", "run": run, "generated": int(time.time()),
        "bbox": [S, W, N, E], "w": w, "h": h, "hours": hours,
        "enc": {"pr1": "sqrt25", "pacc": "sqrt16", "gust": "linear1", "t2m": "t40x2.5"},
    })
    log(f"  AROME: pasada {run} lista para publicar ({sum(len(v) for v in hours.values())} imágenes, "
        f"{sum(p.stat().st_size for p in publish.glob('*.png')) / 1e6:.1f} MB)")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", type=Path, required=True)
    ap.add_argument("--publish", type=Path, required=True)
    ap.add_argument("--published-run", default="")
    ap.add_argument("--budget", type=float, default=240, help="segundos máximos por vuelta")
    a = ap.parse_args()
    try:
        ready = process(a.stage, a.publish, a.published_run.strip(), a.budget)
    except Exception as e:
        log(f"  AROME: ERROR {type(e).__name__}: {e}")
        ready = False
    (a.publish.parent / "arome_ready").unlink(missing_ok=True)
    if ready:
        (a.publish.parent / "arome_ready").write_text("1")


if __name__ == "__main__":
    main()
