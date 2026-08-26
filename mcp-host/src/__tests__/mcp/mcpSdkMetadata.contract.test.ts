import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { McpClient } from '../../mcp/client'

class MemoryTransport implements Transport {
  peer: MemoryTransport | undefined
  onclose: (() => void) | undefined
  onerror: ((error: Error) => void) | undefined
  onmessage: Transport['onmessage'] | undefined

  async start(): Promise<void> {}

  async send(message: Parameters<NonNullable<Transport['onmessage']>>[0]): Promise<void> {
    queueMicrotask(() => this.peer?.onmessage?.(message))
  }

  async close(): Promise<void> {
    this.onclose?.()
  }
}

type MetadataClient = {
  getToolOutputValidator(name: string): unknown
  isToolTaskRequired(name: string): boolean
}

type ToolResponse = {
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, object> }
  outputSchema?: { type: 'object'; properties?: Record<string, object> }
  execution?: { taskSupport: 'required' | 'optional' | 'forbidden' }
}

function transportPair(): [MemoryTransport, MemoryTransport] {
  const client = new MemoryTransport()
  const server = new MemoryTransport()
  client.peer = server
  server.peer = client
  return [client, server]
}

describe('MCP SDK metadata ownership contract', () => {
  it('keeps status probes raw while explicit listTools owns metadata validation and cache updates', async () => {
    let tools: ToolResponse[] = [
      {
        name: 'validated-tool',
        description: 'valid schema',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object', properties: { value: { type: 'string' } } },
        execution: { taskSupport: 'required' as const },
      },
    ]
    const [clientTransport, serverTransport] = transportPair()
    const server = new Server(
      { name: 'metadata-contract-server', version: '1.0.0' },
      { capabilities: { tools: {} } }
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))
    const sdkClient = new Client(
      { name: 'metadata-contract-client', version: '1.0.0' },
      { capabilities: {} }
    )

    await Promise.all([server.connect(serverTransport), sdkClient.connect(clientTransport)])
    await sdkClient.listTools()
    const metadataClient = sdkClient as unknown as MetadataClient
    const originalValidator = metadataClient.getToolOutputValidator('validated-tool')
    expect(originalValidator).toBeDefined()
    expect(metadataClient.isToolTaskRequired('validated-tool')).toBe(true)

    tools = [
      {
        name: 'broken-schema-tool',
        description: 'an unresolved JSON Schema reference for AJV validation',
        inputSchema: { type: 'object' },
        outputSchema: {
          type: 'object',
          properties: { value: { $ref: 'urn:clerum:missing-schema' } },
        },
      },
    ]

    const wrapper = new McpClient({
      name: 'metadata-contract',
      contextRef: 'ctx',
      transport: { type: 'streamableHttp', url: 'http://metadata-contract/mcp' },
      enabled: true,
      status: { deployed: true, ready: true },
    })
    ;(wrapper as unknown as { client: Client; connected: boolean }).client = sdkClient
    ;(wrapper as unknown as { client: Client; connected: boolean }).connected = true

    await expect(wrapper.probeTools()).resolves.toEqual({
      ok: true,
      toolCount: 1,
      outputSchemaCount: 1,
    })
    expect(metadataClient.getToolOutputValidator('validated-tool')).toBe(originalValidator)
    expect(metadataClient.getToolOutputValidator('broken-schema-tool')).toBeUndefined()
    await expect(sdkClient.listTools()).rejects.toThrow()

    await Promise.all([sdkClient.close(), server.close()])
  })
})
