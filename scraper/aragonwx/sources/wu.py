"""
Weather Underground (api.weather.com).

  observations/current  en cada pasada: temperatura, humedad, viento, lluvia del día
  dailysummary/7day     cada 30 min (y siempre antes de medianoche): máx, mín, racha

La clave pública de la web de WU cambia de vez en cuando: se prueba la guardada
en el estado, después WU_API_KEY (secreto opcional) y la de reserva; si ninguna
vale, se busca una nueva en la propia web.
"""

import os
import re
from datetime import datetime

from ..common import TZ, log, num, pmap, session

CURR = "https://api.weather.com/v2/pws/observations/current"
DAILY = "https://api.weather.com/v2/pws/dailysummary/7day"
FALLBACK_KEY = "ff90f212a6984a7390f212a698ea73cc"   # la que usa la web de WU (nov 2026)
DAILY_EVERY = 1800


def _params(cod, key):
    return {"stationId": cod, "format": "json", "units": "m", "numericPrecision": "decimal", "apiKey": key}


def _key_ok(s, key, cod):
    try:
        r = s.get(CURR, params=_params(cod, key), timeout=10)
        return r.status_code in (200, 204)
    except Exception:
        return False


def find_key(s, ctx, test_ids):
    cands = [ctx["state"].get("wu_key"), os.environ.get("WU_API_KEY"), FALLBACK_KEY]
    cands = [k for i, k in enumerate(cands) if k and k not in cands[:i]]
    test = test_ids[:3]
    for k in cands:
        if any(_key_ok(s, k, c) for c in test):
            return k
    for url in ["https://www.wunderground.com/dashboard/pws/" + test[0], "https://www.wunderground.com/"]:
        try:
            html = s.get(url, timeout=20).text
        except Exception:
            continue
        for k in dict.fromkeys(re.findall(r"apiKey=([a-f0-9]{32})", html) +
                               re.findall(r'"apiKey"\s*:\s*"([a-f0-9]{32})"', html)):
            if any(_key_ok(s, k, c) for c in test):
                return k
    return None


def fetch(stations, ctx):
    s = session()
    ids = [st["id"] for st in stations]
    if not ids:
        return {}
    key = find_key(s, ctx, ids)
    if not key:
        log("  WU: ninguna API key válida")
        return {}
    ctx["state"]["wu_key"] = key
    now = ctx["now"]
    loc = datetime.now(TZ)
    last_daily = ctx["state"].get("wu_daily_ts", 0)
    want_daily = now - last_daily >= DAILY_EVERY or (loc.hour == 23 and loc.minute >= 40)
    cache = ctx["state"].setdefault("wu_daily", {})
    today = loc.strftime("%Y-%m-%d")

    def one(cod):
        r = {}
        c = s.get(CURR, params=_params(cod, key), timeout=10)
        if c.status_code == 204:
            return {"off": True}
        if c.status_code == 200:
            o = (c.json().get("observations") or [{}])[0]
            m = o.get("metric") or {}
            r["t"] = o.get("epoch")
            r["ta"] = num(m.get("temp"))
            r["hr"] = num(o.get("humidity"))
            r["ws"] = num(m.get("windSpeed"))
            r["wg"] = num(m.get("windGust"))
            r["pr"] = num(m.get("precipTotal"))
            r["pres"] = num(m.get("pressure"))
        if want_daily:
            d = s.get(DAILY, params=_params(cod, key), timeout=10)
            if d.status_code == 200:
                for sm in reversed(d.json().get("summaries", [])):
                    if str(sm.get("obsTimeLocal", "")).startswith(today):
                        m = sm.get("metric") or {}
                        r["_daily"] = {"day": today, "tx": num(m.get("tempHigh")), "tn": num(m.get("tempLow")),
                                       "gust": num(m.get("windgustHigh"))}
                        break
        return r

    out = {}
    for cod, r in pmap(one, ids, workers=10):
        if r is None:
            continue
        daily = r.pop("_daily", None)
        if daily:
            cache[cod] = daily
        daily = cache.get(cod)
        if daily and daily.get("day") == today:
            for k in ("tx", "tn", "gust"):
                if daily.get(k) is not None:
                    r[k] = daily[k]
        out[cod] = r
    if want_daily:
        ctx["state"]["wu_daily_ts"] = now
    for k in [k for k, v in cache.items() if v.get("day") != today]:
        del cache[k]
    log(f"  WU: {sum(1 for r in out.values() if r.get('ta') is not None)}/{len(ids)} con temperatura"
        f" · resumen diario {'sí' if want_daily else 'no'}")
    return out
