import { expect, mock, test } from 'claude-code/testing'

import type { GpsAgent, Holds } from '../types'
import { type GpsEvent, replay, spawnedIn } from './events'
import { applyCompact, applyEdit, applyGrepHits, applyRead, countPatch, level, shiftRanges, stripParts } from './knowledge'
import { makeRepo, pathsIn, pathsInCommand, relative } from './paths'

const ROOT = '/repo'
const repo = makeRepo(ROOT, [
  { path: 'source/core/Ky.ts' },
  { path: 'source/types/hooks.ts' },
  { path: 'source/types/retry.ts' },
  { path: 'source/utils/delay.ts' },
  { path: 'test/retry.ts' },
  { path: 'readme.md' },
])

test('paths resolve against the root and the shell cwd', async () => {
  expect(relative(repo, '/repo/source/core/Ky.ts')).toBe('source/core/Ky.ts')
  expect(relative(repo, '/elsewhere/x.ts')).toBe(null)
  expect(relative(repo, '../utils/delay.ts', 'source/types')).toBe('source/utils/delay.ts')
  expect(relative(repo, './hooks.ts', 'source/types')).toBe('source/types/hooks.ts')
})

test('a command that cds and globs names the files it reads', async () => {
  const { paths, cwd } = pathsInCommand(repo, 'cd /repo/source/types && wc -l * && for f in hooks.ts retry.ts; do cat "$f"; done')
  expect(cwd).toBe('source/types')
  expect(paths.sort()).toEqual(['source/types/hooks.ts', 'source/types/retry.ts'])
})

test('globs, ** and grep-style output', async () => {
  expect(pathsInCommand(repo, 'cat source/**/*.ts').paths.length).toBe(4)
  expect(pathsIn(repo, 'source/core/Ky.ts:553:  const jitter\ntest/retry.ts:12: x')).toEqual(['source/core/Ky.ts', 'test/retry.ts'])
  expect(pathsIn(repo, 'hooks.ts\nretry.ts', 'source/types').length).toBe(2)
})

test('output names a file only where a path starts the line', async () => {
  // wc counts, ls -l rows and grep -l names count; a README that mentions a file does not.
  expect(pathsIn(repo, '  120 readme.md\n   88 test/retry.ts\n  208 total')).toEqual(['readme.md', 'test/retry.ts'])
  expect(pathsIn(repo, '-rw-r--r--  1 me  staff  812 Oct  6 12:00 readme.md')).toEqual(['readme.md'])
  expect(pathsIn(repo, '# Ky\n![logo](source/core/Ky.ts)\nSee test/retry.ts for retries.')).toEqual([])
})

test('counting and searching commands name hits, not reads', async () => {
  const { paths, searched } = pathsInCommand(repo, 'cd /repo && wc -l source/types/*.ts; grep -rl Ky source/core/Ky.ts | head -3; cat readme.md')
  expect(paths).toEqual(['readme.md'])
  expect(searched.sort()).toEqual(['source/core/Ky.ts', 'source/types/hooks.ts', 'source/types/retry.ts'])
})

test('listing commands and directory globs are not reads', async () => {
  expect(pathsInCommand(repo, 'ls -d */ | grep -i src; find . -maxdepth 2 -name "*.ts"').paths).toEqual([])
  expect(pathsInCommand(repo, 'cd /repo; cat source/core/Ky.ts; echo =====; cat readme.md').paths).toEqual(['source/core/Ky.ts', 'readme.md'])
})

const agents: GpsAgent[] = [
  { id: 'main', tag: 'main', label: 'main', parent: null, spawnedAt: 0, doneAt: null, now: null, nowAt: 0 },
  { id: 'ex1', tag: 'ex1', label: 'Explore utils', parent: 'main', spawnedAt: 1, doneAt: 5, now: null, nowAt: 0 },
  { id: 'ex2', tag: 'ex2', label: 'nested', parent: 'ex1', spawnedAt: 2, doneAt: 4, now: null, nowAt: 0 },
]
const KY = 'source/core/Ky.ts'
const DELAY = 'source/utils/delay.ts'

