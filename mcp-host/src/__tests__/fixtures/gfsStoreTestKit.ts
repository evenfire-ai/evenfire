/**
 * Helpers for GFS download store tests that write the volume directly, the
 * way a shell command running with the Host UID can. They use the synchronous
 * `node:fs` API and `crypto.hash`, so a test that mocks `node:fs/promises` or
 * `createHash` to observe the store never counts the fixture's own calls.
 */
import { hash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { register } from 'prom-client'
import type { GfsImageSource } from '../../visualInput/policy'

export function sourceFor(index: number, version = 1): GfsImageSource {
  const resourceId = index.toString(16).padStart(32, '0')
  return {
    kind: 'gfs',
    drive: 'main',
    resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    name: `fixture-${index}.bin`,
    version,
  }
}

export function digestOf(bytes: Buffer): string {
  return hash('sha256', bytes, 'hex')
}

/** `<host>/users/<key>`, created private if missing. */
export function callerDirectory(host: string, key: string): string {
  const root = path.join(host, 'users', key)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  return root
}

export function downloadDirectory(root: string, id: string): string {
  return path.join(root, '.gfs-downloads', `input-${id}`)
}

export function exists(target: string): boolean {
  try {
    fs.lstatSync(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** A schema-1 meta.json body for `bytes`, valid for one hour from `nowMs`. */
export function metaFor(
  id: string,
  bytes: Buffer,
  nowMs: number,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id,
    callerIdentity: 'planted-identity',
    source: sourceFor(900),
    sizeBytes: bytes.byteLength,
    sha256: digestOf(bytes),
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + 60 * 60_000).toISOString(),
    ...overrides,
  }
}

export interface PlantedDownload {
  id: string
  directory: string
  sourcePath: string
}

/**
 * Writes `<callerRoot>/.gfs-downloads/input-<id>/{meta.json, source}` without
 * the store. `meta: 'omit'` or `source: 'omit'` leaves that file out; a string
 * `meta` is written verbatim.
 */
export function plantDownload(
  callerRoot: string,
  options: {
    id?: string
    bytes: Buffer
    meta: Record<string, unknown> | string | 'omit'
    source?: 'write' | 'omit'
    directoryMode?: number
    sourceMode?: number
  }
): PlantedDownload {
  const id = options.id ?? randomUUID()
  const directory = downloadDirectory(callerRoot, id)
  fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(directory), 0o700)
  fs.mkdirSync(directory, { mode: 0o700 })
  const sourcePath = path.join(directory, 'source')
  if (options.meta !== 'omit')
    fs.writeFileSync(
      path.join(directory, 'meta.json'),
      typeof options.meta === 'string' ? options.meta : JSON.stringify(options.meta),
      { mode: 0o600 }
    )
  if (options.source !== 'omit') {
    fs.writeFileSync(sourcePath, options.bytes, { mode: 0o600 })
    if (options.sourceMode !== undefined) fs.chmodSync(sourcePath, options.sourceMode)
  }
  if (options.directoryMode !== undefined) fs.chmodSync(directory, options.directoryMode)
  return { id, directory, sourcePath }
}

export async function metricValue(name: string, labels: Record<string, string>): Promise<number> {
  const metric = register.getSingleMetric(name)
  if (metric === undefined) throw new Error(`metric ${name} is not registered`)
  const { values } = await metric.get()
  return values
    .filter(sample => Object.entries(labels).every(([key, value]) => sample.labels[key] === value))
    .reduce((sum, sample) => sum + sample.value, 0)
}

export const expiryCount = (outcome: string) =>
  metricValue('clerum_gfs_download_expiry_total', { outcome })
export const quotaCount = (scope: string, reason: string) =>
  metricValue('clerum_gfs_download_quota_total', { scope, reason })

/** The store operations the shared transfer helpers need. */
export interface TransferringStore {
  createTransfer(input: {
    callerIdentity: string
    callerWorkspacePath: string
    source: GfsImageSource
    sizeBytes: number
    expiresAt: string
    retentionOwnerId?: string
  }): Promise<{
    id: string
    path: string
    partialPath: string
    sizeBytes: number
    expiresAt: string
  }>
  publish(
    id: string,
    callerIdentity: string,
    sha256: string
  ): Promise<{ id: string; path: string; sha256: string; expiresAt: string }>
}

/** Admits a transfer and writes its partial file; `fill` sets every byte. */
export async function startTransfer(
  store: TransferringStore,
  root: string,
  caller: string,
  index: number,
  sizeBytes: number,
  options: { version?: number; owner?: string; expiresAt?: string; fill?: number } = {}
) {
  const bytes = Buffer.alloc(sizeBytes, options.fill ?? (index % 251) + 1)
  const transfer = await store.createTransfer({
    callerIdentity: caller,
    callerWorkspacePath: root,
    source: sourceFor(index, options.version ?? 1),
    sizeBytes,
    expiresAt: options.expiresAt ?? new Date(Date.now() + 60 * 60_000).toISOString(),
    ...(options.owner === undefined ? {} : { retentionOwnerId: options.owner }),
  })
  fs.writeFileSync(path.join(root, transfer.partialPath), bytes)
  return { transfer, bytes }
}

export async function completedCopy(
  store: TransferringStore,
  root: string,
  caller: string,
  index: number,
  sizeBytes: number,
  options: { version?: number; owner?: string; expiresAt?: string; fill?: number } = {}
) {
  const { transfer, bytes } = await startTransfer(store, root, caller, index, sizeBytes, options)
  const receipt = await store.publish(transfer.id, caller, digestOf(bytes))
  return { receipt, bytes }
}

/**
 * Re-imports `modulePath` with environment limits applied, then restores the
 * environment. The imported store's logger is not the test's spied instance.
 */
export async function withEnvironment<T>(
  env: Record<string, string>,
  load: () => Promise<T>
): Promise<T> {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  try {
    return await load()
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
