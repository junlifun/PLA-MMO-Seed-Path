"""Guided ESP32-S3 firmware flashing for the wireless board.

The flasher is intentionally thin: serial-port discovery is done with pyserial,
and the actual write goes through the official ``esptool`` module in a child
process.  No firmware is bundled here; the resource manager downloads
``pokeldn-radio-s3.bin`` first.
"""

from __future__ import annotations

import importlib.util
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

from pla_mmo.paths import get_project_root

BOARD_VIDS = {0x303A, 0x10C4, 0x1A86, 0x0403}
BOARD_HINTS = ("esp32", "cp210", "ch340", "ch341", "usb-serial", "silicon labs", "espressif")
PERCENT_RE = re.compile(r"(\d{1,3})\s*%")


class BoardFlashError(RuntimeError):
    pass


class BoardFlasher:
    def __init__(self, project_root: Path | None = None, seed_link=None):
        self.root = Path(project_root or get_project_root())
        self.firmware = self.root / "cache" / "firmware" / "pokeldn-radio-s3.bin"
        self.seed_link = seed_link
        self._lock = threading.RLock()
        self._state = {
            "status": "idle",
            "percent": 0,
            "message": "尚未开始",
            "error": "",
            "log": [],
            "port": "",
            "finished_at": 0,
        }

    # ------------------------------------------------------------- discovery
    def _serial_ports(self) -> tuple[list[dict], str]:
        try:
            from serial.tools import list_ports
        except ImportError:
            return [], "缺少 pyserial，无法检测串口。"
        ports = []
        for port in list_ports.comports():
            vid = getattr(port, "vid", None)
            description = str(getattr(port, "description", "") or "")
            hwid = str(getattr(port, "hwid", "") or "")
            haystack = f"{description} {hwid}".lower()
            suitable = (vid in BOARD_VIDS) or any(hint in haystack for hint in BOARD_HINTS)
            ports.append({
                "port": str(port.device),
                "description": description or str(port.device),
                "hwid": hwid,
                "vid": vid,
                "pid": getattr(port, "pid", None),
                "suitable": bool(suitable),
            })
        return ports, ""

    def status(self, probe: dict | None = None) -> dict:
        ports, serial_error = self._serial_ports()
        probe = probe or {}
        board = probe.get("board") or {}
        flashed_port = str(board.get("port") or "")
        for port in ports:
            port["flashed"] = bool(flashed_port and port["port"].lower() == flashed_port.lower())
        candidates = [port for port in ports if port["suitable"]]
        selected = next((port for port in candidates if port["flashed"]), candidates[0] if candidates else None)
        needs_flash = bool(candidates and not flashed_port)
        esptool_ready = importlib.util.find_spec("esptool") is not None
        firmware_ready = self.firmware.is_file() and self.firmware.stat().st_size > 0
        if serial_error:
            message = serial_error
        elif not candidates:
            message = "未检测到 ESP32 无线板。"
        elif flashed_port:
            message = f"已识别到已烧录板子：{flashed_port}"
        else:
            message = f"检测到候选板子 {selected['port']}，但未识别到已烧录固件。"
        return {
            "ok": True,
            "ports": ports,
            "candidates": candidates,
            "selected": selected,
            "needs_flash": needs_flash,
            "flashed_port": flashed_port,
            "firmware_ready": firmware_ready,
            "firmware": str(self.firmware),
            "esptool": esptool_ready,
            "pyserial": not bool(serial_error),
            "probe": probe,
            "message": message,
            "flash": self.snapshot(),
        }

    def snapshot(self) -> dict:
        with self._lock:
            return {
                **self._state,
                "log": list(self._state.get("log") or [])[-80:],
            }

    # --------------------------------------------------------------- flashing
    def start(self, port: str) -> dict:
        port = str(port or "").strip()
        if not port:
            raise BoardFlashError("请选择串口。")
        if not self.firmware.is_file() or self.firmware.stat().st_size == 0:
            raise BoardFlashError("烧录固件尚未下载，请先在资源管理下载 ESP32-S3 固件。")
        if importlib.util.find_spec("esptool") is None:
            raise BoardFlashError("缺少 esptool。请先安装烧录依赖：python -m pip install esptool pyserial")
        ports, error = self._serial_ports()
        if error:
            raise BoardFlashError(error)
        if not any(item["port"].lower() == port.lower() and item["suitable"] for item in ports):
            raise BoardFlashError(f"当前没有可用的 ESP32 串口：{port}")
        with self._lock:
            if self._state.get("status") == "running":
                raise BoardFlashError("烧录正在进行中。")
            self._state = {
                "status": "running",
                "percent": 0,
                "message": "正在准备烧录…",
                "error": "",
                "log": [f"目标串口：{port}", f"固件：{self.firmware}"],
                "port": port,
                "finished_at": 0,
            }
            thread = threading.Thread(target=self._worker, args=(port,), name="board-flasher", daemon=True)
            thread.start()
        return {"ok": True, "started": True, "flash": self.snapshot()}

    def _append(self, line: str) -> None:
        line = str(line or "").rstrip()
        if not line:
            return
        with self._lock:
            log = self._state.setdefault("log", [])
            log.append(line)
            del log[:-120]
            match = PERCENT_RE.search(line)
            if match:
                self._state["percent"] = max(0, min(100, int(match.group(1))))
            if "Writing at" in line or "Hash of data verified" in line:
                self._state["message"] = line

    def _worker(self, port: str) -> None:
        try:
            import esptool
            major = int(str(getattr(esptool, "__version__", "4")).split(".", 1)[0])
        except Exception:
            major = 4
        write_command = "write-flash" if major >= 5 else "write_flash"
        before = "default-reset" if major >= 5 else "default_reset"
        after = "hard-reset" if major >= 5 else "hard_reset"
        command = [
            sys.executable, "-m", "esptool",
            "--chip", "esp32s3",
            "--port", port,
            "--baud", "921600",
            "--before", before,
            "--after", after,
            write_command, "-z", "0x0", str(self.firmware),
        ]
        creation_flags = 0
        if os.name == "nt":
            creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            with self._lock:
                self._state["message"] = "正在连接板子…"
            process = subprocess.Popen(
                command,
                cwd=str(self.root),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=creation_flags,
            )
            assert process.stdout is not None
            for line in process.stdout:
                self._append(line)
            code = process.wait()
            if code != 0:
                raise BoardFlashError(f"esptool 退出码 {code}，请查看烧录日志。")
            with self._lock:
                self._state.update({
                    "status": "success",
                    "percent": 100,
                    "message": "烧录完成，板子已重启。",
                    "finished_at": time.time(),
                })
        except Exception as exc:  # noqa: BLE001 - surfaced in the UI
            with self._lock:
                self._state.update({
                    "status": "failed",
                    "message": "烧录失败。",
                    "error": str(exc),
                    "finished_at": time.time(),
                })
