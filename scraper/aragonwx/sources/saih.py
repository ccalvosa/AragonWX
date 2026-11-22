"""
SAIH Ebro: todo por su API JSON pública (sin Selenium).

  /api/pluviometrias/getTablaPluviometrias  lluvia de hoy (col2) de todas las estaciones
  /api/mapa/getDatosMapa?slug=mapa-<tipo>-<zona>
        tipo = temperaturas | meteorologia | embalses | aforos
        Cada estación trae sus señales (TAGS) con el último valor y su fecha.

Las temperaturas solo dan el valor actual: la máxima y la mínima del día las
calcula el orquestador con las lecturas de cada pasada (estado persistente).

saihebro.com no acepta conexiones desde las máquinas de GitHub Actions. Se prueba,
por este orden:
  1. conexión directa;
  2. el Worker de Cloudflare de cloudflare/saih-proxy.js (secretos SAIH_PROXY_URL
     y SAIH_PROXY_TOKEN);
  3. los datos crudos que publica un relé en la rama «saih»
     (python -m aragonwx.saih_relay --push, en una máquina que sí llegue al SAIH).
Si ninguna vía da datos frescos, el SAIH se queda sin datos en esa pasada.
"""

import os
import time
import unicodedata
from datetime import datetime

from ..common import TZ, log, num, pmap, session

RELAY_URL = "https://raw.githubusercontent.com/{repo}/saih/saih_raw.json"
RELAY_MAX_AGE = 40 * 60
TIMEOUT = (6, 25)   # (conexión, lectura)

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


def _session(headers=None):
    s = session()
    s.headers.update(headers or {})
    return s


def reachable(base=BASE, headers=None, label="SAIH"):
    """Una petición rápida para no esperar 56 timeouts si el SAIH no responde."""
    try:
        r = _session(headers).get(f"{base}/api/mapa/getDatosMapa", params={"slug": f"mapa-embalses-{ZONES[2]}"},
                                  timeout=TIMEOUT, verify=False)
        if not r.ok:
            colo = r.headers.get("X-Colo") or r.headers.get("CF-RAY", "").split("-")[-1]
            log(f"  {label}: HTTP {r.status_code}" + (f" (Cloudflare {colo})" if colo else ""))
        return r.ok
    except Exception as e:
        log(f"  {label} no responde ({type(e).__name__})")
        return False


def fetch_maps(base=BASE, headers=None):
    """{tag: [tipo_señal, valor, ts, codigo_estacion, nombre]}."""
    s = _session(headers)
    jobs = [(k, z) for k in KINDS for z in ZONES]

    def one(job):
        k, z = job
        r = s.get(f"{base}/api/mapa/getDatosMapa", params={"slug": f"mapa-{k}-{z}"}, timeout=TIMEOUT, verify=False)
        r.raise_for_status()
        return r.json().get("DATOS", [])

    tags = {}
    fails = 0
    for job, datos in pmap(one, jobs, workers=8):
        if datos is None:
            fails += 1
            continue
        for e in datos:
            cod = e.get("CW_REMOTA_TXT")
            for t in e.get("TAGS", []):
                tags[t.get("LS_TAG_TXT")] = [t.get("LS_TIPO_SENAL"), num(t.get("VALOR"), 3),
                                             _ts(t.get("ULTIMA_FECHA", "")), cod, e.get("LR_NOMBRE_CORTO")]
    if fails:
        log(f"  SAIH: {fails}/{len(jobs)} mapas fallidos")
    return tags


def fetch_pluvio(base=BASE, headers=None):
    s = _session(headers)
    try:
        r = s.get(f"{base}/api/pluviometrias/getTablaPluviometrias", timeout=TIMEOUT, verify=False)
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


def download_raw(base=BASE, headers=None, label="SAIH"):
    """{'ts', 'tags', 'pluvio'} o None si el SAIH (o el proxy) no responde."""
    if not reachable(base, headers, label):
        return None
    tags, pluvio = fetch_maps(base, headers), fetch_pluvio(base, headers)
    if not tags and not pluvio:
        return None
    return {"ts": int(time.time()), "tags": tags, "pluvio": pluvio}


def from_proxy():
    url = os.environ.get("SAIH_PROXY_URL", "").rstrip("/")
    if not url:
        return None
    raw = download_raw(url, {"X-Proxy-Token": os.environ.get("SAIH_PROXY_TOKEN", "")}, "SAIH vía Cloudflare")
    if raw:
        log("  SAIH: datos vía Cloudflare")
    return raw


def from_relay():
    repo = os.environ.get("GITHUB_REPOSITORY", "ccalvosa/AragonWX")
    try:
        r = session().get(RELAY_URL.format(repo=repo), params={"t": int(time.time() // 60)}, timeout=(6, 30))
        r.raise_for_status()
        d = r.json()
    except Exception as e:
        log(f"  SAIH relé: no disponible ({type(e).__name__})")
        return None
    age = time.time() - d.get("ts", 0)
    if age > RELAY_MAX_AGE:
        log(f"  SAIH relé: datos de hace {age / 60:.0f} min, demasiado viejos")
        return None
    log(f"  SAIH relé: datos de hace {age / 60:.0f} min")
    return d


def fetch(stations, ctx):
    raw, via = download_raw(), "directo"
    if not raw:
        raw, via = from_proxy(), "Cloudflare"
    if not raw:
        raw, via = from_relay(), "relé"
    ctx["saih_via"] = via if raw else None
    if not raw:
        ctx["saih_tags"] = {}
        return {}
    tags, pluvio = raw["tags"], raw["pluvio"]
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
    tags = ctx.get("saih_tags") or {}
    sig = {}
    for tag, (kind, val, ts, cod, _) in tags.items():
        if cod and val is not None:
            sig.setdefault(cod, {})[kind] = (val, ts)
    res = {}
    for r in reservoirs:
        s = sig.get(r["id"], {})
        vol = s.get("VEMBA", (None, None))[0]
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
