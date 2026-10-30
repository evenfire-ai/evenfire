import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { MAX_BODY_BYTES, MAX_DRAIN_BYTES, parseJsonBody } from './server'

// Mirrors the WRC POST handlers: parse, then answer 413/400 on failure.
let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const parsed = await parseJsonBody(req)
    if (!parsed.ok) {
      res.writeHead(parsed.reason === 'too_large' ? 413 : 400, {
        'Content-Type': 'application/json',
      })
      res.end(JSON.stringify({ error: parsed.reason, bytesRead: parsed.bytesRead }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
})

const jsonBody = (bytes: number) => JSON.stringify({ output: 'x'.repeat(bytes) })

describe('WRC request body limit over a real socket', () => {
  it('accepts a body under the limit', async () => {
    const resp = await fetch(`${baseUrl}/status`, { method: 'POST', body: jsonBody(400_000) })
    expect(resp.status).toBe(200)
  })

  it('answers an oversized body with a readable HTTP 413 instead of resetting the socket', async () => {
    const body = jsonBody(620_000)
    const resp = await fetch(`${baseUrl}/status`, { method: 'POST', body })
    expect(resp.status).toBe(413)
    const payload = (await resp.json()) as { error: string; bytesRead: number }
    expect(payload.error).toBe('too_large')
    expect(payload.bytesRead).toBe(Buffer.byteLength(body))
    expect(payload.bytesRead).toBeGreaterThan(MAX_BODY_BYTES)
  })

  it('keeps serving requests after a 413', async () => {
    await fetch(`${baseUrl}/status`, { method: 'POST', body: jsonBody(620_000) })
    const resp = await fetch(`${baseUrl}/status`, { method: 'POST', body: '{"ok":true}' })
    expect(resp.status).toBe(200)
  })

  it('still drops the connection past the drain cap rather than reading without bound', async () => {
    await expect(
      fetch(`${baseUrl}/status`, { method: 'POST', body: jsonBody(MAX_DRAIN_BYTES + 1024) })
    ).rejects.toThrow('fetch failed')
  })

  it('drops a chunked upload without Content-Length once it passes the drain cap', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x78)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_DRAIN_BYTES * 2) return controller.close()
        sent += chunk.length
        controller.enqueue(chunk)
      },
    })
    await expect(
      fetch(`${baseUrl}/status`, { method: 'POST', body, duplex: 'half' } as RequestInit)
    ).rejects.toThrow('fetch failed')
    expect(sent).toBeLessThan(MAX_DRAIN_BYTES * 2)
  })
})

describe('parseJsonBody', () => {
  it('rejects a declared Content-Length past the drain cap before reading', async () => {
    const request = Object.assign(new PassThrough(), {
      headers: { 'content-length': String(MAX_DRAIN_BYTES + 1) },
    })
    const destroy = vi.spyOn(request, 'destroy')
    await expect(parseJsonBody(request as never)).resolves.toEqual({
      ok: false,
      reason: 'too_large',
      bytesRead: 0,
    })
    expect(destroy).toHaveBeenCalled()
  })

  it('decodes a multi-byte character split across chunks', async () => {
    const request = new PassThrough()
    const parsed = parseJsonBody(request as never)
    const bytes = Buffer.from('{"text":"é"}')
    const split = bytes.indexOf(Buffer.from('é')) + 1
    request.write(bytes.subarray(0, split))
    request.end(bytes.subarray(split))
    await expect(parsed).resolves.toEqual({ ok: true, body: { text: 'é' } })
  })
})
