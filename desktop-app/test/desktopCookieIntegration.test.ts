import { describe, expect, it } from 'vitest'
import { extractSessionCookie } from '../src/desktopWindow'

describe('desktop-app cookie contract with rpc-proxy', () => {
  // The rpc-proxy config.ts RPC_PROXY_DESKTOP_COOKIE_NAME default must equal this.
  // If rpc-proxy changes its default, both this test and SESSION_COOKIE_NAME
  // in desktopWindow.ts must be updated together.
  // See: rpc-proxy/src/config.ts line ~99:
  //   desktopCookieName: process.env.RPC_PROXY_DESKTOP_COOKIE_NAME || "clerum_desktop_session"
  const EXPECTED_COOKIE_NAME = 'clerum_desktop_session'

  it('extracts the cookie value from a real rpc-proxy Set-Cookie format', () => {
    const setCookie = `${EXPECTED_COOKIE_NAME}=abc.signed.value; Path=/api/v1/desktop/chatllm; HttpOnly; SameSite=Strict; Max-Age=3600`
    const extracted = extractSessionCookie(setCookie, EXPECTED_COOKIE_NAME)
    expect(extracted).toBe('abc.signed.value')
  })

  it('returns null when cookie name does not match (regression: hyphenated vs underscored)', () => {
    // The old bug: desktop-app searched for "clerum-desktop-session" (hyphenated)
    // but rpc-proxy sets "clerum_desktop_session" (underscored). This test
    // documents that the hyphenated variant does NOT match.
    const setCookie = `${EXPECTED_COOKIE_NAME}=abc.signed.value; Path=/api/v1/desktop/chatllm; HttpOnly; SameSite=Strict; Max-Age=3600`
    const extracted = extractSessionCookie(setCookie, 'clerum-desktop-session')
    expect(extracted).toBeNull()
  })
})