test('partial reads merge into ranges, and full coverage is a full read', async () => {
  let h: Holds = {}
  h = applyRead(h, 'main', KY, [1, 120], 100, 10)
  expect(level(h, agents, 'main', KY, 347)).toBe('P')
  h = applyRead(h, 'main', KY, [100, 200], 100, 11)
  expect(h.main![KY]!.ranges).toEqual([[1, 200]])
  expect(h.main![KY]!.rereads).toBe(1)
  h = applyRead(h, 'main', KY, [201, 347], 100, 12)
  expect(level(h, agents, 'main', KY, 347)).toBe('V')
  expect(h.main![KY]!.tokens).toBe(300)
})

test("another agent's edit makes a held copy stale, and a fresh read cures it", async () => {
  let h: Holds = {}
  h = applyRead(h, 'ex1', DELAY, [1, 20], 50, 1)
  h = applyRead(h, 'main', DELAY, [1, 20], 50, 2)
  h = applyEdit(h, 'main', DELAY, { added: 6, removed: 2 }, 3)
  expect(level(h, agents, 'ex1', DELAY, 24)).toBe('T')
  expect(h.ex1![DELAY]!.stale?.by).toBe('main')
  // The editor's own copy is current.
  expect(level(h, agents, 'main', DELAY, 24)).toBe('P')
  expect(h.main![DELAY]!.added).toBe(6)
  h = applyRead(h, 'ex1', DELAY, [1, 24], 50, 4)
  expect(level(h, agents, 'ex1', DELAY, 24)).toBe('V')
  // A read after an edit is a fresh copy, not a re-read.
  expect(h.ex1![DELAY]!.rereads).toBe(0)
})

test('secondhand means a spawned subagent, at any depth, holds lines', async () => {
  let h: Holds = {}
  h = applyRead(h, 'ex2', DELAY, [1, 20], 50, 1)
  expect(level(h, agents, 'main', DELAY, 20)).toBe('S')
  expect(level(h, agents, 'ex1', DELAY, 20)).toBe('S')
  // A parent's reads are not its child's.
  h = applyRead(h, 'main', KY, [1, 10], 10, 2)
  expect(level(h, agents, 'ex1', KY, 347)).toBe(null)
})

test('grep hits and compaction', async () => {
  let h: Holds = {}
  h = applyGrepHits(h, 'main', [KY, DELAY], 40, 1)
  expect(level(h, agents, 'main', KY, undefined)).toBe('G')
  h = applyRead(h, 'main', DELAY, [1, 20], 50, 2)
  h = applyCompact(h, 'main')
  expect(level(h, agents, 'main', DELAY, 20)).toBe('X')
  expect(h.main![DELAY]!.tokens).toBe(0)
})

test('a shell read holds unknown lines; a patch counts its lines', async () => {
  let h: Holds = {}
  h = applyRead(h, 'main', KY, null, 80, 1)
  expect(level(h, agents, 'main', KY, 347)).toBe('P')
  expect(countPatch([{ lines: [' a', '-b', '+c', '+d'] }])).toEqual({ added: 2, removed: 1 })
})

test("an agent's own edit moves its ranges and keeps a full read full", async () => {
  let h: Holds = {}
  h = applyRead(h, 'main', DELAY, [1, 408], 900, 1)
  // One line inserted at the top: the hunk covers it plus three lines of context.
  h = applyEdit(h, 'main', DELAY, { added: 1, removed: 0 }, 2, undefined, [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 }])
  expect(h.main![DELAY]!.ranges).toEqual([[1, 409]])
  expect(level(h, agents, 'main', DELAY, 409)).toBe('V')
  // A range below a hunk moves; one above it stays.
  expect(shiftRanges([[1, 10], [50, 60]], [{ oldStart: 20, oldLines: 5, newStart: 20, newLines: 2 }])).toEqual([[1, 10], [20, 21], [47, 57]])
})

