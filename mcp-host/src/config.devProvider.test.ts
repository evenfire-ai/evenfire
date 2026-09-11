/**
 * resolveDevModelProvider — fail-closed narrowing of CLERUM_MODEL_PROVIDER.
 *
 * Guards a provider-boundary regression: an explicitly-set but unknown provider
 * MUST throw (not drop to undefined), so the host never silently falls through
 * to API-key auto-detection — which would route to a different provider and
 * ignore CLERUM_MODEL_NAME. The throw fires regardless of which API keys are
 * mounted, covering the "invalid CLERUM_MODEL_PROVIDER + multiple keys" case.
 */
import { describe, expect, it } from 'vitest'
import { resolveDevModelProvider } from './config'
import { ALL_PROVIDERS } from './llm/registryCore'

describe('resolveDevModelProvider', () => {
  it('returns the narrowed provider for a valid value', () => {
    expect(resolveDevModelProvider('zai')).toBe('zai')
    expect(resolveDevModelProvider('bailian')).toBe('bailian')
    for (const p of ALL_PROVIDERS) {
      expect(resolveDevModelProvider(p)).toBe(p)
    }
  })

  it('returns undefined when absent (auto-detection path)', () => {
    expect(resolveDevModelProvider(undefined)).toBeUndefined()
    expect(resolveDevModelProvider('')).toBeUndefined()
  })

  it('throws fail-closed on a set-but-invalid value, naming the valid providers', () => {
    expect(() => resolveDevModelProvider('zaii')).toThrow(/Invalid CLERUM_MODEL_PROVIDER 'zaii'/)
    // The message lists every valid provider so the operator can self-correct.
    expect(() => resolveDevModelProvider('zaii')).toThrow(
      new RegExp(`Valid providers: ${ALL_PROVIDERS.join(', ')}`)
    )
    expect(ALL_PROVIDERS).toContain('codex-subscription')
  })
})
