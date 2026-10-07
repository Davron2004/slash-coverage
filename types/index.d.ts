/** A 1-based, inclusive line range. */
export type Range = [number, number]

/** What one agent holds of one file, built from its own tool calls. */
export type Hold = {
  /** Line ranges of this file its Read calls put in its context, merged. */
  ranges: Range[]
  /** Read through the shell (cat, sed, head): the lines it covered are unknown. */
  isShellRead: boolean
  /** Read calls, shell reads included. */
  reads: number
  /** Reads that covered lines it already held. */
  rereads: number
  /** Named in a search result or listing. */
  isGrepHit: boolean
  /** Estimated tokens this file's tool results put in its context. */
  tokens: number
  /** Another agent edited the file after this one read it. */
  stale?: { by: string; at: number }
  added: number
  removed: number
  /** Changed by a shell command, so the line counts are unknown. */
  isShellEdit: boolean
  /** Epoch ms of the latest read, hit or edit. */
  last: number
  /** It held lines of this file until a compaction removed them. */
  isForgotten: boolean
}

export type GpsAgent = {
  /** 'main', or a subagent's id. */
  id: string
  /** A few characters naming it in cells: `ex1` for the first Explore agent. */
  tag: string
  label: string
  /** The loop that spawned it; null for main. */
  parent: string | null
  spawnedAt: number
  /** When its latest turn ended; null while it runs. */
  doneAt: number | null
  /** The file it touched last, and when. */
  now: string | null
  nowAt: number
}

/** Holds by agent id, then by path relative to the repo root. */
export type Holds = Record<string, Record<string, Hold>>

declare module 'claude-code' {
  interface PluginState {
    'slash-coverage': {
      holds: Holds
      /** Line counts the Read results reported. */
      lines: Record<string, number>
      agents: GpsAgent[]
      /** 'auto' follows the transcript on screen; otherwise an agent id or 'all'. */
      pick: string
      /** The agent picked last: in all, the picker row stays scrolled to it. */
      anchor: string | null
      /** Agents the person left out of the all view. */
      excluded: string[]
      /** Folders the person folded. */
      closed: string[]
      /** The file whose detail shows under the grid. */
      selected: string | null
      /** Touched paths outside the repo. */
      outside: number
      /** Bumped when the file index changes. */
      indexVersion: number
      /** The chat's snapshot folder, next to its transcript; null until the session names it. */
      snapshotDir: string | null
    }
  }
}
