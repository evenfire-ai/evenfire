import { describe, expect, it } from 'vitest'
import {
  parseCodexToolDiscoveryBytes,
  parseCodexToolPresentation,
  resolveToolPresentation,
} from '../toolPresentationPolicy'

describe('tool presentation configuration', () => {
  it.each([false, true])('defaults Codex to direct with legacy flag %s', enabled => {
    expect(parseCodexToolPresentation(undefined)).toBe('direct')
    expect(resolveToolPresentation('codex-subscription', { dynamicToolsEnabled: enabled })).toEqual(
      {
        bridgeEnabled: false,
        codexMode: 'direct',
      }
    )
    expect(parseCodexToolDiscoveryBytes(undefined)).toBe(32_768)
  })
  it.each([false, true])('defaults Codex fallback to direct with legacy flag %s', enabled => {
    expect(
      resolveToolPresentation('zai', { dynamicToolsEnabled: enabled }, [
        { provider: 'codex-subscription' },
      ])
    ).toEqual({ bridgeEnabled: false, codexMode: 'direct' })
  })
  it.each(['auto', 'direct', 'discovery'] as const)('accepts explicit %s', mode => {
    expect(parseCodexToolPresentation(mode)).toBe(mode)
    expect(
      resolveToolPresentation('codex-subscription', {
        dynamicToolsEnabled: true,
        codexToolPresentation: mode,
      })
    ).toEqual({ bridgeEnabled: mode !== 'direct', codexMode: mode })
  })
  it.each(['', 'AUTO', 'unknown', ' auto'])('rejects invalid mode %j', value => {
    expect(() => parseCodexToolPresentation(value)).toThrow('CODEX_TOOL_PRESENTATION')
  })
  it.each(['', '0', '-1', '1.5', '3bytes', '9007199254740992'])(
    'rejects invalid optimization bytes %j',
    value => {
      expect(() => parseCodexToolDiscoveryBytes(value)).toThrow('CODEX_TOOL_DISCOVERY_BYTES')
    }
  )
  it.each([false, true])('preserves other providers flag %s', enabled => {
    expect(
      resolveToolPresentation('zai', {
        dynamicToolsEnabled: enabled,
        codexToolPresentation: 'discovery',
      })
    ).toEqual({ bridgeEnabled: enabled })
  })
})
