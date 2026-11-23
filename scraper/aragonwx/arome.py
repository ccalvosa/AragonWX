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
  snow  nieve acumulada desde H+00 (cm)    código = √s · 25
        (agua de la nieve en kg/m² con 1 mm ≈ 1 cm, relación 10:1; sin la nieve granulada)
  cota  cota de nieve (m)                  código = z / 20
        altura del termómetro húmedo de +1 °C, calculada con la temperatura, la humedad
        y el geopotencial en 13 niveles de presión (1000–450 hPa) del paquete IP1 de
        AROME a 0,025° (los paquetes de 0,01° no traen nada en altura) e interpolada
        bilinealmente a la rejilla de 0,01°. Unos 24 MB más por hora.

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
# AROME 0,025° (paquete IP1, niveles de presión) para la cota de nieve
LAT25, LON25, STEP25, NI25, NJ25 = 55.4, -12.0, 0.025, 1121, 717
PLEVS = (100000, 95000, 92500, 90000, 85000, 80000, 75000, 70000, 65000, 60000, 55000, 50000, 45000)   # Pa
IPVARS = {(0, 0, 0): "t", (0, 1, 1): "rh", (0, 3, 4): "z"}
TW_SNOW = 1.0   # °C: la nieve suele llegar hasta donde el termómetro húmedo marca ~+1 °C
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
    "snow": lambda s: np.sqrt(np.clip(s, 0, None)) * 25,
    "cota": lambda z: z / 20,
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
    # IP1 de 0,025°: un fichero por bloque de horas (00H06H, 07H12H…)
    out["IP1"] = {}
    for k, (sz, t) in list_keys(f"pnt/{run}/arome/0025/IP1/").items():
        m = re.search(r"__(\d+)H(\d+)H__", k)
        if m:
            for h in range(int(m.group(1)), int(m.group(2)) + 1):
                out["IP1"][h] = (f"{BUCKET}/{k}", sz)
            newest = max(newest, t)
    out["newest"] = newest
    return out


def run_length(info):
    """Horas consecutivas desde H+00 presentes en SP1, SP2 e IP1."""
    n = 0
    while all(n in info.get(pk, {}) for pk in ("SP1", "SP2", "IP1")):
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


# ------------------------------------------------------------------ cota de nieve
def ip_table(url, size, cache):
    """[(offset, longitud, var, nivel Pa, hora)] de los mensajes útiles de un fichero IP1.
    Se lee cabecera a cabecera (~700 mensajes), así que se guarda en `cache`."""
    if cache.exists():
        return [tuple(x) for x in json.loads(cache.read_text())]
    out, off = [], 0
    while off < size:
        r = http.get(url, headers={"Range": f"bytes={off}-{off + 199}"}, timeout=30)
        r.raise_for_status()
        b = r.content
        if b[:4] != b"GRIB":
            raise ValueError(f"no hay mensaje GRIB en {off}")
        length = struct.unpack(">Q", b[8:16])[0]
        disc, p = b[6], 16
        while p + 28 <= len(b):
            sl, sn = struct.unpack(">I", b[p:p + 4])[0], b[p + 4]
            if sn == 4:
                var = IPVARS.get((disc, b[p + 9], b[p + 10]))
                lev, val = b[p + 22], struct.unpack(">I", b[p + 24:p + 28])[0]
                step = struct.unpack(">I", b[p + 18:p + 22])[0]
                if var and lev == 100 and b[p + 23] == 0 and val in PLEVS:
                    out.append((off, length, var, val, step))
                break
            p += sl
        off += length
    cache.write_text(json.dumps(out))
    return out


def wet_bulb(tc, rh, p_hpa):
    """Temperatura del termómetro húmedo (°C) resolviendo la ecuación psicrométrica
    e = es(Tw) − A·p·(T − Tw) por Newton."""
    es = lambda t: 6.112 * np.exp(17.67 * t / (t + 243.5))
    e = np.clip(rh, 1, 100) / 100 * es(tc)
    tw = tc - 2.0
    for _ in range(8):
        a = 6.6e-4 * (1 + 0.00115 * tw) * p_hpa
        f = es(tw) - a * (tc - tw) - e
        d = es(tw) * 17.67 * 243.5 / (tw + 243.5) ** 2 + a
        tw = np.minimum(tw - f / d, tc)
    return tw


