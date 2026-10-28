import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  renameSessionAuthorityFileDurablySync,
  retireSessionCredentialFileDurablySync,
} from './sessionAuthorityDurableFileOps.js'

const PENDING_EXTERNAL_LOGOUT_PREFIX = 'pending-external-logout-'
const MARKER_VERSION = 1
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const markerReadFailures = new WeakSet<object>()
const markerWriteFailures = new WeakSet<object>()

/** Synchronous scope assertion run before and after each marker filesystem operation. */
export type PendingExternalLogoutStorageGuard = () => void

function guarded<T>(guard: PendingExternalLogoutStorageGuard | undefined, operation: () => T): T {
  guard?.()
  try {
    return operation()
  } finally {
    guard?.()
  }
}

/** CAS callers distinguish pre-mutation inspection from post-mutation sync failure. */
export function isPendingExternalLogoutReadFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && markerReadFailures.has(error)
}

/** A failed marker mutation is never evidence that a memory-only restart fence was committed. */
export function isPendingExternalLogoutWriteFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && markerWriteFailures.has(error)
}

/** Temporary inspection failures do not establish corruption or logout intent. */
export function isTransientPendingLogoutReadError(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    markerWriteFailures.has(error) ||
    !markerReadFailures.has(error)
  )
    return false
  const code = (error as NodeJS.ErrnoException | null)?.code
  return (
    typeof code === 'string' &&
    ['EIO', 'EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EINTR'].includes(code)
  )
}