const PANE_PROPS = {
  title: 'Coverage',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

test('the pane draws the grid, and a clicked file shows what each agent knows', async ($, on) => {
  mock.clock(on)
  const logged: string[] = []
  on('ui.log', async (_$, e) => (logged.push(JSON.stringify(e)), { value: undefined }))
  // The engine's Read, beneath the plugin: lines 1–120 of a 347-line file.
  on('tool.call', { tool: 'Read' }, async () => ({
    result: { type: 'text', file: { filePath: '/' + KY, content: 'x\n'.repeat(120), numLines: 120, startLine: 1, totalLines: 347 } },
    text: 'x\n'.repeat(120),
  }))
  await $.tool.call({ tool: 'Read', file_path: '/' + KY, offset: 1, limit: 120 })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'slash-coverage', surface, component: 'Pane', requestId: 'coverage', props: PANE_PROPS })
    expect(logged).toEqual([])
    expect(await ui.find({ type: 'Text', text: /1–120/ })).toBeDefined()
    await ui.press({ key: 'sel:' + KY })
    expect(await ui.find({ type: 'Text', text: /lines 1–120/ })).toBeDefined()
    await ui.press({ key: 'pick:all' })
    expect(await ui.find({ type: 'Text', text: /team holds/ })).toBeDefined()
    await ui.press({ key: 'sel:' + KY })
    await ui.press({ key: 'pick:main' })
    await ui.unmount()
  }
})

test('a folder strip packs short runs and counts long ones, strongest first', async () => {
  const parts = stripParts(['S', 'V', 'S', 'S', 'G', 'S', 'P', 'V'])
  expect(parts.map(p => [p.lvl, p.n, p.isCounted])).toEqual([
    ['V', 2, false],
    ['P', 1, false],
    ['S', 4, true],
    ['G', 1, false],
  ])
})

test('replaying snapshots in time order rebuilds what happened across agents', async () => {
  const mainLog: GpsEvent[] = [
    { k: 'spawn', t: 1, a: 'main', id: 'x1', type: 'Explore', label: 'Explore utils' },
    { k: 'read', t: 3, a: 'main', p: DELAY, r: [1, 20], tok: 50, n: 20 },
    { k: 'edit', t: 5, a: 'main', p: DELAY, add: 1, del: 0, hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 }] },
  ]
  const subLog: GpsEvent[] = [
    { k: 'read', t: 2, a: 'x1', p: DELAY, r: [1, 20], tok: 50, n: 20 },
    { k: 'done', t: 6, a: 'x1' },
  ]
  expect(spawnedIn(mainLog)).toEqual(['x1'])
  const s = replay([mainLog, subLog])
  // The subagent read before main's edit, so its copy is stale, though its log never says so.
  expect(level(s.holds, s.agents, 'x1', DELAY, s.lines[DELAY])).toBe('T')
  expect(level(s.holds, s.agents, 'main', DELAY, s.lines[DELAY])).toBe('V')
  expect(s.lines[DELAY]).toBe(21)
  expect(s.agents.find(a => a.id === 'x1')).toMatchObject({ tag: 'ex1', parent: 'main', doneAt: 6 })
})

