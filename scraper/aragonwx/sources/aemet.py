"""
AEMET: solo AEMET OpenData (requiere AEMET_API_KEY), para todas las estaciones
automáticas de España.

  observacion/convencional/diezminutal/todas  datos cada 10 min (solo la última hora)
  observacion/convencional/todas              datos horarios (~12 h) con máxima, mínima
                                              y lluvia de cada hora

Igual que en aemet-explorer (scripts/update_obs.py): como el diezminutal solo da
la última hora, se fusiona con la serie anterior para guardar 24 h (obs10.json).
De esa serie salen los valores actuales y los del día local en curso: máxima y
mínima (extremos horarios + diezminutales), racha máxima y lluvia desde
medianoche, y la lluvia de la última hora y de las últimas 24 h.
"""

import json
import os
import re
import time
from datetime import datetime, timedelta, timezone

from ..common import TZ, iso, log, num, session

API = "https://opendata.aemet.es/opendata/api/observacion/convencional/"
URL_10 = API + "diezminutal/todas"
URL_H = API + "todas"
STEP = 600
N10 = 144
NH = 24

# variable: (campo diezminutal, bandera de calidad, campo horario)
V10 = {
    "ta": ("TA", "QTA", "ta"),
    "hr": ("HR", "QHR", "hr"),
    "vv": ("VV10m", "QVV10m", "vv"),
    "vmax": ("VMAX10m", "QVMAX10m", "vmax"),
    "dv": ("DV10m", "QDV10m", "dv"),
    "dmax": ("DMAX10m", "QDMAX10m", "dmax"),
    "pres": ("PRES", "QPRES", "pres"),
    "p10": ("PREC", "QPREC", None),
}
VH = {"tamax": "tamax", "tamin": "tamin", "prec": "prec"}



# ------------------------------------------------------------------ OpenData
def _fetch_rows(s, url, key, tries=3):
    for k in range(tries):
        try:
            r = s.get(url, params={"api_key": key}, timeout=60)
            if r.status_code == 429:
                raise RuntimeError("límite de peticiones")
            r.raise_for_status()
            datos = r.json().get("datos")
            rd = s.get(datos, timeout=90)
            rd.raise_for_status()
            return json.loads(rd.content.decode("latin-1"))
        except Exception as e:
            log(f"  AEMET {url.rsplit('/', 1)[-1]} intento {k + 1}: {e}")
            time.sleep(5 * 2 ** k)
    return None


def _pt(s):
    s = s.replace("Z", "+0000")
    if re.search(r"[+-]\d{2}:\d{2}$", s):
        s = s[:-3] + s[-2:]
    if not re.search(r"[+-]\d{4}$", s):
        s += "+0000"
    return int(datetime.strptime(s, "%Y-%m-%dT%H:%M:%S%z").timestamp())


def _load_prev(prev):
    o10, oh, meta = {}, {}, {}
    if not prev or "t0" not in prev:
        return o10, oh, meta
    t0, h0 = _pt(prev["t0"]), _pt(prev["h0"])
    meta = prev.get("meta", {})
    for sid, arrs in prev.get("data", {}).items():
        for v, arr in arrs.items():
            for k, x in enumerate(arr):
                if x is None:
                    continue
                if v in VH:
                    oh.setdefault((sid, h0 + 3600 * k), {})[v] = x
                else:
                    o10.setdefault((sid, t0 + STEP * k), {})[v] = x
    return o10, oh, meta


