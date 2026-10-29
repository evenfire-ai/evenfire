import { constants } from 'node:fs'
import { type FileHandle, lstat, open } from 'node:fs/promises'

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
