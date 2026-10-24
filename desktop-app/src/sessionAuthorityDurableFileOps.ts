import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  SessionAuthorityFileMutationError,
  moveSessionAuthorityFileDurablySync,
} from './windowsSessionAuthorityFileOps.js'

interface FileIdentity {
  readonly device: bigint
  readonly inode: bigint
}

interface FileReceipt {
  readonly identity: FileIdentity
  readonly contents: Buffer
}

function safeCode(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'EIO'
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'EIO'
}

function mutationError(
  error: unknown,
  outcome: 'rejected' | 'indeterminate',
  phase:
    | 'file-validation-failed'
    | 'file-durability-failed'
    | 'file-readback-failed'
    | 'directory-validation-failed'
    | 'publication-rejected'
    | 'directory-sync-failed'
    | 'destination-readback-failed'
    | 'source-retirement-failed'
): SessionAuthorityFileMutationError {
  return new SessionAuthorityFileMutationError(safeCode(error), outcome, {
    phase,
    processStarted: false,
    exitStatus: null,
    processSignaled: false,
    stdoutPresent: false,
    stderrPresent: false,
  })
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

interface DirectoryReceipt {
  readonly path: string
  readonly identity: FileIdentity
}

function observeDirectory(directory: string): DirectoryReceipt {
  try {
    const resolved = path.resolve(directory)
    const parsed = path.parse(resolved)
    let current = parsed.root
    const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
    let stat = fs.lstatSync(current, { bigint: true })
    for (const segment of segments) {
      current = path.join(current, segment)
      stat = fs.lstatSync(current, { bigint: true })
      if (stat.isSymbolicLink() || (!stat.isDirectory() && current !== resolved))
        throw new Error('Session authority parent contains a reparse point or non-directory')
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Session authority parent is not a real directory')
    return {
      path: resolved,
      identity: { device: stat.dev, inode: stat.ino },
    }
  } catch (error) {
    throw mutationError(error, 'rejected', 'directory-validation-failed')
  }
}

function readStableFile(file: string): FileReceipt {
  let descriptor: number | undefined
  try {
    const before = fs.lstatSync(file, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink())
      throw new Error('Session authority source is not a regular file')
    const noFollow = fs.constants.O_NOFOLLOW ?? 0
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow)
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error('Session authority source identity changed while opening')
    const contents = fs.readFileSync(descriptor)
    const after = fs.fstatSync(descriptor, { bigint: true })
    const pathAfter = fs.lstatSync(file, { bigint: true })
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      !pathAfter.isFile() ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      contents.length !== Number(opened.size)
    )
      throw new Error('Session authority source changed while being read')
    return { identity: { device: opened.dev, inode: opened.ino }, contents }
  } catch (error) {
    if (error instanceof SessionAuthorityFileMutationError) throw error
    throw mutationError(error, 'rejected', 'file-readback-failed')
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor)
      } catch (error) {
        throw mutationError(error, 'rejected', 'file-readback-failed')
      }
    }
  }
}

function syncSourceFile(file: string, expected: FileReceipt): void {
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(file, 'r+')
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== expected.identity.device ||
      opened.ino !== expected.identity.inode
    )
      throw new Error('Session authority source identity changed before sync')
    fs.fsyncSync(descriptor)
    const after = fs.fstatSync(descriptor, { bigint: true })
    const pathAfter = fs.lstatSync(file, { bigint: true })
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      !pathAfter.isFile() ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino
    )
      throw new Error('Session authority source changed while syncing')
  } catch (error) {
    throw mutationError(error, 'rejected', 'file-durability-failed')
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor)
      } catch (error) {
        throw mutationError(error, 'rejected', 'file-durability-failed')
      }
    }
  }
}

function syncDirectory(directory: string, expectedIdentity: FileIdentity): void {
  let descriptor: number | undefined
  try {
    if (!sameIdentity(observeDirectory(directory).identity, expectedIdentity))
      throw new Error('Session authority parent identity changed before sync')
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY)
    fs.fsyncSync(descriptor)
    if (!sameIdentity(observeDirectory(directory).identity, expectedIdentity))
      throw new Error('Session authority parent identity changed during sync')
  } catch (error) {
    throw mutationError(error, 'indeterminate', 'directory-sync-failed')
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor)
      } catch (error) {
        throw mutationError(error, 'indeterminate', 'directory-sync-failed')
      }
    }
  }
}

function sameDirectory(
  source: string,
  destination: string
): { directory: string; identity: FileIdentity; source: string; destination: string } {
  const sourceDirectory = observeDirectory(path.dirname(source))
  const destinationDirectory = observeDirectory(path.dirname(destination))
  if (
    sourceDirectory.path !== destinationDirectory.path ||
    !sameIdentity(sourceDirectory.identity, destinationDirectory.identity)
  )
    throw new Error('Session authority files must be published within one directory')
  return {
    directory: sourceDirectory.path,
    identity: sourceDirectory.identity,
    source: path.join(sourceDirectory.path, path.basename(source)),
    destination: path.join(sourceDirectory.path, path.basename(destination)),
  }
}

