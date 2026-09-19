---
name: memory-hygiene
description: 整理 dsh-memory-evolve 记忆：先出归档/去重/合并清单，用户确认后执行；覆盖 memory/user/key 注入轨与 project/daily 日志轻量合并。触发：用户说整理/清理/归档/去重/合并记忆，或记忆过多/过长/重复、审查发现重复条目时。
---

# 记忆整理（归档 / 去重 / 合并）

## 何时用

- 用户说「整理 / 清理 / 归档 / 去重 / 合并记忆」，或抱怨记忆太多、太长、重复。
- 记忆审查到期、或自查发现同一事实被多条表述、旧条目占满注入轨。
- 管家（dsh-memory-steward）在快照里注入【记忆库存】/【整理到期】——那就是本技能的入口。
- 作用域：key/project 按当前会话工作目录隔离——在哪个项目会话里整理就覆盖哪个项目；memory/user 跨项目共享；daily 只能整理**今日**日志（历史每日文件的写入不做，工具按天定位文件）。

## 原则

- **成轮整理走管家通道**：`memory_audit`（盘点）→ `memory_propose`（提案）→ 用户在「整理审批」Tab 勾选采纳。提案执行前自动整文件备份（MEMORY/USER/KEY + 三个 `*-archive.md`），并有轮次开销审计；零散单条快改才用 `memory` 工具直接改。
- 只通过工具读写记忆内容；**不直接编辑** `~/.dsh/memories/` 下的文件（会破坏 § 格式、绕过锁与 drift guard）。
- **先出方案，等用户确认才动手**：走管家时"方案"就是待审提案，Tab 里勾选即确认；用 `memory` 工具直改时，先在会话里报清单等一句「执行」。
- 可逆优先：被合并 / 被覆盖 / 过时 / 低价值的主轨条目一律 `archive`（可移回）；只有内容完全等价、无独立信息的重复条目才 `remove`。已进归档轨、确认被主轨收录或被新事实推翻的，用 `purge` 删除。
- 不手写程序元数据：content 里不写 `[id:…]`、`[git …]`、日期时间戳前缀；key 合并时**保留原 `[branch:…]` 与 `[dsh-only]` 标记**（如需保留）。
- 日志轨（project/daily）不归档：只做"同一天内明显重复进度"的合并，不删除独有信息，不做时间段压缩摘要。
- 省 token：一轮的清单字符会进上下文（≈tokens = 字符 ÷ 2，记在 Tab「整理开销」与 `/api/rounds`）。默认先 `archiveCheck` 预筛、只对命中条目 `memory list filter=` 核对，别一上来拉全量；目标 ≤2K tokens/轮。

## 步骤

### 1. 盘点

1. **归档预筛（先跑，最省）**：`memory_audit {archiveCheck:true, track:"all"}`——归档条目对主轨做相似度比对，分「疑似已收录 / 归档独占 / 待判」三桶（独占不列全文）。
2. **主轨候选簇**——跑插件自带只读扫描器，或等价地用 `memory_audit {deep:true}`（输出更短）：
   ```bash
   M=~/.dsh/profiles/web/node_modules/dsh-memory-evolve
   node "$M/skills/memory-consolidate/scripts/scan_memory.mjs" --dir ~/.dsh/memories --out <工作区>/.scratch/memory-consolidate-report.json
   ```
   报告含候选簇（members / pairs / sim / reasons / hint=supersede|duplicate|conflict|similar / protected 标记）与统计；hint 只是建议，最终定性仍按第 2 步的分拣表。
3. **库存速查**：`memory_audit` 报各轨条数/字节/预算与超预算项（同一轮里顺带看，不必另跑脚本）。
4. **逐条核对**：只对报告命中 / 超预算的条目用 `memory list filter=<唯一子串>` 读正文；归档条目用 `memory_audit {track:"archive-memory"|"archive-user"|"archive-key"}`。候选多到必须逐条判读时，才 `memory_audit {track:"all"}` 一次拉全量。
5. 记录每条：轨道、日期、可唯一识别的子串、正文要点。

### 2. 分拣

| 类别 | 判定 | 动作 |
|---|---|---|
| 完全重复 D | 两条（或以上）表述同一事实、无互补细节 | 保留最完整/最新一条，其余 `remove`（无信息损失） |
| 被覆盖 S | 一条信息是另一条的严格子集 | 保留更全的一条，旧条目 `archive` |
| 可合并 M | 同一主题多条互补（同项目多个结论/踩坑） | 合成一条 `replace`，成员条目 `archive` |
| 过时 O | 已解决、已废弃、一次性叙事、不再影响后续会话 | `archive`（不 delete） |
| 低价值 A | 低频旧事，当前不重要但以后可能用 | `archive` |
| 保留 K | 长期有效、仍会注入的事实 | 不动 |
| 拿不准 | 信息可能还有用 | **不动**，在报告中标注「建议人工判断」 |

daily/project 只做 D 类：相邻或同日、内容高度重复的进度条目，`replace` 合并为一条；其余按类别不动。

### 3. 报告（必须等确认）

输出清单，每条包含：

