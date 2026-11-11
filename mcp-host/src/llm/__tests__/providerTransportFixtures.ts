import { vi } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { type IncomingMessage, type Server, createServer } from 'node:http'
import http2 from 'node:http2'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { CodexLlmProxyClient } from '../codexLlmProxyClient'
import { GrokLlmProxyClient } from '../grokLlmProxyClient'
import { descriptorFor, makeProvider, primarySlot } from '../registry'
import type { SingleTurnProvider } from '../types'

/**
 * Test-only transports for the eight `makeProvider` arms (#1433). Every arm
 * runs its real SDK or proxy client against a local endpoint: a loopback
 * HTTP/1.1 or HTTP/2 server, or the injectable `fetch` of a client whose
 * endpoint cannot be loopback (Azure requires https; Z.ai's base URL is a
 * descriptor constant; the subscription proxy clients take `fetchFn`).
 * Three arms stub more than the endpoint. The subscription arms replace the
 * control-api authorizer with a stub that echoes the request hash, and use
 * constants for the attempt context and the platform JWT; their proxy client
 * is real. Vertex stubs the token hop. Callers install
 * `installLoopbackOnlyNetwork()` so a seam that fails to intercept throws
 * instead of reaching a real endpoint.
 */

export type FixtureReply = {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export type ArmFixture = {
  provider: SingleTurnProvider
  /** Raw request bodies the transport received, in order. */
  bodies: string[]
  /** Subscription arms: what the authorizer stub received. */
  authorized?: Array<{ request: unknown; requestHash: string }>
  /** Vertex: calls to the stubbed token hop. */
  authHops?: () => number
}

export type ArmId =
  | 'openai'
  | 'azure'
  | 'zai'
  | 'claude'
  | 'codex-subscription'
  | 'grok-subscription'
  | 'vertex'
  | 'bedrock'

export type Arm = {
  id: ArmId
  /** A successful reply in the arm's own wire format. */
  success: FixtureReply
  make(reply: FixtureReply): Promise<ArmFixture>
}

// ─── Environment and server lifecycle ───

const servers: Array<{ close(): Promise<void> }> = []
const savedEnv: Record<string, string | undefined> = {}

export function setEnv(name: string, value: string | undefined): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/** Restore every variable set through `setEnv` and close every server. */
export async function cleanupTransports(): Promise<void> {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
    delete savedEnv[name]
  }
  for (const server of servers.splice(0)) await server.close()
}

function bodyText(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body)
}

function replyHeaders(reply: FixtureReply): Record<string, string> {
  return { 'content-type': 'application/json', ...reply.headers }
}

async function readBody(request: IncomingMessage | http2.Http2ServerRequest): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function http1Server(reply: FixtureReply): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = []
  const server: Server = createServer((request, response) => {
    void readBody(request).then(body => {
      bodies.push(body)
      response.writeHead(reply.status, replyHeaders(reply))
      response.end(bodyText(reply.body))
    })
  })
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close(error => (error ? reject(error) : resolve()))
      }),
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies }
}

async function http2Server(reply: FixtureReply): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = []
  const sessions = new Set<http2.ServerHttp2Session>()
  const server = http2.createServer()
  server.on('session', session => {
    sessions.add(session)
    session.on('close', () => sessions.delete(session))
  })
  server.on('request', (request, response) => {
    void readBody(request).then(body => {
      bodies.push(body)
      response.writeHead(reply.status, replyHeaders(reply))
      response.end(bodyText(reply.body))
    })
  })
  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const session of sessions) session.destroy()
        server.close(error => (error ? reject(error) : resolve()))
      }),
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies }
}

/** A `fetch` that records each request body and answers with `reply`. */
function recordingFetch(reply: FixtureReply): { fetch: typeof fetch; bodies: string[] } {
  const bodies: string[] = []
  const fn = async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body ?? ''))
    return new Response(bodyText(reply.body), {
      status: reply.status,
      headers: replyHeaders(reply),
    })
  }
  return { fetch: fn as unknown as typeof fetch, bodies }
}

