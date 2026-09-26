import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbClient } from '../src/db.js'
import type { K8sGateway } from '../src/k8s.js'
import type { GetOAuthGrantInput } from '../src/oauth/store.js'

/**
 * S3.2 / DEC-28 — point 7: `classifyConnector` handles a GENERIC connector
 * UNCHANGED. A generic server has `auth.type==='oauth'` + `spec.oauth.id` (so
 * `resolveServerOAuth` is non-null → it is an oauth connector) but NO
 * `spec.oauth.provider` (so the panel provider label is omitted, exactly like the
 * remote lane today). The tri-state comes solely from grant presence via the same
 * flavored key derivation the rpc-proxy gate uses (D4). We mock only the
 * `oauthGrantExists` boolean, as the sibling connector suites do.
 */
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

const host = (name: string, contextRef: string) => ({
  metadata: { name, namespace: HOSTS_NS },
  spec: { contextRef },
})
const ctx = (contextId: string, servers: string[]) => ({ spec: { contextId, mcpServers: servers } })

// A generic self-hosted oauth server: auth.type oauth, oauth.source generic,
// oauth.id present, NO provider.
const genericServer = (name: string, grantScope: 'user' | 'context', contextRef: string) => ({
  metadata: { name },
  spec: {
    enabled: true,
    auth: { type: 'oauth' },
    transport: { url: `http://${name}.${NS}.svc:3000/mcp` },
    contextRef,
    oauth: {
      source: 'generic',
      id: `${name}-client`,
      authorizationEndpoint: 'https://idp.example.com/authorize',
      tokenEndpoint: 'https://idp.example.com/token',
      tokenRequestFormat: 'form',
      tokenAuthMethod: 'body',
      scopeSeparator: 'space',
      sendScope: true,
      usePkce: true,
      includeResponseType: true,
      supportsRefresh: true,
      grantScope,
    },
  },
})

beforeEach(() => grantExists.mockReset())

async function connectorsFor(g: K8sGateway, agentNames: string[]) {
  return resolveConnectorsForAgents(
    g,
    { mcpServersNamespace: NS, hostsNamespace: HOSTS_NS, agentNames, userId: USER },
    DB
  )
}

describe('classifyConnector — generic connector (DEC-28, point 7)', () => {
  it('a granted generic user server → authorized, oauth-user, NO provider label', async () => {
    grantExists.mockResolvedValue(true)
    const g = gateway({
      hosts: [host('agent-1', 'ctx-1')],
      contexts: [ctx('ctx-1', ['gen-srv'])],
      mcpservers: [genericServer('gen-srv', 'user', 'ctx-1')],
    })
    const [agent] = await connectorsFor(g, ['agent-1'])
    expect(agent.connectors).toHaveLength(1)
    const c = agent.connectors[0]
    expect(c.name).toBe('gen-srv')
    expect(c.status).toBe('authorized')
    expect(c.authKind).toBe('oauth-user')
    expect(c.grantScope).toBe('user')
    expect(c.provider).toBeUndefined()
  })

  it('an un-granted generic server → requires_setup (never authorized)', async () => {
    grantExists.mockResolvedValue(false)
    const g = gateway({
      hosts: [host('agent-1', 'ctx-1')],
      contexts: [ctx('ctx-1', ['gen-srv'])],
      mcpservers: [genericServer('gen-srv', 'context', 'ctx-1')],
    })
    const [agent] = await connectorsFor(g, ['agent-1'])
    const c = agent.connectors[0]
    expect(c.status).toBe('requires_setup')
    expect(c.authKind).toBe('oauth-context')
    expect(c.provider).toBeUndefined()
  })
})
