import { spawnSync } from 'node:child_process'

/**
 * Read-only reads of the lane's Host pod for the memory-notes journey.
 *
 * Written like `readImageCapabilityEvidence`: the namespace, deployment,
 * container and workspace root are fixed constants, the context is the
 * validated profile, every call carries a request timeout and a process
 * timeout, and arguments travel as a vector, never through a shell. Values
 * from the test (a marker, a path) are passed as separate arguments, never
 * spliced into a command or script string.
 */
export const MEMORY_NOTES_HOST = {
  namespace: 'mcp-host',
  deployment: 'chatllm',
  container: 'mcp-host',
  workspace: '/workspace',
} as const

const KUBECTL_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const USER_KEY = /^[a-z0-9_]{1,64}$/
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

/**
 * Reads the latest `memory_writes` row for one key (migration 018) with
 * better-sqlite3 opened read-only, the route verified on the running Hosts.
 * The scope, user key and path arrive as `process.argv[1..3]`.
 */
const LATEST_MEMORY_WRITE_SCRIPT = [
  "const Database = require('/app/mcp-host/node_modules/better-sqlite3')",
  "const db = new Database(process.env.CLERUM_SESSION_DB_DIR + '/state.db', { readonly: true })",
  'try {',
  '  const row = db',
  "    .prepare('SELECT user_key, scope, relative_path, mode, content_sha256 FROM memory_writes ' +",
  "      'WHERE scope = ? AND user_key = ? AND relative_path = ? ORDER BY id DESC LIMIT 1')",
  '    .get(process.argv[1], process.argv[2], process.argv[3])',
  '  process.stdout.write(JSON.stringify(row === undefined ? null : row))',
  '} finally {',
  '  db.close()',
  '}',
].join('\n')

export interface MemoryWriteRowView {
  user_key: string
  scope: 'collective' | 'user'
  relative_path: string
  mode: 'append' | 'replace'
  content_sha256: string
}

interface ExecResult {
  status: number
  stdout: string
  stderr: string
}

function execInHost(profile: string, command: string[]): ExecResult {
  const args = [
    '--context',
    profile,
    '--request-timeout=20s',
    '-n',
    MEMORY_NOTES_HOST.namespace,
    'exec',
    `deploy/${MEMORY_NOTES_HOST.deployment}`,
    '-c',
    MEMORY_NOTES_HOST.container,
    '--',
    ...command,
  ]
  const result = spawnSync('kubectl', args, {
    encoding: 'utf8',
    timeout: KUBECTL_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) {
    throw new Error(`[memory-notes] kubectl ${args.join(' ')} failed: ${result.error.message}`)
  }
  if (result.status === null) {
    throw new Error(`[memory-notes] kubectl ${args.join(' ')} ended by signal ${result.signal}`)
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.trim() }
}

function requireStatus(result: ExecResult, allowed: number[], what: string): void {
  if (!allowed.includes(result.status)) {
    throw new Error(`[memory-notes] ${what} exited ${result.status}: ${result.stderr}`)
  }
}

/** Absolute path of a file inside one user's folder. */
export function userFilePath(userKey: string, relativePath: string): string {
  if (!USER_KEY.test(userKey)) throw new Error(`[memory-notes] invalid user key "${userKey}"`)
  if (!SAFE_RELATIVE_PATH.test(relativePath) || relativePath.split('/').includes('..')) {
    throw new Error(`[memory-notes] invalid relative path "${relativePath}"`)
  }
  return `${MEMORY_NOTES_HOST.workspace}/users/${userKey}/${relativePath}`
}

/**
 * Files under `users/` whose content holds `marker` (fixed-string grep). The
 * spec never computes a user key: it finds the folder by the run marker.
 */
export function findUserFilesWithMarker(profile: string, marker: string): string[] {
  const result = execInHost(profile, [
    'grep',
    '-rlF',
    '--',
    marker,
    `${MEMORY_NOTES_HOST.workspace}/users`,
  ])
  // grep: 0 = matches, 1 = no match; anything else is a failed read.
  requireStatus(result, [0, 1], 'grep for the run marker')
  return result.stdout.split('\n').filter(Boolean).sort()
}

/** The user key of a path under `<workspace>/users/<key>/`. */
export function userKeyOfPath(absolutePath: string): string {
  const prefix = `${MEMORY_NOTES_HOST.workspace}/users/`
  if (!absolutePath.startsWith(prefix)) {
    throw new Error(`[memory-notes] ${absolutePath} is not under ${prefix}`)
  }
  const key = absolutePath.slice(prefix.length).split('/')[0] ?? ''
  if (!USER_KEY.test(key)) throw new Error(`[memory-notes] invalid user key in ${absolutePath}`)
  return key
}

export function readHostFile(profile: string, absolutePath: string): string {
  const result = execInHost(profile, ['cat', '--', absolutePath])
  requireStatus(result, [0], `cat ${absolutePath}`)
  return result.stdout
}

export function hostPathExists(profile: string, absolutePath: string): boolean {
  const result = execInHost(profile, ['test', '-e', absolutePath])
  // test: 0 = exists, 1 = absent; anything else is a failed read.
  requireStatus(result, [0, 1], `test -e ${absolutePath}`)
  return result.status === 0
}

/** The latest record row for one per-user file, or null when none exists. */
export function latestUserMemoryWrite(
  profile: string,
  userKey: string,
  relativePath: string
): MemoryWriteRowView | null {
  userFilePath(userKey, relativePath)
  const result = execInHost(profile, [
    'node',
    '-e',
    LATEST_MEMORY_WRITE_SCRIPT,
    'user',
    userKey,
    relativePath,
  ])
  requireStatus(result, [0], 'read the memory_writes row')
  const parsed: unknown = JSON.parse(result.stdout)
  if (parsed === null) return null
  if (
    typeof parsed !== 'object' ||
    typeof (parsed as MemoryWriteRowView).content_sha256 !== 'string' ||
    typeof (parsed as MemoryWriteRowView).mode !== 'string'
  ) {
    throw new Error(`[memory-notes] unexpected memory_writes row: ${result.stdout}`)
  }
  return parsed as MemoryWriteRowView
}
