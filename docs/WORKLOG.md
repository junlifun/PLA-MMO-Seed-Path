# 未发布修改记录

每次代码修改后先追加到这里。不要直接发布或上传；等明确要求“上传”时，再统一整理成版本更新日志。

## 2026-11-26

- 修复联机测 Seed 在 v0.9.9 中启动后退出代码 2。
  - 根因：精简运行时缺少 `python-netlink`（模块名 `netlink`）。`LDN/ldn/wlan.py` 在导入时无条件执行 `from netlink import ...`，即使实际由 ESP32 托管网络也会失败。
  - 运行时新增 `release/pokeldn-slim-v0.66.12-r3.zip`，包含 `netlink` 包及其 GPL-3.0 许可证。
  - 打包运行时把 `vendor/python-netlink/netlink` 放入自带 Python 的 `site-packages`，旧精简运行时用户升级程序后也能直接启动。
  - 采集器现在会把 `[pla]` 的启动错误转发到 UI，并在退出代码 2 时附带最近一条真实错误，不再只提示“请检查右侧输出”。
  - 版本号 0.9.10，已发布：https://github.com/junlifun/PLA-MMO-Seed-Path/releases/tag/v0.9.10
  - 发布前修正 `update.json` 更新日志的 UTF-8 读取问题，应用内不再显示乱码。
- 本地验证：
  - `dist-python` 自带 Python + 旧 r2 运行时（缺 netlink）能 `import netlink` 并让 `pla_host.py` 进入 `AP up` / `Hosting`，不再返回 2。
  - 测试版 UI 启动采集后进入 `waiting`，日志显示“正在等待 Switch”，未再出现代码 2；停止采集正常释放 COM5。
  - 测试包在 `D:\PLA-MMO-Seed-Path-Update\v0.9.10`，已带运行时、求解器、密钥和测试 README。
## 2026-11-27

- 自动更新支持暂停/继续；选择手动更新包时自动暂停正在下载的任务，保留 `.part` 以便续传。
- 联机采集支持 2–3 只直接完成：新增「完成采集并反推」按钮，减少强行凑 4 只的困扰。
- 联机设置新增「连接人名字」，默认 `seed`，可改为 1–12 个字符；采集器通过 `--exchange-name` 传给主机参数。
- 版本号 0.9.11（本地测试，未上传）。
- 本地验证：4 MB 限速下载暂停后续传 SHA 一致；采集器参数输出 `--data-exchange-name seed`；2–3 只停止后走已有 `_finish()` 反推路径。
