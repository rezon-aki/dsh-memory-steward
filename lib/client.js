window.__ModuleLoader__.load({ id: "@dsh-external/dsh-memory-steward", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
const React = require("react");
const h = React.createElement;
const API = "/memory-steward/api";
const LABEL = "整理审批";

async function getJson(path, init) {
  const res = await fetch(path, init);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { ok: false, message: text.slice(0, 200) }; }
  if (!res.ok || data.ok === false) throw new Error(data.message || ("HTTP " + res.status));
  return data;
}
const post = (path, body) => getJson(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

const card = { border: "1px solid var(--dsh-border, #d0d7de)", borderRadius: 8, padding: "10px 12px", marginBottom: 10 };
const row = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };
const btn = { padding: "3px 10px", borderRadius: 6, border: "1px solid var(--dsh-border, #d0d7de)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 12 };
const btnPrimary = Object.assign({}, btn, { background: "#2da44e", borderColor: "#2da44e", color: "#fff" });
const btnWarn = Object.assign({}, btn, { color: "#bf8700" });
const btnDanger = Object.assign({}, btn, { color: "#cf222e" });
const muted = { opacity: 0.65, fontSize: 12 };
const th = { textAlign: "left", padding: "2px 8px 2px 0", fontWeight: 600, fontSize: 12, opacity: 0.8 };
const td = { padding: "2px 8px 2px 0", fontSize: 13, verticalAlign: "top" };

const TRACK_LABEL = { memory: "memory(全局)", user: "user(全局)", key: "key(本项目)", project: "project 日志", daily: "daily" };
const STATUS_LABEL = { pending: "待审", applied: "已执行", rejected: "已拒绝", archived: "已归档", failed: "失败" };
const fmtBytes = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B");
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString() : "");
const fmtTokens = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n || 0) + "");
const ROUND_REASON = { complete: "完成", "all-resolved": "全部处理", timeout: "超时未结" };

function StatusTable(props) {
  const rows = props.rows || [];
  return h("table", { style: { borderCollapse: "collapse", width: "100%" } },
    h("thead", null, h("tr", null,
      h("th", { style: th }, "轨"), h("th", { style: th }, "条数"), h("th", { style: th }, "字节"),
      h("th", { style: th }, "预算"), h("th", { style: th }, "状态"), h("th", { style: th }, "最老"))),
    h("tbody", null, rows.map((r) => h("tr", { key: r.track },
      h("td", { style: td }, TRACK_LABEL[r.track] || r.track),
      h("td", { style: td }, String(r.entries)),
      h("td", { style: td }, fmtBytes(r.bytes)),
      h("td", { style: td }, r.budget ? ("≤" + r.budget.maxEntries + " 条/" + fmtBytes(r.budget.maxBytes)) : "仅报告"),
      h("td", { style: Object.assign({}, td, r.over ? { color: "#cf222e", fontWeight: 600 } : {}) }, r.over ? "超(" + r.reasons.join("+") + ")" : (r.report || "正常")),
      h("td", { style: Object.assign({}, td, muted) }, r.oldest || "—")))));
}

function ProposalItem(props) {
  const it = props.item;
  const busy = props.busy === it.id;
  const ops = (it.ops || []).map((o) => o.op + ":" + o.target).join(" + ");
  return h("div", { style: Object.assign({}, card, { marginBottom: 8 }) },
    h("div", { style: row },
      props.selectable ? h("input", { type: "checkbox", checked: !!props.checked, disabled: busy, onChange: () => props.toggle(it.id), style: { cursor: "pointer" } }) : null,
      h("strong", null, it.id),
      h("span", { style: muted }, it.track + " · " + it.kind + " · " + ops),
      it.source === "scan" ? h("span", { style: Object.assign({}, muted, { color: "#0969da" }) }, "确定性") : null,
      it.status !== "pending" ? h("span", { style: muted }, "[" + (STATUS_LABEL[it.status] || it.status) + "]") : null),
    h("div", { style: { margin: "6px 0", fontSize: 13 } }, it.summary),
    it.reason ? h("div", { style: muted }, it.reason) : null,
    it.error ? h("div", { style: { color: "#cf222e", fontSize: 12, marginTop: 4 } }, "错误：" + it.error) : null,
    it.evidence ? h("div", { style: Object.assign({}, muted, { marginTop: 4 }) }, "证据：" + JSON.stringify(it.evidence)) : null,
    h("div", { style: Object.assign({}, row, { marginTop: 8 }) },
      it.status === "pending" ? h("button", { style: busy ? btn : btnPrimary, disabled: busy, onClick: () => props.act("approve", [it.id]) }, busy ? "执行中…" : "采纳") : null,
      it.status === "pending" ? h("button", { style: btnDanger, disabled: busy, onClick: () => props.act("reject", [it.id]) }, "拒绝") : null,
      it.status !== "pending" ? h("button", { style: btn, disabled: busy, onClick: () => props.act("restore", [it.id]) }, "恢复待审") : null,
      h("span", { style: muted }, fmtTime(it.createdAt) + (it.appliedAt ? " → " + fmtTime(it.appliedAt) : ""))));
}

