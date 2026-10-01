import { describe, expect, it } from 'vitest'
import type { LookupFunction } from 'node:net'
import { type PinnedTransport, pinnedFetch } from '../src/http/pinnedFetch.js'
import type { DnsResolver } from '../src/http/validateMcpServerSpec.js'

/**
 * R2-L1 — the pin's security guarantee gets the unit net the docstring already
 * promised: the socket connects to the exact IP the kernel validated
 * (connectedIP === validatedIP), DNS resolves ONCE per hop (the re-resolution the
 * pin exists to prevent never happens), and the host stays the hostname (never the
 * IP) so SNI/Host/TLS keep verifying against it.
 *
 * The validated addresses flow through the REAL resolveValidatedOAuthEndpoint →
 * pinnedLookup (T1): the test injects only the DNS seam and a transport that
 * invokes the pinned lookup to observe the IP the socket would reach — no real
 * network.
 */

const VALIDATED_IP = '93.184.216.34' // public, non-blocked

function countingResolver(ips: string[]): { resolveDns: DnsResolver; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    resolveDns: async (hostname: string) => {
      calls.push(hostname)
      return ips
    },
  }
}

/**
 * A transport that invokes the pinned lookup exactly as `node:https` would, to
 * record the IP the socket would connect to — with no real network.
 */
function observingTransport(): {
  transport: PinnedTransport
  seen: { url: string; connectedIps: string[]; invoked: boolean }
} {
  const seen = { url: '', connectedIps: [] as string[], invoked: false }
  const transport: PinnedTransport = input =>
    new Promise((resolve, reject) => {
      seen.invoked = true
      seen.url = input.url
      const hostname = new URL(input.url).hostname
      ;(input.lookup as LookupFunction)(hostname, { all: true }, (err, addrs) => {
        if (err) {
          reject(err)
          return
        }
        const list = Array.isArray(addrs) ? addrs.map(a => a.address) : [addrs as unknown as string]
        seen.connectedIps.push(...list)
        resolve({ status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{}' })
      })
    })
  return { transport, seen }
}

describe('pinnedFetch — the socket pins to the validated IP (R2-L1)', () => {
  it('connectedIP === validatedIP and resolveDns runs exactly once per hop', async () => {
    const { resolveDns, calls } = countingResolver([VALIDATED_IP])
    const { transport, seen } = observingTransport()

    const result = await pinnedFetch(
      'https://as.example.com/.well-known/oauth-authorization-server',
      'test',
      {
        resolveDns,
        transport,
      }
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // The socket pinned to the exact IP the kernel validated.
    expect(seen.connectedIps).toEqual([VALIDATED_IP])
    expect(result.response.pinnedAddresses).toEqual([VALIDATED_IP])
    // DNS resolved exactly once — no second resolution to slip a private IP in.
    expect(calls).toEqual(['as.example.com'])
    // Host stays the hostname (never the IP) so SNI/Host/TLS verify against it.
    expect(new URL(seen.url).hostname).toBe('as.example.com')
  })

  it('a hostname resolving only to a blocked IP is never fetched (fail closed)', async () => {
    const { resolveDns } = countingResolver(['169.254.169.254']) // link-local metadata
    const { transport, seen } = observingTransport()

    const result = await pinnedFetch('https://evil.example.com/x', 'test', {
      resolveDns,
      transport,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('kernel_rejected')
    // The transport was never reached — no connection attempt to a blocked IP.
    expect(seen.invoked).toBe(false)
  })
})
