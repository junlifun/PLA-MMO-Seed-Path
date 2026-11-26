"""GitHub release updates and local data cleanup.

The updater deliberately uses a manifest (``update.json``) published as a
release asset instead of the GitHub API.  That avoids the unauthenticated API
rate limit and lets the release page own the changelog and download links.

Updating is always user-confirmed.  A portable install is replaced by a small
PowerShell helper after the application exits; an installed copy delegates to
the Inno Setup installer with ``/VERYSILENT``.  ``cache`` and user data are
preserved in both cases.  Nothing here downloads or stores ``prod.keys``.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any


REPOSITORY = "Yuutalin/PLA-MMO-Seed-Path"
RELEASE_PAGE = f"https://github.com/{REPOSITORY}/releases/latest"
MANIFEST_URL = (
    f"https://github.com/{REPOSITORY}/releases/latest/download/update.json"
)
ALLOWED_DOWNLOAD_PREFIX = (
    f"https://github.com/{REPOSITORY}/releases/download/"
)
MAX_UPDATE_BYTES = 400 * 1024 * 1024
USER_AGENT = "PLA-MMO-Seed-Path-Updater"


class UpdateError(RuntimeError):
    """A user-facing update error with an optional diagnostic hint."""

    def __init__(self, message: str, *, hint: str = "", detail: str = "") -> None:
        super().__init__(message)
        self.hint = hint
        self.detail = detail


def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _size(path: Path) -> int:
    try:
        if path.is_file():
            return path.stat().st_size
        if path.is_dir():
            total = 0
            for item in path.rglob("*"):
                if item.is_file():
                    try:
                        total += item.stat().st_size
                    except OSError:
                        pass
            return total
    except OSError:
        pass
    return 0


def _version_tuple(value: str) -> tuple[int, ...]:
    raw = str(value or "").strip().lstrip("vV")
    parts = re.findall(r"\d+", raw)
    if not parts:
        return (0,)
    return tuple(int(part) for part in parts[:6])


def is_newer(latest: str, current: str) -> bool:
    return _version_tuple(latest) > _version_tuple(current)


def _friendly_error(exc: BaseException, action: str = "下载") -> tuple[str, str, str]:
    """Return (message, hint, detail) for common network and file failures."""
    detail = f"{type(exc).__name__}: {exc}"
    if isinstance(exc, urllib.error.HTTPError):
        code = int(exc.code or 0)
        if code == 404:
            return (
                "更新文件不存在（HTTP 404）。",
                "可能是版本号已变化、资产被删除，或手动输入的地址不完整。请打开项目 Release 页面重新下载。",
                detail,
            )
        if code in (401, 403):
            return (
                f"GitHub 拒绝访问（HTTP {code}）。",
                "请检查 GitHub 是否被代理/防火墙拦截，或稍后再试；也可能是下载次数过多。",
                detail,
            )
        if code == 429:
            return (
                "GitHub 请求过于频繁（HTTP 429）。",
                "请等待一段时间再试，或直接打开项目 Release 页面手动下载。",
                detail,
            )
        if 500 <= code < 600:
            return (
                f"GitHub 服务器暂时不可用（HTTP {code}）。",
                "这是 GitHub 侧的临时故障，请稍后重试，或前往 Release 页面手动下载。",
                detail,
            )
        return (
            f"{action}被服务器拒绝（HTTP {code}）。",
            "请检查网络代理、GitHub 访问权限和磁盘空间后重试。",
            detail,
        )
    if isinstance(exc, urllib.error.URLError):
        reason = exc.reason
        if isinstance(reason, socket.gaierror):
            return (
                "无法解析 GitHub 域名（DNS 失败）。",
                "请检查网络连接、DNS 设置或代理；也可以在浏览器打开项目 Release 页面手动下载。",
                detail,
            )
        if isinstance(reason, ssl.SSLError):
            return (
                "HTTPS 证书校验失败。",
                "可能是代理、公司网络或安全软件替换了证书。请关闭证书拦截或改用手机热点后重试。",
                detail,
            )
        text = str(reason).lower()
        if "timed out" in text:
            return (
                "连接 GitHub 超时。",
                "请检查代理/VPN、防火墙和网络稳定性；GitHub Releases 在部分地区访问较慢。",
                detail,
            )
        if "refused" in text or "reset" in text or "aborted" in text:
            return (
                "连接被重置或拒绝。",
                "常见原因是代理不稳定、防火墙/安全软件拦截，或 GitHub 线路波动。请切换线路后重试。",
                detail,
            )
        return (
            "无法连接 GitHub。",
            "请检查网络、代理/VPN、DNS 和防火墙；也可以手动下载更新包后在页面中选择文件。",
            detail,
        )
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return (
            "网络请求超时。",
            "请检查代理/VPN、防火墙和网络速度，或稍后重试；也可以手动下载更新包。",
            detail,
        )
    if isinstance(exc, PermissionError):
        return (
            "没有权限写入更新文件。",
            "请检查程序目录和 cache/updates 是否被安全软件锁定，或换一个可写目录。",
            detail,
        )
    if isinstance(exc, OSError) and getattr(exc, "errno", None) == 28:
        return (
            "磁盘空间不足，无法保存更新包。",
            "请清理磁盘后重试。更新包约 55 MB（安装包约 35 MB），解压还需要额外空间。",
            detail,
        )
    return (f"{action}失败：{exc}", "请重试；如果仍然失败，可手动下载更新包并在页面中选择。", detail)


def _atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def _detect_mode(root: Path) -> str:
    """Return ``installed`` when this directory is managed by Inno Setup."""
    if os.name != "nt":
        return "portable"
    try:
        import winreg

        key_path = (
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall"
            r"\{B7F2D7A5-3F3D-4E2A-9C8E-6A2B5D9C4E10}_is1"
        )
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            location, _ = winreg.QueryValueEx(key, "InstallLocation")
        if location and Path(location).resolve() == root.resolve():
            return "installed"
    except (OSError, ImportError, ValueError):
        pass
    if (root / ".installed").is_file():
        return "installed"
    return "portable"


def _safe_member(name: str) -> bool:
    normalized = name.replace("\\", "/")
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        return False
    parts = PurePosixPath(normalized).parts
    return not any(part in {"", ".", ".."} for part in parts)


class UpdateService:
    def __init__(self, project_root: Path, version: str, data_dir: Path, cache_root: Path):
        self.root = Path(project_root).resolve()
        self.version = str(version)
        self.data_dir = Path(data_dir)
        self.update_dir = Path(cache_root) / "updates"
        self.update_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.data_dir / "update-state.json"
        self.mode = _detect_mode(self.root)

        self._lock = threading.RLock()
        self._state = self._load_state()
        self._check_result: dict | None = None
        self._download_thread: threading.Thread | None = None
        self._download = {
            "state": "idle",
            "percent": 0,
            "downloaded": 0,
            "total": 0,
            "message": "尚未下载更新。",
            "error": "",
            "hint": "",
            "path": "",
            "kind": "",
            "version": "",
        }
        self._manual: dict | None = None
        self._cached_check: dict | None = self._state.get("cached_check") or None
        self._cleanup_stale_backups()

    def _cleanup_stale_backups(self) -> None:
        """Remove ``.update-old-*`` copies left by an earlier portable update.

        The restarting application can still hold WebView2 files for a few
        seconds after the helper's final cleanup attempt, so the helper may not
        be able to delete its backup.  The new process does not use that
        directory, and retrying here makes the next launch finish the job.
        """
        pattern = f"{self.root.name}.update-old-*"
        for backup in self.root.parent.glob(pattern):
            if backup.is_dir():
                shutil.rmtree(backup, ignore_errors=True)

    # --------------------------------------------------------------- state
    def _load_state(self) -> dict:
        try:
            loaded = json.loads(self.state_path.read_text(encoding="utf-8-sig"))
            if isinstance(loaded, dict):
                return loaded
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        return {}

    def _save_state(self) -> None:
        try:
            _atomic_write_json(self.state_path, self._state)
        except OSError:
            pass

    def _result(self, **changes: Any) -> dict:
        base = {
            "ok": True,
            "current_version": self.version,
            "latest_version": self.version,
            "update_available": False,
            "skipped": False,
            "mode": self.mode,
            "notes": "",
            "published_at": "",
            "release_url": RELEASE_PAGE,
            "asset": None,
            "checked_at": "",
            "from_cache": False,
            "error": "",
            "hint": "",
            "detail": "",
        }
        base.update(changes)
        return base

    def _normalize_check(self, value: Any) -> dict | None:
        if not isinstance(value, dict):
            return None
        item = dict(value)
        item["current_version"] = self.version
        latest = str(item.get("latest_version") or "")
        item["update_available"] = bool(is_newer(latest, self.version) and not item.get("skipped"))
        return item

    def snapshot(self) -> dict:
        with self._lock:
            download = dict(self._download)
            cached = self._normalize_check(self._cached_check)
        return {
            "ok": True,
            "current_version": self.version,
            "mode": self.mode,
            "check": cached,
            "download": download,
            "manual": dict(self._manual) if self._manual else None,
            "update_dir": str(self.update_dir),
        }

    # --------------------------------------------------------------- check
    def _fetch_manifest(self) -> dict:
        request = urllib.request.Request(
            MANIFEST_URL,
            headers={
                "User-Agent": f"{USER_AGENT}/{self.version}",
                "Accept": "application/json",
                "Cache-Control": "no-cache",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                raw = response.read(1024 * 1024)
        except BaseException as exc:
            message, hint, detail = _friendly_error(exc, "检查更新")
            raise UpdateError(message, hint=hint, detail=detail) from exc
        try:
            manifest = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise UpdateError(
                "更新清单不是有效的 JSON。",
                hint="请前往项目 Release 页面手动下载；可能是代理返回了错误页面。",
                detail=str(exc),
            ) from exc
        if not isinstance(manifest, dict) or not manifest.get("version"):
            raise UpdateError(
                "更新清单缺少版本信息。",
                hint="请前往项目 Release 页面手动下载。",
            )
        assets = manifest.get("assets")
        if not isinstance(assets, dict):
            raise UpdateError(
                "更新清单缺少下载文件。",
                hint="请前往项目 Release 页面手动下载。",
            )
        return manifest

    def _asset_for(self, manifest: dict, kind: str | None = None) -> dict | None:
        assets = manifest.get("assets") if isinstance(manifest.get("assets"), dict) else {}
        requested = kind or ("setup" if self.mode == "installed" else "portable")
        asset = assets.get(requested)
        if not isinstance(asset, dict):
            return None
        return asset

    def _public_check(self, manifest: dict, *, from_cache: bool) -> dict:
        latest = str(manifest.get("version") or "")
        asset = self._asset_for(manifest)
        skipped = str(self._state.get("skipped_version") or "") == latest
        notes = str(manifest.get("notes") or "")
        if len(notes) > 30000:
            notes = notes[:30000] + "\n…"
        return self._result(
            latest_version=latest,
            update_available=bool(is_newer(latest, self.version) and not skipped),
            skipped=skipped,
            notes=notes,
            published_at=str(manifest.get("published_at") or ""),
            release_url=str(manifest.get("release_url") or RELEASE_PAGE),
            asset=asset,
            checked_at=str(manifest.get("checked_at") or _now_iso()),
            from_cache=from_cache,
        )

    def check(self, *, force: bool = False, auto: bool = False) -> dict:
        """Fetch (or reuse) the release manifest and compare versions."""
        with self._lock:
            cached = self._cached_check
            last = str(self._state.get("last_check_at") or "")
        if not force and cached and last and cached.get("current_version") == self.version:
            try:
                age = time.time() - datetime.fromisoformat(last).timestamp()
            except ValueError:
                age = 86401
            if 0 <= age < 86400:
                return {**self._normalize_check(cached), "from_cache": True}

        try:
            manifest = self._fetch_manifest()
            result = self._public_check(manifest, from_cache=False)
        except UpdateError as exc:
            return self._result(
                ok=False,
                error=str(exc),
                hint=exc.hint,
                detail=exc.detail,
                checked_at=_now_iso(),
            )

        with self._lock:
            self._cached_check = result
            self._state["last_check_at"] = result["checked_at"]
            self._state["cached_check"] = result
            self._save_state()
        return result

    def skip(self, version: str) -> dict:
        with self._lock:
            self._state["skipped_version"] = str(version or "").strip()
            self._save_state()
            if self._cached_check and self._cached_check.get("latest_version") == version:
                self._cached_check["skipped"] = True
        return {"ok": True, "skipped_version": self._state["skipped_version"]}

    # ------------------------------------------------------------ download
    def start_download(self, kind: str | None = None) -> dict:
        with self._lock:
            if self._download_thread and self._download_thread.is_alive():
                return {"ok": True, "already_running": True, "download": dict(self._download)}
            check = self._cached_check
        if not check or check.get("current_version") != self.version:
            check = self.check(force=True)
            with self._lock:
                self._cached_check = check
        with self._lock:
            if self._download_thread and self._download_thread.is_alive():
                return {"ok": True, "already_running": True, "download": dict(self._download)}
            if not check.get("ok"):
                return {"ok": False, "error": check.get("error") or "检查更新失败。", "hint": check.get("hint", "")}
            asset = check.get("asset") if isinstance(check.get("asset"), dict) else None
            desired_kind = kind or ("setup" if self.mode == "installed" else "portable")
            if not asset:
                return {"ok": False, "error": "更新清单中没有可下载的文件。", "hint": "请打开项目 Release 页面手动下载。",}
            if desired_kind not in {"portable", "setup"}:
                return {"ok": False, "error": "未知的更新包类型。"}
            url = str(asset.get("url") or "")
            if not url.startswith(ALLOWED_DOWNLOAD_PREFIX):
                return {"ok": False, "error": "更新文件地址不是官方 GitHub Release。", "hint": "为安全起见已拒绝下载。"}
            filename = Path(str(asset.get("name") or "")).name
            if not filename or not re.search(r"\.(zip|exe)$", filename, re.I):
                return {"ok": False, "error": "更新文件名无效。", "hint": "请打开项目 Release 页面手动下载。"}
            self._download = {
                "state": "starting",
                "percent": 0,
                "downloaded": 0,
                "total": int(asset.get("size") or 0),
                "message": "准备下载更新…",
                "error": "",
                "hint": "",
                "path": "",
                "kind": kind or ("setup" if self.mode == "installed" else "portable"),
                "version": str(check.get("latest_version") or ""),
            }
            thread = threading.Thread(
                target=self._download_worker,
                args=(asset, filename, self._download["kind"]),
                name="pla-update-download",
                daemon=True,
            )
            self._download_thread = thread
            thread.start()
        return {"ok": True, "already_running": False, "download": dict(self._download)}

    def _download_worker(self, asset: dict, filename: str, kind: str) -> None:
        destination = self.update_dir / filename
        part = destination.with_name(destination.name + ".part")
        expected_size = int(asset.get("size") or 0)
        expected_hash = str(asset.get("sha256") or "").lower()
        url = str(asset.get("url") or "")
        try:
            if destination.is_file() and self._valid_file(destination, expected_size, expected_hash):
                self._set_download(
                    state="success",
                    percent=100,
                    downloaded=destination.stat().st_size,
                    total=destination.stat().st_size,
                    message="更新包已下载并通过校验。",
                    path=str(destination),
                )
                return

            offset = part.stat().st_size if part.is_file() else 0
            if expected_size and offset > expected_size:
                part.unlink(missing_ok=True)
                offset = 0
            headers = {"User-Agent": f"{USER_AGENT}/{self.version}"}
            if offset:
                headers["Range"] = f"bytes={offset}-"
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=45) as response:
                if offset and getattr(response, "status", 200) != 206:
                    offset = 0
                content_length = int(response.headers.get("Content-Length") or 0)
                total = (offset + content_length) if content_length else expected_size
                if not total:
                    total = expected_size
                mode = "ab" if offset else "wb"
                received = offset
                last_update = 0.0
                with part.open(mode) as handle:
                    while True:
                        chunk = response.read(256 * 1024)
                        if not chunk:
                            break
                        handle.write(chunk)
                        received += len(chunk)
                        now = time.monotonic()
                        if now - last_update >= 0.2:
                            last_update = now
                            percent = min(99, int(received * 100 / total)) if total else 0
                            self._set_download(
                                state="downloading",
                                percent=percent,
                                downloaded=received,
                                total=total,
                                message=f"正在下载更新… {percent}%",
                            )
            if expected_size and part.stat().st_size != expected_size:
                raise UpdateError(
                    f"更新包大小不正确：应为 {expected_size} 字节，实际 {part.stat().st_size} 字节。",
                    hint="下载可能被代理或网络中断截断。请重试；也可以手动下载更新包。",
                )
            if expected_hash and _sha256(part).lower() != expected_hash:
                part.unlink(missing_ok=True)
                raise UpdateError(
                    "更新包 SHA256 校验失败。",
                    hint="文件可能下载不完整或被代理修改。请重试，或从 Release 页面手动下载。",
                )
            os.replace(part, destination)
            self._set_download(
                state="success",
                percent=100,
                downloaded=destination.stat().st_size,
                total=destination.stat().st_size,
                message="更新包已下载并通过校验。",
                path=str(destination),
            )
        except UpdateError as exc:
            self._set_download(state="failed", error=str(exc), message="下载失败。", hint=exc.hint)
        except BaseException as exc:
            message, hint, _detail = _friendly_error(exc, "下载更新")
            self._set_download(state="failed", error=message, message="下载失败。", hint=hint)

    @staticmethod
    def _valid_file(path: Path, size: int, sha256: str) -> bool:
        try:
            if size and path.stat().st_size != size:
                return False
            if sha256 and _sha256(path).lower() != sha256:
                return False
            return True
        except OSError:
            return False

    def _set_download(self, **changes: Any) -> None:
        with self._lock:
            self._download.update(changes)

    # -------------------------------------------------------------- manual
    def stage_manual(self, storage) -> dict:
        filename = Path(getattr(storage, "filename", "") or "").name
        suffix = Path(filename).suffix.lower()
        if suffix not in {".zip", ".exe"}:
            raise UpdateError("只支持 .zip 便携包或 .exe 安装包。")
        token = f"manual-{uuid.uuid4().hex}{suffix}"
        destination = self.update_dir / token
        try:
            storage.save(destination)
        except OSError as exc:
            raise UpdateError(
                "无法保存上传的更新包。",
                hint="请检查磁盘空间和 cache/updates 的写入权限。",
                detail=str(exc),
            ) from exc
        try:
            if destination.stat().st_size > MAX_UPDATE_BYTES:
                raise UpdateError("更新包超过 400 MB，已拒绝。")
            if suffix == ".exe":
                with destination.open("rb") as handle:
                    if handle.read(2) != b"MZ":
                        raise UpdateError("所选文件不是有效的 Windows 安装程序。")
                info = {
                    "token": token,
                    "kind": "setup",
                    "version": "",
                    "size": destination.stat().st_size,
                    "message": "已选择安装包。安装程序将使用静默模式覆盖当前程序，并保留 cache 与用户设置。",
                }
            else:
                info = self._inspect_zip(destination)
                info.update({"token": token, "kind": "portable", "size": destination.stat().st_size})
                if not is_newer(info["version"], self.version):
                    raise UpdateError(
                        f"所选更新包版本为 {info['version'] or '未知'}，不高于当前版本 {self.version}。",
                        hint="请选择比当前版本更新的便携 ZIP。",
                    )
            with self._lock:
                self._manual = info
            return {"ok": True, **info}
        except BaseException:
            destination.unlink(missing_ok=True)
            raise

    def _inspect_zip(self, path: Path) -> dict:
        try:
            with zipfile.ZipFile(path) as archive:
                names = archive.namelist()
                if len(names) > 200000:
                    raise UpdateError("更新包文件数量异常，已拒绝。")
                for name in names:
                    if not _safe_member(name):
                        raise UpdateError("更新包包含不安全的路径，已拒绝。")
                candidates = [
                    name for name in names
                    if name.replace("\\", "/").endswith("app.py")
                    and name.count("/") <= 1
                ]
                if not candidates:
                    candidates = [name for name in names if name.replace("\\", "/").endswith("app.py")]
                if not candidates:
                    raise UpdateError("更新包缺少 app.py，可能不是本程序的便携包。")
                app_name = sorted(candidates, key=lambda value: value.count("/"))[0]
                app_path = PurePosixPath(app_name.replace("\\", "/"))
                root = str(app_path.parent)
                root_prefix = "" if root == "." else root.rstrip("/") + "/"
                required = [
                    "python/pythonw.exe",
                    "pla_mmo/__init__.py",
                    "templates/index.html",
                    "static/app.js",
                ]
                existing = {name.replace("\\", "/") for name in names}
                missing = [item for item in required if root_prefix + item not in existing]
                if missing:
                    raise UpdateError(
                        "更新包结构不完整，缺少：" + "、".join(missing),
                        hint="请选择完整的 portable ZIP（解压后应包含 app.py、python/pythonw.exe 和 pla_mmo）。",
                    )
                with archive.open(app_name) as handle:
                    source = handle.read(2 * 1024 * 1024).decode("utf-8", errors="replace")
                match = re.search(r"APP_VERSION\s*=\s*['\"]([^'\"]+)['\"]", source)
                if not match:
                    raise UpdateError("无法从更新包中读取版本号。")
                return {
                    "version": match.group(1),
                    "root": root_prefix,
                    "message": "更新包结构校验通过。",
                }
        except zipfile.BadZipFile as exc:
            raise UpdateError(
                "更新包不是有效的 ZIP，可能下载不完整。",
                hint="请重新下载；如果仍失败，请从 Release 页面获取完整文件。",
                detail=str(exc),
            ) from exc

    # --------------------------------------------------------------- apply
    def _resolve_package(self, token: str, kind: str) -> tuple[Path, str]:
        token = Path(str(token or "")).name
        if not token:
            raise UpdateError("没有可安装的更新包。")
        path = (self.update_dir / token).resolve()
        try:
            path.relative_to(self.update_dir.resolve())
        except ValueError as exc:
            raise UpdateError("更新包路径无效。") from exc
        if not path.is_file():
            raise UpdateError("更新包已不存在，请重新下载。")
        if kind not in {"portable", "setup"}:
            kind = "setup" if path.suffix.lower() == ".exe" else "portable"
        return path, kind

    def install(self, token: str, kind: str = "") -> dict:
        path, kind = self._resolve_package(token, kind)
        if kind == "setup":
            self._launch_setup_helper(path)
        else:
            self._launch_portable_helper(path)
        return {
            "ok": True,
            "message": "程序即将退出并完成更新，随后会自动重新启动。",
            "kind": kind,
        }

    def _launch_portable_helper(self, archive: Path) -> None:
        staging_parent = self.root.parent / f".pla-update-{uuid.uuid4().hex}"
        staging_parent.mkdir(parents=True, exist_ok=False)
        try:
            with zipfile.ZipFile(archive) as source:
                for member in source.infolist():
                    name = member.filename.replace("\\", "/")
                    if not _safe_member(name):
                        raise UpdateError("更新包包含不安全的路径。")
                    if name.endswith("/"):
                        (staging_parent / name).mkdir(parents=True, exist_ok=True)
                        continue
                    target = staging_parent / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with source.open(member) as src, target.open("wb") as dst:
                        shutil.copyfileobj(src, dst, 1024 * 1024)
            candidates = sorted(
                (p for p in staging_parent.rglob("app.py") if p.is_file()),
                key=lambda p: len(p.parts),
            )
            if not candidates:
                raise UpdateError("更新包解压后没有 app.py。")
            source_root = candidates[0].parent
            if source_root != staging_parent:
                final = self.root.parent / f".pla-update-source-{uuid.uuid4().hex}"
                if final.exists():
                    shutil.rmtree(final, ignore_errors=True)
                shutil.move(str(source_root), str(final))
                shutil.rmtree(staging_parent, ignore_errors=True)
            else:
                final = staging_parent
        except BaseException:
            shutil.rmtree(staging_parent, ignore_errors=True)
            raise

        pythonw = final / "python" / "pythonw.exe"
        if not pythonw.is_file():
            shutil.rmtree(final, ignore_errors=True)
            raise UpdateError("更新包缺少 python/pythonw.exe，无法启动新版本。")

        helper = Path(tempfile.gettempdir()) / f"pla-update-{uuid.uuid4().hex}.ps1"
        log_path = Path(tempfile.gettempdir()) / "pla-update.log"
        script = _portable_helper_script(
            target=self.root,
            staging=final,
            pythonw=pythonw,
            app_pid=os.getpid(),
            log_path=log_path,
        )
        helper.write_text(script, encoding="utf-8-sig")
        subprocess.Popen(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-File",
                str(helper),
            ],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            close_fds=True,
            cwd=str(Path(tempfile.gettempdir())),
        )
        self._exit_soon()

    def _launch_setup_helper(self, setup: Path) -> None:
        helper = Path(tempfile.gettempdir()) / f"pla-update-{uuid.uuid4().hex}.ps1"
        log_path = Path(tempfile.gettempdir()) / "pla-update.log"
        script = _setup_helper_script(
            target=self.root,
            setup=setup,
            app_pid=os.getpid(),
            log_path=log_path,
        )
        helper.write_text(script, encoding="utf-8-sig")
        subprocess.Popen(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-File",
                str(helper),
            ],
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            close_fds=True,
            cwd=str(Path(tempfile.gettempdir())),
        )
        self._exit_soon()

    def _exit_soon(self) -> None:
        def _exit() -> None:
            try:
                sys.stdout.flush()
                sys.stderr.flush()
            except Exception:
                pass
            os._exit(0)

        threading.Timer(1.0, _exit).start()

    # ------------------------------------------------------------- cleanup
    def _backup_dirs(self) -> list[Path]:
        return sorted(
            path for path in self.root.parent.glob(f"{self.root.name}.update-old-*")
            if path.is_dir()
        )

    def cleanup_targets(self) -> list[dict]:
        data = self.data_dir
        root = self.root
        specs = [
            {
                "key": "downloads",
                "label": "未完成下载与更新包",
                "path": root / "cache" / "downloads",
                "description": "资源下载的临时文件和完成包；删除后重试下载即可。",
                "default": True,
            },
            {
                "key": "updates",
                "label": "更新包缓存",
                "path": self.update_dir,
                "description": "已下载的更新 ZIP/Setup 及手动选择的更新包。",
                "default": True,
            },
            {
                "key": "logs",
                "label": "日志与诊断",
                "path": data / "logs",
                "extra": [root / "runtime_errors.log", root / "app-console.log"],
                "description": "运行错误、启动日志和诊断输出；删除后无法回溯旧问题。",
                "default": True,
            },
            {
                "key": "cache_all",
                "label": "全部资源缓存",
                "path": root / "cache",
                "description": "Pokeldn 运行时、求解器、固件、地图、宝可梦图片和自定义图片。删除后需重新下载资源。",
                "default": False,
            },
            {
                "key": "custom_images",
                "label": "自定义宝可梦图片",
                "path": root / "cache" / "pokemon-images" / "custom",
                "description": "你自己放入的宝可梦头像；删除后无法恢复。",
                "default": False,
            },
            {
                "key": "map_annotations",
                "label": "地图与多只生成点缓存",
                "path": root / "cache" / "spawn-maps",
                "description": "地图底图和多只生成点标注缓存；删除后会使用内置地图。",
                "default": False,
            },
            {
                "key": "settings",
                "label": "设置与偏好",
                "path": data / "settings.json",
                "extra": [data / "settings.backup.json"],
                "description": "主题、字号、研究等级、Seed 与联机设置；删除后恢复默认。",
                "default": False,
            },
            {
                "key": "webview",
                "label": "WebView2 窗口缓存",
                "path": data / "webview2-profile",
                "description": "原生窗口的浏览器缓存；删除后首次启动稍慢。",
                "default": False,
            },
            {
                "key": "update_state",
                "label": "更新检查与跳过记录",
                "path": self.state_path,
                "description": "最近检查时间和“跳过此版本”记录。",
                "default": False,
            },
        ]
        backups = self._backup_dirs()
        if backups:
            specs.append({
                "key": "update_backups",
                "label": "旧版本程序备份",
                "path": backups[0],
                "extra": backups[1:],
                "description": "便携版更新后留下的旧程序目录；确认新版本可正常使用后可删除。",
                "default": True,
            })
        result = []
        for spec in specs:
            paths = [spec["path"], *spec.get("extra", [])]
            exists = any(p.exists() for p in paths)
            result.append({
                "key": spec["key"],
                "label": spec["label"],
                "path": str(spec["path"]),
                "paths": [str(p) for p in paths],
                "description": spec["description"],
                "default": spec["default"],
                "exists": exists,
                "size": sum(_size(p) for p in paths),
            })
        return result

    def cleanup(self, keys: list[str]) -> dict:
        allowed = {item["key"]: item for item in self.cleanup_targets()}
        selected = [allowed[key] for key in keys if key in allowed]
        if "cache_all" in {item["key"] for item in selected}:
            selected = [item for item in selected if item["key"] not in {"downloads", "updates", "custom_images", "map_annotations"}]
        freed = 0
        errors = []
        for item in selected:
            for raw in item["paths"]:
                path = Path(raw)
                try:
                    if not path.exists():
                        continue
                    freed += _size(path)
                    if path.is_dir():
                        shutil.rmtree(path)
                    else:
                        path.unlink(missing_ok=True)
                except OSError as exc:
                    errors.append(f"{path}: {exc}")
        # Keep the writable cache root available for the running app.
        try:
            (self.root / "cache").mkdir(parents=True, exist_ok=True)
            self.update_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass
        return {
            "ok": not errors,
            "freed_bytes": freed,
            "errors": errors,
            "deleted": [item["key"] for item in selected],
        }


def _ps_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _portable_helper_script(*, target: Path, staging: Path, pythonw: Path, app_pid: int, log_path: Path) -> str:
    target_q = _ps_quote(str(target))
    staging_q = _ps_quote(str(staging))
    pythonw_q = _ps_quote(str(pythonw))
    log_q = _ps_quote(str(log_path))
    old_q = _ps_quote(str(target) + ".update-old-" + uuid.uuid4().hex[:8])
    return f"""$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $env:TEMP