function Panel(props) {
  const [status, setStatus] = React.useState(null);
  const [items, setItems] = React.useState([]);
  const [err, setErr] = React.useState("");
  const [busy, setBusy] = React.useState("");
  const [scanning, setScanning] = React.useState(false);
  const [tab, setTab] = React.useState("pending");
  const [sel, setSel] = React.useState({});
  const [rounds, setRounds] = React.useState([]);
  const [openRound, setOpenRound] = React.useState(null);
  const [roundSum, setRoundSum] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const [s, p, rd] = await Promise.all([getJson(API + "/status"), getJson(API + "/proposals"), getJson(API + "/rounds")]);
      setStatus(s); setItems(p.items || []); setRounds(rd.rounds || []); setOpenRound(rd.open || null); setRoundSum(rd.summary || null); setErr(""); syncBadge(s && s.pending);
    } catch (e) { setErr(String(e.message || e)); }
  }, []);
  React.useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const act = async (action, ids) => {
    if (!ids || !ids.length) { setErr("没有选中任何提案"); return; }
    setBusy(ids.length === 1 ? ids[0] : ("bulk:" + ids.length));
    try {
      const r = await post(API + "/proposals/" + action, { ids });
      setSel({});
      await load();
      const okN = ((r && r.results) || []).filter((x) => x.ok).length;
      const verb = action === "approve" ? "采纳" : action === "reject" ? "拒绝" : action === "restore" ? "恢复" : "处理";
      setErr(verb + " " + okN + "/" + ids.length + " 条完成" + (okN < ids.length ? "（失败项见下方列表）" : ""));
    } catch (e) { setErr(String(e.message || e)); }
    finally { setBusy(""); }
  };
  const scan = async () => {
    setScanning(true);
    try { const r = await post(API + "/scan", {}); await load(); const c = r.clusters; const info = c ? ("候选簇 " + c.total + "（duplicate " + (c.hints.duplicate || 0) + " / similar " + (c.hints.similar || 0) + " / supersede " + (c.hints.supersede || 0) + "）") : ""; setErr((r.added ? ("新增 " + r.added + " 条提案；") : "确定性规则未命中（多为跨轨叙述，非重复）；") + info + "。其余簇需模型起草：在会话里说「按候选簇起草整理提案」即可。"); }
    catch (e) { setErr(String(e.message || e)); }
    finally { setScanning(false); }
  };
  const setCfg = async (patch) => {
    try { const r = await post(API + "/config", patch); await load(); setErr("配置已更新：" + JSON.stringify(patch).slice(0, 120)); return r; }
    catch (e) { setErr(String(e.message || e)); }
  };
  const setAuto = async (mode) => {
    try { const r = await post(API + "/config", { autoApprove: mode }); await load(); setErr("自动采纳 = " + r.config.autoApprove); }
    catch (e) { setErr(String(e.message || e)); }
  };
  const setBase = async () => {
    const cwd = props && props.session && props.session.header ? props.session.header.cwd : undefined;
    try { const r = await post(API + "/baseline", cwd ? { cwd } : {}); await load(); setErr(r.note ? r.note : ("已设基准 ×" + r.ratio)); const b = r.budgets || {}; setErr("已设基准 ×" + r.ratio + "：memory ≤" + (b.memory ? b.memory.maxEntries + " 条/" + fmtBytes(b.memory.maxBytes) : "-") + "，key ≤" + (b.key ? b.key.maxEntries + " 条/" + fmtBytes(b.key.maxBytes) : "-")); }
    catch (e) { setErr(String(e.message || e)); }
  };
  const resetBase = async () => {
    try { await post(API + "/baseline", { reset: true }); await load(); setErr("已清除基准，回到固定阈值"); }
    catch (e) { setErr(String(e.message || e)); }
  };

  const all = items || [];
  const pending = all.filter((i) => i.status === "pending");
  const history = all.filter((i) => i.status !== "pending").slice(0, 30);
  const cfg = (status && status.config) || {};
  const auto = cfg.autoApprove || "off";
  const selIds = pending.filter((i) => sel[i.id]).map((i) => i.id);
  const toggle = (id) => setSel((s) => Object.assign({}, s, { [id]: !s[id] }));
  const selectAll = () => { const next = {}; for (const i of pending) next[i.id] = true; setSel(next); };
  const invert = () => { const next = {}; for (const i of pending) if (!sel[i.id]) next[i.id] = true; setSel(next); };
  const clearSel = () => setSel({});

  return h("div", { style: { padding: "10px 12px", overflow: "auto", height: "100%" } },
    h("div", { style: row },
      h("strong", { style: { fontSize: 14 } }, "记忆管家"),
      h("span", { style: muted }, "只读观测 + 提案审批（执行走 memory-evolve 官方接口）"),
      h("button", { style: btn, onClick: load }, "刷新"),
      h("button", { style: btn, disabled: scanning, onClick: scan }, scanning ? "扫描中…" : "扫描生成提案")),
    err ? h("div", { style: { color: "#bf8700", fontSize: 12, margin: "6px 0" } }, err) : null,

    h("div", { style: Object.assign({}, card, { marginTop: 10 }) },
      h("div", { style: Object.assign({}, row, { justifyContent: "space-between" }) },
        h("strong", { style: { fontSize: 13 } }, "库存与预算"),
        h("span", { style: muted }, "最近检查：" + fmtTime(status && status.lastCheck) + (status && status.clusters ? "　候选簇 " + status.clusters.total : "") + (status && status.sweep ? ("　整理到期：" + (status.sweep.due ? "是" : "否") + "（上次 " + (status.sweep.days === null ? "从未" : status.sweep.days.toFixed(1) + " 天前") + "，待审 " + status.sweep.pending + "，归档 " + status.sweep.archiveEntries + (status.sweep.archiveOver ? " 超量" : "") + "）") : ""))),
      status ? h(StatusTable, { rows: status.rows || [] }) : h("div", { style: muted }, "加载中…"),
      (status && status.projects && status.projects.length > 1)
        ? h("div", { style: Object.assign({}, muted, { marginTop: 6 }) }, "各项目 key：" + status.projects.map((p) => p.hash + " " + p.entries + "条/" + fmtBytes(p.bytes)).join("　"))
        : null,
      h("div", { style: Object.assign({}, row, { marginTop: 8 }) },
        h("span", { style: muted }, "全自动采纳："),
        h("select", { value: auto, onChange: (e) => setAuto(e.target.value), style: { fontSize: 12, padding: "2px 6px" } },
          h("option", { value: "off" }, "关闭（手动审批）"),
          h("option", { value: "deterministic" }, "仅确定性提案（字面重复归档）"),
          h("option", { value: "all" }, "全部提案（不含删除）")),
        h("span", { style: muted }, auto === "off" ? "每条提案需在下方审批" : "新提案将自动执行（archive/remove/replace），执行前自动备份")),
      h("div", { style: Object.assign({}, row, { marginTop: 8 }) },
        h("span", { style: muted }, "预算基准："),
        h("button", { style: btn, onClick: setBase }, "以当前用量为基准 ×" + (cfg.budgetRatio || 1.5)),
        cfg.baseline ? h("button", { style: btn, onClick: resetBase }, "清除基准") : null,
        h("span", { style: muted }, cfg.baseline
          ? ("memory " + (cfg.baseline.memory ? cfg.baseline.memory.entries + "条/" + fmtBytes(cfg.baseline.memory.bytes) : "-") + "、key " + (cfg.baseline.key ? cfg.baseline.key.entries + "条/" + fmtBytes(cfg.baseline.key.bytes) : "-") + " → 预算 = 基准 ×" + (cfg.budgetRatio || 1.5))
          : "未设基准：用固定阈值（memory ≤20 条/8KB、key ≤25 条/12KB）")),
      h("div", { style: Object.assign({}, row, { marginTop: 8 }) },
        h("span", { style: muted }, "触发方式："),
        h("label", { style: { fontSize: 12, cursor: "pointer" } },
          h("input", { type: "checkbox", checked: cfg.autoCheck !== false, onChange: (e) => setCfg({ autoCheck: e.target.checked }) }), " 自动检查（定时+回合末）"),
        h("label", { style: { fontSize: 12, cursor: "pointer" } },
          h("input", { type: "checkbox", checked: cfg.nudge !== false, onChange: (e) => setCfg({ nudge: e.target.checked }) }), " 注入提醒（超预算/到期时出现在上下文）"),
        h("button", { style: btn, onClick: () => setCfg({ autoCheck: false, nudge: false }) }, "纯手动模式"),
        h("label", { style: { fontSize: 12, cursor: "pointer" } },
          h("input", { type: "checkbox", checked: cfg.lightMode !== false, onChange: (e) => setCfg({ lightMode: e.target.checked }) }), " 轻量模式（优先 archiveCheck+deep）")),
      h("div", { style: Object.assign({}, row, { marginTop: 6 }) },
        h("span", { style: muted }, "整理参数：间隔"),
        h("input", { type: "number", min: 1, defaultValue: cfg.sweepIntervalDays || 7, style: { width: 52, fontSize: 12, padding: "2px 4px" }, onBlur: (e) => setCfg({ sweepIntervalDays: Number(e.target.value) || 7 }) }),
        h("span", { style: muted }, "天 · 归档阈值"),
        h("input", { type: "number", min: 1, defaultValue: cfg.archiveMaxEntries || 30, style: { width: 56, fontSize: 12, padding: "2px 4px" }, onBlur: (e) => setCfg({ archiveMaxEntries: Number(e.target.value) || 30 }) }),
        h("span", { style: muted }, "条 · 预算倍率"),
        h("input", { type: "number", min: 1, step: 0.1, defaultValue: cfg.budgetRatio || 1.5, style: { width: 52, fontSize: 12, padding: "2px 4px" }, onBlur: (e) => setCfg({ budgetRatio: Number(e.target.value) || 1.5 }) }),
        h("span", { style: muted }, "× · 审计保留"),
        h("input", { type: "number", min: 1, defaultValue: cfg.roundKeep || 10, style: { width: 46, fontSize: 12, padding: "2px 4px" }, onBlur: (e) => setCfg({ roundKeep: Number(e.target.value) || 10 }) }),
        h("span", { style: muted }, "轮")),
      h("div", { style: Object.assign({}, muted, { marginTop: 6 }) },
        "淘汰过时条目：在会话里说「跑一轮记忆盘点」→ 模型用 memory_audit track=… 列全量、按 D/S/M/O/A/K 判读后用 memory_propose（支持 proposals 数组批量）提交，你在此页审批。")),

    h("div", { style: Object.assign({}, card, { marginTop: 10 }) },
      h("div", { style: row },
        h("strong", { style: { fontSize: 13 } }, "整理开销（最近 " + (cfg.roundKeep || 10) + " 轮）"),
        h("span", { style: muted }, "≈tokens = 该轮塞进上下文的清单字符 ÷ 2（不含模型输出）")),
      roundSum && roundSum.count
        ? h("div", { style: { marginTop: 4, fontSize: 13 } },
            "最近 " + roundSum.count + " 轮平均 ≈" + fmtTokens(roundSum.avgTokens) + " tokens；上一轮 ≈" + fmtTokens(roundSum.lastTokens) + " tokens",
            roundSum.lastTokens > roundSum.target
              ? h("span", { style: { color: "#c62828" } }, "（超目标 " + fmtTokens(roundSum.target) + "，下轮先用 archiveCheck 预筛）")
              : h("span", { style: muted }, "（目标 ≤" + fmtTokens(roundSum.target) + "）"))
        : null,
      openRound
        ? h("div", { style: Object.assign({}, muted, { marginTop: 4 }) }, "进行中 " + openRound.id + "：盘点 " + openRound.auditCalls + " 次 ≈" + fmtTokens(openRound.tokens) + " tokens · 提案 " + openRound.proposals + " 条/" + openRound.ops + " ops · 已执行 " + openRound.applied + "（失败 " + openRound.failed + "）")
        : null,
      rounds.length === 0 && !openRound ? h("div", { style: muted }, "暂无记录——跑一轮整理后这里会出现。") : null,
      rounds.length
        ? h("table", { style: { borderCollapse: "collapse", width: "100%", marginTop: 4 } },
            h("thead", null, h("tr", null,
              h("th", { style: th }, "开始"), h("th", { style: th }, "盘点"), h("th", { style: th }, "≈tokens"),
              h("th", { style: th }, "提案/ops"), h("th", { style: th }, "执行"), h("th", { style: th }, "结束"))),
            h("tbody", null, rounds.map((r) => h("tr", { key: r.id },
              h("td", { style: Object.assign({}, td, muted) }, fmtTime(r.startedAt)),
              h("td", { style: td }, String(r.auditCalls)),
              h("td", { style: td }, r.tokens >= 2000 ? h("span", { style: { color: "#c62828" } }, fmtTokens(r.tokens)) : fmtTokens(r.tokens)),
              h("td", { style: td }, r.proposals + "/" + r.ops),
              h("td", { style: td }, r.applied + (r.failed ? "（败 " + r.failed + "）" : "")),
              h("td", { style: Object.assign({}, td, muted) }, ROUND_REASON[r.reason] || r.reason || "")))))
        : null),
    h("div", { style: Object.assign({}, card, { marginTop: 10 }) },
      h("div", { style: Object.assign({}, row, { justifyContent: "space-between" }) },
        h("div", { style: row },
          h("button", { style: tab === "pending" ? btnPrimary : btn, onClick: () => setTab("pending") }, "待审批 " + pending.length),
          h("button", { style: tab === "history" ? btnPrimary : btn, onClick: () => setTab("history") }, "历史 " + all.filter((i) => i.status !== "pending").length)),
        tab === "pending" && pending.length > 1
          ? h("button", { style: btnDanger, onClick: () => act("reject", pending.map((i) => i.id)) }, "全部拒绝")
          : (tab === "history" && history.length > 0 ? h("button", { style: btn, onClick: () => act("purge", []) }, "清空历史") : null)),
      tab === "pending" && pending.length > 0
        ? h("div", { style: Object.assign({}, row, { marginTop: 8 }) },
            h("span", { style: muted }, "批量："),
            h("button", { style: btn, onClick: selectAll }, "全选 (" + pending.length + ")"),
            h("button", { style: btn, onClick: invert }, "反选"),
            h("button", { style: btn, disabled: selIds.length === 0, onClick: clearSel }, "清除选择"),
            h("button", { style: Object.assign({}, btnPrimary, selIds.length === 0 ? { opacity: 0.5 } : {}) , disabled: selIds.length === 0, onClick: () => act("approve", selIds) }, "采纳选中 (" + selIds.length + ")"),
            h("button", { style: Object.assign({}, btnDanger, selIds.length === 0 ? { opacity: 0.5 } : {}), disabled: selIds.length === 0, onClick: () => act("reject", selIds) }, "拒绝选中 (" + selIds.length + ")"))
        : null,
      h("div", { style: { marginTop: 8 } },
        (tab === "pending" ? pending : history).map((it) => h(ProposalItem, { key: it.id, item: it, act, busy, selectable: tab === "pending", checked: !!sel[it.id], toggle })),
        (tab === "pending" ? pending : history).length === 0 ? h("div", { style: muted }, tab === "pending" ? "没有待审提案。" : "暂无历史。") : null)));
}

