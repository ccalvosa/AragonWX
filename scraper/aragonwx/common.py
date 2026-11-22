"""Utilidades compartidas por todas las fuentes."""

import csv
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Europe/Madrid")
except Exception:  # Python < 3.9
    from dateutil import tz as _tz
    TZ = _tz.gettz("Europe/Madrid")

ROOT = Path(__file__).resolve().parents[2]
UA_BROWSER = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
UA_BOT = "AragonWX (+https://github.com/ccalvosa/AragonWX)"

OFFLINE_AFTER = 6 * 3600      # sin datos en 6 h -> estación offline
CURRENT_MAX_AGE = 3600        # la temperatura "actual" solo vale si tiene < 1 h

# Claves de una observación (todas opcionales):
#   t     instante del dato (epoch UTC)
#   ta    temperatura actual (°C)       tx / tn  máxima / mínima del día local (°C)
#   pr    lluvia acumulada del día según la propia estación (mm)
#   gust  racha máxima del día (km/h)   wg   racha actual (km/h)   ws  viento medio (km/h)
#   hr    humedad (%)                    pres presión (hPa)
#   off   True si la fuente dice que la estación no transmite
OBS_KEYS = ("ta", "tx", "tn", "pr", "gust", "wg", "ws", "hr", "pres")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def session(ua=UA_BROWSER, **headers):
    s = requests.Session()
    s.headers["User-Agent"] = ua
    s.headers.update(headers)
    adapter = requests.adapters.HTTPAdapter(pool_connections=32, pool_maxsize=32, max_retries=1)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def num(x, nd=1):
    """Convierte texto o número a float redondeado; None si no es un número."""
    if x is None:
        return None
    if isinstance(x, (int, float)):
        v = float(x)
    else:
        m = re.search(r"-?\d+(?:[.,]\d+)?", str(x).replace("−", "-"))
        if not m:
            return None
        v = float(m.group(0).replace(",", "."))
    if v != v or v in (float("inf"), float("-inf")):
        return None
    return round(v, nd)


def now_utc():
    return datetime.now(timezone.utc)


def now_ts():
    return int(time.time())


def local_today():
    return datetime.now(TZ).strftime("%Y-%m-%d")


def local_dt(ts):
    return datetime.fromtimestamp(ts, TZ)


def parse_local(s, fmt):
    """Fecha en hora local española -> epoch UTC."""
    return int(datetime.strptime(s, fmt).replace(tzinfo=TZ).timestamp())


def parse_utc(s, fmt):
    return int(datetime.strptime(s, fmt).replace(tzinfo=timezone.utc).timestamp())


def iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def pmap(fn, items, workers=12):
    """map en paralelo que nunca lanza excepciones: devuelve (item, resultado|None)."""
    def safe(it):
        try:
            return it, fn(it)
        except Exception as e:  # una estación rota no para al resto
            return it, None
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(safe, items))


def read_csv(path):
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def dump_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def load_stations(root=ROOT):
    st = []
    for r in read_csv(root / "config" / "stations.csv"):
        try:
            r["lat"], r["lon"] = float(r["lat"]), float(r["lon"])
        except ValueError:
            continue
        r["alt"] = int(r["alt"]) if r.get("alt") else None
        r["active"] = r.get("active", "1") == "1"
        r["tz_shift"] = r.get("tz_shift") == "1"
        st.append(r)
    return st


# ---------------------------------------------------------------- polígono de Aragón
_POLYS = None


def _aragon_polys():
    global _POLYS
    if _POLYS is None:
        g = load_json(ROOT / "assets" / "provincias.geojson", {"features": []})
        polys = []
        for f in g["features"]:
            geom = f["geometry"]
            parts = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
            for p in parts:
                polys.append(p[0])
        _POLYS = polys
    return _POLYS


def in_aragon(lat, lon, margin=0.0):
    """Punto dentro de Aragón (margin>0 acepta también una franja exterior, en grados)."""
    if lat is None or lon is None:
        return False
    if not (39.7 - margin <= lat <= 42.95 + margin and -2.2 - margin <= lon <= 0.8 + margin):
        return False
    for ring in _aragon_polys():
        inside = False
        j = len(ring) - 1
        for i in range(len(ring)):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                inside = not inside
            j = i
        if inside:
            return True
    if margin > 0:
        for ring in _aragon_polys():
            for x, y in ring[::5]:
                if abs(x - lon) < margin and abs(y - lat) < margin:
                    return True
    return False
