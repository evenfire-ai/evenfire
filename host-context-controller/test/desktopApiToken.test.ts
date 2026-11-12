import { describe, expect, it } from 'vitest'
import { assertDesktopApiToken } from '../src/desktopApiToken'

describe('assertDesktopApiToken', () => {
  it.each(['', '   ', '\n'])('refuses an empty value (%j)', value => {
    expect(() => assertDesktopApiToken(value)).toThrow(
      /^CONTEXT_MAPPER_DESKTOP_API_TOKEN env var is required outside CLERUM_DEV_MODE\./
    )
  })

  it('refuses a placeholder without echoing it', () => {
    let message = ''
    try {
      assertDesktopApiToken('replace-with-x-marker')
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/^CONTEXT_MAPPER_DESKTOP_API_TOKEN has placeholder value\./)
    expect(message).not.toContain('replace-with-x-marker')
  })

  // gen-jwt-keys.sh rotates every key, so the hint must not send an existing install there.
  it.each(['', 'replace-with-x-marker'])(
    'points an existing install to the non-rotating repairs (%j)',
    value => {
      let message = ''
      try {
        assertDesktopApiToken(value)
      } catch (err) {
        message = (err as Error).message
      }
      expect(message).toMatch(/gen-jwt-keys\.sh writes both only on a new install/)
      expect(message).toMatch(/on an existing install it rotates every key/)
      expect(message).toContain(
        '"Required secrets without code defaults" in docs/deploy/releases-and-upgrades.md'
      )
    }
  )

  it('accepts a short real value', () => {
    expect(() => assertDesktopApiToken('nine-byte')).not.toThrow()
  })
})
