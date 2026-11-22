#!/usr/bin/env python3
"""
Una pasada completa: descarga todas las fuentes, valida, calcula y escribe los
ficheros que lee la web.

    python -m aragonwx.build --out out --history-dir history

Entrada:  config/*.csv  ·  out/state.json, out/obs10.json, out/hydro.json (pasada anterior)
Salida (out/):
  now.json      estaciones con los valores actuales y del día
  obs10.json    serie de 24 h de AEMET cada 10 min (solo Aragón)
  hydro.json    embalses y aforos con su serie de 72 h
  webcams.json  webcams propias + DGT
  state.json    estado interno entre pasadas (lluvias, extremos, claves…)
y, al cambiar de día, cierra el día anterior en history/AAAA-MM.json.
"""

import argparse
import calendar
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path

from .common import (CURRENT_MAX_AGE, OFFLINE_AFTER, ROOT, TZ, dump_json, in_aragon, iso, load_json,
                     load_stations, log, read_csv)
from .sources import aemet, avisos, dgt, pws, saih, wu

FETCHERS = {
    "AEMET": aemet.fetch,
    "SAIH": saih.fetch,
    "WU": wu.fetch,
    "WC": pws.weathercloud,
    "MC": pws.meteoclimatic,
    "IBERICAM": pws.ibericam,
    "HOLFUY": pws.holfuy,
    "AVAMET": pws.avamet,
}

COLS = ["id", "src", "name", "prov", "lat", "lon", "alt", "link", "q", "tzs", "model", "notes", "ar",
        "st", "t", "ta", "tx", "tn", "pr", "p1", "p24", "gust", "wg", "ws", "hr", "pres", "qc"]
QMAP = {"Contrastada": "C", "Deficiente": "D"}
PROV = {"Huesca": "H", "Zaragoza": "Z", "Teruel": "T"}

LIMITS = {"ta": (-35, 50), "tx": (-35, 50), "tn": (-35, 50), "pr": (0, 600), "p1": (0, 200), "p24": (0, 800),
          "gust": (0, 250), "wg": (0, 250), "ws": (0, 200), "hr": (0, 100), "pres": (500, 1100)}

# AEMET publica con retraso: su dato horario puede tener ~80 min y sigue siendo el último
CURRENT_AGE_BY_SOURCE = {"AEMET": 5400}

AEMET_LINK = "https://www.aemet.es/es/eltiempo/observacion/ultimosdatos?k=&l={}&w=1&datos=img"
SMALL = {"de", "del", "la", "las", "el", "los", "y", "en"}


def nice_name(s):
    """'ZARAGOZA  AEROPUERTO' -> 'Zaragoza Aeropuerto'."""
    words = " ".join(str(s).split()).lower().split(" ")
    return " ".join(w if (i and w in SMALL) else w[:1].upper() + w[1:] for i, w in enumerate(words))


HYDRO_EVERY = 1800
HYDRO_KEEP = 72 * 3600


def clean(o):
    """Quita valores imposibles y la temperatura actual incoherente con máx/mín."""
    for k, (lo, hi) in LIMITS.items():
        v = o.get(k)
        if v is not None and not (lo <= v <= hi):
            o.pop(k, None)
    if o.get("tx") is not None and o.get("tn") is not None and o["tx"] < o["tn"]:
        o.pop("tx"), o.pop("tn")
    ta = o.get("ta")
    if ta is not None and o.get("tx") is not None and o.get("tn") is not None:
        if ta > o["tx"] + 0.5 or ta < o["tn"] - 0.5:
            o.pop("ta")
    return o


