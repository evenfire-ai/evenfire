/**
 * The `git_read` definition and its parameter validation.
 *
 * Validation is lexical and never echoes input bytes: every failure is one of
 * the fixed texts in `GIT_READ_VALIDATION_TEXTS`. Run-time checks (realpaths,
 * the peel to a commit, the follow check) live in the preflight.
 */
import * as path from 'path'
import { isProtectedWorkspacePath } from '../../../workspace/protectedPaths'
import type { FileReads } from '../../interfaces'
import type { ValidationResult } from '../../types'
import {
  REVISION_PATTERN,
  checkForEachRefFormat,
  checkLogFormat,
  checkRevisionWord,
  isContentCall,
  isRevisionPath,
} from './protectedContent'

export const GIT_READ_TOOL_NAME = 'git_read'

export const GIT_READ_SUBCOMMANDS = [
  'status',
  'log',
  'show',
  'diff',
  'blame',
  'grep',
  'branch',
  'tag',
  'rev_parse',
  'ls_files',
  'ls_tree',
  'describe',
  'stash_list',
  'shortlog',
  'rev_list',
  'merge_base',
  'cat_file',
  'reflog',
  'for_each_ref',
  'worktree_list',
  'remote',
] as const
export type GitReadSubcommand = (typeof GIT_READ_SUBCOMMANDS)[number]

export const GIT_READ_OPTIONS = [
  'short',
  'branch',
  'porcelain',
  'oneline',
  'patch',
  'stat',
  'name_only',
  'name_status',
  'cached',
  'ignore_case',
  'line_number',
  'all',
  'remotes',
  'verbose',
  'follow',
  'graph',
  'word_diff',
  'abbrev_ref',
  'show_toplevel',
  'tags',
  'always',
  'recursive',
  'show_current',
  'count',
  'get_url',
] as const
export type GitReadOption = (typeof GIT_READ_OPTIONS)[number]

const GIT_READ_SORTS = [
  'refname',
  '-refname',
  'creatordate',
  '-creatordate',
  'committerdate',
  '-committerdate',
  'version:refname',
  '-version:refname',
] as const

/**
 * The definition as the provider-neutral `{name, description, parameters}`
 * JSON. It must stay within the 2,048-byte native discovery budget.
 */
export const GIT_READ_DEFINITION = {
  name: GIT_READ_TOOL_NAME,
  description:
    'Read-only git in a workspace repository (no shell). Content of protected platform paths is never returned. Errors are fixed text.',
  parameters: {
    type: 'object',
    properties: {
      subcommand: { type: 'string', enum: [...GIT_READ_SUBCOMMANDS] },
      directory: { type: 'string', description: 'Workspace-relative repo dir' },
      revisions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Commits, ranges, REV:path',
      },
      paths: { type: 'array', items: { type: 'string' } },
      options: { type: 'array', items: { type: 'string', enum: [...GIT_READ_OPTIONS] } },
      pattern: { type: 'string', description: 'grep or ref pattern' },
      format: { type: 'string' },
      max_count: { type: 'integer', minimum: 1, maximum: 1000 },
      line_range: { type: 'string', description: 'blame -L, e.g. 10,20' },
      since: { type: 'string' },
      until: { type: 'string' },
      author: { type: 'string' },
      grep: { type: 'string', description: 'log message pattern' },
      pickaxe: { type: 'string', description: 'log -S string' },
      unified: { type: 'integer', minimum: 0, maximum: 100 },
      sort: { type: 'string', enum: [...GIT_READ_SORTS] },
      contains: { type: 'string' },
      merged: { type: 'string' },
    },
    required: ['subcommand'],
    additionalProperties: false,
  },
} as const

export type GitReadValidationCategory =
  | 'bad_revision'
  | 'bad_path'
  | 'bad_format'
  | 'bad_value'
  | 'option_not_supported'
  | 'protected_path'

export const GIT_READ_VALIDATION_TEXTS: Readonly<Record<GitReadValidationCategory, string>> = {
  bad_revision:
    "Revisions must name commits or ranges, without spaces or a leading '-'. COMMIT:path is accepted only by show and cat_file, without braces.",
  bad_path: "Paths must be workspace-relative, without '..' or a leading '-', ':' or '/'.",
  bad_format: 'Format strings may not use %G signature placeholders.',
  bad_value: 'A field is out of range, longer than 256 bytes, or contains a newline.',
  option_not_supported: 'That option or field is not supported for this subcommand.',
  protected_path: 'That path is platform-managed state; git_read does not return its content.',
}

