import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  readPendingExternalLogoutMarker,
  recordPendingExternalLogout,
} from '../pendingExternalLogout.js'
import {
  createSessionAuthorityFileDurablySync,
  renameSessionAuthorityFileDurablySync,
} from '../sessionAuthorityDurableFileOps.js'
import {
  type SessionAuthorityAbsenceEvidence,
  type SessionAuthorityCredentialSource,
  type SessionAuthorityLegacyJournalObservation,
  type SessionAuthorityMarkerBeforeImage,
  type SessionAuthorityMarkerObservation,
  SessionAuthorityProjectionIntegrityError,
  SessionAuthorityRecordConflictError,
  SessionAuthorityRecordRepository,
  type SessionAuthorityRecordStorageAdapter,
  type SessionAuthorityStorageScope,
  type SessionAuthorityTransactionLease,
  SessionAuthorityUnsupportedRecordVersionError,
  canAcceptSessionAuthorityCandidate,
  consumeSessionAuthorityStorageAuthorization,
  digestSessionAuthoritySource,
  finishSessionAuthorityStorageAuthorization,
  revalidateSessionAuthorityStorageAuthorization,
} from '../sessionAuthorityRecord.js'
import {
  SessionPersistenceProducer,
  readSessionPersistenceJournal,
  sessionPersistenceCandidateHash,
} from '../sessionPersistenceJournal.js'

const ENV_KEY = 'repository_test-0123456789ab'
const ABSENT_MARKER_DIGEST = sha256('session-marker:absent:v1')
const ABSENT_JOURNAL_BYTES = 'session-persistence-journal:absent:v0'
const tempDirectories: string[] = []

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function authorityFile(directory: string, envKey: string): string {
  return path.join(directory, `session-authority-${sha256(envKey)}`)
}

function mutationFile(directory: string, envKey: string): string {
  return path.join(directory, `session-authority-mutation-${sha256(envKey)}`)
}

function markerObservation(
  userDataDirectory: string,
  envKey: string,
  rawContents: string | null
): SessionAuthorityMarkerObservation {
  if (rawContents === null) {
    return {
      rawContents: null,
      rawDigest: ABSENT_MARKER_DIGEST,
      kind: 'absent',
      marker: null,
    }
  }
  if (rawContents === '') {
    const externalMarker = readPendingExternalLogoutMarker(userDataDirectory, envKey)
    if (!externalMarker) throw new Error('Test marker contents disappeared during observation')
    return {
      rawContents,
      rawDigest: sha256(rawContents),
      kind: 'legacy-unrevisioned',
      marker: externalMarker,
    }
  }
  const parsed: unknown = JSON.parse(rawContents)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('Test marker producer wrote a malformed image')
  const record = parsed as Record<string, unknown>
  if (typeof record.revision !== 'string')
    throw new Error('Test marker producer omitted its revision')
  if (record.intent === 'acceptance-pending') {
    if (
      record.version !== 2 ||
      record.purpose !== 'candidate-acceptance' ||
      typeof record.operationId !== 'string' ||
      !(
        record.expectedAuthorityRevision === null ||
        typeof record.expectedAuthorityRevision === 'string'
      ) ||
      typeof record.expectedAuthorityDigest !== 'string' ||
      (record.priorMarkerKind !== 'absent' &&
        record.priorMarkerKind !== 'legacy-unrevisioned' &&
        record.priorMarkerKind !== 'revisioned') ||
      typeof record.priorMarkerDigest !== 'string' ||
      !(record.priorMarkerRevision === null || typeof record.priorMarkerRevision === 'string')
    )
      throw new Error('Test marker producer wrote an invalid acceptance projection')
    return {
      rawContents,
      rawDigest: sha256(rawContents),
      kind: 'revisioned',
      marker: {
        intent: {
          intent: 'acceptance-pending',
          purpose: 'candidate-acceptance',
          operationId: record.operationId,
          expectedAuthorityRevision: record.expectedAuthorityRevision,
          expectedAuthorityDigest: record.expectedAuthorityDigest,
          priorMarkerKind: record.priorMarkerKind,
          priorMarkerDigest: record.priorMarkerDigest,
          priorMarkerRevision: record.priorMarkerRevision,
        },
        revision: record.revision,
      },
    }
  }
  const externalMarker = readPendingExternalLogoutMarker(userDataDirectory, envKey)
  if (!externalMarker) throw new Error('Test marker contents disappeared during observation')
  return {
    rawContents,
    rawDigest: sha256(rawContents),
    kind: externalMarker.revision === null ? 'legacy-unrevisioned' : 'revisioned',
    marker: externalMarker,
  }
}

function sameMarkerImage(
  observed: SessionAuthorityMarkerObservation,
  expected: SessionAuthorityMarkerObservation | SessionAuthorityMarkerBeforeImage
): boolean {
  const expectedRevision =
    'marker' in expected ? (expected.marker?.revision ?? null) : expected.revision
  return (
    observed.rawContents === expected.rawContents &&
    observed.rawDigest === expected.rawDigest &&
    observed.kind === expected.kind &&
    (observed.marker?.revision ?? null) === expectedRevision
  )
}

type CandidateReceipt = {
  expected: {
    transactionId: string
    candidateHash: string
    sourceKind: 'keytar' | 'safe-storage'
    sourceRef: string
    sourceRevision: string
    envKey: string
    accountId: string
  }
  file: string
  value: string
}

class RepositoryStorageAdapter implements SessionAuthorityRecordStorageAdapter {
  readonly scope = Object.freeze({}) as SessionAuthorityStorageScope
  readonly lease = Object.freeze({}) as SessionAuthorityTransactionLease
  readonly root: string
  readonly directory: string
  readonly markerFile: string
  readonly journalFile: string
  readonly candidateReceipts = new WeakMap<object, CandidateReceipt>()
  readonly markerReceipts = new WeakMap<
    object,
    {
      envKey: string
      operationId: string
      markerRevision: string
      markerDigest: string
    }
  >()
  readonly absenceProofs = new WeakMap<object, SessionAuthorityAbsenceEvidence>()
  readonly publishedSources = new Map<string, SessionAuthorityCredentialSource>()
  private mutationActive = false
  journalFailure: 'transient' | 'invalid' | null = null

  constructor(root: string) {
    this.root = root
    this.directory = path.join(root, 'authority')
    this.markerFile = path.join(root, `pending-external-logout-${sha256(ENV_KEY)}`)
    this.journalFile = path.join(root, `session-persistence-journal-${sha256(ENV_KEY)}`)
    fs.mkdirSync(this.directory, { mode: 0o700 })
  }

  resolveSessionAuthorityStorageDirectory(scope: SessionAuthorityStorageScope): string {
    this.assertScope(scope)
    return this.directory
  }

  resolveSessionAuthorityStorageScope(scope: SessionAuthorityStorageScope): string {
    this.assertScope(scope)
    return this.root
  }

  resolveSessionAuthorityUserDataDirectory(scope: SessionAuthorityStorageScope): string {
    this.assertScope(scope)
    return this.root
  }

  assertSessionAuthorityStorageScopeCurrentSync(scope: SessionAuthorityStorageScope): void {
    if (scope !== this.scope) throw new Error('Unissued test storage scope')
    for (const directory of [this.root, this.directory]) {
      const stat = fs.lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('Test storage boundary is not a real directory')
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
        throw new Error('Test storage boundary is not private')
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
        throw new Error('Test storage boundary has a foreign owner')
    }
  }

  assertSessionAuthorityTransactionLeaseCurrentSync(
    scope: SessionAuthorityStorageScope,
    lease: SessionAuthorityTransactionLease
  ): void {
    this.assertScope(scope)
    if (lease !== this.lease) throw new Error('Unissued same-profile transaction lease')
  }

