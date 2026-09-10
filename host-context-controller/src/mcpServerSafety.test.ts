import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  confirmAuthoritativeMcpServerAbsence,
  isMcpServerStatusOnlyUpdate,
  runtimeDesired,
  sameMcpServerDesiredRevision,
  sameMcpServerPolicyRevision,
} from './mcpServerSafety'
import type { McpServerCRD } from './types'

function makeServer(overrides: Partial<McpServerCRD> = {}): McpServerCRD {
  return {
    name: 'web-search',
    namespace: 'mcp-server',
    uid: 'web-search-uid',
    generation: 7,
    annotations: { 'clerum.io/recipe': 'research' },
    labels: { 'clerum.io/workload': 'web-search' },
    spec: {
      contextRef: 'default',
      image: 'clerum/web-search:test',
      transport: { type: 'streamableHttp', port: 3000 },
    },
    ...overrides,
  }
}

describe('sameMcpServerDesiredRevision', () => {
  it('matches equal desired state while ignoring status and one-sided identity metadata', () => {
    const expected = makeServer({
      status: { conditions: [{ type: 'Ready', status: 'False' }] },
    })
    const current = makeServer({
      uid: undefined,
      generation: undefined,
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    })

    expect(sameMcpServerDesiredRevision(expected, current)).toBe(true)
    expect(sameMcpServerDesiredRevision(current, expected)).toBe(true)
  })

  it('rejects a different resource key', () => {
    const expected = makeServer()

    expect(sameMcpServerDesiredRevision(expected, makeServer({ name: 'doc-generator' }))).toBe(
      false
    )
    expect(sameMcpServerDesiredRevision(expected, makeServer({ namespace: 'other' }))).toBe(false)
  })

  it('rejects differing UID or generation only when both sides provide the field', () => {
    const expected = makeServer()

    expect(sameMcpServerDesiredRevision(expected, makeServer({ uid: 'replacement-uid' }))).toBe(
      false
    )
    expect(sameMcpServerDesiredRevision(expected, makeServer({ generation: 8 }))).toBe(false)
    expect(sameMcpServerDesiredRevision(expected, makeServer({ uid: undefined }))).toBe(true)
    expect(sameMcpServerDesiredRevision(expected, makeServer({ generation: undefined }))).toBe(true)
  })

  it('compares desired object fields by semantic content, not Kubernetes map key order', () => {
    const expected = makeServer({
      annotations: { first: '1', second: '2' },
      labels: { first: '1', second: '2' },
    })

    expect(
      sameMcpServerDesiredRevision(
        expected,
        makeServer({
          spec: {
            ...expected.spec,
            image: 'clerum/web-search:next',
          },
          labels: expected.labels,
        })
      )
    ).toBe(false)
    expect(
      sameMcpServerDesiredRevision(
        expected,
        makeServer({
          annotations: { second: '2', first: '1' },
          labels: expected.labels,
        })
      )
    ).toBe(true)
    expect(
      sameMcpServerDesiredRevision(
        expected,
        makeServer({
          annotations: { 'clerum.io/recipe': 'other' },
          labels: expected.labels,
        })
      )
    ).toBe(false)
    expect(
      sameMcpServerDesiredRevision(
        expected,
        makeServer({
          labels: { second: '2', first: '1' },
          annotations: expected.annotations,
        })
      )
    ).toBe(true)
  })

  it('ignores the controller-owned network-ready handshake annotation', () => {
    const expected = makeServer({ annotations: { 'clerum.io/pre-deploy': 'true' } })
    const current = makeServer({
      annotations: {
        'clerum.io/pre-deploy': 'true',
        'clerum.io/network-ready': 'true',
      },
    })

    expect(sameMcpServerDesiredRevision(expected, current)).toBe(true)
    expect(sameMcpServerDesiredRevision(current, expected)).toBe(true)
  })

  it('S3: rejects a transport port change', () => {
    const expected = makeServer()
    expect(
      sameMcpServerDesiredRevision(
        expected,
        makeServer({
          spec: { ...expected.spec, transport: { ...expected.spec.transport, port: 4000 } },
        })
      )
    ).toBe(false)
  })

  it('S4: rejects an egressBindings change', () => {
    const expected = makeServer({
      spec: {
        contextRef: 'default',
        image: 'clerum/web-search:test',
        transport: { type: 'streamableHttp', port: 3000 },
        egressBindings: [{ cidr: '1.2.3.4/32', port: 443, protocol: 'TCP' }],
      },
    })
    expect(
      sameMcpServerDesiredRevision(
        expected,
        makeServer({
          spec: {
            ...expected.spec,
            egressBindings: [{ cidr: '8.8.8.8/32', port: 443, protocol: 'TCP' }],
          },
        })
      )
    ).toBe(false)
  })

  it('G8: McpServerCRD compared fields have no escape hatch besides status', () => {
    type McpServerCompared =
      | 'name'
      | 'namespace'
      | 'uid'
      | 'generation'
      | 'spec'
      | 'annotations'
      | 'labels'
    type McpServerEscapes = Exclude<keyof McpServerCRD, McpServerCompared | 'status'>
    expectTypeOf<McpServerEscapes>().toEqualTypeOf<never>()
  })
})

