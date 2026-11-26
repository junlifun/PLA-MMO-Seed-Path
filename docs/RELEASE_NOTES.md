# v0.9.8

GitHub 账号已由 `Yuutalin` 改名为 `junlifun`。本版本只处理改名造成的影响，不包含其它功能改动。

## 变更

- 更新检查优先访问 `junlifun/PLA-MMO-Seed-Path`，访问失败时自动回退到 `Yuutalin/PLA-MMO-Seed-Path`。
- 更新包下载白名单同时接受新旧两个仓库地址，仍然校验文件大小和 SHA256。
- 资源管理中的 Pokeldn 精简运行时改用新仓库地址。
- README、Release 按钮和默认 Release 页面地址更新为 `junlifun`。
- 程序与安装包版本号更新为 0.9.8。

## 过渡兼容

- 0.9.6 / 0.9.7 通过旧地址仍可检查并下载本版本。
- 本版本的 `update.json` 在过渡期继续使用旧仓库的下载地址，避免旧版更新器因白名单只认旧地址而拒绝安装；新版程序同时接受新旧地址。
- 后续版本会在旧版用户完成升级后，再固定只使用 `junlifun` 地址。

## 注意

- 安装包未做商业代码签名，Windows SmartScreen 可能提示“未知发布者”，请核对 SHA256 后再运行。
- 便携版建议解压到较短路径，例如 `D:\PLA-MMO-Seed-Path`。
