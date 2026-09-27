# dsh-memory-steward

[中文](README.md) · English

> The missing **second half** of [dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve):
> budget watchdog → consolidation-due nudge → the model drafts a plan → you approve it in a Tab → execution with backups.

<p>
  <img src="https://badgen.net/badge/license/MIT/green" alt="MIT license" />
  <img src="https://badgen.net/badge/format/DSH%20bundle/8257D0" alt="DSH bundle" />
  <img src="https://badgen.net/badge/tests/33%20passed/green" alt="tests" />
</p>

**Prerequisite**: this plugin is a **governance companion** to memory-evolve and is useless on its own — every write goes
through its official HTTP API, so the upstream plugin stays the single writer and the memory store stays its own.
Zero code coupling: it relies on 4 official routes (`memory/delete|update|archive`, `memory-files`) and 6 memory file paths.

## What it solves

Upstream does the **ingest** half of memory very well (five tracks · review · skills · merge rules), but nobody looks after what comes after:

| Problem you hit | What the steward does |
|---|---|
| Memory silently grows past budget and nobody tells you | Counts/bytes for all three tracks against a budget (fixed thresholds, or baseline × ratio after you capture one); **only speaks when over budget**, injecting one line into systemPrompt |
| "Should I consolidate now?" depends on you remembering | Over budget **or** archive over the cap, plus enough days since the last pass, plus no pending proposals → the nudge also spells out how to run this pass (light mode starts with the archive pre-screen to save tokens) |
| Consolidation plans live and die inside one conversation | `memory_propose` turns them into a **pending queue**: red-dot count, select/select-all/invert, batch approve, reject, restore |
| A bad edit is unrecoverable | The 6 memory files are backed up in full before every execution; a failed run can resume (already-succeeded ops are never replayed) |
| Proposal bodies and execution echoes bloat the queue file | Three-layer governance: the queue keeps pending + the most recent N resolved items; bodies live only in the queue and `backups/`; a separate append-only event log holds one ≈200 B line per item with summary and failure reason, never a body |

**Measured** (13 items on this machine): `proposals.json` **147,788 → 13,855 B**; the list endpoint polled every 15 s **138,849 → 5,934 B**.

## What it looks like

![Consolidation approval tab](docs/images/steward-tab.png)

One tab holds: inventory and budget (three tracks vs budget) · auto-approve and budget baseline · trigger and consolidation parameters ·
history retention (last N / M days / slim resolved bodies) · consolidation cost audit (≈tokens per round) · pending and history lists.

## Install

```bash
# 1. install the companion plugin first (the store and the single writer)
dsh plugin --profile web add github:csyangwen/dsh-memory-evolve

# 2. then the steward
dsh plugin --profile web add github:rezon-aki/dsh-memory-steward
# once published to npm: dsh plugin --profile web add dsh-memory-steward
```

Restart `dsh web` to take effect (the bundle manifest registers `cordis.patch.yml` automatically — do **not** insert the same id by hand).
A "consolidation approval" tab appears in the conversation view; the title carries a 🔴 count while proposals are pending.

## Companion patch: keep consolidation actions out of memory

Two upstream spots let a **consolidation intent** become a **memory entry** (a receipt) that permanently eats injection budget —
on this machine 10 of 48 global memory entries were such receipts. The patch `patches/dsh-018-memory-facts-vs-tickets-patch.mjs` adds the missing rule:

| Location | Today | After the patch |
|---|---|---|
| `snap.reviewStep` / `snap.dueWarning` in `lib/i18n.js` (sent **every turn**) | The global track has exactly one outlet, `memory_suggest` (semantics: a new fact). Noticing "these three should be merged" has no operational outlet, so the model describes the action as a fact, and your confirmation makes it permanent | Adds an explicit rule: **consolidation actions (merge/archive/delete/purge) are not facts and must never be written as a memory entry**; when a consolidation plugin is installed, submit them through its proposal tool `memory_propose` |
| The hard boundary in `skills/memory-consolidate/SKILL.md` | "Writes go only through the memory tool (`replace`/`archive`/`add`)" — it is the entry skill for a full consolidation pass, yet it defines consolidation as direct memory edits | Rewritten as "facts and tickets are separate": single edits go direct, **batch consolidation goes through the proposal queue**, and the ticket itself is never written as an entry |

