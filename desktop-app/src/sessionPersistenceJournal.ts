import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { PendingExternalLogoutMarker } from './pendingExternalLogout.js'
import {
  renameSessionAuthorityFileDurablySync,
  retireSessionCredentialFileDurablySync,
} from './sessionAuthorityDurableFileOps.js'
import type { SessionTokenMutationSource } from './tokenStore.js'

const MAX_ENTRIES = 128
const MAX_BYTES = 128 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const SOURCES = new Set(['keytar', 'safe-storage', 'isolated-plaintext'])
const readFailures = new WeakSet<object>()
declare const journalSnapshotBrand: unique symbol
export type SessionPersistenceJournalSnapshot = { readonly [journalSnapshotBrand]: true }
const snapshots = new WeakMap<
  SessionPersistenceJournalSnapshot,
  {
    directory: string
    envKey: string
    contents: string | null
  }
>()

export type SessionPersistenceDenial = {
  producer: string
  candidateHash: string
  sources: SessionTokenMutationSource[]
  observedMarkerHash: string
  plannedMarkerHashes: string[]
}

export type SessionPersistenceJournal = {
  version: 1
  revision: string
  pending: SessionPersistenceDenial[]
}

/**
 * Content-addressed compatibility receipt for the immutable pre-V2 denial journal.
 * The journal's random `revision` is not an ownership proof; exact raw bytes are.
 */
export type SessionPersistenceLegacySnapshotReceipt = {
  schemaVersion: 0 | 1
  revision: string
  byteLength: number
  digest: string
  denials: Array<{ producer: string; candidateHash: string }>
}

export type SessionPersistenceLegacySnapshotObservation =
  | { status: 'observed'; receipt: SessionPersistenceLegacySnapshotReceipt }
  | { status: 'transient' | 'invalid'; error: unknown }

export class SessionPersistenceJournalAdmissionError extends Error {
  constructor(cause: unknown) {
    super('Session persistence journal admission failed', { cause })
    this.name = 'SessionPersistenceJournalAdmissionError'
  }
}

export class SessionPersistenceCandidateDeniedError extends Error {
  constructor() {
    super('Saved session belongs to an unaccepted persistence transaction')
    this.name = 'SessionPersistenceCandidateDeniedError'
  }
}

export function sessionPersistenceCandidateHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function sessionPersistenceMarkerHash(marker: PendingExternalLogoutMarker | null): string {
  return sessionPersistenceCandidateHash(JSON.stringify(marker))
}

export function isSessionPersistenceJournalReadFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && readFailures.has(error)
}

/** Source and marker UUIDs never override a pending candidate's denial. */
export function isSessionPersistenceCandidateDenied(
  journal: SessionPersistenceJournal | null,
  token: string,
  currentProducer?: string
): boolean {
  const hash = sessionPersistenceCandidateHash(token)
  return (
    journal?.pending.some(
      entry => entry.candidateHash === hash && entry.producer !== currentProducer
    ) ?? false
  )
}

function journalPath(directory: string, envKey: string): string {
  if (!path.isAbsolute(directory) || !/^[a-z0-9_]+-[0-9a-f]{12}$/.test(envKey))
    throw new Error('Session persistence journal requires an absolute environment storage path')
  return path.join(
    directory,
    `session-persistence-journal-${sessionPersistenceCandidateHash(envKey)}`
  )
}

