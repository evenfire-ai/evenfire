/**
 * Approved-tools presentation contract (#718, #721 minimum), cluster-free.
 *
 * The E2E fixture model (`codex-llm-proxy/test/approvedToolsUpstream.ts`)
 * scripts every journey through the three discovery bridges. Whether the Host
 * presents them is decided by `CODEX_TOOL_PRESENTATION` and the discovery
 * threshold. This test composes the same chain the Host builds for a Codex
 * turn and feeds the fixture model the real proxy request:
 *
 *   approved-tools MCP fixture server (HTTP)
 *     -> real McpManager + MCP SDK streamable HTTP client
 *     -> NativeToolRegistry + McpToolRegistryAdapter + CompositeToolRegistry
 *     -> DeferrableToolController (taskExecutor.createToolRegistry shape)
 *     -> runToolUseLoop -> DefaultReasoningPort -> LlmPortAdapter
 *     -> CodexSubscriptionProvider -> CodexLlmProxyClient (HTTP)
 *     -> codex-llm-proxy createProxyApps + real streamCodexCompletion
 *     -> createApprovedToolsUpstream().fetchFn
 *
 * Only control-api (authorize, redeem, finalize) is a stub; it is not part of
 * the presentation decision. No bridge definition is built by hand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type RequestListener, type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { LlmError, LlmErrorCode } from '../../../core/errors'
import { CodexLlmProxyClient } from '../../../llm/codexLlmProxyClient'
import { CodexSubscriptionProvider } from '../../../llm/codexSubscription'
import { McpManager } from '../../../mcp/manager'
import { LlmPortAdapter } from '../../adapters/llmPortAdapter'
import { CompositeToolRegistry, McpToolRegistryAdapter } from '../../adapters/toolRegistryAdapter'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { DefaultReasoningPort } from '../../reasoning/port'
import { DefaultPromptBuilder } from '../../reasoning/promptBuilder'
import { BasicSafety } from '../../safety/safety'
import { NativeToolRegistry } from '../../tools/nativeToolRegistry'
import { type ChatMessage, ConversationState, type LoopResult } from '../../types'
import { DeferrableToolController } from '../deferrableToolController'
import { SimpleEventEmitter } from '../eventEmitter'
import { DefaultLoopController, buildLoopConfig } from '../loopConfig'
import { resolveToolPresentation } from '../toolPresentationPolicy'
import { runToolUseLoop } from '../toolUseLoop'

type Evidence = {
  catalogRequests: number
  rejected: number
  rejections: string[]
  completions: number
  searchCalls: number
  describeCalls: number
  businessCalls: number
  finalResponses: number
  deniedResponses: number
  limitProbe: { turns: number; completions: number; unexpectedRetries: number }
  limitBoundary: {
    turns: number
    completions: number
    toolResults: number
    finalResponses: number
    unexpectedRetries: number
  }
  requests: Array<{
    definitionCount: number
    connectorDefinitionCount: number
    leakedSchema: boolean
    stage: string
  }>
}
type UpstreamModule = {
  createApprovedToolsUpstream(): { fetchFn: typeof fetch; evidence(): Evidence }
}
type ProxyModule = {
  createProxyApps(
    config: Record<string, unknown>,
    deps: Record<string, unknown>
  ): { runtimeApp: RequestListener; close(): Promise<void> }
}
type ProxyConfigModule = { loadConfig(env: Record<string, string>): Record<string, unknown> }
type FixtureModule = {
  createApprovedToolsFixture(options: { catalogSize: number; runId: string }): Server
}
type BusinessRecord = { runId: string; tool: string; callId: string | number; businessId: string }
type ReceiptModule = {
  businessReceiptProblem(value: unknown, context: 'mcp' | 'host-workflow-result'): string | null
}
type Presentation = Record<(typeof PRESENTATION_KEYS)[number], string | undefined>

// The keys that decide which tools a Codex turn presents.
const PRESENTATION_KEYS = [
  'CODEX_TOOL_PRESENTATION',
  'CLERUM_DYNAMIC_TOOLS_THRESHOLD',
  'CLERUM_NATIVE_TOOL_PRESENTATION',
] as const
const BRIDGES = ['clerum__tool_search', 'clerum__tool_describe', 'clerum__tool_call']
const SERVER = 'fixture'
const MODEL = 'gpt-5.3-codex'
const HOST_REF = 'approved-tools-host'
const REPO = '../../../../../'
const OVERLAY = resolve(__dirname, REPO, 'deploy/overlays/minikube/configmaps/mcp-host-config.yaml')
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const originalEnv = process.env
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  process.env = originalEnv
  vi.resetModules()
  vi.restoreAllMocks()
})

async function listen(handler: RequestListener | Server): Promise<number> {
  const server = typeof handler === 'function' ? createServer(handler) : handler
  server.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close(err => (err ? reject(err) : resolve()))
    )
  })
  return (server.address() as AddressInfo).port
}

/** Reads only the presentation keys of the Minikube Host ConfigMap overlay. */
function overlayPresentation(): Presentation {
  const text = readFileSync(OVERLAY, 'utf8')
  const data = text.split('\n').indexOf('data:')
  expect(data, 'the overlay has a top-level data: section').toBeGreaterThan(0)
  const values = {} as Presentation
  for (const key of PRESENTATION_KEYS) {
    const lines = text.split('\n').filter(line => new RegExp(`^\\s*${key}\\s*:`).test(line))
    expect(lines.length, `${key} is declared at most once`).toBeLessThanOrEqual(1)
    if (lines.length === 0) {
      values[key] = undefined
      continue
    }
    const match = new RegExp(`^  ${key}: (?:'([^']*)'|"([^"]*)")$`).exec(lines[0]!)
    expect(match, `${key} is a quoted string entry of data:`).not.toBeNull()
    values[key] = match![1] ?? match![2]
  }
  return values
}

