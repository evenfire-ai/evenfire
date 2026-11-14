import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupNativeCommitTestHarness,
  createNativeCommitTestHarness,
} from '../../testSupport/appService.nativeCommitTestHarness.js'
import { testLoginResult } from '../../testSupport/authTestFixtures.js'

afterEach(cleanupNativeCommitTestHarness)

describe('AppService Markdown close and auth ordering', () => {
  it('does not revive a close grant canceled by a failed logout', async () => {
    const { service } = await createNativeCommitTestHarness()
    const closeService = service as any
    const login = testLoginResult()
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
      getMe: vi.fn().mockResolvedValue(login.me),
    } as never
    await service.googleLogin('initial-login')

    const sessionGeneration = closeService.getSessionGeneration()
    const binding = {
      requestId: 'markdown-tab:close-first',
      documentEpoch: '11111111-1111-4111-8111-111111111111',
      sequence: 1,
      tabId: 'markdown-tab',
      sessionGeneration,
      ownerIdentities: ['owner-17'],
    }
    expect(closeService.beginMarkdownTabCloseDocument(42, binding.documentEpoch)).toBe(true)
    expect(closeService.authorizeMarkdownTabClose(42, binding)).toBe('granted')

    service.tokenStore.clearSessionToken = vi
      .fn()
      .mockRejectedValue(new Error('keychain unavailable'))
    const cancelled = vi.fn()
    closeService.onSessionPreclearCancelled = cancelled

    await expect(service.logout()).rejects.toThrow('keychain unavailable')

    expect(service.getCachedUserId()).toBe(login.me.id)
    expect(cancelled).toHaveBeenCalledOnce()
    expect(closeService.getMarkdownTabClosePermitStatus(42, binding)).toBe('cancelled')
    expect(closeService.cancelMarkdownTabClosePermit(42, binding)).toBe('cancelled')
    expect(closeService.consumeMarkdownTabClosePermit(42, binding)).toBe('cancelled')
  })

  it('denies and retains a close request when main session preclear wins first', async () => {
    const { service } = await createNativeCommitTestHarness()
    const closeService = service as any
    const login = testLoginResult()
    service.authClient = {
      googleLogin: vi.fn().mockResolvedValue(login),
    } as never
    await service.googleLogin('initial-login')

    const notices: Array<{ transitionId: number; sessionGeneration: number; reason: string }> = []
    closeService.onSessionPreclear = (notice: {
      transitionId: number
      sessionGeneration: number
      reason: string
    }) => {
      notices.push(notice)
      return true
    }
    const preparing = closeService.prepareSessionClear()
    await vi.waitFor(() => expect(notices).toHaveLength(1))
    const binding = {
      requestId: 'markdown-tab:auth-first',
      documentEpoch: '22222222-2222-4222-8222-222222222222',
      sequence: 1,
      tabId: 'markdown-tab',
      sessionGeneration: notices[0]!.sessionGeneration,
      ownerIdentities: ['owner-18'],
    }

    expect(closeService.beginMarkdownTabCloseDocument(42, binding.documentEpoch)).toBe(true)
    expect(closeService.authorizeMarkdownTabClose(42, binding)).toBe('denied')
    expect(closeService.getMarkdownTabClosePermitStatus(42, binding)).toBe('denied')
    expect(closeService.consumeMarkdownTabClosePermit(42, binding)).toBe('denied')
    expect(closeService.acknowledgeSessionPreclear(notices[0]!)).toBe(true)
    await expect(preparing).resolves.toMatchObject(notices[0])
    expect(closeService.getMarkdownTabClosePermitStatus(42, binding)).toBe('denied')
  })
})
