import { describe, expect, it, vi } from 'vitest'
import { config } from '../src/config.js'
import type { K8sGateway } from '../src/k8s.js'
import type { ContextMembershipDirectory } from '../src/services/access/contextMembership.js'
import {
  type McpOAuthConsentServer,
  authorizeMcpOAuthConsent,
} from '../src/services/access/mcpOauthAdmission.js'
import { MockGateway } from './mockGateway.js'

/**
 * PR #1004 — MCP OAuth consent follows agent EXPOSURE, not server ownership.
 *
 *   - Per user (`grantScope='user'`): admitted iff some Context the user is a
 *     member of (agent access via user_agents/team_agents, or legacy
 *     user_contexts) lists the server in `spec.mcpServers` — the same allowlist
 *     the connectors panel reads. Membership of the owner Context alone is NOT
 *     enough (no owner fallback).
 *   - Shared (`grantScope='context'`): admitted iff the user is a member of the
 *     server's own `contextRef` — a shared grant lends one credential to that
 *     Context, so an allowlisting Context is not enough.
 */

const HOSTS_NS = config.hostsNamespace
const MCP_NS = config.mcpServersNamespace

function seedHost(gateway: MockGateway, name: string, contextRef: string): void {
  void gateway.createResource('hosts', { metadata: { name }, spec: { contextRef } }, HOSTS_NS)
}

/**
 * A Context CR: `name` is the resource name (`metadata.name`) a Host/McpServer
 * `contextRef` names; `contextId` is the wire id (`spec.contextId`), which the
 * CRD does not require to equal the name. Defaults to the same string.
 */
function seedContext(
  gateway: MockGateway,
  name: string,
  mcpServers: string[],
  contextId: string = name
): void {
  void gateway.createResource(
    'contexts',
    { metadata: { name }, spec: { contextId, mcpServers } },
    MCP_NS
  )
}

/** Mark a seeded Context as terminating (the mock's create drops deletionTimestamp). */
async function markTerminating(gateway: MockGateway, name: string): Promise<void> {
  const row = (await gateway.getResource('contexts', name, MCP_NS)) as {
    metadata: { deletionTimestamp?: string }
  }
  row.metadata.deletionTimestamp = '2026-10-01T00:00:00Z'
}

function directory(
  overrides: Partial<{
    userContexts: string[]
    userAgents: string[]
    teams: string[]
    teamAgents: Record<string, string[]>
  }> = {}
): ContextMembershipDirectory {
  return {
    getUserContexts: vi.fn(async (userId: string) => ({
      userId,
      contextIds: overrides.userContexts ?? [],
    })),
    getUserAgents: vi.fn(async (userId: string) => ({
      userId,
      agentNames: overrides.userAgents ?? [],
    })),
    listTeams: vi.fn(async (_userId: string, currentTeamId: string) => ({
      currentTeamId,
      items: (overrides.teams ?? []).map(id => ({ id, name: id, role: 'member' })),
    })),
    getTeamAgents: vi.fn(async (teamId: string) => ({
      teamId,
      agentNames: overrides.teamAgents?.[teamId] ?? [],
    })),
  }
}

const perUser = (contextRef = 'ctx-owner'): McpOAuthConsentServer => ({
  name: 'gdrive',
  grantScope: 'user',
  contextRef,
})
const shared = (contextRef = 'ctx-owner'): McpOAuthConsentServer => ({
  name: 'gdrive',
  grantScope: 'context',
  contextRef,
})

