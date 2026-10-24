const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  renameSessionAuthorityFileDurablySync,
} = require('../../dist/sessionAuthorityDurableFileOps.js')
const {
  readSessionPersistenceJournal,
  SessionPersistenceProducer,
  sessionPersistenceCandidateHash,
} = require('../../dist/sessionPersistenceJournal.js')
const {
  consumeSessionAuthorityStorageAuthorization,
  finishSessionAuthorityStorageAuthorization,
  revalidateSessionAuthorityStorageAuthorization,
  SessionAuthorityRecordRepository,
  digestSessionAuthoritySource,
} = require('../../dist/sessionAuthorityRecord.js')

const [directory, envKey, role, phase] = process.argv.slice(2)
const phases = new Set([
  'before-intent',
  'after-intent',
  'after-marker',
  'after-acceptance',
  'after-persistent-acceptance',
])
if (!directory || !envKey || !['produce', 'recover'].includes(role)) process.exit(64)
if (role === 'produce' && !phases.has(phase)) process.exit(64)
if (role === 'recover' && phase !== undefined) process.exit(64)

const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const authorityPath = path.join(directory, `session-authority-${digest(envKey)}`)
const userDataDirectory = path.dirname(directory)
const markerFile = path.join(userDataDirectory, `pending-external-logout-${digest(envKey)}`)
const journalFile = path.join(userDataDirectory, `session-persistence-journal-${digest(envKey)}`)
const mutationActive = { value: false }
const markerReceipts = new WeakMap()
const candidateReceipts = new WeakMap()
const absenceProofs = new WeakMap()

