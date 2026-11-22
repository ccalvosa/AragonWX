#!/usr/bin/env python3
"""
Rellena history/AAAA-MM.json con los resúmenes diarios de Weather Underground
(máxima, mínima, lluvia y racha) de las estaciones WU activas de la red.

    cd scraper && python ../scripts/backfill_wu.py --since 2024-01 --history-dir ../history

Una petición por estación y mes (v2/pws/history/daily, rango de fechas). Los
valores de WU sustituyen a los que hubiera de ese día para esa estación (son el
resumen completo del día según la propia estación). El mes en curso se salta
(lo va cerrando el bucle cada noche), salvo con --include-current, que lo rellena
hasta ayer (útil si el bucle no ha cerrado todos sus días).
"""

import argparse
import calendar
import json
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scraper"))
from aragonwx.common import dump_json, load_json, load_stations, log, num, pmap, session  # noqa: E402
from aragonwx.sources.wu import FALLBACK_KEY  # noqa: E402

URL = "https://api.weather.com/v2/pws/history/daily"


def months(since, until):
    y, m = map(int, since.split("-"))
    while (y, m) < until:
        yield y, m
        m += 1
        if m > 12:
            y, m = y + 1, 1


def fetch_month(s, sid, y, m):
    last = calendar.monthrange(y, m)[1]
    for k in range(3):
        r = s.get(URL, params={"stationId": sid, "format": "json", "units": "m", "numericPrecision": "decimal",
                               "startDate": f"{y}{m:02d}01", "endDate": f"{y}{m:02d}{last}", "apiKey": FALLBACK_KEY},
                  timeout=30)
        if r.status_code == 204:
            return {}
        if r.status_code == 429:
            time.sleep(10 * (k + 1))
            continue
        r.raise_for_status()
        out = {}
        for o in r.json().get("observations", []):
            d, mt = o.get("obsTimeLocal", "")[:10], o.get("metric") or {}
            vals = [num(mt.get("tempHigh")), num(mt.get("tempLow")), num(mt.get("precipTotal")), num(mt.get("windgustHigh"))]
            if d and any(v is not None for v in vals):
                out[d] = vals
        return out
    raise RuntimeError("429 persistente")


def write_month(path, y, m, rows):
    mon = f"{y}-{m:02d}"
    days = [f"{mon}-{d:02d}" for d in range(1, calendar.monthrange(y, m)[1] + 1)]
    doc = load_json(path) or {"month": mon, "days": days, "vars": ["x", "n", "p", "w"], "data": {}}
    n = 0
    for sid, byday in rows.items():
        st = doc["data"].setdefault(sid, {})
        for d, vals in byday.items():
            if d not in days:
                continue
            k = days.index(d)
            for key, v in zip("xnpw", vals):
                if v is None:
                    continue
                st.setdefault(key, [None] * len(days))[k] = v
                n += 1
        if not st:
            del doc["data"][sid]
    dump_json(path, doc)
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2024-01")
    ap.add_argument("--history-dir", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--include-current", action="store_true", help="rellenar también el mes en curso hasta ayer")
    a = ap.parse_args()
    ids = [st["id"] for st in load_stations() if st["source"] == "WU" and st["active"]]
    today = date.today()
    s = session()
    t0 = time.time()
    until = (today.year, today.month + 1) if a.include_current else (today.year, today.month)
    if until[1] > 12:
        until = (until[0] + 1, 1)
    for y, m in months(a.since, until):
        res = pmap(lambda sid: fetch_month(s, sid, y, m), ids, workers=a.workers)
        rows = {sid: {d: v for d, v in r.items() if d < today.isoformat()} for sid, r in res if r}
        rows = {sid: r for sid, r in rows.items() if r}
        fails = sum(1 for _, r in res if r is None)
        n = write_month(a.history_dir / f"{y}-{m:02d}.json", y, m, rows)
        log(f"{y}-{m:02d}: {len(rows)} estaciones con datos, {n} valores, {fails} fallos · {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
