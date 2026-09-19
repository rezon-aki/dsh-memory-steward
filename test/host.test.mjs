/**
 * host 半区测试：预算/到期判定、归档预筛、提案解析、执行与备份、轮次记账、Origin 围栏、技能同步。
 * 全程只碰临时目录；memory-evolve 用本地假服务顶替。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { entry, execOf, getJson, makeCtx, makeMemoryDir, postJson, startServer } from './harness.mjs'

const SHERPA = 'voice-bridge 声纹模型：sherpa-onnx AAR 精简 arm64 后 11,885,845 字节，sha256 a592781e'

function fixture(spec = {}) {
  return makeMemoryDir({
    memory: [
      ...Array.from({ length: 20 }, (_, i) => entry('2026-09-01', '全局记忆条目 ' + (i + 1) + '：内容各不相同')),
      entry('2026-09-02', SHERPA),
    ],
    user: [entry('2026-08-30', '用户偏好：先出方案再动手')],
    memoryArchive: [entry('2026-09-03', SHERPA), entry('2026-09-01', '归档独占条目：只在这里出现的一次性细节')],
    key: [entry('2026-09-05', '项目关键记忆：链路定案 AEC + 声纹门控')],
    keyArchive: [
      entry('2026-09-03', 'key 归档条目一：含唯一串 ALPHA-UNIQUE 的历史细节'),
      entry('2026-09-03', 'key 归档条目二：含唯一串 BETA-UNIQUE 的历史细节'),
    ],
    userArchive: [entry('2026-08-29', 'user 归档：旧偏好')],
    ...spec,
  })
}

/** 起一套完整环境：临时记忆库 + 假 ctx + 本地服务（管家路由 + 假 memory-evolve）。 */
async function setup(config = {}) {
  const mem = fixture()
  const home = mkdtemp(join(mem.root, 'home'))
  process.env.DSH_HOME = home
  const { ctx, tools, routes, prompts, dispose } = makeCtx()
  apply(ctx, { memoryDir: mem.root, autoCheck: false, ...config })
  const srv = await startServer(routes)
  const tool = (name, args, cwd = mem.cwd) => tools.get(name).execute(args || {}, execOf(cwd))
  const teardown = async () => { await srv.close(); dispose(); delete process.env.DSH_HOME; rmSync(mem.root, { recursive: true, force: true }) }
  return { mem, home, ctx, tools, routes, prompts, srv, tool, teardown }
}

const mkdtemp = (p) => { mkdirSync(p, { recursive: true }); return p }

/** 模拟一次「热重载」：新 ctx + 新 instance 读同一份记忆库，返回它的 /api/status。 */
async function reloadStatus(s, memoryDir) {
  const again = makeCtx()
  apply(again.ctx, { memoryDir, autoCheck: false })
  const srv = await startServer(again.routes)
  try { return (await getJson(srv.base, '/memory-steward/api/status')).body }
  finally { await srv.close(); again.dispose() }
}

test('预算判定：超条数即报超，且到期提醒进入 systemPrompt', async () => {
  const s = await setup()
  try {
    const r = await s.tool('memory_audit', { track: 'memory' })
    assert.equal(r.ok, true)
    assert.match(r.message, /超\(条数\)/)
    const line = s.prompts[0].text({ agent: { session: { header: { cwd: s.mem.cwd } } } })
    assert.match(line, /【记忆库存】/)
    assert.match(line, /【整理到期】/)
    assert.match(line, /archiveCheck:true/)   // 轻量模式默认：先预筛
  } finally { await s.teardown() }
})

test('到期只在「无待审 + 隔够天数」时成立', async () => {
  const s = await setup()
  try {
    const before = await s.tool('memory_sweep_status', { action: 'check' })
    assert.match(before.message, /到期：是/)
    await s.tool('memory_propose', { summary: '先占一条', reason: '测试', ops: [{ op: 'purge', target: 'archive-key', match: 'ALPHA-UNIQUE' }] })
    const after = await s.tool('memory_sweep_status', { action: 'check' })
    assert.match(after.message, /待审提案：1 条/)
    assert.match(after.message, /到期：否/)
  } finally { await s.teardown() }
})

