# Changelog

## 0.1.0 — 2026-09-19

首个公开版本。

### 能力

- **预算看门狗**：memory / user / key 三轨条数·字节对照预算（固定阈值或基准 ×倍率），只在超预算时说话。
- **整理到期提醒**：超预算**或**归档超量 + 无待审 + 距上次整理 ≥N 天 → 往 systemPrompt 注入一行，并给出这一轮的跑法（轻量模式先建议归档预筛）。
- **待审批队列 + 审批 Tab**：`memory_propose` 入队；勾选/全选/反选/批量采纳、拒绝、恢复待审、红点计数、历史。
- **带备份执行**：走 memory-evolve 官方 HTTP API（带 `origin` 头）；执行前 6 个记忆文件整份备份；执行锁 + 断点续跑。
- **提案期校验**：`replace` 空正文、含条目分隔符 `§` 直接拒绝。
- **三层治理**：队列（保留策略 `historyKeep` / `historyKeepDays` + 正文精简 `historySlim`）、事件日志 `history.jsonl`（只追加、不含正文）、备份 `backups/`。
- **列表瘦身 + 详情按需**：`GET /api/proposals` 只回轻量字段，正文走 `GET /api/proposals/:id`。
- **开销审计**：`/api/rounds` 记录每轮盘点输入 + 提案输出（按字符 ÷2 估 tokens）。
- **自检**：`GET /api/selfcheck` / `node scripts/selfcheck.mjs`，缺上游时报 FAIL 而不是静默失灵。

### 实测（13 条历史）

| 指标 | 前 | 后 |
|---|---|---|
| `steward/proposals.json` | 147,788 B | 13,855 B |
| `GET /api/proposals`（15s 轮询） | 138,849 B | 5,934 B |
| 事件日志 `history.jsonl` | — | 一行 185–190 B（上限 300 B） |

### 测试

31 例 `node --test`（假 ctx / 假 memory-evolve 服务 / 迷你 React 三件套），涵盖预算与到期判定、归档预筛分桶、
提案解析、执行与备份、断点续跑、并发锁、轮询载荷体积、保留策略端到端、事件日志边界、客户端按需请求。
