# 设计说明（Architecture）

> 面向二次开发与验收：讲清**契约与语义**，而不是复述代码。
> 用户向的安装与使用见 [README](../README.md)；只有人能跑的验收清单见 [TESTING.md](../TESTING.md)。

## 1. 它解决什么

dsh-memory-evolve 只有「入库闸门」：没有预算、没有淘汰、没有自动触发。管家补上**生命周期闭环**：

```
观测（只读扫描记忆文件）
  → 判定（超预算 / 归档超量 / 距上次整理够天数）
  → 提醒（往 systemPrompt 注入一行，健康时返回空串 → 零噪音）
  → 出方案（会话里的模型用 memory_propose 起草）
  → 审批（Tab 勾选/批量；或按开关自动采纳）
  → 执行（回调上游官方 API，执行前整份备份）
  → 治理（队列保留策略 / 事件日志 / 备份）
```

**插件本身不调 LLM**：判读由会话里的模型做（与上游的审查机制同构），管家只提供状态、出口和闸门。
**硬边界**：绝不直接写记忆文件——执行一律回调上游的 HTTP API（带 `origin` 校验），单写者仍是上游。

## 2. 交付物

| 文件 | 作用 |
|---|---|
| `lib/index.js` | host 半区（纯 JS ESM，无构建）：扫描/预算/到期、提案队列、三个工具、Web API、执行器、开销审计、事件日志 |
| `lib/client.js` | client 半区（`window.__ModuleLoader__.load` 包装的 CJS）：「整理审批」Tab |
| `cordis.patch.yml` | bundle patch：把 host 行插进 profile 的插件 roster |
| `skills/memory-hygiene/SKILL.md` | 整理规则真源；`apply()` 时同步到 `<dshHome>/skills/memory-hygiene/SKILL.md`（内容不同即覆写，`/api/status` 的 `skill` 字段回报 `installed/updated/unchanged/error`） |
| `scripts/selfcheck.mjs` | 对运行中实例的自检（`--json` 出原始返回） |
| `scripts/fixture.mjs` | 浏览器验收夹具：`seed` 造两条「原样重写」提案、`status`、`clear` |
| `test/` | 31 例 `node --test`（见 §5） |

运行数据都在 `<memoryDir>/steward/`（默认 `~/.dsh/memories/steward/`）：
`proposals.json`（队列）· `history.jsonl`（事件日志，只追加）· `config.json` · `rounds.json` · `backups/`（执行前的整份文件）。
卸载插件不会删它们。

## 3. 契约与语义

### 工具

- `memory_audit {deep?, archiveCheck?, track?, olderThanDays?, limit?, cwd?}`
  `track='all'` 一次拉全量（memory/user/key + 三个归档轨）；`archiveCheck` 归档预筛（与主轨 bigram 相似度分三桶：疑似已收录 / 归档独占 / 待判，省 token）；`deep` 跑上游 `scan_memory.mjs` 看候选簇。
- `memory_propose {ops | proposals[]}`：`match` 传唯一子串，host 解析成整条正文；批量 ≤20 条。
- `memory_sweep_status {check|complete}`：到期查询与计时复位。

### 审批与执行

- 动作：**采纳 / 拒绝 / 恢复 / 清空历史**（没有「归档」按钮）。历史区另有「清理日志」（留 7 天 / 清空，都带 confirm，只删日志）。
- **断点续跑**：一条提案的多个 op 顺序执行，已成功的 op 不重放（重放会因条目已被改写而假失败）。
- **执行锁**：每条提案同时只跑一次，并发/重复提交被挡（批量按钮双击曾造成「已成功却标 failed」）。
- **提案期校验**：`replace` 的正文不能为空、不能含条目分隔符 `§`。
- **备份**：执行前把 MEMORY/USER/KEY + 三个 `*-archive.md`（存在几个备几个）整份复制到 `backups/<提案id>-<ts>/`。

### 记忆操作

`archive`（默认，可移回）· `remove` · `replace` · `purge`（删归档项）。全部经上游官方 API。

### 预算与到期

- 固定阈值：memory ≤20 条/8 KB、user ≤10 条/4 KB、key ≤25 条/12 KB；设了基准后 = `max(固定, ⌈基准 × budgetRatio⌉)`。
- 到期：（超预算 **或** 归档条数 > `archiveMaxEntries`(30)）**且** 无待审 **且** 距上次整理 ≥ `sweepIntervalDays`(7) 天。

