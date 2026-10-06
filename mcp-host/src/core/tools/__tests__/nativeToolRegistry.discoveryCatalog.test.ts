import { describe, expect, it } from 'vitest'
import type { McpManager } from '../../../mcp/manager'
import type { NativeToolConfig } from '../../interfaces'
import { NativeToolRegistry } from '../nativeToolRegistry'

const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 30000,
  httpAllowlist: [],
  envAllowlist: ['PATH'],
  memoryMaxSize: 1048576,
  statelessLifecycle: false,
}

function stubManager(): McpManager {
  return {
    getAllTools: () => [
      {
        name: 'acme__lookup',
        description: 'Acme lookup',
        inputSchema: { type: 'object' },
        serverName: 'acme',
      },
    ],
  } as unknown as McpManager
}

function buildRegistry(): NativeToolRegistry {
  return new NativeToolRegistry(
    config,
    'test-conv',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    stubManager(),
    true
  )
}

describe('NativeToolRegistry — #1003 discovery catalog covers natives', () => {
  it('tool_search indexes native tools under server "native" alongside MCP entries', async () => {
    const registry = buildRegistry()
    const search = registry.get('clerum__tool_search')
    expect(search).not.toBeNull()

    const output = await search!.execute({ query: 'shell' })
    expect(output.is_error).toBe(false)
    const payload = JSON.parse(output.content) as {
      results: Array<{ name: string; server: string }>
    }
    const nativeHit = payload.results.find(r => r.name === 'shell_exec')
    expect(nativeHit?.server).toBe('native')
  })

  it('tool_describe returns the full schema of a native tool', async () => {
    const registry = buildRegistry()
    const describe = registry.get('clerum__tool_describe')
    expect(describe).not.toBeNull()

    const output = await describe!.execute({ name: 'shell_exec' })
    expect(output.is_error).toBe(false)
    const payload = JSON.parse(output.content) as {
      found: boolean
      name?: string
      server?: string
      parameters?: Record<string, unknown>
    }
    expect(payload.found).toBe(true)
    expect(payload.name).toBe('shell_exec')
    expect(payload.server).toBe('native')
    expect(payload.parameters).toBeTypeOf('object')
  })
})
