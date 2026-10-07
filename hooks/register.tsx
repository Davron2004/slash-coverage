import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GpsAgent, Hold, Holds, Range } from '../types'
import {
  type Hunk,
  type Level,
  RANK,
  countPatch,
  covered,
  describeRanges,
  level,
  stripParts,
  tokensOf,
  via,
} from './knowledge'
import { type GpsEvent, type GpsState, MAIN, type Snapshot, applyEvent, parseSnapshot, replay, snapshotDir, spawnedIn } from './events'
import { type Checkout, type FileEntry, type Repo, absolute, checkoutOf, logical, makeRepo, pathsIn, shellEffects } from './paths'

type $ = EngineInterface

const PANE = 'coverage'
const TITLE = 'Coverage'
const MAX_FILES = 20_000
/** A search naming more files than this is a listing, not a lead: it marks nothing. */
const MAX_HITS = 30
/** An agent counts as working on a file for this long after touching it. */
const NOW_MS = 20_000

const holdsAtom = atom({ plugin: 'slash-coverage', key: 'holds' } as const, {} as Holds)
const linesAtom = atom({ plugin: 'slash-coverage', key: 'lines' } as const, {} as Record<string, number>)
const agentsAtom = atom({ plugin: 'slash-coverage', key: 'agents' } as const, [] as GpsAgent[])
const pickAtom = atom({ plugin: 'slash-coverage', key: 'pick' } as const, 'auto')
const anchorAtom = atom({ plugin: 'slash-coverage', key: 'anchor' } as const, null as string | null)
const closedAtom = atom({ plugin: 'slash-coverage', key: 'closed' } as const, [] as string[])
const excludedAtom = atom({ plugin: 'slash-coverage', key: 'excluded' } as const, [] as string[])
const selectedAtom = atom({ plugin: 'slash-coverage', key: 'selected' } as const, null as string | null)
const outsideAtom = atom({ plugin: 'slash-coverage', key: 'outside' } as const, 0)
const indexAtom = atom({ plugin: 'slash-coverage', key: 'indexVersion' } as const, 0)
const snapshotDirAtom = atom({ plugin: 'slash-coverage', key: 'snapshotDir' } as const, null as string | null)

// ── Colors ──────────────────────────────────────────────────────────────────
const LEVEL_COLOR: Record<Level, string> = { V: '#eef1f6', P: '#a9b3c2', T: '#f0a35e', S: '#b294f5', G: '#6c7487', X: '#e06c75' }
const GLYPH: Record<Level, string> = { V: '●', P: '◉', T: '●', S: '◌', G: '○', X: '✕' }
const LEVEL_NAME: Record<Level, string> = { V: 'full', P: 'partial', T: 'stale', S: 'secondhand', G: 'grep hit', X: 'compacted' }
const EDIT = '#ff9e64'
const NOW = '#e5c07b'
const OK = '#8fd18f'
const ADD = '#8fd18f'
const DEL = '#e06c75'
const FAINT = '#3a404c'
const HOVER = '#2a2f39'
const AGENT_HUES = ['#7aa2f7', '#73d0a0', '#e7a0d0', '#7fd4e6', '#e5c07b', '#c3a6ff', '#f78c6c', '#a3e635', '#2dd4bf', '#f472b6']

// ── The repo index (module memory: rebuilt cheaply after a reload) ──────────
let repo: Repo = makeRepo('', [])
/** Where the session runs: an agent's shell starts here. */
let sessionCwd = ''
/** Each agent's shell cwd after its last command, absolute. */
let cwds = new Map<string, string>()
/** Settles once the index is built; tool calls that arrive sooner (right after a reload) wait for it. */
let indexed: Promise<void> = Promise.resolve()
/** Each folder's files, nested ones included, and its direct children. */
let folders: { count: Map<string, number>; children: Map<string, Set<string>> } | null = null
/** mtimes of the files git reports changed, by absolute path, to tell a fresh edit from an old one. */
let changed = new Map<string, number>()
/** The git repos the index covers, relative to its root: [''] when the root is one. */
let gitRoots: string[] = []
/** Every checkout git runs in: each repo's own, and each of its worktrees. */
let gitCheckouts: Checkout[] = []
/** Checkouts whose git status has been taken: a later one tells what a command changed. */
let seen = new Set<string>()

/** Runs git in the repo root, or in a nested repo (`at`, relative to the root), or in a directory given absolute. */
async function git($: $, args: string[], at = '') {
  try {
    const cwd = at.startsWith('/') ? at : at ? repo.root + '/' + at : repo.root
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 15_000 })
    return r.exitCode === 0 ? r.stdout : null
  } catch {
    return null
  }
}

/** Each repo's worktrees, shown where the repo is: their files are its files. */
async function listCheckouts($: $): Promise<Checkout[]> {
  const out: Checkout[] = []
  for (const at of gitRoots) {
    const main = at ? repo.root + '/' + at : repo.root
    out.push({ dir: main, prefix: at })
    const list = (await git($, ['worktree', 'list', '--porcelain'], at)) ?? ''
    for (const line of list.split('\n')) {
      const dir = line.startsWith('worktree ') ? line.slice(9).trim() : ''
      if (dir && dir !== main) out.push({ dir, prefix: at })
    }
  }
  return out
}

/** Directories outside every checkout already looked at: each could be a worktree made since the index. */
let outsideSeen = new Set<string>()

/** Lists the worktrees again when a path lies outside every checkout and its directory is new. */
async function placeOutside($: $, paths: readonly string[]) {
  const fresh = paths.filter(p => !checkoutOf(repo, p)).map(p => p.slice(0, p.lastIndexOf('/')) || '/').filter(d => !outsideSeen.has(d))
  if (!fresh.length) return
  for (const d of fresh) outsideSeen.add(d)
  gitCheckouts = await listCheckouts($)
  repo = makeRepo(repo.root, repo.files, gitCheckouts, repo.home)
}

/** A repo's tracked files, plus untracked ones git doesn't ignore. */
async function trackedFiles($: $, at: string): Promise<FileEntry[]> {
  const prefix = at ? at + '/' : ''
  const tracked = (await git($, ['ls-files'], at)) ?? ''
  const extra = (await git($, ['ls-files', '--others', '--exclude-standard'], at)) ?? ''
  return [...tracked.split('\n').filter(Boolean), ...extra.split('\n').filter(Boolean).slice(0, 500)].map(path => ({ path: prefix + path }))
}

const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.expo', '.turbo', '.cache', 'coverage',
  'target', '.venv', 'venv', '__pycache__', 'Pods', 'DerivedData', 'vendor', '.gradle',
])

