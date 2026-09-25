/**
 * Shared broker + upstream test wiring for the remote-oauth partition tests.
 *
 * ONE source of truth per test: `brokerWiring(grantStore)` serves BOTH the
 * broker `/user-token` mint AND the `/grants/exists` probe from the SAME
 * `grantStore`, and its factory reproduces `createMcpTokenProviderFactory`
 * (main.ts). So "the grant exists" means the identical thing to the probe (which
 * decides whether the SHARED opens) and to the token mint (which authenticates
 * the connection) — no test ever hand-sets a `GrantExistsResult` boolean (T1).
 * The `/grants/exists` response shape is control-api's echo-the-coordinates
 * contract, reproduced faithfully.
 *
 * `remoteUpstream({ strict })` builds the two SDK Client mocks the rails need:
 *   - strict:  a spec-compliant remote that 401s already at `initialize` when no
 *     Authorization reaches an https target (Slack/Notion).
 *   - lenient: a Google-like remote that ACCEPTS `initialize` token-less and only
 *     401s on `tools/call` — the upstream that makes an ungated eager SHARED
 *     cache a token-less catalog. Its `state.toolCall401Count` counts those 401s.
 * The mocks are returned as plain module objects so a test wires them through its
 * own `vi.mock(...)` calls; the returned `state` is what assertions read.
 */
import { vi } from 'vitest'
import type { McpServerInfo } from '../../../types'
import type { BrokerTokenProviderDeps } from '../../brokerTokenProvider'
import { createBrokerTokenProvider } from '../../brokerTokenProvider'
import type { McpTokenProvider } from '../../client'
import {
  type GrantExistsResult,
  buildGrantExistenceQueries,
  checkGrantExistence,
  selectRevokedPartitionKeys,
} from '../../grantExistenceClient'
import { McpManager, type McpPrincipal, type McpTokenProviderFactory } from '../../manager'

export interface BrokerWiring {
  deps: BrokerTokenProviderDeps
  factory: McpTokenProviderFactory
  /** Every `/grants/exists` batch POSTed, in order (assert probe count/coordinates). */
  existsCalls: Array<Array<{ mcpServerName: string; userId?: string }>>
  /** Force the next `/grants/exists` responses to a non-200 (throws at the client). */
  failExistsWith: (status: number) => void
}

/**
 * A single fake `fetch` for both broker endpoints, reading a shared grant store.
 * `/user-token` mints while the grant exists (404 otherwise); `/grants/exists`
 * echoes the query coordinates and reports existence from the SAME store — the
 * control-api response shape reproduced faithfully.
 */
export function brokerWiring(grantStore: Set<string>): BrokerWiring {
  const existsCalls: Array<Array<{ mcpServerName: string; userId?: string }>> = []
  let existsStatus = 200
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    if (url.endsWith('/api/v1/mcp-oauth/user-token')) {
      const has = grantStore.has(`${body.mcpServerName}:${body.userId ?? ''}`)
      return (has
        ? {
            status: 200,
            json: async () => ({ token: `tok-${body.userId ?? 'ctx'}`, expiresAt: null }),
          }
        : { status: 404, json: async () => ({ error: 'no_grant' }) }) as unknown as Response
    }
    if (url.endsWith('/api/v1/mcp-oauth/grants/exists')) {
      existsCalls.push(body.queries)
      if (existsStatus !== 200) {
        return {
          status: existsStatus,
          json: async () => ({ error: 'boom' }),
        } as unknown as Response
      }
      const results: GrantExistsResult[] = body.queries.map(
        (q: { mcpServerName: string; userId?: string }) => ({
          mcpServerName: q.mcpServerName,
          ...(q.userId !== undefined ? { userId: q.userId } : {}),
          exists: grantStore.has(`${q.mcpServerName}:${q.userId ?? ''}`),
        })
      )
      return { status: 200, json: async () => ({ results }) } as unknown as Response
    }
    throw new Error(`unexpected url ${url}`)
  })
  const deps: BrokerTokenProviderDeps = {
    gatewayUrl: () => 'http://gw:8092',
    controlToken: () => 'ctl',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  }
  const factory: McpTokenProviderFactory = (
    server: McpServerInfo,
    principal: McpPrincipal
  ): McpTokenProvider => {
    if (server.authKind === 'oauth-context') {
      return createBrokerTokenProvider(server, {}, deps)
    }
    if (server.authKind === 'oauth-user' && principal.kind === 'user') {
      return createBrokerTokenProvider(server, { userId: principal.userId }, deps)
    }
    return { resolve: async () => undefined, refresh: async () => undefined }
  }
  return { deps, factory, existsCalls, failExistsWith: (s: number) => (existsStatus = s) }
}