describe('isMcpServerStatusOnlyUpdate', () => {
  it('accepts only an exact identity and generation with unchanged desired state', () => {
    const previous = makeServer({
      status: { conditions: [{ type: 'Ready', status: 'False' }] },
    })
    const current = makeServer({
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    })

    expect(isMcpServerStatusOnlyUpdate(previous, current)).toBe(true)
  })

  it('does not suppress events when UID or generation equality is only one-sided', () => {
    const previous = makeServer()

    expect(isMcpServerStatusOnlyUpdate(previous, makeServer({ uid: undefined }))).toBe(false)
    expect(isMcpServerStatusOnlyUpdate(previous, makeServer({ generation: undefined }))).toBe(false)
  })

  it('does not suppress a desired-state change', () => {
    const previous = makeServer()
    const current = makeServer({
      labels: { 'clerum.io/workload': 'replacement' },
    })

    expect(isMcpServerStatusOnlyUpdate(previous, current)).toBe(false)
  })

  it('treats the controller-owned network-ready handshake as a status-only update', () => {
    const previous = makeServer({ annotations: { 'clerum.io/pre-deploy': 'true' } })
    const current = makeServer({
      annotations: {
        'clerum.io/pre-deploy': 'true',
        'clerum.io/network-ready': 'true',
      },
    })

    expect(isMcpServerStatusOnlyUpdate(previous, current)).toBe(true)
  })
})

