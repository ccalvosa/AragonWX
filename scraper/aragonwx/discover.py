#!/usr/bin/env python3
"""
Busca estaciones de aficionados en Aragón que todavía no están en
config/stations.csv y las deja como sugerencias para el editor de la web.

Fuentes (todas públicas):
  Weather Underground  búsqueda por coordenadas (v3/location/near, 10 estaciones por
                       consulta) en una rejilla que cubre Aragón; se afina donde hay
                       muchas estaciones juntas
  Meteoclimatic        feed XML/RSS de la región (ESARA): todas las de Aragón
  Holfuy               lista pública de estaciones

WeatherCloud no publica un listado: sus estaciones se dan de alta a mano.

Salida: discover.json con las candidatas dentro de Aragón (con un pequeño margen),
activas en los últimos 7 días, la estación ya existente más cercana y un aviso de
posible duplicado (< 300 m de una existente).

    python -m aragonwx.discover --out ../out/discover.json
"""

import argparse
import math
import re
import time
from datetime import datetime, timezone

from .common import dump_json, in_aragon, iso, load_stations, log, num, pmap, session
from .sources.wu import FALLBACK_KEY

ACTIVE_DAYS = 7


def wu_candidates(key):
    s = session()
    url = "https://api.weather.com/v3/location/near"
    seen = {}

    def query(pt):
        lat, lon = pt
        r = s.get(url, params={"geocode": f"{lat:.3f},{lon:.3f}", "product": "pws", "format": "json", "apiKey": key},
                  timeout=20)
        if r.status_code != 200:
            return None
        loc = r.json().get("location") or {}
        return [dict(id=i, name=n, lat=la, lon=lo, upd=u, qc=q, dist=d)
                for i, n, la, lo, u, q, d in zip(loc.get("stationId", []), loc.get("stationName", []),
                                                  loc.get("latitude", []), loc.get("longitude", []),
                                                  loc.get("updateTimeUtc", []), loc.get("qcStatus", []),
                                                  loc.get("distanceKm", [None] * 10))]

    step = 0.12
    grid = [(round(39.8 + i * step, 3), round(-2.2 + j * step, 3))
            for i in range(int(3.2 / step) + 1) for j in range(int(3.1 / step) + 1)]
    grid = [p for p in grid if in_aragon(*p, margin=0.1)]
    dense = []
    for pt, res in pmap(query, grid, workers=8):
        for st in res or []:
            seen.setdefault(st["id"], st)
        # si las 10 caen muy cerca, hay más: se afina alrededor
        if res and len(res) == 10 and max((x.get("dist") or 0) for x in res) < step * 111 / 2:
            dense += [(pt[0] + a, pt[1] + b) for a in (-step / 3, 0, step / 3) for b in (-step / 3, 0, step / 3)]
    for pt, res in pmap(query, dense, workers=8):
        for st in res or []:
            seen.setdefault(st["id"], st)
    log(f"  WU: {len(seen)} estaciones encontradas con {len(grid) + len(dense)} consultas")
    out = []
    for st in seen.values():
        out.append({"src": "WU", "id": st["id"], "name": st["name"], "lat": st["lat"], "lon": st["lon"],
                    "last": st.get("upd"), "qc": st.get("qc"),
                    "link": f"https://www.wunderground.com/dashboard/pws/{st['id']}"})
    return out


def mc_candidates():
    s = session()
    xml = s.get("https://www.meteoclimatic.net/feed/xml/ESARA", timeout=30)
    rss = s.get("https://www.meteoclimatic.net/feed/rss/ESARA", timeout=30)
    xml.encoding = rss.encoding = "iso-8859-15"
    coords = {}
    for item in re.findall(r"<item>.*?</item>", rss.text, re.S):
        m = re.search(r"perfil/(ES[A-Z0-9]+)", item)
        la, lo = re.search(r"<geo:lat>([^<]+)", item), re.search(r"<geo:long>([^<]+)", item)
        if m and la and lo:
            coords[m.group(1)] = (float(la.group(1)), float(lo.group(1)))
    out = []
    for st in re.findall(r"<station>.*?</station>", xml.text, re.S):
        sid = re.search(r"<id>([^<]+)", st).group(1)
        name = re.search(r"<location>([^<]*)", st).group(1)
        pub = re.search(r"<pubDate>([^<]+)", st)
        try:
            last = int(datetime.strptime(pub.group(1).strip(), "%a, %d %b %Y %H:%M:%S %z").timestamp()) if pub else None
        except ValueError:
            last = None
        t = re.search(r"<temperature>.*?<now>([^<]+)", st, re.S)
        lat, lon = coords.get(sid, (None, None))
        out.append({"src": "MC", "id": sid, "name": unescape(name), "lat": lat, "lon": lon, "last": last,
                    "ta": num(t.group(1)) if t else None, "link": f"https://www.meteoclimatic.net/perfil/{sid}"})
    log(f"  Meteoclimatic: {len(out)} estaciones en el feed de Aragón ({len(coords)} con coordenadas)")
    return out


def holfuy_candidates():
    d = session().get("https://api.holfuy.com/stations/stations.json", timeout=30).json()
    out = []
    for st in d.get("holfuyStationsList", []):
        loc = st.get("location") or {}
        la, lo = loc.get("latitude"), loc.get("longitude")
        if la is None or not in_aragon(la, lo, margin=0.05):
            continue
        out.append({"src": "HOLFUY", "id": str(st["id"]), "name": st.get("name"), "lat": la, "lon": lo,
                    "alt": loc.get("altitude"), "last": None, "link": f"https://holfuy.com/es/weather/{st['id']}"})
    log(f"  Holfuy: {len(out)} estaciones en Aragón")
    return out


def unescape(s):
    import html
    return html.unescape(s or "").strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    stations = load_stations()
    known_ids = {s["id"] for s in stations}
    # Holfuy: el id está en el enlace (holfuy.com/…/1935)
    for s in stations:
        m = re.search(r"holfuy\.com/\D*(\d+)", s.get("link") or "")
        if m:
            known_ids.add(m.group(1))
    known = [s for s in stations if s["lat"] is not None]

    cands = []
    for name, fn in (("WU", lambda: wu_candidates(FALLBACK_KEY)), ("MC", mc_candidates), ("HOLFUY", holfuy_candidates)):
        try:
            cands += fn()
        except Exception as e:
            log(f"  {name}: ERROR {type(e).__name__}: {e}")

    now = time.time()
    out = []
    for c in cands:
        if c["id"] in known_ids or c["lat"] is None or not in_aragon(c["lat"], c["lon"]):
            continue
        if c.get("last") and now - c["last"] > ACTIVE_DAYS * 86400:
            continue
        k = math.cos(math.radians(c["lat"]))
        near, dmin = None, 1e9
        for s in known:
            d = math.hypot((s["lat"] - c["lat"]) * 111.2, (s["lon"] - c["lon"]) * 111.2 * k)
            if d < dmin:
                near, dmin = s, d
        c["near"] = {"id": near["id"], "name": near["name"], "src": near["source"], "km": round(dmin, 2)} if near else None
        c["dup"] = dmin < 0.3
        out.append(c)
    out.sort(key=lambda c: (c["dup"], -(c["near"]["km"] if c["near"] else 0)))
    dump_json(a.out, {"generated": iso(int(now)), "n": len(out), "candidates": out})
    by = {}
    for c in out:
        by[c["src"]] = by.get(c["src"], 0) + 1
    log(f"Sugerencias: {len(out)} estaciones nuevas en Aragón {by}")


if __name__ == "__main__":
    main()
