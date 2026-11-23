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

Sesgo sistemático (bias(), para las variables que NO son deficientes)
Con la misma comparación diaria se buscan las estaciones que se apartan de sus vecinas
siempre hacia el mismo lado, aunque sea poco (el control en directo solo ve
diferencias de más de 4 °C):
  x, n  ≥ 8 días comparables; mediana de la diferencia ≥ umbral y ≥ 80 % de los días
        hacia ese lado (por ≥ 0,5 °C). Umbrales: máxima +1,5 / −2 °C, mínima +2 / −2,5 °C
        (la mínima varía más con el terreno). Sin corregir por altitud: si la estación
        está a ≥ 100 m de la altitud media de sus vecinas, se dice en el aviso.
  p     ≥ 4 días con lluvia en las vecinas (mediana ≥ 1 mm) que sumen ≥ 10 mm; aviso si
        recoge menos del 60 % o más del 170 % de lo de sus vecinas esos días.
  w     ≥ 5 días de viento (mediana ≥ 20 km/h); aviso si la razón mediana con sus
        vecinas es < 0,5 o > 2 (las de cumbre o muy expuestas soplan bastante más).
  y la serie congelada (casi siempre el mismo valor) de x, n.
Los avisos van al control de calidad (qc.json), con los demás.
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


def _prepare(history_dir, today, ndays):
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
    return {"days": days, "meta": meta, "lat": lat, "lon": lon, "alt": alt, "k": k, "V": V, "D": D}


