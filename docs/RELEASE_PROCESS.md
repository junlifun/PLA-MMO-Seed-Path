# 发布与更新流程

> 适用版本：v0.9.15  
> 最近核对：2026-11-27  
> 代码结构见 [DEVELOPMENT.md](DEVELOPMENT.md)，交接先看 [HANDOFF.md](HANDOFF.md)。

## 1. 必须先遵守的规则

1. **没有明确说“上传 / 发布 / 发版”，就不要 push、不要创建 Release、不要上传资产。**
   - 本地 commit 可以做，但 push 也算对外发布；同样等确认。
   - 只本地构建、测试、更新日志，然后告诉用户产物在哪、哈希是多少。
2. **每次改动都写更新日志，累计上传。**
   - 未发布改动写进 `docs/WORKLOG.md`。
   - 面向用户的累计日志写进 `docs/RELEASE_NOTES.md`，新版本加在最上面，旧版本不要删。
   - 构建会把整篇 `RELEASE_NOTES.md` 写进 `update.json` 的 `notes`；上传时 GitHub Release 正文也用同一篇。这样更新文件本身带日志。
3. **一次只发一个版本，资产一次传齐。**
   - 不要每改一点就发一个 Release。
   - 用户确认发版后，把代码、portable、Setup、增量包、`update.json`、`SHA256SUMS`、运行时（如有变化）一起处理。
4. **需求不明确先问，不要自行扩大范围。**
   - 尤其是改产品名、改更新地址、改安装方式、动用户数据、删除文件。
   - 先确认再开发，避免返工。
5. **不要动用户已安装的 `D:\PLA-MMO-Seed-Path`。**
   - 不要杀进程、不要替换文件、不要删 `cache`。
   - 测试用独立目录和独立端口。

## 2. 版本号改哪些地方

发版前逐项核对，漏一处就会出现“界面 vX、程序 vY、更新清单 vZ”：

| 位置 | 内容 |
|---|---|
| `app.py` | `APP_VERSION = "x.y.z"` |
| `build/build_python_release.ps1` | `$Version = "x.y.z"`；`$PreviousVersion = "上一个版本"` |
| `build/installer.iss` | `MyAppVersion` / `OutputBaseFilename` 相关版本 |
| `templates/index.html` | 所有 `?v=x.y.z` 查询串；多开相关用 `x.y.z-multi20` |
| `README.md` | 当前版本、下载链接、构建文件名 |
| `docs/RELEASE_NOTES.md` | 顶部新增 `## vX.Y.Z` 段落 |
| `docs/WORKLOG.md` | 新增日期 + 版本条目 |
| `pla_mmo/resources.py` | 只有运行时/资源地址或哈希变化时才改 |

`build/manifests/*.json` 由脚本生成，不要手改；它是增量包的基线。

## 3. 更新日志怎么写

### WORKLOG

给开发/交接看，按时间记录：

```markdown
## 2026-11-27（0.9.16）

- 修复……
- 调整……
- 未验证：……
```

只写事实：改了什么、为什么、怎么验证、还有什么风险。

### RELEASE_NOTES

给用户看，按版本倒序：

```markdown
## v0.9.16

### 新增
- ……

### 修复
- ……

### 注意
- 0.9.13 及更早版本仍需先完整安装一次 0.9.14/0.9.15。
```

规则：

- 旧版本段落保留，形成完整历史。
- 不写内部函数名、不写密钥、不写本机绝对路径。
- 构建时整篇写入 `update.json`，所以不要放 HTML 或超长表格。
- GitHub Release 正文、本地 `CHANGELOG.md`、`update.json` 的 `notes` 三者保持一致。

## 4. 标准发版流程

### 4.1 改完代码

```powershell
python -m py_compile app.py pla_mmo\updater.py pla_mmo\seed_link.py
node --check static\app.js
```

启动源码验证：

```powershell
$env:PLA_PORT="5059"; python app.py
```

至少检查：`/api/health` 版本、设置弹窗、更新面板、联机 Seed 弹窗、一次实际计算。

### 4.2 写日志、改版本

先写 `WORKLOG.md`，再补 `RELEASE_NOTES.md`，最后统一改版本号。顺序不要反，否则容易漏日志。

### 4.3 构建

```powershell
powershell -ExecutionPolicy Bypass -File build\build_python_release.ps1
```

只出便携包：

```powershell
powershell -ExecutionPolicy Bypass -File build\build_python_release.ps1 -PortableOnly
```

构建机要求：

- Python 3.13，且全局 `site-packages` 已装齐 `requirements.txt`。
- Inno Setup 6 已安装（只做便携包可不需要）。
- 构建脚本会从全局 Python 复制依赖；不要用缺包的虚拟环境。

