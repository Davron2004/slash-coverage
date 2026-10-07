import type { Range } from '../types'

/** A file the index knows, by its path relative to the repo root. */
export type FileEntry = { path: string }

/**
 * A directory on disk whose files the map shows at `prefix`: the root at '', and
 * every worktree of a repo at that repo's place, so a subagent working in
 * `../app-feature` reads the same files as main working in `app`.
 */
export type Checkout = { dir: string; prefix: string }

/** The repo as the map indexes it: its root and its files, with a lookup by path. */
export type Repo = { root: string; files: FileEntry[]; byPath: Map<string, number>; checkouts: Checkout[]; home: string }

export function makeRepo(root: string, files: FileEntry[], worktrees: readonly Checkout[] = [], home = ''): Repo {
  // Longest first: a worktree inside the root (`.claude/worktrees/x`) wins over the root.
  const checkouts = [{ dir: root, prefix: '' }, ...worktrees.filter(w => w.dir !== root)].sort((a, b) => b.dir.length - a.dir.length)
  return { root, files, byPath: new Map(files.map((f, i) => [f.path, i])), checkouts, home }
}

const clean = (path: string) => path.trim().replace(/^["'`]+|["'`,;)]+$/g, '')

/** `path` seen from `cwd`, absolute and normalized; null for one that can't be placed (`~user`, `$VAR`, an option). */
export function absolute(path: string, cwd: string, home = ''): string | null {
  const p = clean(path)
  if (!p || p === '-' || p.startsWith('-') || p.includes('$')) return null
  let full: string
  if (p.startsWith('/')) full = p
  else if (p === '~' || p.startsWith('~/')) {
    if (!home) return null
    full = home + p.slice(1)
  } else if (p.startsWith('~')) return null
  else full = cwd + '/' + p
  const out: string[] = []
  for (const part of full.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** The checkout an absolute path lies in, if any. */
export function checkoutOf(repo: Repo, abs: string): Checkout | null {
  return repo.checkouts.find(c => abs === c.dir || abs.startsWith(c.dir + '/')) ?? null
}

/** An absolute path as the map knows it, or null when it lies in no checkout. */
export function logical(repo: Repo, abs: string): string | null {
  const c = checkoutOf(repo, abs)
  if (!c) return null
  const rest = abs.slice(c.dir.length + 1)
  return c.prefix && rest ? c.prefix + '/' + rest : c.prefix || rest
}

/** A path as the map knows it, seen from `cwd` (absolute; the root by default), or null when it's outside. */
export function relative(repo: Repo, path: string, cwd = repo.root): string | null {
  const abs = absolute(path, cwd, repo.home)
  return abs === null ? null : logical(repo, abs)
}

/** A shell glob (`src/*.ts`, `src/**`) as a test on indexed paths. */
export function globTest(pattern: string): RegExp {
  const body = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*')
  return new RegExp('^' + body + '$')
}

const TOKEN_SPLIT = /[\s"'`=(<>{}]+/

/** `  123 path` (wc), or `-rw-r--r--  1 me staff 812 Oct 6 12:00 path` (ls -l): the path after the count or listing. */
const LINE_LEAD = /^\s*(?:\d+\s+|[-dlcbps][rwxsStT-]{9}[@+.]?\s+(?:\S+\s+){7})?/

/**
 * Every indexed path that starts a line of `text`, read from `cwd`: the shape of
 * search hits (`path:12: …`), listings and line counts. A path quoted inside a
 * file's content (`![](docs/home.png)`) starts no line, so a `cat` names nothing.
 */
export function pathsIn(repo: Repo, text: string, cwd = repo.root, limit = 400): string[] {
  const found = new Set<string>()
  for (const line of text.split('\n').slice(0, limit)) {
    const token = line.replace(LINE_LEAD, '').split(TOKEN_SPLIT)[0] ?? ''
    if (!token || token.includes('*') || token.length > 400) continue
    const rel = relative(repo, token.split(':')[0]!, cwd)
    if (rel && repo.byPath.has(rel)) found.add(rel)
  }
  return [...found]
}

// ── Shell syntax ────────────────────────────────────────────────────────────
// Enough of sh to tell which words are a command's file arguments: quotes,
// escapes, `$(…)`, redirects, heredocs, pipes and lists. Not a full shell.

/** A word with its quotes removed. `isGlob`: an unquoted `*` or `?`. `isDynamic`: it holds `$…` or a backtick. */
export type Word = { text: string; isGlob: boolean; isDynamic: boolean }
export type Redirect = { fd: number; op: string; target: Word | null }
export type Command = { argv: Word[]; redirects: Redirect[] }
/** Commands joined by `|`. */
export type Pipeline = Command[]

const OPERATORS = ['&&', '||', ';;', '|&', '&>>', '&>', '>>', '>&', '>|', '<<<', '<<-', '<<', '<&', '<>', '|', '&', ';', '(', ')', '<', '>']

/** A command line as pipelines in the order they run: `;`, `&&`, `||`, `&` and newlines all separate them. */
export function parseShell(src: string): Pipeline[] {
  const pipelines: Pipeline[] = []
  let pipeline: Pipeline = []
  let cmd: Command = { argv: [], redirects: [] }
  let pendingRedirect: Redirect | null = null
  const heredocs: { delim: string; strip: boolean }[] = []
  let i = 0

  const endCommand = () => {
    if (cmd.argv.length || cmd.redirects.length) pipeline.push(cmd)
    cmd = { argv: [], redirects: [] }
    pendingRedirect = null
  }
  const endPipeline = () => {
    endCommand()
    if (pipeline.length) pipelines.push(pipeline)
    pipeline = []
  }
  const pushWord = (w: Word) => {
    if (pendingRedirect) {
      pendingRedirect.target = w
      if (pendingRedirect.op === '<<' || pendingRedirect.op === '<<-') heredocs.push({ delim: w.text, strip: pendingRedirect.op === '<<-' })
      pendingRedirect = null
    } else cmd.argv.push(w)
  }
  /** The index past a `$(…)` (from its `(`) or a `` `…` `` (from its backtick). */
  const skipSubst = (at: number): number => {
    if (src[at] === '`') {
      let j = at + 1
      while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1
      return j + 1
    }
    let depth = 0
    let j = at
    for (; j < src.length; j++) {
      const c = src[j]
      if (c === '\\') j++
      else if (c === "'") {
        const end = src.indexOf("'", j + 1)
        j = end < 0 ? src.length : end
      } else if (c === '(') depth++
      else if (c === ')' && --depth === 0) return j + 1
    }
    return j
  }

  while (i < src.length) {
    const c = src[i]!
    if (c === ' ' || c === '\t') {
      i++
      continue
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2
      continue
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '\n') {
      endPipeline()
      i++
      // Heredoc bodies follow the line that opened them; they are stdin, never arguments.
      for (const { delim, strip } of heredocs.splice(0)) {
        while (i < src.length) {
          const end = src.indexOf('\n', i)
          const line = src.slice(i, end < 0 ? src.length : end)
          i = end < 0 ? src.length : end + 1
          if ((strip ? line.replace(/^\t+/, '') : line) === delim) break
        }
      }
      continue
    }
    const op = OPERATORS.find(o => src.startsWith(o, i))
    if (op) {
      // `2>`: a word of digits right before the operator, with no space, is its file descriptor.
      const last = cmd.argv[cmd.argv.length - 1]
      const isFd = !!last && /^\d+$/.test(last.text) && i > 0 && !/\s/.test(src[i - 1]!)
      i += op.length
      if (op === '|' || op === '|&') endCommand()
      else if (op.includes('<') || op.includes('>')) {
        let fd = op.startsWith('<') ? 0 : op.startsWith('&') ? -1 : 1
        if (isFd) {
          fd = Number(last!.text)
          cmd.argv.pop()
        }
        const r: Redirect = { fd, op, target: null }
        cmd.redirects.push(r)
        // `2>&1`: the target is a descriptor, read as an ordinary word.
        pendingRedirect = r
      } else endPipeline()
      continue
    }
    // A word.
    let text = ''
    let isGlob = false
    let isDynamic = false
    while (i < src.length) {
      const ch = src[i]!
      if (ch === ' ' || ch === '\t' || ch === '\n' || '|&;<>()'.includes(ch)) break
      if (ch === '\\') {
        text += src[i + 1] ?? ''
        i += 2
      } else if (ch === "'") {
        const end = src.indexOf("'", i + 1)
        text += src.slice(i + 1, end < 0 ? src.length : end)
        i = end < 0 ? src.length : end + 1
      } else if (ch === '"') {
        i++
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\' && '"\\$`\n'.includes(src[i + 1] ?? '')) {
            text += src[i + 1]
            i += 2
          } else if (src.startsWith('$(', i) || src[i] === '`') {
            const end = skipSubst(src[i] === '`' ? i : i + 1)
            text += src.slice(i, end)
            isDynamic = true
            i = end
          } else {
            if (src[i] === '$') isDynamic = true
            text += src[i++]
          }
        }
        i++
      } else if (src.startsWith('$(', i) || ch === '`') {
        const end = skipSubst(ch === '`' ? i : i + 1)
        text += src.slice(i, end)
        isDynamic = true
        i = end
      } else {
        if (ch === '$') isDynamic = true
        if (ch === '*' || ch === '?') isGlob = true
        text += ch
        i++
      }
    }
    pushWord({ text, isGlob, isDynamic })
  }
  endPipeline()
  return pipelines
}

// ── What a command line reads ───────────────────────────────────────────────

type FileRef = { path: string; abs: string }
/** Lines `from`–`to` of a file, lines of it that can't be placed (`from: null`), or output that is no file's (`opaque` lines, null when unknown). */
type Seg = (FileRef & { from: number; to: number }) | (FileRef & { from: null }) | { opaque: number | null }

/** A file a command line reads: lines `range`, or unknown lines when null. */
export type ShellRead = FileRef & { range: Range | null }

export type ShellEffects = {
  reads: ShellRead[]
  /** Files searched or counted (grep, wc): named, never read. */
  searched: string[]
  /** Where the shell ends up. */
  cwd: string
  /** Every directory the command line worked in or named a file in, absolute: where it could have changed files. */
  places: string[]
}

/** Commands that print their files whole, or every line of them transformed. */
const WHOLE = new Set(['cat', 'nl', 'tac', 'less', 'more', 'bat', 'batcat', 'cut', 'sort', 'uniq', 'column', 'fold', 'expand', 'rev', 'jq', 'yq', 'xxd', 'od', 'hexdump', 'strings', 'fmt', 'pr', 'paste'])
/** Of those, the ones that keep lines one for one, so a `head` after them still counts lines of the file. */
const LINEWISE = new Set(['cat', 'nl', 'cut', 'expand', 'rev', 'column'])
/** Commands that look inside files but print only matches, names or counts. */
const SEARCHING = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'wc'])
/** Words that start a command without being it. */
const PREFIX = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '}', 'time', 'done', 'fi', 'esac', 'command', 'builtin', 'exec', 'nice', 'nohup'])
/** A pipeline whose stdout goes here still reaches the agent. */
const SHOWN = new Set(['/dev/stdout', '/dev/stderr', '/dev/tty'])

