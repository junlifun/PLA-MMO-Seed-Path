# 开发与架构说明

> 适用版本：v0.9.16  
> 最近核对：2026-11-27  
> 本文只讲“代码怎么跑、改哪里”；发版和更新规则见 [RELEASE_PROCESS.md](RELEASE_PROCESS.md)，交接先看 [HANDOFF.md](HANDOFF.md)。

## 1. 项目定位

Windows 桌面工具，用于《宝可梦传说 阿尔宙斯》：

- 通过 ESP32-S3 无线板和 Switch 联机，采集 2–4 只最初捕获宝可梦，反推 MMO 群体 Seed。
- 用本地 RNG 引擎计算闪光路径、生成点位、多只同时生成路径。
- 提供五地区地图、点位标注、结果筛选、资源下载、应用内更新。
- 所有计算在本机完成，不上传 Seed、存档或 `prod.keys`。

不是旧仓库 `PLA-MMO-Path-Finder` 的备份；旧仓库只保留测 Seed 相关功能。

## 2. 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 后端 | Python 3.13 + Flask | 只监听 `127.0.0.1`，端口默认 5000，可用 `PLA_PORT` 覆盖 |
| 桌面窗口 | pywebview + Edge WebView2 | `gui="edgechromium"`；失败时回退浏览器 |
| 前端 | Jinja2 模板 + 原生 HTML/CSS/JS | 没有 Node 构建步骤，改完静态文件刷新即可 |
| 计算 | `offline_engine` + z3 等 | RNG 路径计算，不依赖服务器 |
| 联机 | Pokeldn 精简运行时 + ESP32-S3 | 串口通信，运行时放 `cache/pokeldn-slim` |
| 反推 | EtumremMMO ConsoleApp | 放 `cache/etumrempmmo` |
| 打包 | 复制 Python 3.13 + Inno Setup 6 | 不用 PyInstaller，不用 Edge App 启动器 |

## 3. 目录速览

```text
_new-repo/
  app.py                  Flask 应用、API、窗口启动、错误处理
  pla_mmo/                业务模块（种子、联机、计算、地图、更新、资源）
  templates/index.html    单页界面
  static/                 app.js、CSS、图标、地图图片
  offline_engine/         本地 RNG 引擎
  vendor/                 随仓库分发的第三方运行时代码
  build/                  打包脚本、Inno Setup 脚本、文件清单
  docs/                   发布日志、工作日志、开发/交接文档
  release/                构建产物（被 .gitignore 忽略）
```

关键业务文件：

| 文件 | 作用 |
|---|---|
| `app.py` | `create_app()`、全部 `/api/*` 路由、WebView/浏览器启动 |
| `pla_mmo/seed_link.py` | 启动联机采集子进程、串口/运行时/keys 探测、状态汇总 |
| `vendor/pla_mmo_seed/pla_mmo_seed.py` | 采集器：读 Switch、保存记录、调用主机和反推 |
| `pla_mmo/local_engine.py` | 本地引擎安装、验证、调用 |
| `pla_mmo/calculator.py` | 路径计算入口 |
| `pla_mmo/multi.py` | 多只生成路径 |
| `pla_mmo/spawn_maps.py` / `spawns.py` | 地图与点位数据 |
| `pla_mmo/updater.py` | 更新检查、下载、暂停、完整包/增量包安装 |
| `pla_mmo/patch_helper.ps1` | 应用退出后执行增量替换、备份、失败恢复 |
| `pla_mmo/resources.py` | Pokeldn、求解器、固件、图片资源下载 |
| `pla_mmo/settings.py` | 设置、主题、用户数据目录 |

## 4. 启动链路

1. `Start-PLA.vbs` / `Start-PLA.bat` 用自带的 `python\pythonw.exe` 启动 `app.py`。
2. `app.py` 解析 `PLA_PORT`，选可用端口，创建 Flask app。
3. 默认进入桌面模式：`_run_desktop_window()` 用 pywebview 打开 `http://127.0.0.1:<port>`。
4. 如果 WebView2/pythonnet 初始化失败，记录 `runtime_errors.log`，回退系统浏览器；不会静默退出。
5. 源码模式也默认开原生窗口。需要浏览器开发时设置 `PLA_BROWSER=1` 或 `PLA_DEV=1`。

开发常用：

