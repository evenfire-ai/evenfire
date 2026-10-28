import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  observePendingExternalLogoutRaw,
  stageAcceptancePendingMarker,
} from '../pendingExternalLogout.js'
import {
  SessionAuthorityAcceptanceTransaction,
  SessionAuthorityCandidateTransaction,
  SessionAuthorityLogoutTransaction,
  readAcceptedSessionAuthoritySource,
} from '../sessionAuthorityAcceptance.js'
import {
  PROFILE_SESSION_AUTHORITY_ENV_KEY,
  type SessionAuthorityCandidate,
  type SessionAuthorityCleanupDebt,
  type SessionAuthorityCredentialSource,
  type SessionAuthorityRecord,
  SessionAuthorityRecordCapacityError,
  SessionAuthorityRecordConflictError,
  type SessionAuthorityRecordObservation,
  SessionAuthorityRecordRepository,
  type SessionAuthorityRecordSnapshot,
  canAcceptSessionAuthorityCandidate,
  canRetireSessionAuthorityCleanupDebt,
  digestSessionAuthoritySource,
} from '../sessionAuthorityRecord.js'
import { observeSessionPersistenceLegacySnapshot } from '../sessionPersistenceJournal.js'
import { type SessionAuthorityStorageScope, TokenStore } from '../tokenStore.js'

const authorityFixture = vi.hoisted(() => ({ directory: '', keychain: new Map<string, string>() }))

vi.mock('electron', () => ({
  app: {
    isReady: () => true,
    isPackaged: false,
    getPath: () => authorityFixture.directory,
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => {
      const key = Buffer.alloc(32, 0x61)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
    },
    decryptString: (value: Buffer) => {
      const key = Buffer.alloc(32, 0x61)
      const iv = value.subarray(0, 12)
      const tag = value.subarray(12, 28)
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  },
}))

vi.mock('keytar', () => ({
  getPassword: vi.fn(
    async (_service: string, account: string) => authorityFixture.keychain.get(account) ?? null
  ),
  setPassword: vi.fn(async (_service: string, account: string, value: string) => {
    authorityFixture.keychain.set(account, value)
  }),
  deletePassword: vi.fn(async (_service: string, account: string) =>
    authorityFixture.keychain.delete(account)
  ),
}))

const envKey = 'fixture-0123456789ab'
const token = 'session-authority-test-token-never-persist-this'
let directory: string
let sessionDirectory: string
let authorityStore: TokenStore
let authorityScope: SessionAuthorityStorageScope
const additionalFixtureDirectories: string[] = []

function repository(): SessionAuthorityRecordRepository {
  return new SessionAuthorityRecordRepository(authorityScope, envKey, authorityStore)
}

async function selectProfileSource(
  source: SessionAuthorityCredentialSource,
  authorityRevision: string,
  transactionId: string
): Promise<void> {
  const profileRepository = new SessionAuthorityRecordRepository(
    authorityScope,
    PROFILE_SESSION_AUTHORITY_ENV_KEY,
    authorityStore
  )
  const profile = profileRepository.observeProfileSelection()
  if (profile.status !== 'observed') throw new Error('Expected profile authority observation')
  committed(
    profileRepository.compareAndSetProfileSelection(
      profile.snapshot,
      profile.selection?.revision ?? null,
      {
        revision: randomUUID(),
        state: 'active',
        mode: 'persistent',
        sessionGeneration: (profile.selection?.sessionGeneration ?? 0) + 1,
        envKey,
        userId: source.accountId ?? 'account-fixture',
        teamId: null,
        source,
        authorityRevision,
        transactionId,
        volatileSessionId: null,
      }
    )
  )
}

async function selectAcceptedProfileSource(record: SessionAuthorityRecord): Promise<void> {
  const source = record.frame.source
  const transactionId = record.frame.transactionId
  const receipt = record.projectionReceipt
  if (!source || !transactionId || !receipt)
    throw new Error('Expected an accepted source with a projection receipt')
  await selectProfileSource(source, receipt.baseAuthorityRevision, transactionId)
}

async function signOutProfileSelection(): Promise<void> {
  const profileRepository = new SessionAuthorityRecordRepository(
    authorityScope,
    PROFILE_SESSION_AUTHORITY_ENV_KEY,
    authorityStore
  )
  const profile = profileRepository.observeProfileSelection()
  if (profile.status !== 'observed') throw new Error('Expected profile authority observation')
  committed(
    profileRepository.compareAndSetProfileSelection(
      profile.snapshot,
      profile.selection?.revision ?? null,
      {
        revision: randomUUID(),
        state: 'signed-out',
        mode: 'signed-out',
        sessionGeneration: (profile.selection?.sessionGeneration ?? 0) + 1,
        envKey: null,
        userId: null,
        teamId: null,
        source: null,
        authorityRevision: null,
        transactionId: null,
        volatileSessionId: null,
      }
    )
  )
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
// Repository contract tests exercise the authority CAS input shape. End-to-end logout tests
// produce and verify the external marker through SessionAuthorityLogoutTransaction.
const logoutReceipt = () => ({
  operationId: randomUUID(),
  markerRevision: randomUUID(),
  markerDigest: sha256(randomUUID()),
})
const authorityPath = () => path.join(sessionDirectory, `session-authority-${sha256(envKey)}`)
const recoveryPath = () =>
  path.join(sessionDirectory, `session-authority-recovery-${sha256(envKey)}`)
const mutationPath = () =>
  path.join(sessionDirectory, `session-authority-mutation-${sha256(envKey)}`)

function observed(repo: SessionAuthorityRecordRepository) {
  const result = repo.observe()
  expect(result.status).toBe('observed')
  if (result.status !== 'observed') throw new Error('Expected an observed authority record')
  return result
}

type CandidateSnapshot = {
  record: SessionAuthorityRecord
  snapshot: SessionAuthorityRecordSnapshot
}

type CandidateInput = Parameters<SessionAuthorityRecordRepository['prepareCandidate']>[1]

async function prepareCandidate(
  repo: SessionAuthorityRecordRepository,
  current: CandidateSnapshot,
  input: Omit<
    CandidateInput,
    'priorSource' | 'priorSourceObservation' | 'userDataDirectory' | 'externalMarkerObservation'
  > & {
    priorSource?: SessionAuthorityCredentialSource | null
  }
) {
  const requestedPriorSource = Object.hasOwn(input, 'priorSource')
    ? (input.priorSource ?? null)
    : current.record.frame.source
  const freshAuthenticationAfterLogout =
    input.purpose === 'fresh-authentication' && current.record.frame.mode === 'logged-out'
  const priorSourceObservation =
    current.record.frame.source === null && !freshAuthenticationAfterLogout
      ? await authorityStore.observeLegacySessionCredentialSources(envKey, authorityScope)
      : undefined
  const priorSource =
    priorSourceObservation && requestedPriorSource?.format === 'v0'
      ? (priorSourceObservation.candidates.find(candidate => {
          const observed = candidate.source
          return (
            observed.kind === requestedPriorSource.kind &&
            observed.envKey === requestedPriorSource.envKey &&
            observed.accountId === requestedPriorSource.accountId &&
            observed.sourceRef === requestedPriorSource.sourceRef &&
            observed.sourceRevision === requestedPriorSource.sourceRevision &&
            observed.storedValueDigest === requestedPriorSource.storedValueDigest &&
            JSON.stringify(observed.legacyLocator) ===
              JSON.stringify(requestedPriorSource.legacyLocator)
          )
        })?.source ?? requestedPriorSource)
      : requestedPriorSource
  return repo.prepareCandidate(current.snapshot, {
    ...input,
    userDataDirectory: directory,
    externalMarkerObservation: observePendingExternalLogoutRaw(directory, envKey),
    priorSource,
    ...(priorSourceObservation ? { priorSourceObservation } : {}),
  })
}

function committed<T extends { status: string }>(
  result: T
): asserts result is T & { status: 'committed' } {
  expect(result.status).toBe('committed')
}

async function waitForSignal(promise: Promise<void>, message: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 2_000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function initialize(repo: SessionAuthorityRecordRepository) {
  const result = repo.observe()
  expect(result.status).toBe('absent')
  if (result.status !== 'absent') throw new Error('Expected absent authority state')
  const created = repo.initialize(result.snapshot)
  committed(created)
  return created
}

function sourceFor(
  candidate: { transactionId: string; sourceRef: string; sourceRevision: string },
  value: string,
  kind: 'keytar' | 'safe-storage' = 'keytar'
): Extract<SessionAuthorityCredentialSource, { format: 'v1' }> {
  return {
    kind,
    format: 'v1',
    transactionId: candidate.transactionId,
    envKey,
    accountId: 'account-fixture',
    sourceRef: candidate.sourceRef,
    sourceRevision: candidate.sourceRevision,
    storedValueDigest: digestSessionAuthoritySource(
      {
        sourceKind: kind,
        sourceRef: candidate.sourceRef,
        envKey,
        accountId: 'account-fixture',
      },
      value
    ),
  }
}

async function preparePersistentCandidate(
  repo: SessionAuthorityRecordRepository,
  value: string,
  kind: 'keytar' | 'safe-storage' = 'keytar',
  priorSource?: SessionAuthorityCredentialSource | null
) {
  const current = observed(repo)
  const transactionId = randomUUID()
  const prepared = await prepareCandidate(repo, current, {
    transactionId,
    candidateHash: sha256(value),
    accountId: 'account-fixture',
    sourceKind: kind,
    ...(priorSource !== undefined ? { priorSource } : {}),
  })
  committed(prepared)
  const candidate = prepared.record.candidates.find(item => item.transactionId === transactionId)
  if (!candidate) throw new Error('Prepared candidate is missing')
  const publication = repo.beginCandidatePublication(prepared.snapshot, transactionId)
  if (publication.status !== 'ready') throw new Error('Candidate publication did not start')
  const publicationReceipt = await authorityStore.writeSessionTokenCandidate({
    token: value,
    envKey,
    accountId: 'account-fixture',
    transactionId,
    sourceRef: candidate.sourceRef,
    sourceRevision: candidate.sourceRevision,
    source: kind,
    authorization: publication.authorization,
    publicationLease: publication.lease,
    authorityScope: authorityScope,
  })
  const published = await repo.markCandidatePublished(
    publication.snapshot,
    transactionId,
    publicationReceipt,
    publication.lease
  )
  committed(published)
  const verified = repo.verifyCandidate(published.snapshot, transactionId)
  committed(verified)
  const source = verified.record.candidates.find(
    item => item.transactionId === transactionId
  )?.publishedSource
  if (!source) throw new Error('Published source receipt is missing')
  return { transactionId, source, snapshot: verified.snapshot }
}

async function acceptPersistent(
  repo: SessionAuthorityRecordRepository,
  value: string,
  kind: 'keytar' | 'safe-storage' = 'keytar'
) {
  const candidate = await preparePersistentCandidate(repo, value, kind)
  const accepted = await acceptWithProjection(repo, candidate.snapshot, candidate.transactionId, {
    mode: 'persistent',
    source: candidate.source,
    markerIntent: null,
  })
  committed(accepted)
  await selectAcceptedProfileSource(accepted.record)
  return accepted
}

async function prepareProjection(
  repo: SessionAuthorityRecordRepository,
  snapshot: SessionAuthorityRecordSnapshot,
  transactionId: string
): Promise<SessionAuthorityRecordSnapshot> {
  const beforeMarker = observePendingExternalLogoutRaw(directory, envKey)
  const journal = observeSessionPersistenceLegacySnapshot(
    authorityStore.resolveSessionAuthorityStorageDirectory(authorityScope),
    envKey
  )
  if (journal.status !== 'observed') throw journal.error
  const prepared = repo.prepareAcceptanceProjection(snapshot, transactionId, {
    ownerEpoch: 0,
    beforeMarker,
    legacyJournalReceipt: journal.receipt,
  })
  committed(prepared.result)
  if (!stageAcceptancePendingMarker(directory, envKey, beforeMarker, prepared.stagedMarker))
    throw new Error('Acceptance marker projection was not published')
  return prepared.result.snapshot
}

async function acceptWithProjection(
  repo: SessionAuthorityRecordRepository,
  snapshot: SessionAuthorityRecordSnapshot,
  transactionId: string,
  acceptance: Parameters<SessionAuthorityRecordRepository['acceptCandidate']>[2]
) {
  const projectedSnapshot = await prepareProjection(repo, snapshot, transactionId)
  return repo.acceptCandidate(projectedSnapshot, transactionId, acceptance)
}

function asInvalid(result: SessionAuthorityRecordObservation) {
  expect(result.status).toBe('invalid')
  if (result.status !== 'invalid') throw new Error('Expected invalid authority observation')
  return result
}

beforeEach(async () => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-session-authority-')))
  authorityFixture.directory = directory
  authorityFixture.keychain.clear()
  authorityStore = new TokenStore()
  authorityScope = await authorityStore.createSessionAuthorityStorageScope()
  sessionDirectory = authorityStore.resolveSessionAuthorityStorageDirectory(authorityScope)
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true })
  for (const fixtureDirectory of additionalFixtureDirectories.splice(0))
    fs.rmSync(fixtureDirectory, { recursive: true, force: true })
})

