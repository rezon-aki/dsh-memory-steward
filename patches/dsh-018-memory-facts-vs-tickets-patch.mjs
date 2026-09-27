#!/usr/bin/env node
// @applies-to *  @idempotent true  @owner local
/**
 * dsh-018-memory-facts-vs-tickets-patch.mjs
 *
 * 给 dsh-memory-evolve 补上「记忆轨只装事实」这条契约。
 *
 * 解决什么问题：上游从未写明「整理动作不是事实」，于是「把 A/B/C 合并成一条」「归档某条」
 * 「清运归档」会被当成一条**事实**写进 MEMORY.md，形成永久回执——本机实测 48 条全局记忆里
 * 有 10 条是这种回执（已全部删除）。两个来源：
 *
 *   1. lib/i18n.js 的 snap.reviewStep / snap.dueWarning 是**每轮常驻**下发的收尾指令，
 *      它给全局轨只开了一个出口：memory_suggest（语义＝新增事实）。模型在审查里发现
 *      「这三条该合并」时手里没有操作出口，只能把动作描述成事实塞进建议队列，用户一确认
 *      就永久落进记忆。
 *   2. skills/memory-consolidate/SKILL.md 的硬边界写「只走 memory 工具 replace/archive/add」
 *      ——它是「一轮系统性整合」的入口技能，却把整理定义为直接改记忆，没有工单语义。
 *
 * 本补丁只改文案（不改任何代码逻辑）：
 *   - i18n 四处（reviewStep / dueWarning 各中英一份）补上「整理动作不是事实、不得写成记忆条目」，
 *     并指出有整理插件时走它的提案工具 memory_propose；
 *   - consolidate 技能补一条「成批整理走提案队列」的边界。
 *
 * 幂等：i18n/SKILL 里已含 memory_propose 即视为已打过，整份跳过。
 * 可撤：纯文本替换；dsh plugin --profile <p> update <包名> 重装该插件即还原。
 * 副本：canonical 在本仓 patches/（对外分发）；本机升级流程的 patches/ 目录另存一份，按 @applies-to 自动重挂。
 * 用法：
 *   node dsh-018-memory-facts-vs-tickets-patch.mjs                  # 默认 web profile
 *   node dsh-018-memory-facts-vs-tickets-patch.mjs web-test         # 指定 profile
 *   node dsh-018-memory-facts-vs-tickets-patch.mjs --root=<包目录>   # 影子/临时副本自测
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const rootArg = process.argv.find((a) => a.startsWith('--root='))
// DSH_HOME 优先：影子流程（dsh-upgrade.sh shadow）用独立 home 验证时，补丁必须打在影子的
// 那份插件副本上，而不是真实 ~/.dsh。
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const pkgRoot = rootArg
  ? rootArg.slice('--root='.length)
  : join(DSH_HOME, 'profiles', process.argv[2] ?? 'web', 'node_modules', 'dsh-memory-evolve')

const ZH = '**整理动作——合并/归档/删除/清运——不是事实，不得写成记忆条目**'
const EN = '**consolidation actions — merge/archive/delete/purge — are not facts and must never be written as a memory entry**'

const targets = [
  {
    file: 'lib/i18n.js',
    from: '（全局记忆用 memory_suggest 提建议 / mode=auto 直接写 memory，技能用 skill_manage 创建/优化）',
    to: '（全局记忆用 memory_suggest 提建议 / mode=auto 直接写 memory，技能用 skill_manage 创建/优化；' + ZH + '：本机装了记忆整理插件时用它的提案工具 memory_propose 交工单）',
  },
  {
    file: 'lib/i18n.js',
    from: '(global memory via memory_suggest suggestions / direct memory writes in mode=auto; skills via skill_manage create/patch)',
    to: '(global memory via memory_suggest suggestions / direct memory writes in mode=auto; skills via skill_manage create/patch; ' + EN + ': when a consolidation plugin is installed submit them through its proposal tool memory_propose)',
  },
  {
    file: 'lib/i18n.js',
    from: '技能用 skill_manage 创建/优化；完成后调用 memory_review_status（action=complete）复位。',
    to: '技能用 skill_manage 创建/优化；整理动作（合并/归档/删除/清运）不是事实，不得写成记忆条目——装了记忆整理插件就走 memory_propose 交工单。完成后调用 memory_review_status（action=complete）复位。',
  },
  {
    file: 'lib/i18n.js',
    from: 'skills via skill_manage create/patch; then call memory_review_status (action=complete) to reset.',
    to: 'skills via skill_manage create/patch; consolidation actions (merge/archive/delete/purge) are not facts and must never be written as a memory entry — submit them through memory_propose when a consolidation plugin is installed; then call memory_review_status (action=complete) to reset.',
  },
  {
    file: 'skills/memory-consolidate/SKILL.md',
    from: '3. **只走 memory 工具**：所有写入用 memory 工具的',
    to: '3. **事实与工单分开**：零散单条改写走 memory 工具的',
  },
  {
    file: 'skills/memory-consolidate/SKILL.md',
    from: '完成。**禁止直接编辑记忆 .md 文件**',
    to: '完成。**一轮成批整理（多条合并/归档/清运）走记忆整理插件的 `memory_propose` 提案队列**，等人在面板采纳后再执行——整理工单本身不要写成记忆条目。**禁止直接编辑记忆 .md 文件**',
  },
]

let changedFiles = 0
let changedTotal = 0
// 按文件分组：每个文件只判一次幂等标记，再逐条替换（同文件多处改动一次性写回）
for (const file of [...new Set(targets.map((t) => t.file))]) {
  const path = join(pkgRoot, file)
  if (!existsSync(path)) {
    console.warn('skip ' + file + ': 文件不存在')
    continue
  }
  const src = readFileSync(path, 'utf8')
  if (src.includes('memory_propose')) {
    console.log('skip ' + file + ': 已含 memory_propose（补丁已打过或上游已自行修复）')
    continue
  }
  let out = src
  let hits = 0
  for (const target of targets.filter((t) => t.file === file)) {
    const n = out.split(target.from).length - 1
    if (n === 0) {
      console.warn('  · ' + file + ': 无匹配文本，已跳过（上游可能改过这句，请人工核对）：' + target.from.slice(0, 44))
      continue
    }
    out = out.replace(target.from, target.to)
    hits += n
  }
  if (!hits) continue
  writeFileSync(path, out)
  changedFiles += 1
  changedTotal += hits
  console.log('patched ' + file + '（' + hits + ' 处）')
}

console.log(changedFiles === 0
  ? 'dsh-018-memory-facts-vs-tickets: 无需打补丁（契约已在）'
  : 'dsh-018-memory-facts-vs-tickets: 已打补丁 ' + changedFiles + ' 个文件 / ' + changedTotal + ' 处')
