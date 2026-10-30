import { describe, expect, it } from 'vitest'
import {
  PluginStoragePrivacyError,
  validateWindowsPluginStorageEvidence,
} from '../pluginStorageWindowsAcl.js'

describe('Windows plugin storage native evidence contract', () => {
  it('accepts only complete affirmative native evidence', () => {
    expect(
      validateWindowsPluginStorageEvidence({
        ok: true,
        items: [
          {
            ok: true,
            identity: '00000001:0000000000000002',
            directory: false,
            effectiveRead: true,
            effectiveWrite: true,
            inheritedUserAccess: true,
            allowedPrincipalsOnly: true,
          },
        ],
      }).items
    ).toHaveLength(1)
  })

  it.each([
    ['unavailable result', { ok: false, phase: 'inspect-object' }],
    ['missing result', null],
    ['missing item', { ok: true, items: [{ ok: true }] }],
    [
      'negative effective access',
      {
        ok: true,
        items: [
          {
            ok: true,
            identity: '00000001:0000000000000002',
            directory: false,
            effectiveRead: false,
            effectiveWrite: true,
            inheritedUserAccess: true,
            allowedPrincipalsOnly: true,
          },
        ],
      },
    ],
  ])('rejects %s evidence without downgrading it', (_label, value) => {
    expect(() => validateWindowsPluginStorageEvidence(value)).toThrow(PluginStoragePrivacyError)
  })
})