describe('confirmAuthoritativeMcpServerAbsence', () => {
  it('stops before the API read when inventory is not authoritative', async () => {
    const resolveCurrent = vi.fn((): McpServerCRD | undefined => undefined)
    const readCurrent = vi.fn()

    await expect(
      confirmAuthoritativeMcpServerAbsence({
        inventoryAuthoritative: () => false,
        resolveCurrent,
        readCurrent,
      })
    ).resolves.toBe(false)
    expect(resolveCurrent).not.toHaveBeenCalled()
    expect(readCurrent).not.toHaveBeenCalled()
  })

  it('stops before the API read when the cache already contains the current server', async () => {
    const readCurrent = vi.fn()

    await expect(
      confirmAuthoritativeMcpServerAbsence({
        inventoryAuthoritative: () => true,
        resolveCurrent: () => makeServer(),
        readCurrent,
      })
    ).resolves.toBe(false)
    expect(readCurrent).not.toHaveBeenCalled()
  })

  it('rejects absence when the API read returns a current object', async () => {
    const readCurrent = vi.fn().mockResolvedValue({
      metadata: { name: 'web-search', namespace: 'mcp-server' },
    })

    await expect(
      confirmAuthoritativeMcpServerAbsence({
        inventoryAuthoritative: () => true,
        resolveCurrent: () => undefined,
        readCurrent,
      })
    ).resolves.toBe(false)
    expect(readCurrent).toHaveBeenCalledOnce()
  })

  it('propagates a non-404 API read failure', async () => {
    const apiError = Object.assign(new Error('unavailable'), { code: 503 })

    await expect(
      confirmAuthoritativeMcpServerAbsence({
        inventoryAuthoritative: () => true,
        resolveCurrent: () => undefined,
        readCurrent: vi.fn().mockRejectedValue(apiError),
      })
    ).rejects.toBe(apiError)
  })

  it('rejects absence when inventory authority is lost after a 404', async () => {
    const inventoryAuthoritative = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    const resolveCurrent = vi.fn((): McpServerCRD | undefined => undefined)

    await expect(
      confirmAuthoritativeMcpServerAbsence({
        inventoryAuthoritative,
        resolveCurrent,
        readCurrent: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('not found'), { code: 404 })),
      })
    ).resolves.toBe(false)
    expect(resolveCurrent).toHaveBeenCalledOnce()
  })

  it('rejects absence when the server is recreated in cache after a 404', async () => {
    const resolveCurrent = vi
      .fn<() => McpServerCRD | undefined>()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(makeServer())

    await expect(
      confirmAuthoritativeMcpServerAbsence({
        inventoryAuthoritative: () => true,
        resolveCurrent,
        readCurrent: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error('not found'), { code: 404 })),
      })
    ).resolves.toBe(false)
    expect(resolveCurrent).toHaveBeenCalledTimes(2)
  })

  it('confirms absence after a 404 when authority and cache absence remain stable', async () => {
    const inventoryAuthoritative = vi.fn(() => true)
    const resolveCurrent = vi.fn((): McpServerCRD | undefined => undefined)

    await expect(
      confirmAuthoritativeMcpServerAbsence({
        inventoryAuthoritative,
        resolveCurrent,
        readCurrent: vi.fn().mockRejectedValue({ response: { statusCode: 404 } }),
      })
    ).resolves.toBe(true)
    expect(inventoryAuthoritative).toHaveBeenCalledTimes(2)
    expect(resolveCurrent).toHaveBeenCalledTimes(2)
  })
})

describe('runtimeDesired policy contract (#604)', () => {
  const reasons = ['SecretNotFound', 'SecretMissingKey', 'SecretAccessDenied', 'ReadError']
  function withVerdict(reason: string, managed = true): McpServerCRD {
    const server = makeServer()
    server.spec = {
      ...server.spec,
      managed,
      envSecret: { name: 'fixture-env', keys: [{ secretKey: 'required', envVar: 'VALUE' }] },
    }
    server.status = { conditions: [{ type: 'SecretResolved', status: 'False', reason }] }
    return server
  }

  it.each(reasons)('preserves ownership semantics for %s', reason => {
    const managed = withVerdict(reason)
    const wrc = withVerdict(reason, false)
    expect(runtimeDesired(managed)).toBe(reason === 'ReadError')
    expect(runtimeDesired(wrc)).toBe(true)
    for (const server of [managed, wrc]) {
      server.spec.enabled = false
      expect(runtimeDesired(server)).toBe(false)
    }
  })

  it('recovers when the reference is removed despite a stale negative condition', () => {
    const server = withVerdict('SecretNotFound')
    expect(runtimeDesired(server)).toBe(false)
    delete server.spec.envSecret
    expect(runtimeDesired(server)).toBe(true)
  })

  it('retires policy effects, but not runtime effects, on a published verdict edge', () => {
    const previous = withVerdict('SecretNotFound')
    const current = withVerdict('SecretFound')
    expect(sameMcpServerDesiredRevision(previous, current)).toBe(true)
    expect(sameMcpServerPolicyRevision(previous, current)).toBe(false)
    expect(sameMcpServerPolicyRevision(current, previous)).toBe(false)
    expect(sameMcpServerPolicyRevision(previous, withVerdict('SecretMissingKey'))).toBe(true)
    expect(
      sameMcpServerPolicyRevision(
        withVerdict('SecretNotFound', false),
        withVerdict('SecretFound', false)
      )
    ).toBe(true)
  })

  it('does not require status for an otherwise desired server', () => {
    expect(runtimeDesired(makeServer())).toBe(true)
    const server = withVerdict('SecretNotFound')
    server.status = undefined
    expect(runtimeDesired(server)).toBe(true)
  })
})