test('归档预筛：完全重复进「疑似已收录」，独占条目不列全文', async () => {
  const s = await setup()
  try {
    const r = await s.tool('memory_audit', { archiveCheck: true })          // 预筛段：独占条目只报数不列全文
    assert.match(r.message, /archive-memory：共 2 条 → 疑似已收录 1 \/ 归档独占 1 \/ 待判 0/)
    assert.match(r.message, /sherpa-onnx/)
    assert.doesNotMatch(r.message, /只在这里出现的一次性细节/)
    const all = await s.tool('memory_audit', { track: 'all' })               // 全量清单：六个轨都列
    for (const track of ['memory(全局)', 'user(全局)', 'key(本项目)', 'archive-memory', 'archive-user', 'archive-key']) {
      assert.ok(all.message.includes(track), '全量清单应含 ' + track)
    }
  } finally { await s.teardown() }
})

test('提案解析：唯一子串换成整条正文；歧义/无匹配都拒绝', async () => {
  const s = await setup()
  try {
    const ok = await s.tool('memory_propose', { summary: '清运 ALPHA', reason: 'S 已收录', ops: [{ op: 'purge', target: 'archive-key', match: 'ALPHA-UNIQUE' }] })
    assert.equal(ok.ok, true)
    const list = await getJson(s.srv.base, '/memory-steward/api/proposals')
    const p = list.body.items.find((i) => i.summary === '清运 ALPHA')
    assert.equal(p.ops[0].match, '[2026-09-03] key 归档条目一：含唯一串 ALPHA-UNIQUE 的历史细节')
    assert.equal(p.track, 'archive-key')
    const bad = await s.tool('memory_propose', { summary: '歧义', reason: 'x', ops: [{ op: 'purge', target: 'archive-key', match: '唯一串' }] })
    assert.equal(bad.ok, false)
    assert.match(bad.message, /匹配到 2 条/)
    const none = await s.tool('memory_propose', { summary: '无匹配', reason: 'x', ops: [{ op: 'purge', target: 'archive-key', match: 'NOT-EXIST-ANYWHERE' }] })
    assert.equal(none.ok, false)
    assert.match(none.message, /找不到匹配条目/)
  } finally { await s.teardown() }
})

test('采纳执行：回调官方 delete 接口、带 origin、执行前备份 6 个文件', async () => {
  const s = await setup()
  try {
    await s.tool('memory_propose', { summary: '清运 ALPHA', reason: 'S', ops: [{ op: 'purge', target: 'archive-key', match: 'ALPHA-UNIQUE' }] })
    const id = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items[0].id
    const res = await postJson(s.srv.base, '/memory-steward/api/proposals/approve', { ids: [id] })
    assert.equal(res.status, 200)
    assert.equal(res.body.results[0].ok, true)
    const call = s.srv.calls.at(-1)
    assert.equal(call.url, '/memory-evolve/api/memory/delete')
    assert.equal(call.body.target, 'archive-key')
    assert.equal(call.body.match, '[2026-09-03] key 归档条目一：含唯一串 ALPHA-UNIQUE 的历史细节')
    assert.match(call.origin, /^http:\/\/127\.0\.0\.1:/)
    const backups = join(s.mem.root, 'steward', 'backups')
    const dirs = readdirSync(backups)
    assert.equal(dirs.length, 1)
    assert.equal(readdirSync(join(backups, dirs[0])).sort().join(','),
      'KEY-archive.md,KEY.md,MEMORY-archive.md,MEMORY.md,USER-archive.md,USER.md')
  } finally { await s.teardown() }
})

test('轮次记账：盘点/提案字符都算进 tokens，执行后结轮', async () => {
  const s = await setup()
  try {
    await s.tool('memory_audit', { track: 'memory' })
    await s.tool('memory_propose', { summary: '清运 ALPHA', reason: 'S', ops: [{ op: 'purge', target: 'archive-key', match: 'ALPHA-UNIQUE' }] })
    const id = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items[0].id
    await postJson(s.srv.base, '/memory-steward/api/proposals/approve', { ids: [id] })
    const r = (await getJson(s.srv.base, '/memory-steward/api/rounds')).body
    assert.equal(r.open, null)
    const round = r.rounds[0]
    assert.equal(round.auditCalls, 1)
    assert.ok(round.auditChars > 0, 'auditChars 应记账')
    assert.ok(round.proposeChars > 0, 'proposeChars 应记账（提案正文是模型输出）')
    assert.equal(round.tokens, Math.ceil((round.auditChars + round.proposeChars) / 2))
    assert.equal(round.auditTokens, Math.ceil(round.auditChars / 2))
    assert.equal(round.applied, 1)
    assert.equal(round.failed, 0)
    assert.equal(round.reason, 'all-resolved')
    assert.equal(r.summary.lastTokens, round.tokens)
    assert.equal(r.summary.target, 2000)
  } finally { await s.teardown() }
})

