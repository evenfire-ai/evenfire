/**
 * Builds the on-disk state the ledger-based GFS download store leaves behind,
 * so restart tests can prove the filesystem store never blocks on it.
 *
 * The shapes are copied literally from the dev store at 74e0d81d9:
 * - mcp-host/src/internalTools/gfsDownloadStore.ts (StoreLedger, GfsDownloadRecord,
 *   GfsProcessingLeaseRecord, GfsReceiptOwnerRecord and parseLedger);
 * - mcp-host/src/internalTools/gfsStoreWriterLease.ts (the v2 writer.lock fence
 *   and writer-v2.sqlite).
 * The v3 fence is the one the store at b8f01e18e writes. writer-v2.sqlite is an
 * empty private file: nothing under test opens it.
 */
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export type DevLedgerShape = 'records' | 'processingLeasesEmpty' | 'none'
export type DevFenceShape = 'v2-matching' | 'v2-mismatched-device' | 'v2-no-device' | 'v3' | 'none'
export type DevUserDirectoryState =
  | 'completed'
  | 'transferring-partial'
  | 'quarantined'
  | 'missing'
  | 'orphan-partial'

export interface DevStoreShape {
  ledger: DevLedgerShape
  fence: DevFenceShape
  sqlite: boolean
  userDirs: DevUserDirectoryState[]
  /** A processing lease left by a crashed pre-#1019 Host, expired or still live. */
  lease?: 'expired' | 'live'
}

export interface DevStore {
  /** `<root>/.gfs-download-store`. */
  storeRoot: string
  /** The exact ledger-v1.json text written, when the shape has a ledger. */
  ledgerText?: string
  /** Absolute `input-<uuid>` directories written under the caller root. */
  userDirectories: string[]
  /** Bytes of every source and source.partial file written. */
  userBytes: number
  callerIdentity: string
  callerRoot: string
}

const OWNERSHIP = 'sqlite-exclusive-v1'
export const DEV_CALLER_IDENTITY = 'caller-dev'
const LEASE_ID = '77777777-7777-4777-8777-777777777777'
const WRITER_SESSION_ID = '88888888-8888-4888-8888-888888888888'
const FILE_BYTES = 4096

function recordState(state: DevUserDirectoryState): string | undefined {
  switch (state) {
    case 'completed':
      return 'completed'
    case 'transferring-partial':
      return 'transferring'
    case 'quarantined':
      return 'quarantined'
    case 'missing':
      return 'missing'
    case 'orphan-partial':
      return undefined
  }
}

export async function buildDevStore(root: string, shape: DevStoreShape): Promise<DevStore> {
  const storeRoot = path.join(root, '.gfs-download-store')
  const callerRoot = path.join(root, 'users', DEV_CALLER_IDENTITY)
  await fs.mkdir(callerRoot, { recursive: true, mode: 0o700 })
  const now = Date.now()
  const records: Record<string, unknown> = {}
  const userDirectories: string[] = []
  let userBytes = 0

  for (const [index, state] of shape.userDirs.entries()) {
    const id = randomUUID()
    const directory = path.join('users', DEV_CALLER_IDENTITY, '.gfs-downloads', `input-${id}`)
    const absolute = path.join(root, directory)
    await fs.mkdir(absolute, { recursive: true, mode: 0o700 })
    userDirectories.push(absolute)
    const bytes = Buffer.alloc(FILE_BYTES, index + 1)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (state === 'completed' || state === 'quarantined') {
      await fs.writeFile(path.join(absolute, 'source'), bytes, { mode: 0o600 })
      userBytes += bytes.byteLength
    }
    if (state === 'transferring-partial' || state === 'orphan-partial') {
      await fs.writeFile(path.join(absolute, 'source.partial'), bytes, { mode: 0o600 })
      userBytes += bytes.byteLength
    }
    const ledgerState = recordState(state)
    if (ledgerState === undefined) continue
    const resourceId = (index + 1).toString(16).padStart(32, '0')
    records[id] = {
      id,
      callerIdentity: DEV_CALLER_IDENTITY,
      source: {
        kind: 'gfs',
        drive: 'main',
        resourceId,
        gfsUri: `gfs://main/${resourceId}`,
        name: `dev-${index + 1}.bin`,
        version: 1,
      },
      directory,
      path: path.join('.gfs-downloads', `input-${id}`, 'source'),
      hostPath: path.join(directory, 'source'),
      sizeBytes: bytes.byteLength,
      ...(ledgerState === 'transferring' ? {} : { sha256 }),
      createdAt: new Date(now - 60 * 60_000).toISOString(),
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
      state: ledgerState,
    }
  }

  const hasStoreRoot = shape.ledger !== 'none' || shape.fence !== 'none' || shape.sqlite
  if (hasStoreRoot) await fs.mkdir(storeRoot, { mode: 0o700 })

  let ledgerText: string | undefined
  if (shape.ledger !== 'none') {
    const processingLeases: Record<string, unknown> = {}
    if (shape.lease !== undefined)
      processingLeases[LEASE_ID] = {
        leaseId: LEASE_ID,
        callerIdentity: '_system',
        recordIds: [],
        acquiredAt: new Date(now - 120_000).toISOString(),
        expiresAt: new Date(now + (shape.lease === 'live' ? 600_000 : -60_000)).toISOString(),
        writerSessionId: WRITER_SESSION_ID,
      }
    const ledger =
      shape.ledger === 'records'
        ? { schemaVersion: 1, records, processingLeases, retentionOwners: {} }
        : { schemaVersion: 1, records: {}, processingLeases }
    ledgerText = JSON.stringify(ledger)
    await fs.writeFile(path.join(storeRoot, 'ledger-v1.json'), ledgerText, { mode: 0o600 })
  }

  const databasePath = path.join(storeRoot, 'writer-v2.sqlite')
  if (shape.sqlite) await fs.writeFile(databasePath, '', { mode: 0o600 })

  if (shape.fence !== 'none') {
    // The fence names the database inode; without a database file it names a
    // fixed one, as a fence left next to a lost database would.
    const identity = shape.sqlite
      ? await fs.stat(databasePath, { bigint: true })
      : { dev: 1n, ino: 1n }
    const fence =
      shape.fence === 'v2-matching'
        ? {
            schemaVersion: 2,
            ownership: OWNERSHIP,
            databaseDevice: String(identity.dev),
            databaseInode: String(identity.ino),
          }
        : shape.fence === 'v2-mismatched-device'
          ? {
              schemaVersion: 2,
              ownership: OWNERSHIP,
              databaseDevice: String(identity.dev + 1n),
              databaseInode: String(identity.ino),
            }
          : shape.fence === 'v2-no-device'
            ? { schemaVersion: 2, ownership: OWNERSHIP, databaseInode: String(identity.ino) }
            : { schemaVersion: 3, ownership: OWNERSHIP, databaseInode: String(identity.ino) }
    await fs.writeFile(path.join(storeRoot, 'writer.lock'), JSON.stringify(fence), {
      mode: 0o600,
    })
  }

  return {
    storeRoot,
    ...(ledgerText === undefined ? {} : { ledgerText }),
    userDirectories,
    userBytes,
    callerIdentity: DEV_CALLER_IDENTITY,
    callerRoot,
  }
}