const segLen = (g: Seg) => ('opaque' in g ? g.opaque : g.from === null ? null : g.to - g.from + 1)

const fuzz = (g: Seg): Seg => ('opaque' in g ? { opaque: null } : { path: g.path, abs: g.abs, from: null })

/** Lines `a`–`b` (1-based, inclusive; `b` may be Infinity) of a stream. Past a part of unknown length nothing can be placed, so the rest is kept unplaced. */
function slice(stream: readonly Seg[], a: number, b: number): Seg[] {
  const out: Seg[] = []
  let pos = 0
  for (let k = 0; k < stream.length; k++) {
    const g = stream[k]!
    const n = segLen(g)
    if (n === null) {
      if (pos < b) out.push(...stream.slice(k).map(fuzz))
      break
    }
    const lo = Math.max(a, pos + 1)
    const hi = Math.min(b, pos + n)
    if (lo <= hi) out.push('opaque' in g ? { opaque: hi - lo + 1 } : { path: g.path, abs: g.abs, from: g.from! + lo - pos - 1, to: g.from! + hi - pos - 1 })
    pos += n
    if (pos >= b) break
  }
  return out
}

function streamLen(s: readonly Seg[]): number | null {
  let n = 0
  for (const g of s) {
    const l = segLen(g)
    if (l === null) return null
    n += l
  }
  return n
}