  runSessionAuthorityRecordMutation<T>(
    operation: () => T,
    lease: SessionAuthorityTransactionLease
  ): T {
    this.assertSessionAuthorityTransactionLeaseCurrentSync(this.scope, lease)
    if (this.mutationActive) throw new Error('Test mutation lane is not reentrant')
    this.mutationActive = true
    try {
      return operation()
    } finally {
      this.mutationActive = false
    }
  }

  observeSessionAuthorityMarkerRaw(
    scope: SessionAuthorityStorageScope,
    userDataDirectory: string,
    envKey: string
  ): SessionAuthorityMarkerObservation {
    this.assertScope(scope)
    if (path.resolve(userDataDirectory) !== path.resolve(this.root))
      throw new Error('Marker observation escaped its test user-data directory')
    let contents: string | null
    try {
      contents = fs.readFileSync(this.markerFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      contents = null
    }
    return markerObservation(this.root, envKey, contents)
  }

  compareAndSetSessionAuthorityAcceptancePendingMarker(
    scope: SessionAuthorityStorageScope,
    userDataDirectory: string,
    envKey: string,
    expectedBeforeImage: {
      rawContents: string | null
      rawDigest: string
      kind: SessionAuthorityMarkerObservation['kind']
      revision: string | null
    },
    stagedMarker: {
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
  ): { status: 'verified'; receipt: unknown } | { status: 'superseded' } | { status: 'uncertain' } {
    this.assertScope(scope)
    if (!this.mutationActive) throw new Error('Marker CAS requires the same-profile mutation lane')
    if (path.resolve(userDataDirectory) !== path.resolve(this.root))
      throw new Error('Marker publication escaped its test user-data directory')
    const before = this.observeSessionAuthorityMarkerRaw(scope, userDataDirectory, envKey)
    if (
      before.rawContents !== expectedBeforeImage.rawContents ||
      before.rawDigest !== expectedBeforeImage.rawDigest ||
      before.kind !== expectedBeforeImage.kind ||
      (before.marker?.revision ?? null) !== expectedBeforeImage.revision
    )
      return { status: 'superseded' }
    const contents = JSON.stringify(stagedMarker)
    const temporary = `${this.markerFile}.${randomUUID()}.tmp`
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(descriptor, contents, 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      const current = this.observeSessionAuthorityMarkerRaw(scope, userDataDirectory, envKey)
      if (
        current.rawContents !== expectedBeforeImage.rawContents ||
        current.rawDigest !== expectedBeforeImage.rawDigest ||
        current.kind !== expectedBeforeImage.kind ||
        (current.marker?.revision ?? null) !== expectedBeforeImage.revision
      )
        return { status: 'superseded' }
      renameSessionAuthorityFileDurablySync(
        temporary,
        this.markerFile,
        expectedBeforeImage.rawContents !== null,
        Buffer.from(contents, 'utf8')
      )
    } catch {
      return { status: 'uncertain' }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      try {
        fs.unlinkSync(temporary)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // The authority marker remains the only selected file; temp cleanup is non-authoritative.
        }
      }
    }
    const after = this.observeSessionAuthorityMarkerRaw(scope, userDataDirectory, envKey)
    if (after.rawContents !== contents || after.rawDigest !== sha256(contents))
      return { status: 'uncertain' }
    const receipt = Object.freeze({})
    this.markerReceipts.set(receipt, {
      envKey,
      operationId: stagedMarker.operationId,
      markerRevision: stagedMarker.revision,
      markerDigest: sha256(contents),
    })
    return { status: 'verified', receipt }
  }

  compareAndSetSessionAuthorityMarkerImage(
    scope: SessionAuthorityStorageScope,
    userDataDirectory: string,
    envKey: string,
    expectedBefore: SessionAuthorityMarkerObservation,
    targetImage: SessionAuthorityMarkerBeforeImage
  ): { status: 'verified'; receipt: unknown } | { status: 'superseded' } | { status: 'uncertain' } {
    this.assertScope(scope)
    if (!this.mutationActive) throw new Error('Marker restoration requires the mutation lane')
    if (path.resolve(userDataDirectory) !== path.resolve(this.root) || envKey !== ENV_KEY)
      throw new Error('Marker restoration escaped its test user-data directory')
    if (
      targetImage.rawDigest !==
      (targetImage.rawContents === null ? ABSENT_MARKER_DIGEST : sha256(targetImage.rawContents))
    )
      return { status: 'uncertain' }
    const before = this.observeSessionAuthorityMarkerRaw(scope, userDataDirectory, envKey)
    if (!sameMarkerImage(before, expectedBefore)) return { status: 'superseded' }
    let target: SessionAuthorityMarkerObservation
    try {
      target = markerObservation(this.root, envKey, targetImage.rawContents)
    } catch {
      return { status: 'uncertain' }
    }
    if (!sameMarkerImage(target, targetImage)) return { status: 'uncertain' }

    try {
      if (targetImage.rawContents === null) {
        // This test adapter proves POSIX directory-entry durability only. It deliberately does
        // not infer Windows deletion durability from Node fsync or from chmod semantics.
        if (process.platform === 'win32') return { status: 'uncertain' }
        const current = this.observeSessionAuthorityMarkerRaw(scope, userDataDirectory, envKey)
        if (!sameMarkerImage(current, expectedBefore)) return { status: 'superseded' }
        fs.unlinkSync(this.markerFile)
        const directory = fs.openSync(userDataDirectory, fs.constants.O_RDONLY)
        try {
          fs.fsyncSync(directory)
        } finally {
          fs.closeSync(directory)
        }
      } else {
        const temporary = `${this.markerFile}.${randomUUID()}.tmp`
        let descriptor: number | undefined
        try {
          descriptor = fs.openSync(temporary, 'wx', 0o600)
          fs.writeFileSync(descriptor, targetImage.rawContents, 'utf8')
          fs.fsyncSync(descriptor)
          fs.closeSync(descriptor)
          descriptor = undefined
          const current = this.observeSessionAuthorityMarkerRaw(scope, userDataDirectory, envKey)
          if (!sameMarkerImage(current, expectedBefore)) return { status: 'superseded' }
          renameSessionAuthorityFileDurablySync(
            temporary,
            this.markerFile,
            expectedBefore.rawContents !== null,
            Buffer.from(targetImage.rawContents, 'utf8')
          )
        } finally {
          if (descriptor !== undefined) fs.closeSync(descriptor)
          try {
            fs.unlinkSync(temporary)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
    } catch {
      return { status: 'uncertain' }
    }

    const after = this.observeSessionAuthorityMarkerRaw(scope, userDataDirectory, envKey)
    return sameMarkerImage(after, targetImage)
      ? { status: 'verified', receipt: Object.freeze({}) }
      : { status: 'uncertain' }
  }

  consumeSessionAuthorityAcceptancePendingMarkerReceipt(
    receipt: unknown,
    scope: SessionAuthorityStorageScope,
    expected: {
      envKey: string
      operationId: string
      markerRevision: string
      markerDigest: string
    }
  ): boolean {
    this.assertScope(scope)
    if (!this.mutationActive)
      throw new Error('Marker receipt requires the same-profile mutation lane')
    if (typeof receipt !== 'object' || receipt === null) return false
    const issued = this.markerReceipts.get(receipt)
    if (!issued || JSON.stringify(issued) !== JSON.stringify(expected)) return false
    const current = this.observeSessionAuthorityMarkerRaw(scope, this.root, expected.envKey)
    if (
      current.rawDigest !== expected.markerDigest ||
      current.marker?.revision !== expected.markerRevision
    )
      return false
    this.markerReceipts.delete(receipt)
    return true
  }

  observeSessionAuthorityLegacyJournal(
    storageRoot: string,
    envKey: string
  ): SessionAuthorityLegacyJournalObservation {
    if (path.resolve(storageRoot) !== path.resolve(this.root))
      return { status: 'invalid', error: new Error('Journal observation escaped its test root') }
    if (this.journalFailure)
      return {
        status: this.journalFailure,
        error: Object.assign(new Error('Test journal observation failure'), {
          code: this.journalFailure === 'transient' ? 'EIO' : 'INVALID',
        }),
      }
    try {
      let raw: string | null
      try {
        raw = fs.readFileSync(this.journalFile, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        raw = null
      }
      if (raw === null) {
        const digest = sha256(ABSENT_JOURNAL_BYTES)
        return {
          status: 'observed',
          receipt: {
            schemaVersion: 0,
            revision: `v0-sha256:${digest}`,
            byteLength: 0,
            digest,
            denials: [],
          },
        }
      }
      const parsed = readSessionPersistenceJournal(storageRoot, envKey)
      if (!parsed) throw new Error('Journal disappeared after its byte snapshot')
      const afterParse = fs.readFileSync(this.journalFile, 'utf8')
      if (afterParse !== raw)
        return {
          status: 'transient',
          error: Object.assign(new Error('Journal changed during test observation'), {
            code: 'EAGAIN',
          }),
        }
      const digest = sha256(raw)
      return {
        status: 'observed',
        receipt: {
          schemaVersion: 1,
          revision: `v0-sha256:${digest}`,
          byteLength: Buffer.byteLength(raw),
          digest,
          denials: parsed.pending.map(({ producer, candidateHash }) => ({
            producer,
            candidateHash,
          })),
        },
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      return ['EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EINTR', 'EIO'].includes(String(code))
        ? { status: 'transient', error }
        : { status: 'invalid', error: error instanceof Error ? error : new Error(String(error)) }
    }
  }

  isLegacySessionCredentialSourceBoundToScope(
    _source: SessionAuthorityCredentialSource,
    _scope: SessionAuthorityStorageScope
  ): boolean {
    return false
  }

  consumeSelectedLegacyPriorSourceObservation(
    _observation: unknown,
    _source: SessionAuthorityCredentialSource,
    _envKey: string,
    _scope: SessionAuthorityStorageScope
  ): boolean {
    return false
  }

  consumeLegacyPriorSourceObservation(
    _observation: unknown,
    _source: SessionAuthorityCredentialSource | null,
    _envKey: string,
    _scope: SessionAuthorityStorageScope
  ): boolean {
    return false
  }

  async consumeSessionTokenCandidatePublicationReceipt(
    receipt: unknown,
    scope: SessionAuthorityStorageScope,
    expected: CandidateReceipt['expected']
  ): Promise<SessionAuthorityCredentialSource | null> {
    this.assertScope(scope)
    if (typeof receipt !== 'object' || receipt === null) return null
    const issued = this.candidateReceipts.get(receipt)
    if (!issued || JSON.stringify(issued.expected) !== JSON.stringify(expected)) return null
    const value = fs.readFileSync(issued.file, 'utf8')
    if (value !== issued.value) return null
    const source: SessionAuthorityCredentialSource = {
      kind: expected.sourceKind,
      format: 'v1',
      transactionId: expected.transactionId,
      envKey: expected.envKey,
      accountId: expected.accountId,
      sourceRef: expected.sourceRef,
      sourceRevision: expected.sourceRevision,
      storedValueDigest: digestSessionAuthoritySource(
        {
          sourceKind: expected.sourceKind,
          sourceRef: expected.sourceRef,
          envKey: expected.envKey,
          accountId: expected.accountId,
        },
        value
      ),
    }
    this.publishedSources.set(expected.sourceRef, source)
    this.candidateReceipts.delete(receipt)
    return source
  }

  resolveAbsenceProof(
    proof: unknown,
    scope: SessionAuthorityStorageScope
  ): SessionAuthorityAbsenceEvidence | null {
    this.assertScope(scope)
    if (typeof proof !== 'object' || proof === null) return null
    return this.absenceProofs.get(proof) ?? null
  }

  removeRejectedCandidateSource(
    authorization: unknown,
    candidate: CandidateReceipt['expected'],
    source: SessionAuthorityCredentialSource
  ): { candidateProof: object; sourceProof: object } {
    const exactCandidate = { ...candidate }
    return this.runSessionAuthorityRecordMutation(() => {
      if (
        !consumeSessionAuthorityStorageAuthorization(authorization, this, this.scope, {
          purpose: 'candidate-cleanup',
          candidate: exactCandidate,
        })
      )
        throw new Error('Test TokenStore rejected an unowned candidate cleanup capability')
      const file = path.join(this.directory, `candidate-${candidate.sourceRef}`)
      try {
        if (
          source.format !== 'v1' ||
          source.transactionId !== candidate.transactionId ||
          source.sourceRef !== candidate.sourceRef ||
          source.sourceRevision !== candidate.sourceRevision ||
          source.accountId !== candidate.accountId ||
          source.envKey !== candidate.envKey
        )
          throw new Error('Rejected candidate source receipt does not match its exact slot')
        if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, this.scope))
          throw new Error('Candidate cleanup ownership changed before unlink')
        try {
          const stat = fs.lstatSync(file)
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error('Candidate source is not a regular file')
          const actual = fs.readFileSync(file, 'utf8')
          if (
            sessionPersistenceCandidateHash(actual) !== candidate.candidateHash ||
            digestSessionAuthoritySource(
              {
                sourceKind: candidate.sourceKind,
                sourceRef: candidate.sourceRef,
                envKey: candidate.envKey,
                accountId: candidate.accountId,
              },
              actual
            ) !== source.storedValueDigest
          )
            throw new Error('Candidate source bytes changed before exact cleanup')
          if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, this.scope))
            throw new Error('Candidate cleanup ownership changed before unlink')
          fs.unlinkSync(file)
          const directory = fs.openSync(this.directory, fs.constants.O_RDONLY)
          try {
            fs.fsyncSync(directory)
          } finally {
            fs.closeSync(directory)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (fs.existsSync(file)) throw new Error('Candidate cleanup did not remove the exact slot')
        if (!revalidateSessionAuthorityStorageAuthorization(authorization, this, this.scope))
          throw new Error('Candidate cleanup ownership changed before absence proof')
        const candidateProof = Object.freeze({})
        const sourceProof = Object.freeze({})
        this.absenceProofs.set(candidateProof, {
          kind: 'candidate-slot-absent',
          candidate: exactCandidate,
        })
        this.absenceProofs.set(sourceProof, {
          kind: 'source-absent',
          transactionId: source.transactionId,
          source,
          outcome: 'deleted',
        })
        return { candidateProof, sourceProof }
      } finally {
        finishSessionAuthorityStorageAuthorization(authorization)
      }
    }, this.lease)
  }

  publishCandidate(expected: CandidateReceipt['expected'], value: string): object {
    if (sessionPersistenceCandidateHash(value) !== expected.candidateHash)
      throw new Error('Candidate source bytes do not match the producer denial hash')
    const file = path.join(this.directory, `candidate-${expected.sourceRef}`)
    createSessionAuthorityFileDurablySync(file, value)
    const receipt = Object.freeze({})
    this.candidateReceipts.set(receipt, { expected, file, value })
    return receipt
  }

  produceLegacyJournalDenials(count: number): Array<{ producer: string; candidateHash: string }> {
    const producer = new SessionPersistenceProducer(
      this.root,
      ENV_KEY,
      null,
      () => undefined,
      () => undefined
    )
    for (let index = 0; index < count; index += 1)
      producer.prepare('keytar', `producer-backed-v0-candidate-${randomUUID()}`)
    const journal = readSessionPersistenceJournal(this.root, ENV_KEY)
    if (!journal) throw new Error('Journal producer did not publish its denials')
    return journal.pending.map(({ producer: owner, candidateHash }) => ({
      producer: owner,
      candidateHash,
    }))
  }

  private assertScope(scope: SessionAuthorityStorageScope): void {
    if (scope !== this.scope) throw new Error('Unissued test storage scope')
    this.assertSessionAuthorityStorageScopeCurrentSync(this.scope)
  }
}

function fixture(): { root: string; adapter: RepositoryStorageAdapter } {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'evenfire-authority-repository-')
  )
  fs.chmodSync(root, 0o700)
  tempDirectories.push(root)
  return { root, adapter: new RepositoryStorageAdapter(root) }
}

function repository(adapter: RepositoryStorageAdapter): SessionAuthorityRecordRepository {
  return new SessionAuthorityRecordRepository(adapter.scope, ENV_KEY, adapter, adapter.lease)
}

function observed(repo: SessionAuthorityRecordRepository) {
  const result = repo.observe()
  expect(result.status).toBe('observed')
  if (result.status !== 'observed') throw new Error('Expected an observed repository frame')
  return result
}

function committed<T extends { status: string }>(
  result: T
): asserts result is T & { status: 'committed' } {
  expect(result.status).toBe('committed')
  if (result.status !== 'committed') throw new Error('Expected durable repository commit')
}

function prepareVerifiedMemoryCandidate(
  repo: SessionAuthorityRecordRepository,
  adapter: RepositoryStorageAdapter,
  candidateValue: string,
  priorSource: SessionAuthorityCredentialSource | null = null
) {
  let state = repo.observe()
  if (state.status === 'absent') {
    committed(repo.initialize(state.snapshot))
    state = repo.observe()
  }
  if (state.status !== 'observed') throw new Error('Expected initialized authority record')
  const beforeMarker = adapter.observeSessionAuthorityMarkerRaw(
    adapter.scope,
    adapter.root,
    ENV_KEY
  )
  const prepared = repo.prepareCandidate(state.snapshot, {
    transactionId: randomUUID(),
    candidateHash: sessionPersistenceCandidateHash(candidateValue),
    accountId: priorSource?.accountId ?? 'account-memory-candidate',
    sourceKind: 'memory-only',
    volatileSessionId: randomUUID(),
    priorSource,
    userDataDirectory: adapter.root,
    externalMarkerObservation: beforeMarker,
  })
  committed(prepared)
  const transactionId = prepared.record.latestCandidateTransactionId
  if (!transactionId) throw new Error('Memory producer did not retain its transaction')
  const verified = repo.verifyCandidate(prepared.snapshot, transactionId)
  committed(verified)
  const journal = adapter.observeSessionAuthorityLegacyJournal(adapter.root, ENV_KEY)
  if (journal.status !== 'observed') throw journal.error
  return { transactionId, beforeMarker, journalReceipt: journal.receipt, verified }
}

async function acceptKeytarSource(
  repo: SessionAuthorityRecordRepository,
  adapter: RepositoryStorageAdapter,
  accountId: string,
  storedValue: string,
  priorSource: SessionAuthorityCredentialSource | null
): Promise<SessionAuthorityCredentialSource> {
  let state = repo.observe()
  if (state.status === 'absent') {
    const initialized = repo.initialize(state.snapshot)
    committed(initialized)
    state = repo.observe()
  }
  if (state.status !== 'observed') throw new Error('Expected initialized authority record')
  const current = state
  if (current.record.frame.mode !== 'uninitialized' && !priorSource)
    throw new Error('Replacement producer requires the exact previous source')
  const beforeMarker = adapter.observeSessionAuthorityMarkerRaw(
    adapter.scope,
    adapter.root,
    ENV_KEY
  )
  const journal = adapter.observeSessionAuthorityLegacyJournal(adapter.root, ENV_KEY)
  if (journal.status !== 'observed') throw journal.error
  const transactionId = randomUUID()
  const candidateHash = sessionPersistenceCandidateHash(storedValue)
  const prepared = repo.prepareCandidate(current.snapshot, {
    transactionId,
    candidateHash,
    accountId,
    sourceKind: 'keytar',
    priorSource,
    userDataDirectory: adapter.root,
    externalMarkerObservation: beforeMarker,
  })
  committed(prepared)
  repo.preflightCandidateAcceptanceCapacity(prepared.snapshot, transactionId, {
    ownerEpoch: 1,
    beforeMarker,
  })
  const candidate = prepared.record.candidates.find(item => item.transactionId === transactionId)
  if (!candidate) throw new Error('Producer did not retain its candidate denial')
  const publication = repo.beginCandidatePublication(prepared.snapshot, transactionId)
  if (publication.status !== 'ready') throw new Error('Candidate source slot was not admitted')
  const receipt = adapter.publishCandidate(
    {
      transactionId,
      candidateHash,
      sourceKind: 'keytar',
      sourceRef: candidate.sourceRef,
      sourceRevision: candidate.sourceRevision,
      envKey: ENV_KEY,
      accountId,
    },
    storedValue
  )
  const published = await repo.markCandidatePublished(
    publication.snapshot,
    transactionId,
    receipt,
    publication.lease
  )
  committed(published)
  const verified = repo.verifyCandidate(published.snapshot, transactionId)
  committed(verified)
  const projection = repo.prepareAcceptanceProjection(verified.snapshot, transactionId, {
    ownerEpoch: 1,
    beforeMarker,
    legacyJournalReceipt: journal.receipt,
  })
  committed(projection.result)
  const markerReceipt = repo.publishAcceptanceProjectionMarker(
    projection.result.snapshot,
    transactionId
  )
  const source = projection.result.record.candidates.find(
    item => item.transactionId === transactionId
  )?.publishedSource
  if (!source) throw new Error('Candidate source receipt was not retained')
  const accepted = repo.acceptCandidate(
    projection.result.snapshot,
    transactionId,
    {
      mode: 'persistent',
      source,
      markerIntent: null,
    },
    markerReceipt
  )
  committed(accepted)
  const acceptedSource = accepted.record.frame.source
  if (!acceptedSource) throw new Error('Persistent authority did not select its source')
  return acceptedSource
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of tempDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

describe('dormant V2 session-authority record repository', () => {
  it('preserves a rejected candidate denial and the exact accepted source across restart', async () => {
    const { adapter } = fixture()
    const repo = repository(adapter)
    const sourceA = await acceptKeytarSource(repo, adapter, 'account-a', 'opaque-source-a', null)
    const current = observed(repo)
    const marker = adapter.observeSessionAuthorityMarkerRaw(adapter.scope, adapter.root, ENV_KEY)
    const prepared = repo.prepareCandidate(current.snapshot, {
      transactionId: randomUUID(),
      candidateHash: sha256('candidate-rejected-b'),
      accountId: 'account-b',
      sourceKind: 'keytar',
      priorSource: sourceA,
      userDataDirectory: adapter.root,
      externalMarkerObservation: marker,
    })
    committed(prepared)
    const rejectedRef = prepared.record.candidates[0]?.sourceRef
    const restarted = observed(repository(adapter))
    expect(restarted.record.frame.source).toEqual(sourceA)
    expect(restarted.record.candidates).toHaveLength(1)
    expect(restarted.record.candidates[0]?.phase).toBe('denied')
    expect(restarted.record.candidates[0]?.sourceRef).toBe(rejectedRef)
    expect(adapter.publishedSources.get(sourceA.sourceRef)).toEqual(sourceA)
    expect(fs.existsSync(path.join(adapter.directory, `candidate-${sourceA.sourceRef}`))).toBe(true)
    expect(fs.existsSync(path.join(adapter.directory, `candidate-${rejectedRef}`))).toBe(false)
  })

  it('accepts a replacement only with exact prior-source cleanup debt and exact journal receipt', async () => {
    const { adapter } = fixture()
    const denials = adapter.produceLegacyJournalDenials(128)
    const fullJournalBytes = fs.readFileSync(adapter.journalFile, 'utf8')
    expect(readSessionPersistenceJournal(adapter.root, ENV_KEY)?.pending).toHaveLength(128)
    expect(() => adapter.produceLegacyJournalDenials(1)).toThrow()
    expect(fs.readFileSync(adapter.journalFile, 'utf8')).toBe(fullJournalBytes)
    const repo = repository(adapter)
    const sourceA = await acceptKeytarSource(repo, adapter, 'account-a', 'opaque-source-a', null)
    const sourceB = await acceptKeytarSource(repo, adapter, 'account-b', 'opaque-source-b', sourceA)
    const restarted = observed(repository(adapter))
    expect(restarted.record.frame.source).toEqual(sourceB)
    expect(sourceB.sourceRef).not.toBe(sourceA.sourceRef)
    expect(sourceB.sourceRevision).not.toBe(sourceA.sourceRevision)
    expect(sourceB.storedValueDigest).toBe(
      digestSessionAuthoritySource(
        {
          sourceKind: 'keytar',
          sourceRef: sourceB.sourceRef,
          envKey: ENV_KEY,
          accountId: 'account-b',
        },
        'opaque-source-b'
      )
    )
    expect(restarted.record.cleanupDebts).toHaveLength(1)
    expect(restarted.record.cleanupDebts[0]?.source).toEqual(sourceA)
    expect(restarted.record.cleanupDebts[0]?.supersedingFrameRevision).toBe(
      restarted.record.frame.revision
    )
    expect(restarted.record.legacyJournalReceipt?.denials).toEqual(denials)
    expect(restarted.record.projectionReceipt?.legacyJournalReceipt.denials).toEqual(denials)
    expect(fs.existsSync(path.join(adapter.directory, `candidate-${sourceA.sourceRef}`))).toBe(true)
    expect(fs.existsSync(path.join(adapter.directory, `candidate-${sourceB.sourceRef}`))).toBe(true)
    const debt = restarted.record.cleanupDebts[0]
    if (!debt) throw new Error('Accepted replacement did not retain exact source debt')
    expect(() => repo.retireCleanupDebt(restarted.snapshot, debt.id, {})).toThrow(
      /TokenStore proof of exact source absence/
    )
    const afterUnavailableCleanup = observed(repository(adapter))
    expect(afterUnavailableCleanup.record.frame.source).toEqual(sourceB)
    expect(afterUnavailableCleanup.record.cleanupDebts).toEqual([debt])
    expect(
      fs.readFileSync(path.join(adapter.directory, `candidate-${sourceA.sourceRef}`), 'utf8')
    ).toBe('opaque-source-a')

    const authorityBytes = fs.readFileSync(authorityFile(adapter.directory, ENV_KEY), 'utf8')
    expect(authorityBytes).not.toContain('opaque-source-a')
    expect(authorityBytes).not.toContain('opaque-source-b')
  })

  it('keeps the candidate denied if its exact source bytes change before receipt verification', async () => {
    const { adapter } = fixture()
    const repo = repository(adapter)
    const absent = repo.observe()
    expect(absent.status).toBe('absent')
    if (absent.status !== 'absent') throw new Error('Expected absent authority')
    committed(repo.initialize(absent.snapshot))
    const current = observed(repo)
    const beforeMarker = adapter.observeSessionAuthorityMarkerRaw(
      adapter.scope,
      adapter.root,
      ENV_KEY
    )
    const transactionId = randomUUID()
    const token = 'candidate-source-bytes-before-tampering'
    const candidateHash = sessionPersistenceCandidateHash(token)
    const prepared = repo.prepareCandidate(current.snapshot, {
      transactionId,
      candidateHash,
      accountId: 'account-source-digest',
      sourceKind: 'keytar',
      priorSource: null,
      userDataDirectory: adapter.root,
      externalMarkerObservation: beforeMarker,
    })
    committed(prepared)
    repo.preflightCandidateAcceptanceCapacity(prepared.snapshot, transactionId, {
      ownerEpoch: 7,
      beforeMarker,
    })
    const candidate = prepared.record.candidates.find(item => item.transactionId === transactionId)
    if (!candidate) throw new Error('Candidate denial receipt is missing')
    const publication = repo.beginCandidatePublication(prepared.snapshot, transactionId)
    if (publication.status !== 'ready') throw new Error('Candidate publication was not admitted')
    const receipt = adapter.publishCandidate(
      {
        transactionId,
        candidateHash,
        sourceKind: 'keytar',
        sourceRef: candidate.sourceRef,
        sourceRevision: candidate.sourceRevision,
        envKey: ENV_KEY,
        accountId: 'account-source-digest',
      },
      token
    )
    const candidateFile = path.join(adapter.directory, `candidate-${candidate.sourceRef}`)
    fs.writeFileSync(candidateFile, 'different-source-bytes', { mode: 0o600 })

    await expect(
      repo.markCandidatePublished(publication.snapshot, transactionId, receipt, publication.lease)
    ).rejects.toThrow(/durable-write receipt/)
    const after = observed(repository(adapter))
    expect(after.record.frame.mode).toBe('uninitialized')
    expect(after.record.frame.source).toBeNull()
    expect(after.record.candidates[0]?.phase).toBe('writing')
    expect(after.record.candidates[0]?.publishedSource).toBeNull()
    expect(adapter.publishedSources.has(candidate.sourceRef)).toBe(false)
  })

  it('rejects an acceptance projection when the legacy journal snapshot changes', () => {
    const { adapter } = fixture()
    const repo = repository(adapter)
    const absent = repo.observe()
    expect(absent.status).toBe('absent')
    if (absent.status !== 'absent') throw new Error('Expected an absent authority frame')
    committed(repo.initialize(absent.snapshot))
    const current = observed(repo)
    const beforeMarker = adapter.observeSessionAuthorityMarkerRaw(
      adapter.scope,
      adapter.root,
      ENV_KEY
    )
    const candidateHash = sha256('memory-candidate')
    const prepared = repo.prepareCandidate(current.snapshot, {
      transactionId: randomUUID(),
      candidateHash,
      accountId: 'account-memory',
      sourceKind: 'memory-only',
      volatileSessionId: randomUUID(),
      priorSource: null,
      userDataDirectory: adapter.root,
      externalMarkerObservation: beforeMarker,
    })
    committed(prepared)
    const candidateId = prepared.record.latestCandidateTransactionId
    if (!candidateId) throw new Error('Missing memory candidate producer receipt')
    const verified = repo.verifyCandidate(prepared.snapshot, candidateId)
    committed(verified)
    expect(canAcceptSessionAuthorityCandidate(verified.record, candidateId)).toBe(true)
    fc.assert(
      fc.property(fc.string(), otherId => {
        if (otherId === candidateId) return true
        return !canAcceptSessionAuthorityCandidate(
          { ...verified.record, latestCandidateTransactionId: otherId },
          candidateId
        )
      })
    )
    expect(
      canAcceptSessionAuthorityCandidate(
        {
          ...verified.record,
          frame: { ...verified.record.frame, revision: randomUUID() },
        },
        candidateId
      )
    ).toBe(false)
    const journal = adapter.observeSessionAuthorityLegacyJournal(adapter.root, ENV_KEY)
    if (journal.status !== 'observed') throw journal.error
    adapter.produceLegacyJournalDenials(1)
    const changedJournal = adapter.observeSessionAuthorityLegacyJournal(adapter.root, ENV_KEY)
    if (changedJournal.status !== 'observed') throw changedJournal.error

    expect(() =>
      repo.prepareAcceptanceProjection(verified.snapshot, candidateId, {
        ownerEpoch: 2,
        beforeMarker,
        legacyJournalReceipt: changedJournal.receipt,
      })
    ).toThrow(SessionAuthorityRecordConflictError)
    const after = observed(repository(adapter))
    expect(after.record.frame.mode).toBe('uninitialized')
    expect(after.record.projectionIntent).toBeNull()
    expect(after.record.candidates[0]?.phase).toBe('verified')
    expect(after.record.legacyJournalReceipt).toEqual(journal.receipt)
  })

  it('does not prepare acceptance from a candidate captured before a newer durable LP marker', () => {
    const { adapter } = fixture()
    const repo = repository(adapter)
    const candidate = prepareVerifiedMemoryCandidate(
      repo,
      adapter,
      'candidate-before-independent-logout'
    )
    recordPendingExternalLogout(adapter.root, ENV_KEY)

    expect(() =>
      repo.prepareAcceptanceProjection(candidate.verified.snapshot, candidate.transactionId, {
        ownerEpoch: 3,
        beforeMarker: candidate.beforeMarker,
        legacyJournalReceipt: candidate.journalReceipt,
      })
    ).toThrow(SessionAuthorityProjectionIntegrityError)

    const after = observed(repository(adapter))
    expect(after.record.frame.mode).toBe('uninitialized')
    expect(after.record.frame.source).toBeNull()
    expect(after.record.projectionIntent).toBeNull()
    expect(after.record.candidates[0]?.phase).toBe('verified')
    expect(
      adapter.observeSessionAuthorityMarkerRaw(adapter.scope, adapter.root, ENV_KEY).marker?.intent
        .intent
    ).toBe('logout-pending')
  })

  it('denies accepted-source reads when an external LP supersedes its projection', async () => {
    const { adapter } = fixture()
    const repo = repository(adapter)
    const source = await acceptKeytarSource(repo, adapter, 'account-a', 'accepted-source-a', null)
    const accepted = observed(repo)
    expect(repo.isAcceptedSourceCurrent(accepted.snapshot, source, source.transactionId)).toBe(true)

    recordPendingExternalLogout(adapter.root, ENV_KEY)

    expect(repo.isAcceptedSourceCurrent(accepted.snapshot, source, source.transactionId)).toBe(
      false
    )
    expect(observed(repository(adapter)).record.frame.source).toEqual(source)
  })

  it('requires exact marker publication before acceptance and rejects a later LP supersession', () => {
    const { adapter } = fixture()
    const repo = repository(adapter)
    const candidate = prepareVerifiedMemoryCandidate(
      repo,
      adapter,
      'candidate-with-projection-intent'
    )
    const projection = repo.prepareAcceptanceProjection(
      candidate.verified.snapshot,
      candidate.transactionId,
      {
        ownerEpoch: 4,
        beforeMarker: candidate.beforeMarker,
        legacyJournalReceipt: candidate.journalReceipt,
      }
    )
    committed(projection.result)
    const candidateRecord = projection.result.record.candidates.find(
      item => item.transactionId === candidate.transactionId
    )
    if (!candidateRecord?.volatileSessionId) throw new Error('Missing M-session receipt')
    const acceptance = {
      mode: 'memory-only' as const,
      volatileSessionId: candidateRecord.volatileSessionId,
    }

    expect(() =>
      Reflect.apply(repo.acceptCandidate, repo, [
        projection.result.snapshot,
        candidate.transactionId,
        acceptance,
        {},
      ])
    ).toThrow()
    expect(observed(repository(adapter)).record.frame.mode).toBe('uninitialized')

    const markerReceipt = repo.publishAcceptanceProjectionMarker(
      projection.result.snapshot,
      candidate.transactionId
    )
    recordPendingExternalLogout(adapter.root, ENV_KEY)
    expect(() =>
      repo.acceptCandidate(
        projection.result.snapshot,
        candidate.transactionId,
        acceptance,
        markerReceipt
      )
    ).toThrow()

    const after = observed(repository(adapter))
    expect(after.record.frame.mode).toBe('uninitialized')
    expect(after.record.frame.source).toBeNull()
    expect(after.record.projectionIntent?.operationId).toBe(candidate.transactionId)
    expect(
      adapter.observeSessionAuthorityMarkerRaw(adapter.scope, adapter.root, ENV_KEY).marker?.intent
        .intent
    ).toBe('logout-pending')
  })

  it('does not restore a stale projection over a newer LP marker during abort recovery', async () => {
    const { adapter } = fixture()
    const repo = repository(adapter)
    const sourceA = await acceptKeytarSource(repo, adapter, 'account-a', 'accepted-source-a', null)
    const candidate = prepareVerifiedMemoryCandidate(
      repo,
      adapter,
      'candidate-superseded-by-lp',
      sourceA
    )
    const projection = repo.prepareAcceptanceProjection(
      candidate.verified.snapshot,
      candidate.transactionId,
      {
        ownerEpoch: 4,
        beforeMarker: candidate.beforeMarker,
        legacyJournalReceipt: candidate.journalReceipt,
      }
    )
    committed(projection.result)
    repo.publishAcceptanceProjectionMarker(projection.result.snapshot, candidate.transactionId)
    recordPendingExternalLogout(adapter.root, ENV_KEY)

    expect(() =>
      repo.completeAbortedAcceptanceProjection(projection.result.snapshot, candidate.transactionId)
    ).toThrow(SessionAuthorityProjectionIntegrityError)

    const after = observed(repository(adapter))
    expect(after.record.frame.source).toEqual(sourceA)
    expect(after.record.projectionIntent?.candidateTransactionId).toBe(candidate.transactionId)
    expect(after.record.candidates[0]?.phase).toBe('verified')
    expect(repo.isAcceptedSourceCurrent(after.snapshot, sourceA, sourceA.transactionId)).toBe(false)
    expect(
      adapter.observeSessionAuthorityMarkerRaw(adapter.scope, adapter.root, ENV_KEY).marker?.intent
        .intent
    ).toBe('logout-pending')
  })

  // The test adapter's directory fsync contract is POSIX-only. Windows publication/durability
  // remains a separate mandatory native gate; this skip is not Windows validation evidence.
  it.skipIf(process.platform === 'win32')(
    'durably restores an exact absent marker image on POSIX when an uninitialized candidate is rejected',
    () => {
      const { adapter } = fixture()
      const repo = repository(adapter)
      const candidate = prepareVerifiedMemoryCandidate(
        repo,
        adapter,
        'candidate-absent-before-image'
      )
      const projection = repo.prepareAcceptanceProjection(
        candidate.verified.snapshot,
        candidate.transactionId,
        {
          ownerEpoch: 5,
          beforeMarker: candidate.beforeMarker,
          legacyJournalReceipt: candidate.journalReceipt,
        }
      )
      committed(projection.result)
      repo.publishAcceptanceProjectionMarker(projection.result.snapshot, candidate.transactionId)
      expect(fs.existsSync(adapter.markerFile)).toBe(true)

      const aborted = repo.completeAbortedAcceptanceProjection(
        projection.result.snapshot,
        candidate.transactionId
      )
      committed(aborted)

      const restarted = observed(repository(adapter))
      expect(restarted.record.frame.mode).toBe('uninitialized')
      expect(restarted.record.frame.source).toBeNull()
      expect(restarted.record.projectionIntent).toBeNull()
      expect(restarted.record.candidates).toHaveLength(0)
      expect(
        adapter.observeSessionAuthorityMarkerRaw(adapter.scope, adapter.root, ENV_KEY)
      ).toEqual(candidate.beforeMarker)
      expect(fs.existsSync(adapter.markerFile)).toBe(false)
    }
  )

  it('blocks accepted and candidate source reads while projection intent is unresolved', async () => {
    const { adapter } = fixture()
    const repo = repository(adapter)
    const sourceA = await acceptKeytarSource(repo, adapter, 'account-a', 'accepted-source-a', null)
    const candidate = prepareVerifiedMemoryCandidate(
      repo,
      adapter,
      'staged-memory-replacement-b',
      sourceA
    )
    const projection = repo.prepareAcceptanceProjection(
      candidate.verified.snapshot,
      candidate.transactionId,
      {
        ownerEpoch: 8,
        beforeMarker: candidate.beforeMarker,
        legacyJournalReceipt: candidate.journalReceipt,
      }
    )
    committed(projection.result)

    expect(() => repo.authorizeAcceptedSourceRead(projection.result.snapshot)).toThrow(
      SessionAuthorityRecordConflictError
    )
    expect(() =>
      repo.authorizeCandidateSourceRead(projection.result.snapshot, candidate.transactionId)
    ).toThrow(SessionAuthorityRecordConflictError)
    const after = observed(repository(adapter))
    expect(after.record.frame.transactionId).toBe(sourceA.transactionId)
    expect(after.record.frame.source).toEqual(sourceA)
    expect(after.record.projectionIntent?.candidateTransactionId).toBe(candidate.transactionId)
  })

  it('keeps authority denied when marker publication returns uncertain after the file move', () => {
    const { adapter } = fixture()
    const repo = repository(adapter)
    const candidate = prepareVerifiedMemoryCandidate(
      repo,
      adapter,
      'candidate-marker-durability-uncertain'
    )
    const projection = repo.prepareAcceptanceProjection(
      candidate.verified.snapshot,
      candidate.transactionId,
      {
        ownerEpoch: 5,
        beforeMarker: candidate.beforeMarker,
        legacyJournalReceipt: candidate.journalReceipt,
      }
    )
    committed(projection.result)
    const originalFsync = fs.fsyncSync
    let injected = false
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (!injected && fs.fstatSync(fd).isDirectory()) {
        injected = true
        throw Object.assign(new Error('Injected marker directory-sync uncertainty'), {
          code: 'EIO',
        })
      }
      return originalFsync(fd)
    })

    expect(() =>
      repo.publishAcceptanceProjectionMarker(projection.result.snapshot, candidate.transactionId)
    ).toThrow()
    expect(injected).toBe(true)
    const after = observed(repository(adapter))
    expect(after.record.frame.mode).toBe('uninitialized')
    expect(after.record.frame.source).toBeNull()
    expect(after.record.projectionIntent?.operationId).toBe(candidate.transactionId)
    expect(
      adapter.observeSessionAuthorityMarkerRaw(adapter.scope, adapter.root, ENV_KEY).marker?.intent
        .intent
    ).toBe('acceptance-pending')
  })

  it('fails closed on unsupported and malformed authority frames', () => {
    const { adapter } = fixture()
    const file = authorityFile(adapter.directory, ENV_KEY)
    fs.writeFileSync(file, JSON.stringify({ version: 1 }), { mode: 0o600 })
    const unsupported = repository(adapter).observe()
    expect(unsupported.status).toBe('invalid')
    if (unsupported.status !== 'invalid') throw new Error('Expected unsupported version denial')
    expect(unsupported.error).toBeInstanceOf(SessionAuthorityUnsupportedRecordVersionError)

    fs.writeFileSync(file, '{"version":2,"envKey":', { mode: 0o600 })
    const malformed = repository(adapter).observe()
    expect(malformed.status).toBe('invalid')
    if (malformed.status !== 'invalid') throw new Error('Expected malformed frame denial')
  })

  it('returns a losing CAS when another repository has already published a newer frame', () => {
    const { adapter } = fixture()
    const first = repository(adapter)
    const second = repository(adapter)
    const firstSnapshot = first.observe()
    const secondSnapshot = second.observe()
    expect(firstSnapshot.status).toBe('absent')
    expect(secondSnapshot.status).toBe('absent')
    if (firstSnapshot.status !== 'absent' || secondSnapshot.status !== 'absent')
      throw new Error('Expected two observations of the same absent authority')
    committed(first.initialize(firstSnapshot.snapshot))
    expect(second.initialize(secondSnapshot.snapshot)).toEqual({ status: 'superseded' })
    expect(observed(repository(adapter)).record.frame.mode).toBe('uninitialized')
  })

  it('rejects journal uncertainty before writing a candidate denial', () => {
    const { adapter } = fixture()
    const repo = repository(adapter)
    const absent = repo.observe()
    expect(absent.status).toBe('absent')
    if (absent.status !== 'absent') throw new Error('Expected absent authority')
    committed(repo.initialize(absent.snapshot))
    const current = observed(repo)
    const beforeMarker = adapter.observeSessionAuthorityMarkerRaw(
      adapter.scope,
      adapter.root,
      ENV_KEY
    )
    adapter.journalFailure = 'transient'
    expect(() =>
      repo.prepareCandidate(current.snapshot, {
        transactionId: randomUUID(),
        candidateHash: sha256('transient-journal-candidate'),
        accountId: 'account-transient',
        sourceKind: 'memory-only',
        priorSource: null,
        userDataDirectory: adapter.root,
        externalMarkerObservation: beforeMarker,
      })
    ).toThrow(/Test journal observation failure/)
    adapter.journalFailure = null
    const after = observed(repository(adapter))
    expect(after.record.candidates).toHaveLength(0)
  })

  it('fails closed when the protected storage boundary is not private', () => {
    const { adapter } = fixture()
    fs.chmodSync(adapter.directory, 0o755)
    expect(() => repository(adapter)).toThrow(/not private/)
    fs.chmodSync(adapter.directory, 0o700)
    expect(repository(adapter).observe().status).toBe('absent')
  })

  it('resolves directory-sync uncertainty by exact reread before reporting a candidate', () => {
    const { adapter } = fixture()
    const repo = repository(adapter)
    const absent = repo.observe()
    expect(absent.status).toBe('absent')
    if (absent.status !== 'absent') throw new Error('Expected absent authority')
    committed(repo.initialize(absent.snapshot))
    const current = observed(repo)
    const beforeMarker = adapter.observeSessionAuthorityMarkerRaw(
      adapter.scope,
      adapter.root,
      ENV_KEY
    )
    const originalFsync = fs.fsyncSync
    let directorySyncCount = 0
    let directorySyncFailed = false
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) {
        directorySyncCount += 1
      }
      if (directorySyncCount === 2 && !directorySyncFailed) {
        directorySyncFailed = true
        throw Object.assign(new Error('Injected directory durability uncertainty'), {
          code: 'EIO',
        })
      }
      return originalFsync(fd)
    })
    const result = repo.prepareCandidate(current.snapshot, {
      transactionId: randomUUID(),
      candidateHash: sha256('durability-uncertainty-candidate'),
      accountId: 'account-durability',
      sourceKind: 'memory-only',
      priorSource: null,
      userDataDirectory: adapter.root,
      externalMarkerObservation: beforeMarker,
    })
    committed(result)
    expect(directorySyncFailed).toBe(true)
    expect(directorySyncCount).toBeGreaterThan(2)
    const after = observed(repository(adapter))
    expect(after.record.candidates).toHaveLength(1)
    expect(after.record.candidates[0]?.phase).toBe('denied')
    expect(after.record.frame.mode).toBe('uninitialized')
  })

  // The crash worker requires POSIX directory fsync. Windows native authority durability must be
  // established by its dedicated workflow before any persistent V2 production rollout.
  it.skipIf(process.platform === 'win32')(
    'classifies real process crashes across POSIX intent, marker, and authority commit boundaries',
    () => {
      const worker = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'sessionAuthorityRecordCrashWorker.cjs'
      )
      const crashPhases = [
        'before-intent',
        'after-intent',
        'after-marker',
        'after-acceptance',
        'after-persistent-acceptance',
      ] as const
      for (const phase of crashPhases) {
        const { adapter } = fixture()
        const producer = spawnSync(
          process.execPath,
          [worker, adapter.directory, ENV_KEY, 'produce', phase],
          {
            encoding: 'utf8',
            timeout: 10_000,
          }
        )
        expect(producer.error).toBeUndefined()
        expect(producer.signal).toBeNull()
        const expectedExit = {
          'before-intent': 71,
          'after-intent': 72,
          'after-marker': 73,
          'after-acceptance': 74,
          'after-persistent-acceptance': 79,
        }[phase]
        expect(producer.status, `${phase}: ${producer.stderr}`).toBe(expectedExit)
        expect(producer.stdout).toBe('')
        expect(producer.stderr).toBe('')

        // Recovery runs in a second OS process with fresh adapter, lease and repository objects.
        const restart = spawnSync(
          process.execPath,
          [worker, adapter.directory, ENV_KEY, 'recover'],
          {
            encoding: 'utf8',
            timeout: 10_000,
          }
        )
        expect(restart.error).toBeUndefined()
        expect(restart.signal).toBeNull()
        expect(restart.status, restart.stderr).toBe(0)
        expect(restart.stderr).toBe('')
        const recovered = JSON.parse(restart.stdout) as {
          firstStatus: string
          recoveryId: string | null
          record: {
            revision: string
            frame: {
              mode: string
              source: {
                kind: string
                format: string
                accountId: string | null
                sourceRef: string
                sourceRevision: string | null
              } | null
              transactionId: string | null
            }
            marker: unknown
            latestCandidateTransactionId: string | null
            candidates: Array<{
              transactionId: string
              sourceRef: string
              sourceRevision: string
              phase: string
            }>
            cleanupDebts: Array<{
              id: string
              sourceRef: string
              sourceRevision: string
              source: {
                kind: string
                format: string
                transactionId: string | null
                accountId: string | null
                sourceRef: string
                sourceRevision: string | null
                storedValueDigest: string
              }
            }>
            legacyJournalReceipt: unknown
            projectionIntent: {
              candidateTransactionId: string
              legacyJournalReceipt: unknown
            } | null
            projectionReceipt: { operationId: string; legacyJournalReceipt: unknown } | null
          }
          externalMarker: {
            kind: string
            digest: string
            intent: string | null
            revision: string | null
          }
          journalReceipt: {
            schemaVersion: number
            revision: string
            byteLength: number
            digest: string
            denials: Array<{ producer: string; candidateHash: string }>
          }
          acceptedReadDenied: boolean
          acceptedReadError: string | null
          acceptedReadAllowed: boolean
          candidateReadDenied: boolean
          candidateReadChecked: boolean
          candidateReadTransactionId: string | null
          candidateReadError: string | null
          interruptedCandidateRef: string | null
          candidateCleanupCompleted: boolean
          interruptedCandidateSlotAbsent: boolean
          priorAcceptedMarkerPreserved: boolean
          priorCredentialPresent: boolean
          selectedSourceBytesMatch: boolean
        }
        expect(recovered.record.revision).toMatch(/^[0-9a-f-]{36}$/i)
        expect(recovered.journalReceipt.schemaVersion).toBe(1)
        expect(recovered.journalReceipt.denials).toHaveLength(1)
        expect(recovered.record.legacyJournalReceipt).toEqual(recovered.journalReceipt)
        expect(recovered.journalReceipt.byteLength).toBeGreaterThan(0)
        expect(recovered.journalReceipt.digest).toMatch(/^[0-9a-f]{64}$/)
        expect(recovered.candidateReadChecked).toBe(true)
        expect(recovered.candidateReadTransactionId).toMatch(/^[0-9a-f-]{36}$/i)
        expect(recovered.candidateReadDenied).toBe(true)
        expect(recovered.candidateReadError).toBeTruthy()
        if (recovered.record.projectionIntent)
          expect(recovered.record.projectionIntent.legacyJournalReceipt).toEqual(
            recovered.journalReceipt
          )
        if (recovered.record.projectionReceipt)
          expect(recovered.record.projectionReceipt.legacyJournalReceipt).toEqual(
            recovered.journalReceipt
          )

        expect(recovered.firstStatus).toBe('observed')
        expect(recovered.recoveryId).toBeNull()

        expect(recovered.externalMarker.intent).toBe('acceptance-pending')
        expect(recovered.externalMarker.digest).toMatch(/^[0-9a-f]{64}$/)
        expect(recovered.priorCredentialPresent).toBe(true)
        if (phase === 'after-persistent-acceptance') {
          expect(recovered.record.frame.mode).toBe('persistent')
          expect(recovered.record.frame.source).toMatchObject({
            kind: 'keytar',
            format: 'v1',
            accountId: 'crash-worker-account-b',
          })
          expect(recovered.record.frame.transactionId).toBe(
            recovered.record.projectionReceipt?.operationId
          )
          expect(recovered.record.candidates).toHaveLength(0)
          expect(recovered.record.cleanupDebts).toHaveLength(1)
          expect(recovered.record.cleanupDebts[0]?.source).toMatchObject({
            kind: 'keytar',
            format: 'v1',
            accountId: 'crash-worker-account-a',
          })
          expect(recovered.record.cleanupDebts[0]?.sourceRef).not.toBe(
            recovered.record.frame.source?.sourceRef
          )
          expect(recovered.acceptedReadAllowed, JSON.stringify(recovered)).toBe(true)
          expect(recovered.acceptedReadDenied).toBe(false)
          expect(recovered.selectedSourceBytesMatch).toBe(true)
          expect(recovered.candidateCleanupCompleted).toBe(false)
          expect(recovered.interruptedCandidateRef).toBeNull()
          expect(recovered.priorAcceptedMarkerPreserved).toBe(false)
          expect(recovered.record.cleanupDebts[0]?.source.storedValueDigest).toMatch(
            /^[0-9a-f]{64}$/
          )
        } else if (phase === 'after-acceptance') {
          expect(recovered.record.frame.mode).toBe('memory-only')
          expect(recovered.record.frame.source).toBeNull()
          expect(recovered.record.frame.transactionId).toBe(
            recovered.record.projectionReceipt?.operationId
          )
          expect(recovered.record.projectionIntent).toBeNull()
          expect(recovered.record.candidates).toHaveLength(0)
          expect(recovered.record.cleanupDebts).toHaveLength(1)
          expect(recovered.acceptedReadDenied).toBe(true)
          expect(recovered.acceptedReadAllowed).toBe(false)
          expect(recovered.selectedSourceBytesMatch).toBe(true)
          expect(recovered.candidateCleanupCompleted).toBe(false)
          expect(recovered.interruptedCandidateRef).toBeNull()
          expect(recovered.record.cleanupDebts[0]?.source.accountId).toBe('crash-worker-account-a')
        } else {
          expect(recovered.record.frame.mode).toBe('persistent')
          expect(recovered.record.frame.source).toMatchObject({
            kind: 'keytar',
            format: 'v1',
            accountId: 'crash-worker-account-a',
          })
          expect(recovered.selectedSourceBytesMatch).toBe(true)
          expect(recovered.record.candidates).toHaveLength(0)
          expect(recovered.record.projectionIntent).toBeNull()
          expect(recovered.record.cleanupDebts).toHaveLength(0)
          expect(recovered.acceptedReadAllowed).toBe(true)
          expect(recovered.acceptedReadDenied).toBe(false)
          expect(recovered.candidateCleanupCompleted).toBe(true)
          expect(recovered.interruptedCandidateRef).toMatch(/^[0-9a-f-]{36}$/i)
          expect(recovered.interruptedCandidateSlotAbsent).toBe(true)
          expect(recovered.priorAcceptedMarkerPreserved).toBe(true)
        }
      }
    }
  )
})
