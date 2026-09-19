# 测试手册（人机分工）

`npm test`（31 例）能覆盖的纯逻辑与 HTTP 层不在这里重复。这份只写**只有人或真环境才能验的**四类，每类都给了可复制的命令、期望结果和"不对时看哪里"。

---

## 0. 一条命令自检（怀疑坏了 / 升级后 / 重启后先跑）

```bash
cd <本仓库目录>
node scripts/selfcheck.mjs          # 加 --json 看原始返回；退出码非 0 表示有 FAIL
```

期望：7 项全 PASS。逐项含义与 FAIL 时的处置：

| 检查项 | 它在验什么 | FAIL 说明什么 |
|---|---|---|
| 技能随包同步 | `apply()` 已把仓库里的整理规则写进技能库 | 内容对不上=技能库被改脏或仓库没同步；重载插件即可覆盖 |
| 状态目录可写 | `~/.dsh/memories/steward/` 能真写一个探针文件再删 | 盘满/权限/DSH_HOME 指错 |
| 客户端 bundle 已组合 | 启动批次里能找到并 200 取到本插件的 `client.js` | **槽位/组合契约变了**（内核升级后最常坏在这）→ Tab 会消失 |
| memory-evolve 写入契约 | 静态读伴生插件的 `lib/api.js`，确认 delete/update/archive 三个路由还在 | 伴生插件没装，或上游改了路由名 → **采纳会失败**，但提案与备份仍安全 |
| memory-evolve 存活 | `GET /memory-evolve/api/memory-files` 能 200 | 伴生插件没起来/端口/围栏问题 |
| 工具注册 | 三个工具都真的注册进了 ctx | 插件加载报错（看 dsh 日志） |
| 提案队列可读 | `proposals.json` 能解析 | 文件损坏 → 读 `/api/proposals` 看报错 |

> 自检自己也有过假警报：全新安装时 `steward/` 目录还没被建过，探针写不进去——已修（写前先 mkdir）。所以 **selfcheck 报 FAIL 时先确认不是它的锅**：detail 里带 ENOENT/mkdir 这类信息就是环境问题。

---

## 1. 浏览器验收（Tab 真的能点）

自动化只做了 headless 渲染冒烟，**真实 React、真实点击、真实皮肤**只能你来。

```bash
node scripts/fixture.mjs seed      # 造 2 条夹具提案（原样重写：采纳=把正文写成一样，无实质变更）
#   然后回浏览器 Ctrl+Shift+R 刷新
node scripts/fixture.mjs status    # 任何时候看队列现状
node scripts/fixture.mjs clear     # 验完清干净（含待审，零残留）
```

刷新后逐条打勾：

- [ ] 会话视图出现「**🔴 整理审批 (2)**」——红点与计数对（证明 client→server 轮询与重注册生效）
- [ ] 打开 Tab：配置区、库存与预算表、整理开销卡片都在，数字与 `curl /api/status` 一致
- [ ] 待审列表两行，勾选框可用；**全选 (2) / 反选 / 清除选择** 计数跟着变（`采纳选中 (N)` 的数字要对）
- [ ] 点「**采纳选中**」→ 该条转入历史并显示**已执行**；点「**拒绝选中**」→ 显示已拒绝；再点「**恢复**」→ 回到待审
- [ ] 「整理开销」卡片：有 `最近 N 轮平均 ≈x tokens；上一轮 ≈y tokens（盘点 a + 提案 b）`；跑过整理后出现「进行中 …」或历史行
- [ ] 若在用皮肤（maid-atelier 等）：切过去再看一遍，**Tab 不空白、不重叠**（历史上踩过 fixed 包含块/皮肤层叠）
- [ ] 历史 tab：顶部一行「保留策略：最近 20 条 · 30 天（超出且超期才淘汰）　已淘汰 N 条 · 已精简 N 条　事件日志 … N 行 / x KB」；「清理日志（留 7 天）」「清空日志」两个按钮都弹 confirm
- [ ] 历史 tab 里点「▸ 查看详细」：先闪「加载详情…」，随后出现原记忆/修改后正文（**列表本身不该带正文**——网络面板里 `/api/proposals` 只有几 KB，`/api/proposals/<id>` 才是正文）
- [ ] 已执行过的老条目若标着「**正文已精简**」：展开显示备份指针、没有「恢复待审」按钮，这是预期（正文在 `backups/<id>-<ts>/`）
- [ ] 最后 `node scripts/fixture.mjs clear`，回页面确认待审归零、红点消失

