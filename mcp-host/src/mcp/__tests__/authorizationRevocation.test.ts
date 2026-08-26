import { describe, expect, it } from 'vitest'
import type { McpServerInfo } from '../../types'
import { McpClient, staticTokenProvider } from '../client'

const server: McpServerInfo = {
  name: 'scoped-server',
  transport: { type: 'streamableHttp', url: 'http://scoped-server.test/mcp' },
  enabled: true,
  authRequired: true,
  credentialRevision: 'credential-revision-1',
  status: { deployed: true, ready: true },
}

describe('MCP credential revocation', () => {
  it('wipes the retained bearer synchronously when a client is retired', async () => {
    const client = new McpClient(server, staticTokenProvider('sensitive-upstream-bearer'))
    // Simulate a live connection: connect() resolves the provider into
    // currentAuthToken, which retire() must clear synchronously. Seed it
    // directly so the assertion exercises retire()'s wipe, not the unconnected
    // (already-undefined) state.
    ;(client as unknown as { currentAuthToken?: string }).currentAuthToken =
      'sensitive-upstream-bearer'

    const cleanup = client.retire()

    expect((client as unknown as { currentAuthToken?: string }).currentAuthToken).toBeUndefined()
    await expect(cleanup()).resolves.toBeUndefined()
  })
})