describe('authorizeMcpOAuthConsent — per-user servers are admitted by agent exposure', () => {
  it('admits a user granted ONLY agent B whose Context lists the server (no owner membership)', async () => {
    const gateway = new MockGateway()
    seedHost(gateway, 'agent-b', 'ctx-b')
    seedContext(gateway, 'ctx-owner', ['gdrive'])
    seedContext(gateway, 'ctx-b', ['gdrive'])
    await expect(
      authorizeMcpOAuthConsent(
        gateway as never,
        'user-1',
        perUser(),
        directory({ userAgents: ['agent-b'] })
      )
    ).resolves.toBe(true)
  })

  it('admits a user whose active team is granted an agent exposing the server', async () => {
    const gateway = new MockGateway()
    seedHost(gateway, 'team-agent', 'ctx-team')
    seedContext(gateway, 'ctx-team', ['gdrive'])
    await expect(
      authorizeMcpOAuthConsent(
        gateway as never,
        'user-1',
        perUser(),
        directory({ teams: ['team-1'], teamAgents: { 'team-1': ['team-agent'] } })
      )
    ).resolves.toBe(true)
  })

  it('denies an outsider whose agents do not expose the server', async () => {
    const gateway = new MockGateway()
    seedHost(gateway, 'other-agent', 'ctx-other')
    seedContext(gateway, 'ctx-owner', ['gdrive'])
    seedContext(gateway, 'ctx-other', ['notion'])
    await expect(
      authorizeMcpOAuthConsent(
        gateway as never,
        'user-1',
        perUser(),
        directory({ userAgents: ['other-agent'] })
      )
    ).resolves.toBe(false)
  })

  it('a private install is denied until an accessible agent Context lists it, then admitted', async () => {
    const gateway = new MockGateway()
    // The server is installed into an owner Context nobody is a member of.
    seedHost(gateway, 'agent-b', 'ctx-b')
    seedContext(gateway, 'ctx-owner', ['gdrive'])
    seedContext(gateway, 'ctx-b', [])
    const dir = directory({ userAgents: ['agent-b'] })

    await expect(
      authorizeMcpOAuthConsent(gateway as never, 'user-1', perUser(), dir)
    ).resolves.toBe(false)

    // Assigning the connector to agent B appends it to B's Context allowlist.
    await gateway.mutateResource(
      'contexts',
      'ctx-b',
      current => ({ spec: { ...(current.spec as object), mcpServers: ['gdrive'] } }),
      MCP_NS
    )
    await expect(
      authorizeMcpOAuthConsent(gateway as never, 'user-1', perUser(), dir)
    ).resolves.toBe(true)
  })

  it('does NOT fall back to owner-Context membership when the owner Context omits the server', async () => {
    const gateway = new MockGateway()
    seedHost(gateway, 'owner-agent', 'ctx-owner')
    seedContext(gateway, 'ctx-owner', [])
    await expect(
      authorizeMcpOAuthConsent(
        gateway as never,
        'user-1',
        perUser(),
        directory({ userAgents: ['owner-agent'], userContexts: ['ctx-owner'] })
      )
    ).resolves.toBe(false)
  })

  it('counts a legacy user_contexts membership whose Context lists the server', async () => {
    const gateway = new MockGateway()
    seedContext(gateway, 'ctx-legacy', ['gdrive'])
    await expect(
      authorizeMcpOAuthConsent(
        gateway as never,
        'user-1',
        perUser(),
        directory({ userContexts: ['ctx-legacy'] })
      )
    ).resolves.toBe(true)
  })

  it('ignores Context CRs outside the mcp-servers namespace', async () => {
    const gateway = new MockGateway()
    seedHost(gateway, 'agent-b', 'ctx-b')
    void gateway.createResource(
      'contexts',
      { metadata: { name: 'ctx-b' }, spec: { contextId: 'ctx-b', mcpServers: ['gdrive'] } },
      'some-other-namespace'
    )
    await expect(
      authorizeMcpOAuthConsent(
        gateway as never,
        'user-1',
        perUser(),
        directory({ userAgents: ['agent-b'] })
      )
    ).resolves.toBe(false)
  })

  it('reads no Contexts when the user is a member of none (fail closed, no I/O)', async () => {
    const gateway = new MockGateway()
    const listResource = vi.spyOn(gateway, 'listResource')
    await expect(
      authorizeMcpOAuthConsent(gateway as never, 'user-1', perUser(), directory())
    ).resolves.toBe(false)
    expect(listResource).not.toHaveBeenCalledWith('contexts', expect.anything())
  })
})

