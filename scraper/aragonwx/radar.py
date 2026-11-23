"""Radar de Zaragoza (AEMET, Perdiguera; código OPERA «espdg») desde EUMETNET OPERA.

Los volúmenes de cada radar llegan al bucket público de OPERA (CC BY 4.0) en ODIM HDF5:
  · exploración Doppler (:07, :17…): 0,5° y 1,5°, 150 km, celdas de 500 m, DBZH y VRADH
  · exploración de largo alcance (:00, :10…): 0,5°, 1,3° y 2,1°, 250 km, celdas de 1 km, DBZH y TH
Cada exploración se repite cada 10 min y, alternadas, dan una imagen cada 5 min.

De cada fichero se toma la elevación más baja y se guarda en coordenadas polares
(una fila por rayo, una columna por celda) como PNG en escala de grises:
  z_AAAAMMDDTHHMM.png  reflectividad: código = (dBZ + 32)·2, 0 = sin eco o sin dato
  v_AAAAMMDDTHHMM.png  velocidad radial: código = v·3 + 128 (m/s, + se aleja), 0 = sin dato
La web pinta cada píxel de la pantalla con la celda del radar que le corresponde.
Se conservan las últimas KEEP_H horas y manifest.json las describe.

Además, con la exploración de largo alcance de las últimas 24 h (carpeta arch/),
se publica la lluvia estimada de 1, 3, 6, 12 y 24 h, corregida con los pluviómetros:
  a{1,3,6,12,24}h_AAAAMMDDTHHMM.png    código = √mm · 16 (0 = menos de 0,1 mm)

    python -m aragonwx.radar --pub ../out/radar_pub
"""
import argparse
import datetime as dt
import io
import json
import re
import sys
from pathlib import Path

import h5py
import numpy as np
import requests
from PIL import Image

ENDPOINTS = [
    "https://object-store.os-api.cci1.ecmwf.int/openradar-24h-backup",
    "https://s3.waw3-1.cloudferro.com/openradar-24h",
]
SITE, CC = "espdg", "ES"
NAME = "Zaragoza (Perdiguera)"
KEEP_H = 3
KEY_RE = re.compile(r"@(\d{8}T\d{4})@[\d._]+@([A-Z_]+)\.h5$")
UA = {"User-Agent": "AragonWX (estaciones de Aragón; github.com/ccalvosa/AragonWX)"}


def list_keys(ses, now, hours=KEEP_H):
    """Claves del radar de las últimas `hours` horas (por días) en el primer bucket que responda."""
    days = {now.date(), (now - dt.timedelta(hours=hours)).date()}
    for ep in ENDPOINTS:
        keys = []
        try:
            for d in sorted(days):
                prefix = f"{d:%Y/%m/%d}/{CC}/{SITE}/PVOL/"
                token = None
                while True:
                    params = {"list-type": "2", "prefix": prefix, "max-keys": "1000"}
                    if token:
                        params["continuation-token"] = token
                    r = ses.get(ep, params=params, timeout=30)
                    r.raise_for_status()
                    keys += re.findall(r"<Key>([^<]+)</Key>", r.text)
                    m = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", r.text)
                    if not m:
                        break
                    token = m.group(1)
        except requests.RequestException as e:
            print(f"radar: {ep} no responde ({e})", file=sys.stderr)
            continue
        if keys:
            return ep, keys
        print(f"radar: {ep} sin ficheros de {SITE}", file=sys.stderr)
    return None, []


def _str(v):
    return v.decode() if isinstance(v, bytes) else str(v)


def decode(blob):
    """ODIM PVOL → dict con la elevación más baja: z (uint8), v (uint8 o None) y su geometría."""
    with h5py.File(io.BytesIO(blob), "r") as h:
        site = h["where"].attrs
        sets = [k for k in h if k.startswith("dataset")]
        low = min(sets, key=lambda k: float(h[k]["where"].attrs["elangle"]))
        ds = h[low]
        w = ds["where"].attrs
        q = {}
        for k in ds:
            if k.startswith("data"):
                a = ds[k]["what"].attrs
                raw = ds[k]["data"][...].astype(np.float64)
                val = raw * float(a.get("gain", 1.0)) + float(a.get("offset", 0.0))
                bad = (raw == float(a["nodata"])) | (raw == float(a["undetect"]))
                q[_str(a["quantity"])] = (val, bad)
        if "DBZH" not in q:
            raise ValueError("sin DBZH")
        nrays = int(w["nrays"])
        az0 = 0.0
        if "how" in ds and "startazA" in ds["how"].attrs:
            az0 = float(ds["how"].attrs["startazA"][0]) % 360
        rstart = float(w.get("rstart", 0.0))
        rstart_m = rstart * 1000 if rstart < 50 else rstart   # ODIM dice km; AEMET lo da en m
        z, zbad = q["DBZH"]
        zc = np.clip(np.round((z + 32) * 2), 1, 254).astype(np.uint8)
        zc[zbad] = 0
        out = {"z": zc, "v": None, "nbins": int(w["nbins"]), "nrays": nrays, "rscale": float(w["rscale"]),
               "rstart": rstart_m, "az0": round(az0, 3), "elev": round(float(w["elangle"]), 2),
               "lat": float(site["lat"]), "lon": float(site["lon"]), "h": float(site["height"])}
        if "VRADH" in q:
            v, vbad = q["VRADH"]
            vc = np.clip(np.round(v * 3) + 128, 1, 254).astype(np.uint8)
            vc[vbad | zbad] = 0   # «undetect» de la velocidad vale 0 m/s: se enmascara con la reflectividad
            out["v"] = vc
        return out


