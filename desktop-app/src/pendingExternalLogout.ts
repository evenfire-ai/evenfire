import fs from 'node:fs'
import path from 'node:path'

const PENDING_EXTERNAL_LOGOUT_FILE = 'pending-external-logout'

function markerPath(userDataDirectory: string): string {
  if (!path.isAbsolute(userDataDirectory)) {
    throw new Error('Pending logout intent requires an absolute userData path')
  }
  return path.join(userDataDirectory, PENDING_EXTERNAL_LOGOUT_FILE)
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

export function hasPendingExternalLogout(userDataDirectory: string): boolean {
  try {
    const stat = fs.lstatSync(markerPath(userDataDirectory))
    if (!stat.isFile()) throw new Error('Pending logout marker is not a regular file')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return false
    throw error
  }
}

export function recordPendingExternalLogout(userDataDirectory: string): void {
  const filePath = markerPath(userDataDirectory)
  fs.mkdirSync(userDataDirectory, { recursive: true })
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600)
    fs.fsyncSync(descriptor)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error
    if (!hasPendingExternalLogout(userDataDirectory)) throw error
    return
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
  syncDirectory(userDataDirectory)
}

export function clearPendingExternalLogout(userDataDirectory: string): void {
  const filePath = markerPath(userDataDirectory)
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile()) throw new Error('Pending logout marker is not a regular file')
    fs.unlinkSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return
    throw error
  }
  syncDirectory(userDataDirectory)
}
