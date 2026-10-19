import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type PendingExternalLogoutIntent,
  isTransientPendingLogoutReadError,
  pendingExternalLogoutMarkersMatch,
} from '../pendingExternalLogout.js'

const transientCodes = ['EMFILE', 'ENFILE', 'EAGAIN', 'EBUSY', 'EINTR']

describe('marker inspection error policy', () => {
  it.each(transientCodes)('classifies %s as temporary, never confirmed corruption', code => {
    expect(
      isTransientPendingLogoutReadError(Object.assign(new Error('fixture-read'), { code }))
    ).toBe(true)
  })

  it('never turns unknown, permanent, absent, or malformed errors into temporary I/O', () => {
    fc.assert(
      fc.property(fc.jsonValue(), value => {
        const code =
          value !== null && typeof value === 'object'
            ? (value as { code?: unknown }).code
            : undefined
        expect(isTransientPendingLogoutReadError(value)).toBe(
          typeof code === 'string' && transientCodes.includes(code)
        )
      }),
      { numRuns: 20000 }
    )
    for (const code of ['ENOENT', 'EACCES', 'ELOOP', 'EIO', 'EINVAL', 'ENOTDIR']) {
      expect(isTransientPendingLogoutReadError({ code })).toBe(false)
    }
  })

  it('depends only on an exact transient code, not misleading message text', () => {
    fc.assert(
      fc.property(fc.string(), fc.constantFrom(...transientCodes), (message, code) => {
        expect(isTransientPendingLogoutReadError({ message, code })).toBe(true)
        expect(isTransientPendingLogoutReadError(new Error(`${code}: ${message}`))).toBe(false)
      }),
      { numRuns: 20000 }
    )
  })
})

describe('shared exact marker ownership', () => {
  const intent = fc.constantFrom<PendingExternalLogoutIntent>(
    { intent: 'logout-pending' },
    { intent: 'keytar-cleanup-pending', credentialSource: 'active-keytar' },
    { intent: 'keytar-cleanup-pending', credentialSource: 'safe-storage' }
  )
  const marker = fc.record({ intent, revision: fc.option(fc.uuid(), { nil: null }) })

  it('is reflexive and symmetric without treating revisionless records as wildcards', () => {
    fc.assert(
      fc.property(marker, marker, (left, right) => {
        expect(pendingExternalLogoutMarkersMatch(left, left)).toBe(true)
        expect(pendingExternalLogoutMarkersMatch(left, right)).toBe(
          pendingExternalLogoutMarkersMatch(right, left)
        )
        const sameSource =
          left.intent.intent === 'logout-pending'
            ? right.intent.intent === 'logout-pending'
            : right.intent.intent === 'keytar-cleanup-pending' &&
              left.intent.credentialSource === right.intent.credentialSource
        expect(pendingExternalLogoutMarkersMatch(left, right)).toBe(
          sameSource && left.revision === right.revision
        )
        expect(pendingExternalLogoutMarkersMatch(null, left)).toBe(false)
        expect(
          pendingExternalLogoutMarkersMatch({ ...left, revision: `new-${left.revision}` }, left)
        ).toBe(false)
      }),
      { numRuns: 20000 }
    )
  })
})