/** Loads the Host configuration exactly as a process started with `env` would. */
async function hostConfig(presentation: Presentation) {
  vi.resetModules()
  process.env = { ...originalEnv }
  for (const key of [
    ...PRESENTATION_KEYS,
    'CODEX_TOOL_DISCOVERY_BYTES',
    'CLERUM_DYNAMIC_TOOLS_ENABLED',
  ]) {
    delete process.env[key]
  }
  for (const key of PRESENTATION_KEYS) {
    const value = presentation[key]
    if (value !== undefined) process.env[key] = value
  }
  return (await import('../../../config')).config
}

async function proxy(fetchFn: typeof fetch) {
  // Runtime imports keep Host's compiler boundary, as in
  // subscriptionAdmission.integration.test.ts.
  const base = `${REPO}codex-llm-proxy/`
  const { createProxyApps } = await vi.importActual<ProxyModule>(`${base}src/server.ts`)
  const { loadConfig } = await vi.importActual<ProxyConfigModule>(`${base}src/config.ts`)
  const redeem = vi.fn(async (input: { requestHash: string }) => ({
    accessToken: `hdr.${Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_contract' } })
    ).toString('base64url')}.sig`,
    transport: {
      protocolVersion: 'codex-subscription-transport.v1',
      completionsOrigin: 'https://chatgpt.com/backend-api/codex/responses',
      catalogOrigin: 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0',
      operation: 'completion_stream',
      servedModel: MODEL,
      maxStreamDurationMs: 1_800_000,
    },
    expiryClass: 'short_lived',
    attemptReceipt: input.requestHash,
  }))
  const finalize = vi.fn(async (input: { providerAttemptId: string; outcome: string }) => ({
    providerAttemptId: input.providerAttemptId,
    outcome: input.outcome,
    duplicate: false,
  }))
  // Production limits and defaults; only the control-api endpoint is unused.
  const config = loadConfig({
    CODEX_LLM_PROXY_JWT_PUBLIC_KEY: publicKey,
    CODEX_LLM_PROXY_EXECUTION_ENABLED: 'true',
    CODEX_LLM_PROXY_CONTROL_API_URL: 'http://control-api.invalid',
    CODEX_LLM_PROXY_CONTROL_API_TOKEN: 'contract-test-service-token',
  })
  const apps = createProxyApps(config, {
    controlApiClient: { redeem, finalize },
    fetchFn,
    lookup: async (hostname: string) => {
      if (hostname !== 'chatgpt.com') throw new Error('contract_dns_operation_denied')
      return [{ address: '104.18.32.47', family: 4 }]
    },
  })
  cleanup.push(() => apps.close())
  const port = await listen(apps.runtimeApp)
  return { url: `http://127.0.0.1:${port}/internal/runtime/v1/codex/completions`, redeem }
}