// ─── Credentials ───

function apiKey(id: 'openai' | 'azure' | 'zai' | 'claude'): Record<string, string> {
  return { [primarySlot(descriptorFor(id)).dataKey]: 'local-http-fixture' }
}

/** A throwaway service account: the key is generated here, never stored. */
function vertexCredentials(): Record<string, string> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return {
    'vertex-service-account-json': JSON.stringify({
      client_email: 'fixture@fixture-project.iam.gserviceaccount.com',
      private_key: privateKey,
      project_id: 'fixture-project',
    }),
  }
}

/** The `google-auth-library` copy that `@google/genai` itself loads. */
function genaiGoogleAuth(): { prototype: { getRequestHeaders: (...args: never[]) => unknown } } {
  const requireHere = createRequire(join(__dirname, 'providerTransportFixtures.ts'))
  const requireFromGenai = createRequire(requireHere.resolve('@google/genai'))
  return (requireFromGenai('google-auth-library') as { GoogleAuth: never }).GoogleAuth
}

// ─── Replies ───

export const OPENAI_SUCCESS: FixtureReply = {
  status: 200,
  body: {
    id: 'chatcmpl-fixture',
    object: 'chat.completion',
    created: 0,
    model: 'fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
}

export const ANTHROPIC_SUCCESS: FixtureReply = {
  status: 200,
  body: {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model: 'fixture-model',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  },
}

export const PROXY_SUCCESS: FixtureReply = {
  status: 200,
  body:
    `data: ${JSON.stringify({ type: 'text', text: 'ok' })}\n\n` +
    `data: ${JSON.stringify({ type: 'done', outcome: 'success' })}\n\n`,
  headers: { 'content-type': 'text/event-stream' },
}

export const VERTEX_SUCCESS: FixtureReply = {
  status: 200,
  body: {
    candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  },
}

export const BEDROCK_SUCCESS: FixtureReply = {
  status: 200,
  body: {
    output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    metrics: { latencyMs: 1 },
  },
}

// ─── Arms ───

function subscriptionDeps(proxy: unknown) {
  const authorized: Array<{ request: unknown; requestHash: string }> = []
  const authorize = vi.fn(async (input: { request: unknown; requestHash: string }) => {
    authorized.push({ request: input.request, requestHash: input.requestHash })
    return {
      providerAttemptId: 'attempt-1',
      requestHash: input.requestHash,
      executionTicket: 'ticket-123456',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }
  })
  return {
    deps: {
      authorizer: { authorize },
      proxy,
      attemptContext: () => ({ policyRevision: 1, policyHash: 'b'.repeat(64) }),
    },
    authorized,
  }
}

export const ARMS: Arm[] = [
  {
    id: 'openai',
    success: OPENAI_SUCCESS,
    async make(reply) {
      const server = await http1Server(reply)
      setEnv('OPENAI_BASE_URL', `${server.url}/v1`)
      return {
        provider: makeProvider('openai', apiKey('openai'), 'fixture-model'),
        bodies: server.bodies,
      }
    },
  },
  {
    id: 'azure',
    success: OPENAI_SUCCESS,
    async make(reply) {
      const provider = makeProvider('azure', apiKey('azure'), 'fixture-model', {
        env: (name: string) =>
          name === 'AZURE_OPENAI_ENDPOINT' ? 'https://fixture.openai.azure.com' : undefined,
      })
      const transport = recordingFetch(reply)
      ;(provider as unknown as { client: { fetch: typeof fetch } }).client.fetch = transport.fetch
      return { provider, bodies: transport.bodies }
    },
  },
  {
    id: 'zai',
    success: OPENAI_SUCCESS,
    async make(reply) {
      const provider = makeProvider('zai', apiKey('zai'), 'fixture-model')
      const transport = recordingFetch(reply)
      ;(provider as unknown as { client: { fetch: typeof fetch } }).client.fetch = transport.fetch
      return { provider, bodies: transport.bodies }
    },
  },
  {
    id: 'claude',
    success: ANTHROPIC_SUCCESS,
    async make(reply) {
      const server = await http1Server(reply)
      setEnv('ANTHROPIC_BASE_URL', server.url)
      return {
        provider: makeProvider('claude', apiKey('claude'), 'fixture-model'),
        bodies: server.bodies,
      }
    },
  },
  {
    id: 'codex-subscription',
    success: PROXY_SUCCESS,
    async make(reply) {
      setEnv('MCP_HOST_CODEX_SUBSCRIPTION_ENABLED', 'true')
      const transport = recordingFetch(reply)
      const proxy = new CodexLlmProxyClient({
        runtimeUrl: 'http://127.0.0.1:9/codex-proxy-fixture',
        readPlatformJwt: () => 'fixture-platform-jwt',
        fetchFn: transport.fetch,
      })
      const wired = subscriptionDeps(proxy)
      return {
        provider: makeProvider('codex-subscription', {}, 'gpt-5.3-codex', {
          codex: wired.deps as never,
        }),
        bodies: transport.bodies,
        authorized: wired.authorized,
      }
    },
  },
  {
    id: 'grok-subscription',
    success: PROXY_SUCCESS,
    async make(reply) {
      setEnv('MCP_HOST_GROK_SUBSCRIPTION_ENABLED', 'true')
      const transport = recordingFetch(reply)
      const proxy = new GrokLlmProxyClient({
        runtimeUrl: 'http://127.0.0.1:9/grok-proxy-fixture',
        readPlatformJwt: () => 'fixture-platform-jwt',
        fetchFn: transport.fetch,
      })
      const wired = subscriptionDeps(proxy)
      return {
        provider: makeProvider('grok-subscription', {}, 'grok-4.6', { grok: wired.deps as never }),
        bodies: transport.bodies,
        authorized: wired.authorized,
      }
    },
  },
  {
    id: 'vertex',
    success: VERTEX_SUCCESS,
    async make(reply) {
      const server = await http1Server(reply)
      setEnv('GOOGLE_VERTEX_BASE_URL', server.url)
      // The token hop to oauth2.googleapis.com is the only part stubbed.
      const tokenHop = vi
        .spyOn(genaiGoogleAuth().prototype, 'getRequestHeaders')
        .mockResolvedValue(new Headers({ authorization: 'Bearer fixture-token' }) as never)
      return {
        provider: makeProvider('vertex', vertexCredentials(), 'gemini-fixture'),
        bodies: server.bodies,
        authHops: () => tokenHop.mock.calls.length,
      }
    },
  },
  {
    id: 'bedrock',
    success: BEDROCK_SUCCESS,
    async make(reply) {
      const server = await http2Server(reply)
      setEnv('AWS_ENDPOINT_URL_BEDROCK_RUNTIME', server.url)
      // Nothing of the user's AWS setup is read.
      setEnv('AWS_CONFIG_FILE', '/nonexistent/mcp-host-test/aws-config')
      setEnv('AWS_SHARED_CREDENTIALS_FILE', '/nonexistent/mcp-host-test/aws-credentials')
      setEnv('AWS_EC2_METADATA_DISABLED', 'true')
      setEnv('AWS_PROFILE', undefined)
      return {
        provider: makeProvider(
          'bedrock',
          { 'aws-access-key-id': 'AKIAFIXTURE', 'aws-secret-access-key': 'fixture-secret' },
          'bedrock-fixture',
          { env: (name: string) => (name === 'AWS_REGION' ? 'us-east-1' : undefined) }
        ),
        bodies: server.bodies,
      }
    },
  },
]

export function arm(id: ArmId): Arm {
  const found = ARMS.find(a => a.id === id)
  if (!found) throw new Error(`no fixture arm '${id}'`)
  return found
}
