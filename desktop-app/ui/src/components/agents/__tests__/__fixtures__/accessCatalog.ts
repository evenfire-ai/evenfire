import type { AccessCatalog, AgentWithMcpServers } from '../../../../../../src/types'

/**
 * The renderer's access catalog built by the REAL main-process producer
 * (`AppService.getAccessCatalog`), so `agentContextByName` has exactly the shape
 * and normalization (trim, `null` for a Host without a Context) the IPC bridge
 * hands the renderer. Only the HTTP client underneath is stubbed, with the
 * `/me/*` and `/team/*` payloads control-api returns, plus the chat-store
 * binding the producer performs as a side effect (it needs the Electron `app`).
 */
export async function accessCatalogFromWire(
  agents: Array<Pick<AgentWithMcpServers, 'name' | 'contextRef'>>
): Promise<AccessCatalog> {
  const { AppService } = await import('../../../../../../src/appService')
  const service = new AppService() as unknown as {
    sessionToken: string | null
    me: { id: string; teamId: string | null } | null
    authClient: unknown
    bindCurrentChatStore: (userId: string) => Promise<void>
    getAccessCatalog: () => Promise<AccessCatalog>
  }
  service.sessionToken = 'session-token'
  service.me = { id: 'user-1', teamId: null }
  service.bindCurrentChatStore = async () => undefined
  service.authClient = {
    getMyContexts: async () => ({ userId: 'user-1', contextIds: [] }),
    getMyAgents: async () => ({
      userId: 'user-1',
      agentNames: agents.map(agent => agent.name),
      agents: agents.map(agent => ({ ...agent, mcpServers: [] })),
    }),
    getTeamContexts: async () => ({ teamId: '', contextIds: [] }),
    getTeamAgents: async () => ({ teamId: '', agentNames: [], agents: [] }),
  }
  return service.getAccessCatalog()
}