```powershell
$env:PLA_DEV="1"       # 浏览器 + Flask debug/reloader
$env:PLA_PORT="5059"
python app.py
```

`PLA_DEV=1` 会关闭原生窗口，直接开浏览器；不要用它验证发布包窗口。

## 5. 核心数据流

### 5.1 联机采集 Seed

1. 前端调用 `POST /api/link/start`，传 `code`、`channel`、`seconds`、`exchange_name`。
2. `SeedLinkService` 探测串口、Pokeldn 运行时、`prod.keys`、EtumremMMO。
3. 用自带 Python 启动 `vendor/pla_mmo_seed/pla_mmo_seed.py`，环境变量包括：
   - `POKELDN_RADIO=esp32:<COMx>`
   - `POKELDN_ESP32_BAUD=921600`
   - `PYTHONPATH=<cache/pokeldn-slim>`
4. 采集器启动主机、等待 Switch 进入交换、每次确认后保存一只的记录。
5. 收齐 4 只，或用户确认只收了 2–3 只后结束，调用本地 EtumremMMO 反推群体 Seed。
6. 前端轮询 `/api/link/status` 显示阶段、数量、日志和错误。

注意：`[link] left` 在“按 B 返回”时也会出现，不能一出现就当作交换结束。自动收尾逻辑用 6 秒等待 + `on_console_joined` 取消，避免把中途返回误判为结束。

### 5.2 路径计算

1. 前端提交 `/api/calculate`（Seed、目标、条件、地图点位等）。
2. `calculator.py` / `multi.py` 调 `offline_engine`，返回结果列表。
3. `result_view.js` 渲染结果卡、路径、筛选和地图标注。
4. 计算失败时顶部显示诊断提示，不会用演示结果冒充真实结果。

### 5.3 更新

1. `UpdateService.check()` 拉取 `update.json`，比较版本、读取可选 `patch`。
2. `start_download()` 选择增量包或完整包；用户可暂停，`.part` 保留，继续时走 Range。
3. 安装时先显示“正在安装”遮罩，2 秒后退出，交给 PowerShell helper：
   - 便携版：解压 staging，替换整个程序目录，保留 `cache`/日志，重启。
   - 安装版：调用 Setup `/SILENT`，显示安装程序进度，完成后重启。
   - 增量包：只替换/新增/删除变化文件，失败恢复已改动文件。
4. 详细规则和回滚矩阵见 [RELEASE_PROCESS.md](RELEASE_PROCESS.md)。

## 6. 前端结构

- `templates/index.html`：所有面板、设置弹窗、联机 Seed 弹窗、更新弹窗、全局提示。
- `static/app.js`：状态管理、API 调用、轮询、弹窗、更新 UI、地图交互。
- `static/product.css`：主布局、侧栏、结果区。
- `static/themes.css`：主题和深色模式。
- `static/update.css`：更新面板、安装遮罩。
- `static/ux-fixes.css`：全局提示、侧栏高度、联机卡片绿色状态等修正。
- `static/result_view.js`：结果卡渲染。

前端没有打包步骤。修改 `app.js`/CSS 后刷新页面即可；发布时注意 `templates/index.html` 里的 `?v=` 查询串要跟版本号一起改。

## 7. 本地开发

要求：

- Windows 10/11
- Python 3.13（与打包运行时一致）
- Microsoft Edge WebView2 Runtime
- Inno Setup 6（只生成安装包时需要）

```powershell
python -m pip install -r requirements.txt
python app.py
```

源码模式首次运行还需要准备本地引擎：

```text
prepare_offline_engine.bat
```

`prod.keys` 必须由用户从自己的 Switch 导入，仓库和发行包都不包含。

## 8. 构建

一键构建：

```text
一键编译.bat
```

或：

```powershell
powershell -ExecutionPolicy Bypass -File build\build_python_release.ps1
```

只出便携包：

```powershell
powershell -ExecutionPolicy Bypass -File build\build_python_release.ps1 -PortableOnly
```

构建脚本会：