function codexProvider(runtimeUrl: string) {
  const platform = jwt.sign(
    {
      sub: `default/${HOST_REF}`,
      hostRefs: [HOST_REF],
      workflowControlScopes: ['llm:codex:execute'],
      scope: 'workflow:approval:request',
    },
    privateKey,
    { algorithm: 'RS256', issuer: 'control-api', audience: 'workflow-approvals', expiresIn: 600 }
  )
  const authorize = vi.fn(async (input: { requestHash: string }) => {
    const id = randomUUID()
    return {
      providerAttemptId: id,
      requestHash: input.requestHash,
      executionTicket: jwt.sign(
        {
          jti: id,
          typ: 'codex-execution-ticket',
          hostRef: HOST_REF,
          model: MODEL,
          requestHash: input.requestHash,
          providerAttemptId: id,
        },
        privateKey,
        { algorithm: 'RS256', issuer: 'control-api', audience: 'codex-llm-proxy', expiresIn: 600 }
      ),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }
  })
  const provider = new CodexSubscriptionProvider(MODEL, {
    authorizer: { authorize },
    proxy: new CodexLlmProxyClient({ runtimeUrl, readPlatformJwt: () => platform }),
    attemptContext: () => ({ policyRevision: 1, policyHash: 'b'.repeat(64), hostRef: HOST_REF }),
  } as never)
  return { provider, authorize }
}

/**
 * One Host process with `presentation` and one fixture MCP server of
 * `catalogSize` tools. `turn` runs one user turn through the Host loop.
 */
