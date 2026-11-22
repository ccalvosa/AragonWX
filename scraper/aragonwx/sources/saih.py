"""
SAIH Ebro: todo por su API JSON pública (sin Selenium).

  /api/pluviometrias/getTablaPluviometrias  lluvia de hoy (col2) de todas las estaciones
  /api/mapa/getDatosMapa?slug=mapa-<tipo>-<zona>
        tipo = temperaturas | meteorologia | embalses | aforos
        Cada estación trae sus señales (TAGS) con el último valor y su fecha.

Las temperaturas solo dan el valor actual: la máxima y la mínima del día las
calcula el orquestador con las lecturas de cada pasada (estado persistente).
"""

import unicodedata
from datetime import datetime

from ..common import TZ, log, num, pmap, session

BASE = "https://www.saihebro.com"
ZONES = ["H3-aragon-irati", "H4-medio-ebro-mi", "H5-gallego", "H6-bajo-cinca", "H7-segre",
         "H8-bajo-ebro", "H9-guadalope-martin", "H10-bajo-jalon", "H16-alto-aragon",
         "H17-alto-cinca", "H18-esera", "H19-huerva-aguas-vivas", "H20-alto-jalon",
         "H21-medio-ebro-md"]
KINDS = ["temperaturas", "meteorologia", "embalses", "aforos"]


def norm(s):
    return (unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
            .lower().replace(" ", "").replace("-", "").replace(".", ""))


def _ts(s):
    try:
        return int(datetime.strptime(s, "%Y-%m-%d %H:%M:%S").replace(tzinfo=TZ).timestamp())
    except Exception:
        return None


def fetch_maps():
    """{tag: (tipo_señal, valor, ts, codigo_estacion, nombre)} y {codigo: estación cruda}."""
    s = session()
    jobs = [(k, z) for k in KINDS for z in ZONES]

    def one(job):
        k, z = job
        r = s.get(f"{BASE}/api/mapa/getDatosMapa", params={"slug": f"mapa-{k}-{z}"}, timeout=30, verify=False)
        r.raise_for_status()
        return r.json().get("DATOS", [])

    tags, stations = {}, {}
    fails = 0
    for job, datos in pmap(one, jobs, workers=8):
        if datos is None:
            fails += 1
            continue
        for e in datos:
            cod = e.get("CW_REMOTA_TXT")
            if cod:
                stations[cod] = e
            for t in e.get("TAGS", []):
                tags[t.get("LS_TAG_TXT")] = (t.get("LS_TIPO_SENAL"), num(t.get("VALOR"), 3),
                                             _ts(t.get("ULTIMA_FECHA", "")), cod, e.get("LR_NOMBRE_CORTO"))
    if fails:
        log(f"  SAIH: {fails}/{len(jobs)} mapas fallidos")
    return tags, stations


def fetch_pluvio():
    s = session()
    try:
        r = s.get(f"{BASE}/api/pluviometrias/getTablaPluviometrias", timeout=30, verify=False)
        r.raise_for_status()
        rows = r.json()
    except Exception as e:
        log(f"  SAIH pluviometrías: {e}")
        return {}
    out = {}
    for row in rows:
        v = num(row.get("col2"))
        if v is None or v < 0:      # -1 = sin dato
            continue
        rec = {"pr": v, "code": row.get("codigo")}
        out[norm(row.get("nombreCorto"))] = rec
        if row.get("codigo"):
            out["#" + row["codigo"]] = rec
    return out


def fetch(stations, ctx):
    tags, raw = fetch_maps()
    pluvio = fetch_pluvio()
    ctx["saih_raw"] = raw
    ctx["saih_tags"] = tags
    # temperatura / humedad / viento de cada estación por su código de remota
    by_station = {}
    for tag, (kind, val, ts, cod, _) in tags.items():
        if val is None or cod is None:
            continue
        by_station.setdefault(cod, {})[kind] = (val, ts, tag)
    temp_by_name = {norm(name): tag for tag, (kind, val, ts, cod, name) in tags.items()
                    if kind == "TEMPE" and val is not None}
    out = {}
    for st in stations:
        r = {}
        tag = None
        for part in (st.get("notes") or "").split():
            if part.startswith("tag="):
                tag = part[4:]
        if not tag:   # pluviómetros que también miden temperatura
            tag = temp_by_name.get(norm(st["id"])) or temp_by_name.get(norm(st["name"]))
        if tag and tag in tags:
            kind, val, ts, cod, _ = tags[tag]
            if val is not None and kind == "TEMPE":
                r["ta"], r["t"] = val, ts
            sig = by_station.get(cod, {})
            for k, key, f in (("SMHUM", "hr", 1), ("SMVVI", "ws", 3.6), ("SMPRE", "pres", 1)):
                if k in sig:
                    r[key] = round(sig[k][0] * f, 1)
        p = pluvio.get(norm(st["id"])) or pluvio.get(norm(st["name"])) or pluvio.get("#" + st["id"])
        if p:
            r["pr"] = p["pr"]
            r.setdefault("t", ctx["now"])
        if r:
            out[st["id"]] = r
    log(f"  SAIH: {len(out)}/{len(stations)} estaciones · {len(tags)} señales · {len(pluvio) // 2} pluviómetros")
    return out


def hydro(reservoirs, gauges, ctx):
    """Valores actuales de embalses y aforos a partir de los mapas ya descargados."""
    raw = ctx.get("saih_raw") or {}
    tags = ctx.get("saih_tags") or {}
    sig = {}
    for tag, (kind, val, ts, cod, _) in tags.items():
        if cod and val is not None:
            sig.setdefault(cod, {})[kind] = (val, ts)
    res = {}
    for r in reservoirs:
        s = sig.get(r["id"], {})
        e = raw.get(r["id"], {})
        vol = s.get("VEMBA", (num(e.get("VALOR_SENAL2_FICHA"), 3), None))[0]
        lvl = s.get("NEMBA", (None, None))[0]
        ts = max([x[1] for x in s.values() if x[1]] or [None]) if s else None
        if vol is None:
            continue
        cap = float(r["capacity_hm3"]) if r.get("capacity_hm3") else None
        res[r["id"]] = {"vol": vol, "pct": round(vol / cap * 100, 1) if cap else s.get("PORCE", (None,))[0],
                        "lvl": lvl, "t": ts}
    gau = {}
    for g in gauges:
        s = sig.get(g["id"], {})
        if not s:
            continue
        q, h = s.get("QRIO", (None, None))[0], s.get("NRIO", (None, None))[0]
        ts = max([x[1] for x in s.values() if x[1]] or [None])
        if q is None and h is None:
            continue
        gau[g["id"]] = {"q": q, "h": h, "t": ts}
    log(f"  SAIH hidro: {len(res)}/{len(reservoirs)} embalses, {len(gau)}/{len(gauges)} aforos")
    return res, gau