/** Repos one or two levels under a root that isn't one: a folder of projects. */
async function findGitRoots($: $): Promise<string[]> {
  const found: string[] = []
  const look = async (dir: string, depth: number) => {
    let entries
    try {
      entries = await $.fs.list(dir ? repo.root + '/' + dir : repo.root)
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.kind !== 'dir' || entry.isLink || SKIP.has(entry.name) || entry.name.startsWith('.')) continue
      const path = dir ? dir + '/' + entry.name : entry.name
      if (await $.fs.exists(repo.root + '/' + path + '/.git')) found.push(path)
      else if (depth < 2) await look(path, depth + 1)
    }
  }
  await look('', 1)
  return found
}

/** Files taken from any one folder that isn't a repo. */
const WALK_BUDGET = 150

async function walk($: $, dir: string, out: FileEntry[], repos: ReadonlySet<string>, budget = { left: WALK_BUDGET }) {
  if (out.length >= MAX_FILES || budget.left <= 0) return
  let entries
  try {
    entries = await $.fs.list(dir ? repo.root + '/' + dir : repo.root)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = dir ? dir + '/' + entry.name : entry.name
    if (repos.has(path)) continue
    const share = dir === '' ? { left: WALK_BUDGET } : budget
    if (entry.kind === 'dir' && !SKIP.has(entry.name) && !entry.isLink) await walk($, path, out, repos, share)
    else if (entry.kind === 'file' && share.left > 0) {
      out.push({ path })
      share.left--
    }
    if (out.length >= MAX_FILES || budget.left <= 0) return
  }
}

async function indexRepo($: $) {
  let root = await $.session.root()
  sessionCwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  repo = makeRepo(root, [], [], home)
  const top = await git($, ['rev-parse', '--show-toplevel'])
  const list: FileEntry[] = []
  if (top) {
    root = top.trim()
    repo = makeRepo(root, [], [], home)
    gitRoots = ['']
    list.push(...(await trackedFiles($, '')))
  } else {
    gitRoots = await findGitRoots($)
    for (const at of gitRoots) list.push(...(await trackedFiles($, at)))
    await walk($, '', list, new Set(gitRoots))
  }
  gitCheckouts = await listCheckouts($)
  repo = makeRepo(root, list.slice(0, MAX_FILES), gitCheckouts, home)
  folders = null
  outsideSeen = new Set()
  seen = new Set()
  changed = new Map()
  // Worktrees are looked at when an agent first works in one.
  await serial(() => snapshotChanges($, gitCheckouts.filter(c => c.dir === (c.prefix ? root + '/' + c.prefix : root))))
  await update($, indexAtom, v => v + 1)
}

/** Touched paths the git index lacks (ignored or past the cap), added to `folders` as they show up. */
let extraPaths = new Set<string>()

function addToFolders(f: NonNullable<typeof folders>, path: string) {
  const parts = path.split('/')
  for (let i = 0; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/')
    const self = parts.slice(0, i + 1).join('/')
    let kids = f.children.get(parent)
    if (!kids) f.children.set(parent, (kids = new Set()))
    kids.add(self)
    if (i < parts.length - 1) f.count.set(self, (f.count.get(self) ?? 0) + 1)
  }
}

/** Each folder's file count and direct children, from the index plus every touched path. */
function folderIndex(touched: Iterable<string>) {
  if (!folders) {
    folders = { count: new Map(), children: new Map() }
    extraPaths = new Set()
    for (const { path } of repo.files) addToFolders(folders, path)
  }
  for (const path of touched) {
    if (repo.byPath.has(path) || extraPaths.has(path)) continue
    extraPaths.add(path)
    addToFolders(folders, path)
  }
  return folders
}

/** Git checks run one at a time: parallel subagent calls must not see a half-built snapshot. */
let gitQueue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = gitQueue.then(fn, fn)
  gitQueue = run.catch(() => undefined)
  return run
}

/** The checkouts a command or edit could have changed: the ones holding its paths or the directories it worked in. */
function checkoutsFor(places: readonly string[]): Checkout[] {
  return gitCheckouts.filter(c => places.some(p => p === c.dir || p.startsWith(c.dir + '/')))
}

/** Re-reads git status in some checkouts; the snapshot is built aside and swapped in whole. */
async function snapshotChanges($: $, roots: readonly Checkout[]) {
  const inside = (path: string) => roots.some(c => path.startsWith(c.dir + '/'))
  const next = new Map([...changed].filter(([path]) => !inside(path)))
  for (const c of roots) {
    const status = await git($, ['status', '--porcelain', '--untracked-files=all'], c.dir)
    if (status === null) continue
    seen.add(c.dir)
    for (const line of status.split('\n')) {
      const rel = line.slice(3).split(' -> ').pop()?.trim().replace(/^"|"$/g, '')
      if (!rel) continue
      const path = c.dir + '/' + rel
      try {
        next.set(path, (await $.fs.stat(path)).mtimeMs)
      } catch {
        next.set(path, 0)
      }
    }
  }
  changed = next
}

/** Takes git status in checkouts not looked at yet, so their old changes don't read as this command's. */
function lookFirst($: $, roots: readonly Checkout[]) {
  const fresh = roots.filter(c => !seen.has(c.dir))
  return fresh.length ? serial(() => snapshotChanges($, fresh)) : Promise.resolve()
}

/** Files git now reports changed whose mtime moved since the last look, absolute: edits by any tool, shell included. */
function freshEdits($: $, roots: readonly Checkout[]): Promise<string[]> {
  if (roots.length === 0) return Promise.resolve([])
  return serial(async () => {
    const before = changed
    await snapshotChanges($, roots)
    return [...changed].filter(([path, mtime]) => before.get(path) !== mtime).map(([path]) => path)
  })
}

async function ensureIndexed($: $, path: string) {
  if (repo.byPath.has(path) || repo.files.length >= MAX_FILES) return
  repo.byPath.set(path, repo.files.length)
  repo.files.push({ path })
  folders = null
  await update($, indexAtom, v => v + 1)
}

// ── The event log, and its snapshot on disk ─────────────────────────────────
/** Each agent's events this session, by agent id: what its snapshot file holds. */
let logs = new Map<string, GpsEvent[]>()

/** Writes run one at a time, so parallel subagents never interleave a read-modify-write. */
let recordQueue: Promise<unknown> = Promise.resolve()

const fileFor = (agent: string) => `${agent === 'main' ? 'main' : agent}.json`