1. 复制源码、`templates`、`static`、`offline_engine`、`vendor`、`tools`。
2. 从**当前全局 Python 3.13 的 site-packages** 复制依赖，不创建隔离环境。
3. 复制 `vendor/python-netlink/netlink`（LDN 导入必需）。
4. 生成 `python\pythonw.exe` 便携运行时、`Start-PLA.bat`、`Start-PLA.vbs`。
5. 生成 portable ZIP；非 `-PortableOnly` 时调用 Inno Setup 生成 Setup。
6. 用 `build/make_update_patch.py` 生成 `build/manifests/<version>.json`。
7. 若存在上一版本清单，生成相邻版本 patch ZIP 和 `release/patch-<version>.json`。
8. 生成 `release/update.json` 和 `release/SHA256SUMS.txt`。

因此构建机必须先装齐运行时依赖，否则打出来的包会在用户机器上报缺模块。历史上 `attrs`、`netlink` 都是这样漏掉的。

## 9. 改动指南

| 想改什么 | 先看哪里 |
|---|---|
| 新增/修改 API | `app.py` 的 `create_app()` |
| 联机采集流程 | `pla_mmo/seed_link.py`、`vendor/pla_mmo_seed/pla_mmo_seed.py` |
| 路径计算 | `pla_mmo/calculator.py`、`pla_mmo/multi.py`、`offline_engine` |
| 地图/点位 | `pla_mmo/spawn_maps.py`、`pla_mmo/spawns.py`、`static/spawn-maps/` |
| 更新/安装 | `pla_mmo/updater.py`、`pla_mmo/patch_helper.ps1` |
| 更新界面 | `static/app.js`、`static/update.css`、`templates/index.html` |
| 设置/主题 | `pla_mmo/settings.py`、`static/themes.css` |
| 安装器 | `build/installer.iss` |
| 版本号 | 见 [RELEASE_PROCESS.md](RELEASE_PROCESS.md) 的版本清单 |

改显示名之前先确认：项目标题、作者、技术标识（`pla_mmo`、`PLA-MMO-Seed-Path`、更新 URL）不要随手改，改名会断更新链路。

## 10. 约束和常见坑

- **路径要短**：便携版建议放 `D:\PLA-MMO-Seed-Path`。工作区深层路径可能让 pythonnet/WebView2 报 `Failed to resolve Python.Runtime.Loader.Initialize`。
- **不要用 PyInstaller 打包**：发行版是“复制 Python 运行时 + 源码”，不是单文件 exe。
- **不要用 Edge App 启动器**：窗口由 pywebview/WebView2 提供。
- **安装版按用户安装**：默认 `%LOCALAPPDATA%\Programs\PLA-MMO-Seed-Path`，不需要管理员权限。
- **用户数据在 `%LOCALAPPDATA%\PLA-MMO-Path-Finder`**：设置、日志、图片缓存；程序目录的 `cache` 放联机运行时、求解器、固件等资源。
- **增量包只用于相邻版本**：跨多个版本、首次安装、手动选择更新包时走完整包。
- **旧版不认识增量清单**：0.9.13 及更早版本仍会下载完整包；这是过渡限制，不是 bug。
- **更新清单不要带 BOM**：`update.json` 必须 UTF-8 无 BOM；构建脚本已用 `UTF8Encoding(false)`。
- **GitHub CDN 有缓存**：刚上传 `update.json` 后，`releases/latest/download/update.json` 可能短时间返回旧内容，等待或加查询参数核对。
- **没有代码签名**：SmartScreen 可能提示未知发布者，发布说明要提示核对 SHA256。

## 11. 验证清单

改动后至少跑：

```powershell
python -m py_compile app.py pla_mmo\updater.py pla_mmo\seed_link.py
node --check static\app.js
```

启动源码服务：

```powershell
$env:PLA_PORT="5059"; python app.py
```

检查：

- `GET /api/health` 返回正确版本、引擎状态。
- 设置 → 更新与维护能打开，不遮挡、不闪屏。
- 联机 Seed 弹窗能打开，资源状态正确。
- 打包后从 `release` 解压一份 portable，独立启动，不要只测源码。

## 12. 相关文档

- [HANDOFF.md](HANDOFF.md)：交接先读，当前状态、账号、待确认事项。
- [RELEASE_PROCESS.md](RELEASE_PROCESS.md)：版本、更新、回滚、发布规则。
- [RELEASE_NOTES.md](RELEASE_NOTES.md)：累计用户更新日志（构建会整篇写入 `update.json`）。
- [WORKLOG.md](WORKLOG.md)：开发过程记录，未发布改动先写这里。
