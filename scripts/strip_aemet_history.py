#!/usr/bin/env python3
"""
Quita de history/AAAA-MM.json las estaciones de AEMET: su histórico oficial lo
sirve aemet-explorer y la web lo lee de allí (js/aemethist.js).

    python scripts/strip_aemet_history.py --history-dir history
"""

import argparse
import csv
import json
from pathlib import Path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--history-dir", type=Path, default=Path("history"))
    ap.add_argument("--stations", type=Path, default=Path("config/stations.csv"))
    a = ap.parse_args()
    aemet = {r["id"] for r in csv.DictReader(open(a.stations, encoding="utf-8")) if r["source"] == "AEMET"}
    for p in sorted(a.history_dir.glob("*.json")):
        doc = json.load(open(p, encoding="utf-8"))
        before = len(doc["data"])
        doc["data"] = {k: v for k, v in doc["data"].items() if k not in aemet}
        if len(doc["data"]) != before:
            json.dump(doc, open(p, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
            print(f"{p.name}: {before - len(doc['data'])} estaciones de AEMET quitadas")


if __name__ == "__main__":
    main()