/** The revocation sweep exactly as main.ts wires it (no duplicated decision logic). */
export async function sweepOnce(
  manager: McpManager,
  deps: BrokerTokenProviderDeps
): Promise<number> {
  const partitions = manager.listLiveOAuthPartitions()
  if (partitions.length === 0) return 0
  const results = await checkGrantExistence(deps, buildGrantExistenceQueries(partitions))
  return manager.evictRevokedPartitions(selectRevokedPartitionKeys(partitions, results))
}

// ─── SDK upstream mocks ───────────────────────────────────────────────────────

export interface MockTransport {
  url: string
  requestHeaders: Record<string, string>
  close: ReturnType<typeof vi.fn>
}

/** Mutable state the upstream mock records into; assertions read it. */
export interface RemoteUpstreamState {
  /** Every transport constructed (one per connect attempt) — its headers/url. */
  transports: MockTransport[]
  /** Authorization header of every heartbeat probe (`request`), in order. */
  probeAuth: Array<string | undefined>
  /** Overrides the lenient upstream's `callTool` return once authenticated. */
  callToolImpl: ((auth: string) => Promise<unknown>) | null
  /** Count of 401s the lenient upstream raised at `tools/call` (missing Bearer). */
  toolCall401Count: number
}

export interface RemoteUpstreamMocks {
  state: RemoteUpstreamState
  clientModule: { Client: new () => unknown }
  transportModule: { StreamableHTTPClientTransport: new (url: URL, opts?: unknown) => unknown }
  sseModule: { SSEClientTransport: new () => unknown }
}

const TOOLS_RESULT = {
  tools: [{ name: 'do', description: 'demo tool', inputSchema: { type: 'object' } }],
}

/** A fresh mutable upstream state. Share ONE across a file's SDK mock factories. */
export function createUpstreamState(): RemoteUpstreamState {
  return { transports: [], probeAuth: [], callToolImpl: null, toolCall401Count: 0 }
}

/** A 401 raised at `initialize` by a spec-compliant remote (strict variant). */
export class RemoteAuthRequired extends Error {
  readonly code = 401
  constructor() {
    super('initialize returned 401')
    this.name = 'RemoteAuthRequired'
  }
}

/**
 * Build the SDK Client/transport mocks for a remote upstream. `strict` picks the
 * upstream flavor (see the module header). A file mocks THREE modules from ONE
 * shared `state`, so a caller passes the same `state` (from `createUpstreamState`,
 * held in an async `vi.hoisted`) to every `remoteUpstream(...)` call; omit it and
 * a fresh state is created. `state` is what assertions read (connect/probe/401
 * activity). A vi.mock factory runs before the file's static imports resolve, so
 * these builders must be reached through an async `vi.hoisted` dynamic import.
 */
export function remoteUpstream(
  opts: { strict: boolean },
  state: RemoteUpstreamState = createUpstreamState()
): RemoteUpstreamMocks {
  const strict = opts.strict

  class MockClient {
    private transport: MockTransport | null = null
    connect = vi.fn(async (t: MockTransport) => {
      // Strict remote: a token-less request to an https target 401s at
      // `initialize`. Lenient remote accepts initialize regardless of the token.
      if (strict && t.url.startsWith('https:') && !t.requestHeaders['Authorization']) {
        throw new RemoteAuthRequired()
      }
      this.transport = t
    })
    close = vi.fn().mockResolvedValue(undefined)
    listTools = vi.fn(async () => TOOLS_RESULT)
    request = vi.fn(async () => {
      const headers = this.transport?.requestHeaders ?? {}
      state.probeAuth.push(headers['Authorization'])
      return TOOLS_RESULT
    })
    callTool = vi.fn(async () => {
      const auth = this.transport?.requestHeaders?.['Authorization']
      // Lenient remote enforces auth only at tools/call: no Bearer → 401. Strict
      // remote never reaches here token-less (it 401s at initialize).
      if (!auth) {
        state.toolCall401Count += 1
        const err = new Error('http 401') as Error & { code: number }
        err.code = 401
        throw err
      }
      if (state.callToolImpl) return state.callToolImpl(auth)
      return { content: [{ type: 'text', text: 'ok' }], authorization: auth }
    })
  }

  class MockStreamable {
    url: string
    requestHeaders: Record<string, string>
    close = vi.fn().mockResolvedValue(undefined)
    constructor(url: URL, opts?: { requestInit?: { headers?: Record<string, string> } }) {
      this.url = url.toString()
      this.requestHeaders = opts?.requestInit?.headers ?? {}
      state.transports.push(this as unknown as MockTransport)
    }
  }

  class MockSSE {
    close = vi.fn().mockResolvedValue(undefined)
  }

  return {
    state,
    clientModule: { Client: MockClient as unknown as new () => unknown },
    transportModule: {
      StreamableHTTPClientTransport: MockStreamable as unknown as new (
        url: URL,
        opts?: unknown
      ) => unknown,
    },
    sseModule: { SSEClientTransport: MockSSE as unknown as new () => unknown },
  }
}
