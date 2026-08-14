/**
 * SSRF guard tests: `resolvePinnedPublicIp` must reject private/metadata targets
 * (literal and DNS-resolved), fail closed on unresolvable hosts, and pin a
 * validated public IP. `isPrivateIp` range classification is covered in
 * core/tools/__tests__/shellAndHttp.test.ts (same implementation, re-exported).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as dns from 'dns/promises'
import http from 'node:http'
import { SsrfBlockedError, requestPinned, resolvePinnedPublicIp } from '../ssrf'

vi.mock('dns/promises', () => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}))

const resolve4 = vi.mocked(dns.resolve4)
const resolve6 = vi.mocked(dns.resolve6)

afterEach(() => vi.clearAllMocks())

describe('resolvePinnedPublicIp', () => {
  it('returns a public IP literal unchanged (no DNS)', async () => {
    await expect(resolvePinnedPublicIp(new URL('https://8.8.8.8/x'))).resolves.toBe('8.8.8.8')
    expect(resolve4).not.toHaveBeenCalled()
  })

  it('rejects a private IP literal', async () => {
    await expect(resolvePinnedPublicIp(new URL('http://10.0.0.5/'))).rejects.toBeInstanceOf(
      SsrfBlockedError
    )
  })

  it('rejects the cloud-metadata IP literal', async () => {
    await expect(
      resolvePinnedPublicIp(new URL('http://169.254.169.254/latest/meta-data/'))
    ).rejects.toThrow(/private IP/)
  })

  it('resolves a hostname to a public IP and pins it', async () => {
    resolve4.mockResolvedValue(['93.184.216.34'])
    resolve6.mockRejectedValue(new Error('no AAAA'))
    await expect(resolvePinnedPublicIp(new URL('https://guardrails.aporia.com/v1'))).resolves.toBe(
      '93.184.216.34'
    )
  })

  it('rejects a hostname that resolves to a private IP (even via AAAA)', async () => {
    resolve4.mockResolvedValue(['93.184.216.34'])
    resolve6.mockResolvedValue(['::1']) // loopback hidden behind AAAA
    await expect(resolvePinnedPublicIp(new URL('https://sneaky.example.com/'))).rejects.toThrow(
      /private IP/
    )
  })

  it('fails closed when DNS resolution fails', async () => {
    resolve4.mockRejectedValue(new Error('nxdomain'))
    resolve6.mockRejectedValue(new Error('nxdomain'))
    await expect(resolvePinnedPublicIp(new URL('https://nope.invalid/'))).rejects.toThrow(
      /DNS resolution failed/
    )
  })
})

describe('requestPinned — bounded in time and bytes', () => {
  let server: http.Server
  let port: number
  const servers: http.Server[] = []

  async function startServer(handler: http.RequestListener): Promise<number> {
    const s = http.createServer(handler)
    servers.push(s)
    await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve))
    return (s.address() as { port: number }).port
  }

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))))
  })

  it('resolves a normal response (happy path preserved)', async () => {
    port = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    const out = await requestPinned({
      url: new URL(`http://localhost:${port}/`),
      method: 'GET',
      headers: {},
      pinnedIp: '127.0.0.1',
      timeoutMs: 5000,
    })
    expect(out.statusCode).toBe(200)
    expect(out.body).toBe('{"ok":true}')
  })

  it('rejects (does not buffer) once the body exceeds maxBytes', async () => {
    port = await startServer((_req, res) => {
      res.writeHead(200)
      res.end('x'.repeat(200_000)) // 200 KB, well over the cap below
    })
    await expect(
      requestPinned({
        url: new URL(`http://localhost:${port}/`),
        method: 'GET',
        headers: {},
        pinnedIp: '127.0.0.1',
        timeoutMs: 5000,
        maxBytes: 1024,
      })
    ).rejects.toThrow(/maxBytes/)
  })

  it('honors the abort signal even while the socket is active (absolute deadline)', async () => {
    // Server sends headers + a byte every 20ms and NEVER ends — a Node socket
    // idle timeout would keep resetting, but the abort must still settle it.
    port = await startServer((_req, res) => {
      res.writeHead(200)
      const t = setInterval(() => res.write('.'), 20)
      res.on('close', () => clearInterval(t))
    })
    const started = Date.now()
    await expect(
      requestPinned({
        url: new URL(`http://localhost:${port}/`),
        method: 'GET',
        headers: {},
        pinnedIp: '127.0.0.1',
        timeoutMs: 10_000, // idle timer would only fire at 10s
        signal: AbortSignal.timeout(80), // absolute deadline wins first
      })
    ).rejects.toThrow(/aborted/)
    expect(Date.now() - started).toBeLessThan(2000) // settled promptly, not at 10s
  })
})
