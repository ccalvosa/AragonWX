"""
Control de calidad automático de las estaciones.

En cada pasada se compara cada estación con sus vecinas y se marcan las
sospechosas. No oculta nada: deja sugerencias (qc.json) para que en el editor se
decida si se marca la variable como «Deficiente» o se descarta el aviso.

Pruebas
  ta/tx/tn  «buddy check»: diferencia con la mediana de las vecinas (≤ 20 km, ≤ 12 más
            cercanas y con altitud parecida, |Δz| < 300 m), sin corregir por altitud; aviso si
            supera max(umbral, 3·σ robusta de las vecinas)
  ta        valor congelado: igual durante ≥ 6 h mientras las vecinas cambian ≥ 1,5 °C
  pr        lluvia que solo marca ella, pluviómetro muerto (0 mm con las vecinas mojadas) y
            acumulados desproporcionados
  gust      rachas muy por encima de las vecinas
  hr        humedad imposible (≤ 3 %)

Para no molestar con casos puntuales, un aviso solo se sugiere si se repite al menos
SUGGEST_PASSES pasadas hoy (≈ 1 h) o en ≥ 2 días de la última semana.

Se ignoran las variables ya marcadas como «Deficiente» y las que lleven en las notas
de la estación «qc-ignore=ta,pr,…» (lo que pone el botón «Descartar» del editor).
"""

import re
from datetime import date, timedelta

import numpy as np

MAX_DZ = 300              # m: solo vecinas a una altitud parecida
SUGGEST_PASSES = 6        # pasadas de 10 min con el aviso hoy
KEEP_DAYS = 7
STUCK_N = 36              # 6 h de pasadas

# variable -> posición de su bandera de calidad (q_tmax, q_tmin, q_prec, q_wind)
QPOS = {"ta": 0, "tx": 0, "tn": 1, "pr": 2, "gust": 3, "hr": None}
QCOL = {0: "q_tmax", 1: "q_tmin", 2: "q_prec", 3: "q_wind"}
TEMP_THR = {"ta": 4.0, "tx": 4.0, "tn": 4.5}
NAMES = {"ta": "La temperatura", "tx": "La máxima", "tn": "La mínima"}


def _ignored(notes):
    m = re.search(r"qc-ignore=([\w,]+)", notes or "")
    return set(m.group(1).split(",")) if m else set()


def _f(x):
    return f"{x:.1f}".replace(".", ",")


