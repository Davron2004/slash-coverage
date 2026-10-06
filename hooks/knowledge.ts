import type { GpsAgent, Hold, Holds, Range } from '../types'

/**
 * How well an agent knows a file. V the whole file, P some lines, T lines read
 * before someone else's edit, S only through a subagent it spawned, G a search
 * hit, X lost to compaction.
 */
export type Level = 'V' | 'P' | 'T' | 'S' | 'G' | 'X'

export const RANK: Record<Level, number> = { V: 5, P: 4, T: 3, S: 2, G: 1, X: 0 }

export function emptyHold(now: number): Hold {
  return { ranges: [], isShellRead: false, reads: 0, rereads: 0, isGrepHit: false, tokens: 0, added: 0, removed: 0, isShellEdit: false, last: now, isForgotten: false }
}

export function mergeRanges(ranges: readonly Range[]): Range[] {
  const out: Range[] = []
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

export const covered = (ranges: readonly Range[]) => ranges.reduce((n, [a, b]) => n + b - a + 1, 0)

const overlaps = (ranges: readonly Range[], [a, b]: Range) => ranges.some(([x, y]) => a <= y && b >= x)

/** Rough token count of a tool result's text. */
export const tokensOf = (text: string) => Math.ceil(text.length / 4)

function withHold(holds: Holds, agent: string, path: string, now: number, change: (h: Hold) => Hold): Holds {
  const mine = holds[agent] ?? {}
  return { ...holds, [agent]: { ...mine, [path]: change({ ...(mine[path] ?? emptyHold(now)), last: now }) } }
}

/** A read of `range`, or of unknown lines when null (a shell read). */
export function applyRead(holds: Holds, agent: string, path: string, range: Range | null, tokens: number, now: number): Holds {
  return withHold(holds, agent, path, now, h => {
    // A read after someone else's edit replaces the old copy.
    const ranges = h.stale ? [] : h.ranges
    const isReread = range !== null && !h.stale && overlaps(ranges, range)
    return {
      ...h,
      ranges: range ? mergeRanges([...ranges, range]) : ranges,
      isShellRead: h.isShellRead || range === null,
      reads: h.reads + 1,
      rereads: h.rereads + (isReread ? 1 : 0),
      tokens: h.tokens + tokens,
      stale: h.stale && range === null ? h.stale : undefined,
      isForgotten: false,
    }
  })
}

export function applyGrepHits(holds: Holds, agent: string, paths: readonly string[], tokens: number, now: number): Holds {
  const each = paths.length ? Math.ceil(tokens / paths.length) : 0
  let out = holds
  for (const path of paths) out = withHold(out, agent, path, now, h => ({ ...h, isGrepHit: true, tokens: h.tokens + each }))
  return out
}

export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number }

/**
 * The editor's own ranges after its edit: lines past a hunk move by what the
 * hunk added or removed, and the hunk's new lines (which it just wrote) join them.
 */
export function shiftRanges(ranges: readonly Range[], hunks: readonly Hunk[]): Range[] {
  const map = (line: number, isEnd: boolean) => {
    let delta = 0
    for (const k of hunks) {
      const oldEnd = k.oldStart + k.oldLines - 1
      if (line > oldEnd) delta += k.newLines - k.oldLines
      else if (line >= k.oldStart) return isEnd ? k.newStart + Math.max(0, k.newLines - 1) : k.newStart
    }
    return line + delta
  }
  const moved = ranges.map(([a, b]): Range => [map(a, false), map(b, true)]).filter(([a, b]) => b >= a)
  const written = hunks.filter(k => k.newLines > 0).map((k): Range => [k.newStart, k.newStart + k.newLines - 1])
  return mergeRanges([...moved, ...written])
}

/**
 * An edit by `agent`. Lines are unknown for a shell edit (null). `written` is
 * the new line count when the agent wrote the whole file, which it then holds.
 * Every other agent holding lines of the file now holds a stale copy.
 */
