import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { OidcSignedIn } from '@components/OidcSignedIn'

const api = vi.hoisted(() => ({
  clearUnconfirmedLogout: vi.fn(),
}))

vi.mock('@lib/api', () => ({
  clearUnconfirmedLogout: api.clearUnconfirmedLogout,
}))

const MARKER_DELETION = '__Host-ef_oidc_signed_in=; Path=/; Max-Age=0; Secure; SameSite=Lax'

let cookieHeader = ''
const cookieWrites: string[] = []
const replace = vi.fn()

beforeEach(() => {
  cookieHeader = ''
  cookieWrites.length = 0
  replace.mockReset()
  api.clearUnconfirmedLogout.mockReset()
  // jsdom serves http, so it would drop a Secure cookie: observe the document cookie jar directly.
  vi.spyOn(document, 'cookie', 'get').mockImplementation(() => cookieHeader)
  vi.spyOn(document, 'cookie', 'set').mockImplementation(value => {
    cookieWrites.push(value)
  })
  vi.stubGlobal('location', { ...window.location, replace })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('OidcSignedIn', () => {
  it('with the marker it clears the fence and the marker, then replaces location with /', () => {
    cookieHeader = 'other=1; __Host-ef_oidc_signed_in=1'

    render(<OidcSignedIn />)

    expect(api.clearUnconfirmedLogout).toHaveBeenCalledTimes(1)
    expect(cookieWrites).toEqual([MARKER_DELETION])
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith('/')
  })

  it('without the marker it leaves the fence and still replaces location with /', () => {
    cookieHeader = 'other=1; __Host-ef_oidc_signed_in=0; ef_oidc_signed_in=1'

    render(<OidcSignedIn />)

    expect(api.clearUnconfirmedLogout).not.toHaveBeenCalled()
    expect(cookieWrites).toEqual([])
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith('/')
  })

  it('returns to /desktop-setup for next=desktop-setup', () => {
    cookieHeader = '__Host-ef_oidc_signed_in=1'
    vi.stubGlobal('location', { ...window.location, search: '?next=desktop-setup', replace })

    render(<OidcSignedIn />)

    expect(api.clearUnconfirmedLogout).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith('/desktop-setup')
  })

  it('falls back to / for an unknown next', () => {
    cookieHeader = '__Host-ef_oidc_signed_in=1'
    // Control: the same render does read next, so each fallback below is a rejection.
    vi.stubGlobal('location', { ...window.location, search: '?next=desktop-setup', replace })
    render(<OidcSignedIn />)
    expect(replace).toHaveBeenCalledWith('/desktop-setup')
    cleanup()

    for (const search of [
      '?next=https%3A%2F%2Fevil.example',
      '?next=https://evil.example',
      '?next=%2Fsettings',
      '?next=settings',
      '?next=constructor',
      '?next=',
    ]) {
      replace.mockReset()
      vi.stubGlobal('location', { ...window.location, search, replace })

      render(<OidcSignedIn />)

      expect(replace, search).toHaveBeenCalledTimes(1)
      expect(replace, search).toHaveBeenCalledWith('/')
      cleanup()
    }
  })
})