**Boundaries**: text only, no logic changes; idempotent (a file already containing `memory_propose` is skipped whole); plain text replacement, so
`dsh plugin --profile web update dsh-memory-evolve` restores the original. **An upstream/core upgrade overwrites it — re-apply after upgrading.**
On this machine the patch also lives in the upgrade flow's `patches/` directory, where it is re-mounted automatically via its `@applies-to` declaration.

Apply it yourself (human):

```bash
git clone https://github.com/rezon-aki/dsh-memory-steward && cd dsh-memory-steward
node patches/dsh-018-memory-facts-vs-tickets-patch.mjs             # default web profile
node patches/dsh-018-memory-facts-vs-tickets-patch.mjs web-test    # a specific profile
node patches/dsh-018-memory-facts-vs-tickets-patch.mjs --root=<dsh-memory-evolve package dir>   # shadow/temp copy
```

Expected output: `已打补丁 2 个文件 / 6 处`. Running it again should print `无需打补丁（契约已在）`. Restart `dsh web` afterwards.

Let an agent apply it — hand it this verbatim:

> Apply the "facts vs tickets" patch to dsh-memory-evolve on this machine: ① run `grep -c memory_propose ~/.dsh/profiles/web/node_modules/dsh-memory-evolve/lib/i18n.js` — if it is non-zero the patch is already applied, stop; ② fetch `patches/dsh-018-memory-facts-vs-tickets-patch.mjs` from https://github.com/rezon-aki/dsh-memory-steward; ③ run `node dsh-018-memory-facts-vs-tickets-patch.mjs` (append a profile name for a non-default profile; set `DSH_HOME=<shadow dir>` in a shadow environment); ④ check that the output is "已打补丁 2 个文件 / 6 处" or "无需打补丁", and grep `lib/i18n.js` for 「不是事实」; ⑤ restart `dsh web`. The patch only rewrites text; if it reports a missing pattern upstream has reworded that line — do not force a replacement.

## What is in the tab

- **Inventory and budget**: counts/bytes per track vs budget, oldest entry, due state (over budget / archive over cap / days since last pass)
- **Pending list**: select, select-all/invert, batch approve/reject; "▸ view details" **fetches bodies on demand** (original entry → rewritten entry)
- **History**: retention policy plus pruned/slimmed counters, delete one record, clear history, trim the event log (keep 7 days / clear, both confirmed)
- **Consolidation cost**: ≈tokens for the last N rounds (audit input + proposal output), red when over target
- **Settings**: auto check / inject nudge / light mode / sweep interval / archive cap / budget ratio / audit rounds / history retention (count · days · slimming) / auto approve

## The three tools

| Tool | Purpose |
|---|---|
| `memory_audit` | Inventory/budget/candidate clusters/archive pre-screen/per-track listing. `deep` runs the upstream scanner; `archiveCheck` pre-screens the archive (three buckets: likely ingested / archive-only / undecided, cheapest); `track:'all'` pulls everything |
| `memory_propose` | Submit proposals (single or a `proposals` array, ≤20): `archive` / `remove` / `replace` / `purge`. `match` only needs to be a unique substring — the host resolves it into the full entry, **and resolves it again at execution time** (so a rewrite during approval still lines up); one failing op no longer aborts the whole proposal |
| `memory_sweep_status` | Due check (`check`) and timer reset (`complete`) |

## Safety boundaries

- **Never writes memory files directly**: all writes go through the official memory-evolve HTTP API (with an `origin` header); it remains the single writer.
- **Execution lock**: one proposal runs at a time — concurrent or duplicate submissions are rejected (a double-clicked batch button once produced "succeeded but marked failed").
- **Validation at proposal time**: `replace` bodies cannot be empty and cannot contain the entry delimiter `§` (blowing up at approval time is too late).
- **One-command self-check**: `node scripts/selfcheck.mjs` → skill sync / state dir writable / client bundle composition / upstream write contract / upstream liveness / tool registration / queue readable, each PASS–FAIL. **It reports FAIL when upstream is missing instead of failing silently.**

