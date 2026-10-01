import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  exists,
  privateDirectory,
  safePath,
  syncDirectory,
  syncFile,
  validateSqliteSetPaths,
} from './paths'
import { CanonicalStoreError, type WriterFence } from './types'

/** This dedicated connection must live in the worker that owns the writable store. */
export function acquireWriterFence({
  stateDir,
  timeoutMs = 1000,
  requireExisting = false,
}: {
  stateDir: string
  timeoutMs?: number
  requireExisting?: boolean
}): WriterFence {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000)
    throw new CanonicalStoreError('LayoutUnsafe')
  const state = path.resolve(stateDir)
  const root = exists(state) ? state : path.dirname(state)
  if (requireExisting && !exists(path.join(state, '.canonical-store', 'writer-fence.db')))
    throw new CanonicalStoreError('CandidateIncomplete')
  safePath(root, state, true)
  privateDirectory(root, state)
  const directory = path.join(state, '.canonical-store')
  privateDirectory(root, directory)
  const file = path.join(directory, 'writer-fence.db')
  safePath(root, file, true)
  if (!exists(file)) {
    try {
      const fd = fs.openSync(
        file,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          fs.constants.O_NOFOLLOW,
        0o600
      )
      fs.closeSync(fd)
      syncFile(root, file)
      syncDirectory(root, directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  safePath(root, file)
  for (const suffix of ['-wal', '-shm'])
    if (exists(`${file}${suffix}`)) throw new CanonicalStoreError('LayoutUnsafe')
  // SIGKILL during SQLite's first coordination-file initialization can leave a hot DELETE journal.
  // Validate its paths, then let SQLite recover under its own OS locks; never remove a lock file or journal manually.
  validateSqliteSetPaths(root, file)
  const original = fs.lstatSync(file)
  let db: Database.Database | undefined
  try {
    db = new Database(file, { fileMustExist: true, timeout: timeoutMs })
    db.pragma('journal_mode = DELETE')
    db.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    db?.close()
    if (
      (error as { code?: string }).code?.startsWith('SQLITE_BUSY') ||
      (error as { code?: string }).code === 'SQLITE_LOCKED'
    ) {
      throw new CanonicalStoreError('WriterFenceBusy')
    }
    throw error
  }
  const connection = db
  let closed = false
  return {
    assertHeld() {
      if (closed || !connection.open || !connection.inTransaction)
        throw new CanonicalStoreError('WriterFenceBusy')
      safePath(root, file)
      const current = fs.lstatSync(file)
      if (current.ino !== original.ino || current.dev !== original.dev)
        throw new CanonicalStoreError('WriterFenceBusy')
    },
    close() {
      if (closed) return
      closed = true
      try {
        if (connection.open && connection.inTransaction) connection.exec('ROLLBACK')
      } finally {
        if (connection.open) connection.close()
      }
    },
  }
}
