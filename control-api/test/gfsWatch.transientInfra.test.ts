import { describe, expect, it } from 'vitest'
import { resolveExternalGfsAuthority } from '../src/gfs/externalAuthority.js'
import { ExternalSessionBackendUnavailableError } from '../src/services/auth/sessionDatabaseFailure.js'
import { isTransientInfraError } from '../src/services/gfsWatch/transientInfraError.js'

const DESKTOP_USER_ID = '11111111-1111-4111-8111-111111111111'

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('isTransientInfraError outside the driver', () => {
  it('classifies the reasons of an aborted and a timed-out signal as transient', async () => {
    const aborted = new AbortController()
    aborted.abort()
    expect(isTransientInfraError(aborted.signal.reason)).toBe(true)

    const timedOut = AbortSignal.timeout(1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((timedOut.reason as Error).name).toBe('TimeoutError')
    expect(isTransientInfraError(timedOut.reason)).toBe(true)
  })

  it('classifies an aborted fetch as transient', async () => {
    const error = await rejectionOf(fetch('http://127.0.0.1:1/', { signal: AbortSignal.abort() }))
    expect(isTransientInfraError(error)).toBe(true)
  })

  it('separates an authority outage (503) from an authority denial (403)', async () => {
    const outage = await rejectionOf(
      resolveExternalGfsAuthority(DESKTOP_USER_ID, {
        linkingEnabled: false,
        resolveActiveLink: async () => null,
        isDesktopUserActive: async () => {
          throw new Error('lifecycle read failed')
        },
      })
    )
    expect(outage).toMatchObject({ name: 'ExternalGfsAuthorityError', status: 503 })
    expect(isTransientInfraError(outage)).toBe(true)

    const denied = await rejectionOf(
      resolveExternalGfsAuthority(DESKTOP_USER_ID, {
        linkingEnabled: false,
        resolveActiveLink: async () => null,
        isDesktopUserActive: async () => false,
      })
    )
    expect(denied).toMatchObject({ name: 'ExternalGfsAuthorityError', status: 403 })
    expect(isTransientInfraError(denied)).toBe(false)
  })

  it('inherits the session boundary verdict on a wrapped plain Error, but not on the raw one', () => {
    const callerDefect = new Error('Query values must be an array')
    expect(isTransientInfraError(new ExternalSessionBackendUnavailableError(callerDefect))).toBe(
      true
    )
    expect(isTransientInfraError(callerDefect)).toBe(false)
  })

  it("keeps Node's ERR_* programming errors and plain TypeErrors as defects", () => {
    let nodeError: unknown
    try {
      Buffer.from(123 as unknown as string)
    } catch (error) {
      nodeError = error
    }
    expect((nodeError as { code?: string }).code).toMatch(/^ERR_/)
    expect(isTransientInfraError(nodeError)).toBe(false)

    // The classifier reads only constructor, name, code and message, so a constructed
    // TypeError is indistinguishable from a thrown one; provoking it at runtime trips CodeQL.
    const typeError = new TypeError("Cannot read properties of undefined (reading 'rows')")
    expect(isTransientInfraError(typeError)).toBe(false)
  })

  it('treats a transport message on an Error subclass, and non-errors, as defects', () => {
    class SchemaError extends Error {}
    expect(isTransientInfraError(new SchemaError('Connection terminated unexpectedly'))).toBe(false)
    expect(isTransientInfraError('Connection terminated unexpectedly')).toBe(false)
    expect(isTransientInfraError(undefined)).toBe(false)
  })
})
