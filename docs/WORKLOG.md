# 未发布修改记录

每次代码修改后先追加到这里。不要直接发布或上传；等明确要求“上传”时，再统一整理成版本更新日志。

## 2026-11-26

- 修复联机测 Seed 在 v0.9.9 中启动后退出代码 2。
  - 根因：精简运行时缺少 `python-netlink`（模块名 `netlink`）。`LDN/ldn/wlan.py` 在导入时无条件执行 `from netlink import ...`，即使实际由 ESP32 托管网络也会失败。
  - 运行时新增 `release/pokeldn-slim-v0.66.12-r3.zip`，包含 `netlink` 包及其 GPL-3.0 许可证。
  - 打包运行时把 `vendor/python-netlink/netlink` 放入自带 Python 的 `site-packages`，旧精简运行时用户升级程序后也能直接启动。
  - 采集器现在会把 `[pla]` 的启动错误转发到 UI，并在退出代码 2 时附带最近一条真实错误，不再只提示“请检查右侧输出”。
  - 版本号暂定 0.9.10，仅在本地测试；尚未上传 GitHub、未创建 Release。
- 本地验证：
  - `dist-python` 自带 Python + 旧 r2 运行时（缺 netlink）能 `import netlink` 并让 `pla_host.py` 进入 `AP up` / `Hosting`，不再返回 2。
  - 测试版 UI 启动采集后进入 `waiting`，日志显示“正在等待 Switch”，未再出现代码 2；停止采集正常释放 COM5。
  - 测试包在 `D:\PLA-MMO-Seed-Path-Update\v0.9.10`，已带运行时、求解器、密钥和测试 README。