function verifyPublishedFile(
  destination: string,
  expected: FileReceipt,
  directory: string,
  directoryIdentity: FileIdentity
): void {
  try {
    const currentDirectory = observeDirectory(directory)
    if (!sameIdentity(currentDirectory.identity, directoryIdentity))
      throw new Error('Session authority parent identity changed after publication')
    const actual = readStableFile(destination)
    if (
      !sameIdentity(actual.identity, expected.identity) ||
      !actual.contents.equals(expected.contents)
    )
      throw new Error('Published session authority file did not match its exact receipt')
  } catch (error) {
    if (error instanceof SessionAuthorityFileMutationError && error.outcome === 'indeterminate')
      throw error
    throw mutationError(error, 'indeterminate', 'destination-readback-failed')
  }
}

function assertReplaceableDestination(destination: string): void {
  try {
    const stat = fs.lstatSync(destination, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Session authority destination is not a regular file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw mutationError(error, 'rejected', 'file-validation-failed')
  }
}

/**
 * Low-level publication mechanics only; this helper does not perform authority CAS, source
 * selection, ACL verification, or inter-process locking. Callers must hold the repository's
 * exclusive same-profile mutation lane and verify the canonical private directory policy before
 * publishing authority data. Keep production authority writes disabled until those caller gates
 * are proven on each supported platform.
 *
 * Publish a file replacement with an explicit durability primitive on every supported platform.
 * Windows directory handles do not provide the POSIX fsync contract: use same-volume
 * MoveFileExW(MOVEFILE_WRITE_THROUGH) instead of treating an unsupported directory fsync as
 * success. Other platforms use rename for replacement or link/unlink for no-clobber publication,
 * followed by parent-directory fsync and exact destination read-back.
 */
export function renameSessionAuthorityFileDurablySync(
  source: string,
  destination: string,
  replaceExisting = true,
  expectedContents?: Uint8Array
): void {
  let paths: ReturnType<typeof sameDirectory>
  try {
    paths = sameDirectory(source, destination)
  } catch (error) {
    throw mutationError(error, 'rejected', 'directory-validation-failed')
  }
  const { directory, identity: directoryIdentity } = paths
  if (replaceExisting) assertReplaceableDestination(paths.destination)
  const expected = readStableFile(paths.source)
  if (expectedContents && !expected.contents.equals(expectedContents))
    throw mutationError(
      new Error('Session authority source bytes differ from requested contents'),
      'rejected',
      'file-readback-failed'
    )
  syncSourceFile(paths.source, expected)
  const afterSync = readStableFile(paths.source)
  if (
    !sameIdentity(afterSync.identity, expected.identity) ||
    !afterSync.contents.equals(expected.contents)
  )
    throw mutationError(
      new Error('Session authority source changed after sync'),
      'rejected',
      'file-validation-failed'
    )

  if (process.platform === 'win32') {
    moveSessionAuthorityFileDurablySync(paths.source, paths.destination, replaceExisting)
    verifyPublishedFile(paths.destination, expected, directory, directoryIdentity)
    return
  }

  if (replaceExisting) {
    try {
      fs.renameSync(paths.source, paths.destination)
    } catch (error) {
      throw mutationError(error, 'rejected', 'publication-rejected')
    }
  } else {
    // POSIX link publication is atomic and fails if the destination appeared after observation;
    // unlike lstat()+rename(), it cannot overwrite a concurrently-created owner.
    try {
      fs.linkSync(paths.source, paths.destination)
    } catch (error) {
      throw mutationError(error, 'rejected', 'publication-rejected')
    }
    try {
      fs.unlinkSync(paths.source)
    } catch (error) {
      try {
        syncDirectory(directory, directoryIdentity)
      } catch {
        // The primary source-retirement uncertainty is retained below.
      }
      throw mutationError(error, 'indeterminate', 'source-retirement-failed')
    }
  }

  syncDirectory(directory, directoryIdentity)
  verifyPublishedFile(paths.destination, expected, directory, directoryIdentity)
}

/** Create a new authority/fence file atomically without overwriting an existing owner. */
export function createSessionAuthorityFileDurablySync(destination: string, contents: string): void {
  const directoryReceipt = observeDirectory(path.dirname(destination))
  const directory = directoryReceipt.path
  const canonicalDestination = path.join(directory, path.basename(destination))
  const directoryIdentity = directoryReceipt.identity
  const temporary = path.join(directory, `${path.basename(destination)}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  try {
    if (!sameIdentity(observeDirectory(directory).identity, directoryIdentity))
      throw new Error('Session authority parent identity changed before preparation')
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, contents, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    if (!sameIdentity(observeDirectory(directory).identity, directoryIdentity))
      throw new Error('Session authority parent identity changed after preparation')
    renameSessionAuthorityFileDurablySync(
      temporary,
      canonicalDestination,
      false,
      Buffer.from(contents, 'utf8')
    )
    if (!sameIdentity(observeDirectory(directory).identity, directoryIdentity))
      throw mutationError(
        new Error('Session authority parent identity changed during publication'),
        'indeterminate',
        'destination-readback-failed'
      )
  } catch (error) {
    if (error instanceof SessionAuthorityFileMutationError) throw error
    throw mutationError(error, 'rejected', 'file-durability-failed')
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      if (sameIdentity(observeDirectory(directory).identity, directoryIdentity))
        fs.unlinkSync(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // The temporary name is never an authority source; preserve the primary result.
      }
    }
  }
}
