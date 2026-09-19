/**
 * dsh-memory-steward — 记忆管家（host 半区，纯 JS 无构建）
 *
 * 只读观测 <memoryDir> 的记忆轨，按预算判定并把结论：
 *   1) 通过 memory_audit 工具随时可查；
 *   2) 仅在超预算时往 systemPrompt 注入一行（健康时返回空串 → DSH 不渲染，零噪音）；
 *   3) 生成「整理提案」进待审批队列（审批 Tab 采纳/归档/拒绝，或按开关自动采纳）。
 *
 * 硬边界：绝不直接写记忆文件。执行一律回调 dsh-memory-evolve 的官方 HTTP API
 * （带 Origin 校验、锁、drift guard），单写者仍是 memory-evolve。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, readdirSync, statSync, copyFileSync, unlinkSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-memory-steward'
export const inject = ['tools', 'systemPrompt']

const DELIM = '\n§\n'
const EVO_PREFIX = '/memory-evolve'
const DEFAULTS = {
  budgets: {
    memory: { maxEntries: 20, maxBytes: 8192 },
    user: { maxEntries: 10, maxBytes: 4096 },
    key: { maxEntries: 25, maxBytes: 12288 },
  },
  reportOnly: { project: { maxEntries: 200, maxBytes: 102400 }, daily: { keepDays: 30 } },
  checkIntervalMs: 12 * 3600 * 1000,
  nudge: true,
  autoApprove: 'off',
  maxAutoOps: 5,
  backupOnApply: true,
  autoCheck: true,        // 自动检查：定时(12h)+回合末刷新库存；关 = 纯手动（仅工具/API 调用时刷新）
  lightMode: true,        // 轻量模式：提醒里优先建议 archiveCheck+deep，候选多再拉全量
  roundKeep: 10,          // 整理开销审计：滚动保留轮数
  historyKeep: 20,        // 提案队列保留策略：非 pending 条目保留最近 N 条
  historyKeepDays: 30,    // 提案队列保留策略：早于 M 天才可能被淘汰/精简（与 N 取「且」）
  historySlim: true,      // 已结条目正文精简：正文只留在 backups/；关掉则整份留在队列
  historyStats: null,     // { pruned, slimmed, lastPrunedAt, lastSlimmedAt }：累计淘汰/精简数
  budgetRatio: 1.5,   // 设了基准后：预算 = ceil(基准 × budgetRatio)
  baseline: null,     // { memory:{entries,bytes}, user:{...}, key:{...} }
  sweepIntervalDays: 7, // 整理到期间隔：超预算/归档超量且无待审提案、距上次整理超过 N 天 → 到期
  archiveMaxEntries: 30, // 归档轨条数阈值：超过也视为「该做一轮整理」（归档清运）
  lastSweepAt: 0,       // 上次整理（生成提案或 complete）时间戳
}

const dshHome = () => process.env.DSH_HOME || join(homedir(), '.dsh')
const memoryDirOf = (config) => (config && config.memoryDir) || join(dshHome(), 'memories')
const projectHash = (cwd) => createHash('sha1').update(String(cwd)).digest('hex').slice(0, 12)
const entryDate = (e) => (String(e).match(/^\[(\d{4}-\d{2}-\d{2})/) || [])[1] || ''

function readEntries(file) {
  try { return readFileSync(file, 'utf8').split(DELIM).map((s) => s.trim()).filter(Boolean) } catch { return [] }
}
function sizeOf(file) { try { return statSync(file).size } catch { return 0 } }
function mtimeOf(file) { try { return statSync(file).mtimeMs } catch { return 0 } }
function loadJson(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback } }
function saveJson(file, value, compact) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, (compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)) + '\n')
  renameSync(tmp, file)
}

const DAY = 86400000
const HIST_SUMMARY_MAX = 60    // 队列 side 的 summary 截断（列表/日志去重键，同一口径才可比）
const HIST_LINE_MAX = 300      // 事件日志每行字节上限（验收标准）
const HIST_ERROR_BYTES = 75    // error 的字节预算：诊断靠它 + 时间戳
/** 截断（超长加省略号）：按字符，列表接口与去重键用同一套口径。 */
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n - 1) + '…' : t }
/** 按 UTF-8 字节截断（中文按 3 字节算，别让一行日志超预算）。 */
const clipBytes = (s, max) => {
  const str = String(s == null ? '' : s), b = Buffer.from(str, 'utf8')
  if (b.length <= max) return str
  return b.slice(0, Math.max(0, max - 3)).toString('utf8').replace(/\uFFFD+$/, '') + '…'
}
/** 结案时刻：apply/reject 时写 resolvedAt；缺省退回执行/创建时间。 */
const resolvedAtOf = (i) => i.resolvedAt || i.appliedAt || i.createdAt || 0
/** 精简后的 op：动作与轨保留，正文换成备份指针（正文一律不进日志、只在队列与备份里）。 */
const slimOp = (op, item) => ({ op: op.op, target: op.target, match: '[正文已精简' + (item.backup ? '：原文见 backups/' + basename(String(item.backup)) + '/' : '') + ']' })
/** 存量数据里的 results 还带着 result 回显（① 之前的旧写法）：顺手剥掉，别再写回盘；op/ok/message 原样保留（续跑要用）。 */
const leanResults = (i) => {
  const rs = i.results
  if (!Array.isArray(rs) || !rs.some((r) => r && Object.keys(r).length > 3)) return i
  return { ...i, results: rs.map((r) => ({ op: r.op, ok: r.ok, message: r.message || '' })) }
}

/**
 * 保留策略（纯函数，无 I/O）：
 *  - pending 永不自动清；
 *  - 非 pending 条目「超出最近 N 条 **且** 早于 M 天」才淘汰（failed/rejected 在 M 天内一律保留）；
 *  - 留下的已结条目在「有备份（原文已另存）或早于 M 天」时精简 ops 正文，只留动作与轨。
 * 返回新数组，不改入参。
 */
export function pruneQueue(items, cfg, now = Date.now()) {
  const keep = cfg && cfg.historyKeep > 0 ? cfg.historyKeep : 20
  const days = cfg && cfg.historyKeepDays >= 0 ? cfg.historyKeepDays : 30
  const cut = now - days * DAY
  const slimOn = !cfg || cfg.historySlim !== false
  const resolved = items.filter((i) => i.status !== 'pending').sort((a, b) => resolvedAtOf(b) - resolvedAtOf(a))
  const recent = new Set(resolved.slice(0, keep).map((i) => i.id))
  const dropped = [], kept = []
  let slimmed = 0
  for (const i of items) {
    if (i.status === 'pending') { kept.push(leanResults(i)); continue }
    if (!recent.has(i.id) && resolvedAtOf(i) <= cut) { dropped.push(i); continue }
    if (slimOn && !i.slim && (i.backup || resolvedAtOf(i) <= cut)) {
      slimmed++
      kept.push({ ...leanResults(i), slim: true, ops: (i.ops || []).map((o) => slimOp(o, i)) })
    } else kept.push(leanResults(i))
  }
  return { kept, dropped, slimmed }
}

/** 事件日志一行：{ts,id,status,track,kind,summary,error,backup,ops}——只记摘要与诊断，绝不含 ops 正文。
 *  整行保证 ≤ HIST_LINE_MAX 字节：先给 error 留 75 B，剩下的全给 summary（用户拍板：日志保留标题）。 */
