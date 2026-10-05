import { describe, expect, it, vi } from 'vitest'
import { EXECUTION_RESULT_MAX_BYTES } from './result'
import { EXECUTION_POD_UID_HEADER, ExecutionResultTransport } from './resultTransport'

const target = { podUid: '00000000-1111-4111-8111-000000000004', podIp: '10.244.0.7' }
const headers = { [EXECUTION_POD_UID_HEADER]: target.podUid, 'content-type': 'application/json' }

describe('private execution result transport', () => {
  it('requests only the fixed Pod port/path with UID binding and a finite abort signal', async () => {
    const read = vi.fn<typeof fetch>(async () => new Response('{"result":"bounded"}', { headers }))
    await expect(new ExecutionResultTransport(5_000, read).read(target)).resolves.toBe(
      '{"result":"bounded"}'
    )
    expect(read).toHaveBeenCalledWith('http://10.244.0.7:9300/result', {
      method: 'GET',
      headers: { [EXECUTION_POD_UID_HEADER]: target.podUid, 'cache-control': 'no-store' },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    })
  })

  it('treats readiness separately from failures and never delivers a reused-IP result', async () => {
    const read = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 425, headers }))
      .mockResolvedValueOnce(
        new Response('foreign result', {
          headers: { ...headers, [EXECUTION_POD_UID_HEADER]: 'foreign-pod' },
        })
      )
    const transport = new ExecutionResultTransport(5_000, read)
    await expect(transport.read(target)).resolves.toBeNull()
    await expect(transport.read(target)).rejects.toThrow('execution_result_binding_mismatch')
  })

  it('rejects caller URLs, loopback, link-local, multicast and malformed identity before I/O', async () => {
    const read = vi.fn<typeof fetch>()
    const transport = new ExecutionResultTransport(5_000, read)
    for (const podIp of [
      'http://host/path',
      '127.0.0.1',
      '169.254.1.2',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fe80::1',
      'ff00::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '0:0:0:0:0:0:0:1',
    ]) {
      await expect(transport.read({ ...target, podIp })).rejects.toThrow(
        'execution_result_target_invalid'
      )
    }
    await expect(transport.read({ ...target, podUid: 'caller-supplied-name' })).rejects.toThrow(
      'execution_result_target_invalid'
    )
    expect(read).not.toHaveBeenCalled()
  })

  it('supports an actual IPv6 Pod address without caller-selected syntax', async () => {
    const read = vi.fn<typeof fetch>(async () => new Response('{}', { headers }))
    await new ExecutionResultTransport(5_000, read).read({ ...target, podIp: 'fd00::17' })
    expect(read.mock.calls[0]?.[0]).toBe('http://[fd00::17]:9300/result')
  })

  it('bounds streamed bytes even when no content length is present', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(EXECUTION_RESULT_MAX_BYTES + 1))
      },
      cancel() {
        cancelled = true
      },
    })
    const read = vi.fn<typeof fetch>(async () => new Response(body, { headers }))
    await expect(new ExecutionResultTransport(5_000, read).read(target)).rejects.toThrow(
      'execution_result_invalid'
    )
    expect(cancelled).toBe(true)
  })

  it('rejects an oversized declared body, non-JSON response and unavailable endpoint', async () => {
    for (const response of [
      new Response('{}', {
        headers: { ...headers, 'content-length': String(EXECUTION_RESULT_MAX_BYTES + 1) },
      }),
      new Response('{}', { headers: { ...headers, 'content-type': 'text/html' } }),
      new Response('{}', { status: 503, headers }),
    ]) {
      const read = vi.fn<typeof fetch>(async () => response)
      await expect(new ExecutionResultTransport(5_000, read).read(target)).rejects.toThrow(
        /execution_result_(invalid|unavailable)/
      )
    }
  })

  it('clears only the same Pod result and keeps a failed clear pending', async () => {
    const read = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204, headers }))
      .mockResolvedValueOnce(new Response(null, { status: 503, headers }))
    const transport = new ExecutionResultTransport(5_000, read)
    await expect(transport.clear(target)).resolves.toBeUndefined()
    expect(read.mock.calls[0]?.[1]?.method).toBe('DELETE')
    await expect(transport.clear(target)).rejects.toThrow('execution_result_clear_pending')
  })
})
