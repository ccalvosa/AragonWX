#!/usr/bin/env python3
"""
Relé del SAIH Ebro.

saihebro.com no acepta conexiones desde GitHub Actions. Este script se ejecuta en
una máquina que sí llega al SAIH (la del script antiguo, un PC, una Raspberry…),
descarga los datos crudos (señales de los mapas + tabla de pluviometrías) y los
publica en la rama «saih» del repositorio, que lee el workflow.

    python -m aragonwx.saih_relay --push            # una vez
    */10 * * * * cd /ruta/AragonWX/scraper && python3 -m aragonwx.saih_relay --push >> /tmp/saih_relay.log 2>&1

Necesita que esa máquina pueda hacer push al repo (clave SSH con permiso de
escritura o un token en la URL de --remote).
"""

import argparse
import shutil
import subprocess
import tempfile
from pathlib import Path

from .common import dump_json, log
from .sources import saih

REMOTE = "git@github.com:ccalvosa/AragonWX.git"


def push(path, remote):
    tmp = Path(tempfile.mkdtemp(prefix="saih_relay_"))
    try:
        shutil.copy(path, tmp / "saih_raw.json")
        run = lambda *a: subprocess.run(["git", *a], cwd=tmp, check=True, capture_output=True, text=True)
        run("init", "-q")
        run("checkout", "-q", "-b", "saih")
        run("add", ".")
        run("-c", "user.name=saih-relay", "-c", "user.email=saih-relay@users.noreply.github.com",
            "commit", "-q", "-m", "saih: datos crudos [relé]")
        run("push", "-q", "-f", remote, "saih")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path(tempfile.gettempdir()) / "saih_raw.json")
    ap.add_argument("--push", action="store_true", help="publicar en la rama saih")
    ap.add_argument("--remote", default=REMOTE)
    a = ap.parse_args()
    raw = saih.download_raw()
    if not raw:
        raise SystemExit("El SAIH no responde desde esta máquina; no se publica nada.")
    dump_json(a.out, raw)
    log(f"SAIH: {len(raw['tags'])} señales, {len(raw['pluvio']) // 2} pluviómetros -> {a.out}")
    if a.push:
        push(a.out, a.remote)
        log("publicado en la rama saih")


if __name__ == "__main__":
    main()
