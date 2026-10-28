import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getActiveEnvKey } from '../config.js'
import { ApiError } from '../httpClient.js'
import {
  readPendingExternalLogoutMarker,
  recordPendingKeytarCleanupIfMissing,
} from '../pendingExternalLogout.js'
import { SessionAuthorityCoordinator } from '../sessionAuthorityCoordinator.js'
import { SessionCredentialSourceObservationError } from '../sessionCredentialSource.js'
import {
  readSessionPersistenceJournal,
  sessionPersistenceCandidateHash,
} from '../sessionPersistenceJournal.js'
import { SessionTokenStorageSupersededBeforeWriteError, TokenStore } from '../tokenStore.js'
import type { SessionMe } from '../types.js'

const fixture = vi.hoisted(() => ({ directory: '', keychain: new Map<string, string>() }))
vi.mock('electron', () => ({
  app: { getPath: () => fixture.directory, isReady: () => true },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (token: string) => Buffer.from(`encrypted:${token}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length),
  },
}))
vi.mock('keytar', () => ({
  getPassword: vi.fn(
    async (_service: string, account: string) => fixture.keychain.get(account) ?? null
  ),
  setPassword: vi.fn(async (_service: string, account: string, token: string) => {
    fixture.keychain.set(account, token)
  }),
  deletePassword: vi.fn(async (_service: string, account: string) =>
    fixture.keychain.delete(account)
  ),
}))

beforeEach(async () => {
  fixture.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'session-authority-coordinator-'))
  fixture.keychain.clear()
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked((await import('electron')).safeStorage.isEncryptionAvailable).mockReturnValue(true)
  await fs.rm(fixture.directory, { recursive: true, force: true })
})

const coordinator = new SessionAuthorityCoordinator({
  getTokenStore: () => new TokenStore(),
  getUserDataDirectory: () => fixture.directory,
  reportDeferredLogoutFailure: () => {},
  failClosedForPendingLogout: async () => {},
})

const marker = (
  intent:
    | { intent: 'logout-pending' }
    | { intent: 'memory-only-session'; volatileSessionId: string }
    | {
        intent: 'keytar-cleanup-pending'
        credentialSource: 'active-keytar' | 'safe-storage'
      }
) => ({ intent, revision: '00000000-0000-4000-8000-000000000001' })

describe('SessionAuthorityCoordinator source decisions', () => {
  it('passes its captured legacy namespace result into the candidate transaction', async () => {
    const store = new TokenStore()
    const envKey = getActiveEnvKey()
    const config = await import('../config.js')
    vi.spyOn(config, 'getActiveLegacyEnvKeyInventory').mockReturnValue({
      keys: [],
      complete: true,
    })
    const authority = new SessionAuthorityCoordinator({
      getTokenStore: () => store,
      getUserDataDirectory: () => fixture.directory,
      reportDeferredLogoutFailure: () => {},
      failClosedForPendingLogout: async () => {},
    })
    const plan = await authority.planFreshSessionAcceptance({
      envKey,
      token: 'fixture-plan-transaction-token',
      authenticatedAt: Date.now(),
      pendingLogout: {
        intent: null,
        marker: null,
        writeAction: { kind: 'secure-preferred' },
        retireMarker: false,
        credentialSource: null,
        allowMemoryOnlyFallback: true,
      },
      legacyEnvKeys: [],
    })

    expect(plan.legacyNamespaceComplete).toBe(true)
    const { SessionAuthorityAcceptanceTransaction } =
      await import('../sessionAuthorityAcceptance.js')
    const transaction = await SessionAuthorityAcceptanceTransaction.begin({
      tokenStore: store,
      userDataDirectory: fixture.directory,
      envKey,
      legacyEnvKeys: plan.legacyEnvKeys,
      legacyNamespaceComplete: plan.legacyNamespaceComplete,
      token: plan.token,
      accountId: 'fixture-plan-owner',
      source: plan.source,
      purpose: plan.purpose,
      priorToken: plan.priorToken,
      expectedAuthorityRevision: plan.authorityRevision,
      ownerEpoch: plan.generation,
    })
    try {
      await transaction.reject()
    } finally {
      await transaction.close()
    }
  })

  it('does not treat an expired temporary owner as current during fresh-login rollback', async () => {
    const clock = { now: Date.now() }
    vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
    const store = new TokenStore()
    const envKey = getActiveEnvKey()
    const authority = new SessionAuthorityCoordinator({
      getTokenStore: () => store,
      getUserDataDirectory: () => fixture.directory,
      reportDeferredLogoutFailure: () => {},
      failClosedForPendingLogout: async () => {},
    })
    const owner = {
      id: 'fixture-expiring-owner',
      email: 'expiring@example.test',
      name: null,
      picture: null,
      teamId: null,
      teamName: null,
      role: 'member' as const,
    }
    const volatileSessionId = 'fixture-expiring-lease'
    authority.sessionToken = 'fixture-expiring-token'
    authority.me = owner
    authority.memoryOnlySession = {
      envKey,
      volatileSessionId,
      marker: marker({ intent: 'memory-only-session', volatileSessionId }),
      expiresAt: clock.now + 60_000,
    }

    const plan = await authority.planFreshSessionAcceptance({
      envKey,
      token: 'fixture-new-login-token',
      authenticatedAt: Date.now(),
      pendingLogout: {
        intent: null,
        marker: null,
        writeAction: { kind: 'secure-preferred' },
        retireMarker: false,
        credentialSource: null,
        allowMemoryOnlyFallback: true,
      },
      legacyEnvKeys: [],
    })
    expect(authority.isFreshSessionAcceptanceRuntimeOwnerCurrent(plan, false)).toBe(true)
    clock.now += 60_001
    expect(authority.isFreshSessionAcceptanceRuntimeOwnerCurrent(plan, false)).toBe(false)
    expect(authority.isFreshSessionAcceptanceRuntimeOwnerUnchanged(plan, false)).toBe(true)
  })

  it('does not read or migrate a secure credential from the historical namespace', async () => {
    const store = new TokenStore()
    const envKey = getActiveEnvKey()
    const legacyEnvKey = 'legacy-222222222222'
    const legacyAccount = `session-token::${legacyEnvKey}`
    fixture.keychain.set(legacyAccount, 'fixture-verified-legacy-keytar')
    const authority = new SessionAuthorityCoordinator({
      getTokenStore: () => store,
      getUserDataDirectory: () => fixture.directory,
      reportDeferredLogoutFailure: () => {},
      failClosedForPendingLogout: async () => {},
    })
    const onTokenRead = vi.fn()

    await expect(
      authority.readPreferredSessionToken(envKey, {
        legacyEnvKeys: [legacyEnvKey],
        onTokenRead,
      })
    ).resolves.toBeNull()

    expect(fixture.keychain.has(legacyAccount)).toBe(true)
    expect(fixture.keychain.has(`session-token::${envKey}`)).toBe(false)
    expect(onTokenRead).not.toHaveBeenCalled()
  })

  it('does not automatically restore historical plaintext from a legacy alias', async () => {
    const store = new TokenStore()
    const envKey = getActiveEnvKey()
    const legacyEnvKey = 'legacy-222222222222'
    const legacyPlaintextPath = path.join(fixture.directory, `session-token-${legacyEnvKey}.json`)
    await fs.writeFile(legacyPlaintextPath, JSON.stringify({ token: 'fixture-old-plain-token' }), {
      mode: 0o600,
    })
    const authority = new SessionAuthorityCoordinator({
      getTokenStore: () => store,
      getUserDataDirectory: () => fixture.directory,
      reportDeferredLogoutFailure: () => {},
      failClosedForPendingLogout: async () => {},
    })
    const onTokenRead = vi.fn()

    await expect(
      authority.readPreferredSessionToken(envKey, {
        legacyEnvKeys: [legacyEnvKey],
        onTokenRead,
      })
    ).resolves.toBeNull()

    expect(onTokenRead).not.toHaveBeenCalled()
    expect(fixture.keychain.get(`session-token::${envKey}`)).toBeUndefined()
    await expect(fs.readFile(legacyPlaintextPath, 'utf8')).resolves.toContain(
      'fixture-old-plain-token'
    )
  })

  it('centralizes logout, pending-cleanup, and rejected-login source outcomes', () => {
    const pending = marker({ intent: 'logout-pending' })
    const safeCleanup = marker({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    const memory = marker({ intent: 'memory-only-session', volatileSessionId: 'volatile-id' })

    expect(coordinator.planLogoutStart(memory)).toEqual({
      kind: 'retain-memory-only-denial',
      marker: memory,
    })
    expect(coordinator.planLogoutStart(safeCleanup)).toMatchObject({
      kind: 'upgrade-cleanup-marker',
      cas: { expected: safeCleanup, next: { intent: { intent: 'logout-pending' } } },
    })
    expect(coordinator.planPendingLogoutApplication(safeCleanup)).toEqual({ kind: 'none' })
    expect(coordinator.planPendingLogoutApplication(memory)).toEqual({
      kind: 'none',
    })
    expect(
      coordinator.planRejectedLoginPriorSourceRead({
        marker: safeCleanup,
        freshTokenUsesSafeStorageOnly: false,
      })
    ).toBe('safe-storage')
    expect(
      coordinator.planRejectedLoginPriorSourceRead({
        marker: pending,
        freshTokenUsesSafeStorageOnly: true,
      })
    ).toBe('safe-storage')
    expect(
      coordinator.planRejectedLoginPriorSourceRead({
        marker: null,
        freshTokenUsesSafeStorageOnly: true,
      })
    ).toBe('default')
    expect(
      coordinator.planLogoutAfterCleanup({
        marker: pending,
        markerInspectionFailed: false,
        clearCompleted: true,
        journalDisposition: 'retired',
      })
    ).toEqual({ kind: 'retire-journal-and-marker', marker: pending })
    expect(
      coordinator.planLogoutAfterCleanup({
        marker: null,
        markerInspectionFailed: false,
        clearCompleted: false,
        journalDisposition: 'unavailable',
      })
    ).toEqual({ kind: 'ensure-logout-intent', expectedMarker: null })
    expect(coordinator.planLogoutFailureMarker(pending, pending)).toEqual({
      kind: 'preserve-existing-logout-intent',
      marker: pending,
    })
    expect(coordinator.planLogoutFailureMarker(null, null)).toEqual({
      kind: 'write-logout-intent',
    })
    expect(coordinator.planLogoutFailureMarker(null, pending)).toEqual({ kind: 'superseded' })
    expect(coordinator.planMarkerRetirementFailure(safeCleanup, null)).toMatchObject({
      kind: 'restore-cleanup-if-missing',
      next: { intent: safeCleanup.intent },
    })
    expect(coordinator.planMarkerRetirementFailure(safeCleanup, safeCleanup)).toEqual({
      kind: 'preserve',
      marker: safeCleanup,
    })
    const newer = marker({ intent: 'logout-pending' })
    expect(coordinator.planMarkerRetirementFailure(safeCleanup, newer)).toEqual({
      kind: 'preserve',
      marker: newer,
    })
  })

  it('allows strict-marker retirement after an explicit isolated-development login', async () => {
    vi.mocked((await import('electron')).safeStorage.isEncryptionAvailable).mockReturnValue(false)
    const store = new TokenStore({ isolatedUserDataPath: fixture.directory })
    const envKey = getActiveEnvKey()
    await store.setSessionToken('explicit-development-login', envKey)
    const authority = new SessionAuthorityCoordinator({
      getTokenStore: () => store,
      getUserDataDirectory: () => fixture.directory,
      reportDeferredLogoutFailure: () => {},
      failClosedForPendingLogout: async () => {},
    })
    const acceptedSource = await authority.readVerifiedSessionTokenSource(
      'explicit-development-login',
      envKey,
      'default',
      () => true
    )
    const logoutMarker = marker({ intent: 'logout-pending' })

    expect(acceptedSource.source).toBe('historical-plaintext')
    expect(
      authority.planAcceptedLoginMarkerTransition({
        marker: logoutMarker,
        canRetirePreviousDebt: true,
        selectedSource: acceptedSource,
      })
    ).toEqual({ kind: 'apply', cas: { expected: logoutMarker, next: null } })
  })

  it('owns source-cleanup preservation and verified completion policy', () => {
    expect(coordinator.planSourceCleanup('active-keytar', 'accepted-token')).toEqual({
      source: 'active-keytar',
      preserveActiveEnvKey: true,
    })
    expect(coordinator.planSourceCleanup('safe-storage', 'accepted-token')).toEqual({
      source: 'safe-storage',
      preserveActiveEnvKey: false,
      preserveActiveEncryptedToken: 'accepted-token',
    })
    expect(coordinator.planSourceCleanup('active-keytar', null)).toBeNull()

    const safeStoragePlan = coordinator.planSourceCleanup('safe-storage', 'accepted-token')!
    expect(
      coordinator.planSourceCleanupOutcome(safeStoragePlan, {
        sourceVerified: true,
        keytarCleanupSettled: true,
        fallbackRetirementVerified: true,
        ownerCurrent: true,
      })
    ).toEqual({ source: 'safe-storage', kind: 'verified' })
    expect(
      coordinator.planSourceCleanupOutcome(safeStoragePlan, {
        sourceVerified: true,
        keytarCleanupSettled: true,
        fallbackRetirementVerified: false,
        ownerCurrent: true,
      })
    ).toEqual({ source: 'safe-storage', kind: 'incomplete' })
    expect(
      coordinator.planSourceCleanupOutcome(safeStoragePlan, {
        sourceVerified: true,
        keytarCleanupSettled: true,
        fallbackRetirementVerified: true,
        ownerCurrent: false,
      })
    ).toEqual({ source: 'safe-storage', kind: 'superseded' })
  })

  it('keeps authority-read outcomes context-aware and distinguishes transient I/O', async () => {
    const envKey = getActiveEnvKey()
    const markerFile = path.join(
      fixture.directory,
      `pending-external-logout-${createHash('sha256').update(envKey).digest('hex')}`
    )
    await fs.writeFile(markerFile, 'not-json', { mode: 0o600 })
    let markerError: unknown
    try {
      readPendingExternalLogoutMarker(fixture.directory, envKey)
    } catch (error) {
      markerError = error
    }
    expect(coordinator.planPersistenceAuthorityFailure(markerError, 'source-cleanup')).toEqual({
      kind: 'fail-closed',
      source: 'marker',
    })
    expect(coordinator.planPersistenceAuthorityFailure(markerError, 'marker-retirement')).toEqual({
      kind: 'continue',
      source: 'marker',
    })

    const journalFile = path.join(
      fixture.directory,
      `session-persistence-journal-${sessionPersistenceCandidateHash(envKey)}`
    )
    await fs.writeFile(journalFile, 'not-json', { mode: 0o600 })
    let journalError: unknown
    try {
      readSessionPersistenceJournal(fixture.directory, envKey)
    } catch (error) {
      journalError = error
    }
    expect(coordinator.planPersistenceAuthorityFailure(journalError, 'producer-rollback')).toEqual({
      kind: 'fail-closed',
      source: 'journal',
    })
    expect(coordinator.planPersistenceAuthorityFailure(journalError, 'source-cleanup')).toEqual({
      kind: 'continue',
      source: 'journal',
    })

    const openSync = vi.spyOn(fsSync, 'openSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('temporary descriptor exhaustion'), { code: 'EMFILE' })
    })
    let transientMarkerError: unknown
    try {
      readPendingExternalLogoutMarker(fixture.directory, envKey)
    } catch (error) {
      transientMarkerError = error
    }
    expect(openSync).toHaveBeenCalledOnce()
    expect(
      coordinator.planPersistenceAuthorityFailure(transientMarkerError, 'source-cleanup')
    ).toEqual({
      kind: 'transient-read',
      source: 'marker',
      action: 'defer',
    })
    expect(
      coordinator.planPersistenceAuthorityFailure(transientMarkerError, 'nested-producer-rollback')
    ).toEqual({
      kind: 'transient-read',
      source: 'marker',
      action: 'repair-owned-source',
    })
    expect(
      coordinator.planPersistenceAuthorityFailure(
        transientMarkerError,
        'restore-source-observation',
        {
          priorRuntimeAvailable: true,
        }
      )
    ).toEqual({
      kind: 'transient-read',
      source: 'marker',
      action: 'preserve-prior-runtime',
    })
    expect(
      coordinator.planPersistenceAuthorityFailure(
        transientMarkerError,
        'restore-session-validation',
        {
          priorRuntimeMatchesCandidate: true,
        }
      )
    ).toEqual({
      kind: 'transient-read',
      source: 'marker',
      action: 'preserve-prior-runtime',
    })

    const keytarFailure = new Error('fixture Keytar read error')
    const keytarPlan = coordinator.planSessionTokenSourceObservation({
      source: 'keytar',
      status: 'failed',
      error: keytarFailure,
      fallbackReadFailure: false,
    })
    expect(keytarPlan).toEqual({
      kind: 'reject',
      error: new SessionCredentialSourceObservationError('keytar'),
    })
    if (keytarPlan.kind !== 'reject') throw new Error('Uncertain Keytar must reject fallback')
    expect(
      coordinator.planPersistenceAuthorityFailure(keytarPlan.error, 'restore-source-observation', {
        priorRuntimeAvailable: true,
      })
    ).toEqual({
      kind: 'transient-read',
      source: 'keytar',
      action: 'preserve-prior-runtime',
    })
    const fallbackFailure = new Error('fixture verified fallback-file read failure')
    expect(
      coordinator.planSessionTokenSourceObservation({
        source: 'safe-storage',
        status: 'failed',
        error: fallbackFailure,
        fallbackReadFailure: false,
      })
    ).toEqual({
      kind: 'reject',
      error: new SessionCredentialSourceObservationError('safe-storage'),
    })
  })

  it('admits team transitions only when durable marker authority matches the live lease', () => {
    const envKey = getActiveEnvKey()
    const logout = marker({ intent: 'logout-pending' })
    const cleanup = marker({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'active-keytar',
    })
    const volatile = marker({
      intent: 'memory-only-session',
      volatileSessionId: 'fixture-volatile-owner',
    })

    expect(coordinator.planTeamTransitionMarkerAdmission(null, envKey)).toEqual({ kind: 'allow' })
    expect(coordinator.planTeamTransitionMarkerAdmission(cleanup, envKey)).toEqual({
      kind: 'allow',
    })
    expect(coordinator.planTeamTransitionMarkerAdmission(logout, envKey)).toEqual({
      kind: 'fail-closed',
    })
    expect(coordinator.planTeamTransitionMarkerAdmission(volatile, envKey)).toEqual({
      kind: 'fail-closed',
    })

    coordinator.memoryOnlySession = {
      envKey,
      volatileSessionId: 'fixture-volatile-owner',
      marker: volatile,
      expiresAt: Date.now() + 60_000,
    }
    expect(coordinator.planTeamTransitionMarkerAdmission(volatile, envKey)).toEqual({
      kind: 'allow',
    })
    expect(
      coordinator.planTeamTransitionMarkerAdmission(
        marker({ intent: 'memory-only-session', volatileSessionId: 'another-owner' }),
        envKey
      )
    ).toEqual({ kind: 'fail-closed' })
    coordinator.memoryOnlySession = undefined
  })

  it('selects ordinary current-source restore only when there is no authority marker', () => {
    expect(coordinator.restoreActionForMarker(null)).toEqual({
      kind: 'restore',
      plan: {
        policy: 'normal',
        pendingCleanupMarker: null,
        retireMarkerAfterRestore: false,
      },
    })
  })

  it('keeps an M marker as a restart denial and never treats it as a credential source', () => {
    const memoryMarker = marker({ intent: 'memory-only-session', volatileSessionId: 'volatile-1' })
    expect(coordinator.restoreActionForMarker(memoryMarker)).toEqual({
      kind: 'deny',
      plan: {
        policy: 'deny-all',
        pendingCleanupMarker: memoryMarker,
        retireMarkerAfterRestore: false,
      },
    })
    expect(coordinator.planFreshLogin(memoryMarker)).toMatchObject({
      kind: 'ready',
      plan: {
        marker: memoryMarker,
        writeAction: { kind: 'secure-preferred' },
        retireMarker: false,
      },
    })
  })

  it('does not let a retired temporary-token tombstone reject the current persistent RPC session', async () => {
    const owner = new SessionAuthorityCoordinator({
      tokenStore: new TokenStore(),
      getUserDataDirectory: () => '/tmp/evenfire-session-authority-tombstone-test',
      reportDeferredLogoutFailure: () => {},
      failClosedForPendingLogout: async () => {},
    })
    const expiredSessionToken = 'reused-by-reauthenticated-session'
    const newSessionToken = 'new-persistent-session-token'
    const reusedRpcToken = 'reused-by-reauthenticated-session'
    const user: SessionMe = {
      id: 'persistent-user',
      email: 'persistent@example.test',
      name: null,
      picture: null,
      teamId: null,
      teamName: null,
      role: 'member',
    }
    owner.sessionToken = expiredSessionToken
    owner.me = user
    owner.memoryOnlySession = {
      envKey: 'active-111111111111',
      volatileSessionId: 'volatile-session-id',
      marker: {
        intent: 'memory-only-session',
        revision: '00000000-0000-4000-8000-000000000001',
        volatileSessionId: 'volatile-session-id',
      },
      expiresAt: Date.now() + 60_000,
    }
    owner.memoryOnlySession = undefined
    owner.sessionToken = null
    owner.me = null
    owner.clearRpcCredentialOwners()
    owner.sessionToken = newSessionToken
    owner.me = user
    const persistentRpc = await owner.issueRpcCredential(newSessionToken, async () => ({
      token: reusedRpcToken,
      expiresInSeconds: 300,
    }))

    expect(owner.assertTemporaryRequestAllowed(persistentRpc.token)).toBeUndefined()
  })

  it('does not apply the volatile ownership cap to persistent sessions', async () => {
    const owner = new SessionAuthorityCoordinator({
      tokenStore: new TokenStore(),
      getUserDataDirectory: () => '/tmp/evenfire-session-authority-persistent-cap-test',
      reportDeferredLogoutFailure: () => {},
      failClosedForPendingLogout: async () => {},
    })
    owner.sessionToken = 'persistent-cap-session'
    owner.me = {
      id: 'persistent-cap-user',
      email: 'persistent-cap@example.test',
      name: null,
      picture: null,
      teamId: null,
      teamName: null,
      role: 'member',
    }

    for (let index = 0; index < 1025; index += 1) {
      await expect(
        owner.issueRpcCredential('persistent-cap-session', async () => ({
          token: `persistent-cap-rpc-${index}`,
          expiresInSeconds: 300,
        }))
      ).resolves.toMatchObject({ token: `persistent-cap-rpc-${index}` })
    }

    expect(owner.assertTemporaryRequestAllowed('persistent-cap-rpc-1024')).toBeUndefined()
    expect((owner as any).rpcCredentialOwners.size).toBe(1024)
    expect(() => owner.assertTemporaryRequestAllowed('persistent-cap-rpc-0')).toThrow()
  })

  it('keeps guarded persistent RPC ownership bounded without denying new issuances', async () => {
    const owner = new SessionAuthorityCoordinator({
      tokenStore: new TokenStore(),
      getUserDataDirectory: () => '/tmp/evenfire-session-authority-guarded-cap-test',
      reportDeferredLogoutFailure: () => {},
      failClosedForPendingLogout: async () => {},
    })
    vi.spyOn(owner, 'assertMemoryOnlySessionCurrent').mockImplementation(() => {})
    const user: SessionMe = {
      id: 'guarded-cap-user',
      email: 'guarded-cap@example.test',
      name: null,
      picture: null,
      teamId: null,
      teamName: null,
      role: 'member',
    }
    owner.sessionToken = 'retired-memory-cap-session'
    owner.me = user
    owner.memoryOnlySession = {
      envKey: 'active-111111111111',
      volatileSessionId: 'retired-memory-cap-lease',
      marker: {
        intent: 'memory-only-session',
        revision: '00000000-0000-4000-8000-000000000001',
        volatileSessionId: 'retired-memory-cap-lease',
      },
      expiresAt: Date.now() + 60_000,
    }
    owner.memoryOnlySession = undefined
    owner.sessionToken = null
    owner.me = null
    owner.clearRpcCredentialOwners()
    owner.advanceSessionGeneration(owner.sessionGeneration)
    owner.sessionToken = 'guarded-persistent-session'
    owner.me = user

    for (let index = 0; index < 1024; index += 1) {
      await expect(
        owner.issueRpcCredential('guarded-persistent-session', async () => ({
          token: `fixture-guarded-persistent-rpc-${index}`,
          expiresInSeconds: 300,
        }))
      ).resolves.toMatchObject({ token: `fixture-guarded-persistent-rpc-${index}` })
    }

    // A manager cache hit is the same accepted bearer, not a new owner record;
    // refreshing its observation must not evict a still-live credential.
    await expect(
      owner.issueRpcCredential(
        'guarded-persistent-session',
        async () => ({
          token: 'fixture-guarded-persistent-rpc-0',
          expiresInSeconds: 300,
        }),
        () => ({ token: 'fixture-guarded-persistent-rpc-0', expiresInSeconds: 300 })
      )
    ).resolves.toMatchObject({ token: 'fixture-guarded-persistent-rpc-0' })
    expect(owner.assertTemporaryRequestAllowed('fixture-guarded-persistent-rpc-0')).toBeUndefined()
    expect((owner as any).rpcCredentialOwners.size).toBe(1024)

    await expect(
      owner.issueRpcCredential('guarded-persistent-session', async () => ({
        token: 'fixture-guarded-persistent-rpc-1024',
        expiresInSeconds: 300,
      }))
    ).resolves.toMatchObject({ token: 'fixture-guarded-persistent-rpc-1024' })

    expect((owner as any).rpcCredentialOwners.size).toBe(1024)
    expect(() => owner.assertTemporaryRequestAllowed('fixture-guarded-persistent-rpc-0')).toThrow(
      'current authenticated session'
    )
    expect(
      owner.assertTemporaryRequestAllowed('fixture-guarded-persistent-rpc-1024')
    ).toBeUndefined()
  })

  it('bounds live RPC credential ownership records and reclaims only after monotonic expiry', async () => {
    let monotonicNow = 0
    const now = vi.spyOn(performance, 'now').mockImplementation(() => monotonicNow)
    try {
      const owner = new SessionAuthorityCoordinator({
        tokenStore: new TokenStore(),
        getUserDataDirectory: () => '/tmp/evenfire-session-authority-capacity-test',
        reportDeferredLogoutFailure: () => {},
        failClosedForPendingLogout: async () => {},
      })
      vi.spyOn(owner, 'assertMemoryOnlySessionCurrent').mockImplementation(() => {})
      const volatileSessionId = 'volatile-capacity-test'
      owner.memoryOnlySession = {
        envKey: 'active-111111111111',
        volatileSessionId,
        marker: {
          intent: 'memory-only-session',
          revision: '00000000-0000-4000-8000-000000000001',
          volatileSessionId,
        },
        expiresAt: Date.now() + 60_000,
      }
      owner.sessionToken = 'capacity-session-token'
      owner.me = {
        id: 'capacity-user',
        email: 'capacity@example.test',
        name: null,
        picture: null,
        teamId: null,
        teamName: null,
        role: 'member',
      }

      let issued = 0
      for (let index = 0; index < 1024; index += 1) {
        await owner.issueRpcCredential('capacity-session-token', async () => ({
          token: `fixture-rpc-capacity-${index}`,
          expiresInSeconds: 300,
        }))
        issued += 1
      }

      await expect(
        owner.issueRpcCredential('capacity-session-token', async () => {
          issued += 1
          return { token: 'fixture-rpc-over-capacity', expiresInSeconds: 300 }
        })
      ).rejects.toThrow('capacity')
      expect(issued).toBe(1024)

      await expect(
        owner.issueRpcCredential(
          'capacity-session-token',
          async () => {
            issued += 1
            return { token: 'fixture-rpc-unexpected-mint', expiresInSeconds: 300 }
          },
          () => ({ token: 'fixture-rpc-capacity-0', expiresInSeconds: 300 })
        )
      ).resolves.toMatchObject({ token: 'fixture-rpc-capacity-0' })
      expect(issued).toBe(1024)

      await expect(
        owner.issueRpcCredential(
          'capacity-session-token',
          async () => {
            issued += 1
            return { token: 'fixture-rpc-unexpected-unowned-mint', expiresInSeconds: 300 }
          },
          () => ({ token: 'fixture-rpc-unowned-cache-value', expiresInSeconds: 300 })
        )
      ).rejects.toThrow('capacity')
      expect(issued).toBe(1024)

      monotonicNow = 299_999
      await expect(
        owner.issueRpcCredential('capacity-session-token', async () => {
          issued += 1
          return { token: 'fixture-rpc-before-expiry', expiresInSeconds: 300 }
        })
      ).rejects.toThrow('capacity')
      expect(issued).toBe(1024)

      monotonicNow = 300_000
      await expect(
        owner.issueRpcCredential('capacity-session-token', async () => ({
          token: 'fixture-rpc-after-expiry',
          expiresInSeconds: 300,
        }))
      ).resolves.toMatchObject({ token: 'fixture-rpc-after-expiry' })
    } finally {
      now.mockRestore()
    }
  })

  it('retains RPC credentials minted for multiple teams under the same volatile lease', async () => {
    const owner = new SessionAuthorityCoordinator({
      tokenStore: new TokenStore(),
      getUserDataDirectory: () => '/tmp/evenfire-session-authority-team-rpc-test',
      reportDeferredLogoutFailure: () => {},
      failClosedForPendingLogout: async () => {},
    })
    vi.spyOn(owner, 'assertMemoryOnlySessionCurrent').mockImplementation(() => {})
    const homeUser: SessionMe = {
      id: 'team-rpc-user',
      email: 'team-rpc@example.test',
      name: null,
      picture: null,
      teamId: 'home-team',
      teamName: 'Home team',
      role: 'member',
    }
    owner.sessionToken = 'home-team-session'
    owner.me = homeUser
    owner.memoryOnlySession = {
      envKey: 'active-111111111111',
      volatileSessionId: 'multi-team-lease',
      marker: {
        intent: 'memory-only-session',
        revision: '00000000-0000-4000-8000-000000000001',
        volatileSessionId: 'multi-team-lease',
      },
      expiresAt: Date.now() + 60_000,
    }
    const homeRequestContext = owner.captureSessionRequestContext('home-team-session')

    await owner.issueRpcCredential('home-team-session', async () => ({
      token: 'fixture-home-team-rpc',
      expiresInSeconds: 300,
    }))
    owner.sessionToken = 'target-team-session'
    owner.me = { ...homeUser, teamId: 'target-team', teamName: 'Target team' }
    await owner.issueRpcCredential('target-team-session', async () => ({
      token: 'fixture-target-team-rpc',
      expiresInSeconds: 300,
    }))
    owner.sessionToken = 'home-team-session'
    owner.me = homeUser
    owner.bindRpcCredentialToRequestOwner('fixture-target-team-rpc', homeRequestContext)

    expect(
      owner.assertTemporaryRequestAllowed('fixture-home-team-rpc', homeRequestContext)
    ).toBeDefined()
    expect(
      owner.assertTemporaryRequestAllowed('fixture-target-team-rpc', homeRequestContext)
    ).toBeDefined()
    expect(owner.assertTemporaryRequestAllowed('fixture-target-team-rpc')).toBeDefined()
  })

  it('rejects a memory-only RPC bearer from a previous team during the same lease', async () => {
    const owner = new SessionAuthorityCoordinator({
      tokenStore: new TokenStore(),
      getUserDataDirectory: () => '/tmp/evenfire-session-authority-memory-team-guard-test',
      reportDeferredLogoutFailure: () => {},
      failClosedForPendingLogout: async () => {},
    })
    vi.spyOn(owner, 'assertMemoryOnlySessionCurrent').mockImplementation(() => {})
    const homeUser: SessionMe = {
      id: 'memory-team-owner',
      email: 'memory-team@example.test',
      name: null,
      picture: null,
      teamId: 'home-team',
      teamName: 'Home team',
      role: 'member',
    }
    owner.sessionToken = 'memory-home-session'
    owner.me = homeUser
    owner.memoryOnlySession = {
      envKey: getActiveEnvKey(),
      volatileSessionId: 'memory-team-lease',
      marker: marker({
        intent: 'memory-only-session',
        volatileSessionId: 'memory-team-lease',
      }),
      expiresAt: Date.now() + 60_000,
    }
    const homeRequestContext = owner.captureSessionRequestContext('memory-home-session')
    await owner.issueRpcCredential('memory-home-session', async () => ({
      token: 'fixture-memory-home-rpc',
      expiresInSeconds: 300,
    }))

    owner.me = { ...homeUser, teamId: 'target-team', teamName: 'Target team' }

    expect(() =>
      owner.assertTemporaryRequestAllowed('fixture-memory-home-rpc', homeRequestContext)
    ).toThrow('The credential is not owned by the current authenticated session')
    owner.me = homeUser
    owner.sessionToken = 'memory-replacement-session'
    expect(() =>
      owner.assertTemporaryRequestAllowed('fixture-memory-home-rpc', homeRequestContext)
    ).toThrow('The credential is not owned by the current authenticated session')
  })

  it('does not let stale in-flight RPC mints reserve capacity after session replacement', async () => {
    const owner = new SessionAuthorityCoordinator({
      tokenStore: new TokenStore(),
      getUserDataDirectory: () => '/tmp/evenfire-session-authority-stale-reservation-test',
      reportDeferredLogoutFailure: () => {},
      failClosedForPendingLogout: async () => {},
    })
    const user: SessionMe = {
      id: 'reservation-user',
      email: 'reservation@example.test',
      name: null,
      picture: null,
      teamId: null,
      teamName: null,
      role: 'member',
    }
    owner.sessionToken = 'old-reservation-session'
    owner.me = user
    vi.spyOn(owner, 'assertMemoryOnlySessionCurrent').mockImplementation(() => {})
    owner.memoryOnlySession = {
      envKey: 'active-111111111111',
      volatileSessionId: 'old-reservation-lease',
      marker: {
        intent: 'memory-only-session',
        revision: '00000000-0000-4000-8000-000000000001',
        volatileSessionId: 'old-reservation-lease',
      },
      expiresAt: Date.now() + 60_000,
    }

    const gates = Array.from({ length: 1024 }, () => {
      let resolve!: (value: { token: string; expiresInSeconds: number }) => void
      const promise = new Promise<{ token: string; expiresInSeconds: number }>(done => {
        resolve = done
      })
      return { promise, resolve }
    })
    let started = 0
    const staleMints = Array.from({ length: 1024 }, (_, index) =>
      owner.issueRpcCredential('old-reservation-session', () => {
        started += 1
        return gates[index].promise
      })
    )
    let outcomes: PromiseSettledResult<{ token: string; expiresInSeconds: number }>[] = []

    try {
      await vi.waitFor(() => expect(started).toBe(1024), { timeout: 2_000 })
      owner.advanceSessionGeneration(owner.sessionGeneration)
      owner.sessionToken = null
      owner.me = null
      owner.clearRpcCredentialOwners()
      owner.memoryOnlySession = undefined
      owner.advanceSessionGeneration(owner.sessionGeneration)
      owner.sessionToken = 'new-reservation-session'
      owner.me = user

      await expect(
        owner.issueRpcCredential('new-reservation-session', async () => ({
          token: 'fixture-new-session-rpc-token',
          expiresInSeconds: 300,
        }))
      ).resolves.toMatchObject({ token: 'fixture-new-session-rpc-token' })
    } finally {
      for (let index = 0; index < gates.length; index += 1) {
        gates[index].resolve({ token: `stale-rpc-${index}`, expiresInSeconds: 300 })
      }
      outcomes = await Promise.allSettled(staleMints)
    }
    expect(outcomes.every(result => result.status === 'rejected')).toBe(true)
  })

  it.each([
    ['active-keytar', 'keytar-active-only'],
    ['safe-storage', 'safe-storage-only'],
  ] as const)('denies cleanup-marker restore for its recorded %s source', source => {
    const cleanupMarker = marker({ intent: 'keytar-cleanup-pending', credentialSource: source })
    expect(coordinator.restoreActionForMarker(cleanupMarker)).toMatchObject({
      kind: 'deny',
      plan: { policy: 'deny-all', pendingCleanupMarker: cleanupMarker },
    })
  })

  it('keeps logout-pending restoration behind the logout finalization path', () => {
    const logoutMarker = marker({ intent: 'logout-pending' })
    expect(coordinator.restoreActionForMarker(logoutMarker)).toEqual({
      kind: 'finalize-logout',
      marker: logoutMarker,
    })
    expect(coordinator.planFreshLogin(logoutMarker)).toMatchObject({
      kind: 'ready',
      plan: {
        marker: logoutMarker,
        writeAction: { kind: 'secure-preferred' },
        retireMarker: false,
      },
    })
  })

  it('allows fresh authentication without restoring a cleanup-marker credential', () => {
    const cleanupMarker = marker({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    expect(coordinator.planFreshLogin(cleanupMarker)).toMatchObject({
      kind: 'ready',
      plan: {
        marker: cleanupMarker,
        writeAction: { kind: 'secure-preferred' },
        retireMarker: false,
      },
    })
  })

  it('owns malformed-marker login recovery classification', () => {
    const transient = Object.assign(new Error('fixture EMFILE'), { code: 'EMFILE' })
    vi.spyOn(fsSync, 'openSync').mockImplementationOnce(() => {
      throw transient
    })
    expect(() => readPendingExternalLogoutMarker(fixture.directory, getActiveEnvKey())).toThrow(
      transient
    )
    expect(coordinator.planMalformedMarkerLoginReadFailure({ error: transient })).toEqual({
      kind: 'reject-transient-read',
    })
    const corrupt = new Error('fixture malformed marker')
    expect(coordinator.planMalformedMarkerLoginReadFailure({ error: corrupt })).toEqual({
      kind: 'read-observed-revision',
    })
    expect(
      coordinator.planMalformedMarkerLoginReadFailure({
        error: corrupt,
        contentsRevision: 'observed-content-hash',
      })
    ).toEqual({ kind: 'normalize-observed-bytes', contentsRevision: 'observed-content-hash' })
    expect(
      coordinator.planMalformedMarkerLoginReadFailure({
        error: corrupt,
        contentsRevision: null,
      })
    ).toEqual({ kind: 'deny-unverifiable-marker' })
  })

  it('owns rejected-candidate cleanup authority across LP and source-specific cleanup markers', () => {
    const observed = { status: 'owned', marker: null } as const
    const superseded = { status: 'superseded' } as const
    expect(
      coordinator.planRejectedCandidateCleanup({
        source: 'active-keytar',
        mode: 'rollback-repair',
        observation: observed,
        runtimeOwned: true,
        currentMarker: null,
      })
    ).toEqual({ kind: 'allow' })
    expect(
      coordinator.planRejectedCandidateCleanup({
        source: 'active-keytar',
        mode: 'rollback-repair',
        observation: superseded,
        runtimeOwned: true,
        currentMarker: marker({ intent: 'logout-pending' }),
      })
    ).toEqual({ kind: 'allow' })
    expect(
      coordinator.planRejectedCandidateCleanup({
        source: 'active-keytar',
        mode: 'rollback-repair',
        observation: superseded,
        runtimeOwned: true,
        currentMarker: marker({
          intent: 'keytar-cleanup-pending',
          credentialSource: 'safe-storage',
        }),
      })
    ).toEqual({ kind: 'allow' })
    expect(
      coordinator.planRejectedCandidateCleanup({
        source: 'safe-storage',
        mode: 'rollback-repair',
        observation: superseded,
        runtimeOwned: true,
        currentMarker: marker({
          intent: 'keytar-cleanup-pending',
          credentialSource: 'safe-storage',
        }),
      })
    ).toEqual({ kind: 'deny' })
    expect(
      coordinator.planRejectedCandidateCleanup({
        source: 'active-keytar',
        mode: 'discard-uncommitted',
        observation: superseded,
        runtimeOwned: true,
        currentMarker: null,
      })
    ).toEqual({ kind: 'allow' })
  })

  it('centralizes restore mismatch, logout marker and journal-retirement decisions', () => {
    const lp = marker({ intent: 'logout-pending' })
    expect(coordinator.planRestoreMarkerMismatch(null, lp)).toEqual({
      kind: 'finalize-logout',
      marker: lp,
    })
    expect(coordinator.planRestoreMarkerMismatch(null, null)).toEqual({ kind: 'superseded' })
    expect(
      coordinator.planLogoutJournalRetirement({ clearCompleted: false, snapshotAvailable: true })
    ).toEqual({ kind: 'skip' })
    expect(
      coordinator.planLogoutJournalRetirement({ clearCompleted: true, snapshotAvailable: true })
    ).toEqual({ kind: 'retire-verified-snapshot' })
    expect(coordinator.planLogoutIntentAfterCleanup(lp)).toEqual({
      kind: 'preserve-existing-logout-intent',
      marker: lp,
    })
    expect(
      coordinator.planLogoutIntentAfterCleanup(
        marker({ intent: 'keytar-cleanup-pending', credentialSource: 'active-keytar' })
      )
    ).toEqual({ kind: 'superseded' })
    expect(coordinator.planLogoutIntentAfterCleanup(null)).toEqual({ kind: 'write-logout-intent' })
  })

  it('retains logout denial only for the original failed-login marker revision', () => {
    const lp = marker({ intent: 'logout-pending' })
    const nextCleanup = marker({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'active-keytar',
    })
    expect(
      coordinator.planRejectedLoginMarkerRecovery({
        marker: lp,
        attemptedMarker: null,
        currentMarker: null,
        transactionOwned: true,
      })
    ).toEqual({ kind: 'write-logout-intent-if-missing' })
    expect(
      coordinator.planRejectedLoginMarkerRecovery({
        marker: lp,
        attemptedMarker: nextCleanup,
        currentMarker: nextCleanup,
        transactionOwned: true,
      })
    ).toEqual({ kind: 'replace-observed-logout-intent', marker: nextCleanup })
    expect(
      coordinator.planRejectedLoginMarkerRecovery({
        marker: lp,
        attemptedMarker: null,
        currentMarker: marker({ intent: 'memory-only-session', volatileSessionId: 'later' }),
        transactionOwned: true,
      })
    ).toEqual({ kind: 'preserve-newer-marker' })
  })

  it('never restores through a cleanup marker, regardless of stored-source cleanup state', () => {
    const cleanupMarker = marker({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    expect(coordinator.restoreActionForMarker(cleanupMarker)).toMatchObject({
      kind: 'deny',
      plan: { policy: 'deny-all', retireMarkerAfterRestore: false },
    })
  })
})