export function histLine(r) {
  const head = {
    ts: r.ts || Date.now(), id: r.id || '*', status: r.status || null,
    track: r.track || null, kind: r.kind || null, summary: '',
    error: r.error ? clipBytes(r.error, HIST_ERROR_BYTES) : null,
    backup: !!r.backup, ops: r.ops || 0,
  }
  let summary = clipBytes(r.summary, Math.max(40, HIST_LINE_MAX - Buffer.byteLength(JSON.stringify(head))))
  // JSON 转义（引号/反斜杠）可能再涨几字节：超了就按同口径再削一次
  while (Buffer.byteLength(JSON.stringify({ ...head, summary })) > HIST_LINE_MAX && summary.length > 1) summary = clipBytes(summary, Buffer.byteLength(summary, 'utf8') - 6)
  return { ...head, summary }
}
export const itemLine = (i, status) => histLine({
  id: i.id, status: status || i.status, track: i.track, kind: i.kind,
  summary: i.summary, error: i.error, backup: i.backup, ops: (i.ops || []).length,
})
/** 日志里的 summary 集合（确定性提案去重：队列清空后不重复提同一簇）。 */
export function historySummaries(file, limit = 500) {
  const out = new Set()
  try {
    for (const l of readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit)) {
      try { const r = JSON.parse(l); if (r && r.summary) out.add(r.summary) } catch { /* 坏行跳过 */ }
    }
  } catch { /* 还没有日志 */ }
  return out
}
const briefOps = (ops) => (ops || []).map((o) => o.op + ':' + o.target).join(' + ')
/** 列表接口的轻量投影：不含 ops/results 正文（详情按需走 GET /api/proposals/:id）。 */
export const listItem = (i) => ({
  id: i.id, summary: clip(i.summary, 120), status: i.status, track: i.track, kind: i.kind, source: i.source,
  reason: clip(i.reason, 60), createdAt: i.createdAt, appliedAt: i.appliedAt || null,
  error: i.error || null, opCount: (i.ops || []).length, backup: !!i.backup, slim: !!i.slim,
  opsBrief: briefOps(i.ops),
})
/** 按时间切日志：cut 之前的行删掉（days=0 → cut=now → 全清）。 */
export function trimLog(text, cut) {
  const lines = String(text || '').split('\n').filter(Boolean)
  const kept = lines.filter((l) => { try { return (JSON.parse(l).ts || 0) >= cut } catch { return false } })
  return { kept: kept.length, removed: lines.length - kept.length, text: kept.length ? kept.join('\n') + '\n' : '' }
}

function filesOf(memoryDir, cwd) {
  const pdir = cwd ? join(memoryDir, 'projects', projectHash(cwd)) : null
  return {
    memory: join(memoryDir, 'MEMORY.md'),
    user: join(memoryDir, 'USER.md'),
    memoryArchive: join(memoryDir, 'MEMORY-archive.md'),
    userArchive: join(memoryDir, 'USER-archive.md'),
    key: pdir ? join(pdir, 'KEY.md') : null,
    keyArchive: pdir ? join(pdir, 'KEY-archive.md') : null,
    project: pdir ? join(pdir, 'MEMORY.md') : null,
  }
}

function measure(file) {
  const entries = readEntries(file)
  const dates = entries.map(entryDate).filter(Boolean).sort()
  return { entries: entries.length, bytes: sizeOf(file), oldest: dates[0] || '', newest: dates[dates.length - 1] || '', mtime: mtimeOf(file) }
}

/** 只读扫描：当前会话的轨 + 全部项目 key 概览 + daily 汇总。 */
function scan(memoryDir, cwd) {
  const f = filesOf(memoryDir, cwd)
  const tracks = { memory: measure(f.memory), user: measure(f.user), memoryArchive: measure(f.memoryArchive) }
  if (f.key) { tracks.key = measure(f.key); tracks.keyArchive = measure(f.keyArchive); tracks.project = measure(f.project) }
  let dailyFiles = 0, dailyBytes = 0, dailyMtime = 0
  try {
    for (const n of readdirSync(join(memoryDir, 'daily'))) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(n)) continue
      const p = join(memoryDir, 'daily', n)
      dailyFiles += 1
      dailyBytes += sizeOf(p)
      dailyMtime = Math.max(dailyMtime, mtimeOf(p))
    }
  } catch { /* 无 daily 目录 */ }
  tracks.daily = { entries: null, files: dailyFiles, bytes: dailyBytes, mtime: dailyMtime }
  const projects = []
  try {
    for (const h of readdirSync(join(memoryDir, 'projects'))) {
      const k = join(memoryDir, 'projects', h, 'KEY.md')
      if (existsSync(k)) projects.push({ hash: h, ...measure(k) })
    }
  } catch { /* 无 projects 目录 */ }
  return { at: Date.now(), cwd: cwd || null, tracks, projects, suggestionsBytes: sizeOf(join(memoryDir, 'SUGGESTIONS.jsonl')) }
}

function overOf(state, budget) {
  if (!state || !budget) return []
  const bad = []
  if (budget.maxEntries && state.entries > budget.maxEntries) bad.push('条数')
  if (budget.maxBytes && state.bytes > budget.maxBytes) bad.push('字节')
  return bad
}

/** 有效预算：有基准就按 ceil(基准 × budgetRatio)，否则用固定阈值。 */
function budgetsOf(cfg) {
  if (!cfg.baseline) return cfg.budgets
  const ratio = cfg.budgetRatio || 1.5
  const out = {}
  for (const t of ['memory', 'user', 'key']) {
    const b = cfg.baseline[t]
    const fixed = cfg.budgets[t] || {}
    out[t] = b
      ? { maxEntries: Math.max(fixed.maxEntries || 0, Math.ceil(b.entries * ratio)), maxBytes: Math.max(fixed.maxBytes || 0, Math.ceil(b.bytes * ratio)) }
      : fixed
  }
  return out
}

/** 某一轨的全量条目清单（供模型逐条判 D/S/M/O/A/K）。 */
function trackListing(memoryDir, cwd, track, olderThanDays, limit) {
  const f = filesOf(memoryDir, cwd)
  const file = track === 'memory' ? f.memory
    : track === 'user' ? f.user
    : track === 'key' ? f.key
    : track === 'archive-memory' ? f.memoryArchive
    : track === 'archive-user' ? f.userArchive
    : track === 'archive-key' ? f.keyArchive
    : null
  if (!file) return { ok: false, message: '无法定位 ' + track + ' 轨（key 需要会话工作目录）' }
  const rows = readEntries(file).map((e, i) => ({ i: i + 1, date: entryDate(e), bytes: Buffer.byteLength(e), head: e.replace(/\s+/g, ' ').slice(0, 120) }))
  const cutoff = olderThanDays ? Date.now() - olderThanDays * 86400000 : null
  const filtered = cutoff ? rows.filter((r) => r.date && new Date(r.date + 'T00:00:00').getTime() < cutoff) : rows
  filtered.sort((a, b) => String(a.date).localeCompare(String(b.date)))
  return { ok: true, track, total: rows.length, matched: filtered.length, rows: filtered.slice(0, Math.max(1, Math.min(200, limit || 60))) }
}

function formatListing(l, track, olderThanDays) {
  if (!l.ok) return '\n' + l.message
  const lines = ['', '—— ' + (TRACK_LABEL[track] || track) + ' 全量清单：共 ' + l.total + ' 条' + (olderThanDays ? '，其中早于 ' + olderThanDays + ' 天的 ' + l.matched + ' 条' : '') + '（按日期升序）——']
  for (const r of l.rows) lines.push('#' + String(r.i).padStart(3) + ' [' + (r.date || '?') + '] ' + String(r.bytes).padStart(5) + 'B  ' + r.head)
  if (l.matched > l.rows.length) lines.push('… 仅显示前 ' + l.rows.length + ' 条（可加 limit）')
  lines.push('判定：D 完全重复→remove；S 被覆盖 / O 过时 / A 低价值→archive；M 可合并→replace 并 archive 成员；K 保留→不动。批量用 memory_propose 的 proposals 数组提交。')
  return lines.join('\n')
}

function verdict(cfg, snap) {
  const rows = []
  for (const track of ['memory', 'user', 'key']) {
    const st = snap.tracks[track]
    if (!st) continue
    const budget = budgetsOf(cfg)[track]
    const bad = overOf(st, budget)
    rows.push({ track, entries: st.entries, bytes: st.bytes, oldest: st.oldest, over: bad.length > 0, reasons: bad, budget, baseline: (cfg.baseline && cfg.baseline[track]) || null })
  }
  const p = snap.tracks.project
  const pb = cfg.reportOnly.project
  rows.push({ track: 'project', entries: p ? p.entries : 0, bytes: p ? p.bytes : 0, over: false, reasons: [], report: p && pb && (p.entries > pb.maxEntries || p.bytes > pb.maxBytes) ? '体量大' : '' })
  const d = snap.tracks.daily
  rows.push({ track: 'daily', entries: d ? d.files : 0, bytes: d ? d.bytes : 0, over: false, reasons: [], report: '保留 ' + cfg.reportOnly.daily.keepDays + ' 天建议' })
  return rows
}

