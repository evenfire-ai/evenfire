import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  installModeForRegistration,
  requiresPreRegisteredCredentials,
  shouldWarnNoRefresh,
} from '../remoteMcp'
import type { RemoteInstallMode, RemoteRegistrationMode } from '../remoteMcp.types'

const REGISTRATION_MODES: RemoteRegistrationMode[] = ['cimd', 'dcr', 'manual', 'pre-registered']
const INSTALL_MODES: RemoteInstallMode[] = ['cimd', 'pre-registered', 'dcr']

describe('installModeForRegistration — property (D-3 precedence is stable and total)', () => {
  it('returns a valid install mode for every registration mode', () => {
    fc.assert(
      fc.property(fc.constantFrom(...REGISTRATION_MODES), mode => {
        expect(INSTALL_MODES).toContain(installModeForRegistration(mode))
      })
    )
  })

  it('is deterministic (same input → same output)', () => {
    fc.assert(
      fc.property(fc.constantFrom(...REGISTRATION_MODES), mode => {
        expect(installModeForRegistration(mode)).toBe(installModeForRegistration(mode))
      })
    )
  })

  it('credentials are required exactly when the mode is manual or pre-registered', () => {
    fc.assert(
      fc.property(fc.constantFrom(...REGISTRATION_MODES), mode => {
        const needsCreds = requiresPreRegisteredCredentials(installModeForRegistration(mode))
        expect(needsCreds).toBe(mode === 'manual' || mode === 'pre-registered')
      })
    )
  })

  it('cimd/dcr never map to pre-registered; manual always does', () => {
    fc.assert(
      fc.property(fc.constantFrom<RemoteRegistrationMode>('cimd', 'dcr'), mode => {
        expect(installModeForRegistration(mode)).not.toBe('pre-registered')
      })
    )
    expect(installModeForRegistration('manual')).toBe('pre-registered')
  })
})

describe('shouldWarnNoRefresh — property (D-8 warns iff no refresh)', () => {
  it('the banner is the exact negation of supportsRefresh', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (supportsRefresh, bearerInBody) => {
        expect(shouldWarnNoRefresh({ quirks: { supportsRefresh, bearerInBody } })).toBe(
          !supportsRefresh
        )
      })
    )
  })
})
