/**
 * Opens the conversation database for the worker thread without creating one
 * next to a surviving journal.
 *
 * A missing `state.db` with a `-wal` or `-shm` file beside it means the main
 * file was moved or deleted while its journal stayed. Creating a new database
 * there hides the history the journal belongs to, and SQLite discards that
 * WAL on the first checkpoint, so the open is refused and the journal is left
 * untouched.
 */
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'

export class DatabaseOpenRefused extends Error {
  readonly code = 'ORPHAN_WAL'

  constructor(message: string) {
    super(message)
    this.name = 'DatabaseOpenRefused'
  }
}

/** `lstat` that reports absence as `false` and every other error as thrown. */
function entryExists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

export function openConversationDatabase(dbPath: string): Database.Database {
  if (!entryExists(dbPath)) {
    const journals = ['-wal', '-shm'].map(s => `${dbPath}${s}`).filter(entryExists)
    if (journals.length > 0) {
      throw new DatabaseOpenRefused(
        `refusing to create ${dbPath}: journal files exist without it (${journals.join(', ')})`
      )
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }
  return new Database(dbPath)
}