async function host(presentation: Presentation, catalogSize: number) {
  const appConfig = await hostConfig(presentation)
  const { createApprovedToolsUpstream } = await vi.importActual<UpstreamModule>(
    `${REPO}codex-llm-proxy/test/approvedToolsUpstream.ts`
  )
  const { createApprovedToolsFixture } = await vi.importActual<FixtureModule>(
    `${REPO}tests/e2e/fixtures/codex-subscription/approved-tools/server.mjs`
  )
  const runId = `contract-${catalogSize}-${randomUUID().slice(0, 8)}`
  const fixturePort = await listen(createApprovedToolsFixture({ catalogSize, runId }))
  const businessCalls = async (): Promise<BusinessRecord[]> => {
    const response = await fetch(`http://127.0.0.1:${fixturePort}/evidence?runId=${runId}`)
    expect(response.status).toBe(200)
    return ((await response.json()) as { calls: BusinessRecord[] }).calls
  }

  const manager = new McpManager()
  cleanup.push(() => manager.close())
  await manager.addServer({
    name: SERVER,
    contextRef: 'contract-context',
    enabled: true,
    transport: { type: 'streamableHttp', url: `http://127.0.0.1:${fixturePort}/mcp` },
    status: { deployed: true, ready: true },
  })
  // Liveness witness: the Host's catalog holds the whole fixture catalog.
  expect(manager.getAllTools()).toHaveLength(catalogSize)

  const simulator = createApprovedToolsUpstream()
  const { url } = await proxy(simulator.fetchFn)
  const { provider, authorize } = codexProvider(url)
  const providerCall = vi.spyOn(provider, 'completeSingleTurnWithTools')

  // taskExecutor.createToolRegistry, for a Codex turn without approval gates.
  const toolPresentation = resolveToolPresentation('codex-subscription', appConfig)
  const conversation = makeFakeConversation({ state: ConversationState.Processing })
  const native = new NativeToolRegistry(
    { ...appConfig.nativeTool, toolSpilloverThresholdBytes: appConfig.toolSpilloverThresholdBytes },
    conversation.id,
    undefined,
    undefined,
    undefined,
    () => ({}),
    undefined,
    undefined,
    undefined,
    undefined,
    manager,
    toolPresentation.bridgeEnabled,
    'codex-subscription'
  )
  const registry = new CompositeToolRegistry(
    native,
    new McpToolRegistryAdapter(manager, 'contract-user', {
      strictValidation: toolPresentation.codexMode !== undefined,
    })
  )
  const nativeNames = new Set(native.listDefinitions().map(definition => definition.name))
  const controller = new DeferrableToolController(
    new DefaultLoopController(),
    nativeNames,
    {
      dynamicToolsEnabled: toolPresentation.bridgeEnabled,
      codexMode: toolPresentation.codexMode,
      codexToolDiscoveryBytes: appConfig.codexToolDiscoveryBytes,
      dynamicToolsThreshold: appConfig.dynamicToolsThreshold,
    },
    {
      get: () => conversation.dynamicToolsBridgeActive,
      set: value => {
        conversation.dynamicToolsBridgeActive = value
      },
    }
  )
  const reasoning = new DefaultReasoningPort(
    new LlmPortAdapter(provider, MODEL, 'codex-subscription'),
    new DefaultPromptBuilder()
  )
  let history: ChatMessage[] = []
  const turn = async (content: string): Promise<LoopResult> => {
    const config = buildLoopConfig({
      reasoning,
      toolRegistry: registry,
      safety: new BasicSafety(),
      events: new SimpleEventEmitter(),
      conversation,
      loopController: controller,
      toolTimeout: appConfig.nativeTool.toolTimeout,
      toolProgressInterval: 0,
    })
    if (toolPresentation.bridgeEnabled) {
      config.bridge = {
        nativeNames,
        getDeferrableCatalogNames: () =>
          new Set(
            manager
              .getAllTools()
              .map(tool => tool.name)
              .filter(name => !nativeNames.has(name))
          ),
      }
    }
    const before = providerCall.mock.calls.length
    const result = await runToolUseLoop(config, [...history, { role: 'user', content }])
    // Liveness witness: the turn reached the provider.
    expect(providerCall.mock.calls.length).toBeGreaterThan(before)
    // The next turn continues from what the Host last sent, plus the answer.
    const sent = providerCall.mock.calls.at(-1)![0].filter(message => message.role !== 'system')
    history =
      result.type === 'response' ? [...sent, { role: 'assistant', content: result.content }] : sent
    return result
  }
  return {
    appConfig,
    toolPresentation,
    manager,
    simulator,
    authorize,
    businessCalls,
    runId,
    turn,
    presented: () => controller.refreshTools(registry.listDefinitions()),
  }
}

type Host = Awaited<ReturnType<typeof host>>

/** Presentation evidence shared by every journey that must run on the bridges. */
function expectBridgedRequests(evidence: Evidence) {
  expect(evidence.requests.length).toBeGreaterThan(0)
  for (const request of evidence.requests) {
    expect(request.connectorDefinitionCount).toBe(0)
    expect(request.leakedSchema).toBe(false)
  }
}