export function applyEdit(
  holds: Holds,
  agent: string,
  path: string,
  lines: { added: number; removed: number } | null,
  now: number,
  written?: number,
  hunks: readonly Hunk[] = [],
): Holds {
  let out = withHold(holds, agent, path, now, h => ({
    ...h,
    added: h.added + (lines?.added ?? 0),
    removed: h.removed + (lines?.removed ?? 0),
    isShellEdit: h.isShellEdit || lines === null,
    ranges: written !== undefined ? [[1, Math.max(1, written)]] : hunks.length ? shiftRanges(h.ranges, hunks) : h.ranges,
    stale: undefined,
  }))
  for (const [other, theirs] of Object.entries(out)) {
    const h = theirs[path]
    if (other === agent || !h || (!h.ranges.length && !h.isShellRead)) continue
    out = { ...out, [other]: { ...theirs, [path]: { ...h, stale: { by: agent, at: now } } } }
  }
  return out
}

/** A compaction drops everything the agent read from its context. */
export function applyCompact(holds: Holds, agent: string): Holds {
  const mine = holds[agent]
  if (!mine) return holds
  const next: Record<string, Hold> = {}
  for (const [path, h] of Object.entries(mine)) {
    const had = h.ranges.length > 0 || h.isShellRead || h.isGrepHit
    next[path] = had ? { ...h, ranges: [], isShellRead: false, isGrepHit: false, tokens: 0, stale: undefined, isForgotten: true } : h
  }
  return { ...holds, [agent]: next }
}

/** The agents `id` spawned, and theirs. */
export function descendants(agents: readonly GpsAgent[], id: string): string[] {
  const out: string[] = []
  for (const a of agents) if (a.parent === id) out.push(a.id, ...descendants(agents, a.id))
  return out
}

const holdsLines = (h: Hold | undefined) => !!h && (h.ranges.length > 0 || h.isShellRead)

/** The subagents of `agent` that hold lines of `path`. */
export function via(holds: Holds, agents: readonly GpsAgent[], agent: string, path: string): string[] {
  return descendants(agents, agent).filter(id => holdsLines(holds[id]?.[path]))
}

export function level(holds: Holds, agents: readonly GpsAgent[], agent: string, path: string, total: number | undefined): Level | null {
  const h = holds[agent]?.[path]
  if (h && holdsLines(h)) {
    if (h.stale) return 'T'
    if (h.ranges.length && total !== undefined && covered(h.ranges) >= total) return 'V'
    return 'P'
  }
  if (via(holds, agents, agent, path).length) return 'S'
  if (h?.isGrepHit) return 'G'
  if (h?.isForgotten) return 'X'
  // An edit with no read behind it (a shell edit, a Write of a new file) still means it knows the change.
  if (h && (h.added || h.removed || h.isShellEdit)) return 'P'
  return null
}

/** Lines added and removed, from an Edit or Write result's structured patch. */
export function countPatch(hunks: readonly { lines: readonly string[] }[] | undefined): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks ?? []) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

/** The order levels appear in a folder's strip: strongest first. */
export const STRIP_ORDER: readonly Level[] = ['V', 'P', 'T', 'S', 'G', 'X']

/** Up to this many of one level show as repeated glyphs; more become a glyph and a count. */
export const STRIP_RUN = 3

export type StripPart = { lvl: Level; n: number; isCounted: boolean }

/** A folder's levels grouped in a fixed order: `●●◉ ◌14 ○○○`. */
export function stripParts(levels: readonly Level[]): StripPart[] {
  return STRIP_ORDER.map(lvl => {
    const n = levels.filter(l => l === lvl).length
    return { lvl, n, isCounted: n > STRIP_RUN }
  }).filter(p => p.n > 0)
}

/** `1–120,200–240`, or a count past two ranges. */
export function describeRanges(ranges: readonly Range[]): string {
  if (ranges.length > 2) return `${ranges.length} ranges`
  return ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(',')
}
