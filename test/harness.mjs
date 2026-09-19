/**
 * 测试脚手架：假 ctx + 临时记忆库 + 一个同时扮演管家 API 与 memory-evolve API 的本地服务。
 * 不依赖任何测试框架之外的东西，也不碰真实的 ~/.dsh。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const DELIM = '\n§\n'
export const hashOf = (cwd) => createHash('sha1').update(String(cwd)).digest('hex').slice(0, 12)
export const entry = (date, text) => '[' + date + '] ' + text

/** 临时记忆库：memory/user/key + 三个归档轨，返回定位与改写工具。 */
export function makeMemoryDir(spec = {}) {
  const root = mkdtempSync(join(tmpdir(), 'steward-test-'))
  const cwd = spec.cwd || '/tmp/proj'
  const pdir = join(root, 'projects', hashOf(cwd))
  mkdirSync(pdir, { recursive: true })
  mkdirSync(join(root, 'daily'), { recursive: true })
  const files = {
    memory: join(root, 'MEMORY.md'),
    user: join(root, 'USER.md'),
    memoryArchive: join(root, 'MEMORY-archive.md'),
    userArchive: join(root, 'USER-archive.md'),
    key: join(pdir, 'KEY.md'),
    keyArchive: join(pdir, 'KEY-archive.md'),
  }
  const write = (k, arr) => writeFileSync(files[k], arr.join(DELIM) + '\n')
  for (const k of Object.keys(files)) write(k, spec[k] || [])
  return { root, cwd, pdir, files, write }
}

/** 假 ctx：收集注册的工具/路由/系统提示/效果，dispose() 清掉定时器。 */
export function makeCtx() {
  const tools = new Map(), routes = [], disposes = [], prompts = [], events = []
  const ctx = {
    tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
    webServer: { register: (r) => { routes.push(r); return () => {} }, listenedPort: 0 },
    systemPrompt: { context: (c) => { prompts.push(c); return () => {} } },
    effect: (fn) => { const d = fn(); disposes.push(d); return d },
    on: (name, fn) => { events.push({ name, fn }); return () => {} },
    inject: (_deps, fn) => { fn(ctx); return () => {} },
    get: (k) => (k === 'webServer' ? ctx.webServer : undefined),
    logger: { info: () => {} },
  }
  return { ctx, tools, routes, prompts, events, dispose: () => { for (const d of disposes) { try { if (typeof d === 'function') d() } catch { /* 已失效 */ } } } }
}

/** 同时扮演管家路由与 memory-evolve 写入接口；写调用记进 calls。 */
export async function startServer(routes, calls = []) {
  const server = createServer((req, res) => {
    const url = req.url || '/'
    if (url.startsWith('/memory-evolve/')) {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        let parsed = null
        try { parsed = JSON.parse(body || '{}') } catch { /* 保留 null */ }
        calls.push({ method: req.method, url, body: parsed, origin: req.headers.origin })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    const r = routes.find((x) => url.startsWith(x.path))
    if (!r) { res.statusCode = 404; res.end('{}'); return }
    r.handler(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  return { server, port, base: 'http://127.0.0.1:' + port, calls, close: () => new Promise((r) => server.close(r)) }
}

/** 工具调用用的 exec 上下文（模拟会话头）。 */
export const execOf = (cwd, id = 'session-test') => ({ agent: { session: { id, header: { cwd } } } })

export const getJson = async (base, path) => {
  const res = await fetch(base + path)
  return { status: res.status, body: await res.json() }
}
export const postJson = async (base, path, body, headers = {}) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) })
  return { status: res.status, body: await res.json() }
}