describe('session authority record repository contract', () => {
  it('rejects a storage capability issued by a different TokenStore instance', () => {
    expect(
      () => new SessionAuthorityRecordRepository(authorityScope, envKey, new TokenStore())
    ).toThrow('another TokenStore')
  })

  it('retires a denied candidate only while its exact source write was never authorized', async () => {
    const repo = repository()
    const initial = initialize(repo)
    const transactionId = randomUUID()
    const candidate = await prepareCandidate(repo, initial, {
      transactionId,
      candidateHash: sha256('never-dispatched candidate'),
      accountId: 'account-fixture',
      sourceKind: 'keytar',
    })
    committed(candidate)

    const retired = repo.retireNeverDispatchedCandidate(candidate.snapshot, transactionId)
    committed(retired)
    expect(retired.record.candidates).toEqual([])
    expect(retired.record.latestCandidateTransactionId).toBeNull()
    expect(retired.record.frame.mode).toBe('uninitialized')
  })

  it('fails closed if the authority root permissions change after repository creation', () => {
    const repo = repository()
    const initialized = initialize(repo)
    fs.chmodSync(directory, 0o755)

    expect(repo.observe().status).toBe('invalid')
    expect(() => repo.initialize(initialized.snapshot)).toThrow()
  })

  it('fails closed if the captured authority root is replaced at the same path', () => {
    const repo = repository()
    initialize(repo)
    const movedDirectory = `${directory}-moved`
    additionalFixtureDirectories.push(movedDirectory)
    fs.renameSync(directory, movedDirectory)
    fs.mkdirSync(directory, { mode: 0o700 })
    authorityFixture.directory = directory

    expect(repo.observe().status).toBe('invalid')
  })

  it('initializes absent state as non-authoritative bootstrap, not as an invented logout', () => {
    const repo = repository()
    const initialized = initialize(repo)

    expect(initialized.record.frame.mode).toBe('uninitialized')
    expect(initialized.record.marker).toBeNull()
    expect(initialized.record.frame.denyUnframedSources).toBe(true)
    expect(observed(repo).record).toEqual(initialized.record)
  })

  it('drains an admitted authority transaction and rejects new record writes after quit closes admission', async () => {
    const lease = authorityStore.beginSessionAuthorityTransaction()
    const repo = new SessionAuthorityRecordRepository(authorityScope, envKey, authorityStore, lease)
    let quitFinished = false
    const quit = authorityStore.prepareForQuit().then(() => {
      quitFinished = true
    })

    await Promise.resolve()
    expect(quitFinished).toBe(false)

    const absent = repo.observe()
    expect(absent.status).toBe('absent')
    if (absent.status !== 'absent') throw new Error('Expected absent authority state')
    committed(repo.initialize(absent.snapshot))
    authorityStore.finishSessionAuthorityTransaction(lease)
    await quit
    expect(quitFinished).toBe(true)

    const postQuitRepo = repository()
    const current = observed(postQuitRepo)
    expect(() => postQuitRepo.commitLogout(current.snapshot, null, logoutReceipt())).toThrow(
      'shutting down'
    )

    authorityStore.reopenAdmission()
    const reopened = observed(postQuitRepo)
    committed(postQuitRepo.commitLogout(reopened.snapshot, null, logoutReceipt()))
    expect(observed(postQuitRepo).record.frame.mode).toBe('logged-out')
  })

  it('drains admitted corruption recovery and rejects recovery after quit closes admission', async () => {
    const lease = authorityStore.beginSessionAuthorityTransaction()
    const repo = new SessionAuthorityRecordRepository(authorityScope, envKey, authorityStore, lease)
    const corrupt = '{recovery-admission-fixture'
    fs.writeFileSync(authorityPath(), corrupt, { mode: 0o600 })
    const invalid = asInvalid(repo.observe())
    let quitFinished = false
    const quit = authorityStore.prepareForQuit().then(() => {
      quitFinished = true
    })

    await Promise.resolve()
    expect(quitFinished).toBe(false)
    expect(repo.recoverInvalid(invalid)).toMatch(/[0-9a-f-]{36}/)
    expect(quitFinished).toBe(false)
    authorityStore.finishSessionAuthorityTransaction(lease)
    await quit
    expect(quitFinished).toBe(true)
    expect(observed(repo).record.frame.mode).toBe('logged-out')

    const postQuitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-authority-post-quit-'))
    additionalFixtureDirectories.push(postQuitRoot)
    authorityFixture.directory = postQuitRoot
    const postQuitStore = new TokenStore({ isolatedUserDataPath: postQuitRoot })
    const postQuitScope = await postQuitStore.createSessionAuthorityStorageScope()
    const postQuitRepo = new SessionAuthorityRecordRepository(postQuitScope, envKey, postQuitStore)
    const postQuitFile = path.join(
      postQuitStore.resolveSessionAuthorityStorageDirectory(postQuitScope),
      `session-authority-${sha256(envKey)}`
    )
    fs.writeFileSync(postQuitFile, '{must-remain-unmodified', { mode: 0o600 })
    const postQuitInvalid = asInvalid(postQuitRepo.observe())
    const before = fs.readFileSync(postQuitFile)
    await postQuitStore.prepareForQuit()
    expect(() => postQuitRepo.recoverInvalid(postQuitInvalid)).toThrow('shutting down')
    expect(fs.readFileSync(postQuitFile)).toEqual(before)
    expect(
      fs.existsSync(
        path.join(path.dirname(postQuitFile), `session-authority-recovery-${sha256(envKey)}`)
      )
    ).toBe(false)

    const permissionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evenfire-authority-permissions-'))
    additionalFixtureDirectories.push(permissionRoot)
    authorityFixture.directory = permissionRoot
    const permissionStore = new TokenStore({ isolatedUserDataPath: permissionRoot })
    const permissionScope = await permissionStore.createSessionAuthorityStorageScope()
    const permissionRepo = new SessionAuthorityRecordRepository(
      permissionScope,
      envKey,
      permissionStore
    )
    initialize(permissionRepo)
    const permissionFile = path.join(
      permissionStore.resolveSessionAuthorityStorageDirectory(permissionScope),
      `session-authority-${sha256(envKey)}`
    )
    fs.chmodSync(permissionFile, 0o644)
    const permissionInvalid = asInvalid(permissionRepo.observe())
    await permissionStore.prepareForQuit()
    expect(() => permissionRepo.recoverInvalid(permissionInvalid)).toThrow('shutting down')
    expect(fs.statSync(permissionFile).mode & 0o777).toBe(0o644)
  })

  it('rejects a cleanup-debt permit after a newer authority revision without touching the source', async () => {
    const repo = repository()
    initialize(repo)
    const first = await acceptPersistent(repo, 'first-cleanup-debt-source')
    const firstSource = first.record.frame.source
    if (!firstSource) throw new Error('Expected the first source to be selected')
    const second = await preparePersistentCandidate(
      repo,
      'second-cleanup-debt-source',
      'keytar',
      firstSource
    )
    const acceptedSecond = await acceptWithProjection(repo, second.snapshot, second.transactionId, {
      mode: 'persistent',
      source: second.source,
      markerIntent: null,
    })
    committed(acceptedSecond)
    const acceptedSecondSource = acceptedSecond.record.frame.source
    const acceptedSecondTransactionId = acceptedSecond.record.frame.transactionId
    const acceptedSecondReceipt = acceptedSecond.record.projectionReceipt
    if (!acceptedSecondSource || !acceptedSecondTransactionId || !acceptedSecondReceipt)
      throw new Error('Expected the second accepted profile source')
    await selectProfileSource(
      acceptedSecondSource,
      acceptedSecondReceipt.baseAuthorityRevision,
      acceptedSecondTransactionId
    )
    const debt = acceptedSecond.record.cleanupDebts.find(
      item => item.source.sourceRef === firstSource.sourceRef
    )
    if (!debt) throw new Error('Expected exact old-source cleanup debt')
    const authorization = repo.authorizeCleanupDebt(acceptedSecond.snapshot, debt.id)

    const newer = observed(repo)
    committed(
      await prepareCandidate(repo, newer, {
        transactionId: randomUUID(),
        candidateHash: sha256('newer-denied-memory-candidate'),
        accountId: 'account-fixture',
        sourceKind: 'memory-only',
        volatileSessionId: randomUUID(),
      })
    )
    const selectedOldBytes = authorityFixture.keychain.get(`session-v1:${firstSource.sourceRef}`)
    await expect(
      authorityStore.deleteSessionCredentialSourceIfUnselectedWithProof(
        debt.source,
        authorization,
        authorityScope
      )
    ).rejects.toThrow('exact source permit')
    expect(authorityFixture.keychain.get(`session-v1:${firstSource.sourceRef}`)).toBe(
      selectedOldBytes
    )
  })

  it('rejects a candidate-cleanup permit after its journal revision changes without deleting it', async () => {
    const repo = repository()
    initialize(repo)
    const profileRepository = new SessionAuthorityRecordRepository(
      authorityScope,
      PROFILE_SESSION_AUTHORITY_ENV_KEY,
      authorityStore
    )
    const profileBefore = profileRepository.observe()
    expect(profileBefore.status).toBe('absent')
    if (profileBefore.status !== 'absent') throw new Error('Expected absent profile authority')
    committed(profileRepository.initialize(profileBefore.snapshot))
    const published = await preparePersistentCandidate(repo, 'rejected-candidate-source')
    const claimed = repo.claimRejectedCandidateCleanup(published.snapshot, published.transactionId)
    expect(claimed.status).toBe('claimed')
    if (claimed.status !== 'claimed') throw new Error('Expected a durable candidate cleanup claim')
    const candidate = claimed.record.candidates.find(
      item => item.transactionId === published.transactionId
    )
    if (!candidate) throw new Error('Expected cleanup candidate in journal')
    const storedBefore = authorityFixture.keychain.get(`session-v1:${candidate.sourceRef}`)

    const current = observed(repo)
    committed(
      await prepareCandidate(repo, current, {
        transactionId: randomUUID(),
        candidateHash: sha256('newer-candidate-after-cleanup-claim'),
        accountId: 'account-fixture',
        sourceKind: 'memory-only',
        volatileSessionId: randomUUID(),
      })
    )
    await expect(
      authorityStore.discardUnacceptedSessionTokenCandidate(
        {
          transactionId: candidate.transactionId,
          candidateHash: candidate.candidateHash,
          sourceRef: candidate.sourceRef,
          sourceRevision: candidate.sourceRevision,
          envKey,
          accountId: candidate.accountId,
          source: 'keytar',
        },
        claimed.authorization,
        authorityScope
      )
    ).rejects.toThrow('cleanup permit')
    expect(authorityFixture.keychain.get(`session-v1:${candidate.sourceRef}`)).toBe(storedBefore)
  })

  it('does not treat a missing profile selector as candidate-cleanup authority', async () => {
    const repo = repository()
    initialize(repo)
    const profileRepository = new SessionAuthorityRecordRepository(
      authorityScope,
      PROFILE_SESSION_AUTHORITY_ENV_KEY,
      authorityStore
    )
    expect(profileRepository.observe().status).toBe('absent')

    const published = await preparePersistentCandidate(repo, 'missing-selector-cleanup-source')
    const storedBefore = authorityFixture.keychain.get(`session-v1:${published.source.sourceRef}`)
    expect(repo.claimRejectedCandidateCleanup(published.snapshot, published.transactionId)).toEqual(
      { status: 'superseded' }
    )
    expect(profileRepository.observe().status).toBe('absent')
    expect(authorityFixture.keychain.get(`session-v1:${published.source.sourceRef}`)).toBe(
      storedBefore
    )
  })

  it('rechecks the profile selector before applying a previously issued cleanup permit', async () => {
    const repo = repository()
    initialize(repo)
    const profileRepository = new SessionAuthorityRecordRepository(
      authorityScope,
      PROFILE_SESSION_AUTHORITY_ENV_KEY,
      authorityStore
    )
    const profileBefore = profileRepository.observe()
    expect(profileBefore.status).toBe('absent')
    if (profileBefore.status !== 'absent') throw new Error('Expected absent profile authority')
    committed(profileRepository.initialize(profileBefore.snapshot))

    const published = await preparePersistentCandidate(repo, 'stale-cleanup-permit-source')
    const claim = repo.claimRejectedCandidateCleanup(published.snapshot, published.transactionId)
    expect(claim.status).toBe('claimed')
    if (claim.status !== 'claimed') throw new Error('Expected a cleanup capability')
    const candidate = claim.record.candidates.find(
      item => item.transactionId === published.transactionId
    )
    if (!candidate) throw new Error('Expected the cleanup candidate')
    const storedBefore = authorityFixture.keychain.get(`session-v1:${candidate.sourceRef}`)

    const local = observed(repo)
    await selectProfileSource(published.source, local.record.revision, published.transactionId)
    await expect(
      authorityStore.discardUnacceptedSessionTokenCandidate(
        {
          transactionId: candidate.transactionId,
          candidateHash: candidate.candidateHash,
          sourceRef: candidate.sourceRef,
          sourceRevision: candidate.sourceRevision,
          envKey,
          accountId: candidate.accountId,
          source: 'keytar',
        },
        claim.authorization,
        authorityScope
      )
    ).rejects.toThrow('cleanup permit')
    expect(authorityFixture.keychain.get(`session-v1:${candidate.sourceRef}`)).toBe(storedBefore)
  })

  it('holds native candidate deletion until the final selector recheck', async () => {
    const repo = repository()
    initialize(repo)
    const profileRepository = new SessionAuthorityRecordRepository(
      authorityScope,
      PROFILE_SESSION_AUTHORITY_ENV_KEY,
      authorityStore
    )
    const profileBefore = profileRepository.observe()
    expect(profileBefore.status).toBe('absent')
    if (profileBefore.status !== 'absent') throw new Error('Expected absent profile authority')
    committed(profileRepository.initialize(profileBefore.snapshot))

    const published = await preparePersistentCandidate(repo, 'barrier-stale-cleanup-source')
    const claim = repo.claimRejectedCandidateCleanup(published.snapshot, published.transactionId)
    expect(claim.status).toBe('claimed')
    if (claim.status !== 'claimed') throw new Error('Expected a cleanup capability')
    const candidate = claim.record.candidates.find(
      item => item.transactionId === published.transactionId
    )
    if (!candidate) throw new Error('Expected the cleanup candidate')
    const storedBefore = authorityFixture.keychain.get(`session-v1:${candidate.sourceRef}`)
    const keytar = await import('keytar')
    const account = `session-v1:${candidate.sourceRef}`
    let signalEntered!: () => void
    let releaseBarrier!: () => void
    const entered = new Promise<void>(resolve => {
      signalEntered = resolve
    })
    const release = new Promise<void>(resolve => {
      releaseBarrier = resolve
    })
    let held = false
    vi.spyOn(keytar, 'getPassword').mockImplementation(async (_service, requestedAccount) => {
      if (requestedAccount === account && !held) {
        held = true
        signalEntered()
        await release
      }
      return authorityFixture.keychain.get(requestedAccount) ?? null
    })
    vi.mocked(keytar.deletePassword).mockClear()

    const deletion = authorityStore.discardUnacceptedSessionTokenCandidate(
      {
        transactionId: candidate.transactionId,
        candidateHash: candidate.candidateHash,
        sourceRef: candidate.sourceRef,
        sourceRevision: candidate.sourceRevision,
        envKey,
        accountId: candidate.accountId,
        source: 'keytar',
      },
      claim.authorization,
      authorityScope
    )
    try {
      await waitForSignal(entered, 'Cleanup did not reach the native read barrier')
      const local = observed(repo)
      await selectProfileSource(published.source, local.record.revision, published.transactionId)
    } finally {
      releaseBarrier()
    }

    await expect(deletion).rejects.toThrow('Candidate cleanup authority changed after inspection')
    expect(vi.mocked(keytar.deletePassword)).not.toHaveBeenCalled()
    expect(authorityFixture.keychain.get(account)).toBe(storedBefore)
  })

  it('stores only opaque candidate digests and binds persistent acceptance to the exact source', async () => {
    const repo = repository()
    initialize(repo)
    const accepted = await acceptPersistent(repo, token)
    const bytes = fs.readFileSync(authorityPath(), 'utf8')
    const selected = accepted.record.frame.source
    if (!selected) throw new Error('Persistent source was not selected')
    const stored = authorityFixture.keychain.get(`session-v1:${selected.sourceRef}`)
    if (!stored) throw new Error('Selected Keytar source was not persisted')

    expect(accepted.record.frame.mode).toBe('persistent')
    expect(selected.storedValueDigest).toBe(
      digestSessionAuthoritySource(
        {
          sourceKind: 'keytar',
          sourceRef: selected.sourceRef,
          envKey,
          accountId: 'account-fixture',
        },
        stored
      )
    )
    expect(bytes).not.toContain(token)
    expect(bytes).not.toContain('session-token')
  })

  it('rejects an accepted source whose transaction differs from its authority frame', async () => {
    const repo = repository()
    initialize(repo)
    await acceptPersistent(repo, 'transaction-bound-source')
    const record = JSON.parse(fs.readFileSync(authorityPath(), 'utf8')) as SessionAuthorityRecord
    record.frame.transactionId = randomUUID()
    fs.writeFileSync(authorityPath(), JSON.stringify(record), { mode: 0o600 })

    expect(repo.observe().status).toBe('invalid')
  })

  it('rejects a published candidate whose receipt changes transaction or source revision', async () => {
    const repo = repository()
    initialize(repo)
    const candidate = await preparePersistentCandidate(repo, 'candidate-bound-source')
    const record = JSON.parse(fs.readFileSync(authorityPath(), 'utf8')) as SessionAuthorityRecord
    const storedCandidate = record.candidates.find(
      item => item.transactionId === candidate.transactionId
    )
    if (!storedCandidate?.publishedSource) throw new Error('Published receipt is missing')
    storedCandidate.publishedSource.transactionId = randomUUID()
    fs.writeFileSync(authorityPath(), JSON.stringify(record), { mode: 0o600 })

    expect(repo.observe().status).toBe('invalid')
  })

  it('does not let callers mutate the private record behind an observed CAS snapshot', async () => {
    const repo = repository()
    initialize(repo)
    const accepted = await acceptPersistent(repo, 'selected-before-caller-mutation')
    const observedRecord = observed(repo)
    const selectedSource = accepted.record.frame.source
    if (!selectedSource) throw new Error('Persistent source was not selected')

    observedRecord.record.cleanupDebts.push({
      id: randomUUID(),
      source: selectedSource,
      supersedingFrameRevision: randomUUID(),
    })

    const loggedOut = repo.commitLogout(observedRecord.snapshot, null, logoutReceipt())
    committed(loggedOut)
    expect(loggedOut.record.cleanupDebts).toHaveLength(1)
    expect(loggedOut.record.cleanupDebts[0]?.source).toEqual(selectedSource)
  })

  it('repairs an owned overshared valid record without discarding accepted source or cleanup debt', async () => {
    const repo = repository()
    initialize(repo)
    await acceptPersistent(repo, 'selected-source-before-replacement')
    const accepted = await acceptPersistent(
      repo,
      'selected-source-after-replacement',
      'safe-storage'
    )
    expect(accepted.record.cleanupDebts).toHaveLength(1)
    const acceptedSource = accepted.record.frame.source
    fs.chmodSync(authorityPath(), 0o644)

    const invalid = asInvalid(repo.observe())
    repo.recoverInvalid(invalid)

    const repaired = observed(repo)
    expect(repaired.record.frame.source).toEqual(acceptedSource)
    expect(repaired.record.cleanupDebts).toEqual(accepted.record.cleanupDebts)
    expect(fs.statSync(authorityPath()).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(recoveryPath())).toBe(false)
  })

  it('rejects a caller-supplied source without a TokenStore publication receipt', async () => {
    const repo = repository()
    const initialized = initialize(repo)
    const transactionId = randomUUID()
    const prepared = await prepareCandidate(repo, initialized, {
      transactionId,
      candidateHash: sha256(token),
      accountId: 'account-fixture',
      sourceKind: 'keytar',
    })
    committed(prepared)
    const candidate = prepared.record.candidates[0]!
    const mismatchedSource = {
      ...sourceFor(candidate, token),
      accountId: 'another-account',
    }
    const publication = repo.beginCandidatePublication(prepared.snapshot, transactionId)
    if (publication.status !== 'ready') throw new Error('Candidate publication did not start')

    await expect(
      repo.markCandidatePublished(
        publication.snapshot,
        transactionId,
        mismatchedSource,
        publication.lease
      )
    ).rejects.toThrow('TokenStore durable-write receipt')
    expect(observed(repo).record.frame.mode).toBe('uninitialized')
  })

  it('uses the empty authority frame as verified-none for bootstrap and consumes supplied inventory once', async () => {
    const repo = repository()
    const initialized = initialize(repo)
    const transactionId = randomUUID()
    const input = {
      transactionId,
      candidateHash: sha256('candidate with verified legacy absence'),
      accountId: 'account-fixture',
      sourceKind: 'memory-only' as const,
      userDataDirectory: directory,
      externalMarkerObservation: observePendingExternalLogoutRaw(directory, envKey),
      priorSource: null,
    }

    const bootstrap = repo.prepareCandidate(initialized.snapshot, input)
    committed(bootstrap)
    expect(bootstrap.record.candidates[0]?.priorSource).toBeNull()
    expect(bootstrap.record.frame).toMatchObject({
      mode: 'uninitialized',
      source: null,
      denyUnframedSources: true,
    })

    const inventory = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    expect(inventory.complete).toBe(true)
    expect(
      authorityStore.consumeLegacyPriorSourceObservation(inventory, null, envKey, authorityScope)
    ).toBe(true)
    expect(
      authorityStore.consumeLegacyPriorSourceObservation(inventory, null, envKey, authorityScope)
    ).toBe(false)

    const freshInventory = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    const freshCurrent = observed(repo)
    const prepared = repo.prepareCandidate(freshCurrent.snapshot, {
      ...input,
      transactionId: randomUUID(),
      priorSourceObservation: freshInventory,
    })
    committed(prepared)
    expect(prepared.record.candidates[0]?.priorSource).toBeNull()

    const staleCurrent = observed(repo)
    expect(() =>
      repo.prepareCandidate(staleCurrent.snapshot, {
        ...input,
        transactionId: randomUUID(),
        priorSourceObservation: inventory,
      })
    ).toThrow(SessionAuthorityRecordConflictError)
  })

  it('keeps fresh-auth permission process-local while preserving the strict V1 candidate shape', async () => {
    const repo = repository()
    const initialized = initialize(repo)
    const logout = repo.commitLogout(initialized.snapshot, null, logoutReceipt())
    committed(logout)

    const transactionId = randomUUID()
    const prepared = await prepareCandidate(repo, observed(repo), {
      transactionId,
      candidateHash: sha256('fresh-auth candidate after logout'),
      accountId: 'account-fixture',
      sourceKind: 'memory-only',
      purpose: 'fresh-authentication',
      priorSource: null,
    })
    committed(prepared)
    const verified = repo.verifyCandidate(prepared.snapshot, transactionId)
    committed(verified)
    const candidate = verified.record.candidates.find(item => item.transactionId === transactionId)
    if (!candidate?.volatileSessionId) throw new Error('Fresh volatile candidate is missing')

    const persisted = JSON.parse(fs.readFileSync(authorityPath(), 'utf8')) as {
      candidates: Array<Record<string, unknown>>
    }
    expect(persisted.candidates[0]).not.toHaveProperty('purpose')
    expect(Object.keys(persisted.candidates[0] ?? {}).sort()).toEqual(
      [
        'transactionId',
        'candidateHash',
        'accountId',
        'sourceKind',
        'sourceRef',
        'sourceRevision',
        'observedFrameRevision',
        'observedMarkerRevision',
        'observedExternalMarker',
        'observedLegacyJournal',
        'priorSource',
        'phase',
        'publishedSource',
        'volatileSessionId',
      ].sort()
    )
    const persistedCandidate = persisted.candidates[0]!
    const markerReceipt = persistedCandidate.observedExternalMarker
    expect(['absent', 'legacy-unrevisioned', 'revisioned']).toContain(markerReceipt.kind)
    expect(markerReceipt.digest).toMatch(/^[0-9a-f]{64}$/)
    if (markerReceipt.kind === 'revisioned') {
      expect(markerReceipt.revision).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      )
    } else {
      expect(markerReceipt.revision).toBeNull()
    }
    expect(persistedCandidate.observedLegacyJournal).toMatchObject({
      schemaVersion: expect.any(Number),
      revision: expect.stringMatching(/^v0-sha256:[0-9a-f]{64}$/),
      byteLength: expect.any(Number),
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    })

    const projectedSnapshot = await prepareProjection(repo, verified.snapshot, transactionId)
    const restartedRepository = repository()
    const afterRestart = observed(restartedRepository)
    expect(() =>
      restartedRepository.acceptCandidate(afterRestart.snapshot, transactionId, {
        mode: 'memory-only',
        volatileSessionId: candidate.volatileSessionId!,
      })
    ).toThrow(SessionAuthorityRecordConflictError)

    const accepted = repo.acceptCandidate(projectedSnapshot, transactionId, {
      mode: 'memory-only',
      volatileSessionId: candidate.volatileSessionId,
    })
    committed(accepted)
    expect(accepted.record.frame.mode).toBe('memory-only')
    expect(accepted.record.marker?.intent).toBe('memory-only-session')
  })

  it('pins an exact V0 source and rejects LP paired with a persistent frame', async () => {
    const repo = repository()
    const initialized = initialize(repo)
    authorityFixture.keychain.set('session-token', 'exact active legacy Keytar session')
    const inventory = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    expect(inventory.complete).toBe(true)
    const source = inventory.sources.find(
      candidate => candidate.format === 'v0' && candidate.kind === 'keytar'
    )
    if (!source) throw new Error('Expected an observed legacy Keytar source')
    const pinned = repo.pinVerifiedActiveLegacySource(initialized.snapshot, source, inventory)
    committed(pinned)
    expect(pinned.record.frame.mode).toBe('persistent')
    expect(pinned.record.frame.source).toEqual(source)

    const frame = JSON.parse(fs.readFileSync(authorityPath(), 'utf8'))
    frame.marker = { intent: 'logout-pending', revision: pinned.record.frame.revision }
    fs.writeFileSync(authorityPath(), JSON.stringify(frame), { mode: 0o600 })

    expect(repo.observe().status).toBe('invalid')
  })

  it('never restores a V0 source selected by an old authority frame', async () => {
    const repo = repository()
    const initialized = initialize(repo)
    const legacyToken = 'exact accepted legacy Keytar session'
    authorityFixture.keychain.set('session-token', legacyToken)
    const inventory = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    const source = inventory.sources.find(
      candidate => candidate.format === 'v0' && candidate.kind === 'keytar'
    )
    if (!source) throw new Error('Expected an observed legacy Keytar source')
    const pinned = repo.pinVerifiedActiveLegacySource(initialized.snapshot, source, inventory)
    committed(pinned)

    const accepted = await readAcceptedSessionAuthoritySource({
      tokenStore: authorityStore,
      envKey,
    })
    expect(accepted).toBeNull()
    expect(authorityFixture.keychain.get('session-token')).toBe(legacyToken)
  })

  it('keeps an old V0 record denied without modifying its legacy credential bytes', async () => {
    const priorToken = 'active legacy Keytar session before replacement'
    authorityFixture.keychain.set('session-token', priorToken)
    const repo = repository()
    const initialized = initialize(repo)
    const inventory = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    const source = inventory.sources.find(
      candidate => candidate.format === 'v0' && candidate.kind === 'keytar'
    )
    if (!source) throw new Error('Expected an observed legacy Keytar source')
    committed(repo.pinVerifiedActiveLegacySource(initialized.snapshot, source, inventory))
    const restored = await readAcceptedSessionAuthoritySource({
      tokenStore: authorityStore,
      envKey,
    })
    expect(restored).toBeNull()
    expect(authorityFixture.keychain.get('session-token')).toBe(priorToken)
  })

  it('does not re-read a pinned V0 source during accepted-session restoration', async () => {
    const priorToken = 'pinned legacy Keytar session before a later replacement'
    authorityFixture.keychain.set('session-token', priorToken)
    const repo = repository()
    const initialized = initialize(repo)
    const inventory = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    const source = inventory.sources.find(
      candidate => candidate.format === 'v0' && candidate.kind === 'keytar'
    )
    if (!source) throw new Error('Expected an observed legacy Keytar source')
    const pinned = repo.pinVerifiedActiveLegacySource(initialized.snapshot, source, inventory)
    committed(pinned)

    const restored = await readAcceptedSessionAuthoritySource({
      tokenStore: authorityStore,
      envKey,
    })
    expect(restored).toBeNull()
    expect(authorityFixture.keychain.get('session-token')).toBe(priorToken)
  })

  it('pins an exact V0 secure source as cleanup debt while accepting only the new V1 source', async () => {
    const repo = repository()
    initialize(repo)
    authorityFixture.keychain.set('session-token', 'exact prior raw Keytar value')
    const observedLegacy = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    expect(observedLegacy.complete).toBe(true)
    const priorSource = observedLegacy.sources.find(
      source => source.format === 'v0' && source.kind === 'keytar'
    )
    if (!priorSource) throw new Error('Legacy Keytar source was not observed')
    const candidate = await preparePersistentCandidate(
      repo,
      'versioned exact replacement',
      'keytar',
      priorSource
    )
    const accepted = await acceptWithProjection(repo, candidate.snapshot, candidate.transactionId, {
      mode: 'persistent',
      source: candidate.source,
      markerIntent: null,
    })
    committed(accepted)

    expect(accepted.record.frame.source).toEqual(candidate.source)
    expect(accepted.record.cleanupDebts).toEqual([
      {
        id: expect.any(String),
        source: priorSource,
        supersedingFrameRevision: accepted.record.frame.revision,
      },
    ])
  })

  it('retires observed V0 Keytar debt only after exact source deletion is verified', async () => {
    const repo = repository()
    initialize(repo)
    const legacyValue = 'legacy Keytar bearer that has no V1 authority'
    authorityFixture.keychain.set('session-token', legacyValue)
    const priorObservation = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    expect(priorObservation.complete).toBe(true)
    const priorSource = priorObservation.sources.find(
      source => source.format === 'v0' && source.kind === 'keytar'
    )
    if (!priorSource) throw new Error('Legacy Keytar source was not observed')

    const candidate = await preparePersistentCandidate(
      repo,
      'fresh V1 replacement',
      'keytar',
      priorSource
    )
    const accepted = await acceptWithProjection(repo, candidate.snapshot, candidate.transactionId, {
      mode: 'persistent',
      source: candidate.source,
      markerIntent: null,
    })
    committed(accepted)
    await selectAcceptedProfileSource(accepted.record)
    const debt = accepted.record.cleanupDebts.find(item => item.source.format === 'v0')
    if (!debt) throw new Error('Accepted source change lost exact V0 cleanup debt')

    const cleanup = await authorityStore.deleteSessionCredentialSourceIfUnselectedWithProof(
      debt.source,
      repo.authorizeCleanupDebt(accepted.snapshot, debt.id),
      authorityScope
    )
    expect(cleanup.outcome).toBe('deleted')
    expect(authorityFixture.keychain.has('session-token')).toBe(false)
    const retired = repo.retireCleanupDebt(accepted.snapshot, debt.id, cleanup.proof)
    committed(retired)
    expect(retired.record.cleanupDebts).toEqual([])
  })

  it('re-observes the same exact V0 source identity after restart for debt cleanup', async () => {
    const repo = repository()
    initialize(repo)
    const legacyValue = 'legacy Keytar source that survives process restart'
    authorityFixture.keychain.set('session-token', legacyValue)
    const priorObservation = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    const priorSource = priorObservation.sources.find(
      source => source.format === 'v0' && source.kind === 'keytar'
    )
    if (!priorSource) throw new Error('Legacy Keytar source was not observed')

    const candidate = await preparePersistentCandidate(
      repo,
      'restart-safe replacement',
      'keytar',
      priorSource
    )
    const accepted = await acceptWithProjection(repo, candidate.snapshot, candidate.transactionId, {
      mode: 'persistent',
      source: candidate.source,
      markerIntent: null,
    })
    committed(accepted)
    await selectAcceptedProfileSource(accepted.record)
    const debt = accepted.record.cleanupDebts.find(item => item.source.format === 'v0')
    if (!debt) throw new Error('Accepted source change lost its V0 cleanup debt')

    const restartedStore = new TokenStore()
    const restartedScope = await restartedStore.createSessionAuthorityStorageScope()
    const restartedRepo = new SessionAuthorityRecordRepository(
      restartedScope,
      envKey,
      restartedStore
    )
    const afterRestart = observed(restartedRepo)
    const reobserved = await restartedStore.observeLegacySessionCredentialSources(
      envKey,
      restartedScope
    )
    const reobservedSource = reobserved.sources.find(
      source => source.format === 'v0' && source.kind === 'keytar'
    )

    expect(reobservedSource).toMatchObject({
      sourceRef: debt.source.sourceRef,
      storedValueDigest: debt.source.storedValueDigest,
      legacyLocator: debt.source.legacyLocator,
    })
    if (!reobservedSource || reobservedSource.format !== 'v0')
      throw new Error('Exact V0 source identity was not re-observed after restart')
    expect(
      restartedStore.isObservedLegacySessionCredentialSource(reobservedSource, restartedScope)
    ).toBe(true)

    const cleanup = await restartedStore.deleteSessionCredentialSourceIfUnselectedWithProof(
      reobservedSource,
      restartedRepo.authorizeCleanupDebt(afterRestart.snapshot, debt.id),
      restartedScope
    )
    expect(cleanup.outcome).toBe('deleted')
    committed(restartedRepo.retireCleanupDebt(afterRestart.snapshot, debt.id, cleanup.proof))
    expect(authorityFixture.keychain.has('session-token')).toBe(false)
  })

  it('does not authorize a copied V0 cleanup debt from a different storage root', async () => {
    const repo = repository()
    initialize(repo)
    const legacyValue = 'legacy source copied with authority record to another root'
    authorityFixture.keychain.set('session-token', legacyValue)
    const priorObservation = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    const priorSource = priorObservation.sources.find(
      source => source.format === 'v0' && source.kind === 'keytar'
    )
    if (!priorSource) throw new Error('Legacy Keytar source was not observed')

    const candidate = await preparePersistentCandidate(
      repo,
      'accepted source on original root',
      'keytar',
      priorSource
    )
    const accepted = await acceptWithProjection(repo, candidate.snapshot, candidate.transactionId, {
      mode: 'persistent',
      source: candidate.source,
      markerIntent: null,
    })
    committed(accepted)
    await selectAcceptedProfileSource(accepted.record)
    const debt = accepted.record.cleanupDebts.find(item => item.source.format === 'v0')
    if (!debt) throw new Error('Accepted source change lost its exact V0 cleanup debt')

    const copiedRoot = path.join(os.tmpdir(), `evenfire-session-authority-copy-${randomUUID()}`)
    fs.cpSync(directory, copiedRoot, { recursive: true, errorOnExist: true })
    additionalFixtureDirectories.push(copiedRoot)
    authorityFixture.directory = copiedRoot

    const copiedStore = new TokenStore()
    const copiedScope = await copiedStore.createSessionAuthorityStorageScope()
    const copiedRepo = new SessionAuthorityRecordRepository(copiedScope, envKey, copiedStore)
    const copiedRecord = observed(copiedRepo)
    const copiedDebt = copiedRecord.record.cleanupDebts.find(item => item.id === debt.id)
    expect(copiedDebt).toEqual(debt)
    expect(
      copiedStore.isLegacySessionCredentialSourceBoundToScope(copiedDebt!.source, copiedScope)
    ).toBe(false)
    expect(() => copiedRepo.authorizeCleanupDebt(copiedRecord.snapshot, debt.id)).toThrow(
      'Cleanup authority requires an exact durable unselected source debt'
    )
    expect(authorityFixture.keychain.get('session-token')).toBe(legacyValue)
    expect(observed(copiedRepo).record.cleanupDebts).toContainEqual(debt)
  })

  it('does not let a restarted V0 cleanup receipt delete a changed legacy value', async () => {
    const repo = repository()
    initialize(repo)
    const legacyValue = 'legacy Keytar value owned by an earlier producer'
    authorityFixture.keychain.set('session-token', legacyValue)
    const priorObservation = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    const priorSource = priorObservation.sources.find(
      source => source.format === 'v0' && source.kind === 'keytar'
    )
    if (!priorSource) throw new Error('Legacy Keytar source was not observed')

    const candidate = await preparePersistentCandidate(
      repo,
      'accepted replacement source',
      'keytar',
      priorSource
    )
    const accepted = await acceptWithProjection(repo, candidate.snapshot, candidate.transactionId, {
      mode: 'persistent',
      source: candidate.source,
      markerIntent: null,
    })
    committed(accepted)
    await selectAcceptedProfileSource(accepted.record)
    const debt = accepted.record.cleanupDebts.find(item => item.source.format === 'v0')
    if (!debt) throw new Error('Accepted source change lost its V0 cleanup debt')

    const newerLegacyValue = 'different value published after the cleanup observation'
    authorityFixture.keychain.set('session-token', newerLegacyValue)
    const restartedStore = new TokenStore()
    const restartedScope = await restartedStore.createSessionAuthorityStorageScope()
    const restartedRepo = new SessionAuthorityRecordRepository(
      restartedScope,
      envKey,
      restartedStore
    )
    const afterRestart = observed(restartedRepo)
    const reobserved = await restartedStore.observeLegacySessionCredentialSources(
      envKey,
      restartedScope
    )
    const changedSource = reobserved.sources.find(
      source => source.format === 'v0' && source.kind === 'keytar'
    )
    if (!changedSource || changedSource.format !== 'v0')
      throw new Error('Changed V0 source was not observed after restart')

    expect(changedSource.sourceRef).toBe(debt.source.sourceRef)
    expect(changedSource.storedValueDigest).not.toBe(debt.source.storedValueDigest)
    const cleanup = await restartedStore.deleteSessionCredentialSourceIfUnselectedWithProof(
      debt.source,
      restartedRepo.authorizeCleanupDebt(afterRestart.snapshot, debt.id),
      restartedScope
    )
    expect(cleanup.outcome).toBe('different-value')
    expect(authorityFixture.keychain.get('session-token')).toBe(newerLegacyValue)
    expect(observed(restartedRepo).record.cleanupDebts).toContainEqual(debt)
  })

  it('re-observes an exact V0 safeStorage file after restart before retiring its debt', async () => {
    const repo = repository()
    initialize(repo)
    const file = path.join(directory, `session-token-${envKey}.enc`)
    const legacyCiphertext = Buffer.from('exact legacy encrypted bytes')
    fs.writeFileSync(file, legacyCiphertext, { mode: 0o600 })
    const priorObservation = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    const priorSource = priorObservation.sources.find(
      source => source.format === 'v0' && source.kind === 'safe-storage'
    )
    if (!priorSource) throw new Error('Legacy safeStorage source was not observed')

    const candidate = await preparePersistentCandidate(
      repo,
      'replacement after legacy safeStorage',
      'keytar',
      priorSource
    )
    const accepted = await acceptWithProjection(repo, candidate.snapshot, candidate.transactionId, {
      mode: 'persistent',
      source: candidate.source,
      markerIntent: null,
    })
    committed(accepted)
    await selectAcceptedProfileSource(accepted.record)
    const debt = accepted.record.cleanupDebts.find(item => item.source.format === 'v0')
    if (!debt) throw new Error('Accepted source change lost its legacy safeStorage debt')

    const restartedStore = new TokenStore()
    const restartedScope = await restartedStore.createSessionAuthorityStorageScope()
    const restartedRepo = new SessionAuthorityRecordRepository(
      restartedScope,
      envKey,
      restartedStore
    )
    const afterRestart = observed(restartedRepo)
    const reobserved = await restartedStore.observeLegacySessionCredentialSources(
      envKey,
      restartedScope
    )
    const reobservedSource = reobserved.sources.find(
      source => source.format === 'v0' && source.kind === 'safe-storage'
    )
    expect(reobservedSource).toMatchObject({
      sourceRef: debt.source.sourceRef,
      storedValueDigest: debt.source.storedValueDigest,
    })
    if (!reobservedSource || reobservedSource.format !== 'v0')
      throw new Error('Exact V0 safeStorage source was not re-observed after restart')

    const cleanup = await restartedStore.deleteSessionCredentialSourceIfUnselectedWithProof(
      reobservedSource,
      restartedRepo.authorizeCleanupDebt(afterRestart.snapshot, debt.id),
      restartedScope
    )
    expect(cleanup.outcome).toBe('deleted')
    committed(restartedRepo.retireCleanupDebt(afterRestart.snapshot, debt.id, cleanup.proof))
    expect(fs.existsSync(file)).toBe(false)
  })

  it('retires historical plaintext only as exact denied-source cleanup, never as auth input', async () => {
    const repo = repository()
    initialize(repo)
    const file = path.join(directory, `session-token-${envKey}.json`)
    fs.writeFileSync(file, JSON.stringify({ token: 'fixture-historical bearer material' }), {
      mode: 0o600,
    })
    const priorObservation = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    expect(priorObservation.complete).toBe(true)
    const priorSource = priorObservation.sources.find(
      source => source.format === 'v0' && source.kind === 'historical-plaintext'
    )
    if (!priorSource) throw new Error('Historical plaintext source was not observed')

    const candidate = await preparePersistentCandidate(
      repo,
      'fresh credential',
      'keytar',
      priorSource
    )
    const accepted = await acceptWithProjection(repo, candidate.snapshot, candidate.transactionId, {
      mode: 'persistent',
      source: candidate.source,
      markerIntent: null,
    })
    committed(accepted)
    await selectAcceptedProfileSource(accepted.record)
    const debt = accepted.record.cleanupDebts.find(
      item => item.source.sourceRef === priorSource.sourceRef
    )
    if (!debt) throw new Error('Accepted source change lost exact plaintext cleanup debt')

    const cleanup = await authorityStore.deleteSessionCredentialSourceIfUnselectedWithProof(
      debt.source,
      repo.authorizeCleanupDebt(accepted.snapshot, debt.id),
      authorityScope
    )
    expect(cleanup.outcome).toBe('deleted')
    expect(fs.existsSync(file)).toBe(false)
    const retired = repo.retireCleanupDebt(accepted.snapshot, debt.id, cleanup.proof)
    committed(retired)
    expect(retired.record.cleanupDebts).toEqual([])
  })

  it('does not follow a replaced legacy credential symlink during exact cleanup', async () => {
    const repo = repository()
    initialize(repo)
    const file = path.join(directory, `session-token-${envKey}.enc`)
    const target = path.join(directory, 'unrelated-target.enc')
    const observedValue = Buffer.from('observed legacy safeStorage bytes')
    fs.writeFileSync(file, observedValue, { mode: 0o600 })
    const priorObservation = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    const priorSource = priorObservation.sources.find(
      source => source.format === 'v0' && source.kind === 'safe-storage'
    )
    if (!priorSource) throw new Error('Legacy safeStorage source was not observed')
    const candidate = await preparePersistentCandidate(
      repo,
      'fresh credential',
      'keytar',
      priorSource
    )
    const accepted = await acceptWithProjection(repo, candidate.snapshot, candidate.transactionId, {
      mode: 'persistent',
      source: candidate.source,
      markerIntent: null,
    })
    committed(accepted)
    await selectAcceptedProfileSource(accepted.record)
    const debt = accepted.record.cleanupDebts.find(
      item => item.source.sourceRef === priorSource.sourceRef
    )
    if (!debt) throw new Error('Accepted source change lost exact legacy cleanup debt')

    fs.writeFileSync(target, observedValue, { mode: 0o600 })
    fs.unlinkSync(file)
    fs.symlinkSync(target, file)
    await expect(
      authorityStore.deleteSessionCredentialSourceIfUnselectedWithProof(
        debt.source,
        repo.authorizeCleanupDebt(accepted.snapshot, debt.id),
        authorityScope
      )
    ).rejects.toThrow()
    expect(fs.readFileSync(target)).toEqual(observedValue)
    expect(repo.observe()).toMatchObject({ status: 'observed' })
  })

  it('does not delete a same-named credential when the root changes during a file write', async () => {
    const repo = repository()
    initialize(repo)
    const file = path.join(directory, `session-token-${envKey}.enc`)
    const observedValue = Buffer.from('observed legacy safeStorage bytes')
    fs.writeFileSync(file, observedValue, { mode: 0o600 })
    const observation = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    const priorSource = observation.sources.find(
      source => source.format === 'v0' && source.kind === 'safe-storage'
    )
    if (!priorSource) throw new Error('Legacy safeStorage source was not observed')
    const candidate = await preparePersistentCandidate(
      repo,
      'fresh keytar credential',
      'keytar',
      priorSource
    )
    const accepted = await acceptWithProjection(repo, candidate.snapshot, candidate.transactionId, {
      mode: 'persistent',
      source: candidate.source,
      markerIntent: null,
    })
    committed(accepted)
    await selectAcceptedProfileSource(accepted.record)
    const debt = accepted.record.cleanupDebts.find(
      item => item.source.sourceRef === priorSource.sourceRef
    )
    if (!debt) throw new Error('Accepted source change lost exact cleanup debt')

    let resumeRename!: () => void
    let notifyRenameStarted!: () => void
    const renameGate = new Promise<void>(resolve => {
      resumeRename = resolve
    })
    const renameStarted = new Promise<void>(resolve => {
      notifyRenameStarted = resolve
    })
    const rename = fsPromises.rename.bind(fsPromises)
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === file) {
        notifyRenameStarted()
        await renameGate
      }
      return rename(from, to)
    })

    let delayedWrite: Promise<void> | undefined
    let cleanup: Promise<unknown> | undefined
    let movedRoot: string | undefined
    try {
      delayedWrite = authorityStore.setSafeStorageSessionToken('new safe value', envKey)
      await waitForSignal(renameStarted, 'SafeStorage write did not reach the rename barrier')
      cleanup = authorityStore.deleteSessionCredentialSourceIfUnselectedWithProof(
        debt.source,
        repo.authorizeCleanupDebt(accepted.snapshot, debt.id),
        authorityScope
      )

      movedRoot = `${directory}-replaced`
      additionalFixtureDirectories.push(movedRoot)
      fs.renameSync(directory, movedRoot)
      fs.mkdirSync(directory, { mode: 0o700 })
      fs.writeFileSync(file, observedValue, { mode: 0o600 })
      authorityFixture.directory = directory
      const writeOutcome = expect(delayedWrite).rejects.toThrow()
      const cleanupOutcome = expect(cleanup).rejects.toThrow()
      resumeRename()

      await Promise.all([writeOutcome, cleanupOutcome])
      expect(fs.readFileSync(file)).toEqual(observedValue)
      expect(repo.observe()).toMatchObject({ status: 'invalid' })
    } finally {
      resumeRename()
      await Promise.allSettled([delayedWrite, cleanup].filter(Boolean) as Promise<unknown>[])
    }
  })

  it('preserves a newer legacy value instead of satisfying an older V0 cleanup debt', async () => {
    const repo = repository()
    initialize(repo)
    const file = path.join(directory, `session-token-${envKey}.enc`)
    fs.writeFileSync(file, Buffer.from('observed legacy ciphertext'), { mode: 0o600 })
    const priorObservation = await authorityStore.observeLegacySessionCredentialSources(
      envKey,
      authorityScope
    )
    expect(priorObservation.complete).toBe(true)
    const priorSource = priorObservation.sources.find(
      source => source.format === 'v0' && source.kind === 'safe-storage'
    )
    if (!priorSource) throw new Error('Legacy safeStorage source was not observed')

    const candidate = await preparePersistentCandidate(
      repo,
      'fresh V1 replacement after legacy ciphertext',
      'keytar',
      priorSource
    )
    const accepted = await acceptWithProjection(repo, candidate.snapshot, candidate.transactionId, {
      mode: 'persistent',
      source: candidate.source,
      markerIntent: null,
    })
    committed(accepted)
    await selectAcceptedProfileSource(accepted.record)
    const debt = accepted.record.cleanupDebts.find(item => item.source.format === 'v0')
    if (!debt) throw new Error('Accepted source change lost exact V0 cleanup debt')
    const newerCiphertext = Buffer.from('newer writer ciphertext')
    fs.writeFileSync(file, newerCiphertext, { mode: 0o600 })

    const cleanup = await authorityStore.deleteSessionCredentialSourceIfUnselectedWithProof(
      debt.source,
      repo.authorizeCleanupDebt(accepted.snapshot, debt.id),
      authorityScope
    )
    expect(cleanup.outcome).toBe('different-value')
    expect(cleanup.proof).toBeUndefined()
    expect(fs.readFileSync(file)).toEqual(newerCiphertext)
    expect(observed(repo).record.cleanupDebts).toContainEqual(debt)
  })

  it.each([
    {
      kind: 'keytar' as const,
      legacyLocator: {
        kind: 'keytar-account' as const,
        account: 'session-token::foreign-abcdef123456',
      },
    },
    {
      kind: 'safe-storage' as const,
      legacyLocator: {
        kind: 'safe-storage-file' as const,
        envKey: 'foreign-abcdef123456',
      },
    },
    {
      kind: 'historical-plaintext' as const,
      legacyLocator: {
        kind: 'plaintext-file' as const,
        envKey: 'foreign-abcdef123456',
      },
    },
  ])('rejects a V0 cleanup locator owned by another environment: $kind', async fixture => {
    const repo = repository()
    const initialized = initialize(repo)
    const foreignSourceRef = randomUUID()
    const priorSource: SessionAuthorityCredentialSource = {
      kind: fixture.kind,
      format: 'v0',
      envKey,
      accountId: null,
      sourceRef: foreignSourceRef,
      sourceRevision: null,
      storedValueDigest: digestSessionAuthoritySource(
        {
          sourceKind: fixture.kind,
          sourceRef: foreignSourceRef,
          envKey,
          accountId: null,
        },
        'foreign environment source'
      ),
      legacyLocator: fixture.legacyLocator,
    }

    await expect(
      prepareCandidate(repo, initialized, {
        transactionId: randomUUID(),
        candidateHash: sha256('fresh account-authenticated token'),
        accountId: 'verified-account',
        sourceKind: 'keytar',
        priorSource,
      })
    ).rejects.toThrow()
  })

  it('compares source identity by fields rather than serialized property order', async () => {
    const repo = repository()
    initialize(repo)
    const accepted = await acceptPersistent(repo, 'current-session')
    const source = accepted.record.frame.source
    if (!source) throw new Error('Accepted source is missing')
    if (source.format !== 'v1') throw new Error('Expected a verified V1 source')
    const reorderedSource: SessionAuthorityCredentialSource = {
      storedValueDigest: source.storedValueDigest,
      sourceRevision: source.sourceRevision,
      sourceRef: source.sourceRef,
      accountId: source.accountId,
      envKey: source.envKey,
      format: source.format,
      transactionId: source.transactionId,
      kind: source.kind,
    }

    const prepared = await prepareCandidate(repo, accepted, {
      transactionId: randomUUID(),
      candidateHash: sha256('next-session'),
      accountId: 'account-fixture',
      sourceKind: 'keytar',
      priorSource: reorderedSource,
    })
    committed(prepared)

    expect(prepared.record.candidates[0]?.priorSource).toEqual(source)
  })

  it('accepts volatile authority with a same-revision marker but persists no bearer token', async () => {
    const repo = repository()
    initialize(repo)
    const start = observed(repo)
    const transactionId = randomUUID()
    const prepared = await prepareCandidate(repo, start, {
      transactionId,
      candidateHash: sha256(token),
      accountId: 'account-fixture',
      sourceKind: 'memory-only',
    })
    committed(prepared)
    const verified = repo.verifyCandidate(prepared.snapshot, transactionId)
    committed(verified)
    const candidate = verified.record.candidates.find(item => item.transactionId === transactionId)
    if (!candidate?.volatileSessionId) throw new Error('Volatile candidate has no session id')

    const accepted = await acceptWithProjection(repo, verified.snapshot, transactionId, {
      mode: 'memory-only',
      volatileSessionId: candidate.volatileSessionId,
    })
    committed(accepted)
    const bytes = fs.readFileSync(authorityPath(), 'utf8')

    expect(accepted.record.frame.mode).toBe('memory-only')
    expect(accepted.record.frame.source).toBeNull()
    expect(accepted.record.marker).toEqual({
      intent: 'memory-only-session',
      revision: accepted.record.frame.revision,
      volatileSessionId: candidate.volatileSessionId,
    })
    expect(bytes).not.toContain(token)
    expect(bytes).not.toContain('bearer')
  })

  it('fences a verified older source when a newer memory-only producer is accepted', async () => {
    const repo = repository()
    initialize(repo)
    const older = await preparePersistentCandidate(repo, 'older-persistent-candidate')
    const beforeReplacement = observed(repo)
    const staleReadPermit = repo.authorizeCandidateSourceRead(
      beforeReplacement.snapshot,
      older.transactionId
    )
    const volatileTransactionId = randomUUID()
    const volatileCandidate = await prepareCandidate(repo, beforeReplacement, {
      transactionId: volatileTransactionId,
      candidateHash: sha256('newer-volatile-candidate'),
      accountId: 'account-fixture',
      sourceKind: 'memory-only',
    })
    committed(volatileCandidate)
    const verifiedVolatile = repo.verifyCandidate(volatileCandidate.snapshot, volatileTransactionId)
    committed(verifiedVolatile)
    const volatileSessionId = verifiedVolatile.record.candidates.find(
      item => item.transactionId === volatileTransactionId
    )?.volatileSessionId
    if (!volatileSessionId) throw new Error('New volatile candidate has no lease identity')
    const acceptedVolatile = await acceptWithProjection(
      repo,
      verifiedVolatile.snapshot,
      volatileTransactionId,
      {
        mode: 'memory-only',
        volatileSessionId,
      }
    )
    committed(acceptedVolatile)

    expect(acceptedVolatile.record.frame.mode).toBe('memory-only')
    expect(acceptedVolatile.record.latestCandidateTransactionId).toBeNull()
    expect(() =>
      repo.authorizeCandidateSourceRead(acceptedVolatile.snapshot, older.transactionId)
    ).toThrow(SessionAuthorityRecordConflictError)
    await expect(
      authorityStore.readSessionTokenCandidate(
        older.source,
        older.transactionId,
        staleReadPermit,
        authorityScope
      )
    ).rejects.toThrow()
    expect(
      observed(repo).record.candidates.find(item => item.transactionId === older.transactionId)
    ).toMatchObject({ phase: 'verified' })
  })

  it('rejects a memory marker whose lease identity differs from the authoritative frame', async () => {
    const repo = repository()
    initialize(repo)
    const start = observed(repo)
    const transactionId = randomUUID()
    const prepared = await prepareCandidate(repo, start, {
      transactionId,
      candidateHash: sha256(token),
      accountId: 'account-fixture',
      sourceKind: 'memory-only',
    })
    committed(prepared)
    const verified = repo.verifyCandidate(prepared.snapshot, transactionId)
    committed(verified)
    const candidate = verified.record.candidates.find(item => item.transactionId === transactionId)
    if (!candidate?.volatileSessionId) throw new Error('Volatile candidate has no session id')
    const accepted = await acceptWithProjection(repo, verified.snapshot, transactionId, {
      mode: 'memory-only',
      volatileSessionId: candidate.volatileSessionId,
    })
    committed(accepted)
    const corrupted = JSON.parse(fs.readFileSync(authorityPath(), 'utf8'))
    corrupted.marker.volatileSessionId = randomUUID()
    fs.writeFileSync(authorityPath(), JSON.stringify(corrupted), { mode: 0o600 })

    expect(repo.observe().status).toBe('invalid')
  })

  it('rejects an authority frame that permits unframed legacy credentials', () => {
    const repo = repository()
    initialize(repo)
    const corrupted = JSON.parse(fs.readFileSync(authorityPath(), 'utf8'))
    corrupted.frame.denyUnframedSources = false
    fs.writeFileSync(authorityPath(), JSON.stringify(corrupted), { mode: 0o600 })

    expect(repo.observe().status).toBe('invalid')
  })

  it('rejects a candidate ref that collides with a retained exact cleanup debt', async () => {
    const repo = repository()
    initialize(repo)
    await acceptPersistent(repo, 'old-slot-token')
    const selected = await acceptPersistent(repo, 'current-slot-token', 'safe-storage')
    const debt = selected.record.cleanupDebts[0]
    if (!debt) throw new Error('Expected old-source cleanup debt')

    await expect(
      prepareCandidate(repo, selected, {
        transactionId: randomUUID(),
        candidateHash: sha256('new candidate token'),
        accountId: 'account-fixture',
        sourceKind: 'keytar',
        sourceRef: debt.source.sourceRef,
      })
    ).rejects.toThrow('duplicate candidate source reference')
  })

  it('keeps a concurrent stale candidate durably denied after logout supersedes its frame', async () => {
    const repo = repository()
    const initialized = initialize(repo)
    const transactionId = randomUUID()
    const prepared = await prepareCandidate(repo, initialized, {
      transactionId,
      candidateHash: sha256(token),
      accountId: 'account-fixture',
      sourceKind: 'memory-only',
    })
    committed(prepared)

    const loggedOut = repo.commitLogout(
      prepared.snapshot,
      prepared.record.marker?.revision ?? null,
      logoutReceipt()
    )
    committed(loggedOut)

    const after = observed(repo)
    expect(after.record.frame.mode).toBe('logged-out')
    expect(
      after.record.candidates.find(item => item.transactionId === transactionId)
    ).toMatchObject({
      phase: 'denied',
      candidateHash: sha256(token),
    })
    expect(() =>
      repo.acceptCandidate(after.snapshot, transactionId, {
        mode: 'memory-only',
        volatileSessionId: prepared.record.candidates[0]!.volatileSessionId!,
      })
    ).toThrow(SessionAuthorityRecordConflictError)
  })

  it('commits logout as LP plus exact-source debt before cleanup and survives restart', async () => {
    const repo = repository()
    initialize(repo)
    const accepted = await acceptPersistent(repo, token)
    const loggedOut = repo.commitLogout(
      accepted.snapshot,
      accepted.record.marker?.revision ?? null,
      logoutReceipt()
    )
    committed(loggedOut)
    const restartedStore = new TokenStore()
    const restartedScope = await restartedStore.createSessionAuthorityStorageScope()
    const restarted = new SessionAuthorityRecordRepository(restartedScope, envKey, restartedStore)
    const afterRestart = observed(restarted)

    expect(afterRestart.record.frame.mode).toBe('logged-out')
    expect(afterRestart.record.marker).toEqual({
      intent: 'logout-pending',
      revision: afterRestart.record.frame.revision,
    })
    expect(afterRestart.record.cleanupDebts).toHaveLength(1)
    expect(afterRestart.record.cleanupDebts[0]?.source).toEqual(accepted.record.frame.source)
  })

  it('retires only a cleanup debt whose exact source absence is proven', async () => {
    const repo = repository()
    initialize(repo)
    const first = await acceptPersistent(repo, 'old-session-value')
    const second = await acceptPersistent(repo, 'new-session-value', 'safe-storage')
    const debt = second.record.cleanupDebts[0]
    if (!debt) throw new Error('Source replacement did not retain exact cleanup debt')

    expect(() =>
      repo.retireCleanupDebt(second.snapshot, debt.id, {
        sourceRef: debt.source.sourceRef,
        storedValueDigest: '0'.repeat(64),
        absenceVerified: true,
      })
    ).toThrow('Cleanup completion')
    expect(
      canRetireSessionAuthorityCleanupDebt(second.record.frame.source, debt, {
        ...debt.source,
      })
    ).toBe(true)

    expect(() =>
      repo.retireCleanupDebt(second.snapshot, debt.id, {
        sourceRef: debt.source.sourceRef,
        storedValueDigest: debt.source.storedValueDigest,
        absenceVerified: true,
      })
    ).toThrow('TokenStore proof')
    expect(observed(repo).record.cleanupDebts).toContainEqual(debt)
    expect(first.record.frame.source?.sourceRef).not.toBe(second.record.frame.source?.sourceRef)
  })

  it('does not treat a structurally forged absence object as TokenStore evidence', async () => {
    const repo = repository()
    initialize(repo)
    await acceptPersistent(repo, 'selected-before-logout')
    const logout = observed(repo)
    const committedLogout = repo.commitLogout(
      logout.snapshot,
      logout.record.marker?.revision ?? null,
      logoutReceipt()
    )
    committed(committedLogout)
    const debt = committedLogout.record.cleanupDebts[0]
    if (!debt) throw new Error('Logout did not record exact cleanup debt')

    expect(() =>
      repo.retireCleanupDebt(committedLogout.snapshot, debt.id, {
        sourceRef: debt.source.sourceRef,
        storedValueDigest: debt.source.storedValueDigest,
        absenceVerified: true,
      })
    ).toThrow(/TokenStore|proof|evidence/i)
    expect(observed(repo).record.cleanupDebts).toContainEqual(debt)
  })

  it('does not treat a same-byte file replacement as the observed CAS revision', () => {
    const repo = repository()
    const initialized = initialize(repo)
    const contents = fs.readFileSync(authorityPath(), 'utf8')
    const replacement = `${authorityPath()}.replacement`
    fs.writeFileSync(replacement, contents, { mode: 0o600 })
    fs.renameSync(replacement, authorityPath())

    const result = repo.commitLogout(
      initialized.snapshot,
      initialized.record.marker?.revision ?? null,
      logoutReceipt()
    )

    expect(result.status).toBe('superseded')
    expect(observed(repo).record.revision).toBe(initialized.record.revision)
  })

  it('compares the exact raw CAS bytes separately from the parsed record digest', () => {
    const repo = repository()
    const initialized = initialize(repo)
    const current = JSON.parse(fs.readFileSync(authorityPath(), 'utf8'))
    fs.writeFileSync(authorityPath(), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 })
    const reformatted = observed(repo)

    const result = repo.commitLogout(
      reformatted.snapshot,
      reformatted.record.marker?.revision ?? null,
      logoutReceipt()
    )

    committed(result)
    expect(result.record.frame.mode).toBe('logged-out')
    expect(initialized.record.revision).not.toBe(result.record.revision)
  })

  it('preserves the accepted source when an unprojected repository logout CAS does not publish', async () => {
    const repo = repository()
    initialize(repo)
    const accepted = await acceptPersistent(repo, 'fixture-accepted-before-logout')
    const rename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination) === authorityPath())
        throw Object.assign(new Error('fixture authority rename interrupted'), { code: 'EIO' })
      return rename(source, destination)
    })

    const result = repo.commitLogout(
      accepted.snapshot,
      accepted.record.marker?.revision ?? null,
      logoutReceipt()
    )
    expect(result.status).toBe('superseded')
    expect(repo.observe().status).toBe('observed')
    vi.restoreAllMocks()

    const recovered = observed(repo)
    expect(recovered.record.frame.mode).toBe('persistent')
    expect(recovered.record.frame.source).toEqual(accepted.record.frame.source)
    expect(recovered.record.cleanupDebts).toEqual([])
    expect(recovered.record.logoutReceipt).toBeNull()
  })

  it('completes an interrupted logout only when its exact staged LP survives restart', async () => {
    const repo = repository()
    initialize(repo)
    const accepted = await acceptPersistent(repo, 'fixture-accepted-before-logout')
    const logout = await SessionAuthorityLogoutTransaction.begin({
      tokenStore: authorityStore,
      userDataDirectory: directory,
      envKey,
      expectedToken: 'fixture-accepted-before-logout',
      expectedAuthoritySource: accepted.record.frame.source ?? undefined,
    })
    if (!logout) throw new Error('Expected an accepted session to begin logout')

    const rename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination) === authorityPath())
        throw Object.assign(new Error('fixture logout authority replacement uncertain'), {
          code: 'EIO',
        })
      return rename(source, destination)
    })
    await expect(Promise.resolve().then(() => logout.commit(() => true))).rejects.toBeInstanceOf(
      SessionAuthorityRecordConflictError
    )
    expect(logout.requiresFailClosedAfterLogoutFailure()).toBe(true)
    vi.restoreAllMocks()
    await logout.close()

    const restartedStore = new TokenStore()
    const restartedScope = await restartedStore.createSessionAuthorityStorageScope()
    const restarted = new SessionAuthorityRecordRepository(restartedScope, envKey, restartedStore)
    expect(restarted.observe().status).toBe('recovery-fenced')
    restarted.resumeRecovery()
    await SessionAuthorityAcceptanceTransaction.reconcilePendingAcceptanceProjection(
      restartedStore,
      directory,
      envKey
    )
    const recovered = observed(restarted)
    expect(recovered.record.frame.mode).toBe('logged-out')
    expect(recovered.record.frame.source).toBeNull()
    expect(recovered.record.cleanupDebts.map(debt => debt.source)).toEqual([
      accepted.record.frame.source,
    ])
    expect(
      await readAcceptedSessionAuthoritySource({ tokenStore: restartedStore, envKey })
    ).toBeNull()
  })

  it('re-durably accepts the exact next authority after directory fsync uncertainty', async () => {
    const repo = repository()
    initialize(repo)
    const old = await acceptPersistent(repo, 'fixture-old-accepted-source')
    const candidate = await preparePersistentCandidate(
      repo,
      'fixture-new-candidate',
      'safe-storage'
    )
    const acceptanceSnapshot = await prepareProjection(
      repo,
      candidate.snapshot,
      candidate.transactionId
    )
    const rename = fs.renameSync.bind(fs)
    const fsync = fs.fsyncSync.bind(fs)
    let authorityWasRenamed = false
    let failedDirectorySync = false
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      const result = rename(source, destination)
      if (String(destination) === authorityPath()) authorityWasRenamed = true
      return result
    })
    vi.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
      if (authorityWasRenamed && !failedDirectorySync && fs.fstatSync(descriptor).isDirectory()) {
        failedDirectorySync = true
        throw Object.assign(new Error('fixture authority directory fsync failed'), { code: 'EIO' })
      }
      return fsync(descriptor)
    })

    const result = repo.acceptCandidate(acceptanceSnapshot, candidate.transactionId, {
      mode: 'persistent',
      source: candidate.source,
      markerIntent: null,
    })
    expect(result.status).toBe('committed')
    expect(failedDirectorySync).toBe(true)
    expect(observed(repo).record.frame.source).toEqual(candidate.source)
    expect(observed(repo).record.cleanupDebts.map(debt => debt.source)).toEqual([
      old.record.frame.source,
    ])
    vi.restoreAllMocks()

    const restartedStore = new TokenStore()
    const restartedScope = await restartedStore.createSessionAuthorityStorageScope()
    const restarted = new SessionAuthorityRecordRepository(restartedScope, envKey, restartedStore)
    expect(restarted.observe().status).toBe('observed')
    const recovered = observed(restarted)
    expect(recovered.record.frame.mode).toBe('persistent')
    expect(recovered.record.frame.source).toEqual(candidate.source)
    expect(recovered.record.cleanupDebts.map(debt => debt.source)).toEqual([
      old.record.frame.source,
    ])
    expect(
      recovered.record.candidates.some(item => item.transactionId === candidate.transactionId)
    ).toBe(false)

    await SessionAuthorityAcceptanceTransaction.reconcilePendingAcceptanceProjection(
      restartedStore,
      directory,
      envKey
    )
    // A per-environment CAS alone is not profile-wide acceptance. The old global selection
    // cannot authorize this locally changed frame, so restart fails closed.
    await expect(
      readAcceptedSessionAuthoritySource({ tokenStore: restartedStore, envKey })
    ).rejects.toBeInstanceOf(SessionAuthorityRecordConflictError)
  })

  it('preserves the exact prior authority when an acceptance rename never publishes', async () => {
    const repo = repository()
    initialize(repo)
    const old = await acceptPersistent(repo, 'fixture-prior-accepted-source')
    const candidate = await preparePersistentCandidate(repo, 'fixture-rejected-candidate', 'keytar')
    const acceptanceSnapshot = await prepareProjection(
      repo,
      candidate.snapshot,
      candidate.transactionId
    )
    const rename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination) === authorityPath())
        throw Object.assign(new Error('fixture authority replacement not published'), {
          code: 'EIO',
        })
      return rename(source, destination)
    })

    const interrupted = repo.acceptCandidate(acceptanceSnapshot, candidate.transactionId, {
      mode: 'persistent',
      source: candidate.source,
      markerIntent: null,
    })
    expect(interrupted.status).toBe('superseded')
    expect(repo.observe().status).toBe('observed')
    vi.restoreAllMocks()

    const restartedStore = new TokenStore()
    const restartedScope = await restartedStore.createSessionAuthorityStorageScope()
    const restarted = new SessionAuthorityRecordRepository(restartedScope, envKey, restartedStore)
    await SessionAuthorityAcceptanceTransaction.reconcilePendingAcceptanceProjection(
      restartedStore,
      directory,
      envKey
    )
    const recovered = observed(restarted)
    expect(recovered.record.frame.source).toEqual(old.record.frame.source)
    expect(recovered.record.candidates).toEqual([])
    expect(recovered.record.projectionIntent).toBeNull()
    expect(observePendingExternalLogoutRaw(directory, envKey).rawContents).toBe(
      JSON.stringify(old.record.projectionReceipt?.marker)
    )
    const restored = await readAcceptedSessionAuthoritySource({
      tokenStore: restartedStore,
      envKey,
    })
    expect(restored?.token).toBe('fixture-prior-accepted-source')
    expect(restored?.accepted.record.frame.source).toEqual(old.record.frame.source)
    expect(restored?.accepted.record.frame.source).not.toEqual(candidate.source)
  })

  it('reconciles fence-retirement uncertainty across both restart namespace outcomes', async () => {
    const repo = repository()
    initialize(repo)
    const old = await acceptPersistent(repo, 'fixture-source-before-indeterminate-acceptance')
    const candidate = await preparePersistentCandidate(repo, 'fixture-fence-retirement', 'keytar')
    const acceptanceSnapshot = await prepareProjection(
      repo,
      candidate.snapshot,
      candidate.transactionId
    )
    const fsync = fs.fsyncSync.bind(fs)
    const unlink = fs.unlinkSync.bind(fs)
    let directorySyncs = 0
    let walBeforeUnlink: string | null = null
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (String(file) === mutationPath()) walBeforeUnlink = fs.readFileSync(mutationPath(), 'utf8')
      return unlink(file)
    })
    vi.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
      if (fs.fstatSync(descriptor).isDirectory()) {
        directorySyncs += 1
        if (directorySyncs === 3)
          throw Object.assign(new Error('fixture fence retirement directory fsync failed'), {
            code: 'EIO',
          })
      }
      return fsync(descriptor)
    })

    const result = repo.acceptCandidate(acceptanceSnapshot, candidate.transactionId, {
      mode: 'persistent',
      source: candidate.source,
      markerIntent: null,
    })
    expect(directorySyncs).toBeGreaterThanOrEqual(3)
    expect(result.status).toBe('committed')
    expect(walBeforeUnlink).not.toBeNull()
    expect(observed(repo).record.frame.source).toEqual(candidate.source)
    vi.restoreAllMocks()

    // The authority rename was directory-synced before fence retirement. If the WAL deletion
    // survives restart, the accepted record is durable and can be observed after reconstruction.
    const noWalRestart = repository()
    const acceptedAfterRestart = observed(noWalRestart)
    expect(acceptedAfterRestart.record.frame.source).toEqual(candidate.source)

    // If a crash restores the pre-unlink WAL name, exact next bytes are made durable again before
    // the fence retires, then the accepted projection is reconciled on the new TokenStore.
    fs.writeFileSync(mutationPath(), walBeforeUnlink!, { mode: 0o600 })
    const restartedStore = new TokenStore()
    const restartedScope = await restartedStore.createSessionAuthorityStorageScope()
    const walRestart = new SessionAuthorityRecordRepository(restartedScope, envKey, restartedStore)
    expect(walRestart.observe().status).toBe('recovery-fenced')
    walRestart.resumeRecovery()
    const recovered = observed(walRestart)
    expect(recovered.record.frame.mode).toBe('persistent')
    expect(recovered.record.frame.source).toEqual(candidate.source)
    expect(recovered.record.cleanupDebts.map(debt => debt.source)).toEqual([
      old.record.frame.source,
    ])
    await SessionAuthorityAcceptanceTransaction.reconcilePendingAcceptanceProjection(
      restartedStore,
      directory,
      envKey
    )
    // Recovery proves the local bytes, while the unchanged profile selector must deny them.
    await expect(
      readAcceptedSessionAuthoritySource({ tokenStore: restartedStore, envKey })
    ).rejects.toBeInstanceOf(SessionAuthorityRecordConflictError)
  })

  it('recovers a published candidate at receipt capacity without double-counting its denial', async () => {
    const repo = repository()
    initialize(repo)
    let current = await acceptPersistent(repo, 'fixture-capacity-old-source')
    const priorSource = current.record.frame.source
    if (!priorSource) throw new Error('Accepted source is missing')

    for (let index = 0; index < 126; index += 1) {
      await preparePersistentCandidate(repo, `fixture-capacity-published-${index}`, 'keytar')
      current = observed(repo)
    }

    const candidate = await preparePersistentCandidate(
      repo,
      'fixture-capacity-published-candidate',
      'safe-storage',
      priorSource
    )
    const acceptanceSnapshot = await prepareProjection(
      repo,
      candidate.snapshot,
      candidate.transactionId
    )
    const atCapacity = observed(repo)
    expect(atCapacity.record.candidates).toHaveLength(127)
    expect(atCapacity.record.candidates.length + 1).toBe(128)

    const rename = fs.renameSync.bind(fs)
    const fsync = fs.fsyncSync.bind(fs)
    let authorityWasRenamed = false
    let failedDirectorySync = false
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      const result = rename(source, destination)
      if (String(destination) === authorityPath()) authorityWasRenamed = true
      return result
    })
    vi.spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
      if (authorityWasRenamed && !failedDirectorySync && fs.fstatSync(descriptor).isDirectory()) {
        failedDirectorySync = true
        throw Object.assign(new Error('fixture capacity acceptance directory sync'), {
          code: 'EIO',
        })
      }
      return fsync(descriptor)
    })

    const interrupted = repo.acceptCandidate(acceptanceSnapshot, candidate.transactionId, {
      mode: 'persistent',
      source: candidate.source,
      markerIntent: null,
    })
    expect(interrupted.status).toBe('committed')
    expect(failedDirectorySync).toBe(true)
    vi.restoreAllMocks()
    const interruptedSource = interrupted.record.frame.source
    const interruptedTransactionId = interrupted.record.frame.transactionId
    const interruptedReceipt = interrupted.record.projectionReceipt
    if (!interruptedSource || !interruptedTransactionId || !interruptedReceipt)
      throw new Error('Expected an accepted profile source after capacity recovery')
    await selectProfileSource(
      interruptedSource,
      interruptedReceipt.baseAuthorityRevision,
      interruptedTransactionId
    )

    const restartedStore = new TokenStore()
    const restartedScope = await restartedStore.createSessionAuthorityStorageScope()
    const restarted = new SessionAuthorityRecordRepository(restartedScope, envKey, restartedStore)
    expect(restarted.observe().status).toBe('observed')
    const recovered = observed(restarted)
    expect(recovered.record.frame.mode).toBe('persistent')
    expect(recovered.record.frame.source).toEqual(candidate.source)
    expect(recovered.record.cleanupDebts.map(debt => debt.source)).toEqual([priorSource])
    expect(
      recovered.record.candidates.some(item => item.transactionId === candidate.transactionId)
    ).toBe(false)
    const recoveredSourceRefs = recovered.record.cleanupDebts.map(debt => debt.source.sourceRef)
    expect(new Set(recoveredSourceRefs).size).toBe(recoveredSourceRefs.length)
    expect(recoveredSourceRefs).toContain(priorSource.sourceRef)
    expect(recoveredSourceRefs).not.toContain(candidate.source.sourceRef)
    expect(
      recovered.record.candidates.length + recovered.record.cleanupDebts.length
    ).toBeLessThanOrEqual(128)

    for (const debt of recovered.record.cleanupDebts) {
      const current = observed(restarted)
      const currentDebt = current.record.cleanupDebts.find(item => item.id === debt.id)
      if (!currentDebt) throw new Error('Recovered cleanup debt disappeared before exact cleanup')
      if (currentDebt.source.format !== 'v1')
        throw new Error('Recovered published candidate debt lost its V1 source identity')
      const deletion = await restartedStore.deleteSessionTokenCandidateIfUnselectedWithProof(
        currentDebt.source,
        restarted.authorizeCleanupDebt(current.snapshot, currentDebt.id),
        restartedScope
      )
      expect(deletion.outcome).toBe('deleted')
      if (!deletion.proof) throw new Error('Exact source deletion did not produce absence proof')
      const retired = restarted.retireCleanupDebt(current.snapshot, currentDebt.id, deletion.proof)
      committed(retired)
    }

    expect(observed(restarted).record.cleanupDebts).toEqual([])
  })

  it('supersedes an unpublished memory candidate when a later producer prepares', async () => {
    const repo = repository()
    const initialized = initialize(repo)
    const staleTransaction = randomUUID()
    const stale = await prepareCandidate(repo, initialized, {
      transactionId: staleTransaction,
      candidateHash: sha256('stale candidate'),
      accountId: 'account-fixture',
      sourceKind: 'memory-only',
    })
    committed(stale)

    const winner = await prepareCandidate(repo, stale, {
      transactionId: randomUUID(),
      candidateHash: sha256('newer candidate'),
      accountId: 'account-fixture',
      sourceKind: 'memory-only',
    })
    committed(winner)
    const winningTransaction = winner.record.candidates[0]!.transactionId
    expect(winner.record.candidates).toHaveLength(1)
    expect(winningTransaction).not.toBe(staleTransaction)
    expect(() => repo.verifyCandidate(winner.snapshot, staleTransaction)).toThrow(
      SessionAuthorityRecordConflictError
    )
    const winnerVerified = repo.verifyCandidate(winner.snapshot, winningTransaction)
    committed(winnerVerified)
    const winnerCandidate = winnerVerified.record.candidates[0]!
    const accepted = await acceptWithProjection(
      repo,
      winnerVerified.snapshot,
      winnerCandidate.transactionId,
      {
        mode: 'memory-only',
        volatileSessionId: winnerCandidate.volatileSessionId!,
      }
    )
    committed(accepted)

    const restarted = observed(repository())
    expect(restarted.record.frame.volatileSessionId).toBe(winnerCandidate.volatileSessionId)
    expect(restarted.record.candidates).toEqual([])
  })

  it('reclaims superseded candidates that never received write authority', async () => {
    const repo = repository()
    let current = initialize(repo)
    let previousTransactionId: string | undefined
    for (let index = 0; index < 129; index += 1) {
      const result = await prepareCandidate(repo, current, {
        transactionId: randomUUID(),
        candidateHash: sha256(`denied candidate ${index}`),
        accountId: 'account-fixture',
        sourceKind: 'keytar',
      })
      committed(result)
      current = result
      if (index === 127) previousTransactionId = current.record.candidates[0]?.transactionId
    }

    expect(previousTransactionId).toBeDefined()
    expect(current.record.candidates).toHaveLength(1)
    expect(current.record.candidates[0]?.transactionId).not.toBe(previousTransactionId)
    expect(() => repo.verifyCandidate(current.snapshot, previousTransactionId!)).toThrow(
      SessionAuthorityRecordConflictError
    )
  })

  it('reclaims an abandoned denied candidate after repository restart', async () => {
    const original = repository()
    const initialized = initialize(original)
    const abandonedTransactionId = randomUUID()
    const abandoned = await prepareCandidate(original, initialized, {
      transactionId: abandonedTransactionId,
      candidateHash: sha256('abandoned before source dispatch'),
      accountId: 'account-fixture',
      sourceKind: 'keytar',
    })
    committed(abandoned)

    const restartedStore = new TokenStore()
    const restartedScope = await restartedStore.createSessionAuthorityStorageScope()
    const restarted = new SessionAuthorityRecordRepository(restartedScope, envKey, restartedStore)
    const afterRestart = observed(restarted)
    expect(afterRestart.record.candidates).toEqual([
      expect.objectContaining({
        transactionId: abandonedTransactionId,
        phase: 'denied',
      }),
    ])

    const legacyInventory = await restartedStore.observeLegacySessionCredentialSources(
      envKey,
      restartedScope
    )
    const replacementTransactionId = randomUUID()
    const replacement = await restarted.prepareCandidate(afterRestart.snapshot, {
      transactionId: replacementTransactionId,
      candidateHash: sha256('new producer after restart'),
      accountId: 'account-fixture',
      sourceKind: 'keytar',
      userDataDirectory: directory,
      externalMarkerObservation: observePendingExternalLogoutRaw(directory, envKey),
      priorSource: null,
      priorSourceObservation: legacyInventory,
    })
    committed(replacement)

    expect(replacement.record.candidates.map(candidate => candidate.transactionId)).toEqual([
      replacementTransactionId,
    ])
    expect(() => restarted.verifyCandidate(replacement.snapshot, abandonedTransactionId)).toThrow(
      SessionAuthorityRecordConflictError
    )
    expect(authorityFixture.keychain.size).toBe(0)
  })

  it('never reclaims candidate receipts after write authority may have been used', async () => {
    const repo = repository()
    let current = initialize(repo)
    for (let index = 0; index < 128; index += 1) {
      const transactionId = randomUUID()
      const denied = await prepareCandidate(repo, current, {
        transactionId,
        candidateHash: sha256(`possibly published candidate ${index}`),
        accountId: 'account-fixture',
        sourceKind: 'keytar',
      })
      committed(denied)
      const publication = repo.beginCandidatePublication(denied.snapshot, transactionId)
      expect(publication.status).toBe('ready')
      if (publication.status !== 'ready') throw new Error('Candidate publication did not start')
      current = { record: publication.record, snapshot: publication.snapshot }
      repo.releaseCandidatePublication(transactionId, publication.lease)
    }

    await expect(
      prepareCandidate(repo, current, {
        transactionId: randomUUID(),
        candidateHash: sha256('candidate beyond unresolved publication receipts'),
        accountId: 'account-fixture',
        sourceKind: 'safe-storage',
      })
    ).rejects.toThrow(SessionAuthorityRecordCapacityError)
    expect(observed(repo).record.candidates).toHaveLength(128)
    expect(observed(repo).record.candidates.every(candidate => candidate.phase !== 'denied')).toBe(
      true
    )
  })

  it('bounds superseded unpublished memory candidates across repeated rejected attempts', async () => {
    const repo = repository()
    let current = initialize(repo)
    const staleTransaction = randomUUID()
    for (let index = 0; index < 256; index += 1) {
      const result = await prepareCandidate(repo, current, {
        transactionId: index === 0 ? staleTransaction : randomUUID(),
        candidateHash: sha256(`volatile candidate ${index}`),
        accountId: 'account-fixture',
        sourceKind: 'memory-only',
      })
      committed(result)
      current = result
      expect(current.record.candidates).toHaveLength(1)
    }

    expect(current.record.candidates[0]?.transactionId).not.toBe(staleTransaction)
    expect(() => repo.verifyCandidate(current.snapshot, staleTransaction)).toThrow(
      SessionAuthorityRecordConflictError
    )
  })

  it('rejects structurally forged cleanup claims for a published rejected candidate', async () => {
    const repo = repository()
    initialize(repo)
    const candidate = await preparePersistentCandidate(repo, 'published-but-rejected-candidate')

    expect(() =>
      repo.retireRejectedCandidateAfterCleanup(candidate.snapshot, candidate.transactionId, {
        sourceRef: candidate.source.sourceRef,
        storedValueDigest: sha256('different stored bytes'),
        outcome: 'deleted',
        absenceVerified: true,
      })
    ).toThrow('exact published-source absence')

    expect(() =>
      repo.retireRejectedCandidateAfterCleanup(candidate.snapshot, candidate.transactionId, {
        sourceRef: candidate.source.sourceRef,
        storedValueDigest: candidate.source.storedValueDigest,
        outcome: 'deleted',
        absenceVerified: true,
      })
    ).toThrow('exact published-source absence')
    expect(observed(repo).record.candidates).toHaveLength(1)
  })

  it('reclaims exact logout debt capacity after restart without losing denials', async () => {
    const repo = repository()
    initialize(repo)
    await acceptPersistent(repo, 'selected-before-capacity-pressure')
    for (let index = 0; index < 127; index += 1) {
      await preparePersistentCandidate(
        repo,
        `selected-frame-published-candidate-${index}`,
        'keytar'
      )
    }

    const current = observed(repo)

    await expect(
      prepareCandidate(repo, current, {
        transactionId: randomUUID(),
        candidateHash: sha256('candidate beyond source-denial reserve'),
        accountId: 'account-fixture',
        sourceKind: 'memory-only',
      })
    ).rejects.toThrow(SessionAuthorityRecordCapacityError)

    const loggedOut = repo.commitLogout(
      current.snapshot,
      current.record.marker?.revision ?? null,
      logoutReceipt()
    )
    committed(loggedOut)
    await signOutProfileSelection()
    expect(loggedOut.record.frame.mode).toBe('logged-out')
    expect(loggedOut.record.candidates).toHaveLength(127)
    expect(loggedOut.record.cleanupDebts).toHaveLength(1)
    expect(loggedOut.record.candidates.length + loggedOut.record.cleanupDebts.length).toBe(128)

    const source = loggedOut.record.cleanupDebts[0]?.source
    const debt = loggedOut.record.cleanupDebts[0]
    if (!source || source.format !== 'v1' || !debt)
      throw new Error('Logout did not retain its exact V1 source debt')
    const deletion = await authorityStore.deleteSessionTokenCandidateIfUnselectedWithProof(
      source,
      repo.authorizeCleanupDebt(loggedOut.snapshot, debt.id),
      authorityScope
    )
    expect(deletion.outcome).toBe('deleted')
    const retired = repo.retireCleanupDebt(loggedOut.snapshot, debt.id, deletion.proof)
    committed(retired)

    const restarted = repository()
    const afterRestart = observed(restarted)
    expect(afterRestart.record.cleanupDebts).toEqual([])
    expect(afterRestart.record.candidates).toHaveLength(127)
    const reclaimed = await prepareCandidate(restarted, afterRestart, {
      transactionId: randomUUID(),
      candidateHash: sha256('candidate after exact cleanup retirement'),
      accountId: 'account-fixture',
      sourceKind: 'memory-only',
      purpose: 'fresh-authentication',
    })
    committed(reclaimed)
    expect(reclaimed.record.candidates).toHaveLength(128)
    expect(reclaimed.record.cleanupDebts).toEqual([])
  })

  it('classifies a transient open failure as unknown and leaves the record unchanged', () => {
    const repo = repository()
    const initialized = initialize(repo)
    const before = fs.readFileSync(authorityPath(), 'utf8')
    const originalOpen = fs.openSync.bind(fs)
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]) === authorityPath())
        throw Object.assign(new Error('fixture transient record open'), { code: 'EMFILE' })
      return originalOpen(...args)
    })

    const result = repo.observe()

    expect(result.status).toBe('transient')
    expect(fs.readFileSync(authorityPath(), 'utf8')).toBe(before)
    expect(initialized.record.frame.mode).toBe('uninitialized')
  })

  it('classifies authority replacement during an open-file read as transient', () => {
    const repo = repository()
    initialize(repo)
    const originalReadFile = fs.readFileSync.bind(fs)
    vi.spyOn(fs, 'readFileSync').mockImplementation(
      (...args: Parameters<typeof fs.readFileSync>) => {
        const result = originalReadFile(...args)
        if (typeof args[0] === 'number') fs.appendFileSync(authorityPath(), 'changed-during-read')
        return result
      }
    )

    const result = repo.observe()

    expect(result.status).toBe('transient')
    expect(fs.readFileSync(authorityPath(), 'utf8')).toContain('changed-during-read')
  })

  it('does not reinterpret ENOENT after lstat as a missing authority record', () => {
    const repo = repository()
    initialize(repo)
    const originalOpen = fs.openSync.bind(fs)
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]) === authorityPath()) {
        fs.unlinkSync(authorityPath())
        throw Object.assign(new Error('fixture authority disappeared after inspection'), {
          code: 'ENOENT',
        })
      }
      return originalOpen(...args)
    })

    const result = repo.observe()

    expect(result.status).toBe('transient')
    expect(fs.existsSync(authorityPath())).toBe(false)
  })

  it('rejects an authority file replaced between lstat and open', () => {
    const repo = repository()
    initialize(repo)
    const priorBytes = fs.readFileSync(authorityPath(), 'utf8')
    const replacement = `${authorityPath()}.replacement`
    fs.writeFileSync(replacement, priorBytes, { mode: 0o600 })
    const originalOpen = fs.openSync.bind(fs)
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      if (String(args[0]) === authorityPath()) fs.renameSync(replacement, authorityPath())
      return originalOpen(...args)
    })

    const result = repo.observe()

    expect(result.status).toBe('transient')
    expect(fs.readFileSync(authorityPath(), 'utf8')).toBe(priorBytes)
  })

  it('recovers malformed regular data only behind a durable LP fence and preserves its bytes', () => {
    const repo = repository()
    fs.writeFileSync(authorityPath(), '{malformed-secret-adjacent-bytes', { mode: 0o600 })
    const invalid = asInvalid(repo.observe())

    const recoveryId = repo.recoverInvalid(invalid)
    const recovered = observed(repo)
    const quarantine = recovered.record.quarantines[0]

    expect(recovered.record.frame.mode).toBe('logged-out')
    expect(recovered.record.frame.denyUnframedSources).toBe(true)
    expect(recovered.record.marker).toEqual({
      intent: 'logout-pending',
      revision: recovered.record.frame.revision,
    })
    expect(recovered.record.frame.recoveryId).toBe(recoveryId)
    expect(quarantine?.digest).toBe(sha256('{malformed-secret-adjacent-bytes'))
    expect(fs.readFileSync(path.join(sessionDirectory, quarantine!.locator), 'utf8')).toBe(
      '{malformed-secret-adjacent-bytes'
    )
  })

  it('refuses to treat a valid authority record as malformed input to corruption recovery', () => {
    const repo = repository()
    initialize(repo)
    const valid = observed(repo)
    const forgedObservation = {
      status: 'invalid' as const,
      error: new Error('forged caller observation'),
      rawDigest: sha256(fs.readFileSync(authorityPath(), 'utf8')),
      pathKind: 'regular' as const,
    }

    expect(() => repo.recoverInvalid(forgedObservation)).toThrow('Only an invalid authority record')
    expect(observed(repo).record.revision).toBe(valid.record.revision)
  })

  it('quarantines an oversized regular authority record without following it or reading it as absent', () => {
    const repo = repository()
    const oversized = Buffer.alloc(256 * 1024 + 1, 0x61)
    fs.writeFileSync(authorityPath(), oversized, { mode: 0o600 })
    const invalid = asInvalid(repo.observe())
    expect(invalid.pathKind).toBe('regular')
    expect(invalid.rawDigest).toBeNull()

    repo.recoverInvalid(invalid)

    const recovered = observed(repo)
    expect(recovered.record.frame.mode).toBe('logged-out')
    const quarantine = recovered.record.quarantines[0]
    expect(fs.statSync(path.join(sessionDirectory, quarantine!.locator)).size).toBe(
      oversized.length
    )
  })

  it('recovers an empty malformed record without treating empty bytes as an absent file', () => {
    const repo = repository()
    fs.writeFileSync(authorityPath(), '', { mode: 0o600 })
    const invalid = asInvalid(repo.observe())

    repo.recoverInvalid(invalid)

    const recovered = observed(repo)
    expect(recovered.record.frame.mode).toBe('logged-out')
    expect(fs.existsSync(authorityPath())).toBe(true)
    expect(
      fs.existsSync(
        path.join(
          sessionDirectory,
          `session-authority-corrupt-${recovered.record.frame.recoveryId}`
        )
      )
    ).toBe(true)
  })

  it('recovers a symlink itself without following or modifying its target', () => {
    if (process.platform === 'win32') return
    const repo = repository()
    const target = path.join(directory, 'external-target')
    fs.writeFileSync(target, 'must-not-follow')
    fs.symlinkSync(target, authorityPath())
    const invalid = asInvalid(repo.observe())
    expect(invalid.pathKind).toBe('symlink')

    repo.recoverInvalid(invalid)

    const recovered = observed(repo)
    expect(recovered.record.frame.mode).toBe('logged-out')
    expect(fs.readFileSync(target, 'utf8')).toBe('must-not-follow')
    expect(
      fs
        .lstatSync(path.join(sessionDirectory, recovered.record.quarantines[0]!.locator))
        .isSymbolicLink()
    ).toBe(true)
  })

  it('resumes interrupted corruption recovery after the exact invalid file was quarantined', async () => {
    const repo = repository()
    const corrupt = 'fixture-corrupt-record'
    fs.writeFileSync(authorityPath(), corrupt, { mode: 0o600 })
    const invalid = asInvalid(repo.observe())
    const quarantine = path.join(sessionDirectory, 'session-authority-corrupt-')
    const originalRename = fs.renameSync.bind(fs)
    let interrupted = false
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      const result = originalRename(source, destination)
      if (!interrupted && String(destination).startsWith(quarantine)) {
        interrupted = true
        throw new Error('fixture interruption after quarantine rename')
      }
      return result
    })

    expect(() => repo.recoverInvalid(invalid)).toThrow('fixture interruption')
    const fenced = repo.observe()
    expect(fenced.status).toBe('recovery-fenced')
    if (fenced.status !== 'recovery-fenced') throw new Error('Recovery fence was not retained')
    vi.restoreAllMocks()

    const beforeRejectedResume = fs.readFileSync(recoveryPath())
    await authorityStore.prepareForQuit()
    expect(() => repo.resumeRecovery()).toThrow('shutting down')
    expect(fs.readFileSync(recoveryPath())).toEqual(beforeRejectedResume)
    expect(repo.observe().status).toBe('recovery-fenced')
    authorityStore.reopenAdmission()

    expect(repo.resumeRecovery()).toBe(fenced.recoveryId)
    expect(observed(repo).record.frame.mode).toBe('logged-out')
    expect(
      fs.readFileSync(
        path.join(sessionDirectory, `session-authority-corrupt-${fenced.recoveryId}`),
        'utf8'
      )
    ).toBe(corrupt)
  })

  it('finishes recovery idempotently when LP was written before recovery-fence unlink', () => {
    const repo = repository()
    const corrupt = 'fixture-corrupt-record-before-lp'
    fs.writeFileSync(authorityPath(), corrupt, { mode: 0o600 })
    const invalid = asInvalid(repo.observe())
    const originalUnlink = fs.unlinkSync.bind(fs)
    let interrupted = false
    vi.spyOn(fs, 'unlinkSync').mockImplementation(target => {
      if (String(target) === recoveryPath() && !interrupted && fs.existsSync(authorityPath())) {
        const record = JSON.parse(fs.readFileSync(authorityPath(), 'utf8'))
        if (record.marker?.intent === 'logout-pending') {
          interrupted = true
          throw new Error('fixture interruption after durable LP publication')
        }
      }
      return originalUnlink(target)
    })

    expect(() => repo.recoverInvalid(invalid)).toThrow(
      'fixture interruption after durable LP publication'
    )
    const fenced = repo.observe()
    expect(fenced.status).toBe('recovery-fenced')
    if (fenced.status !== 'recovery-fenced') throw new Error('Recovery fence was not retained')
    vi.restoreAllMocks()

    expect(repo.resumeRecovery()).toBe(fenced.recoveryId)
    const recovered = observed(repo)
    expect(recovered.record.frame.mode).toBe('logged-out')
    expect(recovered.record.frame.recoveryId).toBe(fenced.recoveryId)
    expect(recovered.record.marker?.revision).toBe(recovered.record.frame.revision)
    expect(
      fs.readFileSync(
        path.join(sessionDirectory, `session-authority-corrupt-${fenced.recoveryId}`),
        'utf8'
      )
    ).toBe(corrupt)
  })

  it.each([
    ['malformed mutation fence', '{malformed-mutation-fence', 0o600, false],
    ['overshared mutation fence', '{malformed-mutation-fence', 0o644, false],
    ['unreadable mutation fence', '{unreadable-mutation-fence', 0o600, true],
  ])(
    'fails closed and recovers a %s without losing its selected-source debt',
    async (_, contents, mode, denyOpen) => {
      const repo = repository()
      initialize(repo)
      const accepted = await acceptPersistent(repo, 'selected-source-before-wal-corruption')
      fs.writeFileSync(mutationPath(), contents, { mode })
      if (denyOpen) {
        const open = fs.openSync.bind(fs)
        vi.spyOn(fs, 'openSync').mockImplementation(((target, ...args) => {
          if (String(target) === mutationPath())
            throw Object.assign(new Error('fixture mutation fence access denied'), {
              code: 'EACCES',
            })
          return open(target, ...args)
        }) as typeof fs.openSync)
      }
      const invalid = asInvalid(repo.observe())

      const recoveryId = repo.recoverInvalid(invalid)
      const recovered = observed(repo)

      expect(recovered.record.frame.mode).toBe('logged-out')
      expect(recovered.record.frame.recoveryId).toBe(recoveryId)
      expect(recovered.record.marker?.intent).toBe('logout-pending')
      expect(recovered.record.cleanupDebts.map(debt => debt.source.sourceRef)).toContain(
        accepted.record.frame.source?.sourceRef
      )
      expect(
        fs.readFileSync(
          path.join(sessionDirectory, `session-authority-corrupt-${recoveryId}`),
          'utf8'
        )
      ).toBe(contents)
      expect(fs.existsSync(mutationPath())).toBe(false)
      expect(fs.existsSync(recoveryPath())).toBe(false)
    }
  )

  it('recovers a malformed recovery fence only after persisting LP and the exact selected-source debt', async () => {
    const repo = repository()
    initialize(repo)
    const accepted = await acceptPersistent(
      repo,
      'selected-source-before-recovery-fence-corruption'
    )
    const corruptFence = '{malformed-recovery-fence'
    fs.writeFileSync(recoveryPath(), corruptFence, { mode: 0o600 })
    const invalid = asInvalid(repo.observe())

    const recoveryId = repo.recoverInvalid(invalid)
    const recovered = observed(repo)

    expect(recovered.record.frame.mode).toBe('logged-out')
    expect(recovered.record.frame.recoveryId).toBe(recoveryId)
    expect(recovered.record.cleanupDebts.map(debt => debt.source.sourceRef)).toContain(
      accepted.record.frame.source?.sourceRef
    )
    const quarantine = recovered.record.quarantines.find(item => item.id === recoveryId)
    expect(quarantine).toMatchObject({ digest: sha256(corruptFence) })
    expect(fs.readFileSync(path.join(sessionDirectory, quarantine!.locator), 'utf8')).toBe(
      corruptFence
    )
    expect(fs.existsSync(recoveryPath())).toBe(false)
  })

  it('recovers a permission-denied recovery fence without treating it as absent', async () => {
    const repo = repository()
    initialize(repo)
    const accepted = await acceptPersistent(
      repo,
      'selected-source-before-unreadable-recovery-fence'
    )
    fs.writeFileSync(recoveryPath(), '{unreadable-recovery-fence', { mode: 0o600 })
    const open = fs.openSync.bind(fs)
    vi.spyOn(fs, 'openSync').mockImplementation(((target, ...args) => {
      if (String(target) === recoveryPath())
        throw Object.assign(new Error('fixture recovery fence access denied'), { code: 'EACCES' })
      return open(target, ...args)
    }) as typeof fs.openSync)
    const invalid = asInvalid(repo.observe())

    const recoveryId = repo.recoverInvalid(invalid)
    const recovered = observed(repo)

    expect(recovered.record.frame.mode).toBe('logged-out')
    expect(recovered.record.frame.recoveryId).toBe(recoveryId)
    expect(recovered.record.cleanupDebts.map(debt => debt.source.sourceRef)).toContain(
      accepted.record.frame.source?.sourceRef
    )
    expect(
      fs.existsSync(path.join(sessionDirectory, `session-authority-corrupt-${recoveryId}`))
    ).toBe(true)
  })

  it.each(['recovery', 'mutation'] as const)(
    'retains the deny fence when a corrupt %s fence cannot inspect the authority record',
    async fenceKind => {
      const repo = repository()
      initialize(repo)
      const accepted = await acceptPersistent(repo, `selected-source-before-${fenceKind}-repair`)
      const damagedPath = fenceKind === 'recovery' ? recoveryPath() : mutationPath()
      fs.writeFileSync(
        damagedPath,
        fenceKind === 'recovery' ? '{malformed-recovery-fence' : '{malformed-mutation-fence',
        { mode: 0o600 }
      )

      const open = fs.openSync.bind(fs)
      vi.spyOn(fs, 'openSync').mockImplementation(((file, ...args) => {
        if (String(file) === authorityPath())
          throw Object.assign(new Error('fixture authority inspection denied'), { code: 'EACCES' })
        return open(file, ...args)
      }) as typeof fs.openSync)

      expect(() => repo.recoverInvalid(asInvalid(repo.observe()))).toThrow(
        'Session authority must be inspectable'
      )
      expect(repo.observe().status).toBe(fenceKind === 'mutation' ? 'recovery-fenced' : 'invalid')
      expect(fs.existsSync(damagedPath)).toBe(fenceKind === 'recovery')
      expect(
        fs.readdirSync(sessionDirectory).some(name => name.startsWith('session-authority-corrupt-'))
      ).toBe(fenceKind === 'mutation')
      vi.restoreAllMocks()

      if (fenceKind === 'mutation') repo.resumeRecovery()
      else repo.recoverInvalid(asInvalid(repo.observe()))

      const repaired = observed(repo)
      expect(repaired.record.frame.mode).toBe('logged-out')
      expect(repaired.record.marker?.intent).toBe('logout-pending')
      expect(repaired.record.cleanupDebts.map(debt => debt.source.sourceRef)).toContain(
        accepted.record.frame.source?.sourceRef
      )
    }
  )

  it('repairs an invalid authority after quarantining its malformed recovery fence', () => {
    const repo = repository()
    const invalidAuthority = '{malformed-authority'
    const invalidRecoveryFence = '{malformed-recovery-fence'
    fs.writeFileSync(authorityPath(), invalidAuthority, { mode: 0o600 })
    fs.writeFileSync(recoveryPath(), invalidRecoveryFence, { mode: 0o600 })

    repo.recoverInvalid(asInvalid(repo.observe()))
    const repaired = observed(repo)

    expect(repaired.record.frame.mode).toBe('logged-out')
    expect(
      fs.readdirSync(sessionDirectory).some(name => name.startsWith('session-authority-corrupt-'))
    ).toBe(true)
    expect(fs.existsSync(recoveryPath())).toBe(false)
  })

  it('resumes recovery-fence repair idempotently after LP publication but before quarantine rename', async () => {
    const repo = repository()
    initialize(repo)
    await acceptPersistent(repo, 'selected-source-before-recovery-repair-interruption')
    fs.writeFileSync(recoveryPath(), '{malformed-recovery-fence', { mode: 0o600 })
    const rename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (
        String(source) === recoveryPath() &&
        String(destination).includes('session-authority-corrupt-')
      )
        throw Object.assign(new Error('fixture interrupted after LP publication'), { code: 'EIO' })
      return rename(source, destination)
    })

    expect(() => repo.recoverInvalid(asInvalid(repo.observe()))).toThrow(
      'fixture interrupted after LP publication'
    )
    const published = JSON.parse(fs.readFileSync(authorityPath(), 'utf8'))
    const recoveryId = published.frame.recoveryId as string
    vi.restoreAllMocks()

    repo.recoverInvalid(asInvalid(repo.observe()))
    const recovered = observed(repo)

    expect(recovered.record.frame.mode).toBe('logged-out')
    expect(recovered.record.frame.recoveryId).toBe(recoveryId)
    expect(recovered.record.quarantines).toHaveLength(1)
    expect(
      fs.existsSync(path.join(sessionDirectory, `session-authority-corrupt-${recoveryId}`))
    ).toBe(true)
    expect(fs.existsSync(recoveryPath())).toBe(false)
  })

  it('proves debt retirement is exact and cannot retire the currently selected source', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.string(),
        fc.string(),
        (sourceRef, sourceRevision, payload, wrongSourceRef) => {
          const source: SessionAuthorityCredentialSource = {
            kind: 'keytar',
            format: 'v1',
            transactionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            envKey,
            accountId: 'property-account',
            sourceRef,
            sourceRevision,
            storedValueDigest: digestSessionAuthoritySource(
              {
                sourceKind: 'keytar',
                sourceRef,
                envKey,
                accountId: 'property-account',
              },
              payload
            ),
          }
          const debt: SessionAuthorityCleanupDebt = {
            id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            source,
            supersedingFrameRevision: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          }
          expect(canRetireSessionAuthorityCleanupDebt(source, debt, source)).toBe(false)
          expect(canRetireSessionAuthorityCleanupDebt(null, debt, source)).toBe(true)
          const wrongSource = { ...source, sourceRef: wrongSourceRef }
          expect(canRetireSessionAuthorityCleanupDebt(null, debt, wrongSource)).toBe(
            wrongSourceRef === sourceRef
          )
          const alternateRevision = sourceRevision.endsWith('0')
            ? `${sourceRevision.slice(0, -1)}1`
            : `${sourceRevision.slice(0, -1)}0`
          const wrongRevision = { ...source, sourceRevision: alternateRevision }
          expect(canRetireSessionAuthorityCleanupDebt(null, debt, wrongRevision)).toBe(false)
        }
      ),
      { numRuns: 10_000 }
    )
  })

  it('property-checks current-frame ownership, denial dominance and cleanup-source reservation', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        fc.uuid(),
        (frameRevision, tx, selectedRef, nextRef) => {
          fc.pre(selectedRef !== nextRef)
          const nextRevision = randomUUID()
          const selected = sourceFor(
            { transactionId: randomUUID(), sourceRef: selectedRef, sourceRevision: randomUUID() },
            'selected-session'
          )
          const candidate: SessionAuthorityCandidate = {
            transactionId: tx,
            candidateHash: sha256(`candidate-${tx}`),
            accountId: 'account-fixture',
            sourceKind: 'keytar',
            sourceRef: nextRef,
            sourceRevision: nextRevision,
            observedFrameRevision: frameRevision,
            observedMarkerRevision: null,
            priorSource: selected,
            phase: 'verified',
            publishedSource: sourceFor(
              { transactionId: tx, sourceRef: nextRef, sourceRevision: nextRevision },
              `candidate-${tx}`
            ),
            volatileSessionId: null,
          }
          const record: SessionAuthorityRecord = {
            version: 1,
            envKey,
            revision: randomUUID(),
            marker: null,
            latestCandidateTransactionId: tx,
            frame: {
              revision: frameRevision,
              envKey,
              mode: 'persistent',
              transactionId: selected.transactionId,
              source: selected,
              volatileSessionId: null,
              denyUnframedSources: true,
              recoveryId: null,
            },
            candidates: [candidate],
            cleanupDebts: [],
            quarantines: [],
          }

          expect(canAcceptSessionAuthorityCandidate(record, tx)).toBe(true)
          expect(
            canAcceptSessionAuthorityCandidate(
              { ...record, candidates: [{ ...candidate, phase: 'denied' }] },
              tx
            )
          ).toBe(false)
          expect(
            canAcceptSessionAuthorityCandidate(
              {
                ...record,
                frame: { ...record.frame, revision: randomUUID() },
              },
              tx
            )
          ).toBe(false)
          expect(
            canAcceptSessionAuthorityCandidate(
              {
                ...record,
                cleanupDebts: [
                  {
                    id: randomUUID(),
                    source: candidate.publishedSource!,
                    supersedingFrameRevision: randomUUID(),
                  },
                ],
              },
              tx
            )
          ).toBe(false)
          expect(
            canAcceptSessionAuthorityCandidate(
              {
                ...record,
                frame: {
                  ...record.frame,
                  source: sourceFor(
                    {
                      transactionId: randomUUID(),
                      sourceRef: randomUUID(),
                      sourceRevision: randomUUID(),
                    },
                    'newer-selected-session'
                  ),
                },
              },
              tx
            )
          ).toBe(false)
        }
      ),
      { numRuns: 1000 }
    )
  })
})