const fmtBytes = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B')
/** 整理开销估算：清单字符 ÷ 2 ≈ tokens（中英混排粗估；不含模型输出）。 */
const estTokens = (chars) => Math.ceil((chars || 0) / 2)
/** 提案正文（模型输出）字符数：ops 里带整条正文，与盘点输入同量级。 */
const opsChars = (items) => items.reduce((n, i) => n + JSON.stringify(i.ops).length, 0)
const roundChars = (r) => (r.auditChars || 0) + (r.proposeChars || 0)
const roundView = (r) => (r ? { ...r, tokens: estTokens(roundChars(r)), auditTokens: estTokens(r.auditChars), proposeTokens: estTokens(r.proposeChars) } : null)
const budgetText = (b) => (b ? '≤' + (b.maxEntries || '-') + ' 条/' + (b.maxBytes ? fmtBytes(b.maxBytes) : '-') : '仅报告')
const TRACK_LABEL = { memory: 'memory(全局)', user: 'user(全局)', key: 'key(本项目)', project: 'project(本项目日志)', daily: 'daily' }

function formatReport(snap, rows, clusters, pendingCount) {
  const lines = ['轨                  条数    字节      预算          状态']
  for (const r of rows) {
    const status = r.over ? '超(' + r.reasons.join('+') + ')' : (r.report || '正常')
    lines.push((TRACK_LABEL[r.track] || r.track).padEnd(20) + String(r.entries).padStart(5) + '  ' + fmtBytes(r.bytes).padStart(9) + '  ' + budgetText(r.budget).padEnd(13) + ' ' + status)
  }
  if (snap.projects.length > 1) {
    lines.push('', '各项目 key：')
    for (const p of snap.projects) lines.push('  ' + p.hash + '  ' + String(p.entries).padStart(4) + ' 条  ' + fmtBytes(p.bytes).padStart(9))
  }
  if (clusters) {
    lines.push('', '候选簇 ' + clusters.total + '（duplicate ' + (clusters.hints.duplicate || 0) + ' / supersede ' + (clusters.hints.supersede || 0) + ' / conflict ' + (clusters.hints.conflict || 0) + ' / similar ' + (clusters.hints.similar || 0) + '）')
    lines.push('确定性提案只处理「同轨（memory/user）且 duplicate ≥0.86」；其余簇需要模型判读后用 memory_propose 起草。')
    for (const c of (clusters.top || [])) {
      lines.push('', '· ' + c.hint + (c.sim !== null ? ' ' + c.sim : '') + '：' + c.members.map((m) => m.track + (m.project ? '/' + m.project : '') + '(' + (m.date || '?') + ')').join(' ↔ '))
      for (const m of c.members) lines.push('    [' + m.track + '] ' + m.excerpt.slice(0, 120))
    }
  }
  lines.push('待审批提案 ' + pendingCount + ' 条')
  const over = rows.filter((r) => r.over)
  lines.push(over.length ? '建议：在「整理审批」Tab 处理提案，或直接运行 memory-hygiene 技能。' : '结论：全部在预算内。')
  return lines.join('\n')
}

/** 归一化：剥掉所有前置 [..] 程序标记与空白，便于比对。 */
function normEntry(s) {
  let t = String(s)
  for (let i = 0; i < 6; i++) t = t.replace(/^\[[^\]]*\]\s*/, '')
  return t.replace(/\s+/g, '').toLowerCase()
}
const bigramsOf = (s) => { const o = new Set(); for (let i = 0; i < s.length - 1; i++) o.add(s.slice(i, i + 2)); return o }
const diceOf = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; for (const g of a) if (b.has(g)) n++; return (2 * n) / (a.size + b.size) }

/** 归档体检预筛：把归档条目对主轨做相似度比对，分「疑似已收录 / 归档独占 / 待判」三桶。
 *  目的：让模型只看真正需要判断的少数条目，而不是读完整归档。 */
function archiveCheck(memoryDir, cwd) {
  const f = filesOf(memoryDir, cwd)
  const live = {
    memory: readEntries(f.memory).concat(readEntries(f.user)).map((e) => bigramsOf(normEntry(e))),
    key: f.key ? readEntries(f.key).map((e) => bigramsOf(normEntry(e))) : [],
  }
  const out = []
  for (const [track, file] of [['archive-memory', f.memoryArchive], ['archive-user', f.userArchive], ['archive-key', f.keyArchive]]) {
    if (!file) continue
    const target = track === 'archive-key' ? 'key' : 'memory'
    const rows = readEntries(file).map((e, i) => {
      const bg = bigramsOf(normEntry(e))
      let best = 0
      for (const lb of live[target]) { const d = diceOf(bg, lb); if (d > best) best = d }
      return { i: i + 1, date: entryDate(e), sim: Number(best.toFixed(2)), head: e.replace(/\s+/g, ' ').slice(0, 100) }
    })
    out.push({ track, total: rows.length, dup: rows.filter((r) => r.sim >= 0.55), solo: rows.filter((r) => r.sim < 0.3), unclear: rows.filter((r) => r.sim >= 0.3 && r.sim < 0.55) })
  }
  return out
}

function formatArchiveCheck(list) {
  const lines = ['', '—— 归档预筛（与主轨 bigram 相似度：≥0.55 疑似已收录 / <0.3 归档独占 / 中间待判）——']
  for (const t of list) {
    lines.push('', t.track + '：共 ' + t.total + ' 条 → 疑似已收录 ' + t.dup.length + ' / 归档独占 ' + t.solo.length + ' / 待判 ' + t.unclear.length)
    for (const r of t.dup) lines.push('  [已收录 ' + r.sim + '] #' + r.i + ' [' + (r.date || '?') + '] ' + r.head.slice(0, 80))
    for (const r of t.unclear) lines.push('  [待判 ' + r.sim + '] #' + r.i + ' [' + (r.date || '?') + '] ' + r.head.slice(0, 90))
    if (t.solo.length) lines.push('  （归档独占 ' + t.solo.length + ' 条未列出：多为仍有价值的历史细节，默认不动）')
  }
  lines.push('', '用法：疑似已收录 → 可 purge；待判 → 用 memory_audit track=archive-* 读全文再定；独占 → 保留。')
  return lines.join('\n')
}

/** 技能随插件走：仓库内 skills/<name>/SKILL.md 是真源，注入/重载时同步进技能库。 */
const SKILL_NAME = 'memory-hygiene'
const skillSource = () => join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', SKILL_NAME, 'SKILL.md')
const skillTarget = () => join(dshHome(), 'skills', SKILL_NAME, 'SKILL.md')
function syncSkill() {
  const src = skillSource(), dst = skillTarget()
  try {
    const body = readFileSync(src, 'utf8')
    const had = existsSync(dst)
    if (had && readFileSync(dst, 'utf8') === body) return { path: dst, action: 'unchanged', chars: body.length }
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, body)
    return { path: dst, action: had ? 'updated' : 'installed', chars: body.length }
  } catch (e) { return { path: dst, action: 'error', message: String((e && e.message) || e).slice(0, 160) } }
}

/** 已组合的客户端 bundle 路径（从启动批次里取，去掉 "application " 前缀）。 */
function clientBundlePathOf(ctx) {
  try {
    const cm = ctx.get && ctx.get('clientModules')
    const g = cm && cm.graph && cm.graph()
    const hit = ((g && g.batches) || []).map((b) => b && b.url).find((u) => u && String(u).includes('steward'))
    return hit ? String(hit).replace(/^[a-z-]+ /, '') : null
  } catch { return null }
}

/** memory-evolve 的 api.js 路径（静态核对写入契约用；解析不到就扫 profiles）。 */
function evolveApiPath() {
  const candidates = []
  try { candidates.push(join(dirname(fileURLToPath(import.meta.resolve('dsh-memory-evolve/package.json'))), 'lib/api.js')) } catch { /* 解析不到 */ }
  try {
    for (const p of readdirSync(join(dshHome(), 'profiles'))) candidates.push(join(dshHome(), 'profiles', p, 'node_modules/dsh-memory-evolve/lib/api.js'))
  } catch { /* 无 profiles */ }
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

const EVOLVE_ROUTES = ['/memory-evolve/api/memory/delete', '/memory-evolve/api/memory/update', '/memory-evolve/api/memory/archive']

function scannerPath() {
  const candidates = []
  try {
    const url = import.meta.resolve('dsh-memory-evolve/package.json')
    candidates.push(join(dirname(fileURLToPath(url)), 'skills/memory-consolidate/scripts/scan_memory.mjs'))
  } catch { /* 解析不到 */ }
  const profiles = join(dshHome(), 'profiles')
  try {
    for (const p of readdirSync(profiles)) candidates.push(join(profiles, p, 'node_modules/dsh-memory-evolve/skills/memory-consolidate/scripts/scan_memory.mjs'))
  } catch { /* 无 profiles */ }
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

function runScanner(memoryDir) {
  const script = scannerPath()
  if (!script) return Promise.reject(new Error('未找到上游 scan_memory.mjs'))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--dir', memoryDir], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('scanner 退出码 ' + code + ': ' + err.slice(0, 200)))
      try { resolve(JSON.parse(out)) } catch (e) { reject(new Error('scanner 输出不是 JSON: ' + String(e).slice(0, 120))) }
    })
  })
}

