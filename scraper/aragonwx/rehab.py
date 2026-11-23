"""
Revisión de las variables marcadas como «Deficiente» en config/stations.csv.

Una estación se marca deficiente porque daba datos malos, pero a veces el dueño la
arregla (la cambia de sitio, limpia el pluviómetro, cambia el sensor). Aquí se
mira si en los últimos días cerrados (history/AAAA-MM.json) vuelve a coincidir con
sus vecinas, para que en el editor se pueda quitar la marca con conocimiento.

Para cada variable deficiente y cada día se compara con la mediana de las vecinas
fiables (las no deficientes) ese mismo día:
  x, n  máxima y mínima: ≤ 20 km, |Δz| < 300 m, ≥ 3 vecinas (sin corregir por altitud).
        Día bueno si |diferencia| ≤ max(2 °C, 2·σ robusta de las vecinas).
  p     lluvia: ≤ 15 km, ≥ 3 vecinas. Solo cuentan los días informativos: con lluvia
        en las vecinas (mediana ≥ 1 mm), bueno si recoge entre la mitad y el doble + 2 mm;
        o en los que marca ≥ 3 mm con las vecinas secas (malo).
  w     racha: ≤ 25 km, ≥ 3 vecinas, días con mediana ≥ 20 km/h; bueno si la razón
        con la mediana está entre 0,65 y 1,5.
Además se descarta la serie congelada (casi siempre el mismo valor).

Veredicto
  «recuperada»  suficientes días comparables, casi todos buenos y sin sesgo:
                x/n ≥ 8 días, ≥ 90 % buenos, |sesgo| ≤ 0,7 °C y ningún día más de 2,5 °C
                por encima (máxima) o por debajo (mínima); p ≥ 3 días con lluvia y
                ninguno malo; w ≥ 4 días, ≥ 85 % buenos.
  «sigue mal»   muchos días malos (o congelada).
  «sin datos» / «sin vecinas» / «pocos días»   no se puede decir aún.
Ojo con la máxima en invierno: un sensor al sol se pasa poco con el sol bajo, así que
una máxima que fallaba en verano puede parecer bien en noviembre. Es una sugerencia.
Lo calcula el bucle una vez al día (rehab.json en la rama data).
"""

import json
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from .common import load_stations

QCOL = {"x": "q_tmax", "n": "q_tmin", "p": "q_prec", "w": "q_wind"}
LIMITS = {"x": (-25, 47), "n": (-28, 33), "p": (0, 250), "w": (0, 170)}
RADIUS = {"x": 20, "n": 20, "p": 15, "w": 25}
MAX_DZ, MIN_NB, DAYS = 300, 3, 14


def _load(history_dir, days):
    """{sid: {campo: [valor por día]}} para la lista de días pedida."""
    want = {d: i for i, d in enumerate(days)}
    out = {}
    for mon in sorted({d[:7] for d in days}):
        p = Path(history_dir) / f"{mon}.json"
        if not p.exists():
            continue
        try:
            doc = json.load(open(p, encoding="utf-8"))
        except Exception:
            continue
        for k, d in enumerate(doc["days"]):
            if d not in want:
                continue
            i = want[d]
            for sid, c in doc["data"].items():
                for f, arr in c.items():
                    if f in LIMITS and k < len(arr) and arr[k] is not None:
                        out.setdefault(sid, {}).setdefault(f, [None] * len(days))[i] = arr[k]
    return out


def _r(x, d=1):
    return None if x is None or not np.isfinite(x) else round(float(x), d)


