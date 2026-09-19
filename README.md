# dsh-memory-steward（记忆管家）

给 [dsh-memory-evolve](https://www.npmjs.com/package/dsh-memory-evolve) 补上记忆的**生命周期闭环**：
它只有「入库闸门」，没有预算、没有淘汰、没有自动触发——管家负责**发现 → 提醒 → 出方案 → 审批 → 执行（带备份）**。

插件本身**不调 LLM**：判读由会话里的模型做（与 memory-evolve 的审查机制同构），管家只提供状态、出口和闸门。

## 它做什么

- **预算看门狗**：memory / user / key 三轨的条数与字节对照预算（固定阈值，或设基准后按 ×1.5 动态），超了才说话。
- **到期提醒**：超预算**或**归档超过阈值，且没有待审提案、距上次整理 ≥7 天 → 往 systemPrompt 注入一行【整理到期】。
- **整理提案队列**：`memory_propose` 提交，用户在「整理审批」Tab 勾选**采纳 / 拒绝 / 恢复**，有红点、有历史、可批量。
- **执行带备份**：一律回调 memory-evolve 官方 HTTP API（带 `origin` 头），每次执行前把 6 个记忆文件整文件备份到 `steward/backups/<提案id>-<ts>/`。
- **开销审计**：`/api/rounds` 记录每轮盘点次数、≈tokens（盘点输入 + 提案输出，按字符 ÷ 2 估）、提案/ops、执行成功失败与结束原因。

**硬边界**：绝不直接改记忆文件；单写者永远是 memory-evolve（它的锁、drift guard、格式校验都在）。

## 安装

需要先装 `dsh-memory-evolve`（管家是它的伴生插件，不重复实现存储）。

```bash
dsh plugin --profile web add <本包目录或 npm 包名>
# 重启 profile 生效
```

开发期用 dsh-super-injector 注入：`dev_inject_plugin <本目录>`，改完 `dev_reload_package dsh-memory-steward`（**无需构建**，见下）。

## 它长什么样

- **工具**：`memory_audit`（库存/预算/候选簇/归档预筛/条目清单）、`memory_propose`（提案，支持 `proposals` 数组批量 ≤20 条）、`memory_sweep_status`（到期查询与计时复位）。
- **Tab**：会话视图里的「整理审批」——配置区、库存预算、整理开销、待审列表（勾选/全选/反选/批量）、历史。
- **HTTP**（同一 webServer，带 Host/Origin 围栏）：`/memory-steward/api/{status,proposals,rounds,scan,config,baseline,proposals/approve|reject|restore|purge}`。
- **技能随包**：`skills/memory-hygiene/SKILL.md` 是整理规则的真源，插件 `apply()` 时同步到 `~/.dsh/skills/memory-hygiene/SKILL.md`（内容不同即覆写），`/api/status` 的 `skill` 字段回报 `installed/updated/unchanged/error`。

## 配置

Tab 里改，落盘在 `<memoryDir>/steward/config.json`：
`autoCheck`（12h 定时 + 回合末刷新）、`nudge`（注入提醒）、`lightMode`、`sweepIntervalDays`、`archiveMaxEntries`、`budgetRatio`、`roundKeep`、`autoApprove`、`baseline`。
**纯手动模式** = `autoCheck:false + nudge:false`（Tab 一键），此后只有工具/API 调用才刷新、才产提案。

运行数据都在 `<memoryDir>/steward/`：`proposals.json`、`config.json`、`rounds.json`、`backups/`。卸载插件不会删它们。

## 开发

**没有构建步骤**：`lib/index.js`（host，ESM）与 `lib/client.js`（client，`window.__ModuleLoader__.load` 包装的 CJS）就是源码，改完注入即生效。仓库里的 `src/`、`tsconfig.json`、`tsdown.config.ts`、`scripts/build.sh` 是脚手架残留，未参与发布，待清理。

```bash
npm test          # node --test，无需安装依赖（Node ≥ 20）
```

测试见 `test/`：假 ctx + 临时记忆目录 + 一个同时扮演管家 API 与 memory-evolve API 的本地 HTTP 服务，覆盖预算/到期判定、归档预筛分桶、提案解析、执行与备份、轮次记账、Origin 围栏、技能同步，以及客户端面板的渲染冒烟。

## 许可

BSD-3-Clause（`package.json` 声明的脚手架默认值；发布前待定，生态多为 MIT）。
