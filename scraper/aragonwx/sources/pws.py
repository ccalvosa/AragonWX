"""
Redes de aficionados con una petición HTTP por estación:
WeatherCloud (API JSON), Holfuy (JSON del widget), Meteoclimatic, Ibericam y
AVAMET (HTML). Cada función devuelve una observación con las claves de common.py.
"""

import re
import time
from datetime import datetime, timezone

from bs4 import BeautifulSoup

from ..common import TZ, log, num, parse_local, parse_utc, pmap, session


# ------------------------------------------------------------------ WeatherCloud
def _wc_val(v):
    return v[1] if isinstance(v, list) and len(v) == 2 else v


def weathercloud(stations, ctx):
    s = session()
    s.headers.update({"X-Requested-With": "XMLHttpRequest", "Accept": "application/json"})

    def one(st):
        r = s.get("https://app.weathercloud.net/device/stats", params={"code": st["id"]}, timeout=15)
        if r.status_code != 200:
            return {"off": True}
        d = r.json()
        if not isinstance(d, dict) or not d.get("last_update"):
            return {"off": True}
        o = {"t": int(d["last_update"])}
        for key, field, f in (("ta", "temp_current", 1), ("tx", "temp_day_max", 1), ("tn", "temp_day_min", 1),
                              ("pr", "rain_day_total", 1), ("gust", "wspdhi_day_max", 3.6),
                              ("hr", "hum_current", 1), ("ws", "wspdavg_current", 3.6),
                              ("wg", "wspdhi_current", 3.6), ("pres", "bar_current", 1)):
            v = num(_wc_val(d.get(field)))
            if v is not None:
                o[key] = round(v * f, 1)
        return o

    return _run("WeatherCloud", one, stations, 24)


# ------------------------------------------------------------------ Holfuy
def holfuy(stations, ctx):
    s = session()

    def one(st):
        m = re.search(r"(\d+)\s*$", st["link"] or st["id"])
        hid = m.group(1)
        r = s.get("https://holfuy.com/puget/mjso.php", params={"k": hid}, timeout=15,
                  headers={"Referer": f"https://holfuy.com/es/weather/{hid}"})
        d = r.json()
        if d.get("valid") != "ok":
            return {"off": True}
        ago = num(re.sub(r"<[^>]+>", "", str(d.get("updated", ""))), 0)
        o = {"t": int(time.time() - (ago or 0) * (60 if "min" in str(d.get("updated")) else 1))}
        for key, field in (("ta", "temperature"), ("tx", "daily_max_temp"), ("tn", "daily_min_temp"),
                           ("gust", "daily_max_wind"), ("hr", "humidity"), ("ws", "speed"),
                           ("wg", "gust"), ("pres", "pressure")):
            v = num(d.get(field))
            if v is not None:
                o[key] = v
        return o

    return _run("Holfuy", one, stations, 4)


# ------------------------------------------------------------------ Meteoclimatic
def meteoclimatic(stations, ctx):
    s = session()

    def one(st):
        r = s.get(st["link"], timeout=15)
        soup = BeautifulSoup(r.content, "html.parser")
        tag = soup.find("td", class_="titolseccio", string=re.compile(r"actualizaci", re.I))
        m = re.search(r"(\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2})", tag.get_text() if tag else "")
        if not m:
            return None
        o = {"t": parse_utc(m.group(1), "%d-%m-%Y %H:%M")}
        for td in soup.find_all("td", class_="dadesactuals"):
            txt = td.get_text(" ", strip=True)
            if "ºC" in txt and "ta" not in o:
                o["ta"] = num(txt)
            elif "mm" in txt:
                o["pr"] = num(txt)
            elif "%" in txt and "hr" not in o:
                o["hr"] = num(txt)
        mx, mn = soup.find("span", class_="vermell"), soup.find("span", class_="blau")
        if mx:
            o["tx"] = num(mx.get_text())
        if mn:
            o["tn"] = num(mn.get_text())
        return o

    return _run("Meteoclimatic", one, stations, 10)


