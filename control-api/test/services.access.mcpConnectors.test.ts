import { beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { DbClient } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import type { GetOAuthGrantInput } from '../src/oauth/store.js'

// The classifier reads grant PRESENCE through the real `oauthGrantExists`
// (whose SQL has its own store suites + the real-Postgres integration test
// alongside this one). Here we mock ONLY that boolean so grant presence is
// deterministic, exactly as the sibling `grantGate.test.ts` does — the fixture
// that stands for the grant store is the boolean it returns, never a hand-built
// oauth_grants row. Server/Host/Context CRs are built in the real CR shape.
const grantExists = vi.fn<(db: unknown, input: GetOAuthGrantInput) => Promise<boolean>>()
vi.mock('../src/oauth/store.js', async importActual => {
  const actual = await importActual<typeof import('../src/oauth/store.js')>()
  return {
    ...actual,
    oauthGrantExists: (db: unknown, input: GetOAuthGrantInput) => grantExists(db, input),
  }
})

const { resolveConnectorsForAgents } = await import('../src/services/access/mcpInvocable.js')

const NS = 'mcp-server'
const HOSTS_NS = 'mcp-host'
const USER = 'user-caller'
const DB: DbClient = { query: async () => ({ rows: [], rowCount: 0 }) }

type Resource = Record<string, unknown>

function gateway(resources: {
  contexts?: Resource[]
  mcpservers?: Resource[]
  hosts?: Resource[]
}): K8sGateway {
  const listResource = vi.fn(async (plural: string) => {
    if (plural === 'contexts') return resources.contexts ?? []
    if (plural === 'mcpservers') return resources.mcpservers ?? []
    if (plural === 'hosts') return resources.hosts ?? []
    return []
  })
  const getResource = vi.fn(async (plural: string, name: string) => {
    if (plural !== 'hosts') return undefined
    const found = resources.hosts?.find(
      r => (r.metadata as { name?: string } | undefined)?.name === name
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
  } as unknown as K8sGateway
}

const host = (name: string, contextRef: string | null) => ({
  metadata: { name, namespace: HOSTS_NS },
  spec: contextRef ? { contextRef } : {},
})

const ctx = (contextId: string, servers: string[]) => ({
  spec: { contextId, mcpServers: servers },
})

const oauthServer = (
  name: string,
  grantScope: 'user' | 'context',
  contextRef: string,
  provider = 'google'
) => ({
  metadata: { name },
  spec: {
    enabled: true,
    auth: { type: 'oauth' },
    transport: { url: `http://${name}.${NS}.svc:3000/mcp` },
    contextRef,
    oauth: {
      id: `${name}-client`,
      provider,
      clientIdRef: { name: `${name}-secret`, key: 'client-id' },
      clientSecretRef: { name: `${name}-secret`, key: 'client-secret' },
      grantScope,
    },
  },
})

const noneServer = (name: string) => ({
  metadata: { name },
  spec: {
    enabled: true,
    auth: { type: 'none' },
    transport: { url: `http://${name}.${NS}.svc:3000/mcp` },
  },
})

const staticServer = (name: string) => ({
  metadata: { name },
  spec: {
    enabled: true,
    auth: { type: 'bearer' },
    transport: { url: `http://${name}.${NS}.svc:3000/mcp` },
  },
})

beforeEach(() => {
  grantExists.mockReset()
})

async function connectorsFor(g: K8sGateway, agentNames: string[]) {
  const agents = await resolveConnectorsForAgents(
    g,
    { mcpServersNamespace: NS, hostsNamespace: HOSTS_NS, agentNames, userId: USER },
    DB
  )
  return agents
}

describe('resolveConnectorsForAgents — property: classify, never filter', () => {
  it('every allowlisted server appears exactly once with the correct tri-state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom('oauth-user', 'oauth-context', 'none', 'static'),
            granted: fc.boolean(),
          }),
          { minLength: 0, maxLength: 8 }
        ),
        async specs => {
          const names = specs.map((_, i) => `srv-${i}`)
          const grantedNames = new Set(
            specs
              .map((s, i) => ({ s, name: names[i] }))
              .filter(({ s }) => s.granted && s.kind.startsWith('oauth'))
              .map(({ name }) => name)
          )
          grantExists.mockImplementation(async (_db, input) => grantedNames.has(input.recipeName))

          const mcpservers = specs.map((s, i) => {
            const name = names[i]
            if (s.kind === 'oauth-user') return oauthServer(name, 'user', 'ctx-1')
            if (s.kind === 'oauth-context') return oauthServer(name, 'context', 'ctx-auth')
            if (s.kind === 'static') return staticServer(name)
            return noneServer(name)
          })

          const g = gateway({
            hosts: [host('agent-a', 'ctx-1')],
            contexts: [ctx('ctx-1', names)],
            mcpservers,
          })

          const [agent] = await connectorsFor(g, ['agent-a'])
          const connectors = agent?.connectors ?? []

          // Invariant 1 — nothing is filtered out or duplicated.
          expect(connectors.map(c => c.name).sort()).toEqual([...names].sort())

          for (let i = 0; i < specs.length; i++) {
            const s = specs[i]
            const c = connectors.find(x => x.name === names[i])
            expect(c).toBeDefined()
            if (s.kind === 'none' || s.kind === 'static') {
              // Invariant 3 — non-oauth is always no_oauth, never authorized.
              expect(c!.status).toBe('no_oauth')
              expect(c!.grantScope).toBeUndefined()
            } else {
              const scope = s.kind === 'oauth-context' ? 'context' : 'user'
              expect(c!.grantScope).toBe(scope)
              expect(c!.authKind).toBe(s.kind)
              // Invariant 1 (needs-connect) + 2 (authorized) driven ONLY by grant.
              expect(c!.status).toBe(s.granted ? 'authorized' : 'requires_setup')
            }
          }
        }
      ),
      { numRuns: 200 }
    )
  })
})