describe('authorizeMcpOAuthConsent — shared servers require owner-Context membership', () => {
  it('admits a member of the server Context', async () => {
    const gateway = new MockGateway()
    seedHost(gateway, 'owner-agent', 'ctx-owner')
    seedContext(gateway, 'ctx-owner', ['gdrive'])
    await expect(
      authorizeMcpOAuthConsent(
        gateway as never,
        'user-1',
        shared(),
        directory({ userAgents: ['owner-agent'] })
      )
    ).resolves.toBe(true)
  })

  it('denies a user whose agent Context merely allowlists the shared server', async () => {
    const gateway = new MockGateway()
    seedHost(gateway, 'agent-b', 'ctx-b')
    seedContext(gateway, 'ctx-owner', ['gdrive'])
    seedContext(gateway, 'ctx-b', ['gdrive'])
    await expect(
      authorizeMcpOAuthConsent(
        gateway as never,
        'user-1',
        shared(),
        directory({ userAgents: ['agent-b'] })
      )
    ).resolves.toBe(false)
  })
})

describe('authorizeMcpOAuthConsent — fail closed', () => {
  it.each(['user', 'context'] as const)(
    'denies a %s-scope server without a contextRef',
    async grantScope => {
      const gateway = new MockGateway()
      seedHost(gateway, 'agent-b', 'ctx-b')
      seedContext(gateway, 'ctx-b', ['gdrive'])
      await expect(
        authorizeMcpOAuthConsent(
          gateway as never,
          'user-1',
          { name: 'gdrive', grantScope },
          directory({ userAgents: ['agent-b'], userContexts: ['ctx-b'] })
        )
      ).resolves.toBe(false)
    }
  )

  // A Host the producer would not list (disabled, terminating, or reported from
  // another namespace) must not contribute membership either, or consent could
  // be admitted for a connector the panel never offered.
  it.each([
    [
      'disabled',
      {
        metadata: { name: 'agent-b', namespace: HOSTS_NS },
        spec: { contextRef: 'ctx-b', enabled: false },
      },
    ],
    [
      'being deleted',
      {
        metadata: {
          name: 'agent-b',
          namespace: HOSTS_NS,
          deletionTimestamp: '2026-10-01T00:00:00Z',
        },
        spec: { contextRef: 'ctx-b' },
      },
    ],
    [
      'reported from another namespace',
      { metadata: { name: 'agent-b', namespace: 'elsewhere' }, spec: { contextRef: 'ctx-b' } },
    ],
  ])('a %s Host contributes nothing', async (_label, hostCr) => {
    const listResource = vi.fn(async (plural: string) => {
      if (plural === 'hosts') return [hostCr]
      if (plural === 'contexts') {
        return [
          {
            metadata: { name: 'ctx-b', namespace: MCP_NS },
            spec: { contextId: 'ctx-b', mcpServers: ['gdrive'] },
          },
        ]
      }
      return []
    })
    const gateway = { listResource } as unknown as K8sGateway
    await expect(
      authorizeMcpOAuthConsent(
        gateway,
        'user-1',
        perUser('ctx-b'),
        directory({ userAgents: ['agent-b'] })
      )
    ).resolves.toBe(false)
    await expect(
      authorizeMcpOAuthConsent(
        gateway,
        'user-1',
        shared('ctx-b'),
        directory({ userAgents: ['agent-b'] })
      )
    ).resolves.toBe(false)
  })

  it('propagates a Context read failure instead of reporting a denial', async () => {
    const gateway = new MockGateway()
    seedHost(gateway, 'agent-b', 'ctx-b')
    vi.spyOn(gateway, 'listResource').mockImplementation(async plural => {
      if (plural === 'contexts') throw new Error('apiserver down')
      return [
        {
          metadata: { name: 'agent-b', namespace: HOSTS_NS },
          spec: { contextRef: 'ctx-b' },
        },
      ]
    })
    await expect(
      authorizeMcpOAuthConsent(
        gateway as never,
        'user-1',
        perUser(),
        directory({ userAgents: ['agent-b'] })
      )
    ).rejects.toThrow('apiserver down')
  })
})