async function receiptJourney(target: Host, catalogSize: number) {
  // The Host presents natives plus the three bridges, never the connector catalog.
  const presented = (await target.presented()).map(tool => tool.name)
  for (const bridge of BRIDGES) expect(presented).toContain(bridge)
  expect(presented.some(name => name.startsWith(`${SERVER}__`))).toBe(false)

  const result = await target.turn('Show my verification receipt and its business ID.')
  // A fixture rejection names its reason before the Host-side outcome is read.
  expect(target.simulator.evidence().rejections).toEqual([])
  expect(result.type).toBe('response')
  const answer = JSON.parse((result as { content: string }).content) as BusinessRecord
  const calls = await target.businessCalls()
  expect(calls).toHaveLength(1)
  expect(answer).toEqual(calls[0])
  expect(answer).toMatchObject({ runId: target.runId, tool: 'workitem_read_receipt' })
  // The receipt the real Host client produced satisfies the shared contract the
  // fixture model enforces. MCP SDK 1.29.0 (mcp-host's installed client)
  // numbers JSON-RPC requests with integers, so callId is one; a change of
  // SDK or transport that alters the id type shows up here first.
  const { businessReceiptProblem } = await vi.importActual<ReceiptModule>(
    `${REPO}tests/e2e/fixtures/codex-subscription/approved-tools/business-receipt.mjs`
  )
  expect(businessReceiptProblem(calls[0], 'mcp')).toBeNull()
  expect(Number.isSafeInteger(calls[0]!.callId)).toBe(true)
  const evidence = target.simulator.evidence()
  expect(evidence).toMatchObject({
    rejected: 0,
    rejections: [],
    searchCalls: 1,
    describeCalls: 1,
    businessCalls: 1,
    finalResponses: 1,
  })
  expect(evidence.requests.map(request => request.stage)).toEqual([...BRIDGES, 'final'])
  expectBridgedRequests(evidence)
  expect(catalogSize).toBeGreaterThan(target.appConfig.dynamicToolsThreshold)
}

