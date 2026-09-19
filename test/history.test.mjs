/**
 * 提案队列历史的自动清理：① 瘦身存储 ② 列表瘦身+详情按需 ③ 保留策略（pruneQueue 双阈值）
 * ④ 事件日志 steward/history.jsonl。全程只碰临时目录；memory-evolve 用本地假服务顶替。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, histLine, pruneQueue } from '../lib/index.js'
import { entry, execOf, getJson, makeCtx, makeMemoryDir, postJson, startServer } from './harness.mjs'

const DAY = 86400000

async function setup(config = {}, spec = {}) {
  const mem = makeMemoryDir(spec)
  const home = join(mem.root, 'home')
  mkdirSync(home, { recursive: true })
  process.env.DSH_HOME = home
  const { ctx, tools, routes, dispose } = makeCtx()
  apply(ctx, { memoryDir: mem.root, autoCheck: false, ...config })
  const srv = await startServer(routes)
  const tool = (name, args, cwd = mem.cwd) => tools.get(name).execute(args || {}, execOf(cwd))
  const teardown = async () => { await srv.close(); dispose(); delete process.env.DSH_HOME; rmSync(mem.root, { recursive: true, force: true }) }
  return { mem, home, srv, tool, teardown, stateDir: join(mem.root, 'steward'), historyFile: join(mem.root, 'steward', 'history.jsonl'), proposalsFile: join(mem.root, 'steward', 'proposals.json') }
}
const readLog = (file) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
const itemSize = (i) => Buffer.byteLength(JSON.stringify(i))

/** pruneQueue 用的假条目。 */
const mkItem = (now, id, status, ageDays, extra = {}) => ({
  id, status, track: 'memory', kind: 'archive', summary: id,
  createdAt: now - ageDays * DAY, resolvedAt: now - ageDays * DAY,
  ops: [{ op: 'archive', target: 'memory', match: '正文'.repeat(20) }], ...extra,
})

test('pruneQueue：待审永不淘汰；非 pending 要「超出最近 N 条 且 超期」两个都满足才丢', () => {
  const now = Date.UTC(2026, 8, 19, 12)
  const items = [mkItem(now, 'p1', 'applied', 40), mkItem(now, 'p2', 'applied', 40), mkItem(now, 'p3', 'applied', 40), mkItem(now, 'p4', 'applied', 1), mkItem(now, 'p9', 'pending', 400)]
  const r = pruneQueue(items, { historyKeep: 2, historyKeepDays: 30, historySlim: true }, now)
  assert.deepEqual(r.kept.map((i) => i.id), ['p1', 'p4', 'p9'])            // 最近 2 条 = p4 + p1（同龄按数组序）：超期但在窗口内 → 留
  assert.deepEqual(r.dropped.map((i) => i.id), ['p2', 'p3'])               // 两个阈值都满足才丢
  assert.equal(r.slimmed, 1)                                               // p1 留下但精简正文
  assert.equal(items[0].ops[0].match, '正文'.repeat(20), 'pruneQueue 不改入参')
  assert.equal(r.kept.find((i) => i.id === 'p1').slim, true)
  assert.equal(r.kept.find((i) => i.id === 'p1').ops[0].op, 'archive', '动作与轨保留')
  assert.equal(r.kept.find((i) => i.id === 'p1').ops[0].match, '[正文已精简]', '正文换成占位符')
  assert.equal(r.kept.find((i) => i.id === 'p4').slim, undefined, '保留期内的不动')
  assert.equal(r.kept.find((i) => i.id === 'p9').slim, undefined, '待审永远原样')
})