test('a resumed chat restores from its snapshots by following spawns', async ($, on) => {
  mock.clock(on)
  const files = new Map<string, string>()
  on('classic.SessionStart', async () => ({}))
  on('fs.write', async (_$, e) => (files.set(e.path, e.text), { value: undefined }))
  on('fs.read', async (_$, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: 'missing' }))
  on('tool.call', { tool: 'Read' }, async () => ({
    result: { type: 'text', file: { filePath: '/' + KY, content: 'x', numLines: 120, startLine: 1, totalLines: 347 } },
    text: 'x',
  }))
  await $.classic.SessionStart({ source: 'startup', transcript_path: '/chats/abc.jsonl' })
  await $.tool.call({ tool: 'Read', file_path: '/' + KY, offset: 1, limit: 120 })
  expect([...files.keys()]).toEqual(['/chats/abc/slash-coverage/main.json'])
  // A subagent's snapshot that main's log points at.
  const main = JSON.parse(files.get('/chats/abc/slash-coverage/main.json')!)
  main.events.push({ k: 'spawn', t: main.events[0].t + 1, a: 'main', id: 'x1', type: 'Explore', label: 'utils' })
  files.set('/chats/abc/slash-coverage/main.json', JSON.stringify(main))
  files.set('/chats/abc/slash-coverage/x1.json', JSON.stringify({ version: 1, agent: 'x1', events: [{ k: 'read', t: main.events[0].t + 2, a: 'x1', p: DELAY, r: [1, 20], tok: 9, n: 20 }] }))
  await $.classic.SessionStart({ source: 'resume', transcript_path: '/chats/abc.jsonl' })
  const ui = await $.ui.mount({ plugin: 'slash-coverage', surface: 'terminal', component: 'Pane', requestId: 'coverage', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /1–120/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /via ex1/ })).toBeDefined()
  await ui.unmount()
})

test('the picker scrolls through many agents, and one left out drops from all', async ($, on) => {
  mock.clock(on)
  const files = new Map<string, string>()
  on('classic.SessionStart', async () => ({}))
  on('fs.write', async (_$, e) => (files.set(e.path, e.text), { value: undefined }))
  on('fs.read', async (_$, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: 'missing' }))
  // Main spawned twelve Explore agents; each read a file of its own.
  const ids = Array.from({ length: 12 }, (_, i) => `s${i}`)
  const dir = '/chats/many/slash-coverage'
  files.set(`${dir}/main.json`, JSON.stringify({ version: 1, agent: 'main', events: ids.map((id, i) => ({ k: 'spawn', t: i + 1, a: 'main', id, type: 'Explore', label: 'job ' + i })) }))
  ids.forEach((id, i) =>
    files.set(`${dir}/${id}.json`, JSON.stringify({ version: 1, agent: id, events: [{ k: 'read', t: 100 + i, a: id, p: `src/f${i}.ts`, r: [1, 10], tok: 5, n: 10 }] })),
  )
  await $.classic.SessionStart({ source: 'resume', transcript_path: '/chats/many.jsonl' })
  const ui = await $.ui.mount({ plugin: 'slash-coverage', surface: 'terminal', component: 'Pane', requestId: 'coverage', props: { ...PANE_PROPS, bodyColumns: 70 } })
  // Not all twelve fit: the row ends in a count of the hidden ones.
  expect(await ui.find({ key: 'pick:s11' })).toBeUndefined()
  expect((await ui.find({ key: 'pick:next' }))?.text).toMatch(/\d+ ›/)
  // Stepping right past the edge scrolls the row.
  for (let i = 0; i < 12; i++) await ui.press({ key: 'pick:next' })
  expect((await ui.find({ key: 'pick:s11' }))?.text).toBe('[ex12 ◆]')
  expect((await ui.find({ key: 'pick:prev' }))?.text).toMatch(/‹ \d+/)
  // In all, ex1's header leaves it out: its file goes, its column stays to bring it back.
  await ui.press({ key: 'pick:all' })
  await ui.press({ key: 'out:s0' })
  expect((await ui.find({ key: 'out:s0' }))?.text).toBe('⊘ex1')
  expect(await ui.find({ type: 'Text', text: /1 agent left out/ })).toBeDefined()
  expect(await ui.find({ key: 'sel:src/f0.ts' })).toBeUndefined()
  expect(await ui.find({ key: 'sel:src/f1.ts' })).toBeDefined()
  await ui.press({ key: 'out:s0' })
  expect(await ui.find({ key: 'sel:src/f0.ts' })).toBeDefined()
  await ui.unmount()
})
