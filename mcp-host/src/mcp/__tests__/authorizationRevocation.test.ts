import { describe, expect, it } from 'vitest'
import type { McpServerInfo } from '../../types'
import { McpClient } from '../client'

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
    const client = new McpClient(server, 'sensitive-upstream-bearer')

    const cleanup = client.retire()

    expect((client as unknown as { authToken?: string }).authToken).toBeUndefined()
    await expect(cleanup()).resolves.toBeUndefined()
  })
})
