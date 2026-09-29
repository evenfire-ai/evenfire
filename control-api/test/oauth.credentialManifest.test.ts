import { describe, expect, it } from 'vitest'
import {
  KNOWN_OAUTH_PROVIDERS,
  type OAuthProvider,
  getCredentialManifest,
} from '../src/oauth/providers.js'

const ALL_PROVIDERS: OAuthProvider[] = [...KNOWN_OAUTH_PROVIDERS]

describe('getCredentialManifest (D-B1)', () => {
  it('every baked provider exposes a manifest with at least client_id + client_secret', () => {
    expect(ALL_PROVIDERS.length).toBeGreaterThanOrEqual(8)
    for (const provider of ALL_PROVIDERS) {
      const manifest = getCredentialManifest(provider)
      const names = manifest.map(f => f.name)
      expect(names).toContain('client_id')
      expect(names).toContain('client_secret')
    }
  })

  it('marks client_secret as secret + required and client_id as non-secret + required', () => {
    const manifest = getCredentialManifest('google')
    const byName = Object.fromEntries(manifest.map(f => [f.name, f]))
    expect(byName['client_id'].secret).toBe(false)
    expect(byName['client_id'].required).toBe(true)
    expect(byName['client_secret'].secret).toBe(true)
    expect(byName['client_secret'].required).toBe(true)
  })

  it('returns a defensive copy — mutating the result never mutates the shared definition', () => {
    const first = getCredentialManifest('slack')
    first[0].label = 'MUTATED'
    first.push({ name: 'injected', label: 'x', secret: false, required: false })
    const second = getCredentialManifest('slack')
    expect(second[0].label).not.toBe('MUTATED')
    expect(second.map(f => f.name)).not.toContain('injected')
  })
})
