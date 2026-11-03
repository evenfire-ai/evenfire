import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  SessionAuthorityFileMutationError,
  moveSessionAuthorityFileDurablySync,
} from './windowsSessionAuthorityFileOps.js'

function syncDirectory(directory: string): void {
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function assertSameDirectory(source: string, destination: string): void {
  if (path.dirname(source) !== path.dirname(destination))
    throw new Error('Session authority files must be published within one directory')
}

/**
 * Publish a file replacement with an explicit durability primitive on every supported platform.
 * Windows directory handles do not provide the POSIX fsync contract: use same-volume
 * MoveFileExW(MOVEFILE_WRITE_THROUGH) instead of treating an unsupported directory fsync as
 * success. Other platforms retain rename followed by parent-directory fsync.
 */
export function renameSessionAuthorityFileDurablySync(
  source: string,
  destination: string,
  replaceExisting = true
): void {
  assertSameDirectory(source, destination)
  if (process.platform === 'win32') {
    moveSessionAuthorityFileDurablySync(source, destination, replaceExisting)
    return
  }
  if (!replaceExisting) {
    try {
      fs.lstatSync(destination)
      throw Object.assign(new Error('Session authority destination already exists'), {
        code: 'EEXIST',
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  fs.renameSync(source, destination)
  syncDirectory(path.dirname(destination))
}

/** Create a new authority/fence file atomically without overwriting an existing owner. */
export function createSessionAuthorityFileDurablySync(
  destination: string,
  contents: string,
  mode = 0o600
): void {
  const temporary = `${destination}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporary, 'wx', mode)
    fs.writeFileSync(descriptor, contents, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    if (process.platform === 'win32') {
      renameSessionAuthorityFileDurablySync(temporary, destination, false)
    } else {
      // link() is the POSIX O_EXCL-equivalent publication for recovery and mutation fences. It
      // prevents another writer from replacing a fence published after our initial observation.
      fs.linkSync(temporary, destination)
      try {
        fs.unlinkSync(temporary)
      } catch {
        // The active destination is already established; the extra temporary link is inert.
      }
      syncDirectory(path.dirname(destination))
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      fs.unlinkSync(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // The temporary name is never an authority source; preserve the primary result.
      }
    }
  }
}

/**
 * Retire an exact source pathname. On Windows, first durably remove its active name with a
 * same-directory write-through rename; the private retired name is never an authority source.
 */
export function retireSessionCredentialFileDurablySync(file: string): void {
  if (process.platform !== 'win32') {
    fs.unlinkSync(file)
    syncDirectory(path.dirname(file))
    return
  }

  const retired = `${file}.evenfire-retired`
  try {
    fs.unlinkSync(retired)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new SessionAuthorityFileMutationError('EIO', 'indeterminate', {
        phase: 'retired-file-cleanup-failed',
        processStarted: false,
        exitStatus: null,
        processSignaled: false,
        stdoutPresent: false,
        stderrPresent: false,
      })
  }

  try {
    moveSessionAuthorityFileDurablySync(file, retired, false)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      fs.lstatSync(file)
    } catch (inspectionError) {
      if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') return
      throw inspectionError
    }
    throw error
  }
  try {
    fs.unlinkSync(retired)
  } catch {
    throw new SessionAuthorityFileMutationError('EIO', 'indeterminate', {
      phase: 'retired-file-cleanup-failed',
      processStarted: false,
      exitStatus: null,
      processSignaled: false,
      stdoutPresent: false,
      stderrPresent: false,
    })
  }
}
