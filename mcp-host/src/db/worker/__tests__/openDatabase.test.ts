import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseOpenRefused, openConversationDatabase } from '../openDatabase'

const dirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-db-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function refusal(fn: () => unknown): DatabaseOpenRefused {
  try {
    fn()
  } catch (err) {
    if (err instanceof DatabaseOpenRefused) return err
    throw err
  }
  throw new Error('expected DatabaseOpenRefused, the open succeeded')
}

describe('openConversationDatabase', () => {
  it('creates the database and its parent directory when no journal exists', () => {
    const dir = tempDir()
    const dbPath = path.join(dir, 'nested', 'state.db')
    const db = openConversationDatabase(dbPath)
    db.exec('CREATE TABLE t (x INTEGER)')
    db.close()
    expect(fs.existsSync(dbPath)).toBe(true)
  })

  it('opens an existing database that has its journals', () => {
    const dir = tempDir()
    const dbPath = path.join(dir, 'state.db')
    const writer = openConversationDatabase(dbPath)
    writer.pragma('journal_mode = WAL')
    writer.exec('CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (7)')
    // The WAL exists next to its main file while the writer is open.
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true)
    const reader = openConversationDatabase(dbPath)
    expect(reader.prepare('SELECT x FROM t').get()).toEqual({ x: 7 })
    reader.close()
    writer.close()
  })

  it('never creates a database next to an orphan WAL and leaves the WAL byte-for-byte', () => {
    const dir = tempDir()
    const dbPath = path.join(dir, 'state.db')
    const wal = Buffer.from('orphan wal bytes that must survive')
    fs.writeFileSync(`${dbPath}-wal`, wal)

    const err = refusal(() => openConversationDatabase(dbPath))
    expect(err.code).toBe('ORPHAN_WAL')
    expect(err.message).toContain(`${dbPath}-wal`)
    expect(fs.existsSync(dbPath)).toBe(false)
    expect(fs.readFileSync(`${dbPath}-wal`).equals(wal)).toBe(true)
    expect(fs.readdirSync(dir)).toEqual(['state.db-wal'])
  })

  it('treats a lone SHM file as an orphan journal too', () => {
    const dir = tempDir()
    const dbPath = path.join(dir, 'state.db')
    fs.writeFileSync(`${dbPath}-shm`, 'shm')
    expect(refusal(() => openConversationDatabase(dbPath)).code).toBe('ORPHAN_WAL')
    expect(fs.readdirSync(dir)).toEqual(['state.db-shm'])
  })

  it('counts a dangling journal symlink as a journal', () => {
    const dir = tempDir()
    const dbPath = path.join(dir, 'state.db')
    fs.symlinkSync(path.join(dir, 'gone'), `${dbPath}-wal`)
    expect(refusal(() => openConversationDatabase(dbPath)).code).toBe('ORPHAN_WAL')
    expect(fs.existsSync(dbPath)).toBe(false)
  })
})
