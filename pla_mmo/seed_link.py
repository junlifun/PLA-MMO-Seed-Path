"""One-click Nintendo Switch link + MMO Seed collection for the path finder.

The collector is the tested ``PLA-MMO-Seed-Finder`` workflow.  It runs inside a
bundled pokeldn runtime (an independent process), so this module only has to
start it, stream its output, and hand the resulting Seed to ``SeedManager``.

Nothing here imports pokeldn: the slim runtime (upstream source packages) is
executed by this tool's Python in an independent process, with the full
``pokeldn.exe --run`` build kept only as a fallback. That keeps the Flask
process free of pyserial, trio and the LDN stack, and a failed collection
cannot take the UI down.
"""
from __future__ import annotations

import atexit
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime
from pathlib import Path

from pla_mmo.seed_reader import validate_seed


PLUGIN_ID = "junli-pla-mmo-seed"
DEFAULT_CHANNEL = 6
DEFAULT_SECONDS = 1800
MIN_SECONDS = 120
MAX_SECONDS = 3600
LOG_LIMIT = 500
# Board probing starts a short-lived Python/LDN process (about 7 s on Windows).
# Keep a successful discovery warm so repeated Start clicks do not pay that cost
# again; an error is cached only briefly so a newly plugged board is retried.
PROBE_READY_TTL = 120.0
PROBE_ERROR_TTL = 15.0


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _tail_text(path: Path, limit: int = 200) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()[:limit]
    except OSError:
        return ""


