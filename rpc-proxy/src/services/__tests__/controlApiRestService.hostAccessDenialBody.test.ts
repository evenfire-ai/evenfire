import { describe, expect, it } from 'vitest'
import {
  ControlApiHostAccessRejectedError,
  fetchHostConnectionFromControlApi,
} from '../controlApiRestService.js'

// control-api's 403 for a Host-access denial carries its reason in a header and
// a fixed body the proxy never parses. The body must still be read to the end:
// an unread response body keeps the upstream connection checked out until the
// garbage collector finds it. The stand-in Response streams its body in chunks
// and reports when the last one was consumed, so "drained" is observed on the
// stream itself, not inferred from the mapped code.

const REASON_HEADER = 'x-host-access-denial-reason'
const CHUNKS = 3

function streamedDenial(reason: string): {
  response: Response
  state: { pulls: number; drained: boolean }
} {
  const state = { pulls: 0, drained: false }
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls += 1
      controller.enqueue(encoder.encode('{"error":"Forbidden"}'))
      if (state.pulls >= CHUNKS) {
        controller.close()
        state.drained = true
      }
    },
  })
  return {
    response: new Response(body, { status: 403, headers: { [REASON_HEADER]: reason } }),
    state,
  }
}

const BINDING = { runId: 'run-1', sessionId: 'session-1', origin: 'direct_chat' } as const

describe('fetchHostConnectionFromControlApi 403 body', () => {
  it('reads the whole 403 body of a host lookup before returning the denial code', async () => {
    const { response, state } = streamedDenial('team_membership_missing')

    const resolved = await fetchHostConnectionFromControlApi('user-1', 'host-1', 'token', {
      fetchImpl: async () => response,
    })

    // Liveness witness: the reason header was read and mapped, so the 403 branch ran.
    expect(resolved).toEqual({ denied: true, code: 'host_access_revoked' })
    expect(response.bodyUsed).toBe(true)
    expect(state.drained).toBe(true)
    expect(state.pulls).toBe(CHUNKS)
  })

  it('reads the whole 403 body of a direct-run lookup before throwing the rejection', async () => {
    const { response, state } = streamedDenial('host_disabled')

    const error = await fetchHostConnectionFromControlApi('user-1', 'host-1', 'token', {
      directRunBinding: BINDING,
      fetchImpl: async () => response,
    }).then(
      () => {
        throw new Error('expected the direct-run lookup to reject')
      },
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(ControlApiHostAccessRejectedError)
    expect((error as ControlApiHostAccessRejectedError).denialCode).toBe('host_access_denied')
    expect(response.bodyUsed).toBe(true)
    expect(state.drained).toBe(true)
    expect(state.pulls).toBe(CHUNKS)
  })
})