function readContents(file: string): string | null {
  let descriptor: number | undefined
  let primaryFailure = false
  try {
    const flags =
      fs.constants.O_RDONLY |
      fs.constants.O_NONBLOCK |
      (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW)
    descriptor = fs.openSync(file, flags)
    const stat = fs.fstatSync(descriptor)
    if (
      !stat.isFile() ||
      stat.size > MAX_BYTES ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      throw new Error('Session persistence journal is not a private bounded regular file')
    if (process.platform === 'win32' && !fs.lstatSync(file).isFile())
      throw new Error('Session persistence journal is not a regular file')
    const contents = fs.readFileSync(descriptor, 'utf8')
    if (Buffer.byteLength(contents) > MAX_BYTES)
      throw new Error('Session persistence journal exceeded its bounded size')
    return contents
  } catch (error) {
    primaryFailure = true
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      if (process.platform === 'win32') {
        try {
          if (!fs.lstatSync(file).isFile())
            throw new Error('Session persistence journal is not a regular file')
        } catch (missingError) {
          if ((missingError as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            if (typeof missingError === 'object' && missingError !== null)
              readFailures.add(missingError)
            throw missingError
          }
        }
      }
      return null
    }
    if (typeof error === 'object' && error !== null) readFailures.add(error)
    throw error
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor)
      } catch (error) {
        if (!primaryFailure) {
          if (typeof error === 'object' && error !== null) readFailures.add(error)
          throw error
        }
      }
    }
  }
}

function parse(contents: string | null): SessionPersistenceJournal | null {
  if (contents === null) return null
  try {
    const value = JSON.parse(contents) as SessionPersistenceJournal
    if (
      value?.version !== 1 ||
      typeof value.revision !== 'string' ||
      !UUID.test(value.revision) ||
      !Array.isArray(value.pending) ||
      value.pending.length > MAX_ENTRIES ||
      Object.keys(value).some(key => !['version', 'revision', 'pending'].includes(key))
    )
      throw new Error()
    const identities = new Set<string>()
    for (const entry of value.pending) {
      if (
        !entry ||
        typeof entry.producer !== 'string' ||
        !UUID.test(entry.producer) ||
        typeof entry.candidateHash !== 'string' ||
        !HASH.test(entry.candidateHash) ||
        !Array.isArray(entry.sources) ||
        entry.sources.length < 1 ||
        entry.sources.length > 3 ||
        new Set(entry.sources).size !== entry.sources.length ||
        entry.sources.some(source => typeof source !== 'string' || !SOURCES.has(source)) ||
        typeof entry.observedMarkerHash !== 'string' ||
        !HASH.test(entry.observedMarkerHash) ||
        !Array.isArray(entry.plannedMarkerHashes) ||
        entry.plannedMarkerHashes.length > 64 ||
        entry.plannedMarkerHashes.some(hash => typeof hash !== 'string' || !HASH.test(hash)) ||
        Object.keys(entry).some(
          key =>
            ![
              'producer',
              'candidateHash',
              'sources',
              'observedMarkerHash',
              'plannedMarkerHashes',
            ].includes(key)
        )
      )
        throw new Error()
      const identity = `${entry.producer}:${entry.candidateHash}`
      if (identities.has(identity)) throw new Error()
      identities.add(identity)
    }
    return value
  } catch {
    const error = new Error('Session persistence journal has an invalid bounded schema')
    readFailures.add(error)
    throw error
  }
}

export function readSessionPersistenceJournal(directory: string, envKey: string) {
  return parse(readContents(journalPath(directory, envKey)))
}

