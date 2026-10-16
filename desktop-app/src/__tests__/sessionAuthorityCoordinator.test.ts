import { describe, expect, it } from 'vitest'
import { SessionAuthorityCoordinator } from '../sessionAuthorityCoordinator.js'
import { TokenStore } from '../tokenStore.js'

const coordinator = new SessionAuthorityCoordinator({
  tokenStore: new TokenStore(),
  getUserDataDirectory: () => '/tmp/evenfire-session-authority-test',
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
      marker: memoryMarker,
      writeKeytar: true,
      requireSafeStorage: false,
      retireMarker: false,
    })
  })

  it.each([
    ['active-keytar', 'keytar-active-only'],
    ['safe-storage', 'safe-storage-only'],
  ] as const)('pins cleanup-marker restore to its recorded %s source', (source, policy) => {
    const cleanupMarker = marker({ intent: 'keytar-cleanup-pending', credentialSource: source })
    expect(coordinator.restoreActionForMarker(cleanupMarker)).toEqual({
      kind: 'cleanup-source',
      source,
      plan: {
        policy,
        pendingCleanupMarker: cleanupMarker,
        retireMarkerAfterRestore: false,
      },
    })
  })

  it('keeps logout-pending restoration behind the logout finalization path', () => {
    const logoutMarker = marker({ intent: 'logout-pending' })
    expect(coordinator.restoreActionForMarker(logoutMarker)).toEqual({
      kind: 'finalize-logout',
      marker: logoutMarker,
    })
    expect(coordinator.planFreshLogin(logoutMarker)).toMatchObject({
      marker: logoutMarker,
      writeKeytar: true,
      retireMarker: false,
    })
  })

  it('requires cleanup effects before making a fresh-login plan for a cleanup marker', () => {
    const cleanupMarker = marker({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    expect(coordinator.planFreshLogin(cleanupMarker)).toBeNull()
  })

  it.each([
    [null, false, null, 'active-keytar'],
    [null, true, null, 'isolated-development'],
    [
      marker({ intent: 'keytar-cleanup-pending', credentialSource: 'active-keytar' }),
      false,
      'active-keytar',
      'active-keytar',
    ],
    [
      marker({ intent: 'keytar-cleanup-pending', credentialSource: 'safe-storage' }),
      false,
      'safe-storage',
      'safe-storage',
    ],
  ] as const)(
    'keeps team persistence pinned to the coordinator-selected cleanup source',
    (observedMarker, isolatedDevelopment, cleanupSource, persistedSource) => {
      expect(coordinator.planTeamSessionPersistence(observedMarker, isolatedDevelopment)).toEqual({
        cleanupSource,
        initialRollbackSource: cleanupSource,
        persistedSource,
      })
    }
  )

  it('retires a cleanup marker only when the source cleanup result is verified', () => {
    const cleanupMarker = marker({
      intent: 'keytar-cleanup-pending',
      credentialSource: 'safe-storage',
    })
    const action = coordinator.restoreActionForMarker(cleanupMarker)
    expect(action.kind).toBe('cleanup-source')
    if (action.kind !== 'cleanup-source') throw new Error('expected cleanup action')
    expect(coordinator.restorePlanAfterCleanup(action, false).retireMarkerAfterRestore).toBe(false)
    expect(coordinator.restorePlanAfterCleanup(action, true).retireMarkerAfterRestore).toBe(true)
  })
})