export type PendingExternalLogoutIntent =
  | { intent: 'logout-pending' }
  | { intent: 'memory-only-session'; volatileSessionId: string }
  | {
      intent: 'keytar-cleanup-pending'
      credentialSource: 'active-keytar' | 'safe-storage'
    }
  | {
      intent: 'acceptance-pending'
      purpose: 'candidate-acceptance'
      operationId: string
      expectedAuthorityRevision: string | null
      expectedAuthorityDigest: string
      priorMarkerKind: 'absent' | 'legacy-unrevisioned' | 'revisioned'
      priorMarkerDigest: string
      priorMarkerRevision: string | null
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

export type PendingExternalLogoutCas = {
  expected: PendingExternalLogoutMarker | null
  next: PendingExternalLogoutMarker | null
}

export type PendingExternalLogoutObservation =
  | { status: 'observed'; marker: PendingExternalLogoutMarker | null }
  | { status: 'transient' | 'invalid'; error: unknown }

export type PendingExternalLogoutRawObservation = {
  rawContents: string | null
  rawDigest: string
  kind: 'absent' | 'legacy-unrevisioned' | 'revisioned'
  marker: PendingExternalLogoutMarker | null
}

export type AcceptancePendingMarker = {
  version: 2
  intent: 'acceptance-pending'
  purpose: 'candidate-acceptance'
  operationId: string
  revision: string
  expectedAuthorityRevision: string | null
  expectedAuthorityDigest: string
  priorMarkerKind: 'absent' | 'legacy-unrevisioned' | 'revisioned'
  priorMarkerDigest: string
  priorMarkerRevision: string | null
}

/** Convert the V2 raw sidecar image into the current reader's typed marker view. */
export function acceptancePendingExternalMarker(
  marker: AcceptancePendingMarker
): PendingExternalLogoutMarker {
  return {
    intent: {
      intent: 'acceptance-pending',
      purpose: marker.purpose,
      operationId: marker.operationId,
      expectedAuthorityRevision: marker.expectedAuthorityRevision,
      expectedAuthorityDigest: marker.expectedAuthorityDigest,
      priorMarkerKind: marker.priorMarkerKind,
      priorMarkerDigest: marker.priorMarkerDigest,
      priorMarkerRevision: marker.priorMarkerRevision,
    },
    revision: marker.revision,
  }
}

const ABSENT_MARKER_DIGEST = createHash('sha256').update('session-marker:absent:v1').digest('hex')

function markerRawDigest(contents: string | null): string {
  return contents === null
    ? ABSENT_MARKER_DIGEST
    : createHash('sha256').update(contents).digest('hex')
}

function markerKind(
  marker: PendingExternalLogoutMarker | null
): 'absent' | 'legacy-unrevisioned' | 'revisioned' {
  if (marker === null) return 'absent'
  return marker.revision === null ? 'legacy-unrevisioned' : 'revisioned'
}

export type PendingExternalLogoutOwnership =
  | { status: 'owned'; marker: PendingExternalLogoutMarker | null }
  | { status: 'superseded' }
  | { status: 'transient' | 'invalid'; error: unknown }

/** Inspection uncertainty is distinct from both absence and changed authority. */
export function observePendingExternalLogoutMarker(
  userDataDirectory: string,
  envKey: string
): PendingExternalLogoutObservation {
  try {
    return {
      status: 'observed',
      marker: readPendingExternalLogoutMarker(userDataDirectory, envKey),
    }
  } catch (error) {
    return { status: isTransientPendingLogoutReadError(error) ? 'transient' : 'invalid', error }
  }
}

/** Pure authority decision shared by every phase of a persistence transaction. */
export function pendingExternalLogoutOwnership(
  observation: PendingExternalLogoutObservation,
  expected: readonly (PendingExternalLogoutMarker | null)[],
  runtimeOwned: boolean
): PendingExternalLogoutOwnership {
  if (!runtimeOwned) return { status: 'superseded' }
  if (observation.status !== 'observed') return observation
  const owns = expected.some(marker =>
    marker === null
      ? observation.marker === null
      : pendingExternalLogoutMarkersMatch(observation.marker, marker)
  )
  return owns ? { status: 'owned', marker: observation.marker } : { status: 'superseded' }
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
  if (process.platform === 'win32')
    throw Object.assign(
      new Error('Windows logout marker requires a native write-through namespace operation'),
      { code: 'ENOTSUP' }
    )
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } catch (error) {
    throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function readMarkerContents(
  filePath: string,
  guard?: PendingExternalLogoutStorageGuard
): string | null {
  let contents: string
  let primaryFailure = false
  let descriptor: number | undefined
  try {
    const flags =
      process.platform === 'win32'
        ? fs.constants.O_RDONLY
        : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW
    descriptor = guarded(guard, () => fs.openSync(filePath, flags))
    if (!guarded(guard, () => fs.fstatSync(descriptor!).isFile())) {
      throw new Error('Pending logout marker is not a regular file')
    }
    contents = guarded(guard, () => fs.readFileSync(descriptor!, 'utf8'))
    if (process.platform === 'win32') {
      try {
        if (!guarded(guard, () => fs.lstatSync(filePath).isFile())) {
          throw new Error('Pending logout marker is not a regular file')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
      }
    }
  } catch (error) {
    primaryFailure = true
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') {
      if (process.platform === 'win32') {
        try {
          if (!guarded(guard, () => fs.lstatSync(filePath).isFile())) {
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
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor)
      } catch (error) {
        if (!primaryFailure) throw error
      }
    }
  }

  return contents
}

function observeMarkerContents(
  filePath: string,
  guard?: PendingExternalLogoutStorageGuard
): string | null {
  try {
    return readMarkerContents(filePath, guard)
  } catch (error) {
    if (typeof error === 'object' && error !== null) markerReadFailures.add(error)
    throw error
  }
}

function parseMarkerContents(contents: string | null): PendingExternalLogoutMarker | null {
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
    volatileSessionId?: unknown
    revision?: unknown
    purpose?: unknown
    operationId?: unknown
    expectedAuthorityRevision?: unknown
    expectedAuthorityDigest?: unknown
    priorMarkerKind?: unknown
    priorMarkerDigest?: unknown
    priorMarkerRevision?: unknown
  }
  if (record.version === 2 && record.intent === 'acceptance-pending') {
    const exactKeys = [
      'version',
      'intent',
      'purpose',
      'operationId',
      'revision',
      'expectedAuthorityRevision',
      'expectedAuthorityDigest',
      'priorMarkerKind',
      'priorMarkerDigest',
      'priorMarkerRevision',
    ]
    if (
      record.purpose !== 'candidate-acceptance' ||
      typeof record.operationId !== 'string' ||
      !UUID.test(record.operationId) ||
      typeof record.revision !== 'string' ||
      !UUID.test(record.revision) ||
      !(
        record.expectedAuthorityRevision === null ||
        (typeof record.expectedAuthorityRevision === 'string' &&
          UUID.test(record.expectedAuthorityRevision))
      ) ||
      typeof record.expectedAuthorityDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.expectedAuthorityDigest) ||
      !['absent', 'legacy-unrevisioned', 'revisioned'].includes(String(record.priorMarkerKind)) ||
      typeof record.priorMarkerDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(record.priorMarkerDigest) ||
      !(
        record.priorMarkerRevision === null ||
        (typeof record.priorMarkerRevision === 'string' && UUID.test(record.priorMarkerRevision))
      ) ||
      (record.priorMarkerKind === 'absent' &&
        (record.priorMarkerRevision !== null ||
          record.priorMarkerDigest !== ABSENT_MARKER_DIGEST)) ||
      (record.priorMarkerKind === 'legacy-unrevisioned' && record.priorMarkerRevision !== null) ||
      (record.priorMarkerKind === 'revisioned' && typeof record.priorMarkerRevision !== 'string') ||
      Object.keys(record).some(key => !exactKeys.includes(key))
    ) {
      throw new Error('Pending acceptance marker has an invalid exact schema')
    }
    return {
      intent: {
        intent: 'acceptance-pending',
        purpose: 'candidate-acceptance',
        operationId: record.operationId,
        expectedAuthorityRevision: record.expectedAuthorityRevision,
        expectedAuthorityDigest: record.expectedAuthorityDigest,
        priorMarkerKind: record.priorMarkerKind as AcceptancePendingMarker['priorMarkerKind'],
        priorMarkerDigest: record.priorMarkerDigest,
        priorMarkerRevision: record.priorMarkerRevision,
      },
      revision: record.revision,
    }
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
  if (record.intent === 'memory-only-session') {
    if (
      typeof record.volatileSessionId !== 'string' ||
      !UUID.test(record.volatileSessionId) ||
      typeof revision !== 'string' ||
      !UUID.test(revision) ||
      Object.keys(record).some(
        key => !['version', 'revision', 'intent', 'volatileSessionId'].includes(key)
      )
    ) {
      throw new Error('Pending logout marker has an invalid memory-only session id')
    }
    return {
      intent: { intent: 'memory-only-session', volatileSessionId: record.volatileSessionId },
      revision,
    }
  }
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

function readMarker(filePath: string): PendingExternalLogoutMarker | null {
  return parseMarkerContents(readMarkerContents(filePath))
}

function writeMarkerIntentOnce(
  userDataDirectory: string,
  envKey: string,
  intent: PendingExternalLogoutIntent,
  revision: string = randomUUID()
): void {
  if (typeof revision !== 'string' || revision.length === 0) {
    throw new Error('Pending logout marker requires a nonempty revision')
  }
  const filePath = markerPath(userDataDirectory, envKey)
  fs.mkdirSync(userDataDirectory, { recursive: true })
  if (parseMarkerContents(readMarkerContents(filePath))?.intent.intent === 'acceptance-pending') {
    throw new Error('Pending acceptance marker requires an exact compare-and-swap transition')
  }
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
    if (process.platform === 'win32') {
      renameSessionAuthorityFileDurablySync(temporaryPath, filePath, true)
    } else {
      fs.renameSync(temporaryPath, filePath)
      syncDirectory(userDataDirectory)
    }
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
      // The rename may already have succeeded; callers fail closed and repair intent.
    }
    throw error
  }
}

function writeMarkerContentsIfUnchanged(
  userDataDirectory: string,
  envKey: string,
  expectedContents: string | null,
  nextContents: string | null,
  guard?: PendingExternalLogoutStorageGuard
): boolean {
  let markerMutationDispatched = false
  try {
    return writeMarkerContentsIfUnchangedOnce(
      userDataDirectory,
      envKey,
      expectedContents,
      nextContents,
      guard,
      () => {
        markerMutationDispatched = true
      }
    )
  } catch (error) {
    // Only destination mutation makes the marker outcome uncertain. Pre-dispatch observations
    // must remain classifiable as transient reads; temporary-file staging is not publication.
    if (markerMutationDispatched && typeof error === 'object' && error !== null)
      markerWriteFailures.add(error)
    throw error
  }
}

function writeMarkerContentsIfUnchangedOnce(
  userDataDirectory: string,
  envKey: string,
  expectedContents: string | null,
  nextContents: string | null,
  guard?: PendingExternalLogoutStorageGuard,
  onMarkerMutationDispatch: () => void = () => {}
): boolean {
  const filePath = markerPath(userDataDirectory, envKey)
  guarded(guard, () => fs.mkdirSync(userDataDirectory, { recursive: true, mode: 0o700 }))
  const current = observeMarkerContents(filePath, guard)
  if (current !== expectedContents) return false
  if (nextContents === null) {
    if (current === null) return true
    if (process.platform === 'win32') {
      guardedMarkerMutation(guard, onMarkerMutationDispatch, () =>
        retireSessionCredentialFileDurablySync(filePath)
      )
    } else {
      guardedMarkerMutation(guard, onMarkerMutationDispatch, () => fs.unlinkSync(filePath))
      guarded(guard, () => syncDirectory(userDataDirectory))
    }
    return observeMarkerContents(filePath, guard) === null
  }

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = guarded(guard, () => fs.openSync(temporaryPath, 'wx', 0o600))
    guarded(guard, () => fs.writeFileSync(descriptor!, nextContents, 'utf8'))
    guarded(guard, () => fs.fsyncSync(descriptor!))
    guarded(guard, () => fs.closeSync(descriptor!))
    descriptor = undefined
    if (observeMarkerContents(filePath, guard) !== expectedContents) return false
    if (process.platform === 'win32') {
      guardedMarkerMutation(guard, onMarkerMutationDispatch, () =>
        renameSessionAuthorityFileDurablySync(temporaryPath, filePath, expectedContents !== null)
      )
    } else {
      guardedMarkerMutation(guard, onMarkerMutationDispatch, () =>
        fs.renameSync(temporaryPath, filePath)
      )
      guarded(guard, () => syncDirectory(userDataDirectory))
    }
    return observeMarkerContents(filePath, guard) === nextContents
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      guarded(guard, () => fs.unlinkSync(temporaryPath))
    } catch {
      // If scope identity became uncertain, preserve the inert temporary file rather than
      // resolving its name again under a potentially different userData root.
    }
  }
}

