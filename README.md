# 洗翠寻光

> 项目代号：`PLA-MMO-Seed-Path`

《宝可梦传说 阿尔宙斯》MMO **Seed 获取 + 闪光路径计算**工具。

> 本仓库是新的独立项目，不是旧仓库 `PLA-MMO-Path-Finder` 的备份。  
> 旧仓库仅保留测 Seed 相关功能；本项目同时支持联机采集 Seed、地图点位和闪光路径计算。

- 作者：**君粒**
- 当前版本：**v0.9.16**
- 许可证：**GPL v3.0**
- 平台：Windows 10 / 11
- 状态：公开仓库

## 下载

- [Windows 安装版 v0.9.16](https://github.com/junlifun/PLA-MMO-Seed-Path/releases/download/v0.9.16/PLA-MMO-Seed-Path-0.9.16-Setup.exe)
- [Windows 便携版 v0.9.16](https://github.com/junlifun/PLA-MMO-Seed-Path/releases/download/v0.9.16/PLA-MMO-Seed-Path-0.9.16-portable.zip)
- [Pokeldn 精简运行时 r3](https://github.com/junlifun/PLA-MMO-Seed-Path/releases/download/v0.9.16/pokeldn-slim-v0.66.12-r3.zip)
- [SHA256 校验文件](https://github.com/junlifun/PLA-MMO-Seed-Path/releases/download/v0.9.16/SHA256SUMS.txt)

> v0.9.16 更新了应用名「洗翠寻光」和图标；0.9.15 用户只需下载约 500 KB 的增量包，0.9.14 及更早版本或首次安装仍需完整包一次。从 v0.9.6 起可在应用内检查更新。

安装版按用户安装，不需要管理员权限，安装后从开始菜单或桌面快捷方式启动。

便携版解压后运行：

```text
Start-PLA.bat
```

或双击 `Start-PLA.vbs`（不显示控制台窗口）。

程序使用自带的 Python + 原生 WebView2 窗口启动，**不使用 Edge App，也不会打开浏览器地址栏**。  
建议解压到较短的路径（例如 `D:\PLA-MMO-Seed-Path`），避免 Windows 旧式路径长度限制影响 WebView2 初始化。

## 功能

- 联机采集 2–4 只最初捕获宝可梦，并反推 MMO 群体 Seed
- 本地 RNG 路径计算，不上传 Seed 或存档
- 五地区地图与多只生成点位置
- 支持 2 只 / 3 只同时生成
- 支持多只生成点路径，路径深度 5 / 9 / 12 / 16
- 闪光、头目、方块闪组合筛选
- 结果卡显示性格、性别、闪光判定、个体值和路径概要
- ESP32-S3 无线板检测与固件烧录
- 多主题、浅色 / 深色模式
- 应用内检查更新、下载安装包、手动选择本地更新包
- 卸载时可选择清理缓存、日志、设置和更新包

## 更新与卸载

从 v0.9.6 开始，设置 →「更新与维护」可以检查 GitHub 最新版本、查看更新日志并下载更新包。

- 安装版会下载 Setup，确认后退出并显示安装程序进度，完成后自动重新打开。
- 便携版会下载 portable ZIP，在原目录替换程序文件，保留 `cache`、地图标注和自定义图片。
- 相邻版本（例如 0.9.15 → 0.9.16）优先下载只包含变化文件的增量包；下载前会校验本地文件是否仍与基线一致。文件被修改过、版本跨度太大或增量包校验失败时，自动改用完整包，并提示回退原因。
- 网络下载失败时，可以打开 Release 页面手动下载，再在「手动更新包」中选择 ZIP 或 Setup；程序会检查包结构，ZIP 还会检查版本和可选的 SHA256。
- v0.9.5 及更早版本没有更新中心，第一次升级仍需手动安装；从 v0.9.6 开始可以应用内更新。
- GitHub 账号已改名为 `junlifun`；v0.9.10 同时兼容新旧仓库地址，0.9.6 / 0.9.7 仍可通过应用内更新升级。
- 安装版的卸载程序会列出缓存、日志、设置和更新包，可勾选是否一起删除。程序内「设置 → 更新」下方也有清理入口。
- 更新不会包含 `prod.keys`、用户存档、日志或 `cache` 中的资源。

## 界面

![主界面](docs/screenshots/layoutA-final.png)

![地区与点位](docs/screenshots/app-regions-final2.png)

![结果卡](docs/screenshots/rich-alpha.png)

## 运行源码

要求：

- Windows 10 / 11
- Python 3.13（与打包运行时一致）
- Microsoft Edge WebView2 Runtime

```powershell
python -m pip install -r requirements.txt
python app.py
```

也可以双击项目根目录的 `启动.vbs`。

## 一键编译

需要：

- Python 3.13
- Inno Setup 6（仅生成安装包时需要）

双击：

```text
一键编译.bat
```

输出在 `release`：

```text
PLA-MMO-Seed-Path-0.9.16-Setup.exe
PLA-MMO-Seed-Path-0.9.16-portable.zip
PLA-MMO-Seed-Path-0.9.16-patch-from-0.9.15.zip
update.json
SHA256SUMS.txt
```

如果只想要便携版：

```powershell
powershell -ExecutionPolicy Bypass -File build\build_python_release.ps1 -PortableOnly
```

编译脚本会：

- 复制应用源码；
- 复制 Python 3.13 运行时及必要依赖；
- 生成便携 ZIP（内含 `python\pythonw.exe`）；
- 生成按用户安装的 Setup（快捷方式直接启动 `pythonw.exe app.py`）；
- 生成文件清单 `build\manifests\<version>.json`；
- 基于上一版本清单生成增量包和 `update.json` 更新清单；
- 生成 SHA256 校验文件。

编译产物不包含 `cache`、`prod.keys`、用户设置或日志；不使用 PyInstaller，也不使用 Edge App 启动器。

## 联机运行时

联机采集需要 Pokeldn 精简源码运行时，不随源码仓库分发。

当前资源地址：

```text
https://github.com/junlifun/PLA-MMO-Seed-Path/releases/download/v0.9.10/pokeldn-slim-v0.66.12-r3.zip
```

下载后在程序「设置 → 资源管理」中自动安装，或手动解压到：

```text
cache/pokeldn-slim/
```

`prod.keys` 必须由用户从自己的 Switch 导入，仓库和发行包都不包含。

## 开发与交接文档

- [开发与架构说明](docs/DEVELOPMENT.md)：技术栈、目录、启动链路、数据流、构建和常见坑。
- [发布与更新流程](docs/RELEASE_PROCESS.md)：版本号位置、累计更新日志、增量更新、回滚和上传规则。
- [交接说明](docs/HANDOFF.md)：当前状态、账号、路径、待确认事项和协作规则。
- [累计更新日志](docs/RELEASE_NOTES.md) / [开发记录](docs/WORKLOG.md)。

## 使用到的开源项目

| 项目 | 用途 | 许可证 |
|---|---|---|
| [Decryptu/pokeldn](https://github.com/Decryptu/pokeldn) | 联机运行时 / LDN | AGPL-3.0 |
| [kwsch/EtumrepMMO](https://github.com/kwsch/EtumrepMMO) | 四只 PA8 反推群体 Seed | 上游许可证 |
| [Lincoln-LM/JS-Finder](https://github.com/Lincoln-LM/JS-Finder) | 地图点位数据参考 | GPL-3.0 |
| [Serebii Pokéarth](https://www.serebii.net/pokearth/hisui/) | 地图底图参考 | 版权归 Serebii |

详细第三方说明见 `LICENSES.md`。

## 公开与分发说明

- 本仓库为公开项目；
- 不包含 `prod.keys`、用户存档、日志或个人数据；
- 不包含 Pokeldn 完整发行包；
- 宝可梦名称、图像和相关商标归各自权利人所有；
- 本项目为非官方工具，与 Nintendo / The Pokémon Company / GAME FREAK / Creatures Inc. 无隶属或认可关系。

## 致谢

- Pokeldn 上游作者
- EtumrepMMO 上游作者
- 地图与点位数据来源
- 所有参与测试和反馈的用户
