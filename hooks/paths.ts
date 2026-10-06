/** A file the index knows, by its path relative to the repo root. */
export type FileEntry = { path: string }

/** The repo as the map indexes it: its root and its files, with a lookup by path. */
export type Repo = { root: string; files: FileEntry[]; byPath: Map<string, number> }

export function makeRepo(root: string, files: FileEntry[]): Repo {
  return { root, files, byPath: new Map(files.map((f, i) => [f.path, i])) }
}

/** A path as the map knows it (relative to the repo root), or null when it's outside the repo. */
export function relative(repo: Repo, path: string, base = ''): string | null {
  const root = repo.root
  const p = path.trim().replace(/^["'`]+|["'`,;)]+$/g, '')
  if (!p || p === '-' || p.startsWith('-')) return null
  let parts: string[]
  if (p.startsWith('/')) {
    if (p === root) return ''
    if (!p.startsWith(root + '/')) return null
    parts = p.slice(root.length + 1).split('/')
  } else if (p.startsWith('~')) {
    return null
  } else {
    parts = [...(base ? base.split('/') : []), ...p.split('/')]
  }
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
    } else out.push(part)
  }
  return out.join('/')
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

/** The indexed files a token names, seen from `base`: one path, a glob's matches, or none. */
function resolveToken(repo: Repo, token: string, base: string, into: Set<string>) {
  if (!token || token.length > 400) return
  const rel = relative(repo, token.split(':')[0]!, base)
  if (!rel) return
  if (repo.byPath.has(rel)) into.add(rel)
  else if (rel.includes('*') || rel.includes('?')) {
    const test = globTest(rel)
    for (const f of repo.files) if (test.test(f.path)) into.add(f.path)
  }
}

/** Commands that name files without reading them: their arguments aren't reads (their output can still be hits). */
const NOT_READING = new Set(['ls', 'find', 'cd', 'pushd', 'echo', 'printf', 'mkdir', 'rmdir', 'touch', 'rm', 'mv', 'cp', 'ln', 'stat', 'test', '[', 'which', 'du', 'tree', 'pwd', 'git', 'chmod', 'file'])

const TOKEN_SPLIT = /[\s"'`=(<>{}]+/

/** Commands that look inside files but print only matches, names or counts: their files are hits, not reads. */
const SEARCHING = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'wc'])

/**
 * The files a shell command names, following its `cd`s: `cd src && cat *` reads every
 * file in src, `wc -l *` and `grep -l x *` only search them. Also answers where the
 * command ends up, to read its output from there.
 */
export function pathsInCommand(repo: Repo, command: string): { paths: string[]; searched: string[]; cwd: string } {
  const found = new Set<string>()
  const searched = new Set<string>()
  let cwd = ''
  for (const segment of command.split(/&&|\|\||;|\n|\|/)) {
    const tokens = segment.trim().split(TOKEN_SPLIT).filter(Boolean)
    if (tokens[0] === 'cd') {
      const next = tokens[1] ? relative(repo, tokens[1], cwd) : ''
      cwd = next ?? cwd
      continue
    }
    if (NOT_READING.has(tokens[0] ?? '')) continue
    const into = SEARCHING.has(tokens[0] ?? '') ? searched : found
    // A token ending in / names a directory, never the files in it.
    for (const token of tokens) if (!token.endsWith('/')) resolveToken(repo, token, cwd, into)
  }
  return { paths: [...found], searched: [...searched].filter(p => !found.has(p)), cwd }
}

/** `  123 path` (wc), or `-rw-r--r--  1 me staff 812 Oct 6 12:00 path` (ls -l): the path after the count or listing. */
const LINE_LEAD = /^\s*(?:\d+\s+|[-dlcbps][rwxsStT-]{9}[@+.]?\s+(?:\S+\s+){7})?/

/**
 * Every indexed path that starts a line of `text`, read from `base`: the shape of
 * search hits (`path:12: …`), listings and line counts. A path quoted inside a
 * file's content (`![](docs/home.png)`) starts no line, so a `cat` names nothing.
 */
export function pathsIn(repo: Repo, text: string, base = '', limit = 400): string[] {
  const found = new Set<string>()
  for (const line of text.split('\n').slice(0, limit)) {
    const rest = line.replace(LINE_LEAD, '')
    const token = rest.split(TOKEN_SPLIT)[0] ?? ''
    if (token && !token.includes('*')) resolveToken(repo, token, base, found)
  }
  return [...found]
}

