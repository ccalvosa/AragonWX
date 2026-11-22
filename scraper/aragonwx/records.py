"""
Récords diarios de cada estación a partir de history/AAAA-MM.json.

Para cada estación, en tres ámbitos (absolutos, del mes en curso y de este día del
calendario): máxima más alta y más baja, mínima más alta y más baja, día más
lluvioso y racha más fuerte, cada uno con su fecha, más el primer día con datos y
el número de días. Lo calcula el bucle una vez al día (records.json en la
rama data). AEMET no está aquí: la web saca sus récords de su serie completa en
aemet-explorer.

Un récord es justo el valor más extremo, así que cualquier error suelto de una
estación de aficionados acabaría siéndolo. Antes de buscarlos se descartan:
  - valores fuera de límites físicos y mínimas mayores que la máxima del día;
  - valores que se apartan mucho de la mediana de las vecinas ese mismo día
    (≤ 25 km, altitud parecida, sin corregir por altitud), y lluvias o rachas muy
    altas en estaciones sin vecinas que las confirmen;
  - las variables marcadas como «Deficiente» en config/stations.csv.
"""

import json
from pathlib import Path

import numpy as np

from .common import load_stations

KEYS = {  # nombre: (campo, ¿máximo?)
    "x_hi": ("x", True), "x_lo": ("x", False),
    "n_hi": ("n", True), "n_lo": ("n", False),
    "p_hi": ("p", True), "w_hi": ("w", True),
}
LIMITS = {"x": (-25, 47), "n": (-28, 33), "p": (0, 250), "w": (0, 170)}
ALONE = {"p": 150, "w": 130}   # sin vecinas que lo confirmen, se descarta por encima de esto
QCOL = {"x": "q_tmax", "n": "q_tmin", "p": "q_prec", "w": "q_wind"}
RADIUS_KM, MAX_DZ, MIN_NB = 25, 300, 3


def _load(history_dir):
    days, cols = [], {}
    for path in sorted(Path(history_dir).glob("????-??.json")):
        try:
            doc = json.load(open(path, encoding="utf-8"))
        except Exception:
            continue
        d0 = len(days)
        days += doc["days"]
        for sid, c in doc["data"].items():
            for f, arr in c.items():
                if f in LIMITS:
                    cols.setdefault(sid, {}).setdefault(f, {}).update(
                        {d0 + k: v for k, v in enumerate(arr) if v is not None})
    return days, cols


def compute(history_dir, today=None):
    days, cols = _load(history_dir)
    if not days:
        return {}
    meta = {s["id"]: s for s in load_stations()}
    ids = [sid for sid in cols if sid in meta]
    nd, ns = len(days), len(ids)
    V = {f: np.full((nd, ns), np.nan, dtype=np.float32) for f in LIMITS}
    for j, sid in enumerate(ids):
        for f, byday in cols[sid].items():
            if meta[sid].get(QCOL[f]) == "Deficiente":
                continue
            idx = np.fromiter(byday.keys(), int)
            V[f][idx, j] = np.fromiter(byday.values(), float)
    # límites físicos y coherencia máxima >= mínima
    for f, (lo, hi) in LIMITS.items():
        V[f][(V[f] < lo) | (V[f] > hi)] = np.nan
    bad = V["n"] > V["x"]
    V["n"][bad] = np.nan
    V["x"][bad] = np.nan
    # vecinas de cada estación
    lat = np.array([meta[s]["lat"] for s in ids]); lon = np.array([meta[s]["lon"] for s in ids])
    alt = np.array([meta[s]["alt"] if meta[s]["alt"] is not None else np.nan for s in ids], dtype=float)
    k = np.cos(np.radians(lat.mean()))
    dist = np.hypot((lat[:, None] - lat[None, :]) * 111.2, (lon[:, None] - lon[None, :]) * 111.2 * k)
    np.fill_diagonal(dist, np.inf)
    nb = np.full((ns, 12), -1)
    for j in range(ns):
        c = np.where(dist[j] <= RADIUS_KM)[0]
        if np.isfinite(alt[j]):
            c = c[np.isfinite(alt[c]) & (np.abs(alt[c] - alt[j]) < MAX_DZ)]
        c = c[np.argsort(dist[j, c])][:12]
        nb[j, :len(c)] = c
    for f in LIMITS:
        X = V[f]
        N = np.where(nb[None, :, :] >= 0, X[:, np.clip(nb, 0, None)], np.nan)   # (días, estaciones, 12)
        cnt = np.sum(~np.isnan(N), axis=2)
        with np.errstate(all="ignore"):
            med = np.nanmedian(N, axis=2)
            mx = np.nanmax(N, axis=2)
        ok = cnt >= MIN_NB
        if f == "x":
            out = ok & (np.abs(X - med) > 7)
        elif f == "n":
            out = ok & (np.abs(X - med) > 8)
        elif f == "w":
            out = ok & (X > 2 * med + 30)
        else:
            out = ok & (X > np.maximum(3 * mx, mx + 25))
        if f in ALONE:
            out |= ~ok & (X > ALONE[f])
        X[out] = np.nan
    # récords: absolutos, del mes en curso y de este día del calendario
    today = today or days[-1]
    scopes = {"abs": np.ones(nd, bool),
              "mon": np.array([d[5:7] == today[5:7] for d in days]),
              "day": np.array([d[5:10] == today[5:10] for d in days])}
    res = {}
    for j, sid in enumerate(ids):
        st = {}
        for sc, mask in scopes.items():
            r, has = {}, np.zeros(nd, bool)
            for name, (f, hi) in KEYS.items():
                col = np.where(mask, V[f][:, j], np.nan)
                m = ~np.isnan(col)
                if not m.any():
                    continue
                has |= m
                i = int(np.nanargmax(col) if hi else np.nanargmin(col))
                r[name] = [round(float(col[i]), 1), days[i]]
            if has.any():
                r["from"] = days[int(np.argmax(has))]
                r["n"] = int(has.sum())
                st[sc] = r
        if st:
            res[sid] = st
    return res
