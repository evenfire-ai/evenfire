import { describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import {
  isK8sResourceNotFound,
  resolveInvocableMcpServersForContexts,
  resolveMcpServersForAgents,
} from '../src/services/access/mcpInvocable.js'

type Resource = Record<string, unknown>

// rpc-proxy rail caller identity + a DB that reports NO grants. These existing
// suites use `none`/`bearer`/disabled servers, which the grant-presence gate
// never touches, so the resolved list is unaffected — they double as a guard
// that `none` servers are NOT grant-gated.
const CALLER = 'user-1'
const NO_GRANTS_DB: DbClient = { query: async () => ({ rows: [], rowCount: 0 }) }

function gateway(resources: {
  contexts?: Resource[]
  mcpservers?: Resource[]
  hosts?: Resource[]
}) {
  const listResource = vi.fn(async (plural: string) => {
    if (plural === 'contexts') return resources.contexts ?? []
    if (plural === 'mcpservers') return resources.mcpservers ?? []
    if (plural === 'hosts') return resources.hosts ?? []
    return []
  })
  const getResource = vi.fn(async (plural: string, name: string) => {
    if (plural !== 'hosts') return undefined
    const found = resources.hosts?.find(
      resource => (resource.metadata as { name?: string } | undefined)?.name === name
    )
    if (!found) throw Object.assign(new Error('not-found'), { statusCode: 404 })
    return found
  })
  return {
    listResource,
    getResource,
    createResource: vi.fn(),
    updateResource: vi.fn(),
    deleteResource: vi.fn(),
  } as unknown as K8sGateway & {
    listResource: typeof listResource
    getResource: typeof getResource
  }
}

const okServer = (name: string, url?: string) => ({
  metadata: { name },
  spec: {
    enabled: true,
    auth: { type: 'none' },
    transport: { url: url ?? `http://${name}.mcp-server.svc:3000/mcp` },
  },
})

const ctx = (contextId: string, servers: string[]) => ({
  spec: { contextId, mcpServers: servers },
})

const host = (name: string, contextRef: string | null) => ({
  metadata: { name, namespace: 'mcp-host' },
  spec: contextRef ? { contextRef } : {},
})

const directoryFields = (name: string) => ({
  name,
  namespace: 'mcp-host',
  displayName: name,
  active: true,
  gfsSubject: { type: 'host', id: `1st:mcp-host/${name}` },
})

describe('resolveInvocableMcpServersForContexts', () => {
  it('returns invocable {name, url} for servers in allowed contexts', async () => {
    const g = gateway({
      contexts: [ctx('trading', ['mcp-a', 'mcp-b']), ctx('business', ['mcp-c'])],
      mcpservers: [okServer('mcp-a'), okServer('mcp-b'), okServer('mcp-c')],
    })
    const out = await resolveInvocableMcpServersForContexts(
      g,
      'mcp-server',
      ['trading'],
      CALLER,
      NO_GRANTS_DB
    )
    expect(out.map(s => s.name)).toEqual(['mcp-a', 'mcp-b'])
    expect(out[0].url).toContain('mcp-a.mcp-server.svc')
  })

  it('drops disabled servers', async () => {
    const g = gateway({
      contexts: [ctx('trading', ['a', 'b'])],
      mcpservers: [
        okServer('a'),
        {
          metadata: { name: 'b' },
          spec: { enabled: false, auth: { type: 'none' }, transport: { url: 'http://b/mcp' } },
        },
      ],
    })
    const names = (
      await resolveInvocableMcpServersForContexts(g, 'ns', ['trading'], CALLER, NO_GRANTS_DB)
    ).map(s => s.name)
    expect(names).toEqual(['a'])
  })

  it("drops servers whose auth.type is not 'none'", async () => {
    const g = gateway({
      contexts: [ctx('trading', ['a', 'b'])],
      mcpservers: [
        okServer('a'),
        {
          metadata: { name: 'b' },
          spec: { enabled: true, auth: { type: 'bearer' }, transport: { url: 'http://b/mcp' } },
        },
      ],
    })
    const names = (
      await resolveInvocableMcpServersForContexts(g, 'ns', ['trading'], CALLER, NO_GRANTS_DB)
    ).map(s => s.name)
    expect(names).toEqual(['a'])
  })

  it('drops HTTP servers without a transport.url', async () => {
    const g = gateway({
      contexts: [ctx('trading', ['a', 'b'])],
      mcpservers: [
        okServer('a'),
        {
          metadata: { name: 'b' },
          spec: { enabled: true, auth: { type: 'none' }, transport: { type: 'streamableHttp' } },
        },
      ],
    })
    const names = (
      await resolveInvocableMcpServersForContexts(g, 'ns', ['trading'], CALLER, NO_GRANTS_DB)
    ).map(s => s.name)
    expect(names).toEqual(['a'])
  })

  it('keeps stdio servers without a transport.url (proxied via stdio-bridge)', async () => {
    const g = gateway({
      contexts: [ctx('trading', ['mcp-fred'])],
      mcpservers: [
        {
          metadata: { name: 'mcp-fred' },
          spec: { enabled: true, auth: { type: 'none' }, transport: { type: 'stdio' } },
        },
      ],
    })
    const out = await resolveInvocableMcpServersForContexts(
      g,
      'mcp-server',
      ['trading'],
      CALLER,
      NO_GRANTS_DB
    )
    expect(out).toEqual([
      { name: 'mcp-fred', url: 'http://mcp-fred.mcp-server.svc.cluster.local:3000/mcp' },
    ])
  })

  it("ignores contexts outside the caller's scope (no cross-context leak)", async () => {
    const g = gateway({
      contexts: [ctx('trading', ['a']), ctx('someone-else', ['b'])],
      mcpservers: [okServer('a'), okServer('b')],
    })
    const names = (
      await resolveInvocableMcpServersForContexts(g, 'ns', ['trading'], CALLER, NO_GRANTS_DB)
    ).map(s => s.name)
    expect(names).toEqual(['a'])
  })

  it('returns an empty array when no contexts are in scope', async () => {
    const g = gateway({ contexts: [ctx('trading', ['a'])], mcpservers: [okServer('a')] })
    expect(await resolveInvocableMcpServersForContexts(g, 'ns', [], CALLER, NO_GRANTS_DB)).toEqual(
      []
    )
  })

  it('results are stable-sorted by name', async () => {
    const g = gateway({
      contexts: [ctx('trading', ['b', 'a', 'c'])],
      mcpservers: [okServer('a'), okServer('b'), okServer('c')],
    })
    const names = (
      await resolveInvocableMcpServersForContexts(g, 'ns', ['trading'], CALLER, NO_GRANTS_DB)
    ).map(s => s.name)
    expect(names).toEqual(['a', 'b', 'c'])
  })
})

describe('resolveMcpServersForAgents', () => {
  it("returns per-agent MCP names from the host's contextRef regardless of user-context auth", async () => {
    // Authorization model: agent access IS the gate. A caller that has
    // already filtered agentNames by user_agents/team_agents gets the full
    // MCP catalog of each agent's context — no context-level gating.
    const g = gateway({
      contexts: [ctx('trading', ['mcp-a', 'mcp-b']), ctx('business', ['mcp-c'])],
      mcpservers: [okServer('mcp-a'), okServer('mcp-b'), okServer('mcp-c')],
      hosts: [host('trader', 'trading'), host('ops', 'business')],
    })
    const out = await resolveMcpServersForAgents(g, {
      mcpServersNamespace: 'mcp-server',
      hostsNamespace: 'mcp-host',
      agentNames: ['trader', 'ops'],
    })
    expect(out).toEqual([
      {
        ...directoryFields('trader'),
        contextRef: 'trading',
        mcpServers: [{ name: 'mcp-a' }, { name: 'mcp-b' }],
      },
      { ...directoryFields('ops'), contextRef: 'business', mcpServers: [{ name: 'mcp-c' }] },
    ])
  })

  // UT-7a (F3, agents): the per-agent directory entry that external routes put on
  // the wire carries displayName = Host spec.host — a DISTINCT free-text value,
  // not the RFC1123 identifier. An accidental `|| name` would fail this.
  it("sets each agent's displayName from spec.host (distinct from metadata.name)", async () => {
    const g = gateway({
      contexts: [ctx('trading', ['mcp-a'])],
      mcpservers: [okServer('mcp-a')],
      hosts: [
        {
          metadata: { name: 'trader', namespace: 'mcp-host' },
          spec: { contextRef: 'trading', host: 'Trading Agents / EU' },
        },
      ],
    })
    const out = await resolveMcpServersForAgents(g, {
      mcpServersNamespace: 'mcp-server',
      hostsNamespace: 'mcp-host',
      agentNames: ['trader'],
    })
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('trader')
    expect(out[0].displayName).toBe('Trading Agents / EU')
  })

  it('omits agents whose Host CR is missing', async () => {
    const g = gateway({
      contexts: [ctx('trading', ['mcp-a'])],
      mcpservers: [okServer('mcp-a')],
      hosts: [host('trader', 'trading')],
    })
    const out = await resolveMcpServersForAgents(g, {
      mcpServersNamespace: 'mcp-server',
      hostsNamespace: 'mcp-host',
      agentNames: ['trader', 'ghost'],
    })
    expect(out).toEqual([
      { ...directoryFields('trader'), contextRef: 'trading', mcpServers: [{ name: 'mcp-a' }] },
    ])
    expect(g.getResource.mock.calls.map(call => call[1])).toEqual(['trader', 'ghost'])
  })

  it('propagates RBAC and transport failures instead of treating an authorized Host as missing', async () => {
    for (const error of [
      Object.assign(new Error('forbidden'), { statusCode: 403 }),
      Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
    ]) {
      const g = gateway({ hosts: [host('trader', null)] })
      g.getResource.mockRejectedValueOnce(error)

      await expect(
        resolveMcpServersForAgents(g, {
          mcpServersNamespace: 'mcp-server',
          hostsNamespace: 'mcp-host',
          agentNames: ['trader'],
        })
      ).rejects.toBe(error)
    }
  })

  it('preserves the input order of agentNames', async () => {
    const g = gateway({
      contexts: [ctx('a', ['s1']), ctx('b', ['s2']), ctx('c', ['s3'])],
      mcpservers: [okServer('s1'), okServer('s2'), okServer('s3')],
      hosts: [host('a1', 'a'), host('b1', 'b'), host('c1', 'c')],
    })
    const out = await resolveMcpServersForAgents(g, {
      mcpServersNamespace: 'mcp-server',
      hostsNamespace: 'mcp-host',
      agentNames: ['c1', 'a1', 'b1'],
    })
    expect(out.map(e => e.name)).toEqual(['c1', 'a1', 'b1'])
  })

  it('fetches only authorized names and preserves their order when hidden Hosts exist', async () => {
    const g = gateway({
      hosts: [host('visible-b', null), host('hidden', null), host('visible-a', null)],
    })
    const out = await resolveMcpServersForAgents(g, {
      mcpServersNamespace: 'mcp-server',
      hostsNamespace: 'mcp-host',
      agentNames: ['visible-a', 'visible-b'],
    })

    expect(out.map(agent => agent.name)).toEqual(['visible-a', 'visible-b'])
    expect(g.getResource.mock.calls.map(call => call[1])).toEqual(['visible-a', 'visible-b'])
    expect(g.listResource).not.toHaveBeenCalledWith('hosts', expect.anything())
  })

  it('applies the same invocability filter as the RPC helper', async () => {
    const g = gateway({
      contexts: [ctx('trading', ['a', 'b'])],
      mcpservers: [
        okServer('a'),
        {
          metadata: { name: 'b' },
          spec: { enabled: false, auth: { type: 'none' }, transport: { url: 'http://b/mcp' } },
        },
      ],
      hosts: [host('trader', 'trading')],
    })
    const out = await resolveMcpServersForAgents(g, {
      mcpServersNamespace: 'mcp-server',
      hostsNamespace: 'mcp-host',
      agentNames: ['trader'],
    })
    expect(out[0].mcpServers).toEqual([{ name: 'a' }]) // b is disabled
  })

  it('returns an empty list for empty agentNames', async () => {
    const g = gateway({})
    const out = await resolveMcpServersForAgents(g, {
      mcpServersNamespace: 'mcp-server',
      hostsNamespace: 'mcp-host',
      agentNames: [],
    })
    expect(out).toEqual([])
  })

  it('treats malformed gateway list responses as empty collections', async () => {
    const listResource = vi.fn(async (plural: string) => {
      if (plural === 'hosts') return undefined
      if (plural === 'mcpservers') return null
      if (plural === 'contexts') return { not: 'an-array' }
      return []
    })
    const g = {
      listResource,
      getResource: vi.fn(),
      createResource: vi.fn(),
      updateResource: vi.fn(),
      deleteResource: vi.fn(),
    } as unknown as K8sGateway
    const out = await resolveMcpServersForAgents(g, {
      mcpServersNamespace: 'mcp-server',
      hostsNamespace: 'mcp-host',
      agentNames: ['trader'],
    })
    expect(out).toEqual([])
  })
})

describe('isK8sResourceNotFound', () => {
  it('accepts Kubernetes and gateway 404 shapes', () => {
    expect(isK8sResourceNotFound({ name: 'K8sNotFoundError' })).toBe(true)
    expect(isK8sResourceNotFound({ statusCode: 404 })).toBe(true)
    expect(isK8sResourceNotFound({ code: 404 })).toBe(true)
    expect(isK8sResourceNotFound({ body: { code: 404 } })).toBe(true)
    expect(isK8sResourceNotFound({ response: { status: 404 } })).toBe(true)
    expect(isK8sResourceNotFound({ response: { body: { code: 404 } } })).toBe(true)
  })

  it('rejects RBAC, transport, and misleading text-only errors', () => {
    expect(isK8sResourceNotFound({ statusCode: 403 })).toBe(false)
    expect(isK8sResourceNotFound({ code: 'ECONNRESET' })).toBe(false)
    expect(isK8sResourceNotFound(new Error('not found'))).toBe(false)
  })
})

describe('parity: agent-scoped server names ⊆ RPC-flat-list for the same contexts', () => {
  it('per-agent names are a subset of the contexts-scoped flat list for those contexts', async () => {
    const g = gateway({
      contexts: [ctx('trading', ['mcp-a', 'mcp-b'])],
      mcpservers: [okServer('mcp-a'), okServer('mcp-b')],
      hosts: [host('trader', 'trading')],
    })
    const rpc = await resolveInvocableMcpServersForContexts(
      g,
      'ns',
      ['trading'],
      CALLER,
      NO_GRANTS_DB
    )
    const agents = await resolveMcpServersForAgents(g, {
      mcpServersNamespace: 'ns',
      hostsNamespace: 'mcp-host',
      agentNames: ['trader'],
    })
    const rpcNames = new Set(rpc.map(s => s.name))
    const agentNames = new Set(agents[0].mcpServers.map(s => s.name))
    for (const n of agentNames) expect(rpcNames.has(n)).toBe(true)
  })
})