/** Run a marker destination mutation after the pre-operation scope check only. */
function guardedMarkerMutation<T>(
  guard: PendingExternalLogoutStorageGuard | undefined,
  onDispatch: () => void,
  operation: () => T
): T {
  guard?.()
  onDispatch()
  try {
    return operation()
  } finally {
    guard?.()
  }
}

/** Capture exact marker bytes and a domain-separated absence digest for V2 projection. */
export function observePendingExternalLogoutRaw(
  userDataDirectory: string,
  envKey: string,
  guard?: PendingExternalLogoutStorageGuard
): PendingExternalLogoutRawObservation {
  const rawContents = guarded(guard, () =>
    observeMarkerContents(markerPath(userDataDirectory, envKey), guard)
  )
  const marker = parseMarkerContents(rawContents)
  return {
    rawContents,
    rawDigest: markerRawDigest(rawContents),
    kind: markerKind(marker),
    marker,
  }
}

/** Stage the exact V2 deny-only marker with byte-exact compare and durable read-back. */
export function stageAcceptancePendingMarker(
  userDataDirectory: string,
  envKey: string,
  expected: PendingExternalLogoutRawObservation,
  marker: AcceptancePendingMarker,
  guard?: PendingExternalLogoutStorageGuard
): AcceptancePendingMarker | null {
  const current = observePendingExternalLogoutRaw(userDataDirectory, envKey, guard)
  if (
    current.rawDigest !== expected.rawDigest ||
    current.rawContents !== expected.rawContents ||
    current.kind !== expected.kind
  )
    return null
  if (
    marker.intent !== 'acceptance-pending' ||
    marker.purpose !== 'candidate-acceptance' ||
    !UUID.test(marker.operationId) ||
    !UUID.test(marker.revision) ||
    !/^[0-9a-f]{64}$/.test(marker.expectedAuthorityDigest) ||
    marker.priorMarkerKind !== expected.kind ||
    marker.priorMarkerDigest !== expected.rawDigest ||
    marker.priorMarkerRevision !== (expected.marker?.revision ?? null)
  )
    throw new Error('Pending acceptance marker does not match its observed before-image')
  const contents = JSON.stringify(marker)
  if (
    !writeMarkerContentsIfUnchanged(
      userDataDirectory,
      envKey,
      expected.rawContents,
      contents,
      guard
    )
  )
    return null
  const verified = observePendingExternalLogoutRaw(userDataDirectory, envKey, guard)
  if (verified.rawContents !== contents || verified.rawDigest !== markerRawDigest(contents))
    throw new Error('Pending acceptance marker publication did not verify')
  return marker
}