/** The last `n` lines of a stream, or its lines from `n` on (`tail -n +n`). */
function tail(s: readonly Seg[], n: number, isFrom: boolean): Seg[] {
  if (isFrom) return slice(s, n, Infinity)
  const len = streamLen(s)
  return len === null ? s.map(fuzz) : slice(s, Math.max(1, len - n + 1), len)
}

const isOption = (w: Word) => w.text.startsWith('-') && w.text !== '-'

/** `-n 20`, `-n20`, `-20`, `--lines=20`, `-n +5`: head's and tail's count, and their files. null for bytes or a count it can't read. */
function countOpt(args: readonly Word[]): { n: number; isFrom: boolean; files: Word[] } | null {
  let n = 10
  let isFrom = false
  const files: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!.text
    let v: string | undefined
    if (t === '-n' || t === '--lines') v = args[++k]?.text
    else if (/^-n./.test(t)) v = t.slice(2)
    else if (t.startsWith('--lines=')) v = t.slice(8)
    else if (/^-\d+$/.test(t)) v = t.slice(1)
    else if (t.startsWith('-c') || t.startsWith('--bytes')) return null
    else if (isOption(args[k]!)) continue
    else files.push(args[k]!)
    if (v !== undefined) {
      if (!/^\+?\d+$/.test(v)) return null
      isFrom = v.startsWith('+')
      n = Number(v.replace('+', ''))
    }
  }
  return { n, isFrom, files }
}