test('pruneQueue：M 天内的已结条目一律保留（failed/rejected 的 error 要能查）；slim 与淘汰是两个开关', () => {
  const now = Date.UTC(2026, 8, 19, 12)
  const fresh = [1, 2, 3, 4, 5].map((n) => mkItem(now, 'f' + n, n === 1 ? 'failed' : 'applied', 1, n === 1 ? { error: '外部接口 500' } : {}))
  const r = pruneQueue(fresh, { historyKeep: 1, historyKeepDays: 30, historySlim: true }, now)
  assert.equal(r.dropped.length, 0, '超出最近 1 条但都在 30 天内 → 不淘汰')
  assert.equal(r.slimmed, 0, '保留期内不精简')
  assert.equal(r.kept.find((i) => i.id === 'f1').error, '外部接口 500')
  const r2 = pruneQueue([mkItem(now, 'o1', 'applied', 40, { backup: '/b/o1' })], { historyKeep: 20, historyKeepDays: 30, historySlim: false }, now)
  assert.equal(r2.dropped.length, 0)
  assert.equal(r2.slimmed, 0, 'historySlim=false 只关精简')
  assert.match(r2.kept[0].ops[0].match, /正文/)
  const r3 = pruneQueue(fresh, { historyKeep: 1, historyKeepDays: 0, historySlim: false }, now)
  assert.equal(r3.dropped.length, 4, '关掉精简不影响淘汰')
  assert.equal(r3.slimmed, 0)
})

test('pruneQueue：40 天前的 failed 仍在最近 N 条内 → 留（诊断字段不动），40 天前的 applied → 精简', () => {
  const now = Date.UTC(2026, 8, 19, 12)
  const r = pruneQueue([mkItem(now, 'p1', 'failed', 40, { error: '连接被拒' }), mkItem(now, 'p2', 'applied', 40, { backup: '/b/p2' })], { historyKeep: 20, historyKeepDays: 30, historySlim: true }, now)
  assert.equal(r.dropped.length, 0)
  assert.equal(r.kept.length, 2)
  assert.equal(r.kept[0].error, '连接被拒')
  assert.equal(r.kept[0].slim, true)
  assert.equal(r.kept[1].slim, true)
})

test('pruneQueue：存量 results 里的 result 回显顺手剥掉，续跑要用的 ok 保留', () => {
  const now = Date.UTC(2026, 8, 19, 12)
  const withEcho = { ...mkItem(now, 'p1', 'applied', 1), results: [{ op: 'archive', ok: true, message: '', result: { ok: true, removed: '整条正文'.repeat(50) } }] }
  const r = pruneQueue([withEcho], { historyKeep: 20, historyKeepDays: 30, historySlim: true }, now)
  assert.deepEqual(Object.keys(r.kept[0].results[0]).sort(), ['message', 'ok', 'op'])
  assert.equal(r.kept[0].results[0].ok, true, '断点续跑读的就是它')
  assert.equal(withEcho.results[0].result.ok, true, '不改入参')
  const done = { ...mkItem(now, 'p2', 'failed', 1), results: [{ op: 'archive', ok: false, message: '模拟外部失败' }] }
  assert.equal(pruneQueue([done], { historyKeep: 20, historyKeepDays: 30 }, now).kept[0], done, '已经精简过的不重新造对象')
})

test('事件日志行：整行 ≤300 B、保留 summary 与 error、字段固定、无 ops 正文', () => {
  const line = histLine({ ts: 1789804277579, id: 'p0044', status: 'failed', track: 'archive-memory', kind: 'replace', summary: '中文摘要标题'.repeat(30), error: '错误原因'.repeat(30), backup: true, ops: 16 })
  assert.ok(Buffer.byteLength(JSON.stringify(line)) <= 300, '中文最坏情况也要 ≤300 B：' + itemSize(line))
  assert.match(line.summary, /中文摘要标题/)
  assert.match(line.error, /错误原因/)
  assert.deepEqual(Object.keys(line), ['ts', 'id', 'status', 'track', 'kind', 'summary', 'error', 'backup', 'ops'])
  const tiny = histLine({ id: 'p1', status: 'applied', summary: 'M 合并：把四条并成一条' })
  assert.equal(tiny.error, null)
  assert.equal(tiny.backup, false)
  assert.equal(tiny.ops, 0)
  assert.ok(Buffer.byteLength(JSON.stringify(tiny)) <= 300)
  assert.equal(JSON.stringify(tiny).includes('ops":['), false, '日志里不能有 ops 数组')
})

