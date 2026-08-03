import { describe, expect, it } from 'vitest'
import type { PendingSandboxUiDeepLink } from '@/App.types'
import {
  MAX_PENDING_SANDBOX_UI_DEEP_LINKS,
  MAX_SANDBOX_UI_DEEP_LINK_RETRY_ATTEMPTS,
  confirmPendingSandboxUiDeepLink,
  deferPendingSandboxUiDeepLink,
  enqueuePendingSandboxUiDeepLink,
  failPendingSandboxUiDeepLink,
  isPendingSandboxUiDeepLinkAwaitingConfirmation,
  isPendingSandboxUiDeepLinkStale,
  nextSandboxUiDeepLinkRetryDelayMs,
  removePendingSandboxUiDeepLink,
  resetPendingSandboxUiDeepLinkFailure,
  shouldPurgeSandboxUiDeepLinks,
} from '../sandboxUiDeepLinkState'

describe('shouldPurgeSandboxUiDeepLinks', () => {
  it('keeps a cold-start link as pending user intent while the first user authenticates', () => {
    expect(shouldPurgeSandboxUiDeepLinks(undefined, null)).toBe(false)
    expect(shouldPurgeSandboxUiDeepLinks(null, 'user-a')).toBe(false)
  })

  it('purges links on logout or an authenticated identity change', () => {
    expect(shouldPurgeSandboxUiDeepLinks('user-a', null)).toBe(true)
    expect(shouldPurgeSandboxUiDeepLinks('user-a', 'user-b')).toBe(true)
  })

  it('keeps links while the same identity changes teams', () => {
    expect(shouldPurgeSandboxUiDeepLinks('user-a', 'user-a')).toBe(false)
  })
})

describe('pending sandbox UI deep-link state', () => {
  it('merges live and cold-start links in FIFO order', () => {
    let pending = enqueuePendingSandboxUiDeepLink([], { id: 2, appRef: 'ns/two' }, null, null)
    pending = enqueuePendingSandboxUiDeepLink(pending, { id: 1, appRef: 'ns/one' }, null, 'user-a')

    expect(pending.map(item => item.link.id)).toEqual([1, 2])
    expect(pending.map(item => item.receivedIdentity)).toEqual(['user-a', null])
  })

  it('re-adds a link that arrives during its acknowledgement window', () => {
    const link = { id: 1, appRef: 'ns/app' }
    let pending = enqueuePendingSandboxUiDeepLink([], link, null, 'user-a')
    pending = removePendingSandboxUiDeepLink(pending, link.id)
    pending = enqueuePendingSandboxUiDeepLink(pending, link, null, 'user-a')

    expect(pending).toHaveLength(1)
    expect(pending[0]?.link).toEqual(link)
  })

  it('mirrors the bounded main-process queue size', () => {
    let pending: PendingSandboxUiDeepLink[] = []
    for (let id = 1; id <= MAX_PENDING_SANDBOX_UI_DEEP_LINKS + 2; id += 1) {
      pending = enqueuePendingSandboxUiDeepLink(
        pending,
        { id, appRef: `ns/app-${id}` },
        null,
        'user-a'
      )
    }

    expect(pending).toHaveLength(MAX_PENDING_SANDBOX_UI_DEEP_LINKS)
    expect(pending[0]?.link.id).toBe(3)
  })

  it('requires post-login confirmation for links received without an identity', () => {
    const pending = enqueuePendingSandboxUiDeepLink([], { id: 1, appRef: 'ns/app' }, null, null)

    expect(isPendingSandboxUiDeepLinkAwaitingConfirmation(pending[0]!, 'user-a')).toBe(true)

    const confirmed = confirmPendingSandboxUiDeepLink(pending, 1, 'user-a')

    expect(isPendingSandboxUiDeepLinkAwaitingConfirmation(confirmed[0]!, 'user-a')).toBe(false)
    expect(isPendingSandboxUiDeepLinkStale(confirmed[0]!, 'user-b')).toBe(true)
  })

  it('treats authenticated queued links as stale after an identity change', () => {
    const pending = enqueuePendingSandboxUiDeepLink([], { id: 1, appRef: 'ns/app' }, null, 'user-a')

    expect(isPendingSandboxUiDeepLinkStale(pending[0]!, 'user-a')).toBe(false)
    expect(isPendingSandboxUiDeepLinkStale(pending[0]!, 'user-b')).toBe(true)
  })

  it('tracks bounded retry delays and explicit failed state', () => {
    let pending = enqueuePendingSandboxUiDeepLink([], { id: 1, appRef: 'ns/app' }, null, 'user-a')
    pending = deferPendingSandboxUiDeepLink(pending, 1, 10_000)

    expect(pending[0]?.retryCount).toBe(1)
    expect(pending[0]?.nextRetryAt).toBe(10_000 + nextSandboxUiDeepLinkRetryDelayMs(0))
    expect(nextSandboxUiDeepLinkRetryDelayMs(MAX_SANDBOX_UI_DEEP_LINK_RETRY_ATTEMPTS + 10)).toBe(
      15_000
    )

    pending = failPendingSandboxUiDeepLink(pending, 1, 'native mount failed')
    expect(pending[0]?.failedMessage).toBe('native mount failed')
    expect(pending[0]?.nextRetryAt).toBeUndefined()

    pending = resetPendingSandboxUiDeepLinkFailure(pending, 1)
    expect(pending[0]?.failedMessage).toBeUndefined()
    expect(pending[0]?.retryCount).toBe(0)
  })
})