### 4.4 产物检查

`release/` 应包含：

```text
PLA-MMO-Seed-Path-<version>-portable.zip
PLA-MMO-Seed-Path-<version>-Setup.exe          # 非 PortableOnly
PLA-MMO-Seed-Path-<version>-patch-from-<prev>.zip  # 有上一版清单时
update.json
SHA256SUMS.txt
pokeldn-slim-v0.66.12-r3.zip                   # 运行时版本变化时
```

`patch-<version>.json` 是构建内部信息，不进 `SHA256SUMS`，也不作为发行资产上传。

检查：

- `update.json` 无 BOM，JSON 可解析，`version` 正确。
- `notes` 中文正常，不是乱码。
- `SHA256SUMS.txt` 只列对外资产，不列内部 patch info。
- Setup 文件版本与 `APP_VERSION` 一致。

### 4.5 本地测试

1. 解压 portable 到短路径，例如 `D:\PLA-Test-<version>`。
2. 用 `Start-PLA.vbs` 启动，确认窗口标题、`/api/health`、设置页。
3. 如有上一版，复制一份旧 portable，走应用内“检查更新”，确认：
   - 能发现新版本；
   - 优先下载增量包；
   - 安装后版本正确、`cache` 保留、无 `.update-old-*` 残留；
   - 窗口自动重启。
4. 手动选择更新包测试时，确认文件选择、校验、安装遮罩。
5. 测完关闭测试进程，删除临时目录。

### 4.6 更新本地发行目录

用户本地目录固定在：

```text
D:\PLA-MMO-Seed-Path-Update\
  PLA-MMO-Seed-Path\                 # 稳定便携目录，原地更新，不整个删掉重建
  PLA-MMO-Seed-Path-<version>-Setup.exe
  CHANGELOG.md
  README.md
  启动测试版.bat
```

规则：

- 只保留当前版本 Setup，旧 Setup 删除。
- 稳定便携目录原地替换程序文件，保留 `cache`（运行时、求解器、keys、地图数据）。
- 不要删用户自己放进去的文件。
- 改目录前先看有没有其他 AI/人留下的 changelog 或说明；发现未知内容先问，不要直接删。
- `启动测试版.bat` 指向稳定目录，端口用 5011 一类测试端口。

### 4.7 报告，等待上传授权

报告内容：

- 版本号、构建时间、产物路径。
- portable / Setup / patch / update.json 的大小和 SHA256。
- 测试结果（尤其增量安装）。
- 已知未验证项（例如没有真实 Switch、安装器只编译未安装）。

然后停在这里。**不要自动上传。**

## 5. 更新地址和兼容性

### 5.1 仓库

- 主仓库：`https://github.com/junlifun/PLA-MMO-Seed-Path`
- 旧仓库地址：`https://github.com/Yuutalin/PLA-MMO-Seed-Path`
- GitHub 账号已从 `Yuutalin` 改名为 `junlifun`。仓库网页和 git 会重定向，旧用户名保留一段时间；个人主页/Pages 不会重定向。
- 作者显示名：`君粒`。

### 5.2 清单地址

更新器按顺序尝试：

```text
https://github.com/junlifun/PLA-MMO-Seed-Path/releases/latest/download/update.json
https://github.com/Yuutalin/PLA-MMO-Seed-Path/releases/latest/download/update.json
```

新地址优先，旧地址兜底。旧版更新器只认旧仓库前缀，所以：

- `update.json` 里的资产下载地址**故意继续使用旧仓库前缀**：
  `https://github.com/Yuutalin/PLA-MMO-Seed-Path/releases/download/v<version>/...`
- `release_url` 用新仓库页面。
- 下载白名单同时接受新旧两个前缀。

不要为了“看起来统一”把所有 URL 改成新仓库，否则 0.9.6/0.9.7 等旧版会拒绝下载。

### 5.3 兼容性

- 0.9.6+：支持应用内更新。
- 0.9.13 及更早：不认识 `patch` 字段，会下载完整包；这是正常的 bootstrap 限制。
- 0.9.14+：支持相邻版本增量更新。
- 0.9.5 及更早：需要手动安装一次。
- 首次安装、跨多个版本、手动选择文件：一律走完整包。

## 6. 更新机制

### 6.1 检查

`UpdateService.check()` 拉取清单，比较版本，读取可选 `patch`：

- 当前版本必须等于 `patch.base_version`。
- 逐个校验 patch 中 replace/delete 文件的源 SHA256。
- 本地文件被改过、缺失、版本不匹配：不提供增量包，显示原因，回退完整包。

