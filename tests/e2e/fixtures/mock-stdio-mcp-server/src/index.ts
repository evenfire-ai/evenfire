import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'mock-stdio-mcp-server',
  version: '0.1.0',
})

server.tool('echo', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text: `Echo: ${text}` }],
}))

server.tool('add', { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }],
}))

server.tool('multiply', { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a * b) }],
}))

server.tool('get_time', {}, async () => ({
  content: [{ type: 'text', text: new Date().toISOString() }],
}))

server.tool('read_env', { name: z.string() }, async ({ name }) => ({
  content: [{ type: 'text', text: process.env[name] ?? `<${name} not set>` }],
}))

const transport = new StdioServerTransport()
await server.connect(transport)
