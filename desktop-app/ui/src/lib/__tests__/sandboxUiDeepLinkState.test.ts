import { describe, expect, it } from 'vitest'
import { shouldPurgeSandboxUiDeepLinks } from '../sandboxUiDeepLinkState'

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
