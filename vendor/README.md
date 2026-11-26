# vendor/ · 联机采集脚本

这个目录只保留体积很小的采集脚本；大文件统一放在工具目录的 `cache/`，
缺失时由「设置 → 资源管理」从上游 GitHub Release 下载。

```
vendor/
└─ pla_mmo_seed/
   ├─ pla_mmo_seed.py      「阿尔宙斯 MMO 测 Seed」采集脚本 0.3.13（少量修改）
   └─ probe_board.py       本工具新增的板子探测脚本

cache/
├─ pokeldn-slim/            Pokeldn 上游源码运行时（约 38 MB，无 GUI/Flet）
├─ etumrempmmo/            EtumrepMMO 1.2.0 求解器（约 69.5 MB）
├─ pokeldn-data/           四只 PA8、latest_seed.txt、Pokeldn 数据
├─ keys/prod.keys          用户导入的密钥（可选，敏感）
├─ pokemon-images/         宝可梦图片缓存（可选）
├─ firmware/               ESP32 固件（可选）
└─ downloads/              临时下载包
```

调用方式（由 `pla_mmo/seed_link.py` 启动，独立子进程）：

```bat
set PYTHONPATH=%CD%\cache\pokeldn-slim
python vendor\pla_mmo_seed\pla_mmo_seed.py ^
  --mode collect --code 12345678 --channel 6 --seconds 1800 ^
  --keys "<用户自己的 prod.keys>" --trainer "OT|TID|SID|LANG|GENDER"
```

采集脚本通过 `PLA_SEED_SOLVER_DIR` 指向 `cache/etumrempmmo`，通过
`POKELDN_DATA` 指向 `cache/pokeldn-data`。

## 下载来源

| 组件 | 来源 | 说明 |
|---|---|---|
| Pokeldn 运行时 | https://github.com/Decryptu/pokeldn | 优先精简源码运行时；完整 Windows 包仅作回退 |
| EtumrepMMO | https://github.com/kwsch/EtumrepMMO/releases | `EtumrepMMO.ConsoleApp.1.2.0.zip` |
| ESP32 固件 | 同上 pokeldn Release | `pokeldn-radio-s3.bin` |
| 宝可梦图片 | https://github.com/PokeAPI/sprites | 可选，按需缓存 |
| prod.keys | 用户自己的 Switch | 不能下载、不能分发 |

## 许可

Pokeldn 为 AGPL-3.0，EtumrepMMO 按其上游发布包许可使用，采集脚本随原插件。
公开发布前请阅读项目根目录 `LICENSES.md`。
