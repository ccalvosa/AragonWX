"""Genera assets/normals.json: normal diaria de la máxima y la mínima de cada estación de AEMET.

Se usa en la web para las anomalías («hoy X °C por encima de lo normal»). Las series
son las de aemet-explorer (data/stations/{id}.json, completas desde su inicio).

Para cada estación y variable se ajusta por mínimos cuadrados la media más tres
armónicos anuales (curva suave del ciclo anual, sin el ruido de cada día):
    normal(d) = a0 + Σ_k (a_k·cos(2πkd/365,25) + b_k·sin(2πkd/365,25)),  d = día del año − 1
Periodo de referencia: 1991–2020 si hay al menos 20 años con datos en él; si no, todos
los años disponibles hasta 2025 si son al menos 10. Si no, la estación no tiene normal.

    python scripts/make_normals.py DIRECTORIO_CON_LOS_JSON   (o sin argumento: los descarga)
"""
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import requests

BASE = "https://ccalvosa.github.io/aemet-explorer/data/"
OUT = Path(__file__).resolve().parents[1] / "assets" / "normals.json"
NH = 3
DAYS_PER_YEAR = 300   # días con dato para contar un año


def design(doy):
    w = 2 * np.pi * doy / 365.25
    cols = [np.ones_like(w)]
    for k in range(1, NH + 1):
        cols += [np.cos(k * w), np.sin(k * w)]
    return np.stack(cols, 1)


def fit(dates, vals, y0, y1):
    sel = (dates >= np.datetime64(f"{y0}-01-01")) & (dates <= np.datetime64(f"{y1}-12-31")) & ~np.isnan(vals)
    if sel.sum() < 10 * DAYS_PER_YEAR:
        return None, 0
    years = np.unique(dates[sel].astype("datetime64[Y]"), return_counts=True)
    nyears = int((years[1] >= DAYS_PER_YEAR).sum())
    d = dates[sel]
    doy = (d - d.astype("datetime64[Y]")).astype(int)
    coef, *_ = np.linalg.lstsq(design(doy.astype(float)), vals[sel], rcond=None)
    return [round(float(c), 3) for c in coef], nyears


def station(doc):
    start = np.datetime64(doc["start"])
    out = {}
    for var, key in (("tmax", "x"), ("tmin", "n")):
        arr = doc["data"].get(var)
        if not arr:
            continue
        vals = np.array([np.nan if v is None else v for v in arr], float)
        dates = start + np.arange(len(vals)).astype("timedelta64[D]")
        coef, ny = fit(dates, vals, 1991, 2020)
        period = "1991–2020"
        if coef is None or ny < 20:
            coef, ny = fit(dates, vals, 1900, 2025)
            if coef is None or ny < 10:
                continue
            ok = dates[~np.isnan(vals) & (dates <= np.datetime64("2025-12-31"))]
            period = f"{str(ok.min())[:4]}–{str(ok.max())[:4]}"
        out[key] = coef
        out[key + "p"] = period
        out[key + "y"] = ny
    return out


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    index = requests.get(BASE + "index.json", timeout=60).json()["stations"]
    res = {}
    for i, s in enumerate(index):
        if src:
            p = src / f"{s['id']}.json"
            if not p.exists():
                continue
            doc = json.loads(p.read_text())
        else:
            doc = requests.get(f"{BASE}stations/{s['id']}.json", timeout=120).json()
        n = station(doc)
        if n:
            res[s["id"]] = n
        if i % 100 == 0:
            print(f"{i}/{len(index)}", file=sys.stderr)
    doc = {"generated": dt.date.today().isoformat(), "harmonics": NH,
           "formula": "a0 + Σk (a_k·cos(2πk·d/365.25) + b_k·sin(2πk·d/365.25)), d = día del año − 1",
           "source": "AEMET (series de aemet-explorer)", "stations": res}
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    p9 = sum(1 for v in res.values() if v.get("xp") == "1991–2020")
    print(f"{len(res)} estaciones con normal ({p9} con 1991–2020); {OUT.stat().st_size // 1000} KB")


if __name__ == "__main__":
    main()
