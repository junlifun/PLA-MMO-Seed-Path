# 交接说明

> 给接手的 AI 或开发者：先读这一篇，再读 [DEVELOPMENT.md](DEVELOPMENT.md) 和 [RELEASE_PROCESS.md](RELEASE_PROCESS.md)。  
> 最近更新：2026-11-27

## 1. 当前状态

- 当前发布版本：**v0.9.16**（产品名 **洗翠寻光**），已发布并标记 Latest。
- 源码位置：`D:\Office-software\File-storage\model\deepseek-harness\default-workspace\_new-repo`
- 本地稳定包：`D:\PLA-MMO-Seed-Path-Update\PLA-MMO-Seed-Path`（v0.9.16，含 `cache`）
- 本地 Setup：`D:\PLA-MMO-Seed-Path-Update\PLA-MMO-Seed-Path-0.9.16-Setup.exe`
- 用户已安装版本：`D:\PLA-MMO-Seed-Path`（v0.9.15）。**不要杀进程、不要替换文件、不要删 `cache`。**
- 工作区已从约 10 GB 清理到约 0.34 GB；删掉的是旧构建、旧版本资产和 Edge 测试配置，源码、文档、当前发行包都在。
- 目前没有待发布的程序改动；v0.9.16 已提交并推送。

## 2. 这个项目是什么

Windows 桌面工具，面向《宝可梦传说 阿尔宙斯》：

- 联机测 Seed：ESP32-S3 + Switch，收 2–4 只最初捕获，反推群体 Seed。
- 闪光路径计算：本地 RNG 引擎，算路线、点位、多只同时生成。
- 地图与标注、结果筛选、资源下载、应用内更新。

技术栈是 **Python 3.13 + Flask + pywebview/WebView2 + 原生 HTML/CSS/JS**。发行包是“复制 Python 运行时 + 源码”，不是 PyInstaller 单文件。

## 3. 已确认的关键决定

### 账号与对外身份

- GitHub：`junlifun`（原 `Yuutalin`，已改名；仓库和 git 访问会重定向）
- 作者显示名：`君粒`
- 产品显示名：**洗翠寻光**（用户已确认；窗口标题、页面标题、关于页、安装器、README 都用它）
- 应用图标：深色底、青色洗翠山形与闪光；源图 `docs/app-icon-source.jpg`，`build/make_icons.py` 生成 `static/app-icon.png`/`static/app.ico`
- 主仓库：`https://github.com/junlifun/PLA-MMO-Seed-Path`
- 旧资产前缀：`https://github.com/Yuutalin/PLA-MMO-Seed-Path/...`（兼容旧更新器，不要清理）
- 本机 `gh` 可能仍显示旧用户名，这是本地认证缓存；实际 API 身份以 `junlifun` 为准。
- 文档里不保存 token、密码或双重验证信息；发布用本机已登录的 `gh`。

### 功能基线

- 联机采集支持 2–4 只，2–3 只可提前完成反推；连接人名字默认 `seed`。
- 自动更新支持暂停/继续，手动选择更新包会暂停自动下载。
- 安装更新前显示遮罩，安装版显示安装程序进度。
- 每收录一只宝可梦，Seed 卡片变浅绿色。
- 错误优先显示在页面顶部全局提示，不再只塞在左上角卡片。
- 这些是已确认行为，改动前先确认不要回退。

### 更新与发布

- GitHub 仓库：`https://github.com/junlifun/PLA-MMO-Seed-Path`
- 旧地址：`https://github.com/Yuutalin/PLA-MMO-Seed-Path`（账号改名后仍重定向）
- 更新清单新地址优先、旧地址兜底；**资产下载地址故意保留旧仓库前缀**，否则旧版更新器会拒绝。
- 支持相邻版本增量更新（文件级 patch），不匹配或失败自动回退完整包。
- 增量安装失败会恢复已改动文件；没有自动降级，回滚用上一版完整包。
- 更新日志累计写：未发布写 `docs/WORKLOG.md`，用户日志写 `docs/RELEASE_NOTES.md`；构建把整篇日志写进 `update.json`，上传时 GitHub Release 正文用同一篇。
- **没有明确授权，不 push、不建 Release、不上传资产。** 只本地构建和报告。
- 0.9.13 及更早不识别增量包，会下载完整包；0.9.14+ 才能测试增量。
- 旧版 0.9.6/0.9.7 仍在用旧仓库下载白名单，短期不要清理旧仓库。

### 运行时与资源

- 联机用 **Pokeldn 精简版**，不是完整版；当前 `pokeldn-slim-v0.66.12-r3.zip`。
- r3 已补 `netlink`；更早的 r2 缺 `netlink`，会在联机时报 `No module named 'netlink'`。
- 应用自带 Python 的 `site-packages` 也内置 `netlink`，所以旧 runtime 用户升级 app 后也能用。
- 之前还漏过 `attrs`/`outcome`/`sniffio`/`sortedcontainers`/`idna`/`cffi`，已在 r2/r3 修。
- `prod.keys` 由用户自己导入，仓库和发行包不包含。
- EtumremMMO 求解器、固件、图片等资源放程序目录 `cache`，不要随便删。
- 用户设置/日志在 `%LOCALAPPDATA%\PLA-MMO-Path-Finder`。

### 安装与路径

- 便携版建议放短路径，例如 `D:\PLA-MMO-Seed-Path`。工作区深层路径可能让 pythonnet/WebView2 报 `Failed to resolve Python.Runtime.Loader.Initialize`。
- 安装版按用户安装，默认 `%LOCALAPPDATA%\Programs\PLA-MMO-Seed-Path`，不需要管理员权限。
- 程序目录有 `.installed` 表示安装版；不要删，否则更新会误判为便携版并下错包。
- 发行包没有代码签名，SmartScreen 可能提示未知发布者。