### 一轮 = 一条流水线

盘点（预筛优先）→ 主轨判读 D/S/M/O/A/K → 归档清运 → 批量提案 → `complete`。
**轻量模式**下提醒会建议先 `archiveCheck`+`deep`，候选多再拉全量。提案入队即复位计时；待审清零会自动以 `all-resolved` 结轮。

### 开销审计

`GET /api/rounds`：滚动 `roundKeep`(10) 轮，每轮记 `auditChars`（盘点清单）+ `proposeChars`（提案正文），`tokens = ⌈字符/2⌉`；
`summary` 给平均/最近/目标（2K，含输入输出拆分）。结束原因 `complete` / `all-resolved` / `timeout`。

### 确定性提案

只覆盖扫描器判定为 `duplicate` 的**同轨 memory/user** 簇（归档较旧一条；`archive` 可移回，执行前另有整文件备份）。
去重键是 `dup:<dropId>-><keepId>` 摘要，**同时读队列与事件日志**——清空队列后同一簇不会被重复提案。
跨轨叙述与日志内冲突**不生成**（日志不可归档）。

### 历史三层（删除语义）

| 用户动作 | 队列 `proposals.json` | 事件日志 `history.jsonl` | 备份 `backups/` |
|---|---|---|---|
| 拒绝 / 恢复 | 状态翻转（不删） | 记一行 | — |
| 删除记录 / 清空历史 | **删掉这些条目** | 保留（只记「被清空 N 条」一行） | 保留 |
| 清理日志 | — | 按天数或整文件删（带 confirm） | — |
| 自动淘汰 | 超出最近 N 条**且**早于 M 天才删 | 逐条留痕 | 保留 |

淘汰前先写日志，所以**没有任何条目会无声消失**；三层都只动管家自己的状态文件，永不碰记忆内容。

## 4. 怎么触发一轮整理

1. 对模型说一句「跑一轮记忆盘点」/「跑一轮全量整理」/「继续清归档」；
2. Tab 按钮「扫描生成提案」（只做确定性重复检测）；
3. `POST /api/scan`（脚本）；
4. 到期自动催：`autoCheck`+`nudge` 都开时，快照出现【整理到期】，模型收尾时执行。

审批后在 Tab 点「以当前用量为基准 ×1.5」可重设预算基准（key 轨需会话上下文）；归档清运后同样建议重设。

## 5. 测试

```bash
npm test        # = node --test test/*.test.mjs，31 例，不装任何依赖（Node ≥ 20）
```

- `test/harness.mjs`：假 ctx（收集注册的工具/路由/系统提示/effect）+ 临时记忆库（memory/user/key + 三个归档轨）+ 一个**同时扮演管家 API 与上游 API** 的本地服务（写入调用被记录，可断言 url/body/origin）。全程不碰真实 `~/.dsh`。
- `test/host.test.mjs`（17 例）：预算判定与提醒文案、到期条件、归档预筛三桶、提案解析（唯一子串→整条；歧义/无匹配拒绝）、采纳执行（回调 + 6 文件备份）、轮次记账、Origin 围栏 403、拒绝/恢复、技能同步、配置往返、无扫描器时优雅降级、自检、HTTP 提案口、`§` 校验、断点续跑、并发锁、历史清理。
- `test/history.test.mjs`（11 例）：`pruneQueue` 边界（待审永不丢 / 双阈值 / M 天内一律留 / 精简与淘汰是两个开关 / 存量 result 回显剥离）、事件日志行 ≤300 B 且不含正文、失败与清空留痕、列表与详情接口字段、**体积验收**、**保留策略端到端**、**去重读日志**、清理日志接口。
- `test/client.test.mjs`（3 例）：把 `lib/client.js` 当浏览器 bundle 加载（迷你 React），对真实运行中的服务渲染，断言开销卡片与待审行文案、**展开详情确实按需发请求**，含空态与历史 tab 清理入口。

**覆盖不到**（靠注入后手测 + 长期观察，清单见 TESTING.md）：真实浏览器里的 React/样式/皮肤、DSH 内核 API 变更、
上游真实接口语义（测试用假服务顶替）、真机网络。

## 6. 已做的验证（可复跑）

