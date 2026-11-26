# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the main Windows application."""

from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

ROOT = Path(SPECPATH).parent

datas = [
    (str(ROOT / "templates"), "templates"),
    (str(ROOT / "static"), "static"),
    (str(ROOT / "offline_engine"), "offline_engine"),
    (str(ROOT / "vendor"), "vendor"),
    (str(ROOT / "LICENSE"), "."),
    (str(ROOT / "LICENSES.md"), "."),
    (str(ROOT / "README.md"), "."),
]

hiddenimports = []
binaries = []
hiddenimports += collect_submodules("offline_engine")
hiddenimports += collect_submodules("pla")
hiddenimports += collect_submodules("webview")
hiddenimports += [
    "webview.platforms.edgechromium",
    "serial.tools.list_ports",
    "usb",
    "usb.core",
    "usb.backend.libusb1",
    "esptool",
    "PIL",
]

for package in ("z3", "webview", "esptool", "usb", "serial"):
    try:
        package_datas, package_binaries, package_hidden = collect_all(package)
        datas += package_datas
        binaries += package_binaries
        hiddenimports += package_hidden
    except Exception:
        pass

# collect_all results for binaries need a stable variable for Analysis.
datas += collect_data_files("webview")
datas += collect_data_files("esptool")

a = Analysis(
    [str(ROOT / "app.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "IPython"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="PLA-MMO-Seed-Path",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    icon=str(ROOT / "static" / "app.ico"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="PLA-MMO-Seed-Path",
)