### 本地目录

`D:\PLA-MMO-Seed-Path-Update` 是对外测试目录，规则：

- 只保留当前版本的 `PLA-MMO-Seed-Path\`、当前 Setup、`CHANGELOG.md`、`README.md`、`启动测试版.bat`。
- 稳定便携目录**原地更新**，不要整个删掉重建；必须保留 `cache`。
- 删除旧版本或未知文件前先检查有没有别人的 changelog/说明；有疑问先问用户。
- `启动测试版.bat` 用 `PLA_PORT=5011`，避免和用户正在用的 5000 端口冲突。

## 4. 待确认/未完成

1. **联机 2–3 只自动收尾需要真实 Switch 再验证。**
   - 已实现 6 秒等待 + 重新连上取消，避免把“按 B 返回”误判成结束。
   - 没有真实硬件长时间验证，接手后不要默认它百分百可靠。
2. **安装器自动安装未做完整自动化验证。**
   - 本环境运行 Setup 静默安装曾挂起；编译成功、用户手动安装成功。
   - 改安装器后至少手动安装/卸载一次。
3. **增量更新只支持相邻版本。**
   - 跨版本、首次安装、手动选择文件都走完整包；这是设计，不是缺陷。
4. **没有代码签名。**
   - 不要承诺“无警告安装”；让用户核对 SHA256。
5. **新图标只验证到 512/32 px 预览。**
   - 圆角遮罩和深色描边是脚本合成的；如果用户觉得边缘仍发白，先看 `docs/app-icon-source.jpg` 是否本来就带白角。

## 5. 常用路径

| 用途 | 路径 |
|---|---|
| 源码 | `...\default-workspace\_new-repo` |
| 构建产物 | `_new-repo\release`（已清理，构建时重建） |
| 开发文档 | `_new-repo\docs` |
| 累计日志 | `_new-repo\docs\RELEASE_NOTES.md` |
| 开发记录 | `_new-repo\docs\WORKLOG.md` |
| 本地稳定包 | `D:\PLA-MMO-Seed-Path-Update\PLA-MMO-Seed-Path` |
| 本地 Setup | `D:\PLA-MMO-Seed-Path-Update\PLA-MMO-Seed-Path-0.9.16-Setup.exe` |
| 用户安装版 | `D:\PLA-MMO-Seed-Path`（不要动） |
| 用户数据 | `%LOCALAPPDATA%\PLA-MMO-Path-Finder` |
| 测试启动 | `D:\PLA-MMO-Seed-Path-Update\启动测试版.bat` |

工作区里的 `PLA-MMO-Seed-Path-Update` 是指向 `D:\PLA-MMO-Seed-Path-Update` 的目录 junction；不要从 junction 里直接双击 `Start-PLA.vbs`，用根目录的 `启动测试版.bat`。

## 6. 常用命令

```powershell
# 源码运行（浏览器调试）
# PLA_DEV 只用于热重载，默认不再自动开标签页，避免构建时刷出一堆窗口。
$env:PLA_DEV="1"; $env:PLA_PORT="5059"; python app.py

# 开发模式确实需要自动开一次浏览器时：
$env:PLA_DEV="1"; $env:PLA_OPEN_BROWSER="1"; $env:PLA_PORT="5059"; python app.py

# 源码运行（原生窗口）
$env:PLA_PORT="5059"; python app.py

# 语法检查
python -m py_compile app.py pla_mmo\updater.py pla_mmo\seed_link.py
node --check static\app.js

# 构建
powershell -ExecutionPolicy Bypass -File build\build_python_release.ps1

# 只出便携包
powershell -ExecutionPolicy Bypass -File build\build_python_release.ps1 -PortableOnly
```

接口自检：

```powershell
Invoke-RestMethod http://127.0.0.1:5059/api/health
```

## 7. 协作规则

- **先确认再开发**：需求有歧义、要改产品名/更新地址/安装方式/删文件，先问。
- **不要自动上传**：没有“上传/发布/发版”就只做本地构建和日志。
- **不要动用户数据**：`D:\PLA-MMO-Seed-Path`、`%LOCALAPPDATA%\PLA-MMO-Path-Finder`、程序 `cache`。
- **不要杀用户进程**：测试用独立端口/目录。
- **不要重建稳定目录**：原地替换，保留 `cache`。
- **不要删未知日志**：看到不认识的 changelog/说明，先问。
- **不要改技术标识**：`pla_mmo`、`PLA-MMO-Seed-Path`、旧仓库前缀、数据目录名。
- **改完写日志**：WORKLOG 记过程，RELEASE_NOTES 记用户可见变化。

## 8. 接手检查清单

1. 读本文、`DEVELOPMENT.md`、`RELEASE_PROCESS.md`。
2. `git status`，确认有没有未提交改动；不要覆盖别人的工作。
3. `GET /api/health` 或启动源码，确认当前版本。
4. 看 `docs/WORKLOG.md` 最后几条，确认有没有未发布改动。
5. 要发版时，按 `RELEASE_PROCESS.md` 的检查清单逐项做。
6. 有不确定的产品决策，先问用户，不要猜。

## 9. 相关文档

- [DEVELOPMENT.md](DEVELOPMENT.md)：架构、启动、构建、代码地图。
- [RELEASE_PROCESS.md](RELEASE_PROCESS.md)：版本、更新、回滚、上传流程。
- [RELEASE_NOTES.md](RELEASE_NOTES.md)：累计用户更新日志。
- [WORKLOG.md](WORKLOG.md)：开发过程记录。