function observeMarker() {
  let rawContents
  try {
    rawContents = fs.readFileSync(markerFile, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return {
      rawContents: null,
      rawDigest: digest('session-marker:absent:v1'),
      kind: 'absent',
      marker: null,
    }
  }
  const parsed = JSON.parse(rawContents)
  if (
    parsed.version !== 2 ||
    parsed.intent !== 'acceptance-pending' ||
    parsed.purpose !== 'candidate-acceptance' ||
    typeof parsed.operationId !== 'string' ||
    typeof parsed.revision !== 'string'
  )
    throw new Error('Crash worker encountered an unsupported marker image')
  return {
    rawContents,
    rawDigest: digest(rawContents),
    kind: 'revisioned',
    marker: {
      intent: {
        intent: 'acceptance-pending',
        purpose: parsed.purpose,
        operationId: parsed.operationId,
        expectedAuthorityRevision: parsed.expectedAuthorityRevision,
        expectedAuthorityDigest: parsed.expectedAuthorityDigest,
        priorMarkerKind: parsed.priorMarkerKind,
        priorMarkerDigest: parsed.priorMarkerDigest,
        priorMarkerRevision: parsed.priorMarkerRevision,
      },
      revision: parsed.revision,
    },
  }
}

const scope = Object.freeze({})
const lease = Object.freeze({})
const adapter = {
  resolveSessionAuthorityStorageDirectory(value) {
    if (value !== scope) throw new Error('Unissued storage scope')
    return directory
  },
  resolveSessionAuthorityStorageScope(value) {
    if (value !== scope) throw new Error('Unissued storage scope')
    return userDataDirectory
  },
  resolveSessionAuthorityUserDataDirectory(value) {
    if (value !== scope) throw new Error('Unissued storage scope')
    return userDataDirectory
  },
  assertSessionAuthorityStorageScopeCurrentSync(value) {
    if (value !== scope) throw new Error('Unissued storage scope')
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe test directory')
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      throw new Error('Test directory is not private')
  },
  assertSessionAuthorityTransactionLeaseCurrentSync(value, issuedLease) {
    if (value !== scope || issuedLease !== lease) throw new Error('Unissued transaction lease')
  },
  runSessionAuthorityRecordMutation(operation, issuedLease) {
    if (issuedLease !== lease || mutationActive.value)
      throw new Error('Same-profile mutation lane is unavailable')
    mutationActive.value = true
    try {
      return operation()
    } finally {
      mutationActive.value = false
    }
  },
  observeSessionAuthorityMarkerRaw(value, observedUserData, observedEnvKey) {
    if (
      value !== scope ||
      observedEnvKey !== envKey ||
      path.resolve(observedUserData) !== path.resolve(userDataDirectory)
    )
      throw new Error('Marker observation escaped the crash-test scope')
    return observeMarker()
  },
  compareAndSetSessionAuthorityAcceptancePendingMarker(
    value,
    observedUserData,
    observedEnvKey,
    expectedBefore,
    stagedMarker
  ) {
    if (
      value !== scope ||
      !mutationActive.value ||
      observedEnvKey !== envKey ||
      path.resolve(observedUserData) !== path.resolve(userDataDirectory)
    )
      throw new Error('Marker CAS requires the owned mutation lane and scope')
    const before = observeMarker()
    if (
      before.rawContents !== expectedBefore.rawContents ||
      before.rawDigest !== expectedBefore.rawDigest ||
      before.kind !== expectedBefore.kind ||
      (before.marker?.revision ?? null) !== expectedBefore.revision
    )
      return { status: 'superseded' }
    const contents = JSON.stringify(stagedMarker)
    const temporary = `${markerFile}.${crypto.randomUUID()}.tmp`
    let descriptor
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600)
      fs.writeFileSync(descriptor, contents, 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = undefined
      const current = observeMarker()
      if (
        current.rawContents !== expectedBefore.rawContents ||
        current.rawDigest !== expectedBefore.rawDigest ||
        current.kind !== expectedBefore.kind ||
        (current.marker?.revision ?? null) !== expectedBefore.revision
      )
        return { status: 'superseded' }
      renameSessionAuthorityFileDurablySync(
        temporary,
        markerFile,
        expectedBefore.rawContents !== null,
        Buffer.from(contents, 'utf8')
      )
    } catch {
      return { status: 'uncertain' }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      try {
        fs.unlinkSync(temporary)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    const after = observeMarker()
    if (after.rawContents !== contents || after.rawDigest !== digest(contents))
      return { status: 'uncertain' }
    const receipt = Object.freeze({})
    markerReceipts.set(receipt, {
      envKey,
      operationId: stagedMarker.operationId,
      markerRevision: stagedMarker.revision,
      markerDigest: digest(contents),
    })
    return { status: 'verified', receipt }
  },
  compareAndSetSessionAuthorityMarkerImage(
    value,
    observedUserData,
    observedEnvKey,
    expectedBefore,
    targetImage
  ) {
    if (
      value !== scope ||
      !mutationActive.value ||
      observedEnvKey !== envKey ||
      path.resolve(observedUserData) !== path.resolve(userDataDirectory)
    )
      throw new Error('Marker restoration requires the owned mutation lane and scope')
    const before = observeMarker()
    if (
      before.rawContents !== expectedBefore.rawContents ||
      before.rawDigest !== expectedBefore.rawDigest ||
      before.kind !== expectedBefore.kind ||
      (before.marker?.revision ?? null) !== (expectedBefore.marker?.revision ?? null)
    )
      return { status: 'superseded' }
    if (
      targetImage.rawDigest !==
      (targetImage.rawContents === null
        ? digest('session-marker:absent:v1')
        : digest(targetImage.rawContents))
    )
      return { status: 'uncertain' }
    try {
      if (targetImage.rawContents === null) {
        if (process.platform === 'win32') return { status: 'uncertain' }
        fs.unlinkSync(markerFile)
        const descriptor = fs.openSync(userDataDirectory, fs.constants.O_RDONLY)
        try {
          fs.fsyncSync(descriptor)
        } finally {
          fs.closeSync(descriptor)
        }
      } else {
        const temporary = `${markerFile}.${crypto.randomUUID()}.tmp`
        let descriptor
        try {
          descriptor = fs.openSync(temporary, 'wx', 0o600)
          fs.writeFileSync(descriptor, targetImage.rawContents, 'utf8')
          fs.fsyncSync(descriptor)
          fs.closeSync(descriptor)
          descriptor = undefined
          const current = observeMarker()
          if (
            current.rawContents !== expectedBefore.rawContents ||
            current.rawDigest !== expectedBefore.rawDigest ||
            current.kind !== expectedBefore.kind ||
            (current.marker?.revision ?? null) !== (expectedBefore.marker?.revision ?? null)
          )
            return { status: 'superseded' }
          renameSessionAuthorityFileDurablySync(
            temporary,
            markerFile,
            expectedBefore.rawContents !== null,
            Buffer.from(targetImage.rawContents, 'utf8')
          )
        } finally {
          if (descriptor !== undefined) fs.closeSync(descriptor)
          try {
            fs.unlinkSync(temporary)
          } catch (error) {
            if (error.code !== 'ENOENT') throw error
          }
        }
      }
    } catch {
      return { status: 'uncertain' }
    }
    const after = observeMarker()
    if (
      after.rawContents !== targetImage.rawContents ||
      after.rawDigest !== targetImage.rawDigest ||
      after.kind !== targetImage.kind ||
      (after.marker?.revision ?? null) !== targetImage.revision
    )
      return { status: 'uncertain' }
    return { status: 'verified', receipt: Object.freeze({}) }
  },
  consumeSessionAuthorityAcceptancePendingMarkerReceipt(receipt, value, expected) {
    if (value !== scope || !mutationActive.value || !receipt) return false
    const issued = markerReceipts.get(receipt)
    if (!issued || JSON.stringify(issued) !== JSON.stringify(expected)) return false
    const current = observeMarker()
    if (
      current.rawDigest !== expected.markerDigest ||
      current.marker?.revision !== expected.markerRevision
    )
      return false
    markerReceipts.delete(receipt)
    return true
  },
  async consumeSessionTokenCandidatePublicationReceipt(receipt, value, expected) {
    if (value !== scope) throw new Error('Test candidate receipt used a foreign storage scope')
    if (typeof receipt !== 'object' || receipt === null)
      throw new Error('Test candidate receipt was absent')
    const published = candidateReceipts.get(receipt)
    if (!published) throw new Error('Test candidate receipt was not issued by the source producer')
    const expectedKeys = [
      'transactionId',
      'candidateHash',
      'sourceKind',
      'sourceRef',
      'sourceRevision',
      'envKey',
      'accountId',
    ]
    const mismatchedKey = expectedKeys.find(key => published.expected[key] !== expected[key])
    if (mismatchedKey) throw new Error(`Test candidate receipt mismatch: ${mismatchedKey}`)
    let stored
    try {
      stored = fs.readFileSync(published.file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Test candidate source was absent')
      throw error
    }
    if (stored !== published.value) throw new Error('Test candidate source read-back changed')
    const source = {
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
        stored
      ),
    }
    candidateReceipts.delete(receipt)
    return source
  },
  publishCandidate(expected, value) {
    if (digest(value) !== expected.candidateHash)
      throw new Error('Candidate source bytes do not match the producer denial hash')
    const file = path.join(directory, `candidate-${expected.sourceRef}`)
    const {
      createSessionAuthorityFileDurablySync,
    } = require('../../dist/sessionAuthorityDurableFileOps.js')
    createSessionAuthorityFileDurablySync(file, value)
    const receipt = Object.freeze({})
    candidateReceipts.set(receipt, { expected, file, value })
    return receipt
  },
  observeSessionAuthorityLegacyJournal(storageRoot, observedEnvKey) {
    if (observedEnvKey !== envKey || path.resolve(storageRoot) !== path.resolve(userDataDirectory))
      return { status: 'invalid', error: new Error('Journal escaped the crash-test scope') }
    let rawContents
    try {
      rawContents = fs.readFileSync(journalFile, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT')
        return {
          status: 'transient',
          error,
        }
      rawContents = null
    }
    if (rawContents === null) {
      const absentDigest = digest('session-persistence-journal:absent:v0')
      return {
        status: 'observed',
        receipt: {
          schemaVersion: 0,
          revision: `v0-sha256:${absentDigest}`,
          byteLength: 0,
          digest: absentDigest,
          denials: [],
        },
      }
    }
    try {
      const parsed = readSessionPersistenceJournal(storageRoot, envKey)
      if (!parsed) throw new Error('Journal disappeared after its byte snapshot')
      if (fs.readFileSync(journalFile, 'utf8') !== rawContents)
        return { status: 'transient', error: new Error('Journal changed during observation') }
      const journalDigest = digest(rawContents)
      return {
        status: 'observed',
        receipt: {
          schemaVersion: 1,
          revision: `v0-sha256:${journalDigest}`,
          byteLength: Buffer.byteLength(rawContents),
          digest: journalDigest,
          denials: parsed.pending.map(({ producer, candidateHash }) => ({
            producer,
            candidateHash,
          })),
        },
      }
    } catch (error) {
      return { status: 'invalid', error }
    }
  },
  isLegacySessionCredentialSourceBoundToScope() {
    return false
  },
  consumeSelectedLegacyPriorSourceObservation() {
    return false
  },
  consumeLegacyPriorSourceObservation() {
    return false
  },
  resolveAbsenceProof(proof, value) {
    if (value !== scope || typeof proof !== 'object' || proof === null) return null
    return absenceProofs.get(proof) || null
  },
  removeRejectedCandidateSource(authorization, candidate, source) {
    const exactCandidate = { ...candidate }
    return adapter.runSessionAuthorityRecordMutation(() => {
      if (
        !consumeSessionAuthorityStorageAuthorization(authorization, adapter, scope, {
          purpose: 'candidate-cleanup',
          candidate: exactCandidate,
        })
      )
        throw new Error('Cleanup capability did not match the durable candidate denial')
      const file = path.join(directory, `candidate-${candidate.sourceRef}`)
      try {
        if (
          source.format !== 'v1' ||
          source.transactionId !== candidate.transactionId ||
          source.sourceRef !== candidate.sourceRef ||
          source.sourceRevision !== candidate.sourceRevision ||
          source.accountId !== candidate.accountId ||
          source.envKey !== candidate.envKey
        )
          throw new Error('Candidate source receipt does not match its exact slot')
        if (!revalidateSessionAuthorityStorageAuthorization(authorization, adapter, scope))
          throw new Error('Candidate cleanup authority was superseded')
        try {
          const stat = fs.lstatSync(file)
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe candidate slot')
          const stored = fs.readFileSync(file, 'utf8')
          if (
            sessionPersistenceCandidateHash(stored) !== candidate.candidateHash ||
            digestSessionAuthoritySource(
              {
                sourceKind: candidate.sourceKind,
                sourceRef: candidate.sourceRef,
                envKey: candidate.envKey,
                accountId: candidate.accountId,
              },
              stored
            ) !== source.storedValueDigest
          )
            throw new Error('Candidate bytes do not match the exact source receipt')
          if (!revalidateSessionAuthorityStorageAuthorization(authorization, adapter, scope))
            throw new Error('Candidate cleanup authority was superseded before unlink')
          fs.unlinkSync(file)
          const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY)
          try {
            fs.fsyncSync(directoryDescriptor)
          } finally {
            fs.closeSync(directoryDescriptor)
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        if (fs.existsSync(file)) throw new Error('Exact candidate source remains after cleanup')
        if (!revalidateSessionAuthorityStorageAuthorization(authorization, adapter, scope))
          throw new Error('Candidate cleanup authority was superseded before absence proof')
        const candidateProof = Object.freeze({})
        const sourceProof = Object.freeze({})
        absenceProofs.set(candidateProof, {
          kind: 'candidate-slot-absent',
          candidate: exactCandidate,
        })
        absenceProofs.set(sourceProof, {
          kind: 'source-absent',
          transactionId: source.transactionId,
          source,
          outcome: 'deleted',
        })
        return { candidateProof, sourceProof }
      } finally {
        finishSessionAuthorityStorageAuthorization(authorization)
      }
    }, lease)
  },
}

if (role === 'recover') {
  const repository = new SessionAuthorityRecordRepository(scope, envKey, adapter, lease)
  const firstObservation = repository.observe()
  let recoveryId = null
  if (firstObservation.status === 'recovery-fenced') {
    recoveryId = repository.resumeRecovery()
  }
  let observation = repository.observe()
  if (observation.status !== 'observed') process.exit(80)
  let record = observation.record
  const interruptedCandidate = record.candidates.find(
    item => item.transactionId === record.latestCandidateTransactionId
  )
  const interruptedCandidateRef = interruptedCandidate?.sourceRef ?? null
  const candidateReadTransactionId =
    interruptedCandidate?.transactionId ??
    record.projectionIntent?.candidateTransactionId ??
    record.projectionReceipt?.operationId ??
    record.latestCandidateTransactionId ??
    null
  let candidateReadDenied = false
  let candidateReadError = null
  if (candidateReadTransactionId) {
    try {
      repository.authorizeCandidateSourceRead(observation.snapshot, candidateReadTransactionId)
    } catch (error) {
      candidateReadDenied = true
      candidateReadError = error instanceof Error ? error.message.slice(0, 160) : 'unknown'
    }
  }
  let cleanupCompleted = false
  if (interruptedCandidate && interruptedCandidate.sourceKind !== 'memory-only') {
    const source = interruptedCandidate.publishedSource
    if (!source) process.exit(82)
    const cleanup = repository.claimRejectedCandidateCleanup(
      observation.snapshot,
      interruptedCandidate.transactionId
    )
    if (cleanup.status !== 'claimed') process.exit(83)
    const proofs = adapter.removeRejectedCandidateSource(
      cleanup.authorization,
      {
        transactionId: interruptedCandidate.transactionId,
        candidateHash: interruptedCandidate.candidateHash,
        sourceKind: interruptedCandidate.sourceKind,
        sourceRef: interruptedCandidate.sourceRef,
        sourceRevision: interruptedCandidate.sourceRevision,
        envKey,
        accountId: interruptedCandidate.accountId,
      },
      source
    )
    const retired = record.projectionIntent
      ? repository.completeAbortedAcceptanceProjection(
          cleanup.snapshot,
          interruptedCandidate.transactionId,
          proofs.candidateProof
        )
      : repository.retireRejectedCandidateAfterCleanup(
          cleanup.snapshot,
          interruptedCandidate.transactionId,
          proofs.sourceProof
        )
    if (retired.status !== 'committed') process.exit(84)
    cleanupCompleted = true
    observation = repository.observe()
    if (observation.status !== 'observed') process.exit(85)
    record = observation.record
  }
  const marker = adapter.observeSessionAuthorityMarkerRaw(scope, userDataDirectory, envKey)
  const journal = adapter.observeSessionAuthorityLegacyJournal(userDataDirectory, envKey)
  if (journal.status !== 'observed') process.exit(81)
  let acceptedReadDenied = false
  let acceptedReadError = null
  try {
    repository.authorizeAcceptedSourceRead(observation.snapshot)
  } catch (error) {
    acceptedReadDenied = true
    acceptedReadError = error instanceof Error ? error.message.slice(0, 160) : 'unknown'
  }
  process.stdout.write(
    JSON.stringify({
      firstStatus: firstObservation.status,
      recoveryId,
      record: {
        revision: record.revision,
        frame: record.frame,
        marker: record.marker,
        latestCandidateTransactionId: record.latestCandidateTransactionId,
        candidates: record.candidates.map(item => ({
          transactionId: item.transactionId,
          sourceRef: item.sourceRef,
          sourceRevision: item.sourceRevision,
          phase: item.phase,
        })),
        cleanupDebts: record.cleanupDebts.map(item => ({
          id: item.id,
          sourceRef: item.source.sourceRef,
          sourceRevision: item.source.sourceRevision,
          source: item.source,
        })),
        legacyJournalReceipt: record.legacyJournalReceipt,
        projectionIntent: record.projectionIntent,
        projectionReceipt: record.projectionReceipt,
      },
      externalMarker: {
        kind: marker.kind,
        digest: marker.rawDigest,
        intent: marker.marker?.intent.intent ?? null,
        revision: marker.marker?.revision ?? null,
      },
      journalReceipt: journal.receipt,
      acceptedReadDenied,
      acceptedReadError,
      acceptedReadAllowed: !acceptedReadDenied,
      candidateReadDenied,
      candidateReadChecked: candidateReadTransactionId !== null,
      candidateReadTransactionId,
      candidateReadError,
      interruptedCandidateRef,
      candidateCleanupCompleted: cleanupCompleted,
      interruptedCandidateSlotAbsent:
        interruptedCandidateRef === null ||
        !fs.existsSync(path.join(directory, `candidate-${interruptedCandidateRef}`)),
      priorAcceptedMarkerPreserved:
        record.frame.mode === 'persistent' &&
        record.frame.source?.accountId === 'crash-worker-account-a' &&
        record.projectionReceipt?.operationId === record.frame.transactionId &&
        marker.rawContents === JSON.stringify(record.projectionReceipt.marker),
      priorCredentialPresent: (() => {
        const prior =
          record.frame.source?.accountId === 'crash-worker-account-a'
            ? record.frame.source
            : record.cleanupDebts.find(item => item.source.accountId === 'crash-worker-account-a')
                ?.source
        if (!prior || prior.format !== 'v1') return false
        const priorPath = path.join(directory, `candidate-${prior.sourceRef}`)
        try {
          const stored = fs.readFileSync(priorPath, 'utf8')
          return (
            digestSessionAuthoritySource(
              {
                sourceKind: prior.kind,
                sourceRef: prior.sourceRef,
                envKey: prior.envKey,
                accountId: prior.accountId,
              },
              stored
            ) === prior.storedValueDigest
          )
        } catch {
          return false
        }
      })(),
      selectedSourceBytesMatch: (() => {
        const selected = record.frame.source
        if (!selected || selected.format !== 'v1') return selected === null
        const selectedPath = path.join(directory, `candidate-${selected.sourceRef}`)
        try {
          const stored = fs.readFileSync(selectedPath, 'utf8')
          return (
            digestSessionAuthoritySource(
              {
                sourceKind: selected.kind,
                sourceRef: selected.sourceRef,
                envKey: selected.envKey,
                accountId: selected.accountId,
              },
              stored
            ) === selected.storedValueDigest
          )
        } catch {
          return false
        }
      })(),
    })
  )
  process.exit(0)
}
async function acceptPersistent(
  repository,
  accountId,
  storedValue,
  priorSource,
  crashPhase = null
) {
  const state = repository.observe()
  if (state.status !== 'observed') process.exit(67)
  const marker = adapter.observeSessionAuthorityMarkerRaw(scope, userDataDirectory, envKey)
  const journal = adapter.observeSessionAuthorityLegacyJournal(userDataDirectory, envKey)
  if (journal.status !== 'observed') process.exit(68)
  const transactionId = crypto.randomUUID()
  const candidateHash = digest(storedValue)
  const prepared = repository.prepareCandidate(state.snapshot, {
    transactionId,
    candidateHash,
    accountId,
    sourceKind: 'keytar',
    priorSource,
    userDataDirectory,
    externalMarkerObservation: marker,
  })
  if (prepared.status !== 'committed') process.exit(69)
  repository.preflightCandidateAcceptanceCapacity(prepared.snapshot, transactionId, {
    ownerEpoch: 1,
    beforeMarker: marker,
  })
  const candidate = prepared.record.candidates.find(item => item.transactionId === transactionId)
  if (!candidate) process.exit(70)
  const publication = repository.beginCandidatePublication(prepared.snapshot, transactionId)
  if (publication.status !== 'ready') process.exit(71)
  const publicationReceipt = adapter.publishCandidate(
    {
      transactionId,
      candidateHash,
      sourceKind: 'keytar',
      sourceRef: candidate.sourceRef,
      sourceRevision: candidate.sourceRevision,
      envKey,
      accountId,
    },
    storedValue
  )
  const published = await repository.markCandidatePublished(
    publication.snapshot,
    transactionId,
    publicationReceipt,
    publication.lease
  )
  if (published.status !== 'committed') process.exit(72)
  const verified = repository.verifyCandidate(published.snapshot, transactionId)
  if (verified.status !== 'committed') process.exit(73)
  if (crashPhase === 'before-intent') process.exit(71)
  const projection = repository.prepareAcceptanceProjection(verified.snapshot, transactionId, {
    ownerEpoch: 1,
    beforeMarker: marker,
    legacyJournalReceipt: journal.receipt,
  })
  if (projection.result.status !== 'committed') process.exit(75)
  if (crashPhase === 'after-intent') process.exit(72)
  const markerReceipt = repository.publishAcceptanceProjectionMarker(
    projection.result.snapshot,
    transactionId
  )
  if (crashPhase === 'after-marker') process.exit(73)
  const source = projection.result.record.candidates.find(
    item => item.transactionId === transactionId
  )?.publishedSource
  if (!source) process.exit(77)
  const accepted = repository.acceptCandidate(
    projection.result.snapshot,
    transactionId,
    { mode: 'persistent', source, markerIntent: null },
    markerReceipt
  )
  if (accepted.status !== 'committed') process.exit(78)
  if (crashPhase === 'after-persistent-acceptance') process.exit(79)
  return accepted.record.frame.source
}

async function acceptMemoryOnly(repository, accountId, storedValue, priorSource) {
  const state = repository.observe()
  if (state.status !== 'observed') process.exit(82)
  const marker = adapter.observeSessionAuthorityMarkerRaw(scope, userDataDirectory, envKey)
  const journal = adapter.observeSessionAuthorityLegacyJournal(userDataDirectory, envKey)
  if (journal.status !== 'observed') process.exit(83)
  const transactionId = crypto.randomUUID()
  const prepared = repository.prepareCandidate(state.snapshot, {
    transactionId,
    candidateHash: digest(storedValue),
    accountId,
    sourceKind: 'memory-only',
    priorSource,
    userDataDirectory,
    externalMarkerObservation: marker,
  })
  if (prepared.status !== 'committed') process.exit(84)
  const verified = repository.verifyCandidate(prepared.snapshot, transactionId)
  if (verified.status !== 'committed') process.exit(85)
  const projection = repository.prepareAcceptanceProjection(verified.snapshot, transactionId, {
    ownerEpoch: 2,
    beforeMarker: marker,
    legacyJournalReceipt: journal.receipt,
  })
  if (projection.result.status !== 'committed') process.exit(86)
  const markerReceipt = repository.publishAcceptanceProjectionMarker(
    projection.result.snapshot,
    transactionId
  )
  const candidate = projection.result.record.candidates.find(
    item => item.transactionId === transactionId
  )
  if (!candidate?.volatileSessionId) process.exit(89)
  const accepted = repository.acceptCandidate(
    projection.result.snapshot,
    transactionId,
    { mode: 'memory-only', volatileSessionId: candidate.volatileSessionId },
    markerReceipt
  )
  if (accepted.status !== 'committed') process.exit(90)
  process.exit(74)
}

async function produce() {
  const journalProducer = new SessionPersistenceProducer(
    userDataDirectory,
    envKey,
    null,
    () => {},
    () => {},
    true
  )
  journalProducer.prepare('keytar', 'crash-worker-unresolved-journal-candidate')

  const repository = new SessionAuthorityRecordRepository(scope, envKey, adapter, lease)
  const absent = repository.observe()
  if (absent.status !== 'absent') process.exit(65)
  const initialized = repository.initialize(absent.snapshot)
  if (initialized.status !== 'committed') process.exit(66)
  const sourceA = await acceptPersistent(
    repository,
    'crash-worker-account-a',
    'source-a-bytes',
    null
  )
  if (!sourceA) process.exit(79)

  if (phase === 'after-persistent-acceptance') {
    const sourceB = await acceptPersistent(
      repository,
      'crash-worker-account-b',
      'source-b-bytes',
      sourceA,
      'after-persistent-acceptance'
    )
    if (!sourceB) process.exit(80)
    process.exit(81)
  }

  if (phase === 'after-acceptance') {
    await acceptMemoryOnly(
      repository,
      'crash-worker-account-b',
      'crash-worker-memory-candidate',
      sourceA
    )
  } else {
    await acceptPersistent(
      repository,
      'crash-worker-account-b',
      'source-b-candidate-bytes',
      sourceA,
      phase
    )
  }
}

produce().catch(error => {
  const failure = error && typeof error === 'object' ? error : {}
  process.stderr.write(
    JSON.stringify({
      name: typeof failure.name === 'string' ? failure.name : 'unknown',
      code: typeof failure.code === 'string' ? failure.code : null,
      message: typeof failure.message === 'string' ? failure.message.slice(0, 300) : null,
      cause:
        failure.cause && typeof failure.cause.message === 'string'
          ? failure.cause.message.slice(0, 200)
          : null,
    })
  )
  process.exit(92)
})
