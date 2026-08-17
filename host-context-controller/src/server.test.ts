import { afterEach, describe, expect, it } from 'vitest'
import { McpServerProvider } from './k8sClient'
import { ContextMapperServer } from './server'

class FakeProvider implements McpServerProvider {
  getAllServers() {
    return []
  }

  getAllServerInfos() {
    return []
  }

  async getServerInfosByContext() {
    return []
  }

  async getAuthToken() {
    return undefined
  }

  onChange() {}

  async start() {}

  async stop() {}
}

class MockResponse {
  statusCode = 200
  headers: Record<string, string> = {}
  body = ''
  headersSent = false

  setHeader(name: string, value: string): void {
    this.headers[name] = value
  }

  writeHead(status: number, headers?: Record<string, string>): void {
    this.statusCode = status
    this.headersSent = true
    if (headers) {
      Object.assign(this.headers, headers)
    }
  }

  end(chunk?: string): void {
    if (chunk) {
      this.body += chunk
    }
  }
}

async function invoke(server: ContextMapperServer, path: string) {
  const req = {
    method: 'GET',
    url: path,
    headers: {},
  }
  const res = new MockResponse()
  await (
    server as unknown as {
      handleRequest: (
        req: { method: string; url: string; headers: Record<string, string> },
        res: MockResponse
      ) => Promise<void>
    }
  ).handleRequest(req, res)
  return res
}

describe('ContextMapperServer readiness', () => {
  let server: ContextMapperServer | null = null

  afterEach(async () => {
    await server?.stop()
    server = null
  })

  it('serves health immediately but gates readiness and API responses until warm-up completes', async () => {
    server = new ContextMapperServer(new FakeProvider(), 0)

    let response = await invoke(server, '/health')
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ status: 'ok', ready: false })

    response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({ status: 'starting', ready: false })

    response = await invoke(server, '/api/v1/mcpservers')
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toEqual({
      error: 'Service Unavailable',
      message: 'Context mapper is still starting',
    })

    server.setReady(true)

    response = await invoke(server, '/ready')
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ status: 'ready', ready: true })

    response = await invoke(server, '/api/v1/mcpservers')
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      servers: [],
      contextRef: '*',
    })
  })
})
