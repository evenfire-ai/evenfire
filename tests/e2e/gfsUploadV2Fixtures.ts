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

interface FixtureHandle {
  truncate(length: number): Promise<void>
  close(): Promise<void>
}

interface FixtureLease {
  handle: FixtureHandle
  state: 'active' | 'disposed' | 'neutralize-failed-closed' | 'close-failed'
  neutralized: boolean
  failure?: unknown
}

const fixtureLeases = new WeakMap<DiskUploadFixture, FixtureLease>()
let afterFixtureHandleForTest: ((fixture: DiskUploadFixture) => Promise<void> | void) | undefined
let fixtureHandleForTest:
  | ((handle: FileHandle, fixture: DiskUploadFixture) => FixtureHandle)
  | undefined

/** Test-only seam for exercising cleanup after a failure that follows handle acquisition. */
export function setAfterFixtureHandleForTest(
  hook: ((fixture: DiskUploadFixture) => Promise<void> | void) | undefined
): void {
  afterFixtureHandleForTest = hook
}

/** Test-only seam for exercising retained-handle disposal failures. */
export function setFixtureHandleForTest(
  hook: ((handle: FileHandle, fixture: DiskUploadFixture) => FixtureHandle) | undefined
): void {
  fixtureHandleForTest = hook
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
    const ownedHandle = fixtureHandleForTest?.(handle, fixture) ?? handle
    fixtureLeases.set(fixture, {
      handle: ownedHandle,
      state: 'active',
      neutralized: false,
    })
    await afterFixtureHandleForTest?.(fixture)
    await ownedHandle.truncate(byteLength)
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
  if (lease.state === 'neutralize-failed-closed') {
    throw (
      lease.failure ??
      new Error(`GFS v2 fixture disposal failed without a recorded cause: ${fixture.filePath}`)
    )
  }
  if (lease.state === 'close-failed') {
    await retryCloseAfterFailure(fixture, lease)
    return
  }
  try {
    await lease.handle.truncate(0)
    lease.neutralized = true
    await lease.handle.close()
    lease.state = 'disposed'
  } catch (error) {
    await closeAfterDisposalFailure(lease, error)
  }
}

async function closeAfterDisposalFailure(lease: FixtureLease, failure: unknown): Promise<never> {
  try {
    await lease.handle.close()
  } catch (closeError) {
    lease.failure = combineFixtureDisposalFailures(lease.neutralized, failure, closeError)
    lease.state = 'close-failed'
    throw lease.failure
  }
  if (lease.neutralized) {
    lease.state = 'disposed'
  } else {
    lease.failure = failure
    lease.state = 'neutralize-failed-closed'
  }
  throw failure
}

async function retryCloseAfterFailure(
  fixture: DiskUploadFixture,
  lease: FixtureLease
): Promise<void> {
  const previousFailure =
    lease.failure ??
    new Error(`GFS v2 fixture disposal failed without a recorded cause: ${fixture.filePath}`)
  try {
    await lease.handle.close()
  } catch (closeError) {
    lease.failure = combineFixtureDisposalFailures(lease.neutralized, previousFailure, closeError)
    throw lease.failure
  }
  if (lease.neutralized) {
    lease.state = 'disposed'
    return
  }
  lease.state = 'neutralize-failed-closed'
  throw previousFailure
}

function combineFixtureDisposalFailures(
  neutralized: boolean,
  failure: unknown,
  closeError: unknown
): AggregateError {
  return new AggregateError(
    [failure, closeError],
    neutralized
      ? 'failed to close neutralized GFS v2 fixture'
      : 'failed to neutralize and close GFS v2 fixture'
  )
}
