/**
 * SSRF guard tests: `resolvePinnedPublicIp` must reject private/metadata targets
 * (literal and DNS-resolved), fail closed on unresolvable hosts, and pin a
 * validated public IP. `isPrivateIp` range classification is covered in
 * core/tools/__tests__/shellAndHttp.test.ts (same implementation, re-exported).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as dns from 'dns/promises'
import { SsrfBlockedError, resolvePinnedPublicIp } from '../ssrf'

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