let pending = 0;
let disposeTab;
let badgeCtx = null;

/** 立即同步红点（列表/状态一变就调；不必等 15s 轮询）。 */
function syncBadge(n) {
  const v = typeof n === "number" ? n : 0;
  if (v === pending) return;
  pending = v;
  if (badgeCtx) registerTab(badgeCtx);
}

/** 待审批计数变化时重注册 Tab（与 memory-evolve 同机制：label 变体 + 重注册生效）。 */
function registerTab(ctx) {
  try { if (typeof disposeTab === "function") disposeTab(); } catch { /* 旧注册已失效 */ }
  disposeTab = ctx.slots.inject("conversation.view", () => ctx.slots.register({
    name: "conversation.view",
    id: "steward-hub",
    order: 35,
    label: () => (pending > 0 ? "🔴 " + LABEL + " (" + pending + ")" : LABEL)
  }, Panel));
}

function apply(ctx) {
  badgeCtx = ctx;
  registerTab(ctx);
  ctx.effect(() => {
    const tick = async () => {
      try {
        const j = await (await fetch(API + "/status")).json();
        syncBadge(j && j.pending);
      } catch { /* 下次轮询再试 */ }
    };
    tick();
    const timer = setInterval(tick, 15000);
    return () => clearInterval(timer);
  }, "dsh-memory-steward: badge");
}

exports.apply = apply;
exports.inject = ["slots"];
return module.exports; } });