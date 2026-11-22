"""Cámaras de tráfico de la DGT (DATEX II) en Huesca, Teruel y Zaragoza."""

import re

from bs4 import BeautifulSoup

from ..common import log, session

URL = "https://nap.dgt.es/datex2/v3/dgt/DevicePublication/camaras_datex2_v36.xml"
PROVS = {"HUESCA", "TERUEL", "ZARAGOZA"}


def _txt(dev, name):
    t = dev.find(re.compile(rf".*{name}$", re.I))
    return t.get_text(strip=True) if t else None


def fetch():
    try:
        r = session().get(URL, timeout=40)
        r.raise_for_status()
        soup = BeautifulSoup(r.content, "xml")
    except Exception as e:
        log(f"  DGT: {e}")
        return []
    out = []
    for dev in soup.find_all(re.compile(r".*device$", re.I)):
        prov = (_txt(dev, "province") or "").upper()
        if prov not in PROVS:
            continue
        url, lat, lon = _txt(dev, "deviceUrl"), _txt(dev, "latitude"), _txt(dev, "longitude")
        if not (url and lat and lon):
            continue
        road, km = _txt(dev, "roadName") or "?", _txt(dev, "kilometerPoint") or "?"
        out.append({"name": f"{road} km {km}", "lat": round(float(lat), 5), "lon": round(float(lon), 5),
                    "link": url, "img": True, "src": "DGT", "prov": prov.title()})
    log(f"  DGT: {len(out)} cámaras")
    return out
