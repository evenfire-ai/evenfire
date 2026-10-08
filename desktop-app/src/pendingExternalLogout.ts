import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PENDING_EXTERNAL_LOGOUT_PREFIX = 'pending-external-logout-'

function markerPath(userDataDirectory: string, envKey: string): string {
  if (!path.isAbsolute(userDataDirectory)) {
    throw new Error('Pending logout intent requires an absolute userData path')
  }
  if (!/^[a-z0-9_]+-[0-9a-f]{12}$/.test(envKey)) {
    throw new Error('Pending logout intent requires a valid environment key')
  }
  const environmentId = createHash('sha256').update(envKey).digest('hex')
  return path.join(userDataDirectory, `${PENDING_EXTERNAL_LOGOUT_PREFIX}${environmentId}`)
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (
      process.platform !== 'win32' ||
      !['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes(String(code))
    ) {
      throw error
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

export function hasPendingExternalLogout(userDataDirectory: string, envKey: string): boolean {
  const filePath = markerPath(userDataDirectory, envKey)
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile()) throw new Error('Pending logout marker is not a regular file')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
  }
  return false
}

export function recordPendingExternalLogout(userDataDirectory: string, envKey: string): void {
  const filePath = markerPath(userDataDirectory, envKey)
  fs.mkdirSync(userDataDirectory, { recursive: true })
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600)
    fs.fsyncSync(descriptor)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error
    if (!hasPendingExternalLogout(userDataDirectory, envKey)) throw error
    return
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
  syncDirectory(userDataDirectory)
}

export function clearPendingExternalLogout(userDataDirectory: string, envKey: string): void {
  let removed = false
  const filePath = markerPath(userDataDirectory, envKey)
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile()) throw new Error('Pending logout marker is not a regular file')
    fs.unlinkSync(filePath)
    removed = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
  }
  if (removed) syncDirectory(userDataDirectory)
}
