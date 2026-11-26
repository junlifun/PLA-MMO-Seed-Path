# v0.9.9

修复联机测 Seed 启动时报 `No module named 'attrs'` 的问题。

## 修复

- 打包的 Python 运行时补充 `attrs`、`attr`、`outcome`、`sniffio`、`sortedcontainers`、`idna` 依赖，联机采集子进程可直接启动。
- Pokeldn 精简运行时更新为 `pokeldn-slim-v0.66.12-r2.zip`，补齐上述依赖以及 `cffi` / `pycparser`，新安装不再缺少模块。
- 已安装过旧精简运行时的用户，升级本版本后无需删除 `cache`；程序自带的依赖会补上缺失模块。

## 说明

- 本版本仍兼容 `junlifun` 与旧名 `Yuutalin` 的仓库地址。
- 安装包未做商业代码签名，Windows SmartScreen 可能提示“未知发布者”，请核对 SHA256 后再运行。
- 便携版建议解压到较短路径，例如 `D:\PLA-MMO-Seed-Path`。