def run(rows, state, now, today):
    """rows: [{id, src, name, lat, lon, alt, q, notes, st, ta, tx, tn, pr, gust, hr}]
    Devuelve (documento qc.json, {id: [códigos sugeridos]})."""
    ok = [r for r in rows if r.get("st") == "ok" and r.get("lat") is not None]
    n = len(ok)
    if n < 5:
        return {"n": 0, "stations": {}}, {}
    lat = np.array([r["lat"] for r in ok]); lon = np.array([r["lon"] for r in ok])
    alt = np.array([r["alt"] if r.get("alt") is not None else np.nan for r in ok], dtype=float)
    k = np.cos(np.radians(lat.mean()))
    dist = np.hypot((lat[:, None] - lat[None, :]) * 111.2, (lon[:, None] - lon[None, :]) * 111.2 * k)
    np.fill_diagonal(dist, np.inf)
    ign = [_ignored(r.get("notes")) for r in ok]

    def usable(r, i, var):
        q = QPOS[var]
        return (r.get(var) is not None and var not in ign[i]
                and not (q is not None and (r.get("q") or "----")[q] == "D"))

    def vals(var):
        return np.array([r[var] if usable(r, i, var) else np.nan for i, r in enumerate(ok)], dtype=float)

    flags = {}   # id -> [(code, var, msg, value, ref, dev)]

    def add(i, code, var, msg, value=None, ref=None, dev=None):
        flags.setdefault(ok[i]["id"], []).append((code, var, msg, value, ref, dev))

    # ---------- temperatura: comparación directa con las vecinas de altitud parecida
    for var, thr in TEMP_THR.items():
        v = vals(var)
        for i in range(n):
            if np.isnan(v[i]):
                continue
            idx = np.where((dist[i] <= 20) & ~np.isnan(v))[0]
            if np.isfinite(alt[i]):
                idx = idx[np.isfinite(alt[idx]) & (np.abs(alt[idx] - alt[i]) < MAX_DZ)]
            idx = idx[np.argsort(dist[i, idx])][:12]
            if len(idx) < 4:
                continue
            nb = v[idx]
            ref = float(np.median(nb))
            sig = 1.4826 * float(np.median(np.abs(nb - ref)))
            dev = v[i] - ref
            if abs(dev) > max(thr, 3 * sig):
                hi = dev > 0
                hint = ": posible sensor al sol o mal ventilado" if var == "tx" and hi else ""
                add(i, f"{var}_{'hi' if hi else 'lo'}", var,
                    f"{NAMES[var]} ({_f(v[i])} °C) está {_f(abs(dev))} °C por {'encima' if hi else 'debajo'} "
                    f"de la mediana de sus vecinas ({_f(ref)} °C){hint}", float(v[i]), round(ref, 1), round(float(dev), 1))

    # ---------- temperatura congelada (necesita el histórico de las pasadas)
    hist = state.setdefault("qc_ta", {})
    vta = vals("ta")
    for i, r in enumerate(ok):
        if np.isnan(vta[i]):
            continue
        idx = np.where((dist[i] <= 20) & ~np.isnan(vta))[0]
        ref = float(np.median(vta[idx])) if len(idx) >= 3 else None
        h = hist.setdefault(r["id"], [])
        h.append([now, float(vta[i]), ref])
        del h[:-STUCK_N]
        if len(h) >= STUCK_N and h[-1][0] - h[0][0] >= 5.5 * 3600:
            own = [x[1] for x in h]
            refs = [x[2] for x in h if x[2] is not None]
            if max(own) == min(own) and refs and max(refs) - min(refs) >= 1.5:
                add(i, "ta_stuck", "ta", f"La temperatura lleva más de 6 h congelada en {_f(own[-1])} °C "
                    f"mientras sus vecinas varían {_f(max(refs) - min(refs))} °C", own[-1])
    ids_ok = {r["id"] for r in ok}
    for k_ in [k_ for k_ in hist if k_ not in ids_ok]:
        del hist[k_]

    # ---------- precipitación del día
    vp = vals("pr")
    for i in range(n):
        if np.isnan(vp[i]):
            continue
        idx = np.where((dist[i] <= 15) & ~np.isnan(vp))[0]
        if len(idx) < 4:
            continue
        nb = vp[idx]
        med, mx = float(np.median(nb)), float(nb.max())
        if vp[i] >= 3 and med == 0 and mx < 0.5:
            add(i, "pr_alone", "pr", f"Marca {_f(vp[i])} mm mientras sus vecinas no recogen nada", float(vp[i]), 0.0)
        elif vp[i] == 0 and med >= 5 and np.mean(nb >= 2) >= 0.75:
            add(i, "pr_dead", "pr", f"0 mm mientras sus vecinas recogen {_f(med)} mm: pluviómetro posiblemente atascado",
                0.0, round(med, 1))
        elif vp[i] >= 20 and vp[i] > 3 * mx + 10:
            add(i, "pr_hi", "pr", f"{_f(vp[i])} mm, más del triple que cualquier vecina (máx. {_f(mx)} mm)",
                float(vp[i]), round(mx, 1))

    # ---------- racha máxima
    vg = vals("gust")
    for i in range(n):
        if np.isnan(vg[i]) or vg[i] < 70:
            continue
        idx = np.where((dist[i] <= 25) & ~np.isnan(vg))[0]
        if len(idx) < 4:
            continue
        med = float(np.median(vg[idx]))
        if vg[i] > 2.5 * med + 25:
            add(i, "gust_hi", "gust", f"Racha de {vg[i]:.0f} km/h frente a {med:.0f} km/h de mediana en sus vecinas",
                float(vg[i]), round(med))

    # ---------- humedad imposible
    vh = vals("hr")
    for i in range(n):
        if not np.isnan(vh[i]) and vh[i] <= 3:
            add(i, "hr_broken", "hr", f"Humedad del {vh[i]:.0f} %: sensor averiado", float(vh[i]))

    # ---------- persistencia y sugerencias
    mem = state.setdefault("qc_flags", {})
    for sid, fl in flags.items():
        for code, *_ in fl:
            e = mem.setdefault(sid, {}).setdefault(code, {"first": now, "days": {}})
            e["last"] = now
            e["days"][today] = e["days"].get(today, 0) + 1
    t0 = date.fromisoformat(today)
    cutoff = {(t0 - timedelta(days=k)).isoformat() for k in range(KEEP_DAYS)}
    for sid in list(mem):
        for code in list(mem[sid]):
            e = mem[sid][code]
            e["days"] = {d: c for d, c in e["days"].items() if d in cutoff}
            if not e["days"] or now - e.get("last", 0) > KEEP_DAYS * 86400:
                del mem[sid][code]
        if not mem[sid]:
            del mem[sid]

    byid = {r["id"]: r for r in ok}
    doc, public = {}, {}
    for sid, fl in flags.items():
        out = []
        for code, var, msg, value, ref, dev in fl:
            e = mem[sid][code]
            today_n, ndays = e["days"].get(today, 0), len(e["days"])
            if today_n < SUGGEST_PASSES and ndays < 2:
                continue
            q = QPOS[var]
            out.append({"code": code, "var": var, "qcol": QCOL.get(q), "msg": msg, "value": value, "ref": ref,
                        "dev": dev, "today": today_n, "days": ndays, "first": e["first"]})
        if out:
            r = byid[sid]
            doc[sid] = {"name": r["name"], "src": r["src"], "flags": out}
            public[sid] = [f["code"] for f in out]
    return {"n": len(doc), "stations": doc}, public
