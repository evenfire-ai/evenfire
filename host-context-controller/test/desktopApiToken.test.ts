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

  it('accepts a short real value', () => {
    expect(() => assertDesktopApiToken('nine-byte')).not.toThrow()
  })
})