def process(st, o, state, now, today):
    """Aplica antigüedad, extremos acumulados y lluvias derivadas a una observación."""
    sid = st["id"]
    o = dict(o or {})
    if o.pop("off", False) and not any(k in o for k in ("ta", "tx", "pr")):
        return {"st": "off"}
    t = o.get("t")
    age = now - t if t else 0
    if t and age > OFFLINE_AFTER:
        return {"st": "off", "t": t}
    if t and age > CURRENT_AGE_BY_SOURCE.get(st["source"], CURRENT_MAX_AGE):
        for k in ("ta", "hr", "ws", "wg", "pres"):
            o.pop(k, None)
    if t and t < int(datetime.now(TZ).replace(hour=0, minute=0, second=0).timestamp()):
        # último dato de ayer: los valores "del día" no son de hoy
        for k in ("tx", "tn", "pr", "gust"):
            o.pop(k, None)
    clean(o)

    # extremos acumulados con nuestras propias lecturas (fuentes sin máx/mín, p. ej. SAIH)
    ext = state.setdefault("ext", {})
    e = ext.get(sid)
    if not e or e.get("day") != today:
        e = ext[sid] = {"day": today}
    if o.get("ta") is not None:
        e["tx"] = max(e.get("tx", o["ta"]), o["ta"])
        e["tn"] = min(e.get("tn", o["ta"]), o["ta"])
    if o.get("wg") is not None:
        e["gust"] = max(e.get("gust", o["wg"]), o["wg"])
    for k in ("tx", "tn", "gust"):
        if o.get(k) is None and e.get(k) is not None:
            o[k] = e[k]
            o.setdefault("derived", []).append(k)

    # lluvia del día: estaciones que reinician el contador a otra hora (tz_shift)
    pr_raw = o.get("pr")
    if st["tz_shift"] and pr_raw is not None:
        acc = state.setdefault("pacc", {})
        a = acc.get(sid)
        if a is None:   # primera lectura: pasadas las 2:00 el contador ya se ha reiniciado hoy
            a = acc[sid] = {"day": today, "acc": pr_raw if datetime.now(TZ).hour >= 2 else 0.0, "raw": pr_raw}
        if a["day"] != today:
            a["day"], a["acc"] = today, 0.0
        inc = pr_raw - a["raw"] if pr_raw >= a["raw"] - 0.05 else pr_raw   # caída = reinicio del contador
        a["acc"] = round(a["acc"] + max(inc, 0.0), 1)
        a["raw"] = pr_raw
        o["pr"] = a["acc"]

    # lluvia en 1 h y 24 h a partir de los incrementos entre pasadas (si la fuente no la da)
    if o.get("pr") is not None:
        hist = state.setdefault("pinc", {})
        h = hist.get(sid)
        if h is None:   # primera lectura: solo fija la referencia
            h = hist[sid] = {"day": today, "last": o["pr"], "inc": [], "since": now}
        else:
            inc = o["pr"] if h["day"] != today else o["pr"] - h["last"]
            if inc > 0.05:
                h["inc"].append([now, round(inc, 1)])
            h["day"], h["last"] = today, o["pr"]
            h["inc"] = [x for x in h["inc"] if x[0] > now - 86400]
        if o.get("p1") is None and h["since"] <= now - 3300:
            o["p1"] = round(sum(x[1] for x in h["inc"] if x[0] > now - 3600), 1)
        if o.get("p24") is None and h["since"] <= now - 86100:
            o["p24"] = round(sum(x[1] for x in h["inc"]), 1)
    o["st"] = "ok"
    return o