$target = {target_q}
$staging = {staging_q}
$pythonw = {pythonw_q}
$log = {log_q}
$old = {old_q}
function Write-Log([string]$message) {{
    try {{ Add-Content -LiteralPath $log -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $message) -Encoding utf8 }} catch {{}}
}}
try {{
    Write-Log 'waiting for the application to exit'
    Wait-Process -Id {app_pid} -Timeout 60 -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 900
    if (Test-Path -LiteralPath $old) {{ Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue }}
    Move-Item -LiteralPath $target -Destination $old
    foreach ($name in @('cache', 'runtime_errors.log', 'app-console.log')) {{
        $source = Join-Path $old $name
        if (Test-Path -LiteralPath $source) {{
            Move-Item -LiteralPath $source -Destination (Join-Path $staging $name) -Force
        }}
    }}
    Move-Item -LiteralPath $staging -Destination $target
    Start-Process -FilePath (Join-Path $target 'python\\pythonw.exe') -ArgumentList ('"' + $target + '\\app.py"') -WorkingDirectory $target
    Write-Log 'portable update installed and restarted'
    Start-Sleep -Seconds 5
    Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
}} catch {{
    Write-Log ('ERROR: ' + $_.Exception.Message)
    if ((-not (Test-Path -LiteralPath $target)) -and (Test-Path -LiteralPath $old)) {{
        try {{ Move-Item -LiteralPath $old -Destination $target }} catch {{ Write-Log ('restore failed: ' + $_.Exception.Message) }}
    }}
}}
"""


def _setup_helper_script(*, target: Path, setup: Path, app_pid: int, log_path: Path) -> str:
    target_q = _ps_quote(str(target))
    setup_q = _ps_quote(str(setup))
    log_q = _ps_quote(str(log_path))
    return f"""$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $env:TEMP
$target = {target_q}
$setup = {setup_q}
$log = {log_q}
function Write-Log([string]$message) {{
    try {{ Add-Content -LiteralPath $log -Value ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $message) -Encoding utf8 }} catch {{}}
}}
try {{
    Write-Log 'waiting for the application to exit'
    Wait-Process -Id {app_pid} -Timeout 60 -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 900
    $arguments = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/DIR="' + $target + '"'))
    $process = Start-Process -FilePath $setup -ArgumentList $arguments -Wait -PassThru
    Write-Log ('setup exit code: ' + $process.ExitCode)
    $pythonw = Join-Path $target 'python\\pythonw.exe'
    if (Test-Path -LiteralPath $pythonw) {{
        Start-Process -FilePath $pythonw -ArgumentList ('"' + $target + '\\app.py"') -WorkingDirectory $target
        Write-Log 'application restarted'
    }} else {{
        Write-Log 'pythonw.exe was not found after setup'
    }}
}} catch {{
    Write-Log ('ERROR: ' + $_.Exception.Message)
}}
"""
