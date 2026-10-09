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

/**
 * A durable view of a marker. New writes include a revision so a producer
 * which started before a deferred logout cannot retire or downgrade that
 * newer logout intent when it eventually finishes.
 *
 * Markers written by earlier builds do not have a revision. They remain
 * readable and can be conditionally changed while they are unchanged.
 */
export type PendingExternalLogoutMarker = {
  intent: PendingExternalLogoutIntent
  revision: string | null
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

function readMarkerContents(filePath: string): string | null {
  let contents: string
  let descriptor: number | undefined
  try {
    const flags =
      process.platform === 'win32'
        ? fs.constants.O_RDONLY
        : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW
    descriptor = fs.openSync(filePath, flags)
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error('Pending logout marker is not a regular file')
    }
    contents = fs.readFileSync(descriptor, 'utf8')
    if (process.platform === 'win32') {
      try {
        if (!fs.lstatSync(filePath).isFile()) {
          throw new Error('Pending logout marker is not a regular file')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') {
      if (process.platform === 'win32') {
        try {
          if (!fs.lstatSync(filePath).isFile()) {
            throw new Error('Pending logout marker is not a regular file')
          }
        } catch (markerError) {
          if ((markerError as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null
          throw markerError
        }
      }
      return null
    }
    if (code === 'ELOOP') {
      throw new Error('Pending logout marker is not a regular file')
    }
    throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }

  return contents
}

function readMarker(filePath: string): PendingExternalLogoutMarker | null {
  const contents = readMarkerContents(filePath)
  if (contents === null) return null

  // Empty markers were only written by this unmerged PR. Preserve them as logout intent.
  if (contents === '') return { intent: { intent: 'logout-pending' }, revision: null }

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
    revision?: unknown
  }
  if (record.version !== MARKER_VERSION) {
    throw new Error('Pending logout marker has an unsupported version')
  }
  const revision =
    record.revision === undefined
      ? null
      : typeof record.revision === 'string' && record.revision.length > 0
        ? record.revision
        : (() => {
            throw new Error('Pending logout marker has an invalid revision')
          })()
  if (record.intent === 'logout-pending') return { intent: { intent: 'logout-pending' }, revision }
  if (
    record.intent !== 'keytar-cleanup-pending' ||
    (record.credentialSource !== 'active-keytar' && record.credentialSource !== 'safe-storage')
  ) {
    throw new Error('Pending logout marker has an unknown intent')
  }
  return {
    intent: {
      intent: 'keytar-cleanup-pending',
      credentialSource: record.credentialSource,
    },
    revision,
  }
}

function writeMarkerIntent(
  userDataDirectory: string,
  envKey: string,
  intent: PendingExternalLogoutIntent,
  revision = randomUUID()
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
    fs.writeFileSync(
      descriptor,
      JSON.stringify({ version: MARKER_VERSION, revision, ...intent }),
      'utf8'
    )
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
  return readPendingExternalLogoutMarker(userDataDirectory, envKey)?.intent ?? null
}

export function readPendingExternalLogoutMarker(
  userDataDirectory: string,
  envKey: string
): PendingExternalLogoutMarker | null {
  return readMarker(markerPath(userDataDirectory, envKey))
}

export function readPendingExternalLogoutContentsRevision(
  userDataDirectory: string,
  envKey: string
): string | null {
  const contents = readMarkerContents(markerPath(userDataDirectory, envKey))
  return contents === null ? null : createHash('sha256').update(contents).digest('hex')
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

function isCurrentMarker(
  current: PendingExternalLogoutMarker | null,
  expected: PendingExternalLogoutMarker
): boolean {
  if (!current || current.revision !== expected.revision) return false
  if (current.intent.intent !== expected.intent.intent) return false
  if (current.intent.intent === 'logout-pending' || expected.intent.intent === 'logout-pending') {
    return current.intent.intent === expected.intent.intent
  }
  return current.intent.credentialSource === expected.intent.credentialSource
}

/**
 * Retire a marker only when it is still the marker the caller originally
 * observed. Synchronous marker I/O keeps this comparison and unlink together
 * with respect to other work in the Electron main process.
 */
export function clearPendingExternalLogoutIfUnchanged(
  userDataDirectory: string,
  envKey: string,
  expected: PendingExternalLogoutMarker
): boolean {
  if (!isCurrentMarker(readPendingExternalLogoutMarker(userDataDirectory, envKey), expected)) {
    return false
  }
  clearPendingExternalLogout(userDataDirectory, envKey)
  return true
}

/** Recreate cleanup intent only after a failed retirement removed the marker. */
export function recordPendingKeytarCleanupIfMissing(
  userDataDirectory: string,
  envKey: string,
  credentialSource: 'active-keytar' | 'safe-storage'
): boolean {
  if (readPendingExternalLogoutMarker(userDataDirectory, envKey) !== null) return false
  writeMarkerIntent(userDataDirectory, envKey, {
    intent: 'keytar-cleanup-pending',
    credentialSource,
  })
  return true
}

/** Retire a malformed marker only if no newer marker replaced its bytes. */
export function clearPendingExternalLogoutIfContentsUnchanged(
  userDataDirectory: string,
  envKey: string,
  expectedContentsRevision: string
): boolean {
  if (
    readPendingExternalLogoutContentsRevision(userDataDirectory, envKey) !==
    expectedContentsRevision
  ) {
    return false
  }
  clearPendingExternalLogout(userDataDirectory, envKey)
  return true
}

/**
 * Convert the marker only when the producer still owns the observed marker.
 * A newer logout-pending marker is intentionally never downgraded to cleanup.
 */
export function recordPendingKeytarCleanupIfUnchanged(
  userDataDirectory: string,
  envKey: string,
  expected: PendingExternalLogoutMarker,
  credentialSource: 'active-keytar' | 'safe-storage'
): boolean {
  if (!isCurrentMarker(readPendingExternalLogoutMarker(userDataDirectory, envKey), expected)) {
    return false
  }
  writeMarkerIntent(userDataDirectory, envKey, {
    intent: 'keytar-cleanup-pending',
    credentialSource,
  })
  return true
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