describe('approved-tools presentation contract (Host -> proxy -> fixture model)', () => {
  it('application default resolves direct and the fixture model rejects it with missing_discovery_bridge', async () => {
    const target = await host(
      {
        CODEX_TOOL_PRESENTATION: undefined,
        CLERUM_DYNAMIC_TOOLS_THRESHOLD: undefined,
        CLERUM_NATIVE_TOOL_PRESENTATION: undefined,
      },
      83
    )
    expect(target.appConfig.codexToolPresentation).toBe('direct')
    expect(target.toolPresentation).toEqual({ bridgeEnabled: false, codexMode: 'direct' })
    const presented = (await target.presented()).map(tool => tool.name)
    expect(presented.filter(name => name.startsWith(`${SERVER}__`))).toHaveLength(83)
    for (const bridge of BRIDGES) expect(presented).not.toContain(bridge)

    const result = await target.turn('Show my verification receipt and its business ID.')
    expect(result.type).toBe('error')
    // Liveness witness: the request was authorized and reached the fixture model.
    expect(target.authorize).toHaveBeenCalledTimes(1)
    expect(target.simulator.evidence()).toMatchObject({
      rejected: 1,
      rejections: ['missing_discovery_bridge'],
      completions: 0,
      businessCalls: 0,
    })
    expect(await target.businessCalls()).toEqual([])
  })

  it('the Minikube overlay declares auto, threshold 60 and native direct, and runs the receipt journey', async () => {
    const declared = overlayPresentation()
    const target = await host(declared, 83)
    // The journey runs first, so a wrong declaration fails with the fixture
    // model's own rejection reason rather than only a configuration mismatch.
    const result = await target.turn('Show my verification receipt and its business ID.')
    expect(target.simulator.evidence()).toMatchObject({ rejected: 0, rejections: [] })
    expect(result.type).toBe('response')
    expect(declared.CODEX_TOOL_PRESENTATION).toBe('auto')
    // The threshold stays the application default (60) unless declared as 60.
    expect([undefined, '60']).toContain(declared.CLERUM_DYNAMIC_TOOLS_THRESHOLD)
    // Native auto would add natives to the discovery catalog the fixture searches.
    expect([undefined, 'direct']).toContain(declared.CLERUM_NATIVE_TOOL_PRESENTATION)
    expect(target.appConfig.codexToolPresentation).toBe('auto')
    expect(target.appConfig.dynamicToolsThreshold).toBe(60)
    const calls = await target.businessCalls()
    expect(calls).toHaveLength(1)
    expect(JSON.parse((result as { content: string }).content)).toEqual(calls[0])
    const evidence = target.simulator.evidence()
    expect(evidence.requests.map(request => request.stage)).toEqual([...BRIDGES, 'final'])
    expectBridgedRequests(evidence)
  })

  it.each([83, 150, 250])(
    'auto presents the bridges for %i tools and completes search, describe, call and answer',
    async catalogSize => {
      const target = await host(
        {
          CODEX_TOOL_PRESENTATION: 'auto',
          CLERUM_DYNAMIC_TOOLS_THRESHOLD: undefined,
          CLERUM_NATIVE_TOOL_PRESENTATION: undefined,
        },
        catalogSize
      )
      expect(target.appConfig.dynamicToolsThreshold).toBe(60)
      expect(target.toolPresentation).toEqual({ bridgeEnabled: true, codexMode: 'auto' })
      await receiptJourney(target, catalogSize)
    }
  )

  it('auto reuses the described tool on the next turn and reports the empty catalog after revocation', async () => {
    const target = await host(
      {
        CODEX_TOOL_PRESENTATION: 'auto',
        CLERUM_DYNAMIC_TOOLS_THRESHOLD: undefined,
        CLERUM_NATIVE_TOOL_PRESENTATION: undefined,
      },
      83
    )
    await receiptJourney(target, 83)

    const reuse = await target.turn('Show my verification receipt again.')
    expect(reuse.type).toBe('response')
    const calls = await target.businessCalls()
    expect(calls).toHaveLength(2)
    expect(JSON.parse((reuse as { content: string }).content)).toEqual(calls[1])
    // Reuse goes straight to the call bridge: no second search or describe.
    expect(target.simulator.evidence()).toMatchObject({
      rejected: 0,
      searchCalls: 1,
      describeCalls: 1,
      businessCalls: 2,
      finalResponses: 2,
    })

    await target.manager.removeServer(SERVER)
    // Liveness witness: the Host catalog is now empty.
    expect(target.manager.getAllTools()).toEqual([])
    const revoked = await target.turn('Show my verification receipt again, please.')
    expect(revoked.type).toBe('response')
    const evidence = target.simulator.evidence()
    expect(evidence).toMatchObject({
      rejected: 0,
      rejections: [],
      businessCalls: 3,
      searchCalls: 2,
      deniedResponses: 1,
    })
    // The answer is the real empty search result, and no business call ran.
    expect(JSON.parse((revoked as { content: string }).content)).toMatchObject({
      found: 0,
      results: [],
    })
    expect(await target.businessCalls()).toHaveLength(2)
    expectBridgedRequests(evidence)
  })

  it('auto turns 257 tool calls into tool_call_limit_exceeded without a retry or a connector call', async () => {
    const target = await host(
      {
        CODEX_TOOL_PRESENTATION: 'auto',
        CLERUM_DYNAMIC_TOOLS_THRESHOLD: undefined,
        CLERUM_NATIVE_TOOL_PRESENTATION: undefined,
      },
      83
    )
    const result = await target.turn('tool call limit probe')
    expect(result.type).toBe('error')
    const error = (result as { error: Error }).error
    // The Host taxonomy Desktop renders as "Too Many Tool Calls".
    expect(error).toBeInstanceOf(LlmError)
    expect((error as LlmError).code).toBe(LlmErrorCode.ToolCallLimitExceeded)
    // Liveness witness: the probe turn was served once and never repeated.
    expect(target.simulator.evidence()).toMatchObject({
      rejected: 0,
      limitProbe: { turns: 1, completions: 1, unexpectedRetries: 0 },
      searchCalls: 0,
    })
    expect(await target.businessCalls()).toEqual([])
  })

  it('auto completes a turn of exactly 256 tool calls', async () => {
    const target = await host(
      {
        CODEX_TOOL_PRESENTATION: 'auto',
        CLERUM_DYNAMIC_TOOLS_THRESHOLD: undefined,
        CLERUM_NATIVE_TOOL_PRESENTATION: undefined,
      },
      83
    )
    const result = await target.turn('tool call limit boundary')
    expect(result).toMatchObject({
      type: 'response',
      content: 'Tool call limit boundary complete: 256 tool results received.',
    })
    expect(target.simulator.evidence()).toMatchObject({
      rejected: 0,
      rejections: [],
      limitBoundary: {
        turns: 1,
        completions: 2,
        toolResults: 256,
        finalResponses: 1,
        unexpectedRetries: 0,
      },
    })
    expect(await target.businessCalls()).toEqual([])
  })
})