def update_health(state, stats, results, now, ctx):
    """Estado de cada red: ok / degradada (menos de la mitad de lo habitual) / caída (ninguna)."""
    hs = state.setdefault("health", {})
    out = {}
    for src, st in stats.items():
        if src not in results:      # red no descargada (inactiva o --only)
            continue
        n, ok = st.get("n", 0) - st.get("na", 0), st.get("ok", 0)
        h = hs.setdefault(src, {"series": []})
        h["series"] = [x for x in h["series"] if x[0] > now - 86400] + [[now, ok]]
        past = sorted(x[1] for x in h["series"][:-1] if x[1] > 0)
        typical = past[len(past) // 2] if past else ok
        status = "down" if n and ok == 0 else "degraded" if typical and ok < 0.5 * typical else "ok"
        if status != h.get("status"):
            h["since"] = now
        h["status"] = status
        if status == "ok":
            h["last_ok"] = now
        out[src] = {"n": n, "ok": ok, "typical": typical, "status": status, "since": h.get("since"),
                    "last_ok": h.get("last_ok"), "series": [x[1] for x in h["series"]],
                    "t0": h["series"][0][0], "via": ctx.get(f"{src.lower()}_via")}
    return out


def close_day(day, snapshot, history_dir):
    """Escribe los valores finales de `day` en history/AAAA-MM.json."""
    mon = day[:7]
    path = Path(history_dir) / f"{mon}.json"
    y, m = map(int, mon.split("-"))
    days = [f"{mon}-{d:02d}" for d in range(1, calendar.monthrange(y, m)[1] + 1)]
    doc = load_json(path) or {"month": mon, "days": days, "vars": ["x", "n", "p", "w"], "data": {}}
    k = days.index(day)
    n = 0
    for sid, v in snapshot.items():
        row = doc["data"].setdefault(sid, {})
        for key, src in (("x", "tx"), ("n", "tn"), ("p", "pr"), ("w", "gust")):
            if v.get(src) is None:
                continue
            row.setdefault(key, [None] * len(days))[k] = v[src]
            n += 1
    dump_json(path, doc)
    log(f"  histórico: cerrado {day} ({len(snapshot)} estaciones, {n} valores) -> {path}")
    return path


def update_hydro(prev, reservoirs, gauges, res_now, gau_now, now, seed=None):
    out = {"generated": iso(now), "reservoirs": {}, "gauges": {}}
    prev = prev or {}
    for kind, cfg, cur, fields in (("reservoirs", reservoirs, res_now, ("vol", "pct")),
                                   ("gauges", gauges, gau_now, ("q", "h"))):
        old = (prev.get(kind) or {})
        for c in cfg:
            sid = c["id"]
            p = old.get(sid) or {}
            series = p.get("s")
            if series is None and seed:
                series = seed.get(kind, {}).get(sid, [])
            series = [x for x in (series or []) if x[0] > now - HYDRO_KEEP]
            v = cur.get(sid)
            if v:
                if not series or now - series[-1][0] >= HYDRO_EVERY - 60:
                    series.append([now, v.get(fields[0]), v.get(fields[1])])
                rec = dict(v)
            else:
                rec = {k: p.get(k) for k in (*fields, "lvl", "t") if p.get(k) is not None}
                rec["stale"] = True
            # tendencia: frente al dato de hace ~3 h (aforos) o ~24 h (embalses)
            lag = 3 * 3600 if kind == "gauges" else 24 * 3600
            ref = [x for x in series if x[0] <= now - lag + HYDRO_EVERY and x[1] is not None]
            curv = rec.get(fields[0])
            if ref and curv is not None:
                d = curv - ref[-1][1]
                eps = 0.01 if kind == "reservoirs" else max(0.02 * abs(ref[-1][1]), 0.05)
                rec["tr"] = 1 if d > eps else -1 if d < -eps else 0
                rec["dv"] = round(d, 3)
            rec["s"] = series
            out[kind][sid] = rec
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=ROOT / "out")
    ap.add_argument("--history-dir", type=Path, default=ROOT / "history")
    ap.add_argument("--only", default="", help="fuentes separadas por comas (pruebas)")
    a = ap.parse_args()
    t_start = time.time()
    out = a.out
    now = int(time.time())
    today = datetime.now(TZ).strftime("%Y-%m-%d")

    state = load_json(out / "state.json", {}) or {}
    ctx = {"now": now, "state": state, "obs10": load_json(out / "obs10.json")}
    stations = load_stations()
    only = {x.strip().upper() for x in a.only.split(",") if x.strip()}
    groups = {}
    for st in stations:
        if st["active"] and st["source"] in FETCHERS and (not only or st["source"] in only):
            groups.setdefault(st["source"], []).append(st)

    results, timings = {}, {}

    def run(src):
        t0 = time.time()
        try:
            r = FETCHERS[src](groups[src], ctx)
        except Exception as e:
            log(f"  {src}: ERROR {type(e).__name__}: {e}")
            r = {}
        timings[src] = round(time.time() - t0, 1)
        return src, r

    with ThreadPoolExecutor(max_workers=len(groups) or 1) as ex:
        for src, r in ex.map(run, list(groups)):
            results[src] = r

    # ---- cierre del día anterior (primera pasada tras medianoche)
    closed = []
    prev_day = state.get("day")
    if prev_day and prev_day != today and state.get("today"):
        closed.append(str(close_day(prev_day, state["today"], a.history_dir)))
        state["today"] = {}
    state["day"] = today
    snap = state.setdefault("today", {})

    # ---- estaciones
    rows, stats = [], {}
    extra = ctx.get("aemet_extra") or {}
    for sid, m in extra.items():   # AEMET del resto de España (y altas nuevas en Aragón)
        stations.append({"id": sid, "source": "AEMET", "name": nice_name(m[0]), "prov": "", "lat": m[1],
                         "lon": m[2], "alt": m[3], "link": AEMET_LINK.format(sid), "model": "", "notes": "",
                         "q_tmax": "", "q_tmin": "", "q_prec": "", "q_wind": "", "tz_shift": False,
                         "kind": "", "active": True, "extra": True})
    for st in stations:
        src = st["source"]
        q = "".join(QMAP.get(st.get(k, ""), "-") for k in ("q_tmax", "q_tmin", "q_prec", "q_wind"))
        base = [st["id"], src, st["name"], PROV.get(st["prov"], ""), round(st["lat"], 5), round(st["lon"], 5),
                st["alt"], st["link"] or None, q, 1 if st["tz_shift"] else 0, st.get("model") or None,
                st.get("notes") or None,
                1 if not st.get("extra") or in_aragon(st["lat"], st["lon"], margin=0.3) else 0]
        if not st["active"] or (only and src not in only):
            o = {"st": "na"}
        elif src in results and st["id"] in results[src]:
            o = process(st, results[src][st["id"]], state, now, today)
        else:
            o = {"st": "off"}
        s = stats.setdefault(src, {"n": 0, "ok": 0, "off": 0})
        s["n"] += 1
        s[o["st"]] = s.get(o["st"], 0) + 1
        if o["st"] == "ok" and src != "AEMET":   # AEMET: su histórico oficial está en aemet-explorer
            daily = {k: o[k] for k in ("tx", "tn", "pr", "gust") if o.get(k) is not None}
            if daily:
                snap[st["id"]] = daily
        rows.append(base + [o.get("st"), o.get("t")] + [o.get(k) for k in COLS[15:]])
    # limpia estados de estaciones que ya no existen
    ids = {st["id"] for st in stations}
    for key in ("ext", "pinc", "pacc"):
        for k in [k for k in state.get(key, {}) if k not in ids]:
            del state[key][k]

    # ---- control de calidad automático (sugerencias para el editor)
    iq = COLS.index("qc")
    qc_rows = [dict(zip(COLS, r)) for r in rows]
    try:
        from . import qc   # aquí y no arriba: si falla (p. ej. falta numpy) no tumba la pasada
        qc_doc, qc_flags = qc.run(qc_rows, state, now, today)
    except Exception as e:
        log(f"  QC: ERROR {type(e).__name__}: {e}")
        qc_doc, qc_flags = {"n": 0, "stations": {}}, {}
    for r in rows:
        r[iq] = qc_flags.get(r[0])
    qc_doc["generated"] = iso(now)
    dump_json(out / "qc.json", qc_doc)
    log(f"  QC: {qc_doc['n']} estaciones sospechosas")

    # ---- salud de cada red (para estado.html y los avisos)
    health = update_health(state, stats, results, now, ctx)
    dump_json(out / "health.json", {"generated": iso(now), "ts": now, "sources": health,
                                    "timings": timings, "qc": qc_doc["n"]})

    now_doc = {"generated": iso(now), "ts": now, "day": today, "cols": COLS, "stats": stats,
               "timings": timings, "rows": rows}
    dump_json(out / "now.json", now_doc)
    if ctx.get("obs10"):
        dump_json(out / "obs10.json", ctx["obs10"])

    # ---- hidrología
    if not only or "SAIH" in only:
        reservoirs = read_csv(ROOT / "config" / "reservoirs.csv")
        gauges = read_csv(ROOT / "config" / "gauges.csv")
        res_now, gau_now = saih.hydro(reservoirs, gauges, ctx)
        prev_h = load_json(out / "hydro.json")
        seed = load_json(out / "seed_hydro.json") if not prev_h else None
        hyd = update_hydro(prev_h, reservoirs, gauges, res_now, gau_now, now, seed)
        hyd["meta"] = {"reservoirs": reservoirs, "gauges": gauges}
        dump_json(out / "hydro.json", hyd)

    # ---- webcams (la lista de la DGT se refresca cada 6 h)
    if now - state.get("webcams_ts", 0) > 6 * 3600 or not (out / "webcams.json").exists():
        cams = [{"name": c["name"], "lat": float(c["lat"]), "lon": float(c["lon"]), "link": c["link"],
                 "notes": c.get("notes") or None, "src": "propia"}
                for c in read_csv(ROOT / "config" / "webcams.csv")]
        d = dgt.fetch()
        if d or not (out / "webcams.json").exists():
            dump_json(out / "webcams.json", {"generated": iso(now), "cams": cams + d})
            state["webcams_ts"] = now

    # ---- récords de cada estación (una vez al día o tras cerrar un día)
    if closed or state.get("records_day") != today or not (out / "records.json").exists():
        try:
            from . import records
            rec = records.compute(a.history_dir, today)
            dump_json(out / "records.json", {"generated": iso(now), "stations": rec})
            state["records_day"] = today
            log(f"  Récords: {len(rec)} estaciones")
        except Exception as e:
            log(f"  Récords: ERROR {type(e).__name__}: {e}")

    # ---- avisos de AEMET (cada 30 min; si fallan se conservan los anteriores)
    key = __import__("os").environ.get("AEMET_API_KEY")
    if key and (not only or "AEMET" in only) and (now - state.get("avisos_ts", 0) > 1800 or not (out / "avisos.json").exists()):
        try:
            av = avisos.fetch(key, now)
            dump_json(out / "avisos.json", {"generated": iso(now), "ts": now, "avisos": av})
            state["avisos_ts"] = now
        except Exception as e:
            log(f"  Avisos AEMET: ERROR {type(e).__name__}: {e}")

    state["last_run"] = now
    dump_json(out / "state.json", state)
    if closed:
        (out / "closed_days.txt").write_text("\n".join(closed) + "\n")
    tot = {k: sum(s.get(k, 0) for s in stats.values()) for k in ("n", "ok", "off")}
    log(f"Hecho en {time.time() - t_start:.0f} s: {tot['ok']} estaciones con datos, {tot['off']} offline, "
        f"{tot['n']} en total · tiempos {timings}")


if __name__ == "__main__":
    main()