**不对时看哪里**（按症状）：

| 症状 | 先看 |
|---|---|
| Tab 完全不出现 | `node scripts/selfcheck.mjs` 看「客户端 bundle 已组合」；再看 `/api/status` 的 `clientPath.urls` 是否含 `steward` |
| Tab 在但一片空白 | 浏览器控制台找 `slot entry crashed` / React error #130（组件没作为第二位置参数注册，见 docs/ARCHITECTURE.md 的槽位契约） |
| 红点数字不动 | 15s 轮询被拦（网络面板看 `/memory-steward/api/status`）；或页面没刷新 |
| 点采纳没反应/报错 | 看该条历史里的失败原因（写进提案的 `error` 字段）；对照 selfcheck 的「写入契约」项 |
| 皮肤下错位 | 检查 `.duc-root`/`position:fixed` 的包含块（backdrop-filter 会让 fixed 以该元素为基准） |

---

## 2. 真实后端语义（假服务替代不了）

夹具的**采纳**就是真实链路：它调 `/memory-evolve/api/memory/update` 真改文件。验收点：

- [ ] 采纳后，历史里该条显示**已执行**（绿色/正常），不是 failed
- [ ] `ls -lt ~/.dsh/memories/steward/backups/ | head` 出现**新目录**，里面 6 个文件（MEMORY/USER/KEY + 三个 `*-archive.md`；缺哪个说明那轨本来就不存在）
- [ ] `MEMORY.md`（或 USER.md）的 mtime 变了，但**语义没变**（因为夹具是原样重写）
- [ ] 反例演练（可选，验证失败路径也体面）：把某条夹具的 match 改成不存在的串（`POST /api/propose` 会 400 拒绝，正好证明"解析不到就不入队"）

想验归档轨真实往返（更强，但会真的动归档）：

```bash
# 看归档里还剩什么
curl -s http://127.0.0.1:3080/memory-steward/api/status | grep -o '"archiveEntries":[0-9]*'
# 让会话里的模型跑：memory_audit {track:"archive-*"} → 挑 1 条 → memory_propose purge → Tab 采纳
# 再用 memory_audit {track:"archive-*"} 复核条数，并确认 backups/ 里出现新目录
```

---

## 3. 内核升级后（换 DSH 版本，最容易坏的一类）

顺序固定，从便宜到贵：

1. `node scripts/selfcheck.mjs` —— 「客户端 bundle 已组合」「工具注册」「memory-evolve 写入契约」三项是**契约哨兵**
2. `npm test` —— 31 例纯逻辑回归（若内核变了 API 形状，测试里的假环境也会先暴露一半）
3. 刷新页面看 Tab 是否还在、能不能点（0.1.5 起 Tab 槽位保留，但组合契约历史上变过）
4. `curl -s .../api/rounds` 看还能不能记账（说明 webServer 前缀路由没被吃）
5. 真跑一轮整理（`memory_audit {archiveCheck:true}` → 提案 → 采纳），确认端到端没断

---

## 4. 长期质量（跑几周才有意义，别只看一次）

- **开销**：`/api/rounds` 每轮 `tokens` 是否稳定 ≤2K；偏高就回看那轮是不是拉了全量（`auditTokens` 占大头）
- **误报率**：历史里 拒绝 / (采纳+拒绝) 的比例。偏高说明提案质量差 → 回看 skill 的判据与模型判读，而不是加自动化
- **nudge 时机**：`【记忆库存】/【整理到期】` 是否只在真超预算/归档超量时出现（噪音多=阈值要调，或直接开纯手动模式）
- **备份是否在长**：采纳 N 次后 `backups/` 应有约 N 个目录；不涨说明 `backupOnApply` 失效（备份目前只增不减，手动清理入口还没做）
- **日志与队列体积**：`history.jsonl` 一行 ≈200 B（每周一轮整理 ≈10 KB/年）；`GET /api/proposals` 在 20 条上限时约 9 KB，超过说明轻量字段口径该收
- **归档是否回潮**：`archiveEntries` 长期单调上升 = 只归档不清运，该跑归档预筛了

---

## 已知覆盖不到（别指望自动化）

真实浏览器渲染与样式、DSH 内核 API 的未来变更、memory-evolve 真实接口语义（测试用假服务）、真机/跨平台差异、以及"这次整理判读得对不对"（那是模型判断质量，不是插件正确性）。