/** The `bad_format` text for a `for_each_ref` atom off the allowlist. */
export const GIT_READ_FOR_EACH_REF_FORMAT_TEXT =
  'Format strings may use only name, id, date, person and subject atoms.'

/** The parameters after validation: nulls dropped, defaults filled. */
export interface GitReadParams {
  readonly subcommand: GitReadSubcommand
  /** Normalized workspace-relative directory; `.` by default. */
  readonly directory: string
  readonly revisions: readonly string[]
  readonly paths: readonly string[]
  readonly options: ReadonlySet<GitReadOption>
  readonly pattern?: string
  readonly format?: string
  readonly maxCount?: number
  readonly lineRange?: string
  readonly since?: string
  readonly until?: string
  readonly author?: string
  readonly grep?: string
  readonly pickaxe?: string
  readonly unified?: number
  readonly sort?: string
  readonly contains?: string
  readonly merged?: string
}

export type GitReadParamCheck =
  | { ok: true; params: GitReadParams }
  | { ok: false; category: GitReadValidationCategory; text: string }

const OPTION_SUBCOMMANDS: Readonly<Record<GitReadOption, readonly GitReadSubcommand[]>> = {
  short: ['status'],
  branch: ['status'],
  porcelain: ['status'],
  oneline: ['log'],
  patch: ['log'],
  graph: ['log'],
  follow: ['log'],
  stat: ['log', 'show', 'diff'],
  name_only: ['log', 'show', 'diff', 'ls_tree'],
  name_status: ['log', 'show', 'diff'],
  word_diff: ['log', 'diff'],
  cached: ['diff'],
  ignore_case: ['grep'],
  line_number: ['grep'],
  count: ['grep'],
  all: ['log', 'branch', 'rev_list'],
  remotes: ['branch'],
  show_current: ['branch'],
  verbose: ['branch', 'remote'],
  abbrev_ref: ['rev_parse'],
  show_toplevel: ['rev_parse'],
  tags: ['describe'],
  always: ['describe'],
  recursive: ['ls_tree'],
  get_url: ['remote'],
}

type StringField =
  | 'pattern'
  | 'format'
  | 'line_range'
  | 'since'
  | 'until'
  | 'author'
  | 'grep'
  | 'pickaxe'
  | 'sort'
  | 'contains'
  | 'merged'
type IntegerField = 'max_count' | 'unified'

const FIELD_SUBCOMMANDS: Readonly<
  Record<StringField | IntegerField | 'paths', readonly GitReadSubcommand[]>
> = {
  paths: ['status', 'log', 'show', 'diff', 'grep', 'ls_files', 'ls_tree', 'blame'],
  pattern: ['grep', 'branch', 'tag', 'for_each_ref'],
  format: ['log', 'show', 'for_each_ref'],
  max_count: ['log', 'reflog', 'for_each_ref'],
  line_range: ['blame'],
  since: ['log'],
  until: ['log'],
  author: ['log'],
  grep: ['log'],
  pickaxe: ['log'],
  unified: ['log', 'diff'],
  sort: ['branch', 'tag', 'for_each_ref'],
  contains: ['branch', 'tag'],
  merged: ['branch', 'tag'],
}

/** How many revisions each subcommand takes (`[min, max]`). */
const REVISION_COUNTS: Readonly<Record<GitReadSubcommand, readonly [number, number]>> = {
  status: [0, 0],
  log: [0, 8],
  show: [0, 8],
  diff: [0, 8],
  blame: [0, 1],
  grep: [0, 8],
  branch: [0, 0],
  tag: [0, 0],
  rev_parse: [0, 8],
  ls_files: [0, 0],
  ls_tree: [0, 1],
  describe: [0, 8],
  stash_list: [0, 0],
  shortlog: [0, 1],
  rev_list: [0, 8],
  merge_base: [2, 2],
  cat_file: [1, 1],
  reflog: [0, 8],
  for_each_ref: [0, 0],
  worktree_list: [0, 0],
  remote: [0, 1],
}

const STRING_FIELDS: readonly StringField[] = [
  'pattern',
  'format',
  'line_range',
  'since',
  'until',
  'author',
  'grep',
  'pickaxe',
  'sort',
  'contains',
  'merged',
]
const KNOWN_KEYS: ReadonlySet<string> = new Set(
  Object.keys(GIT_READ_DEFINITION.parameters.properties)
)
const MAX_FIELD_BYTES = 256
const MAX_REVISIONS = 8
const MAX_PATHS = 32
const LINE_RANGE = /^(?:\d{1,7},\d{1,7}|\d{1,7},\+\d{1,7})$/
const REMOTE_NAME = /^[A-Za-z0-9._-]{1,64}$/