/** 从扫描器报告抽出可读的候选簇明细（供模型起草提案用）。 */
function clusterTop(report) {
  return (report.clusters || []).slice(0, 8).map((c) => ({
    hint: c.hint,
    sim: c.pairs && c.pairs[0] ? Number(c.pairs[0].sim.toFixed(3)) : null,
    members: (c.members || []).map((m) => ({ track: m.track, project: m.project || null, date: m.date || '', excerpt: String(m.excerpt || '').slice(0, 200) })),
  }))
}

function loadQueue(file) {
  const q = loadJson(file, null)
  return q && Array.isArray(q.items) ? q : { version: 1, seq: 0, items: [] }
}

function addProposal(queue, save, p) {
  queue.seq = (queue.seq || 0) + 1
  const item = {
    id: 'p' + String(queue.seq).padStart(4, '0'),
    createdAt: Date.now(), status: 'pending', source: p.source || 'model',
    track: p.track, kind: p.kind, summary: p.summary, reason: p.reason || '',
    ops: p.ops, evidence: p.evidence || null, sessionId: p.sessionId || null, cwd: p.cwd || null,
    appliedAt: null, error: null,
  }
  queue.items.push(item)
  save()
  return item
}

/** 把「唯一子串」解析成整条正文（delete/update 接口需要整条相等）。 */
function resolveEntry(target, match, cwd, memoryDir) {
  const f = filesOf(memoryDir, cwd)
  const file = target === 'memory' ? f.memory
    : target === 'user' ? f.user
    : target === 'key' ? f.key
    : target === 'archive-memory' ? f.memoryArchive
    : target === 'archive-user' ? f.userArchive
    : target === 'archive-key' ? f.keyArchive
    : null
  if (!file) return { ok: false, message: '不支持的 track：' + target }
  const hits = readEntries(file).filter((e) => e.includes(match))
  if (hits.length === 0) return { ok: false, message: '主轨中找不到匹配条目（可能已被改动）' }
  if (hits.length > 1) return { ok: false, message: '匹配到 ' + hits.length + ' 条，请给出更长的唯一子串' }
  return { ok: true, entry: hits[0] }
}

const OP_PATH = {
  archive: EVO_PREFIX + '/api/memory/archive',
  remove: EVO_PREFIX + '/api/memory/delete',
  purge: EVO_PREFIX + '/api/memory/delete',   // 删除归档项：target=archive-memory|archive-user|archive-key
  replace: EVO_PREFIX + '/api/memory/update',
}

async function callEvo(baseUrl, op, sessionId) {
  const path = OP_PATH[op.op]
  if (!path) throw new Error('未知操作 ' + op.op)
  const body = op.op === 'replace'
    ? { target: op.target, match: op.match, content: op.content, sessionId }
    : { target: op.target, match: op.match, sessionId }
  const res = await fetch(baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl }, body: JSON.stringify(body) })
  const text = await res.text()
  let payload
  try { payload = JSON.parse(text) } catch { payload = { ok: false, message: text.slice(0, 200) } }
  if (!res.ok || payload.ok === false) throw new Error(payload.message || payload.error || ('HTTP ' + res.status))
  return payload
}

async function applyProposal(item, state, prev) {
  const results = []
  for (let i = 0; i < item.ops.length; i++) {
    const op = item.ops[i]
    // 断点续跑：上一轮已成功的 op 直接沿用，绝不重放（重放会因条目已被改写而假失败）
    if (Array.isArray(prev) && prev[i] && prev[i].ok) { results.push(prev[i]); continue }
    if (!op.match) { results.push({ op: op.op, ok: false, message: '缺少 match（未解析到整条正文）' }); break }
    // 只留 {op, ok, message}：result 是响应回显，UI 与续跑都不读，白占 40% 体积
    try { await callEvo(state.baseUrl(), op, item.sessionId); results.push({ op: op.op, ok: true, message: '' }) }
    catch (e) { results.push({ op: op.op, ok: false, message: String(e.message || e).slice(0, 200) }); break }
  }
  return results
}

function backupTracks(item, memoryDir, cfg) {
  if (!cfg.backupOnApply) return null
  try {
    const f = filesOf(memoryDir, item.cwd || undefined)
    const dir = join(memoryDir, 'steward', 'backups', String(item.id) + '-' + Date.now())
    mkdirSync(dir, { recursive: true })
    for (const p of [f.memory, f.user, f.key, f.memoryArchive, f.userArchive, f.keyArchive]) if (p && existsSync(p)) copyFileSync(p, join(dir, p.split('/').pop()))
    return dir
  } catch { return null }
}

