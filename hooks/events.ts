import type { GpsAgent, Holds, Range } from '../types'
import { type Hunk, applyCompact, applyEdit, applyGrepHits, applyRead } from './knowledge'

/**
 * One thing an agent did, as Coverage records it. The grid is these events folded in
 * time order, live and on resume alike: `t` is epoch ms, `a` the agent that acted.
 */
export type GpsEvent =
  /** A read of lines `r`, or of unknown lines when null (a shell read); `n` the file's line count when known. */
  | { k: 'read'; t: number; a: string; p: string; r: Range | null; tok: number; n?: number }
  /** Paths named by a search, a listing or a count. */
  | { k: 'hit'; t: number; a: string; ps: string[]; tok: number }
  /** An edit: line counts and hunks from a patch, or `shell` when a command changed the file. */
  | { k: 'edit'; t: number; a: string; p: string; add: number; del: number; shell?: true; written?: number; hunks?: Hunk[] }
  | { k: 'compact'; t: number; a: string }
  /** `a` started subagent `id`. */
  | { k: 'spawn'; t: number; a: string; id: string; type: string; label: string }
  /** `a`'s turn ended. */
  | { k: 'done'; t: number; a: string }

export type GpsState = { holds: Holds; lines: Record<string, number>; agents: GpsAgent[] }

export const EMPTY: GpsState = { holds: {}, lines: {}, agents: [] }

const TYPE_TAG: Record<string, string> = { Explore: 'ex', 'general-purpose': 'gp', Plan: 'pl', fork: 'fk' }

/** `ex1`, `ex2`, `gp1`: the agent's type and its place among agents of that type. */
export function tagFor(list: readonly GpsAgent[], type: string): string {
  const prefix = TYPE_TAG[type] ?? (type.replace(/[^a-z]/gi, '').slice(0, 2).toLowerCase() || 'ag')
  let n = 1
  while (list.some(a => a.tag === prefix + n)) n++
  return prefix + n
}

export const MAIN = (now: number): GpsAgent => ({ id: 'main', tag: 'main', label: 'main', parent: null, spawnedAt: now, doneAt: null, now: null, nowAt: 0 })

/** The agent acting is running, and on `path` when it names one. One seen before its spawn counts as main's. */
function noteAgent(agents: GpsAgent[], id: string, path: string | null, t: number): GpsAgent[] {
  const list = agents.some(a => a.id === 'main') ? agents : [MAIN(t), ...agents]
  const known = list.some(a => a.id === id)
  const base = known ? list : [...list, { id, tag: tagFor(list, 'subagent'), label: 'subagent', parent: 'main', spawnedAt: t, doneAt: null, now: null, nowAt: 0 }]
  return base.map(a => (a.id === id ? { ...a, doneAt: null, now: path ?? a.now, nowAt: path ? t : a.nowAt } : a))
}

export function applyEvent(s: GpsState, ev: GpsEvent): GpsState {
  switch (ev.k) {
    case 'read':
      return {
        holds: applyRead(s.holds, ev.a, ev.p, ev.r, ev.tok, ev.t),
        lines: ev.n !== undefined ? { ...s.lines, [ev.p]: ev.n } : s.lines,
        agents: noteAgent(s.agents, ev.a, ev.p, ev.t),
      }
    case 'hit':
      return { ...s, holds: applyGrepHits(s.holds, ev.a, ev.ps, ev.tok, ev.t), agents: noteAgent(s.agents, ev.a, null, ev.t) }
    case 'edit': {
      const known = s.lines[ev.p]
      const lines = ev.written !== undefined ? ev.written : known !== undefined && !ev.shell ? Math.max(1, known + ev.add - ev.del) : known
      return {
        holds: applyEdit(s.holds, ev.a, ev.p, ev.shell ? null : { added: ev.add, removed: ev.del }, ev.t, ev.written, ev.hunks ?? []),
        lines: lines !== undefined ? { ...s.lines, [ev.p]: lines } : s.lines,
        agents: noteAgent(s.agents, ev.a, ev.p, ev.t),
      }
    }
    case 'compact':
      return { ...s, holds: applyCompact(s.holds, ev.a) }
    case 'spawn': {
      const list = s.agents.some(a => a.id === 'main') ? s.agents : [MAIN(ev.t), ...s.agents]
      const was = list.find(a => a.id === ev.id)
      // A subagent whose tool calls arrived before its spawn did keeps its place, and gets its real name.
      const agents = was
        ? list.map(a => (a.id === ev.id ? { ...a, label: ev.label, parent: ev.a, tag: a.label === 'subagent' ? tagFor(list, ev.type) : a.tag } : a))
        : [...list, { id: ev.id, tag: tagFor(list, ev.type), label: ev.label, parent: ev.a, spawnedAt: ev.t, doneAt: null, now: null, nowAt: 0 }]
      return { ...s, agents }
    }
    case 'done':
      return { ...s, agents: s.agents.map(a => (a.id === ev.a ? { ...a, doneAt: ev.t } : a)) }
  }
}

/** Every agent's events in time order, folded from nothing. */
export function replay(logs: Iterable<readonly GpsEvent[]>): GpsState {
  const all = [...logs].flat().sort((x, y) => x.t - y.t)
  return all.reduce(applyEvent, EMPTY)
}

// ── Snapshots on disk ───────────────────────────────────────────────────────
// One file per agent in the chat's own folder, next to its `subagents/`:
// `<chat id>/slash-coverage/main.json` and `<agent id>.json`. Claude Code deletes the
// folder with the transcript, so a snapshot lives exactly as long as its chat.

export type Snapshot = { version: 1; agent: string; events: GpsEvent[] }

export const snapshotDir = (transcriptPath: string) => transcriptPath.replace(/\.jsonl$/, '') + '/slash-coverage'

/** The agents a log started: their snapshots are read next. */
export const spawnedIn = (events: readonly GpsEvent[]) => events.flatMap(ev => (ev.k === 'spawn' ? [ev.id] : []))

export function parseSnapshot(text: string): GpsEvent[] {
  try {
    const s = JSON.parse(text) as Snapshot
    return s?.version === 1 && Array.isArray(s.events) ? s.events : []
  } catch {
    return []
  }
}