// PR #1004 R2 — Context identity. A Host / McpServer `contextRef` names the
// Context RESOURCE (`metadata.name`), as host-context-controller reads it; only
// a legacy user_contexts id may be an unambiguous wire-id alias. The reviewer's
// matrix: the server name stays `gdrive` throughout.
describe('authorizeMcpOAuthConsent — Context identity (PR #1004 R2)', () => {
  const admit = (
    gateway: MockGateway,
    server: McpOAuthConsentServer,
    dir: ContextMembershipDirectory
  ) => authorizeMcpOAuthConsent(gateway as never, 'user-1', server, dir)

  describe('per-user', () => {
    it('admits owner exposure when the Context name equals its wire id', async () => {
      const gateway = new MockGateway()
      seedHost(gateway, 'owner-agent', 'ctx-owner')
      seedContext(gateway, 'ctx-owner', ['gdrive'])
      await expect(
        admit(gateway, perUser(), directory({ userAgents: ['owner-agent'] }))
      ).resolves.toBe(true)
    })

    it('admits a Host ref naming resource ctx-a whose wire id is ctx-wire-a', async () => {
      const gateway = new MockGateway()
      seedHost(gateway, 'agent-a', 'ctx-a')
      seedContext(gateway, 'ctx-a', ['gdrive'], 'ctx-wire-a')
      await expect(admit(gateway, perUser(), directory({ userAgents: ['agent-a'] }))).resolves.toBe(
        true
      )
    })

    it('admits a secondary reachable Context that legitimately exposes the server', async () => {
      const gateway = new MockGateway()
      seedHost(gateway, 'agent-b', 'ctx-b')
      seedContext(gateway, 'ctx-owner', ['gdrive'], 'wire-owner')
      seedContext(gateway, 'ctx-b', ['gdrive'], 'wire-b')
      await expect(admit(gateway, perUser(), directory({ userAgents: ['agent-b'] }))).resolves.toBe(
        true
      )
    })

    it.each([
      ['A listed first', ['a', 'b']],
      ['B listed first', ['b', 'a']],
    ])(
      "denies Host-A-only when B.contextId collides with A's resource name (%s)",
      async (_label, order) => {
        const gateway = new MockGateway()
        seedHost(gateway, 'agent-a', 'ctx-a')
        for (const which of order) {
          if (which === 'a') seedContext(gateway, 'ctx-a', ['other-server'], 'ctx-wire-a')
          else seedContext(gateway, 'ctx-b', ['gdrive'], 'ctx-a')
        }
        await expect(
          admit(gateway, perUser('ctx-b'), directory({ userAgents: ['agent-a'] }))
        ).resolves.toBe(false)
      }
    )

    it('admits a legacy user_contexts row holding the unambiguous wire-id alias', async () => {
      const gateway = new MockGateway()
      seedContext(gateway, 'ctx-a', ['gdrive'], 'ctx-wire-a')
      await expect(
        admit(gateway, perUser(), directory({ userContexts: ['ctx-wire-a'] }))
      ).resolves.toBe(true)
    })

    it('denies a legacy alias shared by two Contexts (ambiguous)', async () => {
      const gateway = new MockGateway()
      seedContext(gateway, 'ctx-a', ['gdrive'], 'wire')
      seedContext(gateway, 'ctx-b', ['notion'], 'wire')
      await expect(admit(gateway, perUser(), directory({ userContexts: ['wire'] }))).resolves.toBe(
        false
      )
    })

    it('denies a legacy ref naming one Context and aliasing another (collision)', async () => {
      const gateway = new MockGateway()
      seedContext(gateway, 'ctx-a', ['gdrive'], 'ctx-wire-a')
      seedContext(gateway, 'ctx-b', ['gdrive'], 'ctx-a')
      await expect(admit(gateway, perUser(), directory({ userContexts: ['ctx-a'] }))).resolves.toBe(
        false
      )
    })

    it('denies a Host ref to a terminating Context without hopping to an alias', async () => {
      const gateway = new MockGateway()
      seedHost(gateway, 'agent-a', 'ctx-a')
      seedContext(gateway, 'ctx-a', ['gdrive'], 'ctx-wire-a')
      await markTerminating(gateway, 'ctx-a')
      seedContext(gateway, 'ctx-b', ['gdrive'], 'ctx-a')
      await expect(admit(gateway, perUser(), directory({ userAgents: ['agent-a'] }))).resolves.toBe(
        false
      )
    })
  })

  describe('shared', () => {
    it('admits a Host member of the owner resource whose wire id differs', async () => {
      const gateway = new MockGateway()
      seedHost(gateway, 'owner-agent', 'ctx-owner')
      seedContext(gateway, 'ctx-owner', ['gdrive'], 'wire-owner')
      await expect(
        admit(gateway, shared(), directory({ userAgents: ['owner-agent'] }))
      ).resolves.toBe(true)
    })

    it('admits a legacy member holding the owner Context wire-id alias', async () => {
      const gateway = new MockGateway()
      seedContext(gateway, 'ctx-owner', ['gdrive'], 'wire-owner')
      await expect(
        admit(gateway, shared(), directory({ userContexts: ['wire-owner'] }))
      ).resolves.toBe(true)
    })

    it('denies a member of a non-owner Context that allowlists the server', async () => {
      const gateway = new MockGateway()
      seedHost(gateway, 'agent-b', 'ctx-b')
      seedContext(gateway, 'ctx-owner', ['gdrive'])
      seedContext(gateway, 'ctx-b', ['gdrive'])
      await expect(admit(gateway, shared(), directory({ userAgents: ['agent-b'] }))).resolves.toBe(
        false
      )
    })

    it('denies a Host member whose resource name is the owner Context wire id', async () => {
      const gateway = new MockGateway()
      seedHost(gateway, 'agent-a', 'ctx-a')
      seedContext(gateway, 'ctx-a', [], 'ctx-wire-a')
      seedContext(gateway, 'ctx-owner', ['gdrive'], 'ctx-a')
      await expect(admit(gateway, shared(), directory({ userAgents: ['agent-a'] }))).resolves.toBe(
        false
      )
    })

    it('denies a legacy ref whose alias collides with another resource name', async () => {
      const gateway = new MockGateway()
      seedContext(gateway, 'ctx-a', [], 'ctx-wire-a')
      seedContext(gateway, 'ctx-owner', ['gdrive'], 'ctx-a')
      await expect(admit(gateway, shared(), directory({ userContexts: ['ctx-a'] }))).resolves.toBe(
        false
      )
    })

    it('denies when the owner Context resource is missing, even for a matching ref', async () => {
      const gateway = new MockGateway()
      seedHost(gateway, 'owner-agent', 'ctx-owner')
      await expect(
        admit(
          gateway,
          shared(),
          directory({ userAgents: ['owner-agent'], userContexts: ['ctx-owner'] })
        )
      ).resolves.toBe(false)
    })

    it('denies when the owner Context resource is terminating', async () => {
      const gateway = new MockGateway()
      seedHost(gateway, 'owner-agent', 'ctx-owner')
      seedContext(gateway, 'ctx-owner', ['gdrive'])
      await markTerminating(gateway, 'ctx-owner')
      await expect(
        admit(gateway, shared(), directory({ userAgents: ['owner-agent'] }))
      ).resolves.toBe(false)
    })

    it('reads no Contexts when the user is a member of none', async () => {
      const gateway = new MockGateway()
      const listResource = vi.spyOn(gateway, 'listResource')
      await expect(admit(gateway, shared(), directory())).resolves.toBe(false)
      expect(listResource).not.toHaveBeenCalledWith('contexts', expect.anything())
    })
  })
})
