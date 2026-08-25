import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, mkdtemp, open, readdir, rename, rmdir, truncate, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Test-only default for runtime Upload v2 journeys; GFSC remains the product-policy authority. */
export const E2E_GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES = 209_715_200
/** @deprecated Use E2E_GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES in new test plumbing. */
export const GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES = E2E_GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES
export const GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES = 1_073_741_824
export const GFS_UPLOAD_V2_BOUNDARIES = [
  E2E_GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES - 1,
  E2E_GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES,
] as const

export interface DiskUploadFixture {
  directory: string
  filePath: string
  fileName: string
  byteLength: number
  sha256: string
}

interface FilesystemIdentity {
  dev: number
  ino: number
}

interface FixtureLease {
  directory: string
  directoryIdentity: FilesystemIdentity
  expectedFileName?: string
  expectedFileIdentity?: FilesystemIdentity
  quarantineDirectory?: string
  state: 'active' | 'quarantined' | 'disposed'
}

const fixtureLeases = new Map<string, FixtureLease>()
let afterFixtureQuarantineForTest:
  | ((directory: string, quarantineDirectory: string) => Promise<void> | void)
  | undefined

/** Test-only synchronization seam for proving that recreation after quarantine is harmless. */
export function setAfterFixtureQuarantineForTest(
  hook: ((directory: string, quarantineDirectory: string) => Promise<void> | void) | undefined
): void {
  afterFixtureQuarantineForTest = hook
}

/**
 * Creates a deterministic sparse, zero-filled fixture on disk. Playwright
 * receives only the path, never a 200 MiB Buffer or ArrayBuffer.
 */
export async function createDiskUploadFixture(
  byteLength: number,
  extension = '.parquet',
  label = 'gfs-v2'
): Promise<DiskUploadFixture> {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0 ||
    byteLength > GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES
  ) {
    throw new Error(`invalid GFS v2 fixture size: ${byteLength}`)
  }
  return createFixture(byteLength, extension, label)
}

/**
 * Creates a single-byte-over-product-limit fixture for opt-in negative
 * journeys. Both helpers remain fail-closed at the protocol ceiling.
 */
export async function createOversizedDiskUploadFixture(
  extension = '.parquet',
  label = 'gfs-v2-oversize',
  productMaxBytes = E2E_GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES
): Promise<DiskUploadFixture> {
  if (
    !Number.isSafeInteger(productMaxBytes) ||
    productMaxBytes < 1 ||
    productMaxBytes >= GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES
  ) {
    throw new Error(`invalid GFS v2 product maximum: ${productMaxBytes}`)
  }
  return createFixture(productMaxBytes + 1, extension, label)
}

async function createFixture(
  byteLength: number,
  extension: string,
  label: string
): Promise<DiskUploadFixture> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evenfire-gfs-upload-v2-'))
  let lease: FixtureLease
  try {
    lease = {
      directory,
      directoryIdentity: await directoryIdentity(directory),
      state: 'active',
    }
    fixtureLeases.set(directory, lease)
  } catch (error) {
    await rmdir(directory).catch(() => undefined)
    throw error
  }

  const fileName = `${label}-${byteLength}${extension}`
  const filePath = path.join(directory, fileName)
  lease.expectedFileName = fileName
  try {
    const handle = await open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    )
    lease.expectedFileIdentity = await regularFileIdentity(filePath)
    await handle.close()
    await truncate(filePath, byteLength)
    return {
      directory,
      filePath,
      fileName,
      byteLength,
      sha256: await sha256File(filePath),
    }
  } catch (error) {
    try {
      await disposeFixtureLease(lease)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'failed to clean partial GFS v2 fixture')
    }
    throw error
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export async function removeDiskUploadFixture(fixture: DiskUploadFixture): Promise<void> {
  const lease = fixtureLeases.get(fixture.directory)
  if (!lease) {
    throw new Error(`refusing to remove an unowned GFS v2 fixture directory: ${fixture.directory}`)
  }
  await disposeFixtureLease(lease)
}

async function disposeFixtureLease(lease: FixtureLease): Promise<void> {
  if (lease.state === 'disposed') return
  if (lease.state === 'active') await quarantineFixtureDirectory(lease)
  await cleanQuarantinedFixtureDirectory(lease)
}

async function directoryIdentity(directory: string): Promise<FilesystemIdentity> {
  const metadata = await lstat(directory)
  if (!metadata.isDirectory()) throw new Error(`fixture directory is not a directory: ${directory}`)
  return { dev: metadata.dev, ino: metadata.ino }
}

async function regularFileIdentity(filePath: string): Promise<FilesystemIdentity> {
  const metadata = await lstat(filePath)
  if (!metadata.isFile()) throw new Error(`fixture file is not a regular file: ${filePath}`)
  return { dev: metadata.dev, ino: metadata.ino }
}

function identitiesMatch(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function quarantineFixtureDirectory(lease: FixtureLease): Promise<void> {
  let currentIdentity: FilesystemIdentity
  try {
    currentIdentity = await directoryIdentity(lease.directory)
  } catch (error) {
    throw new Error(`cannot quarantine active GFS v2 fixture directory: ${lease.directory}`, {
      cause: error,
    })
  }
  if (!identitiesMatch(currentIdentity, lease.directoryIdentity)) {
    throw new Error(
      `refusing to quarantine a replaced GFS v2 fixture directory: ${lease.directory}`
    )
  }

  const quarantineDirectory = path.join(
    path.dirname(lease.directory),
    `${path.basename(lease.directory)}-quarantine-${randomUUID()}`
  )
  await rename(lease.directory, quarantineDirectory)
  lease.quarantineDirectory = quarantineDirectory
  lease.state = 'quarantined'
  await afterFixtureQuarantineForTest?.(lease.directory, quarantineDirectory)

  const quarantinedIdentity = await directoryIdentity(quarantineDirectory)
  if (identitiesMatch(quarantinedIdentity, lease.directoryIdentity)) return

  throw new Error(
    `refusing to remove a replaced GFS v2 fixture directory; retained at ${quarantineDirectory}`
  )
}

async function cleanQuarantinedFixtureDirectory(lease: FixtureLease): Promise<void> {
  const quarantineDirectory = lease.quarantineDirectory
  if (!quarantineDirectory) {
    throw new Error(`missing quarantine directory for GFS v2 fixture: ${lease.directory}`)
  }

  const quarantinedIdentity = await directoryIdentity(quarantineDirectory)
  if (!identitiesMatch(quarantinedIdentity, lease.directoryIdentity)) {
    throw new Error(
      `refusing to remove a replaced GFS v2 fixture directory; retained at ${quarantineDirectory}`
    )
  }

  const entries = await readdir(quarantineDirectory)
  if (!lease.expectedFileIdentity) {
    if (entries.length > 0) {
      throw new Error(
        `refusing to remove unexpected GFS v2 fixture contents: ${quarantineDirectory}`
      )
    }
  } else {
    if (entries.length !== 1 || entries[0] !== lease.expectedFileName) {
      throw new Error(
        `refusing to remove unexpected GFS v2 fixture contents: ${quarantineDirectory}`
      )
    }
    const filePath = path.join(quarantineDirectory, lease.expectedFileName)
    const fileIdentity = await regularFileIdentity(filePath)
    if (!identitiesMatch(fileIdentity, lease.expectedFileIdentity)) {
      throw new Error(`refusing to remove a replaced GFS v2 fixture file: ${filePath}`)
    }
    await unlink(filePath)
  }
  await rmdir(quarantineDirectory)
  lease.state = 'disposed'
}
