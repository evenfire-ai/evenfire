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

  it('preserves temporary DNS failure as a typed transport cause', async () => {
    const dnsError = Object.assign(new Error('temporary name resolution failure'), {
      code: 'EAI_AGAIN',
    })
    const transport = observingTransport()
    const result = await pinnedFetch('https://as.example.com/token', 'test', {
      resolveDns: async () => {
        throw dnsError
      },
      transport: transport.transport,
    })

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'transport_failed', cause: 'transient_dns' },
    })
    expect(transport.seen.invoked).toBe(false)
  })

  it('does not classify a provider timeout diagnostic as the request deadline', async () => {
    const result = await pinnedFetch('https://as.example.com/token', 'test', {
      resolveDns: async () => [VALIDATED_IP],
      transport: async () => {
        throw new Error('upstream timeout while sending the request')
      },
    })

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'transport_failed', cause: 'transport_error' },
    })
  })

  it('classifies the actual bounded deadline independently from its error message', async () => {
    const result = await pinnedFetch('https://as.example.com/token', 'test', {
      timeoutMs: 1,
      resolveDns: async () => [VALIDATED_IP],
      transport: input =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
        }),
    })

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'transport_failed', cause: 'request_deadline' },
    })
  })

  it('rejects a public-to-private DNS change before the next request is connected', async () => {
    let resolutions = 0
    let secondTransportCalled = false
    const resolveDns = async () => {
      resolutions += 1
      return resolutions === 1 ? [VALIDATED_IP] : ['169.254.169.254']
    }
    const first = await pinnedFetch('https://as.example.com/discovery', 'test', {
      resolveDns,
      transport: observingTransport().transport,
    })
    expect(first.ok).toBe(true)

    const second = await pinnedFetch('https://as.example.com/token', 'test', {
      resolveDns,
      transport: async () => {
        secondTransportCalled = true
        return { status: 200, headers: {}, bodyText: '' }
      },
    })
    expect(second).toMatchObject({ ok: false, error: { kind: 'kernel_rejected' } })
    expect(resolutions).toBe(2)
    expect(secondTransportCalled).toBe(false)
  })

  it('propagates caller cancellation to the transport', async () => {
    const { resolveDns } = countingResolver([VALIDATED_IP])
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    let markTransportReady!: () => void
    const transportReady = new Promise<void>(resolve => {
      markTransportReady = resolve
    })
    const transport: PinnedTransport = input => {
      observedSignal = input.signal
      markTransportReady()
      return new Promise((_resolve, reject) => {
        if (input.signal.aborted) {
          reject(input.signal.reason)
          return
        }
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
      })
    }

    const pending = pinnedFetch('https://as.example.com/token', 'test', {
      resolveDns,
      transport,
      signal: controller.signal,
    })
    await transportReady
    controller.abort(new Error('test cancellation'))
    const result = await pending

    expect(observedSignal?.aborted).toBe(true)
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'transport_failed', cause: 'caller_cancelled' },
    })
  })

  it('does not resolve an endpoint after caller cancellation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('test cancellation'))
    let resolverCalled = false

    const result = await pinnedFetch('https://as.example.com/token', 'test', {
      signal: controller.signal,
      resolveDns: async () => {
        resolverCalled = true
        return [{ address: VALIDATED_IP, family: 4 }]
      },
    })

    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'transport_failed', cause: 'caller_cancelled' },
    })
    expect(resolverCalled).toBe(false)
  })
})
