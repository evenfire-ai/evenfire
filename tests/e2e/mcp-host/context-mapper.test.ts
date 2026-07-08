/**
 * E2E: Context Mapper — verify server discovery and filtering.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { CTX_MAPPER_URL, getMcpServers, healthCheck } from '../helpers.js'

let contextMapperUp = false

beforeAll(async () => {
  contextMapperUp = await healthCheck(CTX_MAPPER_URL)
  if (!contextMapperUp) {
    console.log(
      '[context-mapper] host-context-controller port-forward is not available — tests will be skipped'
    )
  }
})

describe('Context Mapper', () => {
  it('GET /api/v1/mcpservers/context/context1 returns servers', async () => {
    if (!contextMapperUp) return
    const data = await getMcpServers('context1')
    expect(data.servers).toBeDefined()
    expect(Array.isArray(data.servers)).toBe(true)
    expect(data.contextRef).toBe('context1')
  })

  it('context1 includes at least one ready MCP server with transport metadata', async () => {
    if (!contextMapperUp) return
    const data = await getMcpServers('context1')
    const readyServer = data.servers.find((s: any) => s.status?.ready === true)
    expect(readyServer).toBeDefined()
    expect(readyServer.transport).toBeDefined()
    expect(readyServer.transport.type).toBeDefined()
  })

  it('non-existent context returns empty server list', async () => {
    if (!contextMapperUp) return
    const res = await fetch(`${CTX_MAPPER_URL}/api/v1/mcpservers/context/does-not-exist`)
    const data = await res.json()
    expect(data.servers).toEqual([])
  })
})
