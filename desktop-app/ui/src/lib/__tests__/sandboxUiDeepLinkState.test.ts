import { describe, expect, it } from 'vitest'
import type { PendingSandboxUiDeepLink } from '@/App.types'
import {
  MAX_PENDING_SANDBOX_UI_DEEP_LINKS,
  enqueuePendingSandboxUiDeepLink,
  removePendingSandboxUiDeepLink,
  shouldPurgeSandboxUiDeepLinks,
} from '../sandboxUiDeepLinkState'

describe('shouldPurgeSandboxUiDeepLinks', () => {
  it('keeps a cold-start link while the first user authenticates', () => {
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
    let pending = enqueuePendingSandboxUiDeepLink([], { id: 2, appRef: 'ns/two' }, null)
    pending = enqueuePendingSandboxUiDeepLink(pending, { id: 1, appRef: 'ns/one' }, null)

    expect(pending.map(item => item.link.id)).toEqual([1, 2])
  })

  it('re-adds a link that arrives during its acknowledgement window', () => {
    const link = { id: 1, appRef: 'ns/app' }
    let pending = enqueuePendingSandboxUiDeepLink([], link, null)
    pending = removePendingSandboxUiDeepLink(pending, link.id)
    pending = enqueuePendingSandboxUiDeepLink(pending, link, null)

    expect(pending).toHaveLength(1)
    expect(pending[0]?.link).toEqual(link)
  })

  it('mirrors the bounded main-process queue size', () => {
    let pending: PendingSandboxUiDeepLink[] = []
    for (let id = 1; id <= MAX_PENDING_SANDBOX_UI_DEEP_LINKS + 2; id += 1) {
      pending = enqueuePendingSandboxUiDeepLink(pending, { id, appRef: `ns/app-${id}` }, null)
    }

    expect(pending).toHaveLength(MAX_PENDING_SANDBOX_UI_DEEP_LINKS)
    expect(pending[0]?.link.id).toBe(3)
  })
})
