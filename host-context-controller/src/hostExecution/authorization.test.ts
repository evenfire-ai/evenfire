import { describe, expect, it, vi } from 'vitest'
import type { VerifiedMcpHostPrincipal } from '../mcpApiAuthentication'
import {
  HostExecutionAuthorization,
  HostExecutionAuthorizationError,
  HostExecutionAuthorizationErrorCode,
  HostExecutionBinding,
  HostExecutionHostRecord,
  ReadHostRecord,
} from './authorization'

const HOST_UID = '9f0e3a5c-5f1e-4a4e-9a2d-3f4c5b6a7d8e'

const principal: VerifiedMcpHostPrincipal = {
  subject: 'mcp-host/standalone',
  hostName: 'chatllm',
  hostUid: HOST_UID,
  namespace: 'mcp-host',
  jti: 'jti-0001',
  issuedAt: 1_700_000_000,
  expiresAt: 4_102_444_800,
  audiences: ['host-context-controller'],
  nativeExecutionAllowed: true,
}

const liveHost: HostExecutionHostRecord = {
  name: 'chatllm',
  namespace: 'mcp-host',
  uid: HOST_UID,
  generation: 7,
}

/** Reader stub that records calls and serves the supplied sequence. */
function reader(...records: Array<HostExecutionHostRecord | null | undefined>) {
  const calls: Array<[string, string]> = []
  const readHost = (async (name: string, namespace: string) => {
    calls.push([name, namespace])
    return records.length > 1 ? records.shift() : records[0]
  }) as ReadHostRecord
  return { readHost, calls }
}

async function rejection(run: () => Promise<unknown>): Promise<HostExecutionAuthorizationError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof HostExecutionAuthorizationError) return error
    throw error
  }
  throw new Error('expected HostExecutionAuthorizationError')
}

function expectCode(
  error: HostExecutionAuthorizationError,
  code: HostExecutionAuthorizationErrorCode
) {
  expect(error.code).toBe(code)
  expect(error.message).toBe(code)
}

async function bindingFor(
  authorization: HostExecutionAuthorization
): Promise<HostExecutionBinding> {
  return authorization.authorize(principal)
}