### 6.2 下载

- 优先增量包，失败或预检不通过自动回退完整包。
- 支持暂停/继续：`.part` 保留，继续时用 HTTP Range。
- 选择“手动更新文件”时，会自动暂停正在进行的自动下载。
- 下载完成后校验大小和 SHA256。

### 6.3 安装

1. 用户确认后显示“正在安装”遮罩。
2. 2 秒后主程序退出，helper 接管。
3. 便携完整包：解压 staging → 备份/移动旧目录 → 新目录就位 → 重启 → 清理旧备份。
4. Setup：静默调用 `/SILENT`，显示安装程序自带进度，完成后启动。
5. 增量包：按 `patch.json` 只改变化文件，重启。
6. 日志：`%TEMP%\pla-update.log`、`%TEMP%\pla-patch.log`。

`cache`、用户设置、日志不会被完整包覆盖；增量包明确排除这些路径。

## 7. 回滚与失败处理

| 场景 | 行为 | 结果 |
|---|---|---|
| 增量预检不通过 | 自动改下完整包 | 用户看到“已改为下载完整包” |
| 增量包下载失败 | 保留 `.part`，可重试/继续 | 程序文件不变 |
| 增量替换中失败 | 恢复已改动的 add/replace 文件，重启旧版 | 旧版可用，日志有原因 |
| 便携包移动/替换失败 | 尝试恢复旧目录，重启旧版 | 旧版可用 |
| Setup 安装失败/取消 | 保留旧安装，记录日志 | 需手动重装或重试 |
| 重启失败 | 写日志，不删除旧目录 | 用户可手动启动 |
| 新版本启动即崩溃 | 不自动降级；用完整包/旧 Setup 手动回滚 | 保留 `cache` 和用户数据 |

没有“自动降级”功能。需要回滚时，用上一版 Setup 或 portable 覆盖安装；不要删 `cache` 和 `%LOCALAPPDATA%\PLA-MMO-Path-Finder`。

## 8. 上传/发布清单（仅在明确授权后）

1. 确认工作区干净，提交代码：

```powershell
git status
git add ...
git commit -m "..."
git push origin main
```

2. 创建 Release：

```powershell
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file docs\RELEASE_NOTES.md
```

3. 上传资产：

```powershell
gh release upload vX.Y.Z `
  release\PLA-MMO-Seed-Path-X.Y.Z-portable.zip `
  release\PLA-MMO-Seed-Path-X.Y.Z-Setup.exe `
  release\PLA-MMO-Seed-Path-X.Y.Z-patch-from-PREV.zip `
  release\update.json `
  release\SHA256SUMS.txt `
  --clobber
```

运行时 ZIP 有更新时一并上传。`patch-*.json` 不上传。

4. 标记最新版：

```powershell
gh release edit vX.Y.Z --latest
```

5. 验证：

- GitHub API/Release 页面资产大小、digest 与本地一致。
- 新/旧仓库的 `releases/latest/download/update.json` 都返回新版本。
- 用一个旧版 portable 实际检查一次更新。
- 下载 `update.json` 校验 SHA256，确认无 BOM、中文正常。

`gh` 在本机路径是 `C:\Program Files\GitHub CLI\gh.exe`。如果报 `unable to find git executable`，把 `C:\Program Files\Git\cmd` 加到 `PATH` 再执行。

## 9. 常见问题

| 现象 | 原因/处理 |
|---|---|
| `releases/latest/download/update.json` 还是旧版 | GitHub CDN 缓存，等几分钟或加 `?t=时间戳` 核对 |
| 旧版检查不到更新 | 清单 BOM、地址前缀不对、版本号没变、CDN 缓存 |
| 增量包不提供 | 当前版本不是 `base_version`，或本地文件 SHA 不匹配；看 `patch_note` |
| 安装后版本没变 | 旧进程未退出、helper 失败、Setup 被取消；看 `%TEMP%` 日志 |
| 安装后 `.update-old-*` 残留 | WebView2 占用，下次启动会自动清理；也可在“清理本地数据”删除 |
| SmartScreen 提示 | 没有代码签名；让用户核对 SHA256 后用“更多信息→仍要运行” |
| Setup 静默安装没反应 | 本机策略/安全软件拦截；改用 portable，或手动运行 Setup |

## 10. 相关文档

- [DEVELOPMENT.md](DEVELOPMENT.md)：架构、启动、构建细节。
- [HANDOFF.md](HANDOFF.md)：交接状态、账号、待确认事项。
- [RELEASE_NOTES.md](RELEASE_NOTES.md)：累计更新日志。
- [WORKLOG.md](WORKLOG.md)：开发过程记录。
