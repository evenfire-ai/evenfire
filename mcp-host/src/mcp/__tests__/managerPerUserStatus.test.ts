/**
 * R4-M1 — a per-user (ownsServerStatus=false) admission must NEVER write the
 * per-serverName health status.
 *
 * The per-serverName status reflects the SHARED representative's health. A lazy
 * per-user partition that connects while the representative is DOWN must not flip
 * the serverName status to `connected` (with its own partition's toolCount) — a
 * status reader (GET /v1/runtime/status, heartbeat) would then report a down
 * representative as healthy. This pins the gate symmetric with the already-gated
 * markConnecting / recordAdmissionFailure in connectAndInstall.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerInfo } from '../../types'
import type { McpTokenProvider } from '../client'
import type { McpPrincipal, McpTokenProviderFactory } from '../manager'
import { McpManager } from '../manager'

// ─── SDK mocks (constructable) ───────────────────────────────────────────────

const sdk: { connectImpl: (() => Promise<void>) | null } = { connectImpl: null }

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    connect = vi.fn(async () => {
      if (sdk.connectImpl) await sdk.connectImpl()
    })
    close = vi.fn().mockResolvedValue(undefined)
    listTools = vi.fn(async () => ({
      tools: [{ name: 'do', description: 'demo tool', inputSchema: { type: 'object' } }],
    }))
    callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }))
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    close = vi.fn().mockResolvedValue(undefined)
    constructor(_url: URL, _opts?: unknown) {}
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    close = vi.fn().mockResolvedValue(undefined)
  },
}))

// ─── Helpers ─────────────────────────────────────────────────────────────────

function oauthUserServer(name = 'gh'): McpServerInfo {
  return {
    name,
    contextRef: 'ctx-1',
    transport: { type: 'streamableHttp', url: `http://${name}/mcp` },
    authKind: 'oauth-user',
    enabled: true,
    status: { deployed: true, ready: true },
  }
}

/** SHARED representative is token-less; per-user principals get their own token. */
function recordingFactory(): McpTokenProviderFactory {
  return (_server: McpServerInfo, principal: McpPrincipal): McpTokenProvider =>
    principal.kind === 'shared'
      ? { resolve: async () => undefined, refresh: async () => undefined }
      : {
          resolve: async () => `token-for-${principal.userId}`,
          refresh: async () => `token-for-${principal.userId}`,
        }
}

beforeEach(() => {
  sdk.connectImpl = null
})

describe('R4-M1 — a per-user admission never writes the per-serverName status', () => {
  it('a lazy per-user partition does not flip a down representative to connected', async () => {
    const manager = new McpManager(undefined, undefined, recordingFactory())

    // The SHARED representative connect fails (transient/down); every subsequent
    // connect (the per-user partition) succeeds. serverInfos is retained with the
    // ready status, so a per-user call can still lazily admit its own partition.
    let representativeDown = true
    sdk.connectImpl = async () => {
      if (representativeDown) {
        representativeDown = false
        throw new Error('representative down')
      }
    }

    await expect(manager.addServer(oauthUserServer())).rejects.toThrow(/representative down/)
    // Representative admission failed → per-serverName status is `failed`.
    expect(manager.status.get('gh')?.state).toBe('failed')

    // A per-user call lazily admits alice's partition (which connects fine).
    const res = await manager.callTool('gh__do', {}, { userId: 'alice' })
    expect(res.isError).toBe(false)

    // OBSERVABLE (T4): the per-serverName status must NOT have been flipped to
    // `connected` by alice's per-user admission — the representative is still
    // down. Before the fix, installConnectedClient called markConnected
    // unconditionally, reporting the down representative as `connected`.
    expect(manager.status.get('gh')?.state).toBe('failed')
    expect(manager.status.get('gh')?.state).not.toBe('connected')
  })
})