function refuse(category: GitReadValidationCategory, text?: string): GitReadParamCheck {
  return { ok: false, category, text: text ?? GIT_READ_VALIDATION_TEXTS[category] }
}

function hasLineBreakOrNul(value: string): boolean {
  return /[\0\n\r]/.test(value)
}

/** The lexical rule shared by `directory` and `paths`. */
function lexicalPathProblem(value: string): 'bad_path' | null {
  if (value.length === 0 || hasLineBreakOrNul(value)) return 'bad_path'
  if (value.startsWith('-') || value.startsWith(':') || value.startsWith('/')) return 'bad_path'
  if (value.split('/').includes('..')) return 'bad_path'
  return null
}

/** Explicit `null` counts as absent, as for `json_transform`. */
function present(raw: Record<string, unknown>, key: string): boolean {
  return raw[key] !== undefined && raw[key] !== null
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) return null
  return value as string[]
}

/**
 * Validates and normalizes `git_read` parameters. The first failure wins;
 * nothing from the input appears in the text.
 */
export function checkGitReadParams(raw: Record<string, unknown>): GitReadParamCheck {
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key) && present(raw, key)) return refuse('option_not_supported')
  }
  const subcommand = raw.subcommand
  if (
    typeof subcommand !== 'string' ||
    !(GIT_READ_SUBCOMMANDS as readonly string[]).includes(subcommand)
  ) {
    return refuse('option_not_supported')
  }
  const sub = subcommand as GitReadSubcommand

  let directory = '.'
  if (present(raw, 'directory')) {
    if (typeof raw.directory !== 'string') return refuse('bad_path')
    if (raw.directory !== '.') {
      if (lexicalPathProblem(raw.directory)) return refuse('bad_path')
      if (isProtectedWorkspacePath(raw.directory)) return refuse('protected_path')
    }
    directory = path.posix.normalize(raw.directory)
  }

  const options = new Set<GitReadOption>()
  if (present(raw, 'options')) {
    const list = stringArray(raw.options)
    if (list === null) return refuse('option_not_supported')
    for (const option of list) {
      if (!(GIT_READ_OPTIONS as readonly string[]).includes(option)) {
        return refuse('option_not_supported')
      }
      if (!OPTION_SUBCOMMANDS[option as GitReadOption].includes(sub)) {
        return refuse('option_not_supported')
      }
      options.add(option as GitReadOption)
    }
  }

  const strings: Partial<Record<StringField, string>> = {}
  for (const field of STRING_FIELDS) {
    if (!present(raw, field)) continue
    const value = raw[field]
    if (typeof value !== 'string') return refuse('bad_value')
    if (!FIELD_SUBCOMMANDS[field].includes(sub)) return refuse('option_not_supported')
    if (Buffer.byteLength(value, 'utf8') > MAX_FIELD_BYTES || hasLineBreakOrNul(value)) {
      return refuse('bad_value')
    }
    strings[field] = value
  }

  const integers: Partial<Record<IntegerField, number>> = {}
  for (const [field, min, max] of [
    ['max_count', 1, 1000],
    ['unified', 0, 100],
  ] as const) {
    if (!present(raw, field)) continue
    const value = raw[field]
    if (!FIELD_SUBCOMMANDS[field].includes(sub)) return refuse('option_not_supported')
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return refuse('bad_value')
    }
    integers[field] = value
  }

  let revisions: string[] = []
  if (present(raw, 'revisions')) {
    const list = stringArray(raw.revisions)
    if (list === null || list.length > MAX_REVISIONS) return refuse('bad_revision')
    revisions = list
  }
  const [minRevisions, maxRevisions] = REVISION_COUNTS[sub]
  if (sub === 'remote') {
    const wanted = options.has('get_url') ? 1 : 0
    if (revisions.length !== wanted) return refuse('bad_revision')
    if (wanted === 1 && !REMOTE_NAME.test(revisions[0])) return refuse('bad_revision')
    if (options.has('get_url') && options.has('verbose')) return refuse('option_not_supported')
  } else {
    if (revisions.length < minRevisions || revisions.length > maxRevisions) {
      return refuse('bad_revision')
    }
    for (const revision of revisions) {
      const problem = checkRevisionWord(revision, sub)
      if (problem) return refuse(problem)
    }
  }

  let paths: string[] = []
  if (present(raw, 'paths')) {
    const list = stringArray(raw.paths)
    if (list === null || list.length > MAX_PATHS) return refuse('bad_path')
    if (list.length > 0 && !FIELD_SUBCOMMANDS.paths.includes(sub)) {
      return refuse('option_not_supported')
    }
    for (const entry of list) {
      if (lexicalPathProblem(entry)) return refuse('bad_path')
      if (isProtectedWorkspacePath(path.posix.join(directory, entry))) {
        return refuse('protected_path')
      }
    }
    paths = list
  }

  if (sub === 'blame' && paths.length !== 1) return refuse('bad_path')
  if (sub === 'grep' && strings.pattern === undefined) return refuse('option_not_supported')
  if (options.has('show_current') && (options.size > 1 || hasRefListFields(strings))) {
    return refuse('option_not_supported')
  }
  if (options.has('follow')) {
    if (paths.length !== 1 || revisions.some(isRevisionPath)) {
      return refuse('option_not_supported')
    }
  }
  for (const field of ['contains', 'merged'] as const) {
    const value = strings[field]
    if (value !== undefined && (!REVISION_PATTERN.test(value) || value.includes(':'))) {
      return refuse('bad_revision')
    }
  }
  if (strings.line_range !== undefined && !LINE_RANGE.test(strings.line_range)) {
    return refuse('bad_value')
  }
  if (strings.sort !== undefined && !(GIT_READ_SORTS as readonly string[]).includes(strings.sort)) {
    return refuse('bad_value')
  }
  if (strings.format !== undefined) {
    if (sub === 'for_each_ref') {
      if (!checkForEachRefFormat(strings.format)) {
        return refuse('bad_format', GIT_READ_FOR_EACH_REF_FORMAT_TEXT)
      }
    } else if (!checkLogFormat(strings.format)) {
      return refuse('bad_format')
    }
  }

  return {
    ok: true,
    params: {
      subcommand: sub,
      directory,
      revisions,
      paths,
      options,
      ...(strings.pattern !== undefined ? { pattern: strings.pattern } : {}),
      ...(strings.format !== undefined ? { format: strings.format } : {}),
      ...(integers.max_count !== undefined ? { maxCount: integers.max_count } : {}),
      ...(strings.line_range !== undefined ? { lineRange: strings.line_range } : {}),
      ...(strings.since !== undefined ? { since: strings.since } : {}),
      ...(strings.until !== undefined ? { until: strings.until } : {}),
      ...(strings.author !== undefined ? { author: strings.author } : {}),
      ...(strings.grep !== undefined ? { grep: strings.grep } : {}),
      ...(strings.pickaxe !== undefined ? { pickaxe: strings.pickaxe } : {}),
      ...(integers.unified !== undefined ? { unified: integers.unified } : {}),
      ...(strings.sort !== undefined ? { sort: strings.sort } : {}),
      ...(strings.contains !== undefined ? { contains: strings.contains } : {}),
      ...(strings.merged !== undefined ? { merged: strings.merged } : {}),
    },
  }
}

