import { describe, expect, it } from 'vitest'
import { getDesktopErrorMessage } from '../desktopErrors'

describe('getDesktopErrorMessage', () => {
  it('maps Electron IPC HCC status failures to an actionable desktop message', () => {
    const error = new Error(
      "Error invoking remote method 'desktop:getStatus': Error: 502 Bad Gateway: HCC status check failed"
    )

    expect(getDesktopErrorMessage(error)).toBe(
      'Desktop is unavailable because the backend readiness check failed. Refresh port-forwards and verify HCC/rpc-proxy desktop health before retrying.'
    )
  })

  it('preserves unknown desktop errors', () => {
    expect(getDesktopErrorMessage(new Error('Unexpected desktop failure'))).toBe(
      'Unexpected desktop failure'
    )
  })

  it('does not map unrelated desktop:getStatus errors containing 5020', () => {
    expect(
      getDesktopErrorMessage(
        new Error("Error invoking remote method 'desktop:getStatus': Error: upstream 5020")
      )
    ).toBe("Error invoking remote method 'desktop:getStatus': Error: upstream 5020")
  })
})
