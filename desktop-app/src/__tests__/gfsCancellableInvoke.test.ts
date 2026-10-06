/**
 * R2-L3 — an already-aborted signal must start NO producer work: the invoke is
 * never sent and no gfs:abort event fires. Also pins the mid-flight contract:
 * requestId on the invoke, exactly one gfs:abort on abort, listener cleanup on
 * settle.
 */
import { describe, expect, it, vi } from 'vitest'
import { cancellableInvoke } from '../gfs/cancellableInvoke.js'

function bridge() {
  return {
    invoke: vi.fn(() => new Promise(() => undefined)),
    send: vi.fn(),
  }
}

describe('cancellableInvoke (R2-L3)', () => {
  it('starts no IPC or producer work for an already-aborted signal', async () => {
    const mockBridge = bridge()
    const controller = new AbortController()
    controller.abort()

    await expect(
      cancellableInvoke(mockBridge, 'gfs:listChildren', { resourceId: 'r' }, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(mockBridge.invoke).not.toHaveBeenCalled()
    expect(mockBridge.send).not.toHaveBeenCalled()
  })

  it('sends the requestId, fires gfs:abort exactly once on mid-flight abort, and detaches on settle', async () => {
    const mockBridge = bridge()
    const controller = new AbortController()

    const pending = cancellableInvoke(
      mockBridge,
      'gfs:download',
      { uri: 'gfs://main/x', maxBytes: 10 },
      controller.signal
    )
    expect(mockBridge.invoke).toHaveBeenCalledTimes(1)
    const payload = mockBridge.invoke.mock.calls[0]?.[1] as { requestId?: string }
    expect(typeof payload.requestId).toBe('string')

    controller.abort()
    expect(mockBridge.send).toHaveBeenCalledTimes(1)
    expect(mockBridge.send).toHaveBeenCalledWith('gfs:abort', { requestId: payload.requestId })
    // A second abort event (late listener) must not re-send after cleanup.
    controller.signal.dispatchEvent(new Event('abort'))
    pending.catch(() => undefined)
    await Promise.resolve()
    expect(mockBridge.send).toHaveBeenCalledTimes(1)
  })

  it('invokes without a signal exactly as a plain pass-through', async () => {
    const mockBridge = bridge()
    mockBridge.invoke.mockReturnValue(Promise.resolve({ ok: true }))
    const result = await cancellableInvoke<{ ok: boolean }>(mockBridge, 'gfs:resolve', {
      uri: 'gfs://main/x',
    })
    expect(result).toEqual({ ok: true })
    expect(mockBridge.invoke).toHaveBeenCalledWith('gfs:resolve', { uri: 'gfs://main/x' })
    expect(mockBridge.send).not.toHaveBeenCalled()
  })
})
