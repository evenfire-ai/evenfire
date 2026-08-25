import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES = 209_715_200
export const GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES = 1_073_741_824
export const GFS_UPLOAD_V2_BOUNDARIES = [
  GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES - 1,
  GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES,
] as const

export interface DiskUploadFixture {
  directory: string
  filePath: string
  fileName: string
  byteLength: number
  sha256: string
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
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evenfire-gfs-upload-v2-'))
  const fileName = `${label}-${byteLength}${extension}`
  const filePath = path.join(directory, fileName)
  await writeFile(filePath, Buffer.alloc(0))
  await truncate(filePath, byteLength)
  return {
    directory,
    filePath,
    fileName,
    byteLength,
    sha256: await sha256File(filePath),
  }
}

/**
 * Creates a single-byte-over-product-limit fixture for opt-in negative
 * journeys. Both helpers remain fail-closed at the protocol ceiling.
 */
export async function createOversizedDiskUploadFixture(
  extension = '.parquet',
  label = 'gfs-v2-oversize',
  productMaxBytes = GFS_UPLOAD_V2_DEFAULT_PRODUCT_MAX_BYTES
): Promise<DiskUploadFixture> {
  if (
    !Number.isSafeInteger(productMaxBytes) ||
    productMaxBytes < 1 ||
    productMaxBytes >= GFS_UPLOAD_V2_PROTOCOL_MAX_BYTES
  ) {
    throw new Error(`invalid GFS v2 product maximum: ${productMaxBytes}`)
  }
  const byteLength = productMaxBytes + 1
  const directory = await mkdtemp(path.join(os.tmpdir(), 'evenfire-gfs-upload-v2-'))
  const fileName = `${label}-${byteLength}${extension}`
  const filePath = path.join(directory, fileName)
  await writeFile(filePath, Buffer.alloc(0))
  await truncate(filePath, byteLength)
  return {
    directory,
    filePath,
    fileName,
    byteLength,
    sha256: await sha256File(filePath),
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export async function removeDiskUploadFixture(fixture: DiskUploadFixture): Promise<void> {
  await rm(fixture.directory, { recursive: true, force: true })
}
