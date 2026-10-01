import type { Database } from 'better-sqlite3'
import { assertUuid, compareBinding } from './paths'
import { type Binding, type CanonicalIdentity, CanonicalStoreError } from './types'

export function readIdentity(db: Database, binding?: Binding): CanonicalIdentity | undefined {
  const table = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='canonical_store_identity'")
    .get()
  if (!table) return undefined
  const rows = db
    .prepare(
      'SELECT singleton, store_id, layout_version, host_uid, pvc_uid, created_at, provenance FROM canonical_store_identity'
    )
    .safeIntegers(false)
    .all() as Array<{
    singleton: number
    store_id: string
    layout_version: number
    host_uid: string
    pvc_uid: string
    created_at: string
    provenance: string
  }>
  if (rows.length === 0) return undefined
  if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].layout_version !== 1)
    throw new CanonicalStoreError('MarkerMismatch')
  const row = rows[0]
  assertUuid(row.store_id)
  if (
    typeof row.created_at !== 'string' ||
    !Number.isFinite(Date.parse(row.created_at)) ||
    typeof row.provenance !== 'string' ||
    !row.provenance
  )
    throw new CanonicalStoreError('MarkerMismatch')
  const identity: CanonicalIdentity = {
    storeId: row.store_id,
    layoutVersion: 1,
    hostUid: row.host_uid,
    pvcUid: row.pvc_uid,
    createdAt: row.created_at,
    provenance: row.provenance,
  }
  if (binding) compareBinding(identity, binding)
  return identity
}
export function insertIdentity(db: Database, identity: CanonicalIdentity): void {
  const existing = readIdentity(db, identity)
  if (existing) {
    if (existing.storeId !== identity.storeId) throw new CanonicalStoreError('MarkerMismatch')
    return
  }
  db.prepare(
    `INSERT INTO canonical_store_identity
    (singleton,store_id,layout_version,host_uid,pvc_uid,created_at,provenance) VALUES (1,?,1,?,?,?,?)`
  ).run(
    identity.storeId,
    identity.hostUid,
    identity.pvcUid,
    identity.createdAt,
    identity.provenance
  )
}