def _compare(c, f, j):
    """Comparación día a día de la variable f de la estación j con la mediana de sus
    vecinas fiables. Devuelve (vecinas, congelada, días) con días = [(i, v, mediana, bueno)]."""
    lat, lon, alt, V, D = c["lat"], c["lon"], c["alt"], c["V"], c["D"]
    own = V[f][:, j]
    dist = np.hypot((lat - lat[j]) * 111.2, (lon - lon[j]) * 111.2 * c["k"])
    nb = (dist <= RADIUS[f]) & ~D[f]
    nb[j] = False
    if f in "xn" and np.isfinite(alt[j]):
        nb &= np.isfinite(alt) & (np.abs(alt - alt[j]) < MAX_DZ)
    nb = np.where(nb)[0]
    vals = own[np.isfinite(own)]
    frozen = len(vals) >= 5 and len(np.unique(np.round(vals, 1))) <= max(2, len(vals) // 5) \
        and not (f in "pw" and np.all(vals == 0))
    out = []
    for i in range(len(own)):
        v = own[i]
        ref = V[f][i, nb]
        ref = ref[np.isfinite(ref)]
        if not np.isfinite(v) or len(ref) < MIN_NB:
            continue
        med = float(np.median(ref))
        if f in "xn":
            sig = 1.4826 * float(np.median(np.abs(ref - med)))
            ok = abs(v - med) <= max(2.0, 2 * sig)
        elif f == "p":
            if med >= 1:
                ok = 0.5 * med <= v <= 2 * med + 2
            elif v >= 3 and ref.max() < 0.5:
                ok = False
            else:
                continue
        else:
            if med < 20:
                continue
            ok = 0.65 <= v / med <= 1.5
        out.append((i, float(v), med, bool(ok)))
    return nb, bool(frozen), out


def compute(history_dir, today, ndays=DAYS):
    c = _prepare(history_dir, today, ndays)
    days, meta, V, D = c["days"], c["meta"], c["V"], c["D"]
    nd = len(days)
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
            nb, frozen, cmp_ = _compare(c, f, j)
            series = [None] * nd
            devs = []
            for i, v, med, ok in cmp_:
                devs.append(v / med if f == "w" else v - med)
                series[i] = [days[i][5:], _r(v), _r(med), ok]
            good = sum(1 for x in cmp_ if x[3])
            badn = len(cmp_) - good
            n = good + badn
            e.update(nb=len(nb), n=n, good=good, frozen=frozen, series=series)
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


# ------------------------------------------------------------------ sesgo sistemático
QCVAR = {"x": "tx", "n": "tn", "p": "pr", "w": "gust"}    # nombres del control de calidad
T_THR = {("x", 1): 1.5, ("x", -1): 2.0, ("n", 1): 2.0, ("n", -1): 2.5}
T_HINT = {("x", 1): "posible sensor al sol o mal ventilado", ("x", -1): "posible sensor a la sombra o mal calibrado",
          ("n", 1): "posible sensor junto a una pared o en zona urbana", ("n", -1): "puede ser una hondonada fría o un sensor mal calibrado"}
T_NAME = {"x": "La máxima", "n": "La mínima"}


def _f(x, d=1):
    return f"{x:.{d}f}".replace(".", ",")


def _ignored(notes):
    import re
    m = re.search(r"qc-ignore=([\w,]+)", notes or "")
    return set(m.group(1).split(",")) if m else set()


def bias(history_dir, today, ndays=DAYS):
    """{id: [aviso]} con los avisos de sesgo sistemático, en el formato de qc.json."""
    c = _prepare(history_dir, today, ndays)
    days, meta, D, alt = c["days"], c["meta"], c["D"], c["alt"]
    span = f"del {date.fromisoformat(days[0]).day}/{date.fromisoformat(days[0]).month} al " \
           f"{date.fromisoformat(days[-1]).day}/{date.fromisoformat(days[-1]).month}"
    out = {}
    for j, s in enumerate(meta):
        ign = _ignored(s.get("notes"))
        for f in LIMITS:
            if D[f][j] or QCVAR[f] in ign:
                continue
            nb, frozen, cmp_ = _compare(c, f, j)
            if len(nb) < MIN_NB or not cmp_:
                continue
            flag = None
            if f in "xn":
                if len(cmp_) < 8:
                    continue
                if frozen:
                    v = [x[1] for x in cmp_]
                    flag = (f"{QCVAR[f]}_frozen", f"{T_NAME[f]} apenas cambia en {len(cmp_)} días ({_f(min(v))}–{_f(max(v))} °C) "
                            f"mientras sus vecinas sí: posible sensor bloqueado", None, None, None)
                else:
                    dev = np.array([x[1] - x[2] for x in cmp_])
                    m = float(np.median(dev))
                    sg = 1 if m > 0 else -1
                    same = int(np.sum(dev * sg >= 0.5))
                    if abs(m) >= T_THR[(f, sg)] and same >= 0.8 * len(dev):
                        dz = ""
                        if np.isfinite(alt[j]):
                            za = alt[nb][np.isfinite(alt[nb])]
                            if len(za) and abs(alt[j] - za.mean()) >= 100:
                                d = alt[j] - za.mean()
                                dz = f" (ojo: está {abs(d):.0f} m más {'alta' if d > 0 else 'baja'} que la media de sus vecinas)"
                        flag = (f"{QCVAR[f]}_bias_{'hi' if sg > 0 else 'lo'}",
                                f"{T_NAME[f]} sale de media {_f(abs(m))} °C {'por encima' if sg > 0 else 'por debajo'} de sus vecinas "
                                f"({same} de {len(dev)} días): {T_HINT[(f, sg)]}{dz}",
                                None, None, round(m, 1))
            elif f == "p":
                wet = [x for x in cmp_ if x[2] >= 1]
                sv, sm = sum(x[1] for x in wet), sum(x[2] for x in wet)
                if len(wet) >= 4 and sm >= 10:
                    r = sv / sm
                    if sv == 0:
                        flag = ("pr_bias_lo", f"No ha marcado nada en {len(wet)} días de lluvia en los que sus vecinas "
                                f"recogieron {_f(sm)} mm: pluviómetro atascado o la estación no tiene",
                                0.0, round(sm, 1), 0.0)
                    elif r < 0.6:
                        flag = ("pr_bias_lo", f"Ha recogido el {r * 100:.0f} % de lo de sus vecinas en {len(wet)} días de lluvia "
                                f"({_f(sv)} frente a {_f(sm)} mm): pluviómetro obstruido, desnivelado o resguardado",
                                round(sv, 1), round(sm, 1), round(r, 2))
                    elif r > 1.7:
                        flag = ("pr_bias_hi", f"Ha recogido el {r * 100:.0f} % de lo de sus vecinas en {len(wet)} días de lluvia "
                                f"({_f(sv)} frente a {_f(sm)} mm): posible calibración o acumulados duplicados",
                                round(sv, 1), round(sm, 1), round(r, 2))
            else:
                if len(cmp_) >= 5:
                    r = float(np.median([x[1] / x[2] for x in cmp_]))
                    if r == 0:
                        flag = ("gust_bias_lo", f"Racha 0 en {len(cmp_)} días de viento en sus vecinas: anemómetro parado "
                                f"o la estación no tiene", None, None, 0.0)
                    elif r < 0.5:
                        flag = ("gust_bias_lo", f"Sus rachas se quedan en el {r * 100:.0f} % de las de sus vecinas en {len(cmp_)} "
                                f"días de viento: anemómetro resguardado o frenado", None, None, round(r, 2))
                    elif r > 2.0:
                        flag = ("gust_bias_hi", f"Sus rachas son {_f(r)} veces las de sus vecinas en {len(cmp_)} días de viento",
                                None, None, round(r, 2))
            if flag:
                code, msg, value, ref, dev = flag
                out.setdefault(s["id"], []).append({
                    "code": code, "var": QCVAR[f], "qcol": QCOL[f], "msg": msg, "value": value, "ref": ref, "dev": dev,
                    "daily": True, "n": len(cmp_), "meta": f"Últimos {ndays} días cerrados ({span})"})
    return out


if __name__ == "__main__":
    import argparse, collections
    ap = argparse.ArgumentParser()
    ap.add_argument("--history-dir", default=Path(__file__).resolve().parents[2] / "history")
    ap.add_argument("--today", default=date.today().isoformat())
    ap.add_argument("--bias", action="store_true", help="sesgo sistemático de las no deficientes")
    a = ap.parse_args()
    if a.bias:
        b = bias(a.history_dir, a.today)
        print(collections.Counter(x["code"] for v in b.values() for x in v))
        st = {s["id"]: s for s in load_stations()}
        for sid, v in b.items():
            for x in v:
                print(sid, st[sid]["name"], "|", x["msg"])
        raise SystemExit
    doc = compute(a.history_dir, a.today)
    c = collections.Counter((e["var"], e["verdict"]) for st in doc["stations"].values() for e in st["vars"])
    for k_ in sorted(c):
        print(k_, c[k_])
    for sid, st in doc["stations"].items():
        for e in st["vars"]:
            if e["verdict"] == "ok":
                print("OK", sid, st["name"], e["var"], f"{e['good']}/{e['n']}", "sesgo", e.get("bias"))