test('Origin 围栏：跨站请求 403，且不触发任何写入', async () => {
  const s = await setup()
  try {
    const res = await postJson(s.srv.base, '/memory-steward/api/config', { nudge: false }, { origin: 'http://evil.example' })
    assert.equal(res.status, 403)
    assert.equal(s.srv.calls.length, 0)
    const ok = await postJson(s.srv.base, '/memory-steward/api/config', { nudge: false })
    assert.equal(ok.status, 200)
  } finally { await s.teardown() }
})

test('拒绝可恢复：reject → rejected，restore → pending', async () => {
  const s = await setup()
  try {
    await s.tool('memory_propose', { summary: 'x', reason: 'S', ops: [{ op: 'purge', target: 'archive-key', match: 'BETA-UNIQUE' }] })
    const id = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items[0].id
    await postJson(s.srv.base, '/memory-steward/api/proposals/reject', { ids: [id] })
    let items = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items
    assert.equal(items[0].status, 'rejected')
    await postJson(s.srv.base, '/memory-steward/api/proposals/restore', { ids: [id] })
    items = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items
    assert.equal(items[0].status, 'pending')
  } finally { await s.teardown() }
})

test('技能随包：内容不同即覆写；一致时 unchanged', async () => {
  const s = await setup()
  try {
    const dst = join(process.env.DSH_HOME, 'skills', 'memory-hygiene', 'SKILL.md')
    assert.equal(existsSync(dst), true, 'apply() 应把技能安装到技能库')
    const repo = readFileSync(join(import.meta.dirname, '..', 'skills', 'memory-hygiene', 'SKILL.md'), 'utf8')
    assert.equal(readFileSync(dst, 'utf8'), repo)
    let st = (await getJson(s.srv.base, '/memory-steward/api/status')).body
    assert.equal(st.skill.action, 'installed')                              // 空技能库：首次是安装
    st = await reloadStatus(s, s.mem.root)
    assert.equal(st.skill.action, 'unchanged')                              // 内容一致：不动它
    writeFileSync(dst, '# 被改脏的技能\n')
    st = await reloadStatus(s, s.mem.root)
    assert.equal(st.skill.action, 'updated')                                // 被改脏：覆写回仓库版
    assert.equal(readFileSync(dst, 'utf8'), repo)
  } finally { await s.teardown() }
})

test('配置往返：API 写入后重载仍生效', async () => {
  const s = await setup()
  try {
    await postJson(s.srv.base, '/memory-steward/api/config', { sweepIntervalDays: 3, nudge: false, budgetRatio: 2 })
    const st = await reloadStatus(s, s.mem.root)                            // 换一个实例读盘：证明配置真的落盘了
    assert.equal(st.config.sweepIntervalDays, 3)
    assert.equal(st.config.nudge, false)
    assert.equal(st.config.budgetRatio, 2)
    assert.ok(existsSync(join(s.mem.root, 'steward', 'config.json')))
  } finally { await s.teardown() }
})

test('没有 memory-evolve 扫描器时优雅降级：/api/scan 不崩，错误记进 lastError', async () => {
  const s = await setup()
  try {
    const res = await postJson(s.srv.base, '/memory-steward/api/scan', {})
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.added, 0)
    const st = (await getJson(s.srv.base, '/memory-steward/api/status')).body
    assert.match(String(st.lastError), /未找到上游 scan_memory\.mjs/)
  } finally { await s.teardown() }
})
test('自检接口：逐项给 PASS/FAIL，外部依赖缺失也不抛错', async () => {
  const s = await setup()
  try {
    const r = await getJson(s.srv.base, '/memory-steward/api/selfcheck')
    assert.equal(r.status, 200)
    const by = Object.fromEntries(r.body.checks.map((c) => [c.name, c]))
    for (const c of r.body.checks) {
      assert.equal(typeof c.name, 'string')
      assert.equal(typeof c.ok, 'boolean')
      assert.equal(typeof c.detail, 'string')
    }
    assert.equal(r.body.checks.length, 7)
    assert.equal(by['技能随包同步'].ok, true)          // 本地必过项
    assert.equal(by['状态目录可写'].ok, true)
    assert.equal(by['工具注册'].ok, true)
    assert.equal(by['提案队列可读'].ok, true)
    assert.equal(by['客户端 bundle 已组合'].ok, false)  // 测试 ctx 没有 clientModules
    assert.equal(by['memory-evolve 写入契约'].ok, false) // 测试环境没装伴生插件（自检要报出来而不是崩）
  } finally { await s.teardown() }
})

