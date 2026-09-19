# @dsh-external/dsh-memory-steward

记忆管家：预算看门狗 + 整理计划待审批队列与审批 Tab + 全自动采纳开关（只读不改记忆文件，写入走 memory-evolve 官方 API）

由 dsh-super-injector dev_scaffold_plugin 生成。

## 构建与注入

```bash
DSH_CHECKOUT=<checkout> bash scripts/build.sh
# 注入器环境内：dev_inject_plugin <本目录>
```
