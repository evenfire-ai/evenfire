import { type Stats, constants } from 'node:fs'
import * as fs from 'node:fs/promises'

function isOwned(info: Stats): boolean {
  return typeof process.getuid === 'function' && info.uid === process.getuid()
}

function isExpectedGroup(info: Stats): boolean {
  const groups = typeof process.getgroups === 'function' ? process.getgroups() : []
  if (typeof process.getgid === 'function') groups.push(process.getgid())
  return groups.includes(info.gid)
}

export function isPrivateStoreStatTrusted(info: Stats, kind: 'file' | 'directory'): boolean {
  const expected = kind === 'directory' ? 0o700 : 0o600
  const fsGroupModes = kind === 'directory' ? [0o2700, 0o2770, 0o770] : [0o660]
  const actual = info.mode & 0o7777
  return (
    isOwned(info) &&
    (kind === 'directory' ? info.isDirectory() : info.isFile() && info.nlink === 1) &&
    (actual === expected || (fsGroupModes.includes(actual) && isExpectedGroup(info)))
  )
}

/**
 * The opened inode is trusted, but the name now points at another inode. An
 * atomic rename over the name between open and lstat produces exactly this.
 */
export class PrivateStoreNameMovedError extends Error {
  constructor() {
    super('Private-store inode changed')
    this.name = 'PrivateStoreNameMovedError'
  }
}

/** Restore only the exact kubelet fsGroup expansion of a private, owned inode. */
export async function openPrivateStoreObject(
  filename: string,
  kind: 'file' | 'directory',
  flags = constants.O_RDONLY,
  restore = true,
  beforeMutation?: () => Promise<void>
): Promise<fs.FileHandle> {
  const handle = await fs.open(
    filename,
    flags |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      (kind === 'directory' ? constants.O_DIRECTORY : 0)
  )
  try {
    const info = await handle.stat()
    const identity = await handle.stat({ bigint: true })
    const expected = kind === 'directory' ? 0o700 : 0o600
    const actual = info.mode & 0o7777
    if (!isPrivateStoreStatTrusted(info, kind)) throw new Error('Untrusted private-store inode')
    if (actual !== expected && restore) {
      await beforeMutation?.()
      await handle.chmod(expected)
    }
    const after = await handle.stat()
    const afterIdentity = await handle.stat({ bigint: true })
    const named = await fs.lstat(filename, { bigint: true })
    if (
      afterIdentity.dev !== identity.dev ||
      afterIdentity.ino !== identity.ino ||
      named.isSymbolicLink() ||
      (after.mode & 0o7777) !== (restore ? expected : actual)
    )
      throw new Error('Private-store inode changed')
    if (named.dev !== identity.dev || named.ino !== identity.ino)
      throw new PrivateStoreNameMovedError()
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

export async function verifyPrivateStoreDirectory(directory: string): Promise<void> {
  const handle = await openPrivateStoreObject(directory, 'directory')
  await handle.close()
}
