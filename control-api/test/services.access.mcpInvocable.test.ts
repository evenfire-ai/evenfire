import { describe, expect, it, vi } from 'vitest'
import type { K8sGateway } from '../src/k8s.js'
import {
  resolveInvocableMcpServersForContexts,
  resolveMcpServersForAgents,
} from '../src/services/access/mcpInvocable.js'

type Resource = Record<string, unknown>

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
  return {
    listResource,
    getResource: vi.fn(),
    createResource: vi.fn(),
    updateResource: vi.fn(),
    deleteResource: vi.fn(),
  } as unknown as K8sGateway & { listResource: typeof listResource }
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
  metadata: { name },
  spec: contextRef ? { contextRef } : {},
})

describe('resolveInvocableMcpServersForContexts', () => {
  it('returns invocable {name, url} for servers in allowed contexts', async () => {
    const g = gateway({
      contexts: [ctx('trading', ['mcp-a', 'mcp-b']), ctx('business', ['mcp-c'])],
      mcpservers: [okServer('mcp-a'), okServer('mcp-b'), okServer('mcp-c')],
    })
    const out = await resolveInvocableMcpServersForContexts(g, 'mcp-server', ['trading'])
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
    const names = (await resolveInvocableMcpServersForContexts(g, 'ns', ['trading'])).map(
      s => s.name
    )
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
    const names = (await resolveInvocableMcpServersForContexts(g, 'ns', ['trading'])).map(
      s => s.name
    )
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
    const names = (await resolveInvocableMcpServersForContexts(g, 'ns', ['trading'])).map(
      s => s.name
    )
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
    const out = await resolveInvocableMcpServersForContexts(g, 'mcp-server', ['trading'])
    expect(out).toEqual([
      { name: 'mcp-fred', url: 'http://mcp-fred.mcp-server.svc.cluster.local:3000/mcp' },
    ])
  })

  it("ignores contexts outside the caller's scope (no cross-context leak)", async () => {
    const g = gateway({
      contexts: [ctx('trading', ['a']), ctx('someone-else', ['b'])],
      mcpservers: [okServer('a'), okServer('b')],
    })
    const names = (await resolveInvocableMcpServersForContexts(g, 'ns', ['trading'])).map(
      s => s.name
    )
    expect(names).toEqual(['a'])
  })

  it('returns an empty array when no contexts are in scope', async () => {
    const g = gateway({ contexts: [ctx('trading', ['a'])], mcpservers: [okServer('a')] })
    expect(await resolveInvocableMcpServersForContexts(g, 'ns', [])).toEqual([])
  })

  it('results are stable-sorted by name', async () => {
    const g = gateway({
      contexts: [ctx('trading', ['b', 'a', 'c'])],
      mcpservers: [okServer('a'), okServer('b'), okServer('c')],
    })
    const names = (await resolveInvocableMcpServersForContexts(g, 'ns', ['trading'])).map(
      s => s.name
    )
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
      { name: 'trader', contextRef: 'trading', mcpServers: [{ name: 'mcp-a' }, { name: 'mcp-b' }] },
      { name: 'ops', contextRef: 'business', mcpServers: [{ name: 'mcp-c' }] },
    ])
  })

  it('returns null contextRef for agents whose Host CR is missing', async () => {
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
    expect(out[1]).toEqual({ name: 'ghost', contextRef: null, mcpServers: [] })
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
    expect(out).toEqual([{ name: 'trader', contextRef: null, mcpServers: [] }])
  })
})

describe('parity: agent-scoped server names ⊆ RPC-flat-list for the same contexts', () => {
  it('per-agent names are a subset of the contexts-scoped flat list for those contexts', async () => {
    const g = gateway({
      contexts: [ctx('trading', ['mcp-a', 'mcp-b'])],
      mcpservers: [okServer('mcp-a'), okServer('mcp-b')],
      hosts: [host('trader', 'trading')],
    })
    const rpc = await resolveInvocableMcpServersForContexts(g, 'ns', ['trading'])
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