class LinkLogParser:
    """Translate the collector's stdout into a small UI state machine."""

    SEED_RE = re.compile(r"【最终群体 Seed】\s*(\d{15,20})")
    COUNT_RE = re.compile(r"第\s*(\d+)\s*/\s*4\s*只")
    SAVED_RE = re.compile(r"已收录\s*(\d+)\s*/\s*4")
    STOPPED_RE = re.compile(r"已手动停止采集[：:].*?(\d+)\s*/\s*4")
    ENTITY_RE = re.compile(r"Checking entity\s+(\d+)\s*/\s*4", re.IGNORECASE)
    PERCENT_RE = re.compile(r"Searching\.\.\.\s*(\d+(?:\.\d+)?)\s*%", re.IGNORECASE)
    PROGRESS_RE = re.compile(r"^\[progress\]\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$")

    def __init__(self, idle: bool = False) -> None:
        self.count = 0
        self.seed: str | None = None
        self.entity = 0
        self.percent = 0.0
        self.stage = "idle" if idle else "starting"
        self.status = "尚未开始" if idle else "正在启动采集…"
        self.errors: list[str] = []
        self.pokemon = [
            {"title": "", "lines": [], "chips": [], "image": "", "tone": "info"}
            for _ in range(4)
        ]
        self.tone = "info"
        self.connected = False

    # -- helpers ---------------------------------------------------------
    def _set_stage(self, stage: str, status: str) -> None:
        self.stage = stage
        self.status = status

    def _add_error(self, message: str) -> None:
        message = (message or "").strip()
        if not message:
            return
        if not self.errors or self.errors[-1] != message:
            self.errors.append(message)
            del self.errors[:-8]

    def _panel(self, payload: dict) -> None:
        card = str(payload.get("id") or "")
        if card == "seed-capture":
            self.tone = str(payload.get("tone") or "info")
            for line in payload.get("lines") or []:
                if isinstance(line, (list, tuple)) and len(line) >= 2 and line[0] == "状态":
                    self.status = str(line[1])
            for chip in payload.get("chips") or []:
                if isinstance(chip, (list, tuple)) and len(chip) >= 2 and chip[0] == "收录":
                    match = re.search(r"(\d+)\s*/\s*4", str(chip[1]))
                    if match:
                        self.count = max(0, min(4, int(match.group(1))))
            if self.count and self.stage in ("starting", "waiting"):
                self.stage = "collecting"
        elif card.startswith("seed-mon-"):
            try:
                index = int(card.rsplit("-", 1)[1]) - 1
            except (IndexError, ValueError):
                return
            while len(self.pokemon) <= index:
                self.pokemon.append({})
            entry = self.pokemon[index]
            entry["title"] = str(payload.get("title") or "")
            entry["tone"] = str(payload.get("tone") or "info")
            entry["image"] = str(payload.get("image") or "")
            entry["lines"] = [self._line_parts(line) for line in (payload.get("lines") or [])]
            entry["chips"] = [
                {"label": str(chip[0]), "value": str(chip[1])}
                for chip in (payload.get("chips") or [])
                if isinstance(chip, (list, tuple)) and len(chip) >= 2
            ]

    @staticmethod
    def _line_parts(line) -> dict:
        """Normalize one panel line into a left label and a right value."""
        if isinstance(line, (list, tuple)):
            label = str(line[0]) if line else ""
            value = str(line[1]) if len(line) > 1 else ""
        else:
            label, value = "", str(line)
        value = value.strip("\t \u3000")
        # The panel's two columns are sometimes separated by a single space in
        # the JSON copy. Recognise the two stable right-hand groups directly.
        tid_sid = re.search(r"\s(\d{5,7}\s*/\s*\d{3,5})$", value)
        if tid_sid:
            return {
                "label": value[:tid_sid.start()].strip(),
                "value": tid_sid.group(1).strip(),
            }
        ability_size = re.search(r"\s+([^\s]+(?:\s*·\s*[A-Za-z—\-]+))$", value)
        if ability_size and "个体值" in value:
            return {
                "label": value[:ability_size.start()].strip(),
                "value": ability_size.group(1).strip(),
            }
        # Four moves arrive as "move · move move · move"; split between the two
        # pairs when the separator is a single space.
        moves = re.match(r"^(.+?\s·\s.+?)\s+(.+?\s·\s.+)$", value)
        if moves and "个体值" not in value:
            return {
                "label": moves.group(1).strip(),
                "value": moves.group(2).strip(),
            }
        parts = re.split(r"[\t\u3000]{2,}|\s{3,}", value, maxsplit=1)
        if len(parts) == 2:
            return {
                "label": (label or parts[0]).strip(),
                "value": parts[1].strip(),
            }
        return {"label": label.strip(), "value": parts[0].strip()}

    # -- public ----------------------------------------------------------
    def feed(self, line: str) -> None:
        line = line.rstrip("\r\n")
        if not line:
            return
        stripped = line.strip()

        if stripped.startswith("[panel]"):
            try:
                payload = json.loads(stripped[len("[panel]"):].strip())
            except (json.JSONDecodeError, ValueError):
                return
            if isinstance(payload, dict):
                self._panel(payload)
            return

        match = self.PROGRESS_RE.match(stripped)
        if match:
            done = int(match.group(1))
            total = int(match.group(2)) or 4
            if total == 4:
                self.count = max(self.count, min(4, done))
            return

        seed = self.SEED_RE.search(stripped)
        if seed:
            self.seed = seed.group(1)
            self.stage = "done"
            self.tone = "ok"
            self.status = "已找到群体 Seed。"
            return

        match = self.ENTITY_RE.search(stripped)
        if match:
            self.entity = max(1, min(4, int(match.group(1))))
            self.stage = "solving"
            self.status = f"正在反推 Seed · 第 {self.entity}/4 只"
            return

        match = self.PERCENT_RE.search(stripped)
        if match:
            try:
                self.percent = max(0.0, min(100.0, float(match.group(1))))
            except ValueError:
                pass
            self.stage = "solving"
            self.status = f"正在反推 Seed · 第 {max(1, self.entity)}/4 只 · {self.percent:.0f}%"
            return

        match = self.STOPPED_RE.search(stripped)
        if match:
            self.count = max(0, min(4, int(match.group(1))))
            self.stage = "stopped"
            self.tone = "warning"
            self.status = f"已停止采集，当前收录 {self.count}/4。"
            return

        if "已启动阿尔宙斯 MMO Seed 采集" in stripped:
            self._set_stage("waiting", "等待 Switch 连接…")
        elif "Switch 已连接" in stripped or "已连接，请选择" in stripped:
            self.connected = True
            self._set_stage("collecting", "Switch 已连接，请选择第一只最初捕获的宝可梦。")
        elif "已准备四只初始捕获记录" in stripped or "开始反推群体 Seed" in stripped:
            self._set_stage("solving", "四只已收齐，正在反推 Seed…")
        elif "已收录 4/4" in stripped:
            self.count = 4
            self._set_stage("solving", "四只已收齐，正在结束联机并反推 Seed…")
        elif "计算成功" in stripped and "最终群体 Seed" not in stripped:
            self._set_stage("done", "Seed 计算成功。")
            self.tone = "ok"
        elif "没有找到群体 Seed" in stripped:
            self._add_error("EtumrepMMO 没有找到群体 Seed。请确认四只来自同一次群体，且都是最初捕获。")
            self._set_stage("failed", "没有找到群体 Seed。")
            self.tone = "error"
        elif "计算失败" in stripped:
            self._add_error(stripped)
            self._set_stage("failed", "Seed 计算失败。")
            self.tone = "error"
        elif "联机主程序失败" in stripped or "联机采集意外结束" in stripped:
            self._add_error(stripped)
            self._set_stage("failed", "联机采集失败。")
            self.tone = "error"
        elif "等待时间结束" in stripped:
            self._add_error("等待时间结束，还没有收齐四只。")
            self._set_stage("failed", "等待时间结束，未收齐四只。")
            self.tone = "warning"
        elif stripped.startswith("[Seed] 失败："):
            self._add_error(stripped)
            self._set_stage("failed", "采集失败。")
            self.tone = "error"
        elif "已识别交换确认页面中的第" in stripped:
            match = self.COUNT_RE.search(stripped)
            if match:
                self.count = max(0, min(4, int(match.group(1))))
            self._set_stage("collecting", f"已收录 {self.count}/4 只，继续选择下一只。")
            self.tone = "ok" if self.count >= 4 else "info"