type SedPlan = { kind: 'ranges'; ranges: [number, number][] } | { kind: 'whole' } | { kind: 'edit' } | null

/** What `sed` prints: line ranges for `-n 'A,Bp'`, the first lines for `Nq`, the whole input otherwise; null when it can't tell. */
function sedPlan(args: readonly Word[]): { plan: SedPlan; files: Word[] } {
  let quiet = false
  const scripts: string[] = []
  const files: Word[] = []
  let hasE = false
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!.text
    if (t === '-n' || t === '--quiet' || t === '--silent') quiet = true
    else if (/^-i|^--in-place/.test(t)) return { plan: { kind: 'edit' }, files: [] }
    else if (t === '-e' || t === '--expression') {
      scripts.push(args[++k]?.text ?? '')
      hasE = true
    } else if (t.startsWith('--expression=')) {
      scripts.push(t.slice(13))
      hasE = true
    } else if (t === '-f' || t === '--file') return { plan: null, files: args.slice(k + 2).filter(w => !isOption(w)) }
    else if (/^-[a-zA-Z]+$/.test(t)) quiet = quiet || t.includes('n')
    else if (!hasE && !scripts.length) scripts.push(t)
    else files.push(args[k]!)
  }
  const ranges: [number, number][] = []
  const at = (s: string) => (s === '$' ? Infinity : Number(s))
  for (const part of scripts.join(';').split(/[;\n]/).map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d+|\$)(?:\s*,\s*(\d+|\$|\+\d+))?\s*([pq])$/.exec(part)
    if (!m) return { plan: quiet ? null : { kind: 'whole' }, files }
    const a = at(m[1]!)
    const b = m[2] === undefined ? a : m[2].startsWith('+') ? a + Number(m[2].slice(1)) : at(m[2])
    if (m[3] === 'q') {
      if (!quiet) return { plan: { kind: 'ranges', ranges: [[1, a]] }, files }
      continue
    }
    ranges.push([a, b])
  }
  return { plan: quiet ? { kind: 'ranges', ranges } : { kind: 'whole' }, files }
}