async function writeSnapshot($: $, agent: string) {
  const dir = await read($, snapshotDirAtom)
  if (!dir) return
  const snap: Snapshot = { version: 1, agent, events: logs.get(agent) ?? [] }
  try {
    await $.fs.write(`${dir}/${fileFor(agent)}`, JSON.stringify(snap))
  } catch (err) {
    $.ui.log(`could not save the snapshot: ${String((err as Error)?.message ?? err).slice(0, 80)}`)
  }
}

/** Records what an agent did: into its log, onto the grid, and into its snapshot. */
function record($: $, events: readonly GpsEvent[]): Promise<void> {
  if (events.length === 0) return Promise.resolve()
  const run = recordQueue.then(async () => {
    for (const ev of events) logs.set(ev.a, [...(logs.get(ev.a) ?? []), ev])
    const before: GpsState = { holds: await read($, holdsAtom), lines: await read($, linesAtom), agents: await read($, agentsAtom) }
    const after = events.reduce(applyEvent, before)
    if (after.holds !== before.holds) await update($, holdsAtom, () => after.holds)
    if (after.lines !== before.lines) await update($, linesAtom, () => after.lines)
    if (after.agents !== before.agents) await update($, agentsAtom, () => after.agents)
    for (const agent of new Set(events.map(ev => ev.a))) await writeSnapshot($, agent)
  })
  recordQueue = run.catch(() => undefined)
  return run
}

/** Rebuilds the grid from a chat's snapshots: main's, then every agent it (or they) spawned. */
async function restore($: $) {
  const dir = await read($, snapshotDirAtom)
  logs = new Map()
  if (dir) {
    const queue = ['main']
    while (queue.length) {
      const agent = queue.shift()!
      if (logs.has(agent)) continue
      let events: GpsEvent[] = []
      try {
        events = parseSnapshot(await $.fs.read(`${dir}/${fileFor(agent)}`))
      } catch {
        // No snapshot yet: a new chat, or an agent that never acted.
      }
      logs.set(agent, events)
      queue.push(...spawnedIn(events))
    }
  }
  const s = replay(logs.values())
  await update($, holdsAtom, () => s.holds)
  await update($, linesAtom, () => s.lines)
  await update($, agentsAtom, () => s.agents)
}

/** `<config>/projects/<project>/<session id>.jsonl`, looked up by the session's id. */
async function findTranscript($: $): Promise<string | null> {
  try {
    const id = await $.session.id()
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
    for (const project of await $.fs.list(`${config}/projects`)) {
      const path = `${config}/projects/${project.name}/${id}.jsonl`
      if (project.kind === 'dir' && (await $.fs.exists(path))) return path
    }
  } catch {
    // No config folder we can read: the grid just won't outlive the session.
  }
  return null
}

/** Forgets everything: the grid, and every snapshot file this chat wrote. */
async function reset($: $) {
  const agents = [...logs.keys()]
  logs = new Map()
  await update($, holdsAtom, () => ({}))
  await update($, linesAtom, () => ({}))
  await update($, agentsAtom, () => [])
  await update($, selectedAtom, () => null)
  await update($, pickAtom, () => 'auto')
  await update($, anchorAtom, () => null)
  await update($, outsideAtom, () => 0)
  for (const agent of agents) await writeSnapshot($, agent)
}

async function openPane($: $, focus: boolean) {
  return $.ui.open(focus ? { id: PANE, title: TITLE, focus: true } : { id: PANE, title: TITLE })
}

// ── Text helpers ────────────────────────────────────────────────────────────
type Seg = { t: string; c?: string; dim?: boolean; bold?: boolean }

const segLen = (segs: readonly Seg[]) => segs.reduce((n, s) => n + [...s.t].length, 0)

