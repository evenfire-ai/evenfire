import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as promises from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

type PhysicalFileSystem = Pick<
  typeof fs,
  'constants' | 'createReadStream' | 'createWriteStream'
> & { promises: typeof promises }

// Updater paths describe physical files, including the app.asar container itself.
// Logical ASAR entries are inspected separately through @electron/asar.
export const updaterFileSystem: PhysicalFileSystem = process.versions.electron
  ? (require('original-fs') as PhysicalFileSystem)
  : {
      constants: fs.constants,
      createReadStream: fs.createReadStream,
      createWriteStream: fs.createWriteStream,
      promises,
    }

const { constants } = updaterFileSystem
const { lstat, open } = updaterFileSystem.promises

export type OpenedRegularFile = {
  handle: FileHandle
  size: number
  mode: number
}

export async function openRegularFileNoFollow(filePath: string): Promise<OpenedRegularFile> {
  const noFollow = constants.O_NOFOLLOW ?? 0
  const nonBlocking = constants.O_NONBLOCK ?? 0
  const handle = await open(filePath, constants.O_RDONLY | noFollow | nonBlocking)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile()) throw new Error('The updater expected a regular file.')

    // O_NOFOLLOW is unavailable on Windows. The descriptor pins the opened file;
    // compare its identity with the path after opening before trusting its bytes.
    const current = await lstat(filePath, { bigint: true })
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      (process.platform === 'win32' && opened.ino === 0n)
    ) {
      throw new Error('The updater file changed while it was being opened.')
    }

    return {
      handle,
      size: Number(opened.size),
      mode: Number(opened.mode),
    }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

export async function readRegularFileNoFollow(filePath: string, maximumBytes: number) {
  const opened = await openRegularFileNoFollow(filePath)
  try {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || opened.size > maximumBytes) {
      throw new Error('The updater metadata file exceeds its size limit.')
    }
    const bytes = Buffer.alloc(maximumBytes + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await opened.handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset > maximumBytes) throw new Error('The updater metadata file exceeds its size limit.')
    return bytes.subarray(0, offset)
  } finally {
    await opened.handle.close()
  }
}

export async function readFileSha256(filePath: string): Promise<string> {
  const opened = await openRegularFileNoFollow(filePath)
  try {
    const hash = createHash('sha256')
    for await (const chunk of opened.handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer)
    }
    return hash.digest('hex')
  } finally {
    await opened.handle.close()
  }
}