/** The lines `awk` prints when its program only picks them by number: `NR>=10 && NR<=20`, `NR==5,NR==9`. */
function awkRange(program: string): [number, number] | null {
  const cond = program.replace(/\{\s*(print(\s+\$0)?)?\s*;?\s*\}\s*$/, '').trim()
  const between = /^NR\s*==\s*(\d+)\s*,\s*NR\s*==\s*(\d+)$/.exec(cond)
  if (between) return [Number(between[1]), Number(between[2])]
  let a = 1
  let b = Infinity
  for (const part of cond.split('&&').map(s => s.trim())) {
    const m = /^NR\s*(>=|>|<=|<|==)\s*(\d+)$/.exec(part)
    if (!m) return null
    const v = Number(m[2])
    if (m[1] === '>=') a = Math.max(a, v)
    else if (m[1] === '>') a = Math.max(a, v + 1)
    else if (m[1] === '<=') b = Math.min(b, v)
    else if (m[1] === '<') b = Math.min(b, v - 1)
    else {
      a = v
      b = v
    }
  }
  return a <= b ? [a, b] : null
}

/**
 * What a command line does with files, run from `cwd` (absolute): which lines of
 * which files reach the agent, which files it only searched, and where it ends up.
 * `totals` gives a file's line count by its absolute path, when known. `visible`,
 * when the output was cut to a preview, is how many lines of it the agent saw.
 */