describe('resolveConnectorsForAgents — concrete tri-state + fail-closed', () => {
  it('an oauth server WITHOUT a grant is requires_setup and stays in the list', async () => {
    grantExists.mockResolvedValue(false)
    const g = gateway({
      hosts: [host('agent-a', 'ctx-1')],
      contexts: [ctx('ctx-1', ['gdrive'])],
      mcpservers: [oauthServer('gdrive', 'user', 'ctx-1')],
    })
    const [agent] = await connectorsFor(g, ['agent-a'])
    expect(agent.connectors).toEqual([
      {
        name: 'gdrive',
        provider: 'google',
        authKind: 'oauth-user',
        grantScope: 'user',
        status: 'requires_setup',
      },
    ])
  })

  it('an oauth server with a provider but WITHOUT clientSecretRef still carries provider (H3)', async () => {
    // Oauth-ness is gated on `spec.oauth.id` (resolveServerOAuth), so this server
    // classifies as an oauth connector. The panel `provider` label must be derived
    // from `spec.oauth.provider` directly — NOT via resolveServerOAuthSubject, which
    // additionally demands clientIdRef/clientSecretRef and would drop the label.
    grantExists.mockResolvedValue(false)
    const g = gateway({
      hosts: [host('agent-a', 'ctx-1')],
      contexts: [ctx('ctx-1', ['gdrive'])],
      mcpservers: [
        {
          metadata: { name: 'gdrive' },
          spec: {
            enabled: true,
            auth: { type: 'oauth' },
            transport: { url: `http://gdrive.${NS}.svc:3000/mcp` },
            contextRef: 'ctx-1',
            // id + provider present; clientIdRef/clientSecretRef ABSENT.
            oauth: { id: 'gdrive-client', provider: 'google', grantScope: 'user' },
          },
        },
      ],
    })
    const [agent] = await connectorsFor(g, ['agent-a'])
    expect(agent.connectors).toEqual([
      {
        name: 'gdrive',
        provider: 'google',
        authKind: 'oauth-user',
        grantScope: 'user',
        status: 'requires_setup',
      },
    ])
  })

  it('an oauth server WITH a grant (by its flavor) is authorized', async () => {
    grantExists.mockResolvedValue(true)
    const g = gateway({
      hosts: [host('agent-a', 'ctx-1')],
      contexts: [ctx('ctx-1', ['gdrive'])],
      mcpservers: [oauthServer('gdrive', 'user', 'ctx-1')],
    })
    const [agent] = await connectorsFor(g, ['agent-a'])
    expect(agent.connectors[0]).toMatchObject({ name: 'gdrive', status: 'authorized' })
  })

  it('a context-flavor server is keyed by its OWN spec.contextRef, decoupled from userId', async () => {
    grantExists.mockResolvedValue(true)
    const g = gateway({
      hosts: [host('agent-a', 'ctx-scope')],
      contexts: [ctx('ctx-scope', ['shared'])],
      mcpservers: [oauthServer('shared', 'context', 'ctx-authoritative')],
    })
    await connectorsFor(g, ['agent-a'])
    const key = grantExists.mock.calls[0][1]
    expect(key).toMatchObject({
      grantKind: 'shared',
      ownerKind: 'mcpserver',
      recipeName: 'shared',
      contextId: 'ctx-authoritative',
    })
    expect(key).not.toHaveProperty('userId')
  })

  it('a server with no usable oauth (resolveServerOAuth=null) is no_oauth, never queried', async () => {
    const g = gateway({
      hosts: [host('agent-a', 'ctx-1')],
      contexts: [ctx('ctx-1', ['plain'])],
      mcpservers: [noneServer('plain')],
    })
    const [agent] = await connectorsFor(g, ['agent-a'])
    expect(agent.connectors[0]).toEqual({ name: 'plain', status: 'no_oauth' })
    expect(grantExists).not.toHaveBeenCalled()
  })

  it('fail-closed: a grant-read error yields requires_setup, NEVER authorized', async () => {
    grantExists.mockRejectedValue(new Error('db down'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const g = gateway({
      hosts: [host('agent-a', 'ctx-1')],
      contexts: [ctx('ctx-1', ['gdrive'])],
      mcpservers: [oauthServer('gdrive', 'user', 'ctx-1')],
    })
    const [agent] = await connectorsFor(g, ['agent-a'])
    expect(agent.connectors[0].status).toBe('requires_setup')
    errSpy.mockRestore()
  })

  it('preserves agent order and returns empty connectors for an agent with no context', async () => {
    grantExists.mockResolvedValue(false)
    const g = gateway({
      hosts: [host('agent-a', 'ctx-1'), host('agent-b', null)],
      contexts: [ctx('ctx-1', ['gdrive'])],
      mcpservers: [oauthServer('gdrive', 'user', 'ctx-1')],
    })
    const agents = await connectorsFor(g, ['agent-a', 'agent-b'])
    expect(agents.map(a => a.name)).toEqual(['agent-a', 'agent-b'])
    expect(agents[1].connectors).toEqual([])
  })

  it('returns [] for no agents without touching the gateway or DB', async () => {
    const g = gateway({})
    expect(await connectorsFor(g, [])).toEqual([])
    expect(grantExists).not.toHaveBeenCalled()
  })
})