- 轨道（memory / user / key / project / daily）
- 动作（archive / replace / remove / purge）
- 条目摘要（足够识别）与匹配用唯一子串
- 理由（D/S/M/O/A 或「已收录 / 已推翻 / 一次性快照」）
- 变更前 → 变更后：合并条目给出**完整新正文**（用户要审内容）

走管家通道时，报告即 `memory_propose` 提交后的 Tab 待审列表——上面这些字段就是提案的 `summary`/`reason`/`ops`，要在提案里写清楚。同时给出每轨 before/after 条数预估，以及「本次不动」的条目数。结尾明确等待用户确认，可让用户按序号增删。

### 4. 执行（确认后）

走管家：`memory_propose` 用 `proposals` 数组批量提交（一次 ≤20 条），等用户在 Tab 采纳；执行结果（含失败原因与备份路径）回写到提案。零散单条可用 `memory` 工具直改。推荐顺序，每步核对返回 `ok`：

1. 合并：`memory replace` 目标条目，content = 合并正文；memory/user 若需保留原日期，在正文首行写 `[YYYY-MM-DD]`（程序会保留）；key 带原 `[branch:…]`；不带 `[id:…]`/`[git …]`。
2. 归档：`memory archive` 被合并/被覆盖/过时条目（仅 memory/user/key），match 用足够长的唯一子串。
3. 删除：`memory remove` 仅完全重复条目（重复内容已保留在目标条目中）。
4. 归档清运：`memory_propose` 的 `op:"purge"` + `target:"archive-*"`（走官方 delete 接口，执行前有整文件备份）。
5. 日志：project/daily 仅对同一天明显重复的条目做 `replace` 合并，独有信息必须保留在正文里。

任一步失败（无匹配 / 多匹配 / drift 备份）立即停下报告原因，**不要**连续重试或改其它条目。

### 5. 收尾报告

- 每轨 before/after 条数；归档 N 条（可到记忆 Tab 归档页「移回主记忆」）；清除归档 M 条（purge）；删除 K 条（内容已并入保留条目）；未动条目数。
- 归档体检：疑似「已被主轨收录 / 已被新事实推翻 / 仅一次性状态快照」的条目清单与处置建议。
- 开销：本轮 ≈tokens 报一下（Tab「整理开销」或 `/api/rounds`），偏高就记下原因（是否拉了全量）。
- 提醒：归档内容不注入、可移回；项目若启用记忆同步，变动将在下次同步时对账。

### 6. 归档体检（每轮顺带做）

- 归档不注入上下文，堆积只占磁盘空间——真正要防的是**过时结论被移回主轨时误导**。
- 流程：`memory_audit {archiveCheck:true}` 预筛 → 对「疑似已收录 / 待判」用 `memory_audit {track:"archive-*"}` 读全文 + 关键词 grep 主轨核对 → 判定后提 purge 提案。
- 三类该清：**已被主轨收录**（重复）、**已被新事实推翻**（旧架构/旧语义，勿转正）、**仅一次性状态快照**（「当前状态…」「下一步…」）。**归档独占**的条目默认保留。
- 预筛相似度只作排序参考，**必须逐条对主轨全文比对**：措辞差异会把真重复压到 0.4 上下（报「待判」的往往其实已收录）；grep 时用 sha/commit/标识串最可靠，跨轨收录（归档在 memory、内容已进项目 key）也算已收录。
- purge 不可逆，因此**不在自动采纳允许集内**，必须人工在 Tab 确认。

## 坑

- `memory replace/remove/archive` 的 match 是**子串唯一命中**：短词会命中多条，用条目里独有的长片段。
- 多匹配/无匹配时换更精确片段重试，不要猜测乱改。
- 别把 `[id:…]` 写进 content（程序自动保留/生成）；project/daily/key 的日期时间戳、`[git …]` 由程序盖，日期信息写进正文。
- 日志轨无法 archive（工具拒绝该轨）——别对日志做归档。
- `memory` 工具本身删不了归档条目（只能读）——归档清运走 `memory_propose` 的 `purge`；`purge` 提案必须带唯一子串，提交前先确认该子串在归档文件里只命中一条。
- 全局轨 memory/user 注入每个会话，删除必须保守：拿不准就归档。
- key 的 `[summary:…]` 是程序元数据，合并后可不带（系统按正文首行生成新摘要）。
- key 条目带 `[branch:…]` 时合并必须保留原分支范围，否则会变成「全部分支可见」，跨分支串味。
- 单轮动作 ≤20 条：先跑低风险（归档、完全重复删除、归档清运），合并类可单列一轮，避免一次改太多难核对。

## 验证

- 执行后对每轨 `memory list` 抽查：候选词已消失、无残留重复、条数符合报告。
- `memory list archived=true`（memory/user/key）抽查归档条数 = 报告归档数；归档清运用 `memory_audit {track:"archive-*"}` 复核条数。
- 走管家的轮次：`/api/rounds` 看 ops/applied/failed 与本轮 ≈tokens，失败项在 Tab 历史里读原因。
- 若 replace 后出现重复/多余条目，停下报告，不做连环修改。
