import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { readIdentity } from './identity'
import { isImportConsumed, readImportManifest } from './imports'
import { validateSupportedSchema } from './inspectCandidate'
import {
  FINAL_MARKER,
  LEGACY_MARKER,
  MIGRATING_MARKER,
  readJson,
  readLegacyMarker,
  readLegacyStateRecord,
  readMarker,
  validateJournal,
} from './journal'
import {
  SQLITE_FILES,
  assertUuid,
  candidateDirectory,
  compareBinding,
  exists,
  objectHash,
  operationDirectory,
  safePath,
  validateSqliteSetPaths,
} from './paths'
import {
  type Binding,
  type CanonicalIdentity,
  CanonicalStoreError,
  type InitOutcome,
  type LegacyLayoutMarker,
  type WriterFence,
  legacyOutcome,
  outcome,
} from './types'
import { acquireWriterFence } from './writerFence'

export function assertNoIncompleteCanonicalMigration({
  root,
  stateDir,
}: {
  root?: string
  stateDir: string
}): void {
  const journal = path.join(stateDir, '.canonical-store', 'journal.json')
  if (exists(journal)) {
    safePath(root ?? stateDir, journal)
    throw new CanonicalStoreError('MigrationInProgress')
  }
  if (root && exists(path.join(root, MIGRATING_MARKER))) {
    safePath(root, path.join(root, MIGRATING_MARKER))
    throw new CanonicalStoreError('MigrationInProgress')
  }
}
/** Call under the writer fence, before opening writable SQLite or running worker migrations. */
export function validateCanonicalStore({
  stateDir,
  binding,
  root,
}: {
  stateDir: string
  binding: Binding
  root?: string
}): CanonicalIdentity {
  assertNoIncompleteCanonicalMigration({ root, stateDir })
  const file = path.join(stateDir, 'state.db')
  if (!exists(file)) throw new CanonicalStoreError('CandidateIncomplete')
  validateSqliteSetPaths(root ?? stateDir, file)
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 1000 })
  try {
    validateSupportedSchema(db)
    const identity = readIdentity(db, binding)
    if (!identity) throw new CanonicalStoreError('MarkerMismatch')
    if (root) {
      const marker = readMarker(root, binding)
      if (!marker || marker.storeId !== identity.storeId)
        throw new CanonicalStoreError('MarkerMismatch')
    }
    return identity
  } finally {
    db.close()
  }
}
/** A legacy root mount must stop before any store is created on a canonical PVC. */
export function assertLegacyLayoutAllowed(root: string, binding: Binding): void {
  assertNoIncompleteCanonicalMigration({ root, stateDir: path.join(root, 'state') })
  if (exists(path.join(root, LEGACY_MARKER))) {
    readLegacyMarker(root, binding)
    throw new Error('LegacyStoreLayoutRollback')
  }
  if (exists(path.join(root, FINAL_MARKER))) {
    const marker = readMarker(root, binding)
    if (marker) {
      compareBinding(marker, binding)
      throw new Error('CanonicalStoreLayoutRollback')
    }
  }
}

