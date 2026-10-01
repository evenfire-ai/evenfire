import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { runMigrations } from '../migrate'
import { migrations } from '../migrations'
import { type FsPort, nodeFs } from './fsPort'
import { readIdentity } from './identity'
import {
  SQLITE_FILES,
  exists,
  fingerprints,
  objectHash,
  privateDirectory,
  safePath,
  syncDirectory,
  syncFile,
  validateSqliteSetPaths,
} from './paths'
import { createPrivateScratch } from './privateScratch'
import {
  type Binding,
  CanonicalStoreError,
  type CatalogInspection,
  type FileFingerprint,
  LIMITS,
  type WriterFence,
} from './types'

const BUSINESS_TABLES = ['sessions', 'messages', 'pending_approvals', 'sqlite_sequence'] as const
interface SchemaRow {
  type: string
  name: string
  tbl_name: string
  sql: string | null
}
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`
// Preserve quoted literal bytes while normalizing insignificant token spacing.
const normalizedSql = (sql: string | null) =>
  sql === null
    ? null
    : (
        sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z0-9_]+|[^\s]/g) ??
        []
      ).join(' ')
function schema(db: Database.Database): SchemaRow[] {
  return (
    db
      .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')
      .all() as SchemaRow[]
  ).map(row => ({ ...row, sql: normalizedSql(row.sql) }))
}
const referenceSchemas = new Map<number, SchemaRow[]>()
function referenceSchema(version: number): SchemaRow[] {
  const cached = referenceSchemas.get(version)
  if (cached) return cached
  const db = new Database(':memory:')
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS migrations_meta (name TEXT PRIMARY KEY, applied_at REAL NOT NULL);'
    )
    for (const migration of migrations.slice(0, version)) migration.up(db)
    const result = schema(db)
    referenceSchemas.set(version, result)
    return result
  } finally {
    db.close()
  }
}
/** This allowlist derives from the same append-only migration registry as the writer.
 * The business table registry is explicit: a new persistent table requires an inspector change. */
export function validateSupportedSchema(db: Database.Database): number {
  try {
    const names = (
      db.prepare('SELECT name FROM migrations_meta').all() as Array<{ name: string }>
    ).map(row => row.name)
    const applied = new Set(names)
    if (
      names.length !== applied.size ||
      names.length === 0 ||
      names.length > migrations.length ||
      migrations.slice(0, names.length).some(migration => !applied.has(migration.name))
    ) {
      throw new CanonicalStoreError('SchemaUnsupported')
    }
    if (objectHash(schema(db)) !== objectHash(referenceSchema(names.length)))
      throw new CanonicalStoreError('SchemaUnsupported')
    const expectedBusiness = referenceSchema(migrations.length).filter(
      row =>
        row.type === 'table' &&
        !['migrations_meta', 'canonical_store_identity'].includes(row.name) &&
        !row.name.startsWith('messages_fts')
    )
    if (expectedBusiness.some(row => !(BUSINESS_TABLES as readonly string[]).includes(row.name)))
      throw new CanonicalStoreError('SchemaUnsupported')
    return names.length
  } catch (error) {
    if (error instanceof CanonicalStoreError) throw error
    throw new CanonicalStoreError('SchemaUnsupported')
  }
}
function validateIntegrity(db: Database.Database): void {
  const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>
  if (
    result.length !== 1 ||
    result[0].integrity_check !== 'ok' ||
    (db.pragma('foreign_key_check') as unknown[]).length !== 0
  ) {
    throw new CanonicalStoreError('CandidateCorrupt')
  }
}
function validateFts(db: Database.Database): void {
  try {
    db.prepare("INSERT INTO messages_fts(messages_fts,rank) VALUES ('integrity-check',1)").run()
  } catch {
    throw new CanonicalStoreError('CandidateCorrupt')
  }
}
function encoded(value: unknown): string {
  if (value === null) return 'null;'
  if (typeof value === 'bigint') return `integer:${value.toString()};`
  if (typeof value === 'number') return `real:${Object.is(value, -0) ? '-0' : value.toString()};`
  if (typeof value === 'string') return `text:${Buffer.byteLength(value)}:${value};`
  if (Buffer.isBuffer(value)) return `blob:${value.length}:${value.toString('base64')};`
  throw new CanonicalStoreError('CandidateCorrupt')
}
/** Read TEXT as its exact UTF-8 bytes, so invalid UTF-8 cannot collapse into equal JS replacement strings. */
export function typedColumnProjection(names: string[]): string {
  return names
    .map(
      (name, index) =>
        `CASE WHEN typeof(${quote(name)})='text' THEN CAST(${quote(name)} AS BLOB) ELSE ${quote(name)} END AS value_${index},typeof(${quote(name)}) AS type_${index}`
    )
    .join(',')
}
export function catalogFingerprint(
  db: Database.Database,
  deadline = Date.now() + LIMITS.timeoutMs
): Omit<CatalogInspection, 'schemaVersion' | 'identity'> {
  const tableHashes: Record<string, string> = {}
  const counts: Record<string, number> = {}
  const logicalSchema = schema(db).filter(
    row =>
      row.name !== 'migrations_meta' &&
      row.tbl_name !== 'migrations_meta' &&
      row.name !== 'canonical_store_identity' &&
      row.tbl_name !== 'canonical_store_identity'
  )
  const all = createHash('sha256').update(JSON.stringify(logicalSchema))
  for (const table of BUSINESS_TABLES) {
    const columns = db.pragma(`table_xinfo(${quote(table)})`) as Array<{
      name: string
      pk: number
      hidden: number
    }>
    if (columns.length === 0) throw new CanonicalStoreError('SchemaUnsupported')
    const names = columns.filter(column => column.hidden === 0).map(column => column.name)
    const keys = columns
      .filter(column => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map(column => column.name)
    const order = keys.length > 0 ? keys : names
    const statement = db.prepare(
      `SELECT ${typedColumnProjection(names)} FROM ${quote(table)} ORDER BY ${order.map(quote).join(',')}`
    )
    statement.safeIntegers(true)
    const hash = createHash('sha256').update(JSON.stringify([table, names]))
    let count = 0
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
      if (Date.now() > deadline) throw new CanonicalStoreError('ManifestTooLarge')
      hash.update('row;')
      for (let index = 0; index < names.length; index++) {
        hash.update(encoded(row[`type_${index}`]))
        hash.update(encoded(row[`value_${index}`]))
      }
      count++
    }
    counts[table] = count
    tableHashes[table] = hash.digest('hex')
    all.update(JSON.stringify([table, count, tableHashes[table]]))
  }
  return {
    catalogHash: all.digest('hex'),
    tableHashes,
    counts,
    empty: BUSINESS_TABLES.every(table => counts[table] === 0),
  }
}
export interface InspectOptions {
  root: string
  scratchDir: string
  scratchRoot?: string
  binding?: Binding
  live?: boolean
  timeoutMs?: number
  fs?: FsPort
  fence?: WriterFence
}
export interface InspectedCandidate extends CatalogInspection {
  sourceFiles: FileFingerprint[]
  sourceHash: string
  normalizedPath: string
  dispose(): void
}
/** Cold snapshots are never opened by SQLite. WAL replay and known migrations run only here. */
export async function inspectCandidate(
  directory: string,
  options: InspectOptions
): Promise<InspectedCandidate> {
  const port = options.fs ?? nodeFs
  if (!options.live) {
    if (!options.fence) throw new CanonicalStoreError('WriterFenceBusy')
    options.fence.assertHeld()
  }
  const deadline = Date.now() + (options.timeoutMs ?? LIMITS.timeoutMs)
  safePath(options.root, directory)
  const source = path.join(directory, 'state.db')
  if (!exists(source)) throw new CanonicalStoreError('CandidateIncomplete')
  validateSqliteSetPaths(options.root, source)
  let sourceFiles = options.live ? [] : fingerprints(options.root, directory)
  // Hot rollback journals cannot be proven safe by this implementation; retain and block.
  if (exists(`${source}-journal`) && fs.statSync(`${source}-journal`).size > 0)
    throw new CanonicalStoreError('CandidateIncomplete')
  const scratchRoot = options.scratchRoot ?? options.root
  safePath(scratchRoot, scratchRoot)
  const ownedScratch = createPrivateScratch(scratchRoot, options.scratchDir, port)
  const scratch = ownedScratch.directory
  const normalizedPath = path.join(scratch, 'state.db')
  let returned = false
  let db: Database.Database | undefined
  try {
    if (options.live) {
      const live = new Database(source, {
        readonly: true,
        fileMustExist: true,
        timeout: options.timeoutMs ?? 1000,
      })
      try {
        await live.backup(normalizedPath, {
          progress() {
            if (Date.now() > deadline) throw new CanonicalStoreError('ManifestTooLarge')
            return 128
          },
        })
      } finally {
        live.close()
      }
      fs.chmodSync(normalizedPath, 0o600)
      sourceFiles = fingerprints(scratchRoot, scratch)
    } else {
      for (const file of sourceFiles.filter(file => file.present)) {
        const from = path.join(directory, file.name)
        const to = path.join(scratch, file.name)
        safePath(options.root, from)
        safePath(scratchRoot, to, true)
        port.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)
        fs.chmodSync(to, 0o600)
      }
    }
    db = new Database(normalizedPath, { fileMustExist: true, timeout: 1000 })
    validateIntegrity(db)
    const schemaVersion = validateSupportedSchema(db)
    const identity = readIdentity(db, options.binding)
    runMigrations(db)
    validateSupportedSchema(db)
    validateIntegrity(db)
    validateFts(db)
    const catalog = catalogFingerprint(db, deadline)
    db.pragma('journal_mode = DELETE')
    db.close()
    db = undefined
    for (const suffix of ['-wal', '-shm', '-journal'])
      if (exists(`${normalizedPath}${suffix}`)) throw new CanonicalStoreError('CandidateIncomplete')
    syncFile(scratchRoot, normalizedPath, port)
    syncDirectory(scratchRoot, scratch, port)
    if (
      !options.live &&
      objectHash(fingerprints(options.root, directory)) !== objectHash(sourceFiles)
    ) {
      throw new CanonicalStoreError('CandidateChangedDuringMigration')
    }
    if (!options.live) options.fence!.assertHeld()
    returned = true
    return {
      ...catalog,
      schemaVersion,
      identity,
      sourceFiles,
      sourceHash: objectHash(sourceFiles),
      normalizedPath,
      dispose: ownedScratch.dispose,
    }
  } catch (error) {
    if (error instanceof CanonicalStoreError) throw error
    const code = (error as { code?: string }).code
    if (code === 'SQLITE_FULL' || code === 'ENOSPC')
      throw new CanonicalStoreError('InsufficientSpace')
    if (code?.startsWith('SQLITE_READONLY') || code === 'SQLITE_CANTOPEN')
      throw new CanonicalStoreError('CandidateIncomplete')
    if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB')
      throw new CanonicalStoreError('CandidateCorrupt')
    throw error
  } finally {
    if (db?.open) db.close()
    if (!returned) ownedScratch.dispose()
  }
}