test('日志端到端：失败/采纳/清空历史都留痕，淘汰前先记一行，日志绝不含正文', async () => {
  const s = await setup({}, { memory: [entry('2026-09-01', '条目甲：唯一串 LOG-A'), entry('2026-09-02', '条目乙：唯一串 LOG-B')], keyArchive: [entry('2026-09-03', '归档条目：唯一串 ARCH-A 的历史细节')] })
  try {
    await s.tool('memory_propose', { summary: '清运 ARCH-A', reason: 'S 已收录', ops: [{ op: 'purge', target: 'archive-key', match: 'ARCH-A' }] })
    await s.tool('memory_propose', { summary: '归档 LOG-B', reason: 'A 低价值', ops: [{ op: 'archive', target: 'memory', match: 'LOG-B' }] })
    let items = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items
    const idA = items.find((i) => i.summary === '清运 ARCH-A').id
    const idB = items.find((i) => i.summary === '归档 LOG-B').id
    s.srv.failOnce.add('/memory-evolve/api/memory/delete')
    const bad = await postJson(s.srv.base, '/memory-steward/api/proposals/approve', { ids: [idA] })
    assert.equal(bad.body.results[0].ok, false)
    const good = await postJson(s.srv.base, '/memory-steward/api/proposals/approve', { ids: [idB] })
    assert.equal(good.body.results[0].ok, true)
    const log = readLog(s.historyFile)
    assert.equal(log.length, 2)
    assert.equal(log[0].status, 'failed')
    assert.equal(log[0].id, idA)
    assert.equal(log[0].error, '模拟外部失败')          // 诊断三件套：error + ts + summary
    assert.equal(log[0].backup, true, '失败也留了备份（执行前整份文件）')
    assert.equal(log[0].ops, 1)
    assert.equal(log[1].status, 'applied')
    assert.ok(log[0].ts > 0)
    const raw = readFileSync(s.historyFile, 'utf8')
    assert.equal(raw.includes('ARCH-A 的历史细节'), false, '日志不含正文')
    assert.equal(raw.includes('条目乙'), false, '日志不含正文')
    assert.ok(log.every((l) => Buffer.byteLength(JSON.stringify(l)) <= 300))
    // 清空历史：队列删掉、日志只加一行留痕
    const clr = await postJson(s.srv.base, '/memory-steward/api/proposals/purge', {})
    assert.match(clr.body.results[0].message, /已清除 2 条历史/)
    const log2 = readLog(s.historyFile)
    assert.equal(log2.length, 3)
    assert.equal(log2[2].status, 'cleared')
    assert.match(log2[2].summary, /清空历史 2 条/)
    assert.equal((await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items.length, 0)
    const st = (await getJson(s.srv.base, '/memory-steward/api/status')).body.history
    assert.deepEqual([st.keep, st.keepDays, st.slim], [20, 30, true])
    assert.equal(st.pruned, 0)
    assert.equal(st.slimmed, 2, '已结项（有备份）正文已精简')
    assert.equal(st.log.lines, 3)
    assert.equal(st.pending, 0)
  } finally { await s.teardown() }
})

test('列表接口只回轻量字段（无 ops/results），详情接口按需给整份 ops', async () => {
  const s = await setup({}, { memory: [entry('2026-09-01', '条目甲：唯一串 LIST-A'), entry('2026-09-02', '条目乙：唯一串 LIST-B')] })
  try {
    await s.tool('memory_propose', {
      summary: '两段式：先归档再改写', reason: 'M 可合并：把甲并进乙', ops: [
        { op: 'archive', target: 'memory', match: 'LIST-A' },
        { op: 'replace', target: 'memory', match: 'LIST-B', content: '条目乙：已合并' },
      ],
    })
    const list = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items[0]
    for (const k of ['id', 'summary', 'status', 'track', 'kind', 'createdAt', 'appliedAt', 'error', 'opCount', 'backup']) {
      assert.ok(k in list, '轻量字段缺 ' + k)
    }
    assert.equal('ops' in list, false, '列表不带 ops 正文')
    assert.equal('results' in list, false)
    assert.equal(list.opCount, 2)
    assert.equal(list.backup, false)
    assert.equal(list.appliedAt, null)
    assert.equal(list.opsBrief, 'archive:memory + replace:memory')
    const one = (await getJson(s.srv.base, '/memory-steward/api/proposals/' + list.id)).body.item
    assert.equal(one.ops.length, 2)
    assert.equal(one.ops[0].match, '[2026-09-01] 条目甲：唯一串 LIST-A')
    assert.equal(one.ops[1].content, '条目乙：已合并')
    assert.match(one.reason, /M 可合并/)
    assert.equal((await getJson(s.srv.base, '/memory-steward/api/proposals/p9999')).status, 404)
  } finally { await s.teardown() }
})

test('体积验收：13 条已结历史 → proposals.json ≤40 KB、列表载荷 ≤6 KB', async () => {
  const long = (i) => '长条目 ' + i + '：' + '内容'.repeat(300)
  const s = await setup({}, { memory: Array.from({ length: 13 }, (_, i) => entry('2026-09-01', long(i + 1))) })
  try {
    for (let i = 1; i <= 13; i++) {
      const r = await s.tool('memory_propose', {
        summary: 'M 合并：第 ' + i + ' 组四条并成一条（重提，去掉非法分隔符）',
        reason: 'S 已收录：' + '判定理由'.repeat(10),
        ops: [{ op: 'archive', target: 'memory', match: '长条目 ' + i + '：' }],
      })
      assert.equal(r.ok, true)
    }
    const ids = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items.map((i) => i.id)
    assert.equal(ids.length, 13)
    for (const id of ids) {
      const r = await postJson(s.srv.base, '/memory-steward/api/proposals/approve', { ids: [id] })
      assert.equal(r.body.results[0].ok, true, JSON.stringify(r.body))
    }
    const fileBytes = statSync(s.proposalsFile).size
    assert.ok(fileBytes <= 40 * 1024, 'proposals.json 应 ≤40 KB，实际 ' + fileBytes)
    const payload = Buffer.byteLength(await (await fetch(s.srv.base + '/memory-steward/api/proposals')).text())
    assert.ok(payload <= 6000, '列表载荷应 ≤6 KB，实际 ' + payload)
    const st = (await getJson(s.srv.base, '/memory-steward/api/status')).body.history
    assert.equal(st.slimmed, 13)
    assert.equal(st.queue, 13)
    assert.equal(readLog(s.historyFile).length, 13)
  } finally { await s.teardown() }
})

test('保留策略端到端：60 条已结 + 1 条待审 → 收敛到 historyKeep，待审永不淘汰', async () => {
  const s = await setup({ historyKeep: 20, historyKeepDays: 0 }, { memory: Array.from({ length: 61 }, (_, i) => entry('2026-09-01', '批量条目 ' + (i + 1) + '：各不相同 ' + 'x'.repeat(40))) })
  try {
    for (let n = 0; n < 3; n++) {
      const proposals = Array.from({ length: 20 }, (_, k) => {
        const i = n * 20 + k + 1
        return { summary: '历史 ' + i, reason: 'x', ops: [{ op: 'archive', target: 'memory', match: '批量条目 ' + i + '：' }] }
      })
      assert.equal((await postJson(s.srv.base, '/memory-steward/api/propose', { proposals })).status, 200)
    }
    assert.equal((await getJson(s.srv.base, '/memory-steward/api/status')).body.history.queue, 60)
    for (const id of (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items.map((i) => i.id)) {
      const r = await postJson(s.srv.base, '/memory-steward/api/proposals/approve', { ids: [id] })
      assert.equal(r.body.results[0].ok, true)
    }
    await s.tool('memory_propose', { summary: '待审的一条', reason: 'x', ops: [{ op: 'archive', target: 'memory', match: '批量条目 61：' }] })
    const st = (await getJson(s.srv.base, '/memory-steward/api/status')).body.history
    assert.equal(st.pruned, 40)
    assert.equal(st.queue, 21)
    assert.equal(st.pending, 1)
    const items = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items
    assert.equal(items.length, 21)
    assert.equal(items.filter((i) => i.status === 'pending').length, 1)
    assert.ok(readLog(s.historyFile).length >= 40, '淘汰的条目必须在日志里留下痕迹')
    assert.ok(readLog(s.historyFile).every((l) => Buffer.byteLength(JSON.stringify(l)) <= 300))
  } finally { await s.teardown() }
})

test('确定性提案去重：队列清空后从事件日志读 summary，不重复提同一簇', async () => {
  const s = await setup({}, { memory: [entry('2026-09-01', '重复条目甲：唯一串 DUP-A'), entry('2026-09-02', '重复条目乙：唯一串 DUP-B')] })
  try {
    const dir = join(s.home, 'profiles', 'p1', 'node_modules', 'dsh-memory-evolve', 'skills', 'memory-consolidate', 'scripts')
    mkdirSync(dir, { recursive: true })
    const report = {
      stats: { hints: { duplicate: 1 } },
      clusters: [{ id: 'c1', hint: 'duplicate', pairs: [{ sim: 0.95 }], members: [
        { id: 'm1', track: 'memory', date: '2026-09-01', excerpt: '重复条目甲：唯一串 DUP-A' },
        { id: 'm2', track: 'memory', date: '2026-09-02', excerpt: '重复条目乙：唯一串 DUP-B' },
      ] }],
    }
    writeFileSync(join(dir, 'scan_memory.mjs'), 'console.log(' + JSON.stringify(JSON.stringify(report)) + ')\n')
    const first = await postJson(s.srv.base, '/memory-steward/api/scan', {})
    assert.equal(first.body.added, 1)
    const id = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items[0].id
    await postJson(s.srv.base, '/memory-steward/api/proposals/reject', { ids: [id] })
    await postJson(s.srv.base, '/memory-steward/api/proposals/purge', {})              // 队列清空，去重只剩日志
    assert.equal((await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items.length, 0)
    const again = await postJson(s.srv.base, '/memory-steward/api/scan', {})
    assert.equal(again.body.added, 0, '日志里有摘要 → 同一簇不该再提一次')
    assert.equal(readLog(s.historyFile).some((l) => String(l.summary).startsWith('dup:')), true)
  } finally { await s.teardown() }
})

test('清理日志：按天数删旧行、all 整文件删；队列与记忆不受影响', async () => {
  const s = await setup({}, { memory: [entry('2026-09-01', '唯一一条：唯一串 LOGX')] })
  try {
    mkdirSync(s.stateDir, { recursive: true })
    writeFileSync(s.historyFile, JSON.stringify(histLine({ ts: Date.now() - 40 * DAY, id: 'p0001', status: 'applied', summary: '很久以前的一条' })) + '\n')
    await s.tool('memory_propose', { summary: '要拒绝的一条', reason: 'x', ops: [{ op: 'archive', target: 'memory', match: 'LOGX' }] })
    const id = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items[0].id
    await postJson(s.srv.base, '/memory-steward/api/proposals/reject', { ids: [id] })
    assert.equal(readLog(s.historyFile).length, 2)
    const trim = await postJson(s.srv.base, '/memory-steward/api/history/clear', { days: 7 })
    assert.deepEqual([trim.body.removed, trim.body.kept], [1, 1])
    assert.equal(readFileSync(s.historyFile, 'utf8').includes('很久以前'), false)
    assert.equal((await getJson(s.srv.base, '/memory-steward/api/status')).body.history.log.lines, 1)
    const wiped = await postJson(s.srv.base, '/memory-steward/api/history/clear', { all: true })
    assert.equal(wiped.body.removed, 1)
    assert.equal(existsSync(s.historyFile), false)
    assert.equal((await getJson(s.srv.base, '/memory-steward/api/status')).body.history.log.lines, 0)
    const items = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items
    assert.equal(items.length, 1, '清日志不动队列')
    assert.equal(items[0].status, 'rejected')
  } finally { await s.teardown() }
})
