"""Report the wireless boards this computer can see, as one JSON line.

Runs inside the slim Pokeldn source runtime (or the full build).  The full
build exposes ``gui.board``; the slim runtime only ships the radio package, so
fall back to ``pokeldn.ldn.esp32.Radio`` there.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

try:
    from gui.board import identify, ports  # type: ignore
except Exception:  # slim runtime: no GUI package
    from serial.tools import list_ports

    def ports():
        return list_ports.comports()

    def identify(device: str):
        from pokeldn.ldn.esp32 import Radio

        radio = Radio.open_serial(device, baud=115200, fast_baud=921600)
        try:
            info = radio.info
            if info is None:
                raise RuntimeError("board did not answer HELLO")
            return SimpleNamespace(
                firmware=info.text,
                firmware_version=info.firmware_version,
                protocol=info.version,
                chip=info.target,
                current=False,
            )
        finally:
            radio.close()


def main() -> int:
    found = []
    for port in ports():
        item = {
            "port": port.device,
            "bridge": getattr(port, "bridge", ""),
            "native": bool(getattr(port, "native", False)),
        }
        try:
            info = identify(port.device)
        except Exception as exc:  # busy, unplugged, wrong firmware, ...
            item["error"] = f"{type(exc).__name__}: {exc}"
        else:
            item.update({
                "firmware": getattr(info, "firmware", ""),
                "version": getattr(info, "firmware_version", ""),
                "protocol": getattr(info, "protocol", None),
                "chip": getattr(info, "chip", ""),
                "current": bool(getattr(info, "current", False)),
            })
        found.append(item)
    print(json.dumps({"ok": True, "ports": found}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