/** Observe the legacy journal as an immutable, bounded V0 denial snapshot. */
export function observeSessionPersistenceLegacySnapshot(
  directory: string,
  envKey: string
): SessionPersistenceLegacySnapshotObservation {
  try {
    const contents = readContents(journalPath(directory, envKey))
    const journal = parse(contents)
    const raw =
      contents === null
        ? Buffer.from('session-persistence-journal:absent:v0')
        : Buffer.from(contents)
    const digest = createHash('sha256').update(raw).digest('hex')
    return {
      status: 'observed',
      receipt: {
        schemaVersion: contents === null ? 0 : 1,
        revision: `v0-sha256:${digest}`,
        byteLength: contents === null ? 0 : Buffer.byteLength(contents),
        digest,
        denials: (journal?.pending ?? []).map(({ producer, candidateHash }) => ({
          producer,
          candidateHash,
        })),
      },
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    return {
      status:
        typeof code === 'string' &&
        ['EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EINTR', 'EIO'].includes(code)
          ? 'transient'
          : 'invalid',
      error,
    }
  }
}

export function sessionPersistenceLegacySnapshotMatches(
  expected: SessionPersistenceLegacySnapshotReceipt,
  current: SessionPersistenceLegacySnapshotReceipt
): boolean {
  return (
    expected.schemaVersion === current.schemaVersion &&
    expected.revision === current.revision &&
    expected.byteLength === current.byteLength &&
    expected.digest === current.digest &&
    JSON.stringify(expected.denials) === JSON.stringify(current.denials)
  )
}

/** Capture before cleanup starts; a later producer's journal must never be erased. */
export function snapshotSessionPersistenceJournal(directory: string, envKey: string) {
  const snapshot = {} as SessionPersistenceJournalSnapshot
  snapshots.set(snapshot, {
    directory,
    envKey,
    contents: readContents(journalPath(directory, envKey)),
  })
  return snapshot
}

/** Caller verified every credential source absent and still owns LP or observed absence. */
export function retireSessionPersistenceJournalAfterVerifiedLogout(
  snapshot: SessionPersistenceJournalSnapshot,
  requireOwnership: () => void
): boolean {
  const captured = snapshots.get(snapshot)
  if (!captured) throw new Error('Session persistence journal snapshot is invalid')
  requireOwnership()
  return writeIfUnchanged(captured.directory, captured.envKey, captured.contents, [])
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32')
    throw Object.assign(
      new Error('Windows session journal requires a native write-through namespace operation'),
      { code: 'ENOTSUP' }
    )
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(directory, 'r')
    fs.fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

/** Synchronous byte CAS preserves every entry appended by another main-process producer. */
function writeIfUnchanged(
  directory: string,
  envKey: string,
  expected: string | null,
  pending: SessionPersistenceDenial[]
): boolean {
  const file = journalPath(directory, envKey)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (!fs.lstatSync(directory).isDirectory())
    throw new Error('Session persistence journal storage is not a directory')
  if (readContents(file) !== expected) return false
  if (pending.length === 0) {
    try {
      retireSessionCredentialFileDurablySync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    return true
  }
  const journal: SessionPersistenceJournal = { version: 1, revision: randomUUID(), pending }
  const contents = JSON.stringify(journal)
  if (Buffer.byteLength(contents) > MAX_BYTES || pending.length > MAX_ENTRIES)
    throw new Error('Session persistence journal is full')
  const temporary = `${file}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, contents, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    if (readContents(file) !== expected) return false
    if (process.platform === 'win32') {
      renameSessionAuthorityFileDurablySync(temporary, file, expected !== null)
    } else {
      fs.renameSync(temporary, file)
      syncDirectory(directory)
    }
    return true
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try {
      fs.unlinkSync(temporary)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        // Do not replace a prepare/retirement error with temporary cleanup error.
      }
    }
  }
}

/** One owner holds denial through storage, binding and producer-specific GFS acceptance. */
export class SessionPersistenceProducer {
  readonly producer = randomUUID()
  private accepted = false
  private repairedRetirementVerified = false
  private planned = new Set<string>()
  private candidates = new Set<string>()
  private priorHash: string | undefined
  private validatedHash: string | undefined

  constructor(
    private directory: string,
    private envKey: string,
    private observedMarker: PendingExternalLogoutMarker | null,
    private requireOwnership: () => void,
    private reportFailure: (error: unknown) => void,
    private freshAuthentication = true,
    priorToken?: string | null,
    private requireRuntimeOwnership: () => void = requireOwnership
  ) {
    this.priorHash = priorToken ? sessionPersistenceCandidateHash(priorToken) : undefined
  }

  /** Called by the actual leaf after its owner check, before native set or credential rename. */
  prepare = (source: SessionTokenMutationSource, token: string): void => {
    if (this.accepted)
      throw new SessionPersistenceJournalAdmissionError(
        new Error('Persistence producer is already accepted')
      )
    this.requireOwnership()
    try {
      if (!SOURCES.has(source) || typeof token !== 'string' || token.length === 0)
        throw new Error('Persistence publication requires a valid candidate source')
      const file = journalPath(this.directory, this.envKey)
      const contents = readContents(file)
      const current = parse(contents)
      if (
        !this.freshAuthentication &&
        isSessionPersistenceCandidateDenied(current, token, this.producer)
      )
        throw new SessionPersistenceCandidateDeniedError()
      const candidateHash = sessionPersistenceCandidateHash(token)
      const pending = [...(current?.pending ?? [])]
      const ownIndex = pending.findIndex(
        entry => entry.producer === this.producer && entry.candidateHash === candidateHash
      )
      if (ownIndex === -1)
        pending.push({
          producer: this.producer,
          candidateHash,
          sources: [source],
          observedMarkerHash: sessionPersistenceMarkerHash(this.observedMarker),
          plannedMarkerHashes: [...this.planned],
        })
      else {
        const previous = pending[ownIndex]!
        pending[ownIndex] = { ...previous, sources: [...new Set([...previous.sources, source])] }
      }
      this.requireOwnership()
      if (!writeIfUnchanged(this.directory, this.envKey, contents, pending))
        throw new Error('Session persistence journal changed before publication')
      this.candidates.add(candidateHash)
    } catch (error) {
      if (error instanceof SessionPersistenceCandidateDeniedError) throw error
      throw new SessionPersistenceJournalAdmissionError(error)
    }
  }

  /** Exact prior-authority repair may proceed during marker uncertainty, never for a winner. */
  preparePriorRepair(
    source: SessionTokenMutationSource,
    rejectedToken: string,
    priorToken: string
  ): void {
    this.requireRuntimeOwnership()
    try {
      if (this.accepted) throw new Error('Persistence producer is already accepted')
      if (
        !this.priorHash ||
        sessionPersistenceCandidateHash(priorToken) !== this.priorHash ||
        !SOURCES.has(source)
      )
        throw new Error('Prior persistence authority is not captured')
      const contents = readContents(journalPath(this.directory, this.envKey))
      const current = parse(contents)
      const rejectedHash = sessionPersistenceCandidateHash(rejectedToken)
      if (
        !this.candidates.has(rejectedHash) ||
        !current?.pending.some(
          entry => entry.producer === this.producer && entry.candidateHash === rejectedHash
        ) ||
        current.pending.some(
          entry => entry.producer !== this.producer && entry.candidateHash === rejectedHash
        )
      )
        throw new Error('Rejected persistence entry was superseded')
      const ownIndex = current.pending.findIndex(
        entry => entry.producer === this.producer && entry.candidateHash === this.priorHash
      )
      const pending = [...current.pending]
      if (ownIndex === -1)
        pending.push({
          producer: this.producer,
          candidateHash: this.priorHash,
          sources: [source],
          observedMarkerHash: sessionPersistenceMarkerHash(this.observedMarker),
          plannedMarkerHashes: [...this.planned],
        })
      else {
        const previous = pending[ownIndex]!
        pending[ownIndex] = { ...previous, sources: [...new Set([...previous.sources, source])] }
      }
      this.requireRuntimeOwnership()
      if (!writeIfUnchanged(this.directory, this.envKey, contents, pending))
        throw new Error('Prior persistence repair was superseded')
    } catch (error) {
      throw new SessionPersistenceJournalAdmissionError(error)
    }
  }

  declareMarker(marker: PendingExternalLogoutMarker | null): void {
    this.requireOwnership()
    const hash = sessionPersistenceMarkerHash(marker)
    if (!this.planned.has(hash) && this.planned.size === 64)
      throw new SessionPersistenceJournalAdmissionError(new Error('Journal marker plan is full'))
    this.planned.add(hash)
    const file = journalPath(this.directory, this.envKey)
    const contents = readContents(file)
    const current = parse(contents)
    if (!current?.pending.some(entry => entry.producer === this.producer)) return
    const pending = current.pending.map(entry =>
      entry.producer === this.producer
        ? { ...entry, plannedMarkerHashes: [...new Set([...entry.plannedMarkerHashes, hash])] }
        : entry
    )
    if (!writeIfUnchanged(this.directory, this.envKey, contents, pending))
      throw new SessionPersistenceJournalAdmissionError(
        new Error('Journal marker plan was superseded')
      )
  }

  assertMayAuthenticate(token: string): void {
    const hash = sessionPersistenceCandidateHash(token)
    if (this.accepted && this.validatedHash !== hash)
      throw new Error('Accepted persistence producer cannot validate another candidate')
    this.requireOwnership()
    const current = readSessionPersistenceJournal(this.directory, this.envKey)
    if (
      !this.freshAuthentication &&
      isSessionPersistenceCandidateDenied(current, token, this.producer)
    )
      throw new SessionPersistenceCandidateDeniedError()
    this.validatedHash = hash
  }

  /** Call only after all rejection-capable source/authentication/chat/GFS checks. */
  accept(token: string): boolean {
    const acceptedHash = sessionPersistenceCandidateHash(token)
    if (this.validatedHash !== acceptedHash)
      throw new Error('Persistence acceptance requires its exact validated candidate')
    if (this.accepted) return this.retire(acceptedHash, true)
    // An automatic restore's earlier validation precedes awaited auth/chat
    // work. A later independent rejection of this same value remains a denial,
    // not authority that the older automatic producer may retire.
    if (!this.freshAuthentication) this.assertMayAuthenticate(token)
    else this.requireOwnership()
    this.accepted = true
    return this.retire(acceptedHash)
  }

  /** Verified rollback/no-publication may retire only this producer's entry. */
  repaired(): boolean {
    if (this.accepted)
      throw new Error('Accepted persistence producer cannot roll back another candidate')
    this.requireOwnership()
    const retired = this.retire()
    if (retired) this.repairedRetirementVerified = true
    return retired
  }

  get hasVerifiedRepairedRetirement(): boolean {
    return this.repairedRetirementVerified
  }

  /**
   * Once exact prior-source repair is verified, remove only its rollback-denial
   * entry. The rejected candidate denial and every other producer remain intact.
   */
  resolveVerifiedPriorRepair(priorToken: string): boolean {
    const priorHash = sessionPersistenceCandidateHash(priorToken)
    if (!this.priorHash || priorHash !== this.priorHash)
      throw new Error('Prior repair does not match the captured session owner')
    this.requireRuntimeOwnership()
    const file = journalPath(this.directory, this.envKey)
    const contents = readContents(file)
    const current = parse(contents)
    if (!current) return true
    const pending = current.pending.filter(
      entry => entry.producer !== this.producer || entry.candidateHash !== priorHash
    )
    if (pending.length === current.pending.length) return true
    this.requireRuntimeOwnership()
    return writeIfUnchanged(this.directory, this.envKey, contents, pending)
  }

  private retire(acceptedHash?: string, acceptedRetry = false): boolean {
    try {
      const file = journalPath(this.directory, this.envKey)
      const contents = readContents(file)
      const current = parse(contents)
      if (!current) {
        // A confirmed ENOENT is a read-only observation, not a namespace mutation. On Windows
        // all journal namespace mutations already use MoveFileExW(MOVEFILE_WRITE_THROUGH), while
        // opening a directory for fsync is unsupported. Do not turn an absent journal into a
        // false acceptance failure by asking the platform to flush an unchanged directory.
        if (process.platform !== 'win32') syncDirectory(this.directory)
        return true
      }
      const pending = current.pending.filter(entry =>
        acceptedHash
          ? entry.candidateHash !== acceptedHash ||
            (acceptedRetry && entry.producer !== this.producer)
          : entry.producer !== this.producer
      )
      this.requireOwnership()
      const retired = writeIfUnchanged(this.directory, this.envKey, contents, pending)
      if (!retired)
        this.reportSafely(new Error('Session persistence journal retirement was superseded'))
      return retired
    } catch (error) {
      this.reportSafely(error)
      return false
    }
  }

  get isAccepted(): boolean {
    return this.accepted
  }

  private reportSafely(error: unknown): void {
    try {
      this.reportFailure(error)
    } catch {
      // Notification/reporting cannot reject a source past its acceptance point.
    }
  }
}