describe('Host execution authorization', () => {
  it('binds a granted principal to the live Host it names', async () => {
    const { readHost, calls } = reader(liveHost)
    const binding = await bindingFor(new HostExecutionAuthorization(readHost))

    expect(calls).toEqual([['chatllm', 'mcp-host']])
    expect(binding).toEqual({
      hostName: 'chatllm',
      hostUid: HOST_UID,
      namespace: 'mcp-host',
      generation: 7,
    })
    expect(Object.isFrozen(binding)).toBe(true)
    expect(() => {
      ;(binding as { hostUid: string }).hostUid = 'foreign'
    }).toThrow()
  })

  it('revalidates against the live Host and tolerates resourceVersion churn', async () => {
    const churned = { ...liveHost, resourceVersion: '2031' }
    const { readHost, calls } = reader(liveHost, churned)
    const authorization = new HostExecutionAuthorization(readHost)
    const binding = await bindingFor(authorization)

    await expect(authorization.revalidate(principal, binding)).resolves.toBeUndefined()
    expect(calls).toEqual([
      ['chatllm', 'mcp-host'],
      ['chatllm', 'mcp-host'],
    ])
  })

  it('waits for the live re-read and rejects a generation change after it', async () => {
    let release!: (record: HostExecutionHostRecord) => void
    const pending = new Promise<HostExecutionHostRecord>(resolve => {
      release = resolve
    })
    const authorization = new HostExecutionAuthorization(() => pending)
    const binding: HostExecutionBinding = Object.freeze({
      hostName: 'chatllm',
      hostUid: HOST_UID,
      namespace: 'mcp-host',
      generation: 7,
    })

    let outcome = ''
    const attempt = authorization.revalidate(principal, binding).then(
      () => {
        outcome = 'resolved'
      },
      (error: HostExecutionAuthorizationError) => {
        outcome = error.code
      }
    )
    await Promise.resolve()
    expect(outcome).toBe('')

    release({ ...liveHost, generation: 8 })
    await attempt
    expect(outcome).toBe('host_generation_changed')
  })

  it('requires the signed native execution scope before any read', async () => {
    const forged = [
      { ...principal, nativeExecutionAllowed: undefined },
      { ...principal, nativeExecutionAllowed: 1 as unknown as true },
      { ...principal, nativeExecutionAllowed: 'true' as unknown as true },
    ]
    for (const candidate of forged) {
      const { readHost, calls } = reader(liveHost)
      const error = await rejection(() =>
        new HostExecutionAuthorization(readHost).authorize(candidate)
      )
      expectCode(error, 'native_execution_not_authorized')
      expect(calls).toEqual([])
    }
  })

  it('rejects an expired principal before any read, in both directions', async () => {
    const expired = { ...principal, expiresAt: Math.floor(Date.now() / 1000) - 1 }
    const { readHost, calls } = reader(liveHost)
    const authorization = new HostExecutionAuthorization(readHost)

    expectCode(await rejection(() => authorization.authorize(expired)), 'principal_expired')
    const binding = await bindingFor(authorization)
    expectCode(
      await rejection(() => authorization.revalidate(expired, binding)),
      'principal_expired'
    )
    expect(calls).toEqual([['chatllm', 'mcp-host']])
  })

  it('withholds authority when the grant expires while the authorize read is pending', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-05T10:00:00Z'))
      const starting = Math.floor(Date.now() / 1000)
      const calls: Array<[string, string]> = []
      let release!: (record: HostExecutionHostRecord) => void
      const pending = new Promise<HostExecutionHostRecord>(resolve => {
        release = resolve
      })
      const authorization = new HostExecutionAuthorization(async (name, namespace) => {
        calls.push([name, namespace])
        return pending
      })

      let outcome = ''
      const attempt = authorization.authorize({ ...principal, expiresAt: starting + 5 }).then(
        binding => {
          outcome = `granted:${binding.generation}`
        },
        (error: HostExecutionAuthorizationError) => {
          outcome = error.code
        }
      )
      await Promise.resolve()
      expect(outcome).toBe('')
      expect(calls).toEqual([['chatllm', 'mcp-host']])

      vi.setSystemTime(new Date('2026-10-05T10:00:06Z'))
      release(liveHost)
      await attempt
      expect(outcome).toBe('principal_expired')
    } finally {
      vi.useRealTimers()
    }
  })

  it('withholds confirmation when the grant expires while the revalidate read is pending', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-05T10:00:00Z'))
      const starting = Math.floor(Date.now() / 1000)
      const expiring = { ...principal, expiresAt: starting + 5 }
      const binding = await bindingFor(new HostExecutionAuthorization(reader(liveHost).readHost))

      let release!: (record: HostExecutionHostRecord) => void
      const pending = new Promise<HostExecutionHostRecord>(resolve => {
        release = resolve
      })
      const authorization = new HostExecutionAuthorization(() => pending)

      let outcome = ''
      const attempt = authorization.revalidate(expiring, binding).then(
        () => {
          outcome = 'confirmed'
        },
        (error: HostExecutionAuthorizationError) => {
          outcome = error.code
        }
      )
      await Promise.resolve()
      expect(outcome).toBe('')

      vi.setSystemTime(new Date('2026-10-05T10:00:06Z'))
      release(liveHost)
      await attempt
      expect(outcome).toBe('principal_expired')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never defaults a missing or malformed principal identity', async () => {
    // Kubernetes bounds: Host name is a DNS-1123 subdomain (<=253, dot-joined
    // labels), namespace is a DNS-1123 label (<=63, no dots).
    const longName = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.')
    const malformed = [
      { ...principal, hostName: '' },
      { ...principal, hostName: 'ChatLLM' },
      { ...principal, hostName: 'chatllm_1' },
      { ...principal, hostName: 'chatllm..internal' },
      { ...principal, hostName: `${longName}a` },
      { ...principal, hostUid: '' },
      { ...principal, hostUid: 'uid with spaces' },
      { ...principal, namespace: '' },
      { ...principal, namespace: 'Bad_Namespace' },
      { ...principal, namespace: 'a'.repeat(64) },
      { ...principal, namespace: 'mcp.host' },
      { ...principal, expiresAt: Number.NaN },
    ]
    for (const candidate of malformed) {
      const { readHost, calls } = reader(liveHost)
      expectCode(
        await rejection(() => new HostExecutionAuthorization(readHost).authorize(candidate)),
        'principal_invalid'
      )
      expect(calls).toEqual([])
    }
    const noUid = { ...principal } as Partial<VerifiedMcpHostPrincipal>
    delete noUid.hostUid
    const { readHost, calls } = reader(liveHost)
    expectCode(
      await rejection(() =>
        new HostExecutionAuthorization(readHost).authorize(noUid as VerifiedMcpHostPrincipal)
      ),
      'principal_invalid'
    )
    expect(calls).toEqual([])
  })

  it('accepts a dotted or 253-character Host subdomain with a label namespace', async () => {
    const longestName = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.')
    expect(longestName).toHaveLength(253)
    for (const hostName of ['chatllm.tenant-1', longestName]) {
      const { readHost, calls } = reader({ ...liveHost, name: hostName })
      const binding = await new HostExecutionAuthorization(readHost).authorize({
        ...principal,
        hostName,
      })
      expect(binding.hostName).toBe(hostName)
      expect(calls).toEqual([[hostName, 'mcp-host']])
    }
  })

  it('rejects a missing Host record instead of granting by name alone', async () => {
    const missing = reader(null)
    expectCode(
      await rejection(() => bindingFor(new HostExecutionAuthorization(missing.readHost))),
      'host_not_found'
    )
    const absent = reader(undefined)
    expectCode(
      await rejection(() => bindingFor(new HostExecutionAuthorization(absent.readHost))),
      'host_not_found'
    )
  })

  it('rejects a foreign UID for the requested Host name', async () => {
    const foreign = reader({ ...liveHost, uid: 'a1b2c3d4-0000-4000-8000-000000000000' })
    expectCode(
      await rejection(() => bindingFor(new HostExecutionAuthorization(foreign.readHost))),
      'host_identity_mismatch'
    )
  })

  it('rejects a record for another Host name or namespace', async () => {
    for (const record of [
      { ...liveHost, name: 'other-host' },
      { ...liveHost, namespace: 'other-namespace' },
    ]) {
      const { readHost } = reader(record)
      expectCode(
        await rejection(() => bindingFor(new HostExecutionAuthorization(readHost))),
        'host_identity_mismatch'
      )
    }
  })

  it('rejects a deleting Host on authorize and on revalidate', async () => {
    const deleting = { ...liveHost, deletionTimestamp: '2026-10-05T10:00:00Z' }
    const first = reader(deleting)
    expectCode(
      await rejection(() => bindingFor(new HostExecutionAuthorization(first.readHost))),
      'host_deleted'
    )
    const second = reader(liveHost, deleting)
    const authorization = new HostExecutionAuthorization(second.readHost)
    const binding = await bindingFor(authorization)
    expectCode(await rejection(() => authorization.revalidate(principal, binding)), 'host_deleted')
  })

  it('rejects a malformed live record or generation', async () => {
    const malformed: unknown[] = [
      { ...liveHost, generation: 0 },
      { ...liveHost, generation: -1 },
      { ...liveHost, generation: 1.5 },
      { ...liveHost, generation: Number.NaN },
      { ...liveHost, generation: '3' },
      { ...liveHost, uid: '' },
      { ...liveHost, name: 42 },
      'chatllm',
    ]
    for (const record of malformed) {
      const { readHost } = reader(record as HostExecutionHostRecord)
      expectCode(
        await rejection(() => bindingFor(new HostExecutionAuthorization(readHost))),
        'host_record_invalid'
      )
    }
  })

  it('rejects a recreated Host UID after authorize', async () => {
    const recreated = { ...liveHost, uid: 'b1b2c3d4-1111-4111-8111-111111111111' }
    const { readHost } = reader(liveHost, recreated)
    const authorization = new HostExecutionAuthorization(readHost)
    const binding = await bindingFor(authorization)

    expectCode(
      await rejection(() => authorization.revalidate(principal, binding)),
      'host_uid_recreated'
    )
  })

  it('rejects a changed generation and a mismatched live namespace after authorize', async () => {
    const generation = reader(liveHost, { ...liveHost, generation: 8 })
    const first = new HostExecutionAuthorization(generation.readHost)
    const firstBinding = await bindingFor(first)
    expectCode(
      await rejection(() => first.revalidate(principal, firstBinding)),
      'host_generation_changed'
    )

    const namespace = reader(liveHost, { ...liveHost, namespace: 'other-namespace' })
    const second = new HostExecutionAuthorization(namespace.readHost)
    const secondBinding = await bindingFor(second)
    expectCode(
      await rejection(() => second.revalidate(principal, secondBinding)),
      'host_identity_mismatch'
    )
  })

  it('rejects a binding that belongs to another principal before reading', async () => {
    const { readHost, calls } = reader(liveHost)
    const authorization = new HostExecutionAuthorization(readHost)
    const foreignBinding: HostExecutionBinding = Object.freeze({
      hostName: 'other-host',
      hostUid: HOST_UID,
      namespace: 'mcp-host',
      generation: 7,
    })

    expectCode(
      await rejection(() => authorization.revalidate(principal, foreignBinding)),
      'host_identity_mismatch'
    )
    const foreignUid = Object.freeze({
      ...foreignBinding,
      hostUid: 'c1b2c3d4-2222-4222-8222-222222222222',
    })
    expectCode(
      await rejection(() => authorization.revalidate(principal, foreignUid)),
      'host_identity_mismatch'
    )
    expect(calls).toEqual([])
  })

  it('reports fixed codes without leaking token or actor material', async () => {
    const cases: Array<[VerifiedMcpHostPrincipal, HostExecutionHostRecord | null]> = [
      [{ ...principal, nativeExecutionAllowed: undefined }, liveHost],
      [{ ...principal, expiresAt: 1 }, liveHost],
      [principal, null],
      [principal, { ...liveHost, uid: 'foreign-uid' }],
    ]
    for (const [candidate, record] of cases) {
      const { readHost } = reader(record)
      const error = await rejection(() =>
        new HostExecutionAuthorization(readHost).authorize(candidate)
      )
      expect(error.message).toBe(error.code)
      for (const secret of [principal.jti, principal.subject, 'jti-0001']) {
        expect(error.message).not.toContain(secret)
      }
    }
  })
})
