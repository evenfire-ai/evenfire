import { afterEach, describe, expect, it } from 'vitest'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { getRuntime } from 'openai/_shims/node-runtime'
import { OpenAICompatibleProvider } from '../openaiCompatible'

const completion = {
  id: 'runtime-http-test',
  object: 'chat.completion',
  model: 'runtime-http-test',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'complete response' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
}

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    )
  }
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
}

function provider(baseURL: string): OpenAICompatibleProvider {
  // A local protocol fixture needs a non-secret key because the real SDK
  // requires one. The provider and SDK transport are never mocked or replaced.
  return new OpenAICompatibleProvider(
    { id: 'zai', baseURL, defaultModel: 'runtime-http-test' },
    'local-http-fixture'
  )
}

describe('Node runtime HTTP compatibility', () => {
  it('reads fragmented plain, gzip and Brotli responses over the SDK keep-alive transport', async () => {
    let requests = 0
    const connections = new Set<number>()
    const server = createServer((request, response) => {
      connections.add(request.socket.remotePort!)
      request.resume()
      request.on('end', () => {
        const encoding = ['identity', 'gzip', 'br'][requests++ % 3]
        const json = Buffer.from(JSON.stringify(completion))
        const body =
          encoding === 'gzip' ? gzipSync(json) : encoding === 'br' ? brotliCompressSync(json) : json
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Encoding': encoding,
        })
        response.write(body.subarray(0, 7))
        setImmediate(() => response.end(body.subarray(7)))
      })
    })
    const client = provider(await listen(server))
    const sdk = (client as unknown as { client: { fetch: unknown } }).client
    expect(sdk.fetch).toBe(getRuntime().fetch)
    for (let index = 0; index < 6; index += 1) {
      const result = await client.completeSingleTurn(
        [{ role: 'user', content: 'read the response' }],
        {
          signal: AbortSignal.timeout(2_000),
        }
      )
      expect(result.content).toBe('complete response')
      expect(result.usage_reported).toBe(true)
    }
    expect(requests).toBe(6)
    expect(connections.size).toBe(1)
  })

  it('bounds a truncated SDK response by the caller deadline without accepting its JSON', async () => {
    let requests = 0
    const body = JSON.stringify(completion)
    const server = createServer((request, response) => {
      requests += 1
      request.resume()
      request.on('end', () => {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body) + 64),
          Connection: 'close',
        })
        // Valid JSON rules out a parsing failure. The SDK's node-fetch@2 can
        // stall here on older Node releases too, so this case checks caller
        // cancellation, not early detection of incomplete HTTP framing.
        response.end(body)
      })
    })
    const client = provider(await listen(server))
    const signal = AbortSignal.timeout(3_000)
    const error = await client
      .completeSingleTurn([{ role: 'user', content: 'read the response' }], {
        signal,
      })
      .then(
        () => undefined,
        failure => failure as Error
      )
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(SyntaxError)
    expect(error?.message).toMatch(/premature|aborted|closed|reset/i)
    expect(requests).toBeGreaterThan(0)
  })

  it('detects truncated HTTP framing in native fetch before caller cancellation', async () => {
    const body = JSON.stringify(completion)
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body) + 64),
        Connection: 'close',
      })
      response.end(body)
    })
    const baseURL = await listen(server)
    const signal = AbortSignal.timeout(3_000)
    const response = await fetch(baseURL, { signal })
    const error = await response.json().then(
      () => undefined,
      failure => failure as Error
    )
    expect(error).toBeInstanceOf(TypeError)
    expect(error?.message).toMatch(/terminated|closed|reset/i)
    expect(signal.aborted).toBe(false)
    expect(requests).toBe(1)
  })

  it('honors cancellation after the server has received the request', async () => {
    const abort = new AbortController()
    let requests = 0
    const server = createServer(request => {
      requests += 1
      request.resume()
      abort.abort()
    })
    const client = provider(await listen(server))
    await expect(
      client.completeSingleTurn([{ role: 'user', content: 'read the response' }], {
        signal: abort.signal,
      })
    ).rejects.toThrow()
    expect(requests).toBe(1)
  })

  it('reads compressed responses through the native fetch runtime too', async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      const body = brotliCompressSync(Buffer.from(JSON.stringify(completion)))
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'br' })
      response.write(body.subarray(0, 7))
      setImmediate(() => response.end(body.subarray(7)))
    })
    const baseURL = await listen(server)
    const result = await fetch(baseURL, { signal: AbortSignal.timeout(2_000) })
    expect(await result.json()).toEqual(completion)
    expect(requests).toBe(1)
  })
})