export function shellEffects(
  repo: Repo,
  command: string,
  cwd: string,
  totals: (abs: string) => number | undefined = () => undefined,
  visible?: number,
): ShellEffects {
  const searched = new Set<string>()
  const places = new Set<string>([cwd])
  const vars = new Map<string, Word[]>()
  const shown: Seg[] = []

  /** The files a word names: one path, a glob's indexed matches, or a for-loop variable's words. */
  const filesOf = (w: Word): FileRef[] => {
    const loop = /^\$\{?(\w+)\}?$/.exec(w.text)
    if (loop && vars.has(loop[1]!)) return vars.get(loop[1]!)!.flatMap(filesOf)
    if (w.isDynamic || w.text.length > 400 || w.text.endsWith('/')) return []
    const abs = absolute(w.text, cwd, repo.home)
    if (!abs) return []
    places.add(abs.slice(0, abs.lastIndexOf('/')) || '/')
    const rel = logical(repo, abs)
    if (rel === null) return []
    if (!w.isGlob) return [{ path: rel, abs }]
    const test = globTest(rel)
    const c = checkoutOf(repo, abs)!
    return repo.files
      .filter(f => test.test(f.path) && (!c.prefix || f.path.startsWith(c.prefix + '/')))
      .map(f => ({ path: f.path, abs: c.dir + '/' + (c.prefix ? f.path.slice(c.prefix.length + 1) : f.path) }))
  }
  /** A file's every line. A name that is no file (a typo, a grep pattern) prints nothing of one. */
  const whole = (f: FileRef): Seg => {
    const n = totals(f.abs)
    if (n !== undefined) return { ...f, from: 1, to: Math.max(1, n) }
    return repo.byPath.has(f.path) ? { ...f, from: null } : { opaque: null }
  }

  /** A stage's output: from its file arguments, or from its stdin (`input`) when it names none. */
  const stage = (name: string, args: Word[], input: Seg[] | null): Seg[] | null => {
    const source = (files: Word[]): Seg[] => {
      const fs = files.flatMap(filesOf)
      return files.length || !input ? fs.map(whole) : input
    }
    if (name === 'head' || name === 'tail') {
      const o = countOpt(args)
      // Bytes, or a count it can't read: the files, without the values their options took.
      if (!o) return source(args.filter((w, k) => !isOption(w) && !/^(-[nc]|--lines|--bytes)$/.test(args[k - 1]?.text ?? ''))).map(fuzz)
      const cut = (s: Seg[]) => (name === 'head' ? slice(s, 1, o.n) : tail(s, o.n, o.isFrom))
      // Files named are cut one by one; stdin is one stream.
      return o.files.length || !input ? o.files.flatMap(filesOf).flatMap(f => cut([whole(f)])) : cut(input)
    }
    if (name === 'sed') {
      const { plan, files } = sedPlan(args)
      if (plan?.kind === 'edit') return null
      const s = source(files)
      if (!plan) return s.map(fuzz)
      return plan.kind === 'whole' ? s : plan.ranges.flatMap(([a, b]) => slice(s, a, b))
    }
    if (name === 'awk') {
      const rest = args.filter((w, k) => !isOption(w) && !['-F', '-v', '-f'].includes(args[k - 1]?.text ?? ''))
      const r = awkRange(rest[0]?.text ?? '')
      const s = source(rest.slice(1))
      return r ? slice(s, r[0], r[1]) : s.map(fuzz)
    }
    if (name === 'tee') return input ?? []
    if (WHOLE.has(name)) {
      const s = source(args.filter(w => !isOption(w)))
      return LINEWISE.has(name) ? s : s.map(fuzz)
    }
    if (name === 'echo' || name === 'printf') return [{ opaque: 1 }]
    return null
  }

  for (const pipeline of parseShell(command)) {
    let stream: Seg[] | null = null
    let isShown = true
    for (const cmd of pipeline) {
      let argv = cmd.argv
      while (argv.length && (PREFIX.has(argv[0]!.text) || /^\w+=/.test(argv[0]!.text))) argv = argv.slice(1)
      const name = (argv[0]?.text ?? '').split('/').pop()!.replace(/^g(?=sed$|awk$|head$|tail$|cat$|grep$)/, '')
      const args = argv.slice(1)
      const fileIn = cmd.redirects.filter(r => r.op === '<' && r.target).flatMap(r => filesOf(r.target!)).map(whole)
      const input: Seg[] | null = fileIn.length ? fileIn : stream
      isShown = !cmd.redirects.some(
        r => (r.fd === 1 || r.fd === -1) && ['>', '>>', '>|', '&>', '&>>'].includes(r.op) && r.target && !SHOWN.has(r.target.text),
      )
      if (name === 'cd' || name === 'pushd') {
        const to = args.find(w => !isOption(w))
        const next = to ? (to.isDynamic ? null : absolute(to.text, cwd, repo.home)) : repo.home || null
        if (next) cwd = next
        places.add(cwd)
        stream = null
      } else if (name === 'for' && args[1]?.text === 'in') {
        vars.set(args[0]!.text, args.slice(2))
        stream = null
      } else if (SEARCHING.has(name) || (name === 'git' && args[0]?.text === 'grep')) {
        // The files searched, or the stream piped in: named either way, not read.
        // A grep's first word is its pattern, unless -e or -f gave it.
        const hasPattern = name !== 'wc' && !args.some(w => /^-[a-zA-Z]*[ef]$|^--(regexp|file)\b/.test(w.text))
        const words = name === 'git' ? [] : args.filter(w => !isOption(w)).slice(hasPattern ? 1 : 0)
        const files = words.flatMap(filesOf)
        const from: FileRef[] = files.length || words.length ? files : (input ?? []).flatMap(g => ('opaque' in g ? [] : [g]))
        for (const f of from) if (repo.byPath.has(f.path) || totals(f.abs) !== undefined) searched.add(f.path)
        stream = [{ opaque: null }]
      } else stream = (name ? stage(name, args, input) : input) ?? [{ opaque: null }]
    }
    if (stream && isShown) shown.push(...stream)
  }

  const reads: ShellRead[] = []
  for (const g of visible === undefined ? shown : slice(shown, 1, visible)) {
    if (!('opaque' in g)) reads.push({ path: g.path, abs: g.abs, range: g.from === null ? null : [g.from, g.to] })
  }
  const readPaths = new Set(reads.map(r => r.path))
  return { reads, searched: [...searched].filter(p => !readPaths.has(p)), cwd, places: [...places] }
}
