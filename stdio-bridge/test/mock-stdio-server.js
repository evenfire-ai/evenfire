#!/usr/bin/env node
// Mock MCP stdio server for testing.
// Reads JSON-RPC from stdin, responds on stdout.

const readline = require('readline')

const rl = readline.createInterface({ input: process.stdin })

rl.on('line', line => {
  try {
    const msg = JSON.parse(line)
    if (msg.method === 'initialize') {
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock-stdio-server', version: '1.0.0' },
        },
      }
      process.stdout.write(JSON.stringify(response) + '\n')
    } else if (msg.method === 'tools/list') {
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo input',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            },
            {
              name: 'read_env',
              description: 'Read environment variable',
              inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
            },
          ],
        },
      }
      process.stdout.write(JSON.stringify(response) + '\n')
    } else if (msg.method === 'tools/call') {
      const name = msg.params?.name
      const args = msg.params?.arguments ?? {}
      const text =
        name === 'read_env'
          ? (process.env[args.name] ?? `<${args.name} not set>`)
          : `Echo: ${JSON.stringify(msg.params)}`
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text }],
        },
      }
      process.stdout.write(JSON.stringify(response) + '\n')
    } else if (msg.method === 'notifications/initialized') {
      // No response needed for notifications
    } else {
      const error = {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      }
      process.stdout.write(JSON.stringify(error) + '\n')
    }
  } catch {
    // Ignore parse errors
  }
})

process.stdin.on('end', () => process.exit(0))
