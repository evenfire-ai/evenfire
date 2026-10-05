import { describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { ExecutionInputTransport } from './inputTransport'
import { EXECUTION_POD_UID_HEADER } from './resultTransport'

const target = { podUid: '00000000-1111-4111-8111-000000000004', podIp: '10.244.0.7' }
const headers = { [EXECUTION_POD_UID_HEADER]: target.podUid }

describe('private execution input transport', () => {
  it('probes the fixed input listener without reading the original', async () => {
    const probe = vi.fn<typeof fetch>(async () => new Response(null, { status: 204, headers }))
    await expect(new ExecutionInputTransport(5_000, probe).ready(target)).resolves.toBe(true)
    expect(probe).toHaveBeenCalledWith(
      'http://10.244.0.7:9301/ready',
      expect.objectContaining({
        method: 'GET',
        headers,
        redirect: 'error',
        signal: expect.any(AbortSignal),
      })
    )
  })

  it('distinguishes initial listener refusal from every other failure', async () => {
    const probe = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(
        Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('fetch failed'), { cause: { code: 'ENETUNREACH' } })
      )
    const transport = new ExecutionInputTransport(5_000, probe)
    await expect(transport.ready(target)).resolves.toBe(false)
    await expect(transport.ready(target)).rejects.toThrow('fetch failed')
  })

  it('streams a single opaque POST with a bound length, UID and real abort signal', async () => {
    const input = Readable.from([Buffer.from([0, 255, 17])])
    const send = vi.fn<typeof fetch>(async (_url, init) => {
      const chunks: Buffer[] = []
      for await (const chunk of init!.body as Readable) chunks.push(chunk)
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 255, 17]))
      return new Response(null, { status: 204, headers })
    })
    await new ExecutionInputTransport(5_000, send).send(target, input, 3)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      'http://10.244.0.7:9301/input',
      expect.objectContaining({
        method: 'POST',
        duplex: 'half',
        body: input,
        redirect: 'error',
        headers: { ...headers, 'content-type': 'application/octet-stream', 'content-length': '3' },
        signal: expect.any(AbortSignal),
      })
    )
    expect(input.destroyed).toBe(true)
  })

  it('never resends an ambiguous or rejected delivery and closes its stream', async () => {
    for (const failure of ['network', 'foreign', 'rejected']) {
      const input = Readable.from([Buffer.from('private')])
      const send = vi.fn<typeof fetch>(async () => {
        if (failure === 'network') throw new Error('delivery unknown')
        return new Response(null, {
          status: failure === 'rejected' ? 400 : 204,
          headers: failure === 'foreign' ? { [EXECUTION_POD_UID_HEADER]: 'other' } : headers,
        })
      })
      await expect(
        new ExecutionInputTransport(5_000, send).send(target, input, 7)
      ).rejects.toThrow()
      expect(send).toHaveBeenCalledTimes(1)
      expect(input.destroyed).toBe(true)
    }
  })

  it('rejects a bad target or size before I/O', async () => {
    const send = vi.fn<typeof fetch>()
    const transport = new ExecutionInputTransport(5_000, send)
    await expect(
      transport.send({ ...target, podIp: '127.0.0.1' }, Readable.from([]), 0)
    ).rejects.toThrow('execution_result_target_invalid')
    await expect(transport.send(target, Readable.from([]), 11_534_337)).rejects.toThrow(
      'execution_input_contract_invalid'
    )
    expect(send).not.toHaveBeenCalled()
  })
})