function hasRefListFields(strings: Partial<Record<StringField, string>>): boolean {
  return (
    strings.pattern !== undefined ||
    strings.sort !== undefined ||
    strings.contains !== undefined ||
    strings.merged !== undefined
  )
}

/** `Tool.validateParams` for `git_read`. */
export function validateGitReadParams(raw: Record<string, unknown>): ValidationResult {
  const check = checkGitReadParams(raw)
  return check.ok ? { is_valid: true, errors: [] } : { is_valid: false, errors: [check.text] }
}

/** Characters that make a git pathspec a glob; a backslash escapes the next one. */
const PATHSPEC_MAGIC = /[*?[\\]/

/**
 * The workspace files a `git_read` call reads, for the guardrail `file_read`
 * rules (`Tool.fileReads`).
 *
 * - A call that returns only names and ids reads no file content: `undefined`.
 * - A content call with literal paths and no `REV:PATH` reads those paths and
 *   everything under them (`subtrees`): a path can name a directory.
 * - Any other content call, including `follow` (history under earlier names is
 *   not declared), reads the whole workspace.
 */
export function gitReadFileReads(raw: Record<string, unknown>): FileReads | undefined {
  const check = checkGitReadParams(raw)
  if (!check.ok) return undefined
  const params = check.params
  if (!isContentCall(params)) return undefined
  const literalPaths =
    params.paths.length > 0 &&
    !params.paths.some(entry => PATHSPEC_MAGIC.test(entry)) &&
    !params.revisions.some(isRevisionPath) &&
    !params.options.has('follow')
  if (literalPaths) {
    return {
      paths: params.paths.map(entry => path.posix.join(params.directory, entry)),
      subtrees: true,
    }
  }
  return { paths: ['.'], wholeWorkspace: true }
}