/** Normal full-root init rejects a new lineage; prepared recovery may inspect imports separately under maintenance. */
export function assertNoForeignLayoutCandidates(root: string, binding: Binding): void {
  const workspace = path.join(root, 'workspace')
  safePath(root, workspace)
  if (!fs.statSync(workspace).isDirectory()) throw new CanonicalStoreError('LayoutUnsafe')
  for (const id of ['C_root', 'C_ws'] as const) {
    const directory = candidateDirectory(root, id)
    if (!exists(directory)) continue
    safePath(root, directory)
    for (const name of SQLITE_FILES)
      if (exists(path.join(directory, name)))
        throw new CanonicalStoreError('ForeignCandidateAfterCanonical')
  }
  const imports = path.join(root, '.canonical-store-import')
  if (!exists(imports)) return
  safePath(root, imports)
  for (const id of fs.readdirSync(imports)) {
    assertUuid(id)
    const manifest = readImportManifest(root, id, binding)
    if (!isImportConsumed(root, id, binding, manifest, true))
      throw new CanonicalStoreError('ForeignCandidateAfterCanonical')
  }
}
/** Normal Pod initialization only checks the committed store; creation/promotion belong to authenticated operator Jobs. */
export function bootCheck(root: string, binding: Binding, fence?: WriterFence): InitOutcome {
  safePath(root, root)
  const stateDir = path.join(root, 'state')
  assertNoIncompleteCanonicalMigration({ root, stateDir })
  if (!exists(path.join(stateDir, 'state.db'))) throw new CanonicalStoreError('CandidateIncomplete')
  const owned = fence ? undefined : acquireWriterFence({ stateDir, requireExisting: true })
  const held = fence ?? owned!
  try {
    held.assertHeld()
    assertNoForeignLayoutCandidates(root, binding)
    const identity = validateCanonicalStore({ root, stateDir, binding })
    const marker = readMarker(root, binding)!
    const journal = validateJournal(
      readJson(root, path.join(operationDirectory(root, marker.migrationId), 'journal.json')),
      binding
    )
    if (
      journal.phase !== 'completed' ||
      journal.identity?.storeId !== identity.storeId ||
      journal.migrationId !== marker.migrationId
    ) {
      throw new CanonicalStoreError('MarkerMismatch')
    }
    held.assertHeld()
    return outcome('AlreadyCanonical', identity)
  } finally {
    owned?.close()
  }
}

/** Stable floor boot checks metadata/schema/binding only; accepted writes must not be compared with the initial snapshot. */
export function validateLegacyStore({
  stateDir,
  binding,
  root,
}: {
  stateDir: string
  binding: Binding
  root?: string
}): LegacyLayoutMarker {
  assertNoIncompleteCanonicalMigration({ root, stateDir })
  const file = path.join(stateDir, 'state.db')
  if (!exists(file)) throw new CanonicalStoreError('CandidateIncomplete')
  validateSqliteSetPaths(root ?? stateDir, file)
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 1000 })
  try {
    validateSupportedSchema(db)
    if (readIdentity(db, binding)) throw new Error('CanonicalStoreLayoutRollback')
  } finally {
    db.close()
  }
  const marker = readLegacyStateRecord(stateDir, binding)
  if (!marker) throw new CanonicalStoreError('MarkerMismatch')
  if (root) {
    if (exists(path.join(root, FINAL_MARKER))) throw new Error('CanonicalStoreLayoutRollback')
    const rootMarker = readLegacyMarker(root, binding)
    if (!rootMarker || objectHash(rootMarker) !== objectHash(marker))
      throw new CanonicalStoreError('MarkerMismatch')
  }
  const archived = path.join(stateDir, '.canonical-store', marker.migrationId, 'journal.json')
  const journal = validateJournal(readJson(root ?? stateDir, archived), binding)
  if (
    journal.writer !== 'layout-precheck' ||
    journal.phase !== 'completed' ||
    journal.identity ||
    journal.migrationId !== marker.migrationId
  ) {
    throw new CanonicalStoreError('MarkerMismatch')
  }
  return marker
}
/** Normal floor init never creates files, runs migrations, adopts a candidate, or repairs metadata. */
export function legacyBootCheck(root: string, binding: Binding, fence?: WriterFence): InitOutcome {
  safePath(root, root)
  const stateDir = path.join(root, 'state')
  assertNoIncompleteCanonicalMigration({ root, stateDir })
  if (!exists(path.join(stateDir, 'state.db'))) throw new CanonicalStoreError('CandidateIncomplete')
  const owned = fence ? undefined : acquireWriterFence({ stateDir, requireExisting: true })
  const held = fence ?? owned!
  try {
    held.assertHeld()
    assertNoForeignLayoutCandidates(root, binding)
    const marker = validateLegacyStore({ root, stateDir, binding })
    held.assertHeld()
    return legacyOutcome('AlreadyLegacy', marker)
  } finally {
    owned?.close()
  }
}
