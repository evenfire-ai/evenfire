import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const PENDING_EXTERNAL_LOGOUT_PREFIX = 'pending-external-logout-'
const MARKER_VERSION = 1

export type PendingExternalLogoutIntent =
  | { intent: 'logout-pending' }
  | {
      intent: 'keytar-cleanup-pending'
      credentialSource: 'active-keytar' | 'safe-storage'
    }

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

function readMarkerIntent(filePath: string): PendingExternalLogoutIntent | null {
  let contents: string
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile()) throw new Error('Pending logout marker is not a regular file')
    contents = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null
    throw error
  }

  // Empty markers were only written by this unmerged PR. Preserve them as logout intent.
  if (contents === '') return { intent: 'logout-pending' }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    throw new Error('Pending logout marker has an invalid format')
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Pending logout marker has an invalid format')
  }
  const record = parsed as {
    version?: unknown
    intent?: unknown
    credentialSource?: unknown
  }
  if (record.version !== MARKER_VERSION) {
    throw new Error('Pending logout marker has an unsupported version')
  }
  if (record.intent === 'logout-pending') return { intent: 'logout-pending' }
  if (
    record.intent !== 'keytar-cleanup-pending' ||
    (record.credentialSource !== 'active-keytar' && record.credentialSource !== 'safe-storage')
  ) {
    throw new Error('Pending logout marker has an unknown intent')
  }
  return {
    intent: 'keytar-cleanup-pending',
    credentialSource: record.credentialSource,
  }
}

function writeMarkerIntent(
  userDataDirectory: string,
  envKey: string,
  intent: PendingExternalLogoutIntent
): void {
  const filePath = markerPath(userDataDirectory, envKey)
  fs.mkdirSync(userDataDirectory, { recursive: true })
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile()) throw new Error('Pending logout marker is not a regular file')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
  }

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, JSON.stringify({ version: MARKER_VERSION, ...intent }), 'utf8')
    fs.fsyncSync(descriptor)
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
      // Preserve the original write error.
    }
    throw error
  }
  fs.closeSync(descriptor)

  try {
    fs.renameSync(temporaryPath, filePath)
    syncDirectory(userDataDirectory)
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
      // The rename may already have succeeded; callers fail closed and repair intent.
    }
    throw error
  }
}

export function readPendingExternalLogoutIntent(
  userDataDirectory: string,
  envKey: string
): PendingExternalLogoutIntent | null {
  return readMarkerIntent(markerPath(userDataDirectory, envKey))
}

export function hasPendingExternalLogout(userDataDirectory: string, envKey: string): boolean {
  return readPendingExternalLogoutIntent(userDataDirectory, envKey) !== null
}

export function recordPendingExternalLogout(userDataDirectory: string, envKey: string): void {
  writeMarkerIntent(userDataDirectory, envKey, { intent: 'logout-pending' })
}

export function recordPendingKeytarCleanup(
  userDataDirectory: string,
  envKey: string,
  credentialSource: 'active-keytar' | 'safe-storage'
): void {
  const existingIntent = readPendingExternalLogoutIntent(userDataDirectory, envKey)
  if (
    existingIntent?.intent === 'keytar-cleanup-pending' &&
    existingIntent.credentialSource === credentialSource
  ) {
    return
  }
  writeMarkerIntent(userDataDirectory, envKey, {
    intent: 'keytar-cleanup-pending',
    credentialSource,
  })
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
