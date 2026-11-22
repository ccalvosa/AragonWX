"""
Avisos meteorológicos de AEMET (Meteoalerta) en formato CAP, para toda España.

  /api/avisos_cap/ultimoelaborado/area/esp  -> .tar con un XML CAP por zona y día

De cada aviso se guardan el nivel (amarillo / naranja / rojo; los verdes se
descartan), el fenómeno, el parámetro («Rachas máximas;80 km/h»), la probabilidad,
el inicio y el fin, el texto y el polígono de la zona. Solo los que no han
caducado. Las zonas de Aragón tienen el código 62xxxx.
"""

import io
import re
import tarfile
from datetime import datetime

from ..common import log, session

URL = "https://opendata.aemet.es/opendata/api/avisos_cap/ultimoelaborado/area/esp"
LEVELS = {"amarillo": 1, "naranja": 2, "rojo": 3}


def _ts(s):
    return int(datetime.fromisoformat(s.strip()).timestamp())


def _get(block, tag):
    m = re.search(rf"<{tag}>([^<]*)</{tag}>", block)
    return m.group(1).strip() if m else None


def _param(block, name):
    m = re.search(rf"<valueName>{re.escape(name)}</valueName>\s*<value>([^<]*)</value>", block)
    return m.group(1).strip() if m else None


def fetch(api_key, now):
    s = session()
    r = s.get(URL, params={"api_key": api_key}, timeout=60)
    r.raise_for_status()
    datos = r.json().get("datos")
    if not datos:
        raise RuntimeError(r.json().get("descripcion", "sin datos"))
    tar = tarfile.open(fileobj=io.BytesIO(s.get(datos, timeout=120).content))
    out, seen = [], set()
    for m in tar.getmembers():
        if not m.isfile():
            continue
        xml = tar.extractfile(m).read().decode("utf-8", "ignore")
        for info in re.findall(r"<info>.*?</info>", xml, re.S):
            if "<language>es-ES</language>" not in info:
                continue
            level = (_param(info, "AEMET-Meteoalerta nivel") or "").lower()
            if level not in LEVELS:
                continue
            expires, onset = _get(info, "expires"), _get(info, "onset")
            if not expires or _ts(expires) < now:
                continue
            phen = (_param(info, "AEMET-Meteoalerta fenomeno") or ";").split(";")
            par = (_param(info, "AEMET-Meteoalerta parametro") or "").split(";")
            for area in re.findall(r"<area>.*?</area>", info, re.S):
                zone = _param(area, "AEMET-Meteoalerta zona") or ""
                key = (zone, phen[0], onset)
                if key in seen:
                    continue
                seen.add(key)
                poly = []
                for p in re.findall(r"<polygon>([^<]+)</polygon>", area):
                    poly.append([[round(float(a), 3), round(float(b), 3)] for a, b in
                                 (pt.split(",") for pt in p.split())])
                out.append({
                    "zone": zone, "area": _get(area, "areaDesc"), "ar": zone.startswith("62"),
                    "level": level, "lv": LEVELS[level], "phen": phen[0], "phen_name": phen[-1],
                    "param": par[1] if len(par) > 1 else None, "value": par[2] if len(par) > 2 else None,
                    "prob": _param(info, "AEMET-Meteoalerta probabilidad"),
                    "onset": _ts(onset) if onset else None, "expires": _ts(expires),
                    "headline": _get(info, "headline"), "desc": _get(info, "description"), "poly": poly,
                })
    out.sort(key=lambda a: (-a["lv"], a["onset"] or 0))
    n_ar = sum(1 for a in out if a["ar"])
    log(f"  Avisos AEMET: {len(out)} en vigor o próximos ({n_ar} en Aragón)")
    return out
