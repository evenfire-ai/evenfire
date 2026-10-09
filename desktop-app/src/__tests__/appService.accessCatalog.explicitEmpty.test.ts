import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AppService } from '../appService.js'
import { __setChatStoreBaseDirForTests } from '../chatStoreBinding.js'

// RP1004-P01a (#991): a catalog response that carries `mcpServers: []` for an
// agent is an authoritative "no connectors", not a missing mapping. The
// producer must emit the scoped key with [] so the renderer stops falling back
// to the workspace-wide preview, while an older wire that omits the field keeps
// the unknown (fallback) semantics. Fixtures sit at the auth-client boundary and
// the assertions read the real AppService.refreshAccessCatalog output.

const ME = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'test@clerum.io',
  name: 'Test User',
  picture: null,
  teamId: '00000000-0000-4000-8000-0000000000aa',
  teamName: 'Test Team',
  role: 'member',
}

type WireAgent = {
  name: string
  contextRef?: string | null
  mcpServers?: Array<{ name: string }>
}

type AgentsResponse = { agentNames: string[]; agents?: WireAgent[] }

function createService(userAgents: AgentsResponse, teamAgents: AgentsResponse) {
  const service = new AppService() as any
  service.sessionToken = 'fake-session-token'
  service.me = ME
  service.rpcTokenManager = {
    getOrIssue: vi.fn().mockResolvedValue({ token: 'fake-rpc-token' }),
    clear: vi.fn(),
  }
  service.authClient = {
    getMe: vi.fn().mockResolvedValue(ME),
    getMyContexts: vi.fn().mockResolvedValue({ contextIds: [] }),
    getMyAgents: vi.fn().mockResolvedValue(userAgents),
    getTeamContexts: vi.fn().mockResolvedValue({ teamId: ME.teamId, contextIds: [] }),
    getTeamAgents: vi.fn().mockResolvedValue({ teamId: ME.teamId, ...teamAgents }),
  }
  return service
}

describe('AppService.refreshAccessCatalog — explicit-empty connector mappings', () => {
  let chatStoreBaseDir: string

  beforeEach(async () => {
    chatStoreBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'clerum-app-service-explicit-'))
    __setChatStoreBaseDirForTests(chatStoreBaseDir)
  })

  afterEach(async () => {
    __setChatStoreBaseDirForTests(null)
    await fs.rm(chatStoreBaseDir, { recursive: true, force: true })
  })

  it('keeps an agent whose last connector was detached as an authoritative empty mapping', async () => {
    const service = createService(
      {
        agentNames: ['agent-a', 'agent-b'],
        agents: [
          { name: 'agent-a', contextRef: 'ctx-a', mcpServers: [] },
          { name: 'agent-b', contextRef: 'ctx-b', mcpServers: [{ name: 'shared-x' }] },
        ],
      },
      { agentNames: [], agents: [] }
    )

    const catalog = await service.refreshAccessCatalog()

    expect(catalog.agentMcpServers).toEqual({
      'agent-a': [],
      'agent-b': [{ name: 'shared-x' }],
    })
    expect(catalog.contextMcpServers).toEqual({
      'ctx-a': [],
      'ctx-b': [{ name: 'shared-x' }],
    })
  })

  it('omits the scoped maps when the wire carries no agents[] enrichment (older build)', async () => {
    const service = createService({ agentNames: ['agent-a'] }, { agentNames: [] })

    const catalog = await service.refreshAccessCatalog()

    expect(catalog).not.toHaveProperty('agentMcpServers')
    expect(catalog).not.toHaveProperty('contextMcpServers')
  })

  it('leaves an agent unknown when its entry has no mcpServers field', async () => {
    const service = createService(
      {
        agentNames: ['agent-a', 'agent-b'],
        agents: [
          { name: 'agent-a', contextRef: 'ctx-a' },
          { name: 'agent-b', contextRef: 'ctx-b', mcpServers: [] },
        ],
      },
      { agentNames: [], agents: [] }
    )

    const catalog = await service.refreshAccessCatalog()

    expect(catalog.agentMcpServers).toEqual({ 'agent-b': [] })
    expect(catalog.contextMcpServers).toEqual({ 'ctx-b': [] })
  })

  it('unions an empty user list with a populated team list', async () => {
    const service = createService(
      {
        agentNames: ['agent-a'],
        agents: [{ name: 'agent-a', contextRef: 'ctx-a', mcpServers: [] }],
      },
      {
        agentNames: ['agent-a'],
        agents: [{ name: 'agent-a', contextRef: 'ctx-a', mcpServers: [{ name: 'shared-x' }] }],
      }
    )

    const catalog = await service.refreshAccessCatalog()

    expect(catalog.agentMcpServers).toEqual({ 'agent-a': [{ name: 'shared-x' }] })
    expect(catalog.contextMcpServers).toEqual({ 'ctx-a': [{ name: 'shared-x' }] })
  })

  it('keeps a populated user list when the team entry omits the field', async () => {
    const service = createService(
      {
        agentNames: ['agent-a'],
        agents: [{ name: 'agent-a', contextRef: 'ctx-a', mcpServers: [{ name: 'shared-x' }] }],
      },
      { agentNames: ['agent-a'], agents: [{ name: 'agent-a', contextRef: 'ctx-a' }] }
    )

    const catalog = await service.refreshAccessCatalog()

    expect(catalog.agentMcpServers).toEqual({ 'agent-a': [{ name: 'shared-x' }] })
    expect(catalog.contextMcpServers).toEqual({ 'ctx-a': [{ name: 'shared-x' }] })
  })

  it('treats an enrichment outage (agents: [] with agentNames) as unknown, not empty', async () => {
    const service = createService(
      { agentNames: ['agent-a', 'agent-b'], agents: [] },
      { agentNames: [], agents: [] }
    )

    const catalog = await service.refreshAccessCatalog()

    expect(catalog).not.toHaveProperty('agentMcpServers')
    expect(catalog).not.toHaveProperty('contextMcpServers')
  })

  it('keeps a context known-empty only when every known agent on it is empty', async () => {
    const service = createService(
      {
        agentNames: ['agent-a', 'agent-c'],
        agents: [
          { name: 'agent-a', contextRef: 'ctx-shared', mcpServers: [] },
          { name: 'agent-c', contextRef: 'ctx-shared', mcpServers: [{ name: 'shared-x' }] },
        ],
      },
      { agentNames: [], agents: [] }
    )

    const catalog = await service.refreshAccessCatalog()

    expect(catalog.agentMcpServers).toEqual({
      'agent-a': [],
      'agent-c': [{ name: 'shared-x' }],
    })
    expect(catalog.contextMcpServers).toEqual({ 'ctx-shared': [{ name: 'shared-x' }] })
  })
})