# ------------------------------------------------------------------ Ibericam
def ibericam(stations, ctx):
    s = session()

    def one(st):
        r = s.get(st["link"], timeout=15)
        soup = BeautifulSoup(r.content, "html.parser")
        o = {}
        span = soup.find("span", class_="larger")
        parent = span.find_parent("p") if span else None
        m = re.search(r"(\d{2}\.\d{2}\.\d{4}).*?(\d{2}:\d{2})", parent.get_text(" ", strip=True) if parent else "")
        if m:
            o["t"] = parse_local(f"{m.group(1)} {m.group(2)}", "%d.%m.%Y %H:%M")
        for p in soup.find_all("p", class_="larger"):
            if "center" in str(p.get("style", "")).lower() and "°C" in p.get_text():
                o["ta"] = num(p.get_text())
                break
        for p in soup.find_all("p"):
            txt = p.get_text(" ", strip=True)
            mx = re.search(r"Max\s*(-?\d+(?:\.\d+)?)", txt)
            mn = re.search(r"Min\s*(-?\d+(?:\.\d+)?)", txt)
            if mx and "tx" not in o:
                o["tx"] = float(mx.group(1))
            if mn and "tn" not in o:
                o["tn"] = float(mn.group(1))
        for box in soup.select(".small-box"):
            if box.find("p", class_="small", string=re.compile("hoy", re.I)):
                o["pr"] = num(box.find_all("p")[-1].get_text())
                break
        return o or None

    return _run("Ibericam", one, stations, 10)


# ------------------------------------------------------------------ AVAMET
def _ava_num(txt):
    if not txt or txt.strip() in ("-", ""):
        return None
    t = re.sub(r"[^\d,-]", "", txt)
    if t.count("-") > 1:
        t = "-" + t.replace("-", "")
    return num(t.replace(",", "."))


def avamet(stations, ctx):
    s = session()

    def one(st):
        r = s.get(st["link"], timeout=15)
        soup = BeautifulSoup(r.content, "html.parser")
        el = soup.select_one("div#hora") or soup.select_one("div#mobNom h4 b")
        o = {}
        if el:
            try:
                o["t"] = parse_local(el.get_text(strip=True), "%d-%m-%Y %H:%M")
            except ValueError:
                pass
        for sel, key in (("#temp_mit", "ta"), ("#mobVTemp", "ta"), ("#temp_max", "tx"), ("#temp_min", "tn")):
            e = soup.select_one(sel)
            if e and key not in o:
                v = _ava_num(e.get_text())
                if v is not None:
                    o[key] = v
        for d in soup.find_all("div", id="prec"):
            if re.search(r"hui|hoy", d.get_text(), re.I):
                o["pr"] = _ava_num(d.get_text())
                break
        for d in soup.find_all("div", id="vent"):
            if re.search(r"m[àa]x|racha", d.get_text(), re.I):
                o["gust"] = _ava_num(d.get_text())
                break
        for cel in soup.find_all("td", class_="mobVTT"):
            t = cel.get_text(strip=True).lower()
            nxt = cel.find_next_sibling("td")
            v = _ava_num(nxt.get_text()) if nxt else None
            if v is None:
                continue
            if "pr" not in o and "precipitaci" in t and "hui" in t:
                o["pr"] = v
            elif "gust" not in o and re.search(r"r[àa]fega|racha", t) and re.search(r"m[àa]xima", t):
                o["gust"] = v
        return {k: v for k, v in o.items() if v is not None} or None

    return _run("AVAMET", one, stations, 4)


# ------------------------------------------------------------------
def _run(name, fn, stations, workers):
    out = {}
    for st, r in pmap(fn, stations, workers=workers):
        if r:
            out[st["id"]] = r
    n = sum(1 for r in out.values() if not r.get("off"))
    log(f"  {name}: {n}/{len(stations)} con datos")
    return out