/** Segments cut or padded to exactly `width` cells. */
function fitSegs(segs: readonly Seg[], width: number, align: 'left' | 'right' = 'left'): Seg[] {
  const len = segLen(segs)
  if (len <= width) {
    const pad = { t: ' '.repeat(width - len) }
    return align === 'right' ? [pad, ...segs] : [...segs, pad]
  }
  const out: Seg[] = []
  let left = width - 1
  for (const s of segs) {
    const chars = [...s.t]
    if (chars.length <= left) {
      out.push(s)
      left -= chars.length
    } else {
      out.push({ ...s, t: chars.slice(0, left).join('') })
      break
    }
  }
  out.push({ t: '…', dim: true })
  return out
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

function tok(n: number): string {
  if (!n) return ''
  return n >= 1000 ? (n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(n)
}

// ── What a cell says ────────────────────────────────────────────────────────
type Cell = {
  lvl: Level
  held: Seg[]
  tokens: number
  last: number | null
  reads: number
  rereads: number
  added: number
  removed: number
  isShellEdit: boolean
}

type World = { holds: Holds; agents: GpsAgent[]; lines: Record<string, number>; names: Map<string, string>; hue: Map<string, string>; now: number }

function agentCell(w: World, agent: string, path: string): Cell | null {
  const lvl = level(w.holds, w.agents, agent, path, w.lines[path])
  if (!lvl) return null
  const h: Hold | undefined = w.holds[agent]?.[path]
  const total = w.lines[path]
  let held: Seg[]
  if (lvl === 'V') held = [{ t: 'all' }, ...(total ? [{ t: ` ${total}`, dim: true }] : [])]
  else if (lvl === 'P') {
    held = h?.ranges.length
      ? [{ t: describeRanges(h.ranges) }, ...(total ? [{ t: `/${total}`, dim: true }] : [])]
      : [{ t: h?.isShellRead ? 'shell read' : 'edited', dim: true }]
  } else if (lvl === 'T') held = [{ t: 'stale ' }, { t: `✎${w.names.get(h!.stale!.by) ?? h!.stale!.by}`, c: EDIT }]
  else if (lvl === 'S') held = [{ t: 'via ', c: LEVEL_COLOR.S }, ...via(w.holds, w.agents, agent, path).flatMap((id, i) => [{ t: (i ? ' ' : '') + (w.names.get(id) ?? id), c: w.hue.get(id) }])]
  else held = [{ t: LEVEL_NAME[lvl], c: LEVEL_COLOR[lvl] }]
  return {
    lvl,
    held: [{ t: GLYPH[lvl] + ' ', c: LEVEL_COLOR[lvl] }, ...held],
    tokens: h?.tokens ?? 0,
    last: h ? w.now - h.last : null,
    reads: h?.reads ?? 0,
    rereads: h?.rereads ?? 0,
    added: h?.added ?? 0,
    removed: h?.removed ?? 0,
    isShellEdit: h?.isShellEdit ?? false,
  }
}

/** The whole team: the best any agent knows, and who holds lines of it. */
function teamCell(w: World, path: string): Cell | null {
  const cells = w.agents.map(a => [a.id, agentCell(w, a.id, path)] as const).filter((x): x is readonly [string, Cell] => !!x[1] && x[1].lvl !== 'S')
  if (!cells.length) return null
  const best = [...cells].sort((a, b) => RANK[b[1].lvl] - RANK[a[1].lvl])[0]![1].lvl
  const holders = w.agents.filter(a => {
    const h = w.holds[a.id]?.[path]
    return h && (h.ranges.length || h.isShellRead) && !h.stale
  })
  const lasts = cells.map(([, c]) => c.last).filter((x): x is number => x !== null)
  const sum = (k: 'tokens' | 'reads' | 'rereads' | 'added' | 'removed') => cells.reduce((n, [, c]) => n + c[k], 0)
  return {
    lvl: best,
    held: [
      { t: GLYPH[best] + ' ', c: LEVEL_COLOR[best] },
      ...(holders.length
        ? holders.flatMap((a, i) => [{ t: (i ? ' ' : '') + (w.names.get(a.id) ?? a.id), c: w.hue.get(a.id) }])
        : [{ t: LEVEL_NAME[best], c: LEVEL_COLOR[best] }]),
    ],
    tokens: sum('tokens'),
    last: lasts.length ? Math.min(...lasts) : null,
    reads: sum('reads'),
    rereads: sum('rereads'),
    added: sum('added'),
    removed: sum('removed'),
    isShellEdit: cells.some(([, c]) => c.isShellEdit),
  }
}

// ── Columns ─────────────────────────────────────────────────────────────────
type Column = { key: 'held' | 'tokens' | 'last' | 'reads' | 'edits'; title: string; width: number; align: 'left' | 'right' }
const COLUMNS: Column[] = [
  { key: 'held', title: 'held', width: 16, align: 'left' },
  { key: 'tokens', title: 'tokens', width: 7, align: 'right' },
  { key: 'last', title: 'last', width: 6, align: 'right' },
  { key: 'reads', title: 'reads', width: 7, align: 'right' },
  { key: 'edits', title: ' edits', width: 10, align: 'left' },
]
const MIN_NAME = 18

const HELD_MIN = 16

/**
 * The name column fits the longest name shown; "held" takes the rest, so a wider
 * pane widens it. Columns drop from the right when even that leaves too little.
 */
function columnsFor(width: number, wantName: number): { name: number; cols: Column[] } {
  for (let n = COLUMNS.length; n >= 1; n--) {
    const cols = COLUMNS.slice(0, n)
    const fixed = cols.reduce((s, c) => s + (c.key === 'held' ? 0 : c.width), 0)
    const name = Math.max(MIN_NAME, Math.min(wantName, width - fixed - HELD_MIN))
    const held = width - fixed - name
    if (held >= HELD_MIN || n === 1) return { name, cols: cols.map(c => (c.key === 'held' ? { ...c, width: Math.max(8, held) } : c)) }
  }
  return { name: width, cols: [] }
}

function lastColor(ms: number | null) {
  if (ms === null) return undefined
  return ms < 15_000 ? LEVEL_COLOR.V : ms < 90_000 ? LEVEL_COLOR.P : undefined
}

/** `+6 −2`, leaving out a side that is zero. */
function editSegs(added: number, removed: number): Seg[] {
  return [{ t: ' ' }, ...(added ? [{ t: `+${added}`, c: ADD }] : []), ...(added && removed ? [{ t: ' ' }] : []), ...(removed ? [{ t: `−${removed}`, c: DEL }] : [])]
}

function cellSegs(c: Cell | null, col: Column): Seg[] {
  if (!c) return []
  switch (col.key) {
    case 'held':
      return c.held
    case 'tokens':
      return c.lvl === 'X' ? [{ t: '0', c: LEVEL_COLOR.X }] : [{ t: tok(c.tokens) }]
    case 'last':
      return c.last === null ? [] : [{ t: ago(c.last), c: lastColor(c.last), dim: c.last >= 90_000 }]
    case 'reads':
      return [{ t: c.reads ? String(c.reads) : '' }, ...(c.rereads ? [{ t: ` ↩${c.rereads}`, c: LEVEL_COLOR.T }] : [])]
    case 'edits':
      if (c.added || c.removed) return editSegs(c.added, c.removed)
      return c.isShellEdit ? [{ t: ' ✎ shell', c: EDIT }] : []
  }
}

/**
 * A folder's levels as glyphs: short runs packed (`●●◉`), long ones a glyph and
 * a count with a space on each side (`●●◉ ◌14 ○○○`).
 */
function stripSegs(levels: readonly Level[]): Seg[] {
  const parts = stripParts(levels)
  const out: Seg[] = []
  parts.forEach((p, i) => {
    if (i > 0 && (p.isCounted || parts[i - 1]!.isCounted)) out.push({ t: ' ' })
    // A lone counted group would repeat the folder's own count (`◌34 34/3078`): the glyph says enough.
    const isAlone = parts.length === 1
    out.push({ t: p.isCounted ? `${GLYPH[p.lvl]}${isAlone ? '' : p.n}` : GLYPH[p.lvl].repeat(p.n), c: LEVEL_COLOR[p.lvl] })
  })
  return out
}

/** A folder's cells: its levels as a strip, and the sums. */
function folderSegs(cells: readonly Cell[], total: number, col: Column): Seg[] {
  switch (col.key) {
    case 'held':
      return [...stripSegs(cells.map(c => c.lvl)), { t: ` ${cells.length}/${total}`, dim: true }]
    case 'tokens':
      return [{ t: tok(cells.reduce((n, c) => n + c.tokens, 0)), dim: true }]
    case 'last': {
      const lasts = cells.map(c => c.last).filter((x): x is number => x !== null)
      const m = lasts.length ? Math.min(...lasts) : null
      return m === null ? [] : [{ t: ago(m), c: lastColor(m), dim: m >= 90_000 }]
    }
    case 'reads': {
      const reads = cells.reduce((n, c) => n + c.reads, 0)
      const rereads = cells.reduce((n, c) => n + c.rereads, 0)
      return [{ t: reads ? String(reads) : '', dim: true }, ...(rereads ? [{ t: ` ↩${rereads}`, c: LEVEL_COLOR.T }] : [])]
    }
    case 'edits': {
      const added = cells.reduce((n, c) => n + c.added, 0)
      const removed = cells.reduce((n, c) => n + c.removed, 0)
      if (added || removed) return editSegs(added, removed)
      return cells.some(c => c.isShellEdit) ? [{ t: ' ✎', c: EDIT }] : []
    }
  }
}

/** Lines of output the agent saw when Claude Code kept only a preview of it. */
function previewLines(text: string): number {
  const m = /Preview[^\n]*:\n([\s\S]*?)(?:\n\.\.\.)?\s*(?:<\/persisted-output>)?\s*$/.exec(text)
  return m ? m[1]!.split('\n').length : 0
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    indexed = indexRepo($)
    await indexed
    // A mod loaded after the session started never saw SessionStart: find the chat's transcript by its id.
    if (!(await read($, snapshotDirAtom))) {
      const found = await findTranscript($)
      if (found) await update($, snapshotDirAtom, () => snapshotDir(found))
    }
    // A reload keeps the session's state but not this module's log: read it back from disk.
    await restore($)
    // Ages in the "last" column move on their own.
    $.clock.every(5000, () => $.ui.invalidate('ui.render'))
    void openPane($, false)
    await $.command.register({
      name: 'coverage',
      description: 'Coverage: show or hide which files each agent has in its context (args: clear, reindex)',
      argumentHint: '[clear|reindex]',
      immediate: true,
    })
    return next(e)
  })

  // The transcript names the chat's folder: snapshots live there, and come back on resume.
  on('classic.SessionStart', async ($, e, next) => {
    await update($, snapshotDirAtom, () => snapshotDir(e.transcript_path))
    if (e.source === 'clear') await reset($)
    else await restore($)
    return next(e)
  })

  on('command.run', { command: 'coverage' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'reindex') {
      await indexRepo($)
      return { text: `Coverage indexed ${repo.files.length} files` }
    }
    if (arg === 'clear') {
      await reset($)
      return { text: 'Coverage cleared' }
    }
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) await $.ui.close({ id: PANE })
    else await openPane($, true)
    return {}
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId) {
      const t = await $.clock.now()
      await record($, [{ k: 'spawn', t, a: e.parentAgentId ?? 'main', id: started.agentId, type: e.subagentType, label: e.description || e.subagentType }])
    }
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) await record($, [{ k: 'done', t: await $.clock.now(), a: e.agentId }])
    return done
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    await record($, [{ k: 'compact', t: await $.clock.now(), a: e.agentId ?? 'main' }])
    return done
  })

  on('tool.call', async ($, e, next) => {
    const a = e.agentId ?? 'main'
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>
    const command = tool === 'Bash' && typeof args.command === 'string' ? args.command : ''
    // Before a command runs, look at the checkouts it works in, so what it changes stands out after.
    let cwd = ''
    if (command) {
      await indexed
      cwd = cwds.get(a) ?? sessionCwd
      try {
        const { places } = shellEffects(repo, command, cwd)
        await placeOutside($, places)
        await lookFirst($, checkoutsFor(places))
      } catch (err) {
        $.ui.log(`could not read a command: ${String((err as Error)?.message ?? err).slice(0, 80)}`)
      }
    }
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    await indexed
    const result = ran.result as Record<string, any> | undefined
    const text = ran.text ?? ''
    /** A path argument as the map knows it, with its absolute form; a worktree made since the index is found here. */
    const pathArg = async (k: string) => {
      const abs = typeof args[k] === 'string' ? absolute(args[k] as string, cwds.get(a) ?? sessionCwd, repo.home) : null
      if (!abs) return null
      await placeOutside($, [abs])
      const p = logical(repo, abs)
      return p ? { p, abs } : null
    }
    try {
      const t = await $.clock.now()
      if (tool === 'Read') {
        const at = await pathArg('file_path')
        if (!at) {
          await update($, outsideAtom, n => n + 1)
          return ran
        }
        const { p } = at
        const file = result?.file ?? {}
        const tok = tokensOf(text)
        if (result?.type === 'text') {
          const r: Range = file.numLines > 0 ? [file.startLine, file.startLine + file.numLines - 1] : [1, 1]
          await record($, [{ k: 'read', t, a, p, r, tok, n: Math.max(1, Number(file.totalLines) || 0) }])
        } else if (result?.type === 'file_unchanged') {
          // The engine answered with a stub: the agent asked for lines it already has.
          const known = (await read($, linesAtom))[p] ?? 1
          const from = typeof args.offset === 'number' ? args.offset : 1
          await record($, [{ k: 'read', t, a, p, r: [from, typeof args.limit === 'number' ? from + args.limit - 1 : known], tok }])
        } else {
          // An image, PDF or notebook: whole or nothing.
          await record($, [{ k: 'read', t, a, p, r: [1, 1], tok, n: 1 }])
        }
      } else if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
        const at = (await pathArg('file_path')) ?? (await pathArg('notebook_path'))
        if (!at || result?.staged) return ran
        const { p, abs } = at
        await ensureIndexed($, p)
        const { added, removed } = countPatch(result?.structuredPatch)
        if (tool === 'Write' && typeof result?.content === 'string') {
          const written = result.content.split('\n').length
          const isNew = result.originalFile == null && result.type === 'create'
          await record($, [{ k: 'edit', t, a, p, add: isNew ? written : added, del: isNew ? 0 : removed, written }])
        } else {
          const hunks = (result?.structuredPatch ?? []).map((h: Hunk) => ({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines }))
          await record($, [{ k: 'edit', t, a, p, add: added, del: removed, hunks }])
        }
        // Take in the edit so the next shell command doesn't count it again.
        await serial(() => snapshotChanges($, checkoutsFor([abs])))
      } else if (tool === 'Grep' || tool === 'Glob') {
        const ps = pathsIn(repo, text, typeof args.path === 'string' ? absolute(args.path, sessionCwd, repo.home) ?? sessionCwd : sessionCwd)
        if (ps.length && ps.length <= MAX_HITS) await record($, [{ k: 'hit', t, a, ps, tok: tokensOf(text) }])
      } else if (command) {
        const reset = /Shell cwd was reset to (\/[^\n]+)/.exec(text)
        // First pass: which files the command prints from, to count their lines.
        const wanted = new Set<string>()
        shellEffects(repo, command, cwd, abs => (wanted.add(abs), undefined))
        const totals = new Map<string, number>()
        for (const abs of [...wanted].slice(0, 50)) {
          try {
            const body = await $.fs.read(abs)
            // Counted as the Read tool counts (a trailing newline ends one more, empty, line), so a whole cat is a full read.
            totals.set(abs, body.split('\n').length)
          } catch {
            // Gone, a directory, or never a file.
          }
        }
        const fx = shellEffects(repo, command, cwd, abs => totals.get(abs), result?.persistedOutputPath ? previewLines(text) : undefined)
        cwds.set(a, reset ? reset[1]!.trim() : fx.cwd)
        const edits = (await freshEdits($, checkoutsFor(fx.places))).map(abs => logical(repo, abs)).filter((p): p is string => !!p)
        const reads = fx.reads.filter(r => !edits.includes(r.path))
        const readPaths = new Set(reads.map(r => r.path))
        const hits = [...new Set([...fx.searched, ...pathsIn(repo, text, fx.cwd)])].filter(p => !readPaths.has(p) && !edits.includes(p))
        // The output's tokens, shared by lines read; a read of unknown lines weighs as much as an average one.
        const share = tokensOf(text)
        const known = reads.filter(r => r.range).map(r => r.range![1] - r.range![0] + 1)
        const avg = known.length ? known.reduce((x, y) => x + y, 0) / known.length : 1
        const weight = (r: (typeof reads)[number]) => (r.range ? r.range[1] - r.range[0] + 1 : avg)
        const sum = reads.reduce((n, r) => n + weight(r), 0)
        for (const p of edits) await ensureIndexed($, p)
        await record($, [
          ...(hits.length && hits.length <= MAX_HITS ? [{ k: 'hit' as const, t, a, ps: hits, tok: reads.length ? 0 : share }] : []),
          ...reads.map(r => ({
            k: 'read' as const,
            t,
            a,
            p: r.path,
            r: r.range,
            tok: Math.ceil((share * weight(r)) / sum),
            ...(totals.has(r.abs) ? { n: Math.max(1, totals.get(r.abs)!) } : {}),
          })),
          ...edits.map(p => ({ k: 'edit' as const, t, a, p, add: 0, del: 0, shell: true as const })),
        ])
      }
    } catch (err) {
      $.ui.log(`could not place ${tool}: ${String((err as Error)?.message ?? err).slice(0, 80)}`)
    }
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const holdsAll = await read($, holdsAtom)
    const excluded = new Set(await read($, excludedAtom))
    const lines = await read($, linesAtom)
    const known = await read($, agentsAtom)
    const pick = await read($, pickAtom)
    const anchor = await read($, anchorAtom)
    const closed = new Set(await read($, closedAtom))
    const selected = await read($, selectedAtom)
    const outside = await read($, outsideAtom)
    await read($, indexAtom)
    const now = await $.clock.now()
    const width = Math.max(30, e.props.bodyColumns)

    const agentsAll: GpsAgent[] = known.some(a => a.id === 'main')
      ? known
      : [MAIN(0), ...known]
    // Cells name agents by tag. Names and colors come from every agent, so leaving one out moves no color.
    const names = new Map(agentsAll.map((a, i) => [a.id, a.tag ?? (a.id === 'main' ? 'main' : 'ag' + i)]))
    const hue = new Map(agentsAll.map((a, i) => [a.id, AGENT_HUES[i % AGENT_HUES.length]!]))

    // Which agent: the one picked, else the transcript on screen, else main.
    const viewed = e.props.view.agentId
    const shown = pick === 'all' || agentsAll.some(a => a.id === pick) ? pick : viewed && agentsAll.some(a => a.id === viewed) ? viewed : 'main'
    // All leaves out the agents the person left out, as if they never ran.
    const agents = shown === 'all' ? agentsAll.filter(a => !excluded.has(a.id)) : agentsAll
    const holds = shown === 'all' ? Object.fromEntries(Object.entries(holdsAll).filter(([id]) => !excluded.has(id))) : holdsAll
    const w: World = { holds, agents, lines, names, hue, now }
    const cellOf = (path: string) => (shown === 'all' ? teamCell(w, path) : agentCell(w, shown, path))
    const isRunning = (a: GpsAgent) => (a.id === 'main' ? now - a.nowAt < NOW_MS : a.doneAt === null)
    const nowPaths = new Set(
      agents.filter(a => (shown === 'all' || a.id === shown) && a.now && isRunning(a) && now - a.nowAt < (a.id === 'main' ? NOW_MS : 120_000)).map(a => a.now!),
    )

    // Rows: in all, every file any agent touched; for one agent, the files it knows, its subagents' included.
    const everTouched = new Set<string>()
    for (const mine of Object.values(holds)) for (const path of Object.keys(mine)) everTouched.add(path)
    const touched = shown === 'all' ? everTouched : new Set([...everTouched].filter(p => level(holds, agents, shown, p, lines[p])))
    const { count, children } = folderIndex(everTouched)
    const isTouchedDir = (dir: string) => [...touched].some(p => p.startsWith(dir + '/'))
    // Each row's name is its indent, a marker and the last part of its path.
    const wantName = Math.max(
      'file'.length,
      ...[...touched].flatMap(p => {
        const parts = p.split('/')
        return parts.map((part, i) => i * 2 + 2 + part.length + (i < parts.length - 1 ? 1 : 0))
      }),
    ) + 2
    // One agent: its numbers in columns. All: one narrow column per agent, then the team's sums.
    const isTeam = shown === 'all'
    // Wide enough for its header, a numbered toggle: `1: main`.
    const AGENT_COL = 8
    const teamTail = COLUMNS.filter(c => c.key === 'tokens' || c.key === 'last')
    const tailW = teamTail.reduce((n, c) => n + c.width, 0)
    // Agents left out lose their column; they're listed under the grid to bring back.
    let fit = agents.length
    while (isTeam && fit > 1 && width - 1 - fit * AGENT_COL - tailW < MIN_NAME) fit--
    const teamAgents = agents.slice(0, fit)
    const { name: nameW, cols } = isTeam
      ? { name: Math.max(MIN_NAME, Math.min(wantName, width - 1 - fit * AGENT_COL - tailW)), cols: teamTail }
      : columnsFor(width - 1, wantName)
    // Glyphs sit under the agent's name, past the header's `1: `.
    const agentCol = (segs: Seg[]) => fitSegs([{ t: '   ' }, ...segs], AGENT_COL)
    const teamFile = (p: string): Seg[] =>
      teamAgents.flatMap(a => {
        const l = level(holds, agents, a.id, p, lines[p])
        return agentCol(l ? [{ t: GLYPH[l], c: LEVEL_COLOR[l] }] : [{ t: '·', c: FAINT }])
      })
    const teamDir = (inside: readonly string[]): Seg[] =>
      teamAgents.flatMap(a => {
        const ls = inside.map(p => level(holds, agents, a.id, p, lines[p])).filter((l): l is Level => !!l)
        if (!ls.length) return agentCol([{ t: '·', c: FAINT }])
        const best = [...ls].sort((x, y) => RANK[y] - RANK[x])[0]!
        return agentCol([{ t: GLYPH[best], c: LEVEL_COLOR[best] }, ...(ls.length > 1 ? [{ t: String(ls.length), dim: true }] : [])])
      })

    const rows: JSX.Element[] = []
    const line = (key: string, name: JSX.Element, segs: Seg[], isSelected = false) =>
      rows.push(
        <Box key={key} flexDirection="row" width={width} hover={{ backgroundColor: HOVER }} backgroundColor={isSelected ? HOVER : undefined}>
          {name}
          <Text wrap="truncate-end">{segs.map(s => <Text color={s.c} dimColor={s.dim} bold={s.bold}>{s.t}</Text>)}</Text>
        </Box>,
      )
    const toggle = (dir: string) => () => void update($, closedAtom, list => (list.includes(dir) ? list.filter(d => d !== dir) : [...list, dir]))
    const select = (path: string) => () => void update($, selectedAtom, s => (s === path ? null : path))

    const walkDir = (dir: string, depth: number) => {
      const kids = [...(children.get(dir) ?? [])].sort()
      const dirs = kids.filter(k => count.has(k))
      const files = kids.filter(k => !count.has(k))
      const indent = '  '.repeat(depth)
      let untouched = 0
      for (const d of dirs) {
        if (!isTouchedDir(d)) {
          untouched++
          continue
        }
        const isOpen = !closed.has(d)
        const inside = [...touched].filter(p => p.startsWith(d + '/'))
        const cells = inside.map(cellOf).filter((c): c is Cell => !!c)
        const label = fitSegs([{ t: indent + (isOpen ? '▾ ' : '▸ ') + d.split('/').pop() + '/' }], nameW)
        line(
          'd:' + d,
          <Button key={'fold:' + d} plain label={label.map(s => s.t).join('')} onPress={toggle(d)} />,
          [...(isTeam ? teamDir(inside) : []), ...cols.flatMap(c => fitSegs(folderSegs(cells, count.get(d) ?? 0, c), c.width, c.align))],
        )
        if (isOpen) walkDir(d, depth + 1)
      }
      for (const p of files) {
        if (!touched.has(p)) {
          untouched++
          continue
        }
        const c = cellOf(p)
        const isNow = nowPaths.has(p)
        const label = fitSegs([{ t: indent + (isNow ? '◆ ' : '  ') + p.split('/').pop() }], nameW)
        line(
          'f:' + p,
          <Button key={'sel:' + p} plain label={label.map(s => s.t).join('')} dimColor={!c} onPress={select(p)} />,
          [...(isTeam ? teamFile(p) : []), ...(c ? cols.flatMap(col => fitSegs(cellSegs(c, col), col.width, col.align)) : [])],
          selected === p,
        )
      }
      if (untouched) rows.push(<Text key={'u:' + dir} color={FAINT}>{indent}  {untouched} untouched</Text>)
    }
    walkDir('', 0)

    // The picker: a row of agents in spawn order that scrolls to keep the picked one in view.
    // h and l step through them, m jumps to main, a to all. In all, the row stays where the
    // last agent picked left it, and h and l step on from that agent.
    const order = agentsAll
    const at = order.findIndex(a => a.id === (shown === 'all' ? anchor : shown))
    const go = (id: string) => () =>
      void (async () => {
        if (id !== 'all') await update($, anchorAtom, () => id)
        await update($, pickAtom, () => id)
      })()
    const stepTo = (d: number) => order[at < 0 ? (d > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + d))]!.id
    const itemLabel = (a: GpsAgent) => {
      const status = a.id === 'main' ? '' : a.doneAt === null ? ' ◆' : ' ✓'
      const text = `${excluded.has(a.id) ? '⊘' : ''}${names.get(a.id)}${status}`
      return a.id === shown ? `[${text}]` : text
    }
    // The anchor in all is measured as if still picked, so the row keeps its exact place.
    const placeLabel = (a: GpsAgent) => (shown === 'all' && a.id === anchor ? `[${itemLabel(a)}]` : itemLabel(a))
    // Fixed parts: the title, the two scroll ends and all, with their hotkeys and gaps.
    const fixed = '◉ Coverage'.length + 'h: ‹ 99'.length + '99 › :l'.length + 'a: all'.length + 8
    const widthOf = (a: GpsAgent) => placeLabel(a).length + (a.id === 'main' ? 3 : 0) + 2
    let lo = Math.max(0, at)
    let hi = lo
    let used = order.length ? widthOf(order[lo]!) : 0
    for (let grew = true; grew; ) {
      grew = false
      if (hi + 1 < order.length && used + widthOf(order[hi + 1]!) <= width - fixed) {
        used += widthOf(order[++hi]!)
        grew = true
      }
      if (lo > 0 && used + widthOf(order[lo - 1]!) <= width - fixed) {
        used += widthOf(order[--lo]!)
        grew = true
      }
    }
    const picker = [
      <Button key="pick:prev" plain hotkey="h" dimColor label={lo > 0 ? `‹ ${lo}` : '‹'} onPress={go(stepTo(-1))} />,
      ...order.slice(lo, hi + 1).map(a => (
        <Button
          key={'pick:' + a.id}
          plain
          hotkey={a.id === 'main' ? 'm' : undefined}
          dimColor={shown !== a.id}
          label={itemLabel(a)}
          onPress={go(a.id)}
        />
      )),
      <Button key="pick:next" plain hotkey="l" dimColor label={hi < order.length - 1 ? `${order.length - 1 - hi} ›` : '›'} onPress={go(stepTo(1))} />,
      <Button key="pick:all" plain hotkey="a" dimColor={shown !== 'all'} label={shown === 'all' ? '[all]' : 'all'} onPress={go('all')} />,
    ]
    const toggleOut = (id: string) => () =>
      void update($, excludedAtom, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))

    // The summary under the picker.
    const all = [...touched]
    let summary: Seg[]
    if (shown === 'all') {
      const held = all.filter(p => agents.some(a => (holds[a.id]?.[p]?.ranges.length ?? 0) > 0 || holds[a.id]?.[p]?.isShellRead)).length
      const onlySubs = all.filter(p => {
        const m = holds.main?.[p]
        return !(m && (m.ranges.length || m.isShellRead)) && agents.some(a => a.id !== 'main' && ((holds[a.id]?.[p]?.ranges.length ?? 0) > 0 || holds[a.id]?.[p]?.isShellRead))
      }).length
      const stale = all.reduce((n, p) => n + agents.filter(a => holds[a.id]?.[p]?.stale).length, 0)
      summary = [
        { t: `team holds ${held}/${repo.files.length} files · ${onlySubs} only in subagents`, dim: true },
        ...(excluded.size ? [{ t: ` · ${excluded.size} agent${excluded.size > 1 ? 's' : ''} left out`, c: LEVEL_COLOR.X }] : []),
        ...(stale ? [{ t: ` · ${stale} stale cop${stale > 1 ? 'ies' : 'y'}`, c: LEVEL_COLOR.T }] : []),
        ...(outside ? [{ t: ` · ${outside} reads outside the repo`, dim: true }] : []),
      ]
    } else {
      const a = agents.find(x => x.id === shown)!
      const levels = all.map(p => level(holds, agents, shown, p, lines[p])).filter((l): l is Level => !!l)
      const n = (l: Level) => levels.filter(x => x === l).length
      const tokens = Object.values(holds[shown] ?? {}).reduce((s, h) => s + h.tokens, 0)
      const rereads = Object.values(holds[shown] ?? {}).reduce((s, h) => s + h.rereads, 0)
      const head = a.id === 'main' ? 'main session' : `${a.label} · ${a.doneAt === null ? 'running ' + ago(now - a.spawnedAt) : 'done in ' + ago(a.doneAt - a.spawnedAt)}`
      summary = [
        { t: head + '\n', dim: true },
        { t: `files ${tok(tokens) || 0} tok `, dim: true },
        ...(['V', 'P', 'T', 'S', 'G', 'X'] as Level[]).filter(l => n(l)).flatMap(l => [{ t: ` ${GLYPH[l]}`, c: LEVEL_COLOR[l] }, { t: `${n(l)}` }]),
        ...(rereads ? [{ t: `  ↩${rereads} re-reads`, c: LEVEL_COLOR.T }] : []),
        ...(outside ? [{ t: `  · ${outside} reads outside the repo`, dim: true }] : []),
      ]
    }

    // What every agent knows of the selected file.
    const detail =
      selected && Object.values(holdsAll).some(m => m[selected]) ? (
        <Box key="detail" flexDirection="column" marginTop={1}>
          <Text wrap="truncate-start">
            <Text bold>{selected}</Text>
            <Text dimColor>{lines[selected] ? `  ${lines[selected]} lines` : ''}</Text>
          </Text>
          {agentsAll.map(a => {
            const lvl = level(holdsAll, agentsAll, a.id, selected, lines[selected])
            const hold = holdsAll[a.id]?.[selected]
            const parts: Seg[] = [{ t: (names.get(a.id) ?? a.id).padEnd(6) + ' ', c: hue.get(a.id) }, ...(excluded.has(a.id) ? [{ t: '⊘ ', dim: true }] : [])]
            if (!lvl) parts.push({ t: 'never seen', c: FAINT })
            else {
              parts.push({ t: GLYPH[lvl] + ' ' + LEVEL_NAME[lvl], c: LEVEL_COLOR[lvl] })
              if (hold?.ranges.length) parts.push({ t: ` lines ${describeRanges(hold.ranges)}` })
              if (lvl === 'T') parts.push({ t: ` · ${names.get(hold!.stale!.by) ?? hold!.stale!.by} edited it ${ago(now - hold!.stale!.at)} ago`, c: EDIT })
              if (lvl === 'S') parts.push({ t: ' via ' + via(holdsAll, agentsAll, a.id, selected).map(id => names.get(id) ?? id).join(', ') })
              if (hold && (hold.added || hold.removed)) parts.push({ t: ` +${hold.added}`, c: ADD }, { t: ` −${hold.removed}`, c: DEL })
            }
            return <Text key={'det:' + a.id} wrap="truncate-end">{parts.map(s => <Text color={s.c} dimColor={s.dim}>{s.t}</Text>)}</Text>
          })}
        </Box>
      ) : null

    const legend: Seg[] = (['V', 'P', 'T', 'S', 'G', 'X'] as Level[]).flatMap(l => [{ t: GLYPH[l], c: LEVEL_COLOR[l] }, { t: ` ${LEVEL_NAME[l]}  `, dim: true }])

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Text bold color="claude">◉ Coverage</Text>
          {picker}
        </Box>
        <Text wrap="wrap">{summary.map(s => <Text color={s.c} dimColor={s.dim}>{s.t}</Text>)}</Text>
        <Box marginTop={1} flexDirection="row" width={width}>
          <Text dimColor>{'file'.padEnd(nameW)}</Text>
          {/* In all, each agent's header is a toggle: its number leaves it out, or brings it back. */}
          {isTeam &&
            teamAgents.map((a, i) => (
              <Box key={'col:' + a.id} width={AGENT_COL}>
                <Button
                  key={'out:' + a.id}
                  plain
                  hotkey={i < 9 ? String(i + 1) : undefined}
                  label={names.get(a.id) ?? a.id}
                  onPress={toggleOut(a.id)}
                />
              </Box>
            ))}
          <Text dimColor>
            {cols.map(c => (c.align === 'right' ? c.title.padStart(c.width) : c.title.padEnd(c.width))).join('')}
            {isTeam && fit < agents.length ? `  +${agents.length - fit} agents` : ''}
          </Text>
        </Box>
        {touched.size === 0 ? (
          <Text dimColor wrap="wrap">
            {isTeam && excluded.size && !agents.length
              ? 'Every agent is left out.'
              : everTouched.size === 0
              ? 'Nothing read yet. Files appear here as Claude and its subagents read, search and edit them, with what each one holds.'
              : `${names.get(shown) ?? shown} hasn’t read, searched or edited a file yet.`}
          </Text>
        ) : (
          rows
        )}
        {/* The agents left out of all: each one comes back on a click, all of them on 0. */}
        {isTeam && excluded.size > 0 && (
          <Box key="left-out" marginTop={1} flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Text color={LEVEL_COLOR.X}>left out</Text>
            {agentsAll
              .filter(a => excluded.has(a.id))
              .map(a => (
                <Button key={'in:' + a.id} plain dimColor label={'⊘' + (names.get(a.id) ?? a.id)} onPress={toggleOut(a.id)} />
              ))}
            <Button key="in:all" plain hotkey="0" label="bring all back" onPress={() => void update($, excludedAtom, () => [])} />
          </Box>
        )}
        {detail}
        <Box marginTop={1} flexDirection="row" flexWrap="wrap">
          <Text wrap="wrap">
            {legend.map(s => <Text color={s.c} dimColor={s.dim}>{s.t}</Text>)}
            <Text color={NOW}>◆</Text>
            <Text dimColor> now  </Text>
            <Text color={LEVEL_COLOR.T}>↩</Text>
            <Text dimColor> re-read</Text>
          </Text>
        </Box>
        <Text color={FAINT} wrap="wrap">
          click a file for its detail, a folder to fold it{isTeam ? ' · an agent’s number leaves it out' : ''}
        </Text>
      </Box>
    )
  })
}