test('HTTP 提案口：与工具同一条实现（唯一子串→整条正文；解析失败 400）', async () => {
  const s = await setup()
  try {
    const r = await postJson(s.srv.base, '/memory-steward/api/propose', {
      cwd: s.mem.cwd,                                   // key/archive-key 目标：无会话时显式给 cwd
      summary: '夹具提案', reason: 'S 已收录', ops: [{ op: 'purge', target: 'archive-key', match: 'ALPHA-UNIQUE' }],
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.ids.length, 1)
    assert.equal(r.body.pending, 1)
    const p = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items[0]
    assert.equal(p.ops[0].match, '[2026-09-03] key 归档条目一：含唯一串 ALPHA-UNIQUE 的历史细节')
    assert.equal(p.source, 'api')
    const bad = await postJson(s.srv.base, '/memory-steward/api/propose', { cwd: s.mem.cwd, summary: 'x', reason: 'y', ops: [{ op: 'purge', target: 'archive-key', match: '根本不存在' }] })
    assert.equal(bad.status, 400)
    assert.match(bad.body.message, /找不到匹配条目/)
  } finally { await s.teardown() }
})
test('提案期就拦住非法新正文：含 § 直接拒绝，不留到审批才炸', async () => {
  const s = await setup()
  try {
    const bad = await s.tool('memory_propose', { summary: '含分隔符', reason: 'x', ops: [{ op: 'replace', target: 'memory', match: '全局记忆条目 1：', content: '正文里带了 § 符号' }] })
    assert.equal(bad.ok, false)
    assert.match(bad.message, /不能包含 §/)
    const empty = await s.tool('memory_propose', { summary: '空正文', reason: 'x', ops: [{ op: 'replace', target: 'memory', match: '全局记忆条目 1：', content: '   ' }] })
    assert.equal(empty.ok, false)
    assert.match(empty.message, /需要 content/)
    assert.equal((await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items.length, 0)
  } finally { await s.teardown() }
})

test('执行可续跑：中途失败后重试，已成功的 op 不重放', async () => {
  const s = await setup()
  try {
    const p = await s.tool('memory_propose', {
      summary: '两段式', reason: 'x',
      ops: [
        { op: 'replace', target: 'memory', match: '全局记忆条目 1：', content: '全局记忆条目 1：已改写' },
        { op: 'archive', target: 'memory', match: '全局记忆条目 2：' },
      ],
    })
    assert.equal(p.ok, true)
    const id = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items[0].id
    s.srv.failOnce.add('/memory-evolve/api/memory/archive')          // 第 2 个 op 失败一次
    const first = await postJson(s.srv.base, '/memory-steward/api/proposals/approve', { ids: [id] })
    assert.equal(first.body.results[0].ok, false)
    let item = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items[0]
    assert.equal(item.status, 'failed')
    assert.equal(item.results.length, 2)
    assert.equal(item.results[0].ok, true)                            // 第 1 个 op 已成功
    const updates = s.srv.calls.filter((c) => c.url.endsWith('/memory/update')).length
    assert.equal(updates, 1)
    const second = await postJson(s.srv.base, '/memory-steward/api/proposals/approve', { ids: [id] })
    assert.equal(second.body.results[0].ok, true, '重试应从失败的 op 续跑并成功')
    item = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items[0]
    assert.equal(item.status, 'applied')
    assert.equal(s.srv.calls.filter((c) => c.url.endsWith('/memory/update')).length, 1, '已成功的 op 不能被重放')
    assert.equal(s.srv.calls.filter((c) => c.url.endsWith('/memory/archive')).length, 2, '归档只该在第二次真正执行')
  } finally { await s.teardown() }
})

test('并发重复提交同一提案：只执行一次，另一次被挡', async () => {
  const s = await setup()
  try {
    await s.tool('memory_propose', { summary: '并发', reason: 'x', ops: [{ op: 'purge', target: 'archive-key', match: 'ALPHA-UNIQUE' }] })
    const id = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items[0].id
    const [a, b] = await Promise.all([
      postJson(s.srv.base, '/memory-steward/api/proposals/approve', { ids: [id] }),
      postJson(s.srv.base, '/memory-steward/api/proposals/approve', { ids: [id] }),
    ])
    const oks = [a, b].filter((r) => r.body.results[0].ok).length
    assert.equal(oks, 1, '两次并发只该有一次成功')
    assert.equal(s.srv.calls.length, 1, '真实删除只该发一次')
    const item = (await getJson(s.srv.base, '/memory-steward/api/proposals')).body.items[0]
    assert.equal(item.status, 'applied')
  } finally { await s.teardown() }
})
