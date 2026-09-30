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

function literalUrl(ip: string): URL {
  return ip.includes(':') ? new URL(`http://[${ip}]/`) : new URL(`http://${ip}/`)
}

const BLOCKED_SPECIAL_PURPOSE_ADDRESSES: readonly (readonly [string, string])[] = [
  ['100.64.0.1', 'CGNAT (RFC 6598)'],
  ['198.18.0.1', 'benchmarking (RFC 2544)'],
  ['224.0.0.1', 'IPv4 multicast'],
  ['240.0.0.1', 'IPv4 reserved'],
  ['255.255.255.255', 'IPv4 broadcast'],
  ['64:ff9b::a9fe:a9fe', 'NAT64-wrapped cloud metadata'],
  ['2002:a00:1::', '6to4-wrapped private IPv4'],
  ['ff02::1', 'IPv6 multicast'],
]

describe('resolvePinnedPublicIp', () => {
  it('returns a public IP literal unchanged (no DNS)', async () => {
    await expect(resolvePinnedPublicIp(new URL('https://8.8.8.8/x'))).resolves.toBe('8.8.8.8')
    expect(resolve4).not.toHaveBeenCalled()
    expect(resolve6).not.toHaveBeenCalled()
  })

  it('rejects a private IP literal', async () => {
    await expect(resolvePinnedPublicIp(new URL('http://10.0.0.5/'))).rejects.toBeInstanceOf(
      SsrfBlockedError
    )
    expect(resolve4).not.toHaveBeenCalled()
    expect(resolve6).not.toHaveBeenCalled()
  })

  it('rejects the cloud-metadata IP literal', async () => {
    await expect(
      resolvePinnedPublicIp(new URL('http://169.254.169.254/latest/meta-data/'))
    ).rejects.toThrow(/private IP/)
    expect(resolve4).not.toHaveBeenCalled()
    expect(resolve6).not.toHaveBeenCalled()
  })

  it('returns a public IPv6 literal unchanged (no DNS)', async () => {
    await expect(resolvePinnedPublicIp(new URL('https://[2606:4700:4700::1111]/'))).resolves.toBe(
      '2606:4700:4700::1111'
    )
    expect(resolve4).not.toHaveBeenCalled()
    expect(resolve6).not.toHaveBeenCalled()
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

  it.each(BLOCKED_SPECIAL_PURPOSE_ADDRESSES)(
    'rejects the %s IP literal (%s)',
    async (ip: string) => {
      const outcome = resolvePinnedPublicIp(literalUrl(ip))
      await expect(outcome).rejects.toBeInstanceOf(SsrfBlockedError)
      await expect(outcome).rejects.toThrow(`Target is a private IP (${ip})`)
      expect(resolve4).not.toHaveBeenCalled()
      expect(resolve6).not.toHaveBeenCalled()
    }
  )

  it.each(BLOCKED_SPECIAL_PURPOSE_ADDRESSES)(
    'rejects a hostname resolving to %s (%s)',
    async (ip: string) => {
      const isV6 = ip.includes(':')
      resolve4.mockResolvedValue(isV6 ? [] : [ip])
      resolve6.mockResolvedValue(isV6 ? [ip] : [])
      const outcome = resolvePinnedPublicIp(new URL('https://blocked.example.com/'))
      await expect(outcome).rejects.toBeInstanceOf(SsrfBlockedError)
      await expect(outcome).rejects.toThrow(`Domain resolves to private IP (${ip})`)
    }
  )

  it.each([
    ['64:ff9b::808:808', 'NAT64 form of public 8.8.8.8'],
    ['2002:808:808::', '6to4 form of public 8.8.8.8'],
  ])(
    'rejects the %s literal outright (%s): prefix policy without embedded-IPv4 extraction',
    async (ip: string) => {
      const outcome = resolvePinnedPublicIp(literalUrl(ip))
      await expect(outcome).rejects.toBeInstanceOf(SsrfBlockedError)
      await expect(outcome).rejects.toThrow(`Target is a private IP (${ip})`)
      expect(resolve4).not.toHaveBeenCalled()
      expect(resolve6).not.toHaveBeenCalled()
    }
  )

  it('rejects a hostname with a public A record and a NAT64 AAAA record (DNS64 policy)', async () => {
    resolve4.mockResolvedValue(['93.184.216.34'])
    resolve6.mockResolvedValue(['64:ff9b::808:808'])
    const outcome = resolvePinnedPublicIp(new URL('https://dns64.example.com/'))
    await expect(outcome).rejects.toBeInstanceOf(SsrfBlockedError)
    await expect(outcome).rejects.toThrow('Domain resolves to private IP (64:ff9b::808:808)')
  })
})

describe('requestPinned — bounded in time and bytes', () => {
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