/** 确定性提案：只处理扫描器判定为 duplicate 的全局轨簇（归档较旧一条；archive 可移回，执行前另有整文件备份）。 */
async function deterministicProposals(memoryDir, existing, fromLog) {
  const report = await runScanner(memoryDir)
  const out = []
  // 队列 + 事件日志一起算「提过没有」：清空队列后同一 duplicate 簇不该被重复提案
  const seen = new Set(existing.map((i) => clip(i.summary, HIST_SUMMARY_MAX)))
  for (const s of fromLog || []) seen.add(s)
  for (const c of report.clusters || []) {
    if (c.hint !== 'duplicate') continue
    const members = c.members || []
    const global = members.filter((m) => m.track === 'memory' || m.track === 'user')
    if (global.length < 2) continue
    const sorted = global.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
    const drop = sorted[0], keep = sorted[sorted.length - 1]
    const target = drop.track === 'user' ? 'user' : 'memory'
    const key = 'dup:' + drop.id + '->' + keep.id
    if (seen.has(key)) continue
    const resolved = resolveEntry(target, String(drop.excerpt || '').slice(0, 80), null, memoryDir)
    if (!resolved.ok) continue
    out.push({
      source: 'scan', track: target, kind: 'remove', summary: key,
      reason: '字面重复（相似度 ' + (c.pairs && c.pairs[0] ? c.pairs[0].sim.toFixed(2) : '?') + '）：保留较新一条，归档较旧（可在记忆 Tab 归档页移回）',
      ops: [{ op: 'archive', target, match: resolved.entry }],
      evidence: { cluster: c.id, sim: c.pairs && c.pairs[0] ? c.pairs[0].sim : null, keepId: keep.id, dropId: drop.id },
      sessionId: null, cwd: null,
    })
  }
  return out
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  cfg.budgets = { ...DEFAULTS.budgets, ...((config && config.budgets) || {}) }
  cfg.reportOnly = { ...DEFAULTS.reportOnly, ...((config && config.reportOnly) || {}) }
  const memoryDir = memoryDirOf(config)
  const skill = syncSkill()
  const stateDir = join(memoryDir, 'steward')
  const proposalsFile = join(stateDir, 'proposals.json')
  const configFile = join(stateDir, 'config.json')
  const saved = loadJson(configFile, {})
  if (saved && typeof saved === 'object') {
    if (typeof saved.autoApprove === 'string') cfg.autoApprove = saved.autoApprove
    if (typeof saved.nudge === 'boolean') cfg.nudge = saved.nudge
    if (typeof saved.budgetRatio === 'number' && saved.budgetRatio > 0) cfg.budgetRatio = saved.budgetRatio
    if (saved.baseline && typeof saved.baseline === 'object') cfg.baseline = saved.baseline
    if (typeof saved.lastSweepAt === 'number') cfg.lastSweepAt = saved.lastSweepAt
    if (typeof saved.autoCheck === 'boolean') cfg.autoCheck = saved.autoCheck
    if (typeof saved.lightMode === 'boolean') cfg.lightMode = saved.lightMode
    if (typeof saved.sweepIntervalDays === 'number' && saved.sweepIntervalDays > 0) cfg.sweepIntervalDays = saved.sweepIntervalDays
    if (typeof saved.archiveMaxEntries === 'number' && saved.archiveMaxEntries > 0) cfg.archiveMaxEntries = saved.archiveMaxEntries
    if (typeof saved.roundKeep === 'number' && saved.roundKeep > 0) cfg.roundKeep = saved.roundKeep
    if (typeof saved.historyKeep === 'number' && saved.historyKeep > 0) cfg.historyKeep = saved.historyKeep
    if (typeof saved.historyKeepDays === 'number' && saved.historyKeepDays >= 0) cfg.historyKeepDays = saved.historyKeepDays
    if (typeof saved.historySlim === 'boolean') cfg.historySlim = saved.historySlim
    if (saved.historyStats && typeof saved.historyStats === 'object') cfg.historyStats = saved.historyStats
  }
  const saveConfig = () => saveJson(configFile, { autoApprove: cfg.autoApprove, nudge: cfg.nudge, autoCheck: cfg.autoCheck, lightMode: cfg.lightMode, budgetRatio: cfg.budgetRatio, baseline: cfg.baseline, sweepIntervalDays: cfg.sweepIntervalDays, archiveMaxEntries: cfg.archiveMaxEntries, roundKeep: cfg.roundKeep, historyKeep: cfg.historyKeep, historyKeepDays: cfg.historyKeepDays, historySlim: cfg.historySlim, historyStats: cfg.historyStats, lastSweepAt: cfg.lastSweepAt })
  // ── 整理开销审计：一轮 = 一段连续活动（盘点/提案/审批），滚动保留 roundKeep 轮 ──
  const roundsFile = join(stateDir, 'rounds.json')
  const rounds = loadJson(roundsFile, null) || { version: 1, open: null, rounds: [] }
  if (!Array.isArray(rounds.rounds)) rounds.rounds = []
  const ROUND_GAP_MS = 30 * 60 * 1000
  const saveRounds = () => saveJson(roundsFile, rounds)
  const cfgPayload = () => ({ autoApprove: cfg.autoApprove, nudge: cfg.nudge, autoCheck: cfg.autoCheck, lightMode: cfg.lightMode, budgetRatio: cfg.budgetRatio, sweepIntervalDays: cfg.sweepIntervalDays, archiveMaxEntries: cfg.archiveMaxEntries, roundKeep: cfg.roundKeep, historyKeep: cfg.historyKeep, historyKeepDays: cfg.historyKeepDays, historySlim: cfg.historySlim !== false, baseline: cfg.baseline, budgets: budgetsOf(cfg) })
  function openRound() {
    const now = Date.now()
    if (rounds.open && now - (rounds.open.lastAt || rounds.open.startedAt) > ROUND_GAP_MS) closeRound('timeout')
    if (!rounds.open) rounds.open = { id: 'r' + now.toString(36), startedAt: now, lastAt: now, auditCalls: 0, auditChars: 0, proposeCalls: 0, proposals: 0, ops: 0, applied: 0, failed: 0 }
    rounds.open.lastAt = now
    return rounds.open
  }
  function closeRound(reason) {
    if (!rounds.open) return null
    const r = rounds.open
    r.endedAt = Date.now()
    r.reason = reason || 'closed'
    rounds.rounds.unshift(r)
    rounds.rounds = rounds.rounds.slice(0, cfg.roundKeep || 10)
    rounds.open = null
    try { saveRounds() } catch { /* 静默 */ }
    return r
  }
  const queue = loadQueue(proposalsFile)
  // ── 事件日志（队列之外的另一层）：诊断靠 error+ts、去重靠 summary、清运留痕；
  //    只追加、不进内存、不参与轮询，也绝不含 ops 正文（正文只在队列与 backups/ 里）──
  const historyFile = join(stateDir, 'history.jsonl')
  const appendHistory = (lines) => { try { mkdirSync(stateDir, { recursive: true }); appendFileSync(historyFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n') } catch { /* 日志写不进不影响主流程 */ } }
  const stats = () => (cfg.historyStats = { pruned: 0, slimmed: 0, ...(cfg.historyStats || {}) })
  let logCache = null
  function logStats() {
    try {
      const st = statSync(historyFile)
      if (logCache && logCache.size === st.size && logCache.mtime === st.mtimeMs) return logCache.out
      const lines = readFileSync(historyFile, 'utf8').split('\n').filter(Boolean)
      const at = (i) => { try { return JSON.parse(lines[i]).ts || null } catch { return null } }
      const out = { bytes: st.size, lines: lines.length, oldest: lines.length ? at(0) : null, newest: lines.length ? at(lines.length - 1) : null }
      logCache = { size: st.size, mtime: st.mtimeMs, out }
      return out
    } catch { return { bytes: 0, lines: 0, oldest: null, newest: null } }
  }
  /** 写 proposals.json 的唯一出口：每次都先 pruneQueue（不新增定时器），日志留痕后再落盘。 */
  function saveQueue() {
    const r = pruneQueue(queue.items, cfg, Date.now())
    queue.items = r.kept
    if (r.dropped.length || r.slimmed) {
      const st = stats()
      if (r.dropped.length) { st.pruned += r.dropped.length; st.lastPrunedAt = Date.now(); appendHistory(r.dropped.map((i) => itemLine(i))) }
      if (r.slimmed) { st.slimmed += r.slimmed; st.lastSlimmedAt = Date.now() }
      saveConfig()
    }
    saveJson(proposalsFile, queue, true)
    return r
  }
  const historyView = () => {
    const st = stats()
    return {
      keep: cfg.historyKeep, keepDays: cfg.historyKeepDays, slim: cfg.historySlim !== false,
      queue: queue.items.length, pending: queue.items.filter((i) => i.status === 'pending').length,
      pruned: st.pruned, slimmed: st.slimmed, slimInQueue: queue.items.filter((i) => i.slim).length,
      log: logStats(),
    }
  }
  const toolFlags = { audit: false, propose: false, status: false }   // 自检用：工具是否真的注册成功
  const applying = new Set()   // 正在执行的提案 id：挡掉重复/并发提交
  let snap = null, rows = [], clusters = null, lastCheck = 0, lastError = null
  let baseUrlCache = null, checking = false, cwdCache = null
  const log = (...a) => { try { ctx.logger?.info?.('[steward]', ...a) } catch { /* 无 logger */ } }
  const baseUrl = () => baseUrlCache || ('http://127.0.0.1:' + ((ctx.get && ctx.get('webServer') && ctx.get('webServer').listenedPort) || 3080))
  const clientPathDebug = () => { try { const cm = ctx.get && ctx.get('clientModules'); if (!cm) return { service: 'no-service' }; const urls = (cm.graph && cm.graph()) ? (cm.graph().batches || []).map((b) => b.phase + ' ' + b.url).filter((u) => u.indexOf('steward') >= 0) : null; return { path: typeof cm.clientPath === 'function' ? (cm.clientPath(name) || null) : null, urls } } catch (e) { return { error: String((e && e.message) || e) } } }
  const pending = () => queue.items.filter((i) => i.status === 'pending')

  function refresh(cwd) {
    if (checking) return
    checking = true
    try {
      if (cwd !== undefined) cwdCache = cwd || null
      snap = scan(memoryDir, cwdCache)
      rows = verdict(cfg, snap)
      lastCheck = snap.at
    } catch (e) { lastError = String(e.message || e) } finally { checking = false }
  }

  /** 整理是否到期：超预算 + 没有待审提案 + 距上次整理超过 sweepIntervalDays。 */
  function sweepState() {
    const over = rows.filter((r) => r.over)
    const days = cfg.lastSweepAt ? (Date.now() - cfg.lastSweepAt) / 86400000 : null
    const archiveEntries = (snap && snap.tracks.memoryArchive ? snap.tracks.memoryArchive.entries : 0) + (snap && snap.tracks.keyArchive ? snap.tracks.keyArchive.entries : 0)
    const archiveOver = archiveEntries > (cfg.archiveMaxEntries || 30)
    const stale = days === null || days >= cfg.sweepIntervalDays
    const due = pending().length === 0 && stale && (over.length > 0 || archiveOver)
    return { over: over.length > 0, pending: pending().length, days, due, archiveEntries, archiveOver }
  }

  function nudgeLine(cwd) {
    if (!cfg.nudge) return ''
    if (!snap || (cwd || null) !== cwdCache) refresh(cwd)
    const over = rows.filter((r) => r.over)
    if (over.length === 0) return ''
    const parts = over.map((r) => r.track + ' ' + r.entries + ' 条/' + fmtBytes(r.bytes) + '（预算 ' + budgetText(r.budget) + '）')
    const s = sweepState()
    if (over.length === 0 && !s.archiveOver) return ''
    const head = over.length
      ? ('【记忆库存】' + parts.join('、') + ' 超出预算。')
      : ('【记忆归档】归档轨 ' + s.archiveEntries + ' 条已超过阈值 ' + (cfg.archiveMaxEntries || 30) + '。')
    if (!s.due) return head + '（' + (s.pending ? '已有 ' + s.pending + ' 条待审提案，等用户在「整理审批」Tab 处理' : '距上次整理不足 ' + cfg.sweepIntervalDays + ' 天，暂不重复提醒') + '）'
    const light = cfg.lightMode !== false
      ? '① memory_audit {archiveCheck:true} 归档预筛（三桶：疑似已收录/归档独占/待判，独占不列全文，最省 token）+ memory_audit {deep:true} 看主轨候选簇；若候选多或需逐条判读，再 memory_audit {track:"all"} 拉全量。'
      : '① memory_audit {track:"all"} 一次拉全量（memory/user/key + archive-*）。'
    return head + '【整理到期】本回合收尾前跑**一轮完整整理**（一条流水线，主轨+归档一起过；判读细则/坑/验证见 memory-hygiene 技能）：' + light + '② 主轨判 D/S/M/O/A/K——新事实照常写、重复 remove、被覆盖/过时/低价值 archive、同主题 replace 合并；③ 归档清运——已被主轨收录 / 被新事实推翻 / 一次性状态快照 → purge 删除；④ memory_propose 用 proposals 数组批量提交；⑤ 有提案要等人审批时**不要**调 complete——propose 已复位计时，用户采纳后会自动以 all-resolved 结轮（这样 applied 才记得上）；确认本轮无事可做才 memory_sweep_status complete。用户随后在「整理审批」Tab 批量勾选采纳。开销口径：本轮 memory_audit 返回的清单字符 ÷ 2 ≈ tokens，可在 Tab「整理开销」或 /api/rounds 核对（常规轮次目标 ≤2K；合并类 replace 要把整条旧文与新文都写进 ops，一轮大重构 10K+ 属正常）。'
  }

  async function autoApprovePending() {
    const mode = cfg.autoApprove
    if (mode !== 'deterministic' && mode !== 'all') return []
    const targets = pending().filter((i) => {
      if (mode === 'deterministic') return i.source === 'scan' && i.ops.every((o) => o.op === 'archive')
      return i.ops.every((o) => o.op === 'archive' || o.op === 'remove' || o.op === 'replace')
    }).slice(0, cfg.maxAutoOps)
    const applied = []
    for (const item of targets) {
      const backup = backupTracks(item, memoryDir, cfg)
      const results = await applyProposal(item, { baseUrl }, item.results)
      const ok = results.every((r) => r.ok)
      item.status = ok ? 'applied' : 'failed'
      item.appliedAt = Date.now()
      item.resolvedAt = item.appliedAt
      item.auto = true
      item.backup = backup
      item.error = ok ? null : ((results.find((r) => !r.ok) || {}).message || '执行失败')
      item.results = results
      saveQueue()
      appendHistory([itemLine(item)])
      applied.push(item)
    }
    if (applied.length) refresh(cwdCache)
    return applied
  }

  /** 提案入队（工具与 HTTP 路由共用一条实现）：唯一子串 → 整条正文，并记账到当前轮。 */
  function enqueueProposals(requests, sid, cwd) {
    const buildOps = (rawOps) => {
      const ops = []
      for (const raw of rawOps || []) {
        const needCwd = raw.target === 'key' || raw.target === 'archive-key'
        if (needCwd && !cwd) return { ok: false, message: 'key 轨提案需要会话工作目录' }
        const r = resolveEntry(raw.target, String(raw.match || '').trim(), needCwd ? cwd : null, memoryDir)
        if (!r.ok) return { ok: false, message: r.message }
        if (raw.op === 'replace') {
          const content = String(raw.content || '').trim()
          if (!content) return { ok: false, message: 'replace 需要 content（合并后的新正文）' }
          if (content.includes('§')) return { ok: false, message: '新正文不能包含 §（那是记忆文件的条目分隔符）——如需引用章节号请写「第 8 节」或 § 之外的写法' }
          ops.push({ op: 'replace', target: raw.target, match: r.entry, content })
        } else {
          ops.push({ op: raw.op, target: raw.target, match: r.entry })
        }
      }
      return ops.length ? { ok: true, ops } : { ok: false, message: 'ops 不能为空' }
    }
    const added = []
    for (const req of (requests || []).slice(0, 20)) {
      if (!req || !req.summary) return { ok: false, message: '每条提案都需要 summary' }
      const built = buildOps(req.ops)
      if (!built.ok) return { ok: false, message: '提案「' + String(req.summary).slice(0, 30) + '」：' + built.message }
      added.push(addProposal(queue, saveQueue, { source: sid ? 'model' : 'api', track: built.ops[0].target, kind: built.ops[0].op, summary: req.summary, reason: req.reason || '', ops: built.ops, sessionId: sid || null, cwd: cwd || null }))
    }
    if (!added.length) return { ok: false, message: '没有可提交的提案' }
    cfg.lastSweepAt = Date.now(); saveConfig()
    openRound()
    rounds.open.proposeCalls += 1
    rounds.open.proposals += added.length
    rounds.open.ops += added.reduce((n, i) => n + i.ops.length, 0)
    rounds.open.proposeChars = (rounds.open.proposeChars || 0) + opsChars(added)
    try { saveRounds() } catch { /* 静默 */ }
    return { ok: true, added }
  }

  /** 自检：内核契约 + 外部依赖 + 自身状态，一条命令看清哪里断了（只读，除一个探针文件）。 */
  async function selfcheck() {
    const checks = []
    const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail == null ? '' : detail).slice(0, 200) })
    add('技能随包同步', skill.action !== 'error', skill.action + ' → ' + skill.path)
    try {
      mkdirSync(stateDir, { recursive: true })          // 全新安装时目录还没被建过（saveJson 才会建）
      const probe = join(stateDir, '.selfcheck')
      writeFileSync(probe, String(Date.now()))
      readFileSync(probe, 'utf8')
      unlinkSync(probe)
      add('状态目录可写', true, stateDir)
    } catch (e) { add('状态目录可写', false, String((e && e.message) || e)) }
    const bundle = clientBundlePathOf(ctx)
    if (!bundle) add('客户端 bundle 已组合', false, '启动批次里没有 steward 的 client.js（槽位/组合契约可能变了）')
    else {
      try {
        const res = await fetch(baseUrl() + bundle)
        const text = res.ok ? await res.text() : ''
        add('客户端 bundle 已组合', res.ok && text.includes('__ModuleLoader__'), 'HTTP ' + res.status + ' · ' + bundle)
      } catch (e) { add('客户端 bundle 已组合', false, String((e && e.message) || e)) }
    }
    const api = evolveApiPath()
    if (!api) add('memory-evolve 写入契约', false, '解析不到 dsh-memory-evolve（伴生插件没装？）')
    else {
      try {
        const src = readFileSync(api, 'utf8')
        const missing = EVOLVE_ROUTES.filter((r) => !src.includes(r))
        add('memory-evolve 写入契约', missing.length === 0, missing.length ? '缺路由：' + missing.join(' , ') : 'delete/update/archive 三个路由都在（' + api + '）')
      } catch (e) { add('memory-evolve 写入契约', false, String((e && e.message) || e)) }
    }
    try {
      const res = await fetch(baseUrl() + '/memory-evolve/api/memory-files')
      add('memory-evolve 存活', res.ok, 'HTTP ' + res.status)
    } catch (e) { add('memory-evolve 存活', false, String((e && e.message) || e)) }
    add('工具注册', toolFlags.audit && toolFlags.propose && toolFlags.status, JSON.stringify(toolFlags))
    add('提案队列可读', Array.isArray(queue.items), queue.items.length + ' 条（待审 ' + pending().length + '）')
    return checks
  }

  async function generateAndQueue(sessionId) {
    const added = []
    try {
      const props = await deterministicProposals(memoryDir, queue.items, historySummaries(historyFile))
      lastError = null
      for (const p of props) added.push(addProposal(queue, saveQueue, { ...p, sessionId: sessionId || null, cwd: cwdCache }))
      if (added.length) { cfg.lastSweepAt = Date.now(); saveConfig() }
    } catch (e) { lastError = '扫描失败: ' + String(e.message || e).slice(0, 160) }
    try {
      const report = await runScanner(memoryDir)
      clusters = { total: (report.clusters || []).length, hints: (report.stats && report.stats.hints) || {}, top: clusterTop(report) }
    } catch { /* 无扫描器 */ }
    await autoApprovePending()
    return added
  }

  ctx.effect(() => ctx.tools.register({
    name: 'memory_audit',
    description: '查看记忆库存与预算：各轨条数/字节/最老条目、超预算项、待审批整理提案数。deep=true 时额外运行上游扫描器统计候选簇。只读，不写任何记忆文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deep: { type: 'boolean', description: '是否运行上游 scan_memory.mjs 统计候选簇（默认 false）' },
        archiveCheck: { type: 'boolean', description: '归档预筛：把归档条目对主轨做相似度比对，分「疑似已收录/归档独占/待判」三桶（省 token，推荐在整理归档时先跑）' },
        cwd: { type: 'string', description: '要统计的项目工作目录（默认当前会话）' },
        track: { type: 'string', enum: ['all', 'memory', 'user', 'key', 'archive-memory', 'archive-user', 'archive-key'], description: '列出条目：all=一次拉全量（主轨+归档轨，一轮整理用）；单轨用 memory/user/key；archive-* 单看归档' },
        olderThanDays: { type: 'integer', description: '只列日期早于 N 天前的条目（配合 track）' },
        limit: { type: 'integer', description: '清单最多显示条数（默认 60）' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'] },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    async execute(args, exec) {
      const cwd = (args && args.cwd) || (exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd)
      refresh(cwd)
      if (args && args.deep) { try { const r = await runScanner(memoryDir); clusters = { total: (r.clusters || []).length, hints: (r.stats && r.stats.hints) || {}, top: clusterTop(r) } } catch (e) { lastError = String(e.message || e) } }
      let msg = formatReport(snap, rows, args && args.deep ? clusters : null, pending().length)
      if (args && args.archiveCheck) msg += formatArchiveCheck(archiveCheck(memoryDir, cwd))
      openRound()
      rounds.open.auditCalls += 1
      rounds.open.auditChars += msg.length
      try { saveRounds() } catch { /* 静默 */ }
      const track = args && args.track
      if (track === 'all') {
        for (const t of ['memory', 'user', 'key', 'archive-memory', 'archive-user', 'archive-key']) {
          if ((t === 'key' || t === 'archive-key') && !cwd) continue
          msg += formatListing(trackListing(memoryDir, cwd, t, args.olderThanDays, args.limit || 25), t, args.olderThanDays)
        }
      } else if (track) {
        msg += formatListing(trackListing(memoryDir, cwd, track, args.olderThanDays, args.limit), track, args.olderThanDays)
      }
      return { ok: true, message: msg }
    },
  }), 'dsh-memory-steward: memory_audit')
  toolFlags.audit = true

  ctx.effect(() => ctx.tools.register({
    name: 'memory_propose',
    description: '提交一条整理提案到待审批队列（采纳后由管家回调 memory-evolve 官方接口执行；每次执行前自动整文件备份）。三种操作：archive=移入 *-archive.md（可在记忆 Tab 归档页移回，推荐）、remove=直接删除（仅完全重复且无独立信息时用）、replace=合并成一条新正文。ops 的 match 只需能唯一定位条目的子串，管家会解析成整条正文；replace 需附 content。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string', description: '一句话说明这条提案做什么（用于去重与展示）' },
        reason: { type: 'string', description: '判定依据（D/S/M/O/A 或覆盖/冲突等）' },
        ops: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              op: { type: 'string', enum: ['archive', 'remove', 'replace'] },
              target: { type: 'string', enum: ['memory', 'user', 'key'] },
              match: { type: 'string', description: '唯一识别条目的子串' },
              content: { type: 'string', description: 'replace 的新正文（不含时间戳/标记）' },
            },
            required: ['op', 'target', 'match'],
          },
        },
      },
        proposals: {
          type: 'array',
          description: '批量提交（与 ops 二选一）：每项 {summary, reason, ops}；一次最多 20 条',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string' },
              reason: { type: 'string' },
              ops: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    op: { type: 'string', enum: ['archive', 'remove', 'replace', 'purge'] },
                    target: { type: 'string', enum: ['memory', 'user', 'key', 'archive-memory', 'archive-user', 'archive-key'] },
                    match: { type: 'string' },
                    content: { type: 'string' },
                  },
                  required: ['op', 'target', 'match'],
                },
              },
            },
            required: ['summary', 'ops'],
          },
        },
      },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'] },
      render: (_a, v) => [{ type: 'text', text: v.message }],
    },
    async execute(args, exec) {
      const sid = exec && exec.agent && exec.agent.session ? exec.agent.session.id : null
      const cwd = exec && exec.agent && exec.agent.session ? exec.agent.session.header.cwd : null
      const requests = (Array.isArray(args && args.proposals) && args.proposals.length)
        ? args.proposals.slice(0, 20)
        : [{ summary: args && args.summary, reason: args && args.reason, ops: args && args.ops }]
      const r = enqueueProposals(requests, sid, cwd)
      if (!r.ok) return { ok: false, message: r.message }
      const auto = await autoApprovePending()
      return { ok: true, message: '已加入待审批队列 ' + r.added.length + ' 条：' + r.added.map((i) => i.id).join(',') + '（待审 ' + pending().length + ' 条）' + (auto.length ? '；已自动采纳 ' + auto.length + ' 条' : '') }
    },
  }), 'dsh-memory-steward: memory_propose')
  toolFlags.propose = true

  ctx.effect(() => ctx.tools.register({
    name: 'memory_sweep_status',
    description: '整理到期状态：check 查看（超预算 + 无待审提案 + 距上次整理 ≥ interval 即到期）；complete 在完成一轮盘点并提交提案后复位计时（proposals 提交也会自动复位）。',
    parameters: { type: 'object', additionalProperties: false, properties: { action: { type: 'string', enum: ['check', 'complete'] } }, required: ['action'] },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'] }, render: (_a, v) => [{ type: 'text', text: v.message }] },
    async execute(args) {
      if (args && args.action === 'complete') { cfg.lastSweepAt = Date.now(); saveConfig(); closeRound('complete'); return { ok: true, message: '整理计时已复位（间隔 ' + cfg.sweepIntervalDays + ' 天）；本轮开销已记入审计' } }
      const s = sweepState()
      const days = s.days === null ? '从未整理' : s.days.toFixed(1) + ' 天前'
      return { ok: true, message: '超预算：' + (s.over ? '是' : '否') + '；待审提案：' + s.pending + ' 条；上次整理：' + days + '；到期：' + (s.due ? '是' : '否') }
    },
  }), 'dsh-memory-steward: memory_sweep_status')
  toolFlags.status = true

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'memory:steward',
    order: 60,
    text: (context) => { try { return nudgeLine(context && context.agent && context.agent.session ? context.agent.session.header.cwd : undefined) } catch { return '' } },
  }), 'dsh-memory-steward: nudge')

  if (cfg.autoCheck !== false) {
    ctx.effect(() => {
      const tick = () => { try { refresh(cwdCache) } catch { /* 静默 */ } }
      const timer = setInterval(tick, cfg.checkIntervalMs)
      return () => clearInterval(timer)
    }, 'dsh-memory-steward: timer')
    try {
      ctx.effect(() => ctx.on('agent/turn-stopping', () => { try { refresh(cwdCache) } catch { /* 静默 */ } }), 'dsh-memory-steward: turn')
    } catch { /* 无该事件 */ }
  }

  if (ctx.inject) {
    ctx.inject(['webServer'], (wctx) => {
      wctx.effect(() => wctx.webServer.register({
        kind: 'prefix',
        path: '/memory-steward',
        handler: async (req, res) => {
          const send = (code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)) }
          const host = req.headers.host || '127.0.0.1:3080'
          baseUrlCache = 'http://' + host
          const origin = String(req.headers.origin || '')
          try { if (origin && new URL(origin).host !== host) return send(403, { ok: false, message: '跨站请求已拒绝' }) } catch { return send(403, { ok: false, message: 'bad origin' }) }
          const url = new URL(req.url || '/', 'http://' + host)
          const path = url.pathname
          const readBody = () => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')) } catch { resolve({}) } }) })
          try {
            if (req.method === 'GET' && path === '/memory-steward/api/status') {
              refresh(cwdCache)
              return send(200, { ok: true, skill, clientPath: clientPathDebug(), rows, pending: pending().length, config: Object.assign(cfgPayload(), { fixedBudgets: cfg.budgets, reportOnly: cfg.reportOnly }), sweep: sweepState(), history: historyView(), lastCheck, lastError, projects: snap ? snap.projects : [], clusters })
            }
            if (req.method === 'GET' && path === '/memory-steward/api/proposals') return send(200, { ok: true, items: queue.items.slice().reverse().map(listItem) })
            if (req.method === 'GET' && path.startsWith('/memory-steward/api/proposals/')) {
              const id = decodeURIComponent(path.slice('/memory-steward/api/proposals/'.length))
              const item = queue.items.find((i) => i.id === id)
              if (!item) return send(404, { ok: false, message: '没有这条提案：' + id })
              return send(200, { ok: true, item })
            }
            if (req.method === 'GET' && path === '/memory-steward/api/rounds') {
              const list = rounds.rounds.map(roundView)
              const openV = roundView(rounds.open)
              const all = openV ? [openV].concat(list) : list
              const avg = all.length ? Math.round(all.reduce((n, r) => n + r.tokens, 0) / all.length) : 0
              const last = all[0] || null
              return send(200, { ok: true, open: openV, rounds: list, summary: { count: all.length, avgTokens: avg, lastTokens: last ? last.tokens : 0, lastAuditTokens: last ? last.auditTokens : 0, lastProposeTokens: last ? last.proposeTokens : 0, target: 2000 } })
            }
            if (req.method === 'GET' && path === '/memory-steward/api/selfcheck') return send(200, { ok: true, checks: await selfcheck() })
            if (req.method === 'POST' && path === '/memory-steward/api/history/clear') {
              const body = await readBody()
              const days = Number(body.days)
              const before = logStats()
              if (body.all === true || !(days > 0)) { try { unlinkSync(historyFile) } catch { /* 本来就没有 */ } logCache = null; return send(200, { ok: true, cleared: true, removed: before.lines, log: logStats() }) }
              const cut = Date.now() - days * DAY
              const r = trimLog(readFileSync(historyFile, 'utf8'), cut)
              writeFileSync(historyFile, r.text)
              logCache = null
              return send(200, { ok: true, days, removed: r.removed, kept: r.kept, log: logStats() })
            }
            if (req.method === 'POST' && path === '/memory-steward/api/propose') {
              const body = await readBody()
              const requests = (Array.isArray(body.proposals) && body.proposals.length) ? body.proposals : [{ summary: body.summary, reason: body.reason, ops: body.ops }]
              const r = enqueueProposals(requests, null, body.cwd || cwdCache)   // key/archive-key 目标需要 cwd（无会话时由调用方显式给）
              if (!r.ok) return send(400, { ok: false, message: r.message })
              const auto = await autoApprovePending()
              return send(200, { ok: true, ids: r.added.map((i) => i.id), pending: pending().length, auto: auto.length })
            }
            if (req.method === 'POST' && path === '/memory-steward/api/scan') {
              const added = await generateAndQueue(null)
              openRound(); rounds.open.auditCalls += 1; rounds.open.proposals += added.length; rounds.open.proposeChars = (rounds.open.proposeChars || 0) + opsChars(added); try { saveRounds() } catch { /* 静默 */ }
              return send(200, { ok: true, added: added.length, pending: pending().length, clusters, rule: '确定性规则只处理同轨 memory/user 且 duplicate ≥0.86 的簇；其余需模型起草（memory_propose）' })
            }
            if (req.method === 'POST' && path === '/memory-steward/api/config') {
              const body = await readBody()
              if (typeof body.autoApprove === 'string') cfg.autoApprove = body.autoApprove
              if (typeof body.nudge === 'boolean') cfg.nudge = body.nudge
              if (typeof body.autoCheck === 'boolean') cfg.autoCheck = body.autoCheck
              if (typeof body.lightMode === 'boolean') cfg.lightMode = body.lightMode
              if (typeof body.sweepIntervalDays === 'number' && body.sweepIntervalDays > 0) cfg.sweepIntervalDays = body.sweepIntervalDays
              if (typeof body.archiveMaxEntries === 'number' && body.archiveMaxEntries > 0) cfg.archiveMaxEntries = body.archiveMaxEntries
              if (typeof body.budgetRatio === 'number' && body.budgetRatio > 0) cfg.budgetRatio = body.budgetRatio
              if (typeof body.historyKeep === 'number' && body.historyKeep > 0) cfg.historyKeep = body.historyKeep
              if (typeof body.historyKeepDays === 'number' && body.historyKeepDays >= 0) cfg.historyKeepDays = body.historyKeepDays
              if (typeof body.historySlim === 'boolean') cfg.historySlim = body.historySlim
              saveConfig()
              saveQueue()   // 改完保留策略立刻生效一次（不必等下一次写队列）
              return send(200, { ok: true, config: cfgPayload(), history: historyView() })
            }
            if (req.method === 'POST' && path === '/memory-steward/api/baseline') {
              const body = await readBody()
              const missing = []
              if (body && body.reset === true) { cfg.baseline = null } else {
                const cwd = (body && body.cwd) || cwdCache
                refresh(cwd)
                const next = {}
                for (const t of ['memory', 'user', 'key']) {
                  const st = snap && snap.tracks[t]
                  if (st) next[t] = { entries: st.entries, bytes: st.bytes }
                  else if (cfg.baseline && cfg.baseline[t]) next[t] = cfg.baseline[t]
                  else missing.push(t)
                }
                cfg.baseline = next
              }
              saveConfig()
              refresh(cwdCache)
              return send(200, { ok: true, baseline: cfg.baseline, ratio: cfg.budgetRatio, budgets: budgetsOf(cfg), missing: missing.length ? missing : undefined, note: missing.length ? ('未采到基准：' + missing.join('/') + '（key 需要会话工作目录，在会话里再点一次即可）') : undefined })
            }
            const m = path.match(/^\/memory-steward\/api\/proposals\/(approve|reject|restore|purge)$/)
            if (req.method === 'POST' && m) {
              const action = m[1]
              const body = await readBody()
              const ids = new Set(body.ids || [])
              const out = []
              for (const item of queue.items.filter((i) => ids.has(i.id))) {
                if (action === 'purge') { out.push({ id: item.id, ok: true, message: '已从历史清除' }); continue }
                if (action === 'approve') {
                  if (item.status === 'applied') { out.push({ id: item.id, ok: false, message: '已执行过' }); continue }
                  if (applying.has(item.id)) { out.push({ id: item.id, ok: false, message: '正在执行中（重复提交已忽略）' }); continue }
                  applying.add(item.id)
                  try {
                    const backup = backupTracks(item, memoryDir, cfg)
                    const results = await applyProposal(item, { baseUrl }, item.results)
                    const ok = results.every((r) => r.ok)
                    item.status = ok ? 'applied' : 'failed'
                    item.appliedAt = Date.now()
                    item.resolvedAt = item.appliedAt
                    item.backup = backup
                    item.error = ok ? null : ((results.find((r) => !r.ok) || {}).message || '执行失败')
                    item.results = results
                    appendHistory([itemLine(item)])
                    out.push({ id: item.id, ok, message: ok ? '已执行' : item.error })
                  } finally { applying.delete(item.id) }
                } else if (action === 'reject') { item.status = 'rejected'; item.resolvedAt = Date.now(); appendHistory([itemLine(item)]); out.push({ id: item.id, ok: true, message: '已拒绝' }) }
                else { item.status = 'pending'; appendHistory([itemLine(item, 'restored')]); out.push({ id: item.id, ok: true, message: '已恢复待审' }) }
              }
              if (action === 'purge') { const ids = new Set((body.ids && body.ids.length) ? body.ids : queue.items.filter((i) => i.status !== 'pending').map((i) => i.id)); queue.items = queue.items.filter((i) => !ids.has(i.id)); out.length = 0; out.push({ id: '*', ok: true, message: '已清除 ' + ids.size + ' 条历史' }); if (ids.size) appendHistory([histLine({ id: '*', status: 'cleared', summary: '清空历史 ' + ids.size + ' 条（只删队列记录，日志保留）' })]) }
              if (rounds.open && action === 'approve') { rounds.open.applied += out.filter((r) => r.ok).length; rounds.open.failed += out.filter((r) => !r.ok).length }
              saveQueue()
              if (pending().length === 0) closeRound('all-resolved'); else { try { saveRounds() } catch { /* 静默 */ } }
              refresh(cwdCache)
              return send(200, { ok: true, results: out, pending: pending().length })
            }
            return send(404, { ok: false, message: 'unknown route ' + path })
          } catch (e) { return send(500, { ok: false, message: String((e && e.message) || e).slice(0, 300) }) }
        },
      }), 'dsh-memory-steward: api')
    })
  }

  refresh()
  log('ready; memoryDir=' + memoryDir + '; pending=' + pending().length)
}