/** Restore the exact captured marker before-image only while the staged marker still owns bytes. */
export function restoreAcceptanceMarkerBeforeImage(
  userDataDirectory: string,
  envKey: string,
  stagedDigest: string,
  beforeImage: PendingExternalLogoutRawObservation,
  guard?: PendingExternalLogoutStorageGuard
): boolean {
  const current = observePendingExternalLogoutRaw(userDataDirectory, envKey, guard)
  if (current.rawDigest !== stagedDigest || current.marker?.intent.intent !== 'acceptance-pending')
    return false
  return writeMarkerContentsIfUnchanged(
    userDataDirectory,
    envKey,
    current.rawContents,
    beforeImage.rawContents,
    guard
  )
}

function writeMarkerIntent(
  userDataDirectory: string,
  envKey: string,
  intent: PendingExternalLogoutIntent,
  revision: string = randomUUID()
): void {
  try {
    writeMarkerIntentOnce(userDataDirectory, envKey, intent, revision)
  } catch (error) {
    if (typeof error === 'object' && error !== null) markerWriteFailures.add(error)
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
  try {
    return readMarker(markerPath(userDataDirectory, envKey))
  } catch (error) {
    if (typeof error === 'object' && error !== null) markerReadFailures.add(error)
    throw error
  }
}

export function readPendingExternalLogoutContentsRevision(
  userDataDirectory: string,
  envKey: string
): string | null {
  const contents = observeMarkerContents(markerPath(userDataDirectory, envKey))
  return contents === null ? null : createHash('sha256').update(contents).digest('hex')
}

export function hasPendingExternalLogout(userDataDirectory: string, envKey: string): boolean {
  return readPendingExternalLogoutIntent(userDataDirectory, envKey) !== null
}

export function recordPendingExternalLogout(userDataDirectory: string, envKey: string): void {
  writeMarkerIntent(userDataDirectory, envKey, { intent: 'logout-pending' })
}

/** Normalize readable malformed bytes before joining the ordinary logout recovery flow. */
export function recordPendingExternalLogoutIfContentsUnchanged(
  userDataDirectory: string,
  envKey: string,
  expectedContentsRevision: string
): boolean {
  const expected = observeMarkerContents(markerPath(userDataDirectory, envKey))
  if (
    expected === null ||
    createHash('sha256').update(expected).digest('hex') !== expectedContentsRevision
  )
    return false
  const next = JSON.stringify({
    version: MARKER_VERSION,
    revision: randomUUID(),
    intent: 'logout-pending',
  })
  return writeMarkerContentsIfUnchanged(userDataDirectory, envKey, expected, next)
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

export function pendingExternalLogoutMarkersMatch(
  current: PendingExternalLogoutMarker | null,
  expected: PendingExternalLogoutMarker | null
): boolean {
  if (current === null || expected === null) return current === expected
  return Boolean(
    current &&
    current.revision === expected.revision &&
    JSON.stringify(current.intent) === JSON.stringify(expected.intent)
  )
}

/** Commit a new temporary-session denial fence only while the marker is absent. */
export function recordMemoryOnlySessionIfMissing(
  userDataDirectory: string,
  envKey: string,
  volatileSessionId: string = randomUUID(),
  revision: string = randomUUID()
): PendingExternalLogoutMarker | null {
  if (!UUID.test(volatileSessionId) || !UUID.test(revision)) {
    throw new Error('Memory-only session marker requires UUID ownership values')
  }
  const observed = observePendingExternalLogoutRaw(userDataDirectory, envKey)
  if (observed.marker !== null) return null
  const intent: PendingExternalLogoutIntent = {
    intent: 'memory-only-session',
    volatileSessionId,
  }
  const contents = JSON.stringify({ version: MARKER_VERSION, revision, ...intent })
  if (!writeMarkerContentsIfUnchanged(userDataDirectory, envKey, observed.rawContents, contents))
    return null
  return { intent, revision }
}

/** Replace only the exact authority observed by a fresh authenticated producer. */
export function recordMemoryOnlySessionIfUnchanged(
  userDataDirectory: string,
  envKey: string,
  expected: PendingExternalLogoutMarker,
  volatileSessionId: string = randomUUID(),
  revision: string = randomUUID()
): PendingExternalLogoutMarker | null {
  if (!UUID.test(volatileSessionId) || !UUID.test(revision)) {
    throw new Error('Memory-only session marker requires UUID ownership values')
  }
  const observed = observePendingExternalLogoutRaw(userDataDirectory, envKey)
  if (!pendingExternalLogoutMarkersMatch(observed.marker, expected)) return null
  const intent: PendingExternalLogoutIntent = {
    intent: 'memory-only-session',
    volatileSessionId,
  }
  const contents = JSON.stringify({ version: MARKER_VERSION, revision, ...intent })
  if (!writeMarkerContentsIfUnchanged(userDataDirectory, envKey, observed.rawContents, contents))
    return null
  return { intent, revision }
}

/** Restore logout intent only for the exact record owned by a failed conversion. */
export function recordPendingExternalLogoutIfUnchanged(
  userDataDirectory: string,
  envKey: string,
  expected: PendingExternalLogoutMarker
): boolean {
  const observed = observePendingExternalLogoutRaw(userDataDirectory, envKey)
  if (!pendingExternalLogoutMarkersMatch(observed.marker, expected)) return false
  const contents = JSON.stringify({
    version: MARKER_VERSION,
    revision: randomUUID(),
    intent: 'logout-pending',
  })
  return writeMarkerContentsIfUnchanged(userDataDirectory, envKey, observed.rawContents, contents)
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
  const observed = observePendingExternalLogoutRaw(userDataDirectory, envKey)
  if (!pendingExternalLogoutMarkersMatch(observed.marker, expected)) return false
  return writeMarkerContentsIfUnchanged(userDataDirectory, envKey, observed.rawContents, null)
}

/** Apply a coordinator-planned exact marker CAS without choosing policy here. */
export function applyPendingExternalLogoutCas(
  userDataDirectory: string,
  envKey: string,
  cas: PendingExternalLogoutCas,
  guard?: PendingExternalLogoutStorageGuard
): boolean {
  const observed = observePendingExternalLogoutRaw(userDataDirectory, envKey, guard)
  const current = observed.marker
  const ownsObservedMarker =
    cas.expected === null
      ? current === null
      : pendingExternalLogoutMarkersMatch(current, cas.expected)
  if (!ownsObservedMarker) return false
  if (cas.next === null) {
    return writeMarkerContentsIfUnchanged(
      userDataDirectory,
      envKey,
      observed.rawContents,
      null,
      guard
    )
  }
  if (cas.next.intent.intent === 'acceptance-pending') return false
  const nextContents = JSON.stringify({
    version: MARKER_VERSION,
    revision: cas.next.revision ?? randomUUID(),
    ...cas.next.intent,
  })
  return writeMarkerContentsIfUnchanged(
    userDataDirectory,
    envKey,
    observed.rawContents,
    nextContents,
    guard
  )
}

/**
 * Apply a marker transition only while the exact raw before-image remains current. This is used
 * by first-V2 legacy quarantine, where a typed LP value alone is not enough to bind the recovery
 * receipt to the bytes that were inspected before the transition.
 */
export function applyPendingExternalLogoutRawCas(
  userDataDirectory: string,
  envKey: string,
  expected: PendingExternalLogoutRawObservation,
  next: PendingExternalLogoutMarker,
  guard?: PendingExternalLogoutStorageGuard
): boolean {
  const observed = observePendingExternalLogoutRaw(userDataDirectory, envKey, guard)
  if (
    observed.rawContents !== expected.rawContents ||
    observed.rawDigest !== expected.rawDigest ||
    observed.kind !== expected.kind ||
    !pendingExternalLogoutMarkersMatch(observed.marker, expected.marker) ||
    next.intent.intent === 'acceptance-pending' ||
    !next.revision ||
    !UUID.test(next.revision)
  )
    return false

  const nextContents = JSON.stringify({
    version: MARKER_VERSION,
    revision: next.revision,
    ...next.intent,
  })
  return writeMarkerContentsIfUnchanged(
    userDataDirectory,
    envKey,
    expected.rawContents,
    nextContents,
    guard
  )
}

/** Bind cleanup authority only while the caller still observes marker absence. */
export function recordPendingKeytarCleanupIfMissing(
  userDataDirectory: string,
  envKey: string,
  credentialSource: 'active-keytar' | 'safe-storage',
  replacementRevision: string = randomUUID()
): boolean {
  const observed = observePendingExternalLogoutRaw(userDataDirectory, envKey)
  if (observed.marker !== null) return false
  const contents = JSON.stringify({
    version: MARKER_VERSION,
    revision: replacementRevision,
    intent: 'keytar-cleanup-pending',
    credentialSource,
  })
  return writeMarkerContentsIfUnchanged(userDataDirectory, envKey, observed.rawContents, contents)
}

/**
 * Convert the marker only when the producer still owns the observed marker.
 * A newer logout-pending marker is intentionally never downgraded to cleanup.
 */
export function recordPendingKeytarCleanupIfUnchanged(
  userDataDirectory: string,
  envKey: string,
  expected: PendingExternalLogoutMarker,
  credentialSource: 'active-keytar' | 'safe-storage',
  replacementRevision: string = randomUUID()
): boolean {
  if (!UUID.test(replacementRevision)) {
    throw new Error('Pending logout marker requires a nonempty revision')
  }
  const observed = observePendingExternalLogoutRaw(userDataDirectory, envKey)
  if (!pendingExternalLogoutMarkersMatch(observed.marker, expected)) return false
  const contents = JSON.stringify({
    version: MARKER_VERSION,
    revision: replacementRevision,
    intent: 'keytar-cleanup-pending',
    credentialSource,
  })
  return writeMarkerContentsIfUnchanged(userDataDirectory, envKey, observed.rawContents, contents)
}

export function clearPendingExternalLogout(userDataDirectory: string, envKey: string): void {
  let removed = false
  const filePath = markerPath(userDataDirectory, envKey)
  try {
    try {
      const stat = fs.lstatSync(filePath)
      if (!stat.isFile()) throw new Error('Pending logout marker is not a regular file')
      if (process.platform === 'win32') {
        retireSessionCredentialFileDurablySync(filePath)
      } else {
        fs.unlinkSync(filePath)
        syncDirectory(userDataDirectory)
      }
      removed = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
    }
    if (removed && process.platform !== 'win32') syncDirectory(userDataDirectory)
  } catch (error) {
    if (typeof error === 'object' && error !== null) markerWriteFailures.add(error)
    throw error
  }
}