def update_obs10(prev, api_key):
    """Devuelve el nuevo obs10 (formato de aemet-explorer, solo Aragón) o None."""
    s = session()
    o10, oh, meta = _load_prev(prev)
    rows10 = _fetch_rows(s, URL_10, api_key)
    time.sleep(2)
    rowsh = _fetch_rows(s, URL_H, api_key)
    if not rows10 and not rowsh:
        log("  AEMET OpenData no responde; se conserva la serie anterior")
        return prev

    for row in rows10 or []:
        sid, f = row.get("IDEMA"), row.get("Fecha")
        if not sid or not f:
            continue
        lon, lat = (row.get("LOC") or {}).get("coordinates", [None, None])
        if sid not in meta and lat is not None:
            meta[sid] = [(row.get("UBI") or sid).strip(), round(lat, 4), round(lon, 4),
                         int(round(float(row["ALT"]))) if row.get("ALT") is not None else None]
        t = _pt(f)
        if t % STEP:
            continue
        slot = o10.setdefault((sid, t), {})
        for v, (field, qf, _) in V10.items():
            x = num(row.get(field))
            q = row.get(qf)
            if x is None or (q is not None and q >= 3):
                continue
            slot[v] = x

    for row in rowsh or []:
        sid, f = row.get("idema"), row.get("fint")
        if not sid or not f:
            continue
        if sid not in meta and row.get("lat") is not None:
            lat, lon = num(row.get("lat"), 4), num(row.get("lon"), 4)
            meta[sid] = [(row.get("ubi") or sid).strip(), lat, lon,
                         int(round(float(row["alt"]))) if row.get("alt") is not None else None]
        t = _pt(f)
        if t % 3600:
            continue
        hs = oh.setdefault((sid, t), {})
        for v, field in VH.items():
            x = num(row.get(field))
            if x is not None:
                hs[v] = x
        s10 = o10.setdefault((sid, t), {})
        for v, (_, _, hfield) in V10.items():
            if hfield and v not in s10:
                x = num(row.get(hfield))
                if x is not None:
                    s10[v] = x

    filled = [t for (sid, t), v in o10.items() if v and sid in meta]
    if not filled:
        return prev
    last = max(filled)
    t0 = last - (N10 - 1) * STEP
    last_h = last - last % 3600
    h0 = last_h - (NH - 1) * 3600
    data = {}
    for (sid, t), vals in o10.items():
        if sid in meta and t0 <= t <= last and vals:
            st = data.setdefault(sid, {})
            for v, x in vals.items():
                st.setdefault(v, [None] * N10)[(t - t0) // STEP] = x
    for (sid, t), vals in oh.items():
        if sid in meta and h0 <= t <= last_h and vals:
            st = data.setdefault(sid, {})
            for v, x in vals.items():
                st.setdefault(v, [None] * NH)[(t - h0) // 3600] = x
    order = list(V10) + list(VH)
    return {"generated": iso(int(time.time())), "t0": iso(t0), "n": N10, "step": STEP, "last": iso(last),
            "h0": iso(h0), "nh": NH, "vars": list(V10), "hvars": list(VH),
            "meta": {k: v for k, v in meta.items() if k in data},
            "data": {sid: {v: st[v] for v in order if v in st} for sid, st in sorted(data.items())}}


def obs_from_obs10(o):
    """Valores actuales y extremos del día local a partir de la serie de 24 h."""
    out = {}
    if not o or "t0" not in o:
        return out
    t0, h0 = _pt(o["t0"]), _pt(o["h0"])
    now = datetime.now(TZ)
    midnight = int(now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp())
    for sid, d in o["data"].items():
        r = {}
        ta = d.get("ta") or []
        last_k = max((k for k, x in enumerate(ta) if x is not None), default=None)
        if last_k is not None:
            r["t"] = t0 + last_k * STEP
            r["ta"] = ta[last_k]
            for v, key, f in (("hr", "hr", 1), ("vv", "ws", 3.6), ("vmax", "wg", 3.6), ("pres", "pres", 1)):
                arr = d.get(v) or []
                if last_k < len(arr) and arr[last_k] is not None:
                    r[key] = round(arr[last_k] * f, 1)
        # extremos desde la medianoche local
        k_mid = max(0, -(-(midnight - t0) // STEP))
        vals = [x for x in ta[k_mid:] if x is not None]
        hk_mid = max(0, -(-(midnight + 3600 - h0) // 3600))   # horas que terminan tras medianoche
        hx = [x for x in (d.get("tamax") or [])[hk_mid:] if x is not None]
        hn = [x for x in (d.get("tamin") or [])[hk_mid:] if x is not None]
        if vals or hx:
            r["tx"] = max(vals + hx)
        if vals or hn:
            r["tn"] = min(vals + hn)
        gusts = [x for x in (d.get("vmax") or [])[k_mid:] if x is not None]
        if gusts:
            r["gust"] = round(max(gusts) * 3.6, 1)
        # lluvia: horas completas del día + diezminutales de la hora en curso
        prec_h = d.get("prec") or []
        pr, covered = 0.0, midnight
        any_p = False
        for k in range(hk_mid, len(prec_h)):
            if prec_h[k] is not None:
                pr += prec_h[k]
                any_p = True
                covered = h0 + k * 3600
        p10 = d.get("p10") or []
        for k in range(len(p10)):
            tk = t0 + k * STEP
            if tk > covered and tk > midnight and p10[k] is not None:
                pr += p10[k]
                any_p = True
        if any_p:
            r["pr"] = round(pr, 1)
        # lluvia de la última hora y de las últimas 24 h
        if p10 and last_k is not None:
            last1 = [x for x in p10[max(0, last_k - 5):last_k + 1] if x is not None]
            if last1:
                r["p1"] = round(sum(last1), 1)
        hp = [x for x in prec_h if x is not None]
        if hp:
            last_full = h0 + (len(prec_h) - 1) * 3600
            tail = [x for k, x in enumerate(p10) if x is not None and t0 + k * STEP > last_full]
            r["p24"] = round(sum(hp) + sum(tail), 1)
        if r:
            out[sid] = r
    return out


def fetch(stations, ctx):
    """Observaciones de todas las estaciones AEMET + actualiza ctx['obs10']."""
    key = os.environ.get("AEMET_API_KEY")
    if not key:
        log("  AEMET_API_KEY no definida: sin datos de AEMET")
        return {}
    new = update_obs10(ctx.get("obs10"), key)
    if not new:
        return {}
    ctx["obs10"] = new
    out = obs_from_obs10(new)
    ids = {s["id"] for s in stations}
    # estaciones que no están en config/stations.csv (resto de España y altas nuevas)
    ctx["aemet_extra"] = {sid: new["meta"][sid] for sid in out if sid not in ids and sid in new["meta"]}
    n10 = sum(1 for d in new["data"].values() if any(x is not None for x in (d.get("ta") or [])[-6:]))
    log(f"  AEMET: {len(out)} estaciones con datos ({n10} con diezminutales en la última hora)")
    return out
