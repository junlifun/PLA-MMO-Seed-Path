# -*- mode: python ; coding: utf-8 -*-
"""Small standalone launcher for the vendor Seed collector."""

from pathlib import Path

ROOT = Path(SPECPATH).parent

a = Analysis(
    [str(ROOT / "build" / "seed_helper.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[],
    hiddenimports=[
        "queue", "urllib", "urllib.error", "urllib.request",
        "argparse", "collections", "hashlib", "json", "re", "shutil",
        "subprocess", "threading", "time", "unicodedata",
    ],
    excludes=["tkinter", "webview", "flask", "z3", "esptool", "usb"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="seed-helper",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="seed-helper",
)