class _WindowsJob:
    """A kill-on-close job object, so an orphaned EtumrepMMO dies with the app."""

    def __init__(self) -> None:
        self.handle = None
        self._kernel32 = None

    def create(self) -> bool:
        if os.name != "nt":
            return False
        try:
            import ctypes
            from ctypes import wintypes

            class IO_COUNTERS(ctypes.Structure):
                _fields_ = [
                    ("ReadOperationCount", ctypes.c_ulonglong),
                    ("WriteOperationCount", ctypes.c_ulonglong),
                    ("OtherOperationCount", ctypes.c_ulonglong),
                    ("ReadTransferCount", ctypes.c_ulonglong),
                    ("WriteTransferCount", ctypes.c_ulonglong),
                    ("OtherTransferCount", ctypes.c_ulonglong),
                ]

            class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
                _fields_ = [
                    ("PerProcessUserTimeLimit", ctypes.c_longlong),
                    ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD),
                ]

            class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
                _fields_ = [
                    ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                    ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t),
                ]

            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.CreateJobObjectW.restype = wintypes.HANDLE
            kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
            kernel32.SetInformationJobObject.restype = wintypes.BOOL
            kernel32.SetInformationJobObject.argtypes = [
                wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
            ]
            kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
            kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

            handle = kernel32.CreateJobObjectW(None, None)
            if not handle:
                return False
            info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            info.BasicLimitInformation.LimitFlags = 0x00002000  # KILL_ON_JOB_CLOSE
            if not kernel32.SetInformationJobObject(
                handle, 9, ctypes.byref(info), ctypes.sizeof(info)
            ):
                kernel32.CloseHandle(handle)
                return False
            self.handle = handle
            self._kernel32 = kernel32
            return True
        except Exception:
            return False

    def assign(self, proc: subprocess.Popen[str]) -> None:
        if not self.handle or not self._kernel32:
            return
        try:
            import ctypes
            from ctypes import wintypes

            self._kernel32.AssignProcessToJobObject(
                self.handle, wintypes.HANDLE(int(proc._handle))
            )
        except Exception:
            pass

    def close(self) -> None:
        if not self.handle or not self._kernel32:
            return
        try:
            self._kernel32.CloseHandle(self.handle)
        except Exception:
            pass
        self.handle = None


