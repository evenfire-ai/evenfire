import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { assertNoIncompleteCanonicalMigration } from './db/canonicalStore/bootGuard'
import { FINAL_MARKER, LEGACY_MARKER, LEGACY_STATE_RECORD } from './db/canonicalStore/journal'
import { UUID, exists, safePath, validateSqliteSetPaths } from './db/canonicalStore/paths'
import { validateBinding } from './db/canonicalStore/paths'
import type { Binding } from './db/canonicalStore/types'

export type StorageContract = 'legacy-floor' | 'canonical'

/** HCC-admitted contracts never infer a storage mode from a defaulted boolean. */
export function parseStorageContract(raw: string, required: boolean): StorageContract | undefined {
  if (raw === '') {
    if (required) throw new Error('CanonicalStoreRuntimeContractMissing')
    return undefined
  }
  if ((raw === 'canonical' && required) || (raw === 'legacy-floor' && !required)) return raw
  throw new Error('CanonicalStoreRuntimeContractMismatch')
}

export function requiresExistingStore(options: CanonicalStoreRuntimeOptions): boolean {
  return options.required || options.storageContract === 'legacy-floor'
}

/** Injected by HCC on every admitted storage template, including legacy layouts. */
export interface CanonicalStoreRuntimeOptions {
  stateDir: string
  binding: Binding
  required: boolean
  storageContract?: StorageContract
  /** Legacy root PVC mount; canonical main containers intentionally cannot see it. */
  legacyRoot?: string
}

export function assertCanonicalRuntimeConfig(
  mode: 'memory' | 'sqlite' | 'dual',
  dbPath: string | undefined,
  options: CanonicalStoreRuntimeOptions
): void {
  validateBinding(options.binding)
  if (!path.isAbsolute(options.stateDir) || path.resolve(options.stateDir) !== options.stateDir) {
    throw new Error('CanonicalStoreStateDirInvalid')
  }
  if (
    options.legacyRoot &&
    (!path.isAbsolute(options.legacyRoot) ||
      path.resolve(options.legacyRoot) !== options.legacyRoot)
  ) {
    throw new Error('CanonicalStoreLegacyRootInvalid')
  }
  if (
    options.storageContract &&
    ((options.storageContract === 'canonical') !== options.required ||
      !['canonical', 'legacy-floor'].includes(options.storageContract))
  ) {
    throw new Error('CanonicalStoreRuntimeContractMismatch')
  }
  if (!requiresExistingStore(options)) return
  if (mode !== 'sqlite') throw new Error('CanonicalStoreRequiresSqlite')
  if (options.legacyRoot) throw new Error('CanonicalStoreRootMountForbidden')
  if (dbPath !== path.join(options.stateDir, 'state.db')) {
    throw new Error('CanonicalStoreDbPathMismatch')
  }
}

/** An identity remains authoritative even when a legacy mount cannot see the final marker. */
export function assertLegacyStoreIsNotCanonical(dbPath: string): void {
  if (!exists(dbPath)) return
  validateSqliteSetPaths(path.dirname(dbPath), dbPath)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 })
  try {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'canonical_store_identity'"
      )
      .get()
    if (table && db.prepare('SELECT singleton FROM canonical_store_identity LIMIT 1').get()) {
      throw new Error('CanonicalStoreLayoutRollback')
    }
  } finally {
    db.close()
  }
}

/** Missing new environment variables never turn an existing canonical lineage into legacy. */
export function assertUncoordinatedStoreBootAllowed(dbPath: string): void {
  const directory = path.dirname(dbPath)
  assertNoIncompleteCanonicalMigration({ stateDir: directory })
  assertNoIncompleteCanonicalMigration({ root: directory, stateDir: path.join(directory, 'state') })
  if (exists(path.join(directory, FINAL_MARKER))) throw new Error('CanonicalStoreLayoutRollback')
  assertLegacyStoreIsNotCanonical(dbPath)
  assertLegacyStoreIsNotCanonical(path.join(directory, 'state', 'state.db'))
  for (const stateDir of [directory, path.join(directory, 'state')]) {
    const records = path.join(stateDir, '.canonical-store')
    if (exists(path.join(records, LEGACY_STATE_RECORD)))
      throw new Error('CanonicalStoreRuntimeContractMissing')
    if (!exists(records)) continue
    safePath(stateDir, records)
    // A retained operation remains a storage commitment even if state.db is
    // absent. No contract means no authority to replace that catalog with a new DB.
    for (const name of fs.readdirSync(records)) {
      if (UUID.test(name) && exists(path.join(records, name, 'journal.json'))) {
        throw new Error('CanonicalStoreRuntimeContractMissing')
      }
    }
  }
  if (exists(path.join(directory, LEGACY_MARKER)))
    throw new Error('CanonicalStoreRuntimeContractMissing')
}
