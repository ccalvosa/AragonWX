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


def list_keys(ses, now):
    """Claves del radar de hoy (y de ayer si hace falta para cubrir KEEP_H) en el primer bucket que responda."""
    days = {now.date(), (now - dt.timedelta(hours=KEEP_H)).date()}
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


def run(pub: Path, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    pub.mkdir(parents=True, exist_ok=True)
    mpath = pub / "manifest.json"
    man = json.loads(mpath.read_text()) if mpath.exists() else {"frames": []}
    have = {f["t"] for f in man["frames"]}
    cutoff = (now - dt.timedelta(hours=KEEP_H)).strftime("%Y%m%dT%H%M")
    ses = requests.Session()
    ses.headers.update(UA)
    ep, keys = list_keys(ses, now)
    new = 0
    for key in sorted(keys):
        m = KEY_RE.search(key)
        if not m:
            continue
        stamp, qty = m.groups()
        t = dt.datetime.strptime(stamp, "%Y%m%dT%H%M").replace(tzinfo=dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
        if stamp < cutoff or t in have:
            continue
        try:
            r = ses.get(f"{ep}/{key}", timeout=60)
            r.raise_for_status()
            d = decode(r.content)
        except Exception as e:   # un fichero roto no para el resto
            print(f"radar: {key} no se ha podido leer ({e})", file=sys.stderr)
            continue
        save_png(d["z"], pub / f"z_{stamp}.png")
        fr = {"t": t, "kind": "dop" if d["v"] is not None else "lr", "z": f"z_{stamp}.png",
              **{k: d[k] for k in ("nbins", "nrays", "rscale", "rstart", "az0", "elev")}}
        if d["v"] is not None:
            save_png(d["v"], pub / f"v_{stamp}.png")
            fr["v"] = f"v_{stamp}.png"
        man["frames"].append(fr)
        man["site"] = {"id": SITE, "name": NAME, "lat": d["lat"], "lon": d["lon"], "h": d["h"]}
        have.add(t)
        new += 1
    # fuera lo que ya no entra en la ventana
    keep = [f for f in man["frames"] if f["t"].replace("-", "").replace(":", "")[:13] >= cutoff]
    gone = len(man["frames"]) - len(keep)
    man["frames"] = sorted(keep, key=lambda f: f["t"])
    used = {f["z"] for f in keep} | {f.get("v") for f in keep}
    for p in pub.glob("*.png"):
        if p.name not in used:
            p.unlink()
    if new or gone or not mpath.exists():
        man.update({"updated": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "source": "EUMETNET OPERA (CC BY 4.0) · AEMET",
                    "zcode": "dBZ = c/2 - 32", "vcode": "m/s = (c - 128)/3", "keep_h": KEEP_H})
        mpath.write_text(json.dumps(man, separators=(",", ":")))
    last = man["frames"][-1]["t"] if man["frames"] else "ninguna"
    print(f"radar: {new} nuevas, {gone} retiradas, {len(man['frames'])} en total, última {last}")
    return bool(new or gone)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pub", required=True)
    ap.add_argument("--flag", help="fichero que se crea si hay cambios que publicar")
    a = ap.parse_args()
    if run(Path(a.pub)) and a.flag:
        Path(a.flag).touch()


if __name__ == "__main__":
    main()
