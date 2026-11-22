#!/usr/bin/env python3
"""
AROME France HD (Météo-France, 0,01° ≈ 1,3 km) sobre la parte de España que cubre
su dominio (hasta 37,5°N por el sur), con un margen amplio sobre Francia, el
Atlántico y el Mediterráneo.

Fuente: paquetes horarios abiertos de Météo-France (Licence Ouverte 2.0) en
https://meteofrance-pnt.s3.rbx.io.cloud.ovh.net/pnt/<pasada>/arome/001/<SP1|SP2>/…
Pasadas cada 3 h, de H+00 a H+51, publicadas poco a poco ~1,5–3 h después.

Cada fichero cubre toda Francia (2801×1791 puntos), así que no se descarga
entero: con una petición de 160 bytes por mensaje se lee su cabecera (longitud y
parámetro) y luego solo se bajan los mensajes que interesan (~16 MB por hora).

Campos que se publican (PNG en escala de grises, un valor codificado por píxel,
255 = sin dato; rejilla nativa de 0,01° sin reproyectar ni interpolar):
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
from datetime import datetime, timezone
import io
import json
import re
import shutil
import struct
import time
from pathlib import Path

import numpy as np
import requests

from .common import dump_json, log

BUCKET = "https://meteofrance-pnt.s3.rbx.io.cloud.ovh.net"
NHOURS = 52        # H+00 a H+51
MIN_HOURS = 24     # una pasada atascada se publica si llega al menos a H+23…
STALL = 3600       # …y lleva una hora sin ficheros nuevos
# rejilla de los ficheros 0,01°
LAT0, LON0, STEP, NI, NJ = 55.4, -12.0, 0.01, 2801, 1791
# recorte: España dentro del dominio de AROME (el límite sur del modelo es 37,5°N),
# de Galicia a Baleares y con margen sobre Francia
S, N, W, E = 37.5, 45.0, -10.5, 5.0
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

# identidad de lo publicado: pasada + recorte (si cambia el recorte, se rehace)
def ident(run):
    return f"{run}@{S},{W},{N},{E}@nativa"


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
        for c in re.findall(r"<Contents>.*?</Contents>", r.text, re.S):
            k, sz = re.search(r"<Key>([^<]+)", c).group(1), int(re.search(r"<Size>(\d+)", c).group(1))
            lm = re.search(r"<LastModified>([^<]+)", c)
            t = datetime.strptime(lm.group(1)[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp() if lm else 0
            keys[k] = (sz, t)
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
    """{paquete: {hora: (url, tamaño)}, "newest": instante del último fichero}."""
    out, newest = {}, 0
    for pk in ("SP1", "SP2"):
        keys = list_keys(f"pnt/{run}/arome/001/{pk}/")
        out[pk] = {}
        for k, (sz, t) in keys.items():
            m = re.search(r"__(\d+)H__", k)
            if m:
                out[pk][int(m.group(1))] = (f"{BUCKET}/{k}", sz)
                newest = max(newest, t)
    out["newest"] = newest
    return out


def run_length(info):
    """Horas consecutivas desde H+00 presentes en SP1 y SP2."""
    n = 0
    while n in info.get("SP1", {}) and n in info.get("SP2", {}):
        n += 1
    return n


def complete_run(runs_info):
    """La pasada más reciente que está completa: las 52 horas, o al menos MIN_HOURS
    sin ficheros nuevos desde hace STALL segundos (pasadas cortas o atascadas)."""
    now = time.time()
    for run, info in runs_info:
        n = run_length(info)
        if n >= NHOURS or (n >= MIN_HOURS and now - info.get("newest", now) > STALL):
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
    """Recorte de la rejilla nativa (sin reproyectar ni interpolar)."""
    j0, j1 = round((LAT0 - N) / STEP), round((LAT0 - S) / STEP)
    i0, i1 = round((W - LON0) / STEP), round((E - LON0) / STEP)
    return slice(j0, j1 + 1), slice(i0, i1 + 1)


JS, IS = crop_index()


def decode(buf):
    # pygrib: sus ruedas incluyen ecCodes con soporte CCSDS (la compresión de Météo-France)
    import pygrib
    g = pygrib.fromstring(buf)
    if (g.Ni, g.Nj) != (NI, NJ):
        raise ValueError("rejilla inesperada")
    v = np.ma.filled(np.ma.asarray(g.values, dtype=np.float32), np.nan)
    return v[JS, IS]   # filas de norte a sur, puntos de rejilla nativos


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
    Image.fromarray(code, mode="L").save(path, compress_level=7)


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
    if ident(run) == published_run:
        log(f"  AROME: la pasada {run} ya está publicada")
        return False
    sdir = stage / ident(run).replace(":", "").replace("@", "_").replace(",", "_")
    if stage.exists():   # restos de pasadas anteriores
        for d in stage.iterdir():
            if d != sdir:
                shutil.rmtree(d, ignore_errors=True)
    sdir.mkdir(parents=True, exist_ok=True)
    done = {int(p.stem[1:]) for p in sdir.glob("h*.done")}
    nh = min(run_length(info), NHOURS)
    for hour in range(nh):
        if hour in done:
            continue
        if time.time() - t_start > budget:
            log(f"  AROME {run}: {len(done)}/{nh} horas; se sigue en la próxima vuelta")
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
    h, w = JS.stop - JS.start, IS.stop - IS.start
    dump_json(publish / "manifest.json", {
        "model": "AROME France HD 0,01° (Météo-France)", "run": run, "id": ident(run), "generated": int(time.time()),
        "bbox": [S, W, N, E], "w": w, "h": h, "hours": hours,
        # rejilla nativa: el punto (fila r, columna c) está en (N - r·step, W + c·step)
        "grid": "latlon", "step": STEP,
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