def compute(history_dir, today, ndays=DAYS):
    t0 = date.fromisoformat(today)
    days = [(t0 - timedelta(days=k)).isoformat() for k in range(ndays, 0, -1)]   # sin hoy (no está cerrado)
    hist = _load(history_dir, days)
    meta = [s for s in load_stations() if s.get("lat") is not None]
    ids = [s["id"] for s in meta]
    ns, nd = len(ids), len(days)
    lat = np.array([s["lat"] for s in meta]); lon = np.array([s["lon"] for s in meta])
    alt = np.array([s["alt"] if s["alt"] is not None else np.nan for s in meta], dtype=float)
    k = np.cos(np.radians(lat.mean()))
    V, D = {}, {}
    for f, (lo, hi) in LIMITS.items():
        a = np.full((nd, ns), np.nan)
        for j, sid in enumerate(ids):
            arr = hist.get(sid, {}).get(f)
            if arr:
                a[:, j] = [np.nan if v is None else v for v in arr]
        a[(a < lo) | (a > hi)] = np.nan
        V[f] = a
        D[f] = np.array([s.get(QCOL[f]) == "Deficiente" for s in meta])
    bad = V["n"] > V["x"]
    V["n"][bad] = np.nan
    V["x"][bad] = np.nan

    res = {}
    for j, s in enumerate(meta):
        for f in LIMITS:
            if not D[f][j]:
                continue
            own = V[f][:, j]
            e = {"var": f, "qcol": QCOL[f], "have": int(np.isfinite(own).sum())}
            res.setdefault(s["id"], {"name": s["name"], "src": s["source"], "vars": []})["vars"].append(e)
            if not e["have"]:
                e["verdict"] = "nodata"
                continue
            dist = np.hypot((lat - lat[j]) * 111.2, (lon - lon[j]) * 111.2 * k)
            nb = (dist <= RADIUS[f]) & ~D[f]
            nb[j] = False
            if f in "xn" and np.isfinite(alt[j]):
                nb &= np.isfinite(alt) & (np.abs(alt - alt[j]) < MAX_DZ)
            nb = np.where(nb)[0]
            vals = own[np.isfinite(own)]
            frozen = len(vals) >= 5 and len(np.unique(np.round(vals, 1))) <= max(2, len(vals) // 5) \
                and not (f in "pw" and np.all(vals == 0))
            good = badn = 0
            devs, series = [], []
            for i in range(nd):
                v = own[i]
                ref = V[f][i, nb]
                ref = ref[np.isfinite(ref)]
                if not np.isfinite(v) or len(ref) < MIN_NB:
                    series.append(None)
                    continue
                med = float(np.median(ref))
                if f in "xn":
                    sig = 1.4826 * float(np.median(np.abs(ref - med)))
                    ok = abs(v - med) <= max(2.0, 2 * sig)
                    devs.append(v - med)
                elif f == "p":
                    if med >= 1:
                        ok = 0.5 * med <= v <= 2 * med + 2
                    elif v >= 3 and ref.max() < 0.5:
                        ok = False
                    else:
                        series.append(None)
                        continue
                    devs.append(v - med)
                else:
                    if med < 20:
                        series.append(None)
                        continue
                    ok = 0.65 <= v / med <= 1.5
                    devs.append(v / med)
                ok = bool(ok)
                good += ok; badn += not ok
                series.append([days[i][5:], _r(v), _r(med), bool(ok)])
            n = good + badn
            e.update(nb=len(nb), n=n, good=good, frozen=bool(frozen), series=series)
            if devs:
                e["bias"] = _r(np.mean(devs), 2 if f == "w" else 1)
                e["mad"] = _r(np.mean(np.abs(devs)), 1) if f != "w" else None
            need = {"x": 8, "n": 8, "p": 3, "w": 4}[f]
            share = good / n if n else 0
            if frozen:
                v = "bad"
            elif len(nb) < MIN_NB:
                v = "nonb"
            elif n < need:
                v = "bad" if badn >= 3 else "few"
            elif f in "xn":
                e["peak"] = _r(max(devs) if f == "x" else min(devs))   # el peor día hacia el lado típico del fallo
                v = ("ok" if share >= 0.9 and abs(e["bias"]) <= 0.7 and abs(e["peak"]) <= 2.5
                     else "bad" if share < 0.7 else "mixed")
            elif f == "p":
                v = "ok" if badn == 0 else "bad" if share < 0.67 else "mixed"
            else:
                v = "ok" if share >= 0.85 else "bad" if share < 0.6 else "mixed"
            e["verdict"] = v
    return {"days": [days[0], days[-1]], "stations": res,
            "n_ok": sum(1 for st in res.values() for e in st["vars"] if e["verdict"] == "ok")}


if __name__ == "__main__":
    import argparse, collections
    ap = argparse.ArgumentParser()
    ap.add_argument("--history-dir", default=Path(__file__).resolve().parents[2] / "history")
    ap.add_argument("--today", default=date.today().isoformat())
    a = ap.parse_args()
    doc = compute(a.history_dir, a.today)
    c = collections.Counter((e["var"], e["verdict"]) for st in doc["stations"].values() for e in st["vars"])
    for k_ in sorted(c):
        print(k_, c[k_])
    for sid, st in doc["stations"].items():
        for e in st["vars"]:
            if e["verdict"] == "ok":
                print("OK", sid, st["name"], e["var"], f"{e['good']}/{e['n']}", "sesgo", e.get("bias"))
