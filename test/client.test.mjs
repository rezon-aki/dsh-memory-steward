/**
 * client 半区测试：把 lib/client.js 当浏览器 bundle 加载（迷你 React 顶替 hooks/组件），
 * 对真实运行中的管家服务做渲染冒烟——面板不能抛异常，关键文案（含子组件渲染的行）要在。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { apply as hostApply } from '../lib/index.js'
import { entry, execOf, makeCtx, makeMemoryDir, startServer } from './harness.mjs'

const SRC = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
const realFetch = globalThis.fetch

/** 迷你 React：根组件 hooks 跨渲染保留，子组件按实例开临时作用域；够 Panel 用。 */
function makeMiniReact() {
  const root = { hooks: [], effects: [], i: 0 }
  const stack = [root]
  const scope = () => stack[stack.length - 1]
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    useState: (init) => {
      const s = scope(), idx = s.i++
      if (!(idx in s.hooks)) s.hooks[idx] = typeof init === 'function' ? init() : init
      return [s.hooks[idx], (v) => { s.hooks[idx] = typeof v === 'function' ? v(s.hooks[idx]) : v }]
    },
    useCallback: (fn) => fn,
    useEffect: (fn) => { const s = scope(), idx = s.i++; if (!(idx in s.hooks)) { s.hooks[idx] = true; s.effects.push(fn) } },
  }
  return {
    React,
    /** 渲染根组件（状态保存在 root.hooks，跨次渲染可见）。 */
    render: (Comp, props) => { root.i = 0; return Comp(props || {}) },
    /** 展开一个子组件（临时作用域，等价于 React 给每个组件实例自己的 hook 槽）。 */
    expand: (node) => { const s = { hooks: [], effects: [], i: 0 }; stack.push(s); try { return node.type(node.props) } finally { stack.pop() } },
    runEffects: async () => { const q = root.effects.splice(0); const clean = []; for (const fn of q) { const c = await fn(); if (typeof c === 'function') clean.push(c) } return clean },
    /** 收集渲染树里的全部文本，函数组件会被展开。 */
    text: (node, out = []) => {
      if (node === null || node === undefined || typeof node === 'boolean') return out
      if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
      if (Array.isArray(node)) { for (const n of node) makeMiniReact.text(n, out); return out }
      if (typeof node === 'object') {
        if (typeof node.type === 'function') return out   // 由实例方法展开
        makeMiniReact.text(node.children, out)
      }
      return out
    },
  }
}

/** 当浏览器 bundle 加载，返回 { apply 后的入口 }。 */
function loadClient() {
  let captured = null
  new Function('window', SRC)({ __ModuleLoader__: { load: (m) => { captured = m } } })
  assert.equal(captured.id, '@dsh-external/dsh-memory-steward')
  const mini = makeMiniReact()
  const mod = captured.factory((id) => { if (id === 'react') return mini.React; throw new Error('unexpected require: ' + id) })
  let meta = null, Panel = null
  const disposes = []
  const ctx = {
    slots: {
      inject: (_view, cb) => { cb(); return () => {} },
      register: (m, C) => { meta = m; Panel = C; return () => {} },
    },
    effect: (fn) => { const d = fn(); disposes.push(d); return d },          // 红点轮询定时器要能停
  }
  mod.apply(ctx)
  const collect = (node) => {
    const out = []
    const walk = (n) => {
      if (n === null || n === undefined || typeof n === 'boolean') return
      if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return }
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (typeof n === 'object') { if (typeof n.type === 'function') walk(mini.expand(n)); else walk(n.children) }
    }
    walk(node)
    return out
  }
  const api = {
    mod,
    get meta() { return meta },
    get Panel() { return Panel },
    render: mini.render,                       // 渲染根组件（状态跨次保留）
    runEffects: mini.runEffects,               // 跑 useEffect（拉真实数据）
    cleanups: [],                              // useEffect 的清理函数（15s 轮询定时器在这）
    text: () => collect(mini.render(Panel, {})).join(' '),
    dispose: () => {
      for (const d of disposes.concat(api.cleanups)) { try { if (typeof d === 'function') d() } catch { /* 已失效 */ } }
      disposes.length = 0
      api.cleanups.length = 0
    },
  }
  return api
}

/** 渲染到断言成立为止（最多 ~1s）：状态由异步 load() 写入，不赌固定延时。 */
async function renderUntil(client, predicate, label = '面板数据') {
  const cleanups = await client.runEffects()
  client.cleanups.push(...cleanups)
  let text = ''
  for (let n = 0; n < 40; n++) {
    text = client.text()
    if (predicate(text)) return { text, cleanups }
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail('等不到' + label + '，最后一次渲染：' + text.slice(0, 400))
}

async function withPanel(memSpec, run) {
  const mem = makeMemoryDir(memSpec)
  mkdirSync(join(mem.root, 'home'), { recursive: true })
  process.env.DSH_HOME = join(mem.root, 'home')
  const host = makeCtx()
  hostApply(host.ctx, { memoryDir: mem.root, autoCheck: false })
  const srv = await startServer(host.routes)
  globalThis.fetch = (p, init) => realFetch(srv.base + p, init)
  const client = loadClient()
  try { await run({ mem, host, srv, client }) }
  finally {
    client.dispose(); await srv.close(); host.dispose(); delete process.env.DSH_HOME
    globalThis.fetch = realFetch
    rmSync(mem.root, { recursive: true, force: true })
  }
}

test('client：面板对真实服务渲染不抛异常，开销与待审行都渲染', async () => {
  await withPanel({ memory: [entry('2026-09-01', '全局记忆条目一')], keyArchive: [entry('2026-09-03', 'key 归档：唯一串 UNIQ-X 的历史细节')] }, async ({ mem, host, client }) => {
    await host.tools.get('memory_audit').execute({ track: 'memory' }, execOf(mem.cwd))
    await host.tools.get('memory_propose').execute(
      { summary: '待审样例', reason: 'S 已收录', ops: [{ op: 'purge', target: 'archive-key', match: 'UNIQ-X' }] }, execOf(mem.cwd))

    client.render(client.Panel, {})                       // 首帧：加载中
    const { text } = await renderUntil(client, (t) => t.includes('待审样例'))

    assert.match(text, /整理开销/)
    assert.match(text, /≈tokens = 盘点清单（输入）\+ 提案正文（输出）/)
    assert.match(text, /进行中/)                          // 有未结轮次
    assert.match(text, /待审样例/)                        // 待审提案进了列表（子组件渲染）
    assert.match(text, /S 已收录/)                        // reason 也渲染
    assert.equal(typeof client.meta.label(), 'string')
  })
})

test('client：空态渲染（没有提案也没有轮次）', async () => {
  await withPanel({ memory: [entry('2026-09-01', '唯一一条')] }, async ({ client }) => {
    const loading = client.text()
    assert.match(loading, /加载中|暂无记录|整理/)          // 首帧不炸
    const { text } = await renderUntil(client, (t) => t.includes('最近检查：') && !t.includes('加载中…'))
    assert.match(text, /暂无记录/)                         // 没跑过整理
    assert.match(text, /盘点/)
  })
})