def save_png(arr, path):
    Image.fromarray(arr, "L").save(path, optimize=True)


def utc(stamp):
    return dt.datetime.strptime(stamp, "%Y%m%dT%H%M").replace(tzinfo=dt.timezone.utc)


# ---------- lluvia estimada (acumulados de 1 h y 24 h) ----------
# Cada exploración de largo alcance (cada 10 min) se convierte en intensidad con
# Marshall-Palmer (Z = 200·R^1,6), por debajo de ZMIN_RAIN dBZ no llueve y el dBZ se
# limita a ZMAX_RAIN para que el granizo no dispare el acumulado; cada imagen cuenta
# 10 min. El de 24 h se corrige con un único factor (sesgo medio) frente a los
# pluviómetros de AEMET (p24 de now.json): suma de pluviómetros / suma del radar.
ZMIN_RAIN, ZMAX_RAIN = 7.0, 55.0
STEP_MIN = 10
DATA_NOW = "https://raw.githubusercontent.com/ccalvosa/AragonWX/data/now.json"
BACKFILL = 30            # descargas por pasada para rellenar el archivo de 24 h
BIAS_MIN_PAIRS, BIAS_RANGE = 5, (0.25, 4.0)
# Ecos fijos (montañas, edificios): frecuencia de eco de cada celda con una media
# exponencial de ~2 días; las celdas con eco más de la mitad del tiempo no suman lluvia.
CLUTTER_TAU, CLUTTER_ON, CLUTTER_SEED = 288, 0.5, 0.9
PERIODS = (1, 3, 6, 12, 24)   # horas de los acumulados


def rain_rate(code):
    dbz = code.astype(np.float64) / 2 - 32
    ok = (code > 0) & (dbz >= ZMIN_RAIN)
    z = 10 ** (np.minimum(dbz, ZMAX_RAIN) / 10)
    r = (z / 200) ** (1 / 1.6)
    r[~ok] = 0
    return r


