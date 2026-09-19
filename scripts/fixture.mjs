#!/usr/bin/env node
/**
 * 浏览器验收夹具：造 / 清可在「整理审批」Tab 里点着玩的提案。
 *
 *   node scripts/fixture.mjs seed     # 两条「原样重写」提案：采纳也只是把正文写成一样，无实质变更
 *   node scripts/fixture.mjs clear    # 把夹具提案从队列里删干净（含待审）
 *   node scripts/fixture.mjs status   # 看当前队列与夹具是否还在
 *
 * 依赖运行中的 dsh web（默认 http://127.0.0.1:3080，可用 STEWARD_BASE 覆盖）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.STEWARD_BASE || 'http://127.0.0.1:3080'
const API = BASE + '/memory-steward/api'
const MARK = '【验收夹具】'
const memories = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'memories')

const j = async (path, init) => {
  const res = await fetch(API + path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.ok === false) throw new Error(path + ' → HTTP ' + res.status + ' ' + (body.message || ''))
  return body
}
const post = (path, body) => j(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** 取某轨第一条条目，拆成「整条」与「去掉程序标记的正文」。 */
function firstEntry(file) {
  let raw = ''
  try { raw = readFileSync(file, 'utf8') } catch { return null }
  const entry = raw.split('\n§\n').map((s) => s.trim()).filter(Boolean)[0]
  if (!entry) return null
  const body = entry.replace(/^(\[[^\]]*\]\s*)+/, '')
  return { entry, body }
}

async function seed() {
  const mem = firstEntry(join(memories, 'MEMORY.md'))
  const user = firstEntry(join(memories, 'USER.md'))
  const proposals = []
  if (mem) proposals.push({ summary: MARK + '可采纳·原样重写（memory）', reason: '验收：这条只把正文写成一样，用来验「采纳」链路与备份', ops: [{ op: 'replace', target: 'memory', match: mem.entry.slice(0, 60), content: mem.body }] })
  if (user) proposals.push({ summary: MARK + '可拒绝·原样重写（user）', reason: '验收：这条用来验「拒绝 / 恢复」', ops: [{ op: 'replace', target: 'user', match: user.entry.slice(0, 60), content: user.body }] })
  if (!proposals.length) { console.log('记忆库是空的（MEMORY.md / USER.md 没条目），没法造夹具。'); return }
  const r = await post('/propose', { proposals })
  console.log('已造 ' + r.ids.length + ' 条夹具：' + r.ids.join(',') + '（待审 ' + r.pending + '）')
  console.log('下一步：刷新页面 → 会话视图「整理审批」Tab → 勾选/采纳/拒绝/恢复 → 跑完清理：node scripts/fixture.mjs clear')
}

async function clear() {
  const { items } = await j('/proposals')
  const ids = items.filter((i) => String(i.summary || '').startsWith(MARK)).map((i) => i.id)
  if (!ids.length) { console.log('没有夹具残留。'); return }
  await post('/proposals/purge', { ids })
  console.log('已清除 ' + ids.length + ' 条夹具：' + ids.join(','))
}

async function status() {
  const { items } = await j('/proposals')
  const fx = items.filter((i) => String(i.summary || '').startsWith(MARK))
  const pending = items.filter((i) => i.status === 'pending')
  console.log('队列共 ' + items.length + ' 条（待审 ' + pending.length + '，夹具 ' + fx.length + '）')
  for (const i of items.slice(0, 12)) console.log('  ' + i.id + ' [' + i.status + '] ' + i.track + '/' + i.kind + ' — ' + i.summary)
}

const cmd = process.argv[2] || 'status'
try {
  if (cmd === 'seed') await seed()
  else if (cmd === 'clear') await clear()
  else await status()
} catch (e) {
  console.error('失败：' + (e && e.message ? e.message : e))
  process.exitCode = 1
}