- 端到端 remove：临时条目 → 采纳 → 条目消失、`MEMORY.md` 字节还原、备份生成。
- 归档往返：`archive` → 归档轨出现 → 从归档轨删除 → 零残留。
- 批量与并发：一次入队多条 → 批量拒绝 → 清运；并发重复提交只执行一次（真实删除只发一次请求）。
- 真整理：16 条提案（主轨合并）采纳后 memory 28→14 条；归档清运 25 ops 采纳后 archive-memory 23→2、archive-key 11→7。
- 基准预算：设后 memory ≤42 条/28.9 KB、key ≤33 条/35.7 KB；reset 回固定阈值。
- 开销审计：一轮 `archiveCheck` 记 1 次 / 1575 字符 ≈ 788 tokens；`/api/rounds` 正常。
- 客户端：bundle 进 application 批次，`GET /plugins/??<pkg>/client.js&rev=…` = 200。
- 历史自动清理（13 条历史）：`proposals.json` 147,788 → **13,855 B**、`/api/proposals` 138,849 → **5,934 B**；
  13 条全部精简（都有备份）并剥离存量 `result` 回显；事件日志实测 185–190 B/行；`history/clear` 两种模式；selfcheck 7/7 PASS。

## 7. 已知限制

- **前置依赖**：没有上游时管家没有数据可管（自检会报 FAIL，执行会失败并写进提案 `error`）。依赖关系的表达见 §8。
- **正文精简是单向的**：已精简的条目不会再回填正文（正文在 `backups/`）；精简过的条目不能「恢复待审」（UI 隐藏按钮）。
- `GET /api/proposals` 的体积随条数线性增长：上限 20 条时约 9 KB。
- `history.jsonl` 没有自动 rotate（只有手动「清理日志」）：一行 ≈200 B，按每周一轮算一年 <100 KB。
- `backups/` 只增不减（清理入口尚未实现）。

## 8. 与上游的关系（重要）

管家**零代码耦合**地依赖上游：只调用 4 条官方路由（`/memory-evolve/api/memory/{delete,update,archive}`、`/memory-evolve/api/memory-files`）与 6 个记忆文件路径。

DSH 目前**没有「插件依赖插件」的声明机制**，所以这层依赖落在四处：

1. **文档**：README 首屏写明前置依赖与安装顺序；
2. **探测闸门**：自检静态核对上游 `lib/api.js` 里三个路由字符串是否存在（`memory-evolve 写入契约`）；
3. **存活探测**：`GET /memory-evolve/api/memory-files` 能否 200（`memory-evolve 存活`）；
4. **体面降级**：执行失败的原文写进提案 `error`；Tab 与 `/api/status` 都能看到上次错误。

不采用的三种做法及原因：`dependencies`/`peerDependencies`（装配真源是 profile 的 `dsh.profile.bundles`，进 node_modules 不进 roster；上游也不在 npm）、
`inject: ['<上游服务名>']`（上游没有 `ctx.provide(...)`）、在自家 bundle patch 里替上游 insert 行（重复 id 会让加载器报错起不来）。

## 9. 设计依据

**历史到底有什么用**（决定了保留策略）：

1. **失败可诊断**——靠 failed 项的 `error` + 时间戳定位问题（典型场景：三条失败挤在 2.5 秒内 = 并发重复提交竞态）。关键字段是 `error` + 时间戳，正文不需要。
2. **决策可追溯**——「这条被合并成了什么、原文是什么」。**备份目录已完整提供**，所以队列里的 `ops` 正文属重复存储。
3. **确定性提案去重**——靠 summary 防重复提同一簇；队列清空后由事件日志接着。

**没用的**：`results` 里的响应回显、久远成功项的 `ops` 正文、pretty-print 缩进。
**因此**：把队列当队列（只留 pending + 最近 N 条），另存只追加的事件日志，正文与还原材料归 `backups/`。

## 10. 开发与热重载

无构建步骤：改 `lib/index.js` / `lib/client.js` 就是改源码。

```bash
npm test                                   # 31 例回归
node scripts/selfcheck.mjs                 # 对运行中的实例自检
dev_reload_package {packageName: ...}      # 若装了 dsh-super-injector，可热重载
```

改客户端后浏览器需刷新页面（bundle 带 rev 哈希）。正式安装路径：
`dsh plugin --profile <name> add <路径或 git 地址>` → 重启 profile。
