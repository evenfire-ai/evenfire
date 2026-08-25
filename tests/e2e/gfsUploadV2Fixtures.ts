import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { type FileHandle, mkdtemp, open } from 'node:fs/promises'
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

interface FixtureLease {
  handle: FileHandle
  state: 'active' | 'disposed'
}

const fixtureLeases = new WeakMap<DiskUploadFixture, FixtureLease>()
let afterFixtureHandleForTest: ((fixture: DiskUploadFixture) => Promise<void> | void) | undefined

/** Test-only seam for exercising cleanup after a failure that follows handle acquisition. */
export function setAfterFixtureHandleForTest(
  hook: ((fixture: DiskUploadFixture) => Promise<void> | void) | undefined
): void {
  afterFixtureHandleForTest = hook
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
  const fileName = `${label}-${byteLength}${extension}`
  const filePath = path.join(directory, fileName)
  let fixture: DiskUploadFixture | undefined
  try {
    const handle = await open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600
    )
    fixture = {
      directory,
      filePath,
      fileName,
      byteLength,
      sha256: '',
    }
    fixtureLeases.set(fixture, { handle, state: 'active' })
    await afterFixtureHandleForTest?.(fixture)
    await handle.truncate(byteLength)
    fixture.sha256 = await sha256File(filePath)
    return fixture
  } catch (error) {
    if (fixture) {
      try {
        await disposeFixtureLease(fixture)
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'failed to neutralize partial GFS v2 fixture'
        )
      }
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
  const lease = fixtureLeases.get(fixture)
  if (!lease) {
    throw new Error(`refusing to neutralize an unowned GFS v2 fixture: ${fixture.filePath}`)
  }
  await disposeFixtureLease(fixture)
}

async function disposeFixtureLease(fixture: DiskUploadFixture): Promise<void> {
  const lease = fixtureLeases.get(fixture)
  if (!lease) {
    throw new Error(`refusing to neutralize an unowned GFS v2 fixture: ${fixture.filePath}`)
  }
  if (lease.state === 'disposed') return
  try {
    await lease.handle.truncate(0)
    await lease.handle.close()
    lease.state = 'disposed'
  } catch (error) {
    try {
      await lease.handle.close()
    } catch {
      // Preserve the original failure; this test-only helper has no pathname fallback.
    }
    throw error
  }
}