def polar_index(geo, site, lat, lon):
    """(rayo, celda, distancia en km) de un punto, o None fuera del alcance."""
    R = 6371000.0
    la0, lo0, la, lo = map(np.radians, (site["lat"], site["lon"], lat, lon))
    d = lo - lo0
    x = np.cos(la) * np.sin(d)
    y = np.cos(la0) * np.sin(la) - np.sin(la0) * np.cos(la) * np.cos(d)
    dist = R * np.hypot(x, y)
    az = (np.degrees(np.arctan2(x, y)) + 360) % 360
    b = int((dist - geo["rstart"]) // geo["rscale"])
    if b < 0 or b >= geo["nbins"]:
        return None
    ray = int(((az - geo["az0"] + 720) % 360) * geo["nrays"] / 360) % geo["nrays"]
    return ray, b, dist / 1000


def gauge_bias(ses, acc24, geo, site, t_last):
    """Factor pluviómetros / radar con las estaciones de AEMET que tienen lluvia en 24 h."""
    try:
        doc = ses.get(DATA_NOW, params={"t": int(t_last.timestamp() // 60)}, timeout=30).json()
    except Exception as e:
        print(f"radar: sin now.json para corregir la lluvia ({e})", file=sys.stderr)
        return None, 0
    if abs(doc.get("ts", 0) - t_last.timestamp()) > 2 * 3600:
        return None, 0
    c = {k: i for i, k in enumerate(doc["cols"])}
    pairs = []
    for row in doc["rows"]:
        if row[c["src"]] != "AEMET" or row[c["st"]] != "ok" or row[c["p24"]] is None:
            continue
        ix = polar_index(geo, site, row[c["lat"]], row[c["lon"]])
        if not ix or ix[2] < 15:   # junto al radar, el cono de silencio
            continue
        g, r = float(row[c["p24"]]), float(acc24[ix[0], ix[1]])
        if g >= 0.5 and r >= 0.5:
            pairs.append((g, r))
    if len(pairs) < BIAS_MIN_PAIRS or sum(r for _, r in pairs) < 5:
        return None, len(pairs)
    f = sum(g for g, _ in pairs) / sum(r for _, r in pairs)
    return round(min(max(f, BIAS_RANGE[0]), BIAS_RANGE[1]), 3), len(pairs)


def accumulate(ses, pub, man):
    """Recalcula los acumulados si hay exploraciones nuevas en el archivo. Devuelve True si cambian."""
    arch, geo = pub / "arch", man.get("arch_geo")
    files = sorted(arch.glob("z_*.png")) if arch.exists() else []
    if not files or not geo:
        return False
    t_last = utc(files[-1].stem[2:])
    sig = f"{files[-1].stem}:{len(files)}"
    if man.get("acc", {}).get("sig") == sig:
        return False
    shape = (geo["nrays"], geo["nbins"])
    acc = {h: np.zeros(shape) for h in PERIODS}
    nf = {h: 0 for h in PERIODS}
    echo = np.zeros(shape)
    last_echo = None
    for p in files:
        age = (t_last - utc(p.stem[2:])).total_seconds() / 60
        if age >= 24 * 60:
            continue
        a = np.asarray(Image.open(p))
        if a.shape != shape:
            continue
        rr = rain_rate(a)
        r = rr * STEP_MIN / 60
        echo += rr > 0
        for h in PERIODS:
            if age < h * 60:
                acc[h] += r; nf[h] += 1
        if age == 0:
            last_echo = rr > 0
    n24 = nf[24]
    exp = {h: h * 60 // STEP_MIN for h in PERIODS}
    e24 = exp[24]
    # mapa de ecos fijos
    cpath = pub / "clutter.png"
    freq24 = echo / max(n24, 1)
    if cpath.exists():
        cl = np.asarray(Image.open(cpath)).astype(np.float64) / 250
        if cl.shape != shape:
            cl = None
    else:
        cl = None
    new_last = man.get("acc", {}).get("t") != t_last.strftime("%Y-%m-%dT%H:%MZ")
    if cl is None and n24 >= 0.8 * e24:
        cl = freq24.copy()   # primera vez con 24 h completas
    elif cl is not None and new_last and last_echo is not None:
        cl += (last_echo - cl) / CLUTTER_TAU
    if cl is not None:
        Image.fromarray(np.round(cl * 250).astype(np.uint8), "L").save(cpath, optimize=True)
        fixed = cl >= CLUTTER_ON
    else:
        fixed = (freq24 >= CLUTTER_SEED) if n24 >= 18 else np.zeros(shape, bool)   # ≥ 3 h de imágenes
    # imágenes que faltan: se reparten solo si faltan pocas (si no, se publica lo que hay)
    complete = lambda h: nf[h] >= (4 if h == 1 else 0.8 * exp[h])
    for h in PERIODS:
        acc[h][fixed] = 0
        if exp[h] > nf[h] and complete(h):
            acc[h] *= exp[h] / nf[h]
    bias, npairs = gauge_bias(ses, acc[24], geo, man["site"], t_last) if complete(24) else (None, 0)
    f = bias or 1.0   # un único factor (sesgo medio del campo de 24 h) para todos los periodos
    stamp = t_last.strftime("%Y%m%dT%H%M")
    code = lambda a: np.where(a * f >= 0.1, np.clip(np.round(np.sqrt(a * f) * 16), 1, 254), 0).astype(np.uint8)
    for old in pub.glob("a*h_*.png"):
        old.unlink()
    per = {}
    for h in PERIODS:
        name = f"a{h}h_{stamp}.png"
        save_png(code(acc[h]), pub / name)
        per[str(h)] = {"f": name, "n": nf[h], "e": exp[h], "max": round(float(acc[h].max() * f), 1)}
    man["acc"] = {"t": t_last.strftime("%Y-%m-%dT%H:%MZ"), "per": per,
                  # claves antiguas (1 h y 24 h) para las páginas que aún no lean «per»
                  "h1": per["1"]["f"], "h24": per["24"]["f"], "n1": nf[1], "n24": n24, "e1": exp[1], "e24": e24,
                  "bias": bias, "pairs": npairs, "sig": sig,
                  "clutter": int(fixed.sum()), "clutter_map": cl is not None,
                  "acode": "mm = (c/16)^2", "zr": "Marshall-Palmer Z = 200·R^1,6", **geo}
    print(f"radar: lluvia {', '.join(f'{h} h ({nf[h]}/{exp[h]})' for h in PERIODS)} a las {man['acc']['t']}, "
          f"corrección {bias if bias else 'ninguna'} con {npairs} pluviómetros; {int(fixed.sum())} celdas de ecos fijos; "
          f"máx. 24 h {per['24']['max']:.1f} mm")
    return True


def run(pub: Path, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    pub.mkdir(parents=True, exist_ok=True)
    arch = pub / "arch"
    arch.mkdir(exist_ok=True)
    mpath = pub / "manifest.json"
    man = json.loads(mpath.read_text()) if mpath.exists() else {"frames": []}
    have = {f["t"] for f in man["frames"]}
    cutoff = (now - dt.timedelta(hours=KEEP_H)).strftime("%Y%m%dT%H%M")
    cut24 = (now - dt.timedelta(hours=24, minutes=20)).strftime("%Y%m%dT%H%M")
    ses = requests.Session()
    ses.headers.update(UA)
    ep, keys = list_keys(ses, now, hours=25)
    new = backfilled = 0
    for key in sorted(keys, reverse=True):   # de la más reciente hacia atrás (el relleno empieza por la última hora)
        m = KEY_RE.search(key)
        if not m:
            continue
        stamp, qty = m.groups()
        t = utc(stamp).strftime("%Y-%m-%dT%H:%MZ")
        recent = stamp >= cutoff and t not in have
        # el archivo de 24 h solo guarda la de largo alcance (sin VRADH)
        to_arch = "VRADH" not in qty and stamp >= cut24 and not (arch / f"z_{stamp}.png").exists()
        if not recent and not (to_arch and backfilled < BACKFILL):
            continue
        try:
            r = ses.get(f"{ep}/{key}", timeout=60)
            r.raise_for_status()
            d = decode(r.content)
        except Exception as e:   # un fichero roto no para el resto
            print(f"radar: {key} no se ha podido leer ({e})", file=sys.stderr)
            continue
        man["site"] = {"id": SITE, "name": NAME, "lat": d["lat"], "lon": d["lon"], "h": d["h"]}
        if d["v"] is None:
            save_png(d["z"], arch / f"z_{stamp}.png")
            man["arch_geo"] = {k: d[k] for k in ("nbins", "nrays", "rscale", "rstart", "az0")}
            if not recent:
                backfilled += 1
        if not recent:
            continue
        save_png(d["z"], pub / f"z_{stamp}.png")
        fr = {"t": t, "kind": "dop" if d["v"] is not None else "lr", "z": f"z_{stamp}.png",
              **{k: d[k] for k in ("nbins", "nrays", "rscale", "rstart", "az0", "elev")}}
        if d["v"] is not None:
            save_png(d["v"], pub / f"v_{stamp}.png")
            fr["v"] = f"v_{stamp}.png"
        man["frames"].append(fr)
        have.add(t)
        new += 1
    # fuera lo que ya no entra en las ventanas
    keep = [f for f in man["frames"] if f["t"].replace("-", "").replace(":", "")[:13] >= cutoff]
    gone = len(man["frames"]) - len(keep)
    man["frames"] = sorted(keep, key=lambda f: f["t"])
    for p in arch.glob("z_*.png"):
        if p.stem[2:] < cut24:
            p.unlink()
    acc = accumulate(ses, pub, man)
    used = {f["z"] for f in keep} | {f.get("v") for f in keep} | {man.get("acc", {}).get("h1"), man.get("acc", {}).get("h24"), "clutter.png"}
    for p in pub.glob("*.png"):
        if p.name not in used:
            p.unlink()
    changed = bool(new or gone or backfilled or acc)
    if changed or not mpath.exists():
        man.update({"updated": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "source": "EUMETNET OPERA (CC BY 4.0) · AEMET",
                    "zcode": "dBZ = c/2 - 32", "vcode": "m/s = (c - 128)/3", "keep_h": KEEP_H})
        mpath.write_text(json.dumps(man, separators=(",", ":")))
    last = man["frames"][-1]["t"] if man["frames"] else "ninguna"
    print(f"radar: {new} nuevas, {gone} retiradas, {backfilled} al archivo de 24 h "
          f"({len(list(arch.glob('z_*.png')))} en total), {len(man['frames'])} en la animación, última {last}")
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pub", required=True)
    ap.add_argument("--flag", help="fichero que se crea si hay cambios que publicar")
    a = ap.parse_args()
    if run(Path(a.pub)) and a.flag:
        Path(a.flag).touch()


if __name__ == "__main__":
    main()
