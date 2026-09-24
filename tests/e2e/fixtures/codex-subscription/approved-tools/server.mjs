import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export const RECEIPT_TOOL = 'workitem_read_receipt'
const SIZES = new Set([83, 150, 250])
const RUN_ID = /^[a-zA-Z0-9_-]{1,80}$/
const MAX_REQUEST_BYTES = 64 * 1024

export function createApprovedToolsFixture({ catalogSize = 83, runId = randomUUID() } = {}) {
  if (!SIZES.has(catalogSize)) throw new Error('catalogSize must be 83, 150, or 250')
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new Error('Invalid runId')
  const tools = Array.from({ length: catalogSize }, (_, index) => ({
    name:
      index === catalogSize - 1 ? RECEIPT_TOOL : `workitem_read_${String(index).padStart(3, '0')}`,
    description:
      index === catalogSize - 1
        ? 'Read the verification receipt for a work item. Returns its persisted business identifier.'
        : `Read work item category ${index}. Returns its persisted business identifier.`,
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }))
  const names = new Set(tools.map(tool => tool.name))
  let businessId
  const calls = []

  const send = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(body === undefined ? undefined : JSON.stringify(body))
  }
  const rpcError = (response, id, code, message) =>
    send(response, 200, {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    })

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.local')
    if (request.method === 'GET' && url.pathname === '/health') {
      return send(response, 200, { ready: true, catalogSize, runId })
    }
    if (request.method === 'GET' && url.pathname === '/evidence') {
      const requestedRun = url.searchParams.get('runId')
      if (!RUN_ID.test(requestedRun ?? '')) return send(response, 400, { error: 'Invalid runId' })
      if (requestedRun !== runId) return send(response, 404, { error: 'Unknown run' })
      return send(response, 200, { runId, catalogSize, calls })
    }
    if (url.pathname !== '/mcp') return send(response, 404, { error: 'Not found' })
    // This fixture implements stateless JSON responses, not an SSE subscription.
    if (request.method !== 'POST') return send(response, 405, { error: 'POST required' })
    if (
      !request.headers.accept?.includes('application/json') ||
      !request.headers.accept?.includes('text/event-stream')
    ) {
      return send(response, 406, {
        error: 'Accept must include application/json and text/event-stream',
      })
    }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      return send(response, 415, { error: 'application/json required' })
    }
    let bytes = 0
    const chunks = []
    try {
      for await (const chunk of request) {
        bytes += chunk.length
        if (bytes > MAX_REQUEST_BYTES) return send(response, 413, { error: 'Request too large' })
        chunks.push(chunk)
      }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (
        !message ||
        Array.isArray(message) ||
        message.jsonrpc !== '2.0' ||
        typeof message.method !== 'string'
      ) {
        return rpcError(response, null, -32600, 'Invalid Request')
      }
      const { id, method, params } = message
      if (id === undefined) {
        if (method === 'notifications/initialized' || method === 'notifications/cancelled')
          return send(response, 202)
        return send(response, 400, { error: 'Unsupported notification' })
      }
      let result
      if (method === 'initialize') {
        if (typeof params?.protocolVersion !== 'string')
          return rpcError(response, id, -32602, 'protocolVersion required')
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'evenfire-approved-tools-fixture', version: '1.0.0' },
        }
      } else if (method === 'ping') {
        result = {}
      } else if (method === 'tools/list') {
        result = { tools }
      } else if (method === 'tools/call') {
        const args = params?.arguments === undefined ? {} : params.arguments
        if (
          !names.has(params?.name) ||
          !args ||
          typeof args !== 'object' ||
          Array.isArray(args) ||
          Object.keys(args).length !== 0
        ) {
          result = {
            isError: true,
            content: [{ type: 'text', text: 'Unknown tool or invalid arguments' }],
          }
        } else {
          // Generated inside this service only when a business call arrives.
          businessId ??= randomUUID()
          const record = { runId, tool: params.name, callId: id, businessId }
          calls.push(record)
          result = { content: [{ type: 'text', text: JSON.stringify(record) }], isError: false }
        }
      } else {
        return rpcError(response, id, -32601, 'Method not found')
      }
      send(response, 200, { jsonrpc: '2.0', id, result })
    } catch {
      if (!response.headersSent) rpcError(response, null, -32700, 'Parse error')
    }
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 10_000
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8080)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535')
  const server = createApprovedToolsFixture({
    catalogSize: Number(process.env.CATALOG_SIZE ?? 83),
    runId: process.env.RUN_ID,
  })
  server.listen(port, process.env.BIND_ADDRESS ?? '127.0.0.1')
  const shutdown = () => {
    server.close()
    server.closeAllConnections()
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}
