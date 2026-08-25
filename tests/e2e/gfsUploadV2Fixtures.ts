import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
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

const ownedFixtureDirectories = new Set<string>()

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
  ownedFixtureDirectories.add(directory)
  const fileName = `${label}-${byteLength}${extension}`
  const filePath = path.join(directory, fileName)
  try {
    await writeFile(filePath, Buffer.alloc(0))
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
      await removeOwnedFixtureDirectory(directory)
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
  await removeOwnedFixtureDirectory(fixture.directory)
}

async function removeOwnedFixtureDirectory(directory: string): Promise<void> {
  if (!ownedFixtureDirectories.has(directory)) {
    throw new Error(`refusing to remove an unowned GFS v2 fixture directory: ${directory}`)
  }
  await rm(directory, { recursive: true, force: true })
  ownedFixtureDirectories.delete(directory)
}
