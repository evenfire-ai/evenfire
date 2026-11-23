/**
 * Rules that keep `git_read` from returning the content of protected platform
 * paths, in any revision, the index or the worktree.
 *
 * "Protected content" is a blob reached under a protected path name, or a blob
 * reached with no path at all (an object id), since no rule can tell whose it
 * is. Names of protected paths may still appear in listings.
 */
import {
  GFS_DOWNLOADS_TRASH_PREFIX,
  PROTECTED_WORKSPACE_DIRS,
  RETIRED_GFS_DOWNLOAD_STORE_PREFIX,
  STATE_DB_NAME_PREFIX,
  isProtectedWorkspacePath,
} from '../../../workspace/protectedPaths'

/** Subcommands whose revisions must peel to a commit (G-P4). */
export const PEEL_SUBCOMMANDS: ReadonlySet<string> = new Set(['show', 'cat_file', 'diff', 'grep'])

/** Subcommands that accept `REV:PATH` (G-P3). */
const REV_PATH_SUBCOMMANDS: ReadonlySet<string> = new Set(['show', 'cat_file'])

/** A revision word: no leading `-`, no whitespace or NUL anywhere. */
export const REVISION_PATTERN = /^[^-\s\0][^\s\0]*$/

const PLAIN_NAME = /^[A-Za-z0-9._-]+$/
const EXCLUDE = ':(exclude,top,glob)'

/**
 * The exclusion pathspecs appended to every content call (G-P1). Each magic
 * word is load-bearing: without `/**` the directory forms leak, without `glob`
 * the root `state.db` and the directory forms leak, and without `top` a call
 * from a subdirectory leaks every form outside it. Built from the protected
 * path constants, so a protected name added there is excluded here too.
 */
export function protectedExcludePathspecs(): readonly string[] {
  const names = [
    ...PROTECTED_WORKSPACE_DIRS,
    RETIRED_GFS_DOWNLOAD_STORE_PREFIX,
    GFS_DOWNLOADS_TRASH_PREFIX,
    STATE_DB_NAME_PREFIX,
  ]
  for (const name of names) {
    // A glob character in a protected name would change what the exclusion matches.
    if (!PLAIN_NAME.test(name)) throw new Error('protected name is not a plain path segment')
  }
  const specs: string[] = []
  for (const dir of PROTECTED_WORKSPACE_DIRS) {
    specs.push(`${EXCLUDE}**/${dir}`, `${EXCLUDE}**/${dir}/**`)
  }
  for (const prefix of [RETIRED_GFS_DOWNLOAD_STORE_PREFIX, GFS_DOWNLOADS_TRASH_PREFIX]) {
    specs.push(`${EXCLUDE}**/${prefix}*`, `${EXCLUDE}**/${prefix}*/**`)
  }
  specs.push(`${EXCLUDE}**/${STATE_DB_NAME_PREFIX}*`)
  return specs
}

/**
 * The lexical rule for a path inside a `REV:PATH` word (G-P3). Git resolves
 * `./` and `../` against the cwd, so those forms are refused rather than
 * judged. A `:` inside the path is refused too: git's split is then hard to
 * predict.
 */
function checkRevisionPath(revPath: string): 'bad_path' | 'protected_path' | null {
  if (revPath.length === 0 || revPath.includes(':')) return 'bad_path'
  if (revPath.startsWith('/')) return 'bad_path'
  const segments = revPath.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    return 'bad_path'
  }
  return isProtectedWorkspacePath(revPath) ? 'protected_path' : null
}

/**
 * The lexical check of one revision word for a subcommand. `REV:PATH` is
 * accepted only on `show` and `cat_file`, never with braces (`stash@{0}:a`),
 * never as `:/text` or `:!text`, and only for an unprotected path. A non-empty
 * `REV` must still peel to a commit at run time (G-P4).
 */
export function checkRevisionWord(
  revision: string,
  subcommand: string
): 'bad_revision' | 'bad_path' | 'protected_path' | null {
  if (!REVISION_PATTERN.test(revision)) return 'bad_revision'
  const colon = revision.indexOf(':')
  if (colon < 0) return null
  if (!REV_PATH_SUBCOMMANDS.has(subcommand) || revision.includes('{')) return 'bad_revision'
  const left = revision.slice(0, colon)
  let revPath = revision.slice(colon + 1)
  if (left === '') {
    // The index: `:PATH`, or `:N:PATH` with N in 0–3.
    if (revPath.startsWith('/') || revPath.startsWith('!')) return 'bad_revision'
    const stage = /^([0-3]):/.exec(revPath)
    if (stage) revPath = revPath.slice(stage[0].length)
  }
  return checkRevisionPath(revPath)
}

/** True when a revision word names a path (`REV:PATH` or an index path). */
export function isRevisionPath(revision: string): boolean {
  return revision.includes(':')
}

/**
 * True for a call that can return file content: `show`, `diff`, `grep`,
 * `blame`, `cat_file`, or `log` with a patch, a word diff, a context size or a
 * pickaxe. Other calls return names and ids only.
 */
export function isContentCall(params: {
  subcommand: string
  options: ReadonlySet<string>
  unified?: number
  pickaxe?: string
}): boolean {
  switch (params.subcommand) {
    case 'show':
    case 'diff':
    case 'grep':
    case 'blame':
    case 'cat_file':
      return true
    case 'log':
      return (
        params.options.has('patch') ||
        params.options.has('word_diff') ||
        params.unified !== undefined ||
        params.pickaxe !== undefined
      )
    default:
      return false
  }
}

const DATE_MODIFIER = '(?::relative|:short|:iso|:iso-strict|:unix)?'
const FOR_EACH_REF_ATOMS: readonly RegExp[] = [
  /^refname(?::short|:lstrip=-?\d{1,4}|:rstrip=-?\d{1,4})?$/,
  /^objectname(?::short)?$/,
  /^(?:objecttype|objectsize|HEAD|symref)$/,
  /^upstream(?::short|:track|:trackshort)?$/,
  /^push(?::short)?$/,
  /^(?:authorname|authoremail|committername|committeremail|taggername|taggeremail|creator)$/,
  new RegExp(`^(?:authordate|committerdate|taggerdate|creatordate)${DATE_MODIFIER}$`),
  /^(?:subject|contents:subject)$/,
]

function allowedAtom(atom: string): boolean {
  const name = atom.startsWith('*') ? atom.slice(1) : atom
  return FOR_EACH_REF_ATOMS.some(pattern => pattern.test(name))
}

/**
 * G-P7: a `for_each_ref` format may use only name, id, date, person and
 * subject atoms. `%(raw)` on a tag of a protected blob prints the blob, so
 * every other atom is refused. Outside atoms only literal text, `%%` and `%xx`
 * hex escapes are allowed.
 */
export function checkForEachRefFormat(format: string): boolean {
  let i = 0
  while (i < format.length) {
    if (format[i] !== '%') {
      i++
      continue
    }
    const next = format[i + 1]
    if (next === '%') {
      i += 2
    } else if (/^[0-9a-fA-F]{2}$/.test(format.slice(i + 1, i + 3))) {
      i += 3
    } else if (next === '(') {
      const close = format.indexOf(')', i + 2)
      if (close < 0 || !allowedAtom(format.slice(i + 2, close))) return false
      i = close + 1
    } else {
      return false
    }
  }
  return true
}

/** `log` and `show` formats: no signature placeholders (they run gpg). */
export function checkLogFormat(format: string): boolean {
  return !format.includes('%G') && !format.toLowerCase().includes('signature')
}