class SeedLinkService:
    """Own the one collection subprocess allowed at a time."""

    def __init__(self, project_root: Path, settings_store, seed_manager) -> None:
        self.project_root = Path(project_root).resolve()
        self.settings_store = settings_store
        self.seed_manager = seed_manager

        self.runtime_dir = self.project_root / "cache" / "pokeldn-runtime"
        self.runtime_exe = self.runtime_dir / "pokeldn.exe"
        # The slim runtime is the upstream Pokeldn source packages (no GUI/Flet),
        # executed by the Python that already runs this tool. It is preferred when
        # present; the full one-click build remains a fallback.
        self.slim_dir = self.project_root / "cache" / "pokeldn-slim"
        self.slim_marker = self.slim_dir / "pokeldn" / "__init__.py"
        self.slim_python = self._slim_python()
        self.seed_helper = self.project_root / "helpers" / "seed-helper" / "seed-helper.exe"
        self.collector = self.project_root / "vendor" / "pla_mmo_seed" / "pla_mmo_seed.py"
        self.probe_script = self.project_root / "vendor" / "pla_mmo_seed" / "probe_board.py"
        self.cache_root = self.project_root / "cache"
        self.data_dir = self.cache_root / "pokeldn-data"
        self.plugin_data = self.data_dir / "plugin-data" / PLUGIN_ID
        self.latest_seed_path = self.plugin_data / "latest_seed.txt"
        self.solver_dir = self.cache_root / "etumrempmmo"
        self.keys_dir = self.cache_root / "keys"
        self._migrate_legacy_assets()

        self._lock = threading.RLock()
        self._probe_lock = threading.Lock()
        self._proc: subprocess.Popen[str] | None = None
        self._reader: threading.Thread | None = None
        self._job: _WindowsJob | None = None
        self._parser = LinkLogParser(idle=True)
        self._log: deque[str] = deque(maxlen=LOG_LIMIT)
        self._started_monotonic: float | None = None
        self._finished_monotonic: float | None = None
        self._started_at: str | None = None
        self._finished_at: str | None = None
        self._stop_requested = False
        self._probe_cache: dict = {}
        self._probe_checked_at: float = 0.0
        self._last_seed: str | None = None
        self._applied = False
        self._atexit_registered = False
        self._data_error = ""

        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            self.plugin_data.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            # The app must still start (and calculate paths) when the link data
            # folder is read-only; only the link feature is unavailable.
            self._data_error = f"无法创建联机数据目录：{exc}"
        atexit.register(self.shutdown)
        self._atexit_registered = True

    @staticmethod
    def _slim_python() -> Path:
        executable = Path(sys.executable)
        if executable.name.lower() == "pythonw.exe":
            console = executable.with_name("python.exe")
            if console.is_file():
                return console
        return executable

    def _slim_available(self) -> bool:
        return self.slim_marker.is_file() and self.slim_python.is_file()

    def _runtime_available(self) -> bool:
        return self._slim_available() or self.runtime_exe.is_file()

    def _runtime_command(self, script: Path, args: list[str] | None = None) -> list[str]:
        extra = list(args or [])
        if self._slim_available():
            if self.seed_helper.is_file() and getattr(sys, "frozen", False):
                return [str(self.seed_helper), str(script), *extra]
            if not getattr(sys, "frozen", False):
                return [str(self.slim_python), str(script), *extra]
        return [str(self.runtime_exe), "--run", str(script), *extra]

    def _migrate_legacy_assets(self) -> None:
        """Move resources from the old vendor/data layout into cache/ once."""
        legacy_runtime = self.project_root / "vendor" / "pokeldn-runtime"
        legacy_data = self.project_root / "data" / "pokeldn"
        legacy_solver = legacy_data / "plugin-data" / PLUGIN_ID / "solver"

        if not self.runtime_dir.exists() and legacy_runtime.is_dir():
            try:
                self.runtime_dir.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(legacy_runtime), str(self.runtime_dir))
            except OSError:
                pass
        if not self.data_dir.exists() and legacy_data.is_dir():
            try:
                self.data_dir.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(legacy_data), str(self.data_dir))
            except OSError:
                pass
        if not self.solver_dir.exists():
            for candidate in (self.plugin_data / "solver", legacy_solver):
                if candidate.is_dir() and candidate != self.solver_dir:
                    try:
                        self.solver_dir.parent.mkdir(parents=True, exist_ok=True)
                        shutil.move(str(candidate), str(self.solver_dir))
                        break
                    except OSError:
                        continue

        # If the old seed source pointed into data/pokeldn, follow the move.
        try:
            old_seed = legacy_data / "plugin-data" / PLUGIN_ID / "latest_seed.txt"
            new_seed = self.plugin_data / "latest_seed.txt"
            settings = self.settings_store.load()
            if str(settings.get("seed_file_path") or "") == str(old_seed) and new_seed.is_file():
                self.settings_store.update({"seed_file_path": str(new_seed)})
                try:
                    self.seed_manager.reload(confirm=True)
                except Exception:
                    pass
        except Exception:
            pass

    # -- settings --------------------------------------------------------
    def _settings(self) -> dict:
        try:
            return self.settings_store.load()
        except Exception:
            return {}

    def _pokeldn_settings(self) -> dict:
        appdata = os.environ.get("APPDATA")
        if not appdata:
            return {}
        return _read_json(Path(appdata) / "pokeldn" / "settings.json")

    def _expand(self, raw: str) -> str:
        value = str(raw or "").strip().strip('"').strip("'")
        if not value:
            return ""
        value = re.sub(r"%([^%]+)%", lambda m: os.environ.get(m.group(1), m.group(0)), value)
        value = os.path.expandvars(os.path.expanduser(value))
        return value

    def resolve_keys_path(self) -> tuple[Path | None, str]:
        settings = self._settings()
        raw = settings.get("link_keys_path") or self._pokeldn_settings().get("keys") or ""
        if raw:
            path = Path(self._expand(raw))
            if not path.is_file():
                return path, f"prod.keys 不存在：{path}"
            return path.resolve(), ""

        for candidate in (
            self.keys_dir / "prod.keys",
            self.data_dir / "prod.keys",
            self.project_root / "prod.keys",
        ):
            if candidate.is_file():
                return candidate.resolve(), ""
        return None, (
            "未设置 prod.keys 路径。请点「选择 prod.keys」，"
            f"或把 prod.keys 放到：{self.keys_dir / 'prod.keys'}"
        )

    def resolve_trainer(self) -> str:
        configured = str(self._settings().get("link_trainer") or "").strip()
        if configured.count("|") >= 4:
            return configured
        defaults = self._pokeldn_settings()
        ot = str(defaults.get("ot") or "POKELDN").replace("|", " ").strip() or "POKELDN"

        def number(name: str, fallback: int) -> int:
            try:
                return int(defaults.get(name, fallback))
            except (TypeError, ValueError):
                return fallback

        return "|".join((
            ot,
            str(number("tid", 0)),
            str(number("sid", 0)),
            str(number("language", 2)),
            str(number("gender", 0)),
        ))

    # -- environment -----------------------------------------------------
    def _find_solver(self) -> Path | None:
        if not self.solver_dir.is_dir():
            return None
        for pattern in (
            "EtumrepMMO.ConsoleApp.exe",
            "EtumrepMMO.exe",
            "EtumrepMMO.ConsoleApp.*.exe",
            "EtumrepMMO.*.exe",
        ):
            matches = sorted(self.solver_dir.rglob(pattern))
            if matches:
                return matches[0]
        return None

    def _environment(self) -> dict:
        settings = self._settings()
        keys, keys_error = self.resolve_keys_path()
        solver = self._find_solver()
        latest_seed = _tail_text(self.latest_seed_path)
        warnings = []
        if self._data_error:
            warnings.append(self._data_error)
        if not self._runtime_available():
            warnings.append("缺少 Pokeldn 联机运行环境，请在「设置 → 资源管理」下载或运行精简运行时准备。")
        if not self.collector.is_file():
            warnings.append(f"缺少采集脚本：{self.collector}")
        if keys is None or (not keys.is_file()):
            warnings.append(keys_error or "未设置 prod.keys。")
        if solver is None:
            warnings.append("缺少 EtumrepMMO 求解器，采满四只后无法立即反推。")
        return {
            "runtime_dir": str(self.slim_dir if self._slim_available() else self.runtime_dir),
            "runtime_ok": self._runtime_available(),
            "runtime_mode": "slim" if self._slim_available() else ("full" if self.runtime_exe.is_file() else ""),
            "runtime_python": str(self.slim_python) if self._slim_available() else "",
            "collector": str(self.collector),
            "collector_ok": self.collector.is_file(),
            "data_dir": str(self.data_dir),
            "plugin_data": str(self.plugin_data),
            "solver_dir": str(self.solver_dir),
            "solver": str(solver) if solver else "",
            "solver_ok": solver is not None,
            "keys_path": str(keys) if keys else "",
            "keys_ok": bool(keys and keys.is_file()),
            "keys_error": keys_error,
            "latest_seed": latest_seed,
            "latest_seed_path": str(self.latest_seed_path),
            "latest_seed_mtime": (
                datetime.fromtimestamp(self.latest_seed_path.stat().st_mtime).astimezone().isoformat(timespec="seconds")
                if self.latest_seed_path.is_file() else None
            ),
            "warnings": warnings,
            "configured_channel": int(settings.get("link_channel") or DEFAULT_CHANNEL),
            "configured_seconds": int(settings.get("link_seconds") or DEFAULT_SECONDS),
            "configured_board_port": str(settings.get("link_board_port") or "auto"),
        }

    def _base_env(self, port: str | None = None, managed: bool = True) -> dict:
        env = dict(os.environ)
        env.update({
            "POKELDN_DATA": str(self.data_dir),
            "PLA_SEED_SOLVER_DIR": str(self.solver_dir),
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            "PLA_SEED_OPEN_TXT": "0",
            "POKELDN_ESP32_BAUD": "921600",
        })
        if managed:
            # Closing our stdin is the graceful stop signal the collector knows.
            env["POKELDN_MANAGED_RUN"] = "1"
        else:
            # A probe closes stdin immediately; a managed run would interpret
            # that EOF as Ctrl-C and interrupt its own imports.
            env.pop("POKELDN_MANAGED_RUN", None)
        if self._slim_available():
            existing = str(env.get("PYTHONPATH") or "").strip()
            env["PYTHONPATH"] = str(self.slim_dir) + (os.pathsep + existing if existing else "")
            env["POKELDN_RUNTIME_DIR"] = str(self.slim_dir)
        env["POKELDN_RADIO"] = f"esp32:{port}" if port else "esp32:auto"
        return env

    # -- board probe -----------------------------------------------------
    def probe(self, force: bool = False, timeout: float = 30.0) -> dict:
        with self._probe_lock:
            if not force and self._probe_cache:
                age = time.monotonic() - self._probe_checked_at
                ttl = PROBE_READY_TTL if self._probe_cache.get("ready") else PROBE_ERROR_TTL
                if age < ttl:
                    return self._probe_cache

            environment = self._environment()
            result = {
                "ok": True,
                "ready": False,
                "checked_at": _now_iso(),
                "environment": environment,
                "ports": [],
                "board": None,
                "error": "",
            }
            if not self._runtime_available():
                result.update({"error": "缺少 Pokeldn 联机运行环境，请在「设置 → 资源管理」下载。"})
                self._probe_cache = result
                self._probe_checked_at = time.monotonic()
                return result
            if not self.probe_script.is_file():
                result.update({"error": "板子检测脚本缺失。"})
                self._probe_cache = result
                self._probe_checked_at = time.monotonic()
                return result

            cmd = self._runtime_command(self.probe_script)
            try:
                completed = subprocess.run(
                    cmd,
                    cwd=str(self.project_root),
                    env=self._base_env(managed=False),
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=timeout,
                    creationflags=(0x08000000 if os.name == "nt" else 0),
                )
            except subprocess.TimeoutExpired:
                result.update({"error": "检测无线板超时。请确认 ESP32 未被其他程序占用。"})
            except OSError as exc:
                result.update({"error": f"无法启动内置联机运行环境：{exc}"})
            else:
                payload = None
                for line in reversed((completed.stdout or "").splitlines()):
                    line = line.strip()
                    if line.startswith("{") and '"ports"' in line:
                        try:
                            payload = json.loads(line)
                        except json.JSONDecodeError:
                            payload = None
                        if payload is not None:
                            break
                if payload is None:
                    result.update({
                        "error": "无法读取无线板信息。请确认固件已烧录，且没有其他程序占用串口。",
                        "output": (completed.stdout or "")[-2000:],
                    })
                else:
                    ports = payload.get("ports") or []
                    result["ports"] = ports
                    board, board_error = self._choose_board(ports)
                    result["board"] = board
                    if board is None:
                        result["error"] = board_error
                    else:
                        result["ready"] = True
            self._probe_cache = result
            self._probe_checked_at = time.monotonic()
            return result

    def _choose_board(self, ports: list[dict]) -> tuple[dict | None, str]:
        if not isinstance(ports, list) or not ports:
            return None, "未检测到无线板。请插好 ESP32-S3 的 USB 数据线，并确认固件已烧录。"
        configured = str(self._settings().get("link_board_port") or "auto").strip()
        if configured and configured.lower() != "auto":
            for port in ports:
                if str(port.get("port") or "").lower() == configured.lower():
                    return port, ""
            return None, f"设置中指定的串口 {configured} 不在当前设备列表。"

        candidates = [
            port for port in ports
            if not port.get("error")
            and (str(port.get("chip") or "").upper().startswith("ESP32")
                 or "espressif" in str(port.get("bridge") or "").lower())
            and int(port.get("protocol") or 0) == 1
        ]
        if not candidates:
            errors = [str(p.get("error")) for p in ports if p.get("error")]
            detail = f"（{errors[0]}）" if errors else ""
            return None, f"未检测到已烧录无线固件的 ESP32-S3{detail}。"
        current = [port for port in candidates if port.get("current")]
        return (current or candidates)[0], ""

    # -- lifecycle -------------------------------------------------------
    def _snapshot_locked(self) -> dict:
        running = self._proc is not None and self._proc.poll() is None
        parser = self._parser
        if self._started_monotonic:
            end = self._finished_monotonic or time.monotonic()
            elapsed = max(0, int(end - self._started_monotonic))
        else:
            elapsed = 0
        return {
            "ok": True,
            "running": running,
            "phase": parser.stage,
            "status": parser.status,
            "count": parser.count,
            "entity": parser.entity,
            "percent": round(parser.percent, 1),
            "seed": parser.seed or self._last_seed,
            "applied": self._applied,
            "error": parser.errors[-1] if parser.errors else "",
            "errors": list(parser.errors),
            "tone": parser.tone,
            "connected": parser.connected,
            "pokemon": list(parser.pokemon),
            "started_at": self._started_at,
            "finished_at": self._finished_at,
            "elapsed_seconds": elapsed,
            "stop_requested": self._stop_requested,
            "log": self._visible_log(),
            "environment": self._environment(),
            "probe": {
                "checked_at": self._probe_cache.get("checked_at"),
                "ok": self._probe_cache.get("ok"),
                "error": self._probe_cache.get("error", ""),
                "ports": self._probe_cache.get("ports", []),
                "board": self._probe_cache.get("board"),
            } if self._probe_cache else None,
            "paths": {
                "latest_seed": str(self.latest_seed_path),
                "solver": str(self._find_solver() or ""),
            },
            "settings": {
                "channel": int(self._settings().get("link_channel") or DEFAULT_CHANNEL),
                "seconds": int(self._settings().get("link_seconds") or DEFAULT_SECONDS),
            },
        }

    def _visible_log(self) -> list[str]:
        """Keep the panel/progress protocol noise out of the user-facing log."""
        hidden = ("[panel]", "[progress]", "[Seed 界面]")
        return [
            line for line in self._log
            if not line.startswith(hidden) and line.strip() != "Press [ENTER] to exit."
        ][-250:]

    def snapshot(self) -> dict:
        with self._lock:
            return self._snapshot_locked()

    def environment(self) -> dict:
        """Static paths and prerequisites, without touching the serial port."""
        return self._environment()

    def pokemon_image(self, index: int) -> Path | None:
        """Return one card's cached image, limited to this tool's plugin data."""
        with self._lock:
            if not 0 <= index < len(self._parser.pokemon):
                return None
            raw = str(self._parser.pokemon[index].get("image") or "").strip()
        if not raw:
            return None
        base = self.plugin_data.resolve()
        try:
            path = Path(raw).resolve()
        except OSError:
            return None
        if path != base and base not in path.parents:
            return None
        if not path.is_file() or path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
            return None
        try:
            if path.stat().st_size > 2 * 1024 * 1024:
                return None
        except OSError:
            return None
        return path

    def start(self, code: str, channel: int, seconds: int) -> dict:
        code = str(code or "").strip()
        if not re.fullmatch(r"\d{8}", code):
            return {"ok": False, "error": "联机密码必须是 8 位数字。"}
        try:
            channel = int(channel)
            seconds = int(seconds)
        except (TypeError, ValueError):
            return {"ok": False, "error": "信道或等待时间格式不正确。"}
        if not 1 <= channel <= 13:
            return {"ok": False, "error": "无线信道必须在 1 到 13 之间。"}
        if not MIN_SECONDS <= seconds <= MAX_SECONDS:
            return {"ok": False, "error": f"最长等待时间必须在 {MIN_SECONDS} 到 {MAX_SECONDS} 秒之间。"}

        if self._data_error:
            return {"ok": False, "error": self._data_error}

        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return {"ok": False, "error": "联机采集已经在运行。"}

        probe = self.probe(force=False)
        board = probe.get("board") or {}
        if not board:
            return {"ok": False, "error": probe.get("error") or "无线板检测失败。", "probe": probe}
        port = str(board.get("port") or "")
        if not port:
            return {"ok": False, "error": "没有可用的 ESP32 串口。", "probe": probe}

        keys, keys_error = self.resolve_keys_path()
        if keys is None or not keys.is_file():
            return {"ok": False, "error": keys_error or "缺少 prod.keys。", "probe": probe}

        if self._find_solver() is None:
            return {
                "ok": False,
                "error": "缺少 EtumrepMMO 求解器，请在「设置 → 资源管理」下载后再采集。",
                "probe": probe,
            }

        solver_missing = False
        environment = probe.get("environment") or {}

        cmd = self._runtime_command(self.collector, [
            "--mode", "collect",
            "--code", code,
            "--channel", str(channel),
            "--seconds", str(seconds),
            "--keys", str(keys),
            "--trainer", self.resolve_trainer(),
            "--stamp", time.strftime("%Y%m%d-%H%M%S"),
        ])
        snapshot = self._launch(
            cmd,
            port,
            f"[工具] 使用串口 {port}，信道 {channel}，最长等待 {seconds} 秒。",
        )
        if not snapshot.get("ok"):
            snapshot["probe"] = probe
            return snapshot
        snapshot["probe"] = probe
        snapshot["warning"] = (
            f"没有找到 EtumrepMMO 求解器，采满四只后会停在这里：{environment.get('solver_dir')}"
            if solver_missing else ""
        )
        return snapshot

    def solve_last(self) -> dict:
        """Recompute the Seed from the newest 2–4 saved records, without a board."""
        if self._data_error:
            return {"ok": False, "error": self._data_error}
        keys, keys_error = self.resolve_keys_path()
        if keys is None or not keys.is_file():
            return {"ok": False, "error": keys_error or "缺少 prod.keys。"}
        if self._find_solver() is None:
            return {"ok": False, "error": "缺少 EtumrepMMO 求解器，请在「设置 → 资源管理」下载。"}
        cmd = self._runtime_command(self.collector, [
            "--mode", "solve-last",
            "--keys", str(keys),
            "--trainer", self.resolve_trainer(),
        ])
        return self._launch(cmd, None, "[工具] 不联机，直接用最近保存的 2–4 只记录重算 Seed。")

    def _launch(self, cmd: list[str], port: str | None, log_note: str) -> dict:
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return {"ok": False, "error": "联机采集已经在运行。"}
            self._parser = LinkLogParser()
            self._log.clear()
            self._log.append(log_note)
            self._last_seed = None
            self._applied = False
            self._stop_requested = False
            self._finished_at = None
            self._started_at = _now_iso()
            self._started_monotonic = time.monotonic()
            self._finished_monotonic = None

            try:
                self._proc = subprocess.Popen(
                    cmd,
                    cwd=str(self.project_root),
                    env=self._base_env(port),
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    bufsize=1,
                    creationflags=(
                        (0x08000000 | 0x00000200) if os.name == "nt" else 0
                    ),
                )
            except OSError as exc:
                self._proc = None
                return {"ok": False, "error": f"无法启动内置联机运行环境：{exc}"}

            # A kill-on-close job guarantees EtumrepMMO does not survive the app
            # or a forced stop of the collector.
            if self._job is not None:
                self._job.close()
            job = _WindowsJob()
            if job.create():
                job.assign(self._proc)
                self._job = job
            else:
                self._job = None

            self._reader = threading.Thread(
                target=self._reader_loop,
                args=(self._proc,),
                name="pla-seed-link-reader",
                daemon=True,
            )
            self._reader.start()
            return self._snapshot_locked()

    def _reader_loop(self, proc: subprocess.Popen[str]) -> None:
        assert proc.stdout is not None
        try:
            for raw in proc.stdout:
                line = raw.rstrip("\r\n")
                if not line:
                    continue
                with self._lock:
                    self._log.append(line)
                    self._parser.feed(line)
        finally:
            try:
                code = proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                code = -1
            self._finish(code)

    def _finish(self, code: int) -> None:
        applied = False
        partial_count = 0
        with self._lock:
            self._proc = None
            self._finished_at = _now_iso()
            self._finished_monotonic = time.monotonic()
            job, self._job = self._job, None
            parser = self._parser
            seed = parser.seed
            stopped = self._stop_requested or parser.stage == "stopped"
            if seed:
                parser.stage = "done"
                parser.tone = "ok"
                parser.status = "Seed 已找到，准备填入计算。"
                self._last_seed = seed
            elif stopped:
                parser.stage = "stopped"
                parser.tone = "warning"
                if 2 <= parser.count <= 3 and not parser.errors:
                    partial_count = parser.count
                    parser.stage = "solving"
                    parser.tone = "info"
                    parser.status = f"已停止，正在用已收录的 {partial_count} 只记录反推 Seed…"
                elif not parser.status:
                    parser.status = f"已停止采集，当前收录 {parser.count}/4。"
            elif code == 2:
                parser.stage = "failed"
                parser.tone = "error"
                parser.status = "缺少 EtumrepMMO 求解器。"
                if not parser.errors:
                    parser.errors.append(
                        f"缺少 EtumrepMMO 求解器。请把官方 Windows x64 发布包解压到：{self.solver_dir}"
                    )
            elif parser.errors:
                parser.stage = "failed"
                parser.tone = "error"
                parser.status = f"采集未完成（退出代码 {code}）。"
            else:
                parser.stage = "failed"
                parser.tone = "error"
                parser.status = f"采集未完成（退出代码 {code}）。"
                parser.errors.append(f"采集程序退出代码 {code}，没有生成 Seed。")

        if job is not None:
            # The collector has exited; any still-running EtumrepMMO child is an
            # orphan and should not keep a core busy.
            job.close()

        if seed:
            applied = self._apply_seed(seed)
        with self._lock:
            self._applied = applied

        if partial_count:
            threading.Thread(
                target=self._auto_solve_partial,
                args=(partial_count,),
                name="pla-seed-partial-solve",
                daemon=True,
            ).start()

    def _auto_solve_partial(self, count: int) -> None:
        """After a manual stop, calculate from the 2–3 records already received."""
        time.sleep(0.8)
        try:
            result = self.solve_last()
        except Exception as exc:
            result = {"ok": False, "error": str(exc)}
        if not result.get("ok"):
            with self._lock:
                self._parser.stage = "failed"
                self._parser.tone = "error"
                self._parser.status = result.get("error") or "用已收录记录反推 Seed 失败。"
                if result.get("error"):
                    self._parser.errors.append(str(result["error"]))

    def _apply_seed(self, seed: str) -> bool:
        try:
            validate_seed(seed)
        except ValueError as exc:
            with self._lock:
                self._parser.errors.append(f"程序返回的 Seed 无效：{exc}")
            return False

        update_source = self._should_take_over_source()
        try:
            result = self.seed_manager.apply_seed(
                seed,
                origin="link",
                source_path=str(self.latest_seed_path),
                update_source=update_source,
            )
        except Exception as exc:
            with self._lock:
                self._parser.errors.append(f"Seed 已找到，但写入当前 Seed 失败：{exc}")
            return False
        if not result.get("ok"):
            with self._lock:
                self._parser.errors.append(result.get("error") or "Seed 已找到，但应用失败。")
            return False
        return True

    def _should_take_over_source(self) -> bool:
        try:
            current = str(self._settings().get("seed_file_path") or "").strip()
        except Exception:
            return False
        if not current:
            return True
        normalized = current.replace("/", "\\").lower()
        return normalized.endswith("pokeldn\\plugin-data\\junli-pla-mmo-seed\\latest_seed.txt")

    def stop(self) -> dict:
        with self._lock:
            proc = self._proc
            if proc is None or proc.poll() is not None:
                return self._snapshot_locked()
            self._stop_requested = True
            self._parser.stage = "stopping"
            self._parser.status = "正在停止采集并释放无线板…"
            self._parser.tone = "warning"
        try:
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
        except (OSError, ValueError):
            pass
        threading.Thread(
            target=self._watchdog,
            args=(proc, 1.5 if self._slim_available() else 5.0),
            name="pla-seed-link-watchdog",
            daemon=True,
        ).start()
        return self.snapshot()

    def _kill_tree(self, proc: subprocess.Popen[str]) -> None:
        """Kill the collector and any EtumrepMMO/PKHeX child it started."""
        if proc.poll() is not None:
            return
        if os.name == "nt":
            try:
                subprocess.run(
                    ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=15,
                    creationflags=0x08000000,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
        try:
            proc.terminate()
        except OSError:
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except OSError:
                pass
        with self._lock:
            job, self._job = self._job, None
        if job is not None:
            job.close()

    def _watchdog(self, proc: subprocess.Popen[str], timeout: float = 30.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                return
            time.sleep(0.4)
        if proc.poll() is None:
            self._kill_tree(proc)

    def choose_keys(self, path: str) -> dict:
        value = self._expand(path)
        candidate = Path(value) if value else None
        if candidate is None or not candidate.is_file():
            return {"ok": False, "error": "所选 prod.keys 文件不存在。"}
        try:
            if candidate.stat().st_size > 1024 * 1024:
                return {"ok": False, "error": "所选文件过大，不像 prod.keys。"}
        except OSError as exc:
            return {"ok": False, "error": f"无法读取所选文件：{exc}"}

        imported = False
        target = self.keys_dir / "prod.keys"
        try:
            source = candidate.resolve()
            target_resolved = target.resolve() if target.exists() else target
            if source != target_resolved:
                self.keys_dir.mkdir(parents=True, exist_ok=True)
                temp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
                shutil.copy2(source, temp)
                os.replace(temp, target)
                imported = True
            chosen = target.resolve()
        except OSError as exc:
            # A read-only tool folder should not stop the user from pointing at
            # the key file; fall back to the original path.
            chosen = candidate.resolve()
            if not chosen.is_file():
                return {"ok": False, "error": f"无法导入 prod.keys：{exc}"}

        try:
            self.settings_store.update({"link_keys_path": str(chosen)})
        except (ValueError, OSError) as exc:
            return {"ok": False, "error": f"保存密钥路径失败：{exc}"}
        self._probe_checked_at = 0.0
        return {
            "ok": True,
            "keys_path": str(chosen),
            "imported": imported,
            "environment": self._environment(),
        }

    def shutdown(self) -> None:
        with self._lock:
            proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        try:
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
        except (OSError, ValueError):
            pass
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self._kill_tree(proc)
        with self._lock:
            job, self._job = self._job, None
        if job is not None:
            job.close()