def snow_level(t, rh, z):
    """Cota de nieve (m) en cada punto: el nivel más alto en el que el termómetro húmedo
    sube por encima de TW_SNOW, interpolado entre niveles de presión. Si toda la columna
    está por debajo, la cota queda bajo el nivel de 1000 hPa (se pone 0)."""
    tw = np.stack([wet_bulb(t[k] - 273.15, rh[k], PLEVS[k] / 100) for k in range(len(PLEVS))])
    hgt = z / 9.80665
    warm = tw >= TW_SNOW
    L = len(PLEVS)
    # índice del nivel más alto con Tw ≥ umbral (de abajo arriba); -1 si ninguno
    top = np.where(warm.any(0), L - 1 - np.argmax(warm[::-1], axis=0), -1)
    k = np.clip(top, 0, L - 2)
    take = lambda a, i: np.take_along_axis(a, i[None], 0)[0]
    t0, t1, z0, z1 = take(tw, k), take(tw, k + 1), take(hgt, k), take(hgt, k + 1)
    frac = np.clip((t0 - TW_SNOW) / np.where(t0 - t1 > 1e-6, t0 - t1, 1e-6), 0, 1)
    out = z0 + frac * (z1 - z0)
    out = np.where(top < 0, 0.0, np.where(top == L - 1, hgt[-1], out))
    return np.clip(out, 0, None)


def fetch_cota(info, hour, sdir):
    import pygrib
    url, size = info["IP1"][hour]
    name = re.search(r"__(\d+H\d+H)__", url).group(1)
    msgs = [m for m in ip_table(url, size, sdir / f"ip1_{name}.json") if m[4] == hour]
    f = {v: [None] * len(PLEVS) for v in IPVARS.values()}
    # mensajes contiguos en una sola petición
    msgs.sort()
    groups, cur = [], []
    for m in msgs:
        if cur and m[0] != cur[-1][0] + cur[-1][1]:
            groups.append(cur); cur = []
        cur.append(m)
    if cur:
        groups.append(cur)
    for g in groups:
        o0 = g[0][0]
        r = http.get(url, headers={"Range": f"bytes={o0}-{g[-1][0] + g[-1][1] - 1}"}, timeout=180)
        r.raise_for_status()
        for off, length, var, lev, _ in g:
            gr = pygrib.fromstring(r.content[off - o0: off - o0 + length])
            if (gr.Ni, gr.Nj) != (NI25, NJ25):
                raise ValueError("rejilla de 0,025° inesperada")
            f[var][PLEVS.index(lev)] = np.ma.filled(np.ma.asarray(gr.values, dtype=np.float32), np.nan)
    if any(x is None for v in f.values() for x in v):
        raise ValueError(f"IP1 H+{hour}: faltan niveles")
    lvl = snow_level(*(np.stack(f[v]) for v in ("t", "rh", "z")))
    # bilineal a la rejilla de 0,01° del recorte
    lat = LAT0 - np.arange(JS.start, JS.stop) * STEP
    lon = LON0 + np.arange(IS.start, IS.stop) * STEP
    fy, fx = (LAT25 - lat) / STEP25, (lon - LON25) / STEP25
    y0, x0 = np.floor(fy).astype(int), np.floor(fx).astype(int)
    wy, wx = (fy - y0)[:, None], (fx - x0)[None, :]
    y1, x1 = np.minimum(y0 + 1, NJ25 - 1), np.minimum(x0 + 1, NI25 - 1)
    return ((lvl[y0][:, x0] * (1 - wx) + lvl[y0][:, x1] * wx) * (1 - wy)
            + (lvl[y1][:, x0] * (1 - wx) + lvl[y1][:, x1] * wx) * wy)


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
    cdone = {int(p.stem[1:]) for p in sdir.glob("c*.done")}
    nh = min(run_length(info), NHOURS)
    for hour in range(nh):
        if hour in done and hour in cdone:
            continue
        if time.time() - t_start > budget:
            log(f"  AROME {run}: {len(done)}/{nh} horas y {len(cdone)}/{nh} de cota; se sigue en la próxima vuelta")
            return False
        if hour not in cdone:
            to_png(sdir / f"cota_{hour:02d}.png", fetch_cota(info, hour, sdir), "cota")
            (sdir / f"c{hour:02d}.done").touch()
            cdone.add(hour)
        if hour in done:
            continue
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
        if "snow" in f:
            to_png(sdir / f"snow_{hour:02d}.png", f["snow"], "snow")
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
        "enc": {"pr1": "sqrt25", "pacc": "sqrt16", "gust": "linear1", "t2m": "t40x2.5", "snow": "sqrt25", "cota": "x20"},
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
