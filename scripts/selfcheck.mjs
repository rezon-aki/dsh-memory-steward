#!/usr/bin/env node
/**
 * 一条命令看清管家哪里断了：内核契约 / 伴生插件 / 自身状态。
 *   node scripts/selfcheck.mjs          # 人看的格式
 *   node scripts/selfcheck.mjs --json   # 原始 JSON
 * 退出码：全 PASS=0，有 FAIL=1（可直接用于脚本/习惯性检查）。
 */
const BASE = process.env.STEWARD_BASE || 'http://127.0.0.1:3080'
const res = await fetch(BASE + '/memory-steward/api/selfcheck')
const body = await res.json()
if (process.argv.includes('--json')) { console.log(JSON.stringify(body, null, 2)) }
else {
  for (const c of body.checks || []) console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + ' — ' + c.detail)
  const bad = (body.checks || []).filter((c) => !c.ok).length
  console.log(bad ? '\n' + bad + ' 项 FAIL：按上面 detail 定位（见 TESTING.md §0 对照表）' : '\n全部 PASS')
}
process.exitCode = (body.checks || []).some((c) => !c.ok) ? 1 : 0
