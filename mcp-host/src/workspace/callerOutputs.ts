/**
 * Where a chat caller's generated files live: a reserved directory inside the
 * caller's own verified root (`<host>/users/<key>/.clerum-outputs`), the root
 * file_read and file_write use, but out of reach of those tools. Generation,
 * attachment, listing and download all resolve it, so through them one user
 * never reaches another's files, not even by guessing a name. A directory that
 * cannot be verified is never replaced by a shared one. shell_exec is not
 * confined: an approved command runs as the Host and can read any caller's
 * folder.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { verifyManagedCallerRootPath } from './callerRootBinding'
import { deriveUserKeyFromSource } from './userKey'

export const CALLER_OUTPUTS_DIR = '.clerum-outputs'

export type CallerOutputDir = { dir: string } | { failureCode: string }
export type CallerOutputLookup = CallerOutputDir | { missing: true }

const KNOWN_CODES = new Set([
  'EACCES',
  'EEXIST',
  'EIO',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EROFS',
])

function failureCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code
  return typeof code === 'string' && KNOWN_CODES.has(code) ? code : 'EIO'
}

/**
 * The outputs directory under `callerRoot`, re-verified on every call: the
 * caller root must still be the managed `<host>/users/<key>`, and the
 * directory a real one, not a link. With `create`, a missing directory is made
 * (owner only); without it, a missing one is reported as such.
 */
export function resolveCallerOutputDir(
  callerRoot: string,
  opts: { create: boolean }
): CallerOutputLookup {
  try {
    const root = verifyManagedCallerRootPath(callerRoot)
    if (!root) return { failureCode: 'EEXIST' }
    const dir = path.join(root, CALLER_OUTPUTS_DIR)
    let info: fs.Stats
    try {
      info = fs.lstatSync(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      if (!opts.create) return { missing: true }
      fs.mkdirSync(dir, { mode: 0o700 })
      info = fs.lstatSync(dir)
    }
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(dir) !== dir) {
      return { failureCode: 'EEXIST' }
    }
    return { dir }
  } catch (err) {
    return { failureCode: failureCode(err) }
  }
}

/**
 * The outputs directory of the Desktop user `userId` on the Host based at
 * `hostBase`, for the artifact routes: the caller key is the one a chat
 * message from that user gets (channel `rpc`, sender = user id). Read only:
 * a user with no folder yet has nothing, and none is created.
 */
export function resolveRpcCallerOutputDir(hostBase: string, userId: string): CallerOutputLookup {
  const key = deriveUserKeyFromSource({ sender: userId, channelType: 'rpc' })
  const root = path.join(path.resolve(hostBase), 'users', key)
  try {
    fs.lstatSync(root)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? { missing: true }
      : { failureCode: failureCode(err) }
  }
  return resolveCallerOutputDir(root, { create: false })
}

/** The message a generator returns when the caller's folder cannot be used; it names no path. */
export function callerOutputUnavailableMessage(code: string): string {
  return (
    `Generated files are unavailable: this Host could not verify your private output folder ` +
    `(${code}). Nothing was saved.`
  )
}

/**
 * Files and bytes left in the folder chat files went to before they became
 * per user. Nothing reads, serves or removes them now; the count is logged so
 * an operator knows they are there. Undefined when the folder is absent.
 */
export async function countSharedOutputs(
  dir: string
): Promise<{ files: number; bytes: number } | undefined> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
  let files = 0
  let bytes = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      bytes += (await fs.promises.lstat(path.join(dir, entry.name))).size
      files++
    } catch {
      // Removed meanwhile.
    }
  }
  return { files, bytes }
}