## Cost

The plugin itself **never calls an LLM** — the model in the session does the judging. One consolidation round costs the audit listing (input) plus the proposal bodies (output),
estimated at characters ÷ 2. A normal round targets **≤2K tokens** (a merge `replace` must carry both the old and the new body, so a large restructuring at 10K+ is normal).
`/api/rounds` and the tab's cost card use the same measure.

## Configuration

Edited in the tab, persisted to `<memoryDir>/steward/config.json` (default `~/.dsh/memories/steward/config.json`):

| Key | Default | Meaning |
|---|---|---|
| `autoCheck` | true | Automatic checks: every 12 h plus an inventory refresh at turn end |
| `nudge` | true | Inject one line into systemPrompt when over budget / due |
| `lightMode` | true | Prefer `archiveCheck` + `deep` in the nudge; pull everything only when there are many candidates |
| `sweepIntervalDays` | 7 | Days since the last pass before nudging again |
| `archiveMaxEntries` | 30 | Archive-track entry cap (exceeding it also counts as "time for a pass") |
| `budgetRatio` | 1.5 | With a baseline: budget = max(fixed threshold, ⌈baseline × ratio⌉) |
| `roundKeep` | 10 | Rolling rounds kept in the cost audit |
| `historyKeep` | 20 | Keep the most recent N resolved queue items |
| `historyKeepDays` | 30 | A resolved item must also be older than M days to be pruned/slimmed (AND with N) |
| `historySlim` | true | Slim resolved bodies (with a backup, the body stays only in `backups/`) |
| `autoApprove` | off | `off` / `deterministic` (auto-apply deterministic archives only) / `all` |
| `baseline` | null | Budget baseline snapshot; once set, the budget uses baseline × ratio instead of fixed thresholds |

**Fully manual mode** = `autoCheck:false` + `nudge:false` (one click in the tab): from then on only tool/API calls refresh state and produce proposals.

## HTTP API

On the same webServer, fenced by Host/Origin (cross-site requests get 403):

| Route | Meaning |
|---|---|
| `GET /api/status` | Inventory, budget, due state, history stats, skill sync state, client bundle path |
| `GET /api/proposals` | **Lightweight list** (no ops/results bodies); `GET /api/proposals/:id` fetches full ops on demand |
| `POST /api/proposals/{approve,reject,restore,purge}` | Approval actions (purge with empty ids clears history, pending items survive) |
| `POST /api/propose` / `POST /api/scan` | External proposal submission / deterministic duplicate scan |
| `POST /api/config` / `POST /api/baseline` | Change settings / set or clear the budget baseline |
| `GET /api/rounds` | Consolidation cost audit |
| `GET /api/selfcheck` | Self-check (same as `scripts/selfcheck.mjs`) |
| `POST /api/history/clear` | Event log: `{days:N}` removes lines older than N days, `{all:true}` clears the file (log only) |

## Development

**No build step**: `lib/index.js` (host, ESM) and `lib/client.js` (client, CJS wrapped in `window.__ModuleLoader__.load`) are the sources.

```bash
npm test                     # 33 cases, node --test, zero dependencies (Node ≥ 20)
node scripts/selfcheck.mjs   # item-by-item self-check against a running instance (--json for raw)
node scripts/fixture.mjs seed|status|clear   # browser acceptance fixtures (rewritten verbatim, semantics unchanged)
```

Tests use three building blocks: a fake ctx (captures registered tools/routes/prompts), a temporary memory store, and one local service playing both the steward API and the memory-evolve API;
client tests render `lib/client.js` as a browser bundle through a mini React and assert that "expanding details really does fetch on demand".

- Design doc: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Human/agent acceptance checklist: [TESTING.md](TESTING.md)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## License

MIT. The companion plugin [dsh-memory-evolve](https://github.com/csyangwen/dsh-memory-evolve) is MIT as well.
