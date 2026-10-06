import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashCanonicalCodexRequest } from '@clerum/llm-provider-attempt-contract'
import { LlmPortAdapter } from '../core/adapters/llmPortAdapter'
import type { NativeToolConfig } from '../core/interfaces'
import { appendToolResults } from '../core/orchestration/toolUseLoopMessages'
import { NativeToolRegistry } from '../core/tools/nativeToolRegistry'
import type { Attachment, ChatMessage, ToolResult } from '../core/types'
import { realPngOfDecodedBytesBase64 } from '../llm/__tests__/codexImageFixtures'
import { ClaudeProvider } from '../llm/claude'
import { CodexSubscriptionProvider } from '../llm/codexSubscription'
import type { ImageInputResolver } from '../llm/imageInput'
import { OpenAIProvider } from '../llm/openai'
import { OpenAICompatibleProvider } from '../llm/openaiCompatible'
import type { LlmProvider } from '../llm/registryCore'
import type { SingleTurnProvider } from '../llm/types'
import { VisualInputBudget } from '../visualInput/policy'
import { projectGfsApproval } from '../visualInput/suspension'
import { GfsDownloadStore } from './gfsDownloadStore'
import type { GfsProcessingLeaseProvider } from './gfsProcessingLease'

const { sdkCreate, clientFactory } = vi.hoisted(() => ({
  sdkCreate: vi.fn(),
  clientFactory: vi.fn(),
}))

// Only external transport boundaries are replaced. Production client, tool,
// native adapter, message construction and provider serialization all execute.
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: sdkCreate } }
  },
}))
vi.mock('./gfsClient', async importOriginal => ({
  ...(await importOriginal<typeof import('./gfsClient')>()),
  getGfsToolScopes: () => new Set(['gfs.read']),
  createGfscClient: clientFactory,
}))

const rid = '1234567890abcdef1234567890abcdef'
const uri = `gfs://main/${rid}`
const model = 'example/vision-model'
type CatalogState = 'supported' | 'unsupported' | 'unknown' | 'missing' | 'codex-present'
const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 0,
  httpAllowlist: [],
  envAllowlist: [],
  memoryMaxSize: 1048576,
}
const stores: GfsDownloadStore[] = []
const temporaryRoots: string[] = []

function codexFixture() {
  const authorize = vi.fn(async (input: { request: unknown; requestHash: string }) => {
    const canonical = hashCanonicalCodexRequest(input.request)
    if (!canonical.ok) throw new Error(`invalid unit wire request: ${canonical.code}`)
    expect(input.requestHash).toBe(canonical.value.requestHash)
    return {
      providerAttemptId: 'unit-attempt',
      requestHash: input.requestHash,
      executionTicket: 'unit-only-execution-ticket',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }
  })
  const stream = vi.fn(async (_input: { request: unknown; requestHash: string }) => ({
    text: 'seen',
    toolCalls: [],
    outcome: 'success' as const,
  }))
  const provider = new CodexSubscriptionProvider('gpt-5.6-luna', {
    authorizer: { authorize },
    proxy: { stream },
    attemptContext: () => ({ policyRevision: 1, policyHash: 'b'.repeat(64), hostRef: 'chatllm' }),
  } as never)
  return {
    authorize,
    stream,
    llm: { provider, model: 'gpt-5.6-luna', name: 'codex-subscription' as const },
  }
}

async function setup(
  bytes: Buffer,
  options: {
    name?: string
    catalogState?: CatalogState
    llm?: { provider: SingleTurnProvider; model: string; name: LlmProvider }
    managed?: boolean
  } = {}
) {
  const { createGfscClient } = await vi.importActual<typeof import('./gfsClient')>('./gfsClient')
  const gfsFetch = vi.fn(async (url: string) =>
    url.includes('/content?')
      ? new Response(new Uint8Array(bytes), {
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.length),
            'x-gfs-uri': uri,
            'x-gfs-version': '7',
          },
        })
      : new Response(
          JSON.stringify({
            ok: true,
            data: {
              resourceId: rid,
              rid,
              drive: 'main',
              gfsUri: uri,
              version: 7,
              kind: 'file',
              name: options.name ?? 'neutral.png',
              bytes: bytes.length,
            },
          }),
          { headers: { 'content-type': 'application/json' } }
        )
  )
  clientFactory.mockReturnValue(
    createGfscClient(
      {
        get: () => undefined,
        readFile: async () => 'integration-only-identity',
        fetch: gfsFetch,
      },
      { maxRetryWaitMs: config.toolTimeout, random: () => 0 }
    )
  )
  const metadataFetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          data: {
            id: model,
            architecture: { input_modalities: ['text', 'image'] },
          },
        }),
        { headers: { 'content-type': 'application/json' } }
      )
  )
  vi.stubGlobal('fetch', metadataFetch)
  sdkCreate.mockResolvedValue({
    choices: [{ message: { content: 'Done' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  })
  const provider =
    options.llm?.provider ??
    new OpenAICompatibleProvider(
      {
        id: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        defaultModel: model,
      },
      'integration-only-provider-identity',
      model
    )
  const budget = new VisualInputBudget()
  let catalogState = options.catalogState ?? 'supported'
  const evidence = {
    source: 'curated' as const,
    reference: 'https://example.com/image-input',
    checkedAt: '2026-09-18T00:00:00Z',
  }
  const imageInputResolver: ImageInputResolver = () => {
    if (catalogState === 'missing') return undefined
    if (catalogState === 'codex-present') return { capability: undefined }
    if (catalogState === 'unknown') return { capability: { state: 'unknown' } }
    return { capability: { state: catalogState, evidence } }
  }
  const adapter = new LlmPortAdapter(
    provider,
    options.llm?.model ?? model,
    options.llm?.name ?? 'openrouter',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    imageInputResolver
  )
  let managed:
    | {
        store: GfsDownloadStore
        deliveryAvailable: boolean
        callerIdentity: string
        callerWorkspacePath: string
        processingLeaseProvider: GfsProcessingLeaseProvider
        retentionOwnerId: string
      }
    | undefined
  if (options.managed) {
    const root = await fs.mkdtemp(join(tmpdir(), 'gfs-image-wire-'))
    temporaryRoots.push(root)
    const callerWorkspacePath = join(root, 'users', 'unit-caller')
    await fs.mkdir(callerWorkspacePath, { recursive: true, mode: 0o700 })
    const store = new GfsDownloadStore(root)
    await store.initialize()
    stores.push(store)
    managed = {
      store,
      deliveryAvailable: true,
      callerWorkspacePath,
      callerIdentity: 'unit-caller',
      processingLeaseProvider: store.processingLeaseProvider('unit-caller'),
      retentionOwnerId: 'gfs-image-integration-task',
    }
  }
  const tool = new NativeToolRegistry(
    config,
    'gfs-image-integration',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.llm?.name,
    managed
  ).get('clerum__gfs_read')!
  const output = await tool.execute(
    { drive: 'main', resourceId: rid },
    {
      onOutput: () => {},
      timeoutMs: 10000,
      visualInput: { budget, resolveCapability: signal => adapter.getImageInputCapability(signal) },
    }
  )
  const result: ToolResult = { ...output, name: 'clerum__gfs_read', tool_call_id: 'read-image' }
  const messages: ChatMessage[] = [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'read-image',
          name: 'clerum__gfs_read',
          arguments: { drive: 'main', resourceId: rid },
        },
      ],
    },
  ]
  const collected: Attachment[] = []
  appendToolResults(messages, [result], collected)
  return {
    adapter,
    messages,
    output,
    gfsFetch,
    metadataFetch,
    budget,
    collected,
    tool,
    setCatalogState: (state: CatalogState) => {
      catalogState = state
    },
  }
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store
      .releaseReceiptOwner('gfs-image-integration-task', 'unit-caller')
      .catch(() => undefined)
    await store.close()
  }
  for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('GFS bytes to actual provider request', () => {
  it('preserves a native-decoded managed PNG beyond 3 MiB in the actual canonical Codex wire', async () => {
    const transport = codexFixture()
    const bytes = Buffer.from(realPngOfDecodedBytesBase64(3 * 1024 * 1024 + 1), 'base64')
    const subject = await setup(bytes, {
      managed: true,
      llm: transport.llm,
      catalogState: 'codex-present',
    })
    const receipt = JSON.parse(subject.output.content)
    expect(receipt).toMatchObject({
      delivery: 'workspace_file',
      sizeBytes: bytes.byteLength,
      visualDelivery: 'included',
      usage: { visualDelivery: 'included' },
    })
    expect(receipt.path).toMatch(/^\.gfs-downloads\//)
    const original = structuredClone(subject.messages)
    await subject.adapter.completeWithTools({ messages: subject.messages, tools: [] })
    const authorized = transport.authorize.mock.calls[0]![0]
    const wire = authorized.request as {
      messages: Array<{ contentParts?: Array<{ type: string; data?: string }> }>
    }
    expect(
      wire.messages
        .flatMap(message => message.contentParts ?? [])
        .find(part => part.type === 'image')?.data
    ).toBe(bytes.toString('base64'))
    expect(transport.stream.mock.calls[0]![0]).toMatchObject({
      request: authorized.request,
      requestHash: authorized.requestHash,
    })
    expect(subject.messages).toEqual(original)
    subject.budget.close()
  })
  it.each(['openai', 'claude'] as const)(
    'delivers a native-decoded managed PNG beyond 3 MiB through the official %s instance',
    async type => {
      const create = vi.fn(async (_request: unknown) => ({
        content: [{ type: 'text', text: 'seen' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }))
      const targetModel = type === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-6'
      const provider =
        type === 'openai'
          ? new OpenAIProvider(
              {
                baseURL: 'https://api.openai.com/v1',
                chat: { completions: { create: sdkCreate } },
              } as never,
              targetModel
            )
          : new ClaudeProvider(
              { baseURL: 'https://api.anthropic.com', messages: { create } } as never,
              targetModel
            )
      const bytes = Buffer.from(realPngOfDecodedBytesBase64(3 * 1024 * 1024 + 1), 'base64')
      const subject = await setup(bytes, {
        managed: true,
        llm: { provider, model: targetModel, name: type },
      })
      expect(JSON.parse(subject.output.content)).toMatchObject({
        delivery: 'workspace_file',
        sizeBytes: bytes.byteLength,
        visualDelivery: 'included',
        usage: { visualDelivery: 'included' },
      })
      const original = structuredClone(subject.messages)
      await subject.adapter.completeWithTools({ messages: subject.messages, tools: [] })
      const request = type === 'openai' ? sdkCreate.mock.calls[0]![0] : create.mock.calls[0]![0]
      const content = (request as { messages: Array<{ content: unknown }> }).messages.flatMap(
        message => (Array.isArray(message.content) ? message.content : [])
      )
      if (type === 'openai') {
        expect(content.find(part => part.type === 'image_url')?.image_url.url).toBe(
          `data:image/png;base64,${bytes.toString('base64')}`
        )
      } else {
        expect(content.find(part => part.type === 'image')?.source).toEqual({
          type: 'base64',
          media_type: 'image/png',
          data: bytes.toString('base64'),
        })
      }
      expect(subject.messages).toEqual(original)
      subject.budget.close()
    }
  )
  it.each(['image/png', 'image/jpeg'] as const)(
    'delivers %s through the verified official OpenAI instance and catalog vision evidence',
    async mime => {
      const model = 'gpt-4.1'
      // Only the SDK HTTP boundary is doubled; no credential or catalog service.
      const client = {
        baseURL: 'https://api.openai.com/v1',
        chat: { completions: { create: sdkCreate } },
      }
      const canvas = createCanvas(8, 8)
      canvas.getContext('2d').fillRect(1, 1, 4, 4)
      const bytes =
        mime === 'image/png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg')
      const subject = await setup(bytes, {
        llm: {
          provider: new OpenAIProvider(client as never, model),
          model,
          name: 'openai',
        },
      })
      expect(JSON.parse(subject.output.content).delivery).toBe('image_input')
      await subject.adapter.completeWithTools({ messages: subject.messages, tools: [] })
      expect(subject.metadataFetch).not.toHaveBeenCalled()
      const request = sdkCreate.mock.calls[0][0]
      const images = request.messages
        .flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
        .filter((part: any) => part.type === 'image_url')
      expect(images).toEqual([
        {
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${bytes.toString('base64')}` },
        },
      ])
      expect(request.model).toBe(model)
      subject.budget.close()
    }
  )

  it('supports an official OpenAI instance with catalog-supported vision beyond the old model allowlist', async () => {
    const client = {
      baseURL: 'https://api.openai.com/v1',
      chat: { completions: { create: sdkCreate } },
    }
    const provider = new OpenAIProvider(client as never, 'future-vision-model')
    const bytes = createCanvas(2, 2).toBuffer('image/png')
    const subject = await setup(bytes, {
      llm: { provider, model: 'future-vision-model', name: 'openai' },
    })

    expect(JSON.parse(subject.output.content).delivery).toBe('image_input')
    await subject.adapter.completeWithTools({ messages: subject.messages, tools: [] })
    expect(JSON.stringify(sdkCreate.mock.calls[0][0])).toContain(bytes.toString('base64'))
    expect(subject.metadataFetch).not.toHaveBeenCalled()
    subject.budget.close()
  })

  it('returns a reference when the catalog omits a documented vision model', async () => {
    const client = {
      baseURL: 'https://api.openai.com/v1',
      chat: { completions: { create: sdkCreate } },
    }
    const provider = new OpenAIProvider(client as never, 'gpt-4.1')
    const subject = await setup(createCanvas(2, 2).toBuffer('image/png'), {
      catalogState: 'missing',
      llm: { provider, model: 'gpt-4.1', name: 'openai' },
    })

    expect(JSON.parse(subject.output.content)).toMatchObject({
      delivery: 'reference_only',
      reason: 'model_image_input_unknown',
    })
    expect(subject.output.attachments).toBeUndefined()
    expect(sdkCreate).not.toHaveBeenCalled()
    subject.budget.close()
  })

  it('withholds an admitted GFS image if catalog support is revoked before dispatch', async () => {
    const transport = codexFixture()
    const subject = await setup(createCanvas(2, 2).toBuffer('image/png'), {
      llm: transport.llm,
      catalogState: 'codex-present',
    })
    expect(JSON.parse(subject.output.content).delivery).toBe('image_input')
    subject.setCatalogState('missing')

    await subject.adapter.completeWithTools({ messages: subject.messages, tools: [] })

    expect(
      subject.messages.some(message => message.contentParts?.some(part => part.type === 'image'))
    ).toBe(true)
    const sentRequest = transport.authorize.mock.calls[0]![0].request as {
      messages: Array<{ role: string; content: string }>
    }
    expect(JSON.stringify(sentRequest)).not.toContain('"type":"image"')
    const sentTool = sentRequest.messages.find(
      (message: { role: string }) => message.role === 'tool'
    )
    expect(JSON.parse(sentTool!.content)).toMatchObject({
      delivery: 'reference_only',
      reason: 'model_image_input_unavailable',
    })
    subject.budget.close()
  })

  it('delivers a GFS image through Codex V2 for a present catalog row', async () => {
    const { authorize, stream, llm } = codexFixture()
    const bytes = createCanvas(2, 2).toBuffer('image/png')
    const subject = await setup(bytes, {
      catalogState: 'codex-present',
      llm,
    })

    expect(JSON.parse(subject.output.content).delivery).toBe('image_input')
    await subject.adapter.completeWithTools({ messages: subject.messages, tools: [] })

    const authorized = authorize.mock.calls[0]![0].request as {
      messages: Array<{ contentParts?: Array<{ type: string }> }>
    }
    const image = authorized.messages
      .flatMap((message: { contentParts?: Array<{ type: string }> }) => message.contentParts ?? [])
      .find((part: { type: string }) => part.type === 'image')
    expect(image).toMatchObject({
      type: 'image',
      data: bytes.toString('base64'),
      source: { kind: 'tool', toolCallId: 'read-image' },
    })
    expect(stream).toHaveBeenCalledOnce()
    subject.budget.close()
  })

  it.each([
    ['image/png', false],
    ['image/jpeg', false],
    ['image/png', true],
    ['image/jpeg', true],
  ] as const)(
    'delivers %s through the verified official Claude instance, cache=%s',
    async (mime, cache) => {
      const targetModel = 'claude-sonnet-4-6'
      // Credential-free SDK boundary double. The production provider serializer,
      // client/tool registry and loop still execute.
      const create = vi.fn(async () => ({
        content: [{ type: 'text', text: 'Done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
      }))
      const client = { baseURL: 'https://api.anthropic.com', messages: { create } }
      const canvas = createCanvas(8, 8)
      canvas.getContext('2d').fillRect(1, 1, 4, 4)
      const bytes =
        mime === 'image/png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg')
      const subject = await setup(bytes, {
        llm: {
          provider: new ClaudeProvider(client as never, targetModel),
          model: targetModel,
          name: 'claude',
        },
      })
      expect(subject.output.is_error).toBe(false)
      await subject.adapter.completeWithTools({
        messages: subject.messages,
        tools: [],
        ...(cache
          ? {
              systemPromptParts: {
                stable: 'system instructions',
                context: 'context',
                stableHash: 'fixture',
                contextHash: 'fixture',
              },
            }
          : {}),
      })
      expect(subject.metadataFetch).not.toHaveBeenCalled()
      const request = (create.mock.calls as unknown as Array<[Record<string, any>]>)[0][0]
      const blocks = request.messages.flatMap((m: any) =>
        Array.isArray(m.content) ? m.content : []
      )
      expect(blocks.filter((b: any) => b.type === 'image')).toEqual([
        {
          type: 'image',
          source: { type: 'base64', media_type: mime, data: bytes.toString('base64') },
        },
      ])
      expect(JSON.stringify(blocks.filter((b: any) => b.type !== 'image'))).not.toContain(
        bytes.toString('base64')
      )
      if (cache) expect(request.system[0].cache_control).toEqual({ type: 'ephemeral' })
      subject.budget.close()
    }
  )
  it.each(['unchanged', 'replaced', 'revoked'] as const)(
    'requires a new authorized read after suspension when the resource is %s',
    async state => {
      const original = createCanvas(2, 2).toBuffer('image/png')
      const transport = codexFixture()
      const subject = await setup(original, { llm: transport.llm, catalogState: 'codex-present' })
      const restored = projectGfsApproval({
        request_id: 'approval',
        tool_name: 'shell_exec',
        tool_call_id: 'pending-action',
        parameters: { command: 'echo done' },
        description: 'pending action',
        context_snapshot: subject.messages,
      })
      expect(JSON.stringify(restored)).not.toContain(original.toString('base64'))
      expect(JSON.stringify(restored)).toContain('new_gfs_read_required_after_suspension')
      expect(subject.gfsFetch).toHaveBeenCalledTimes(2)
      const replacement = createCanvas(3, 3).toBuffer('image/png')
      if (state === 'revoked')
        subject.gfsFetch.mockResolvedValueOnce(new Response('denied', { status: 403 }))
      if (state === 'replaced') {
        subject.gfsFetch.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              data: {
                resourceId: rid,
                rid,
                drive: 'main',
                gfsUri: uri,
                version: 8,
                kind: 'file',
                name: 'neutral.png',
                bytes: replacement.length,
              },
            })
          )
        )
        subject.gfsFetch.mockResolvedValueOnce(
          new Response(new Uint8Array(replacement), {
            headers: {
              'x-gfs-uri': uri,
              'x-gfs-version': '8',
              'content-length': String(replacement.length),
            },
          })
        )
      }
      const reread = await subject.tool.execute(
        { drive: 'main', resourceId: rid },
        {
          onOutput: () => {},
          timeoutMs: 10000,
          visualInput: {
            budget: subject.budget,
            resolveCapability: signal => subject.adapter.getImageInputCapability(signal),
          },
        }
      )
      restored.context_snapshot.push({
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'explicit-reread',
            name: 'clerum__gfs_read',
            arguments: { drive: 'main', resourceId: rid },
          },
        ],
      })
      appendToolResults(
        restored.context_snapshot,
        [{ ...reread, name: 'clerum__gfs_read', tool_call_id: 'explicit-reread' }],
        []
      )
      const images = restored.context_snapshot
        .flatMap(message => message.contentParts ?? [])
        .filter(part => part.type === 'image')
      if (state === 'revoked') {
        expect(reread.is_error).toBe(true)
        expect(images).toHaveLength(0)
        expect(subject.gfsFetch).toHaveBeenCalledTimes(3)
      } else {
        expect(reread.is_error).toBe(false)
        expect(images).toHaveLength(1)
        expect(images[0].source?.kind === 'gfs' ? images[0].source.version : undefined).toBe(
          state === 'replaced' ? 8 : 7
        )
        expect(images[0].data).toBe(
          (state === 'replaced' ? replacement : original).toString('base64')
        )
        expect(subject.gfsFetch).toHaveBeenCalledTimes(4)
      }
      expect(restored.tool_call_id).toBe('pending-action')
      expect(restored.parameters).toEqual({ command: 'echo done' })
      subject.budget.close()
    }
  )
  it('does not silently lose an image when a shaper changes its message role', async () => {
    const subject = await setup(createCanvas(1, 1).toBuffer('image/png'))
    const shaped = subject.messages.map(message =>
      message.contentParts?.some(p => p.type === 'image')
        ? { ...message, role: 'system' as const }
        : message
    )
    await subject.adapter.completeWithTools({ messages: shaped, tools: [] })
    expect(sdkCreate).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(sdkCreate.mock.calls[0][0])).not.toContain('image_url')
    subject.budget.close()
  })
  it('keeps the destination gate after shaping removes optional image provenance fields', async () => {
    const transport = codexFixture()
    const subject = await setup(createCanvas(1, 1).toBuffer('image/png'), {
      llm: transport.llm,
      catalogState: 'codex-present',
    })
    const shaped = subject.messages.map(message => ({
      ...message,
      contentParts: message.contentParts?.map(part =>
        part.type === 'image'
          ? { type: 'image' as const, mimeType: part.mimeType, data: part.data }
          : part
      ),
    }))
    const completeSingleTurnWithTools = vi.fn().mockResolvedValue({
      content: 'degraded',
      tool_calls: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      finish_reason: 'stop',
    })
    const fallback = new LlmPortAdapter(
      {
        completeSingleTurn: vi.fn(),
        completeSingleTurnWithTools,
        getProviderType: () => 'openai' as const,
        classifyError: vi.fn(),
      },
      'unknown-model',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined
    )
    const fallbackMessages = structuredClone(shaped)
    await fallback.completeWithTools({ messages: fallbackMessages, tools: [] })
    expect(completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
    expect(fallbackMessages.some(m => m.contentParts?.some(p => p.type === 'image'))).toBe(true)
    expect(JSON.stringify(completeSingleTurnWithTools.mock.calls[0][0])).not.toContain(
      '"type":"image"'
    )
    expect(sdkCreate).not.toHaveBeenCalled()
    // The source-binding Codex transport cannot accept pixels whose source was removed.
    await expect(
      subject.adapter.completeWithTools({ messages: shaped, tools: [] })
    ).rejects.toBeDefined()
    expect(transport.stream).not.toHaveBeenCalled()
    subject.budget.close()
  })
  it.each(['image/png', 'image/jpeg'] as const)(
    'preserves unchanged %s bytes through the validated Codex wire',
    async mime => {
      const canvas = createCanvas(8, 8)
      const context = canvas.getContext('2d')
      context.fillStyle = '#186bcc'
      context.fillRect(0, 0, 8, 8)
      const bytes =
        mime === 'image/png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg')
      const transport = codexFixture()
      const subject = await setup(bytes, {
        name: 'incorrect-extension.txt',
        llm: transport.llm,
        catalogState: 'codex-present',
      })
      expect(subject.output.is_error).toBe(false)
      expect(subject.output.attachments?.[0].visualSource).toMatchObject({
        gfsUri: uri,
        version: 7,
      })
      expect(subject.collected).toEqual([])
      await subject.adapter.completeWithTools({ messages: subject.messages, tools: [] })
      const request = transport.authorize.mock.calls[0]![0].request as {
        messages: Array<{
          role: string
          content: string
          contentParts?: Array<{ type: string; data?: string }>
        }>
      }
      const imagePart = request.messages
        .flatMap(m => m.contentParts ?? [])
        .find(part => part.type === 'image')
      expect(imagePart!.data).toBe(bytes.toString('base64'))
      const toolMessage = request.messages.find((m: { role: string }) => m.role === 'tool')
      expect(typeof toolMessage!.content).toBe('string')
      expect(toolMessage!.content).not.toContain(bytes.toString('base64'))
      expect(subject.metadataFetch).not.toHaveBeenCalled()
      expect(subject.gfsFetch).toHaveBeenCalledTimes(2)
      subject.budget.close()
      expect(subject.budget.residentBytes).toBe(0)
    }
  )

  it.each([
    '',
    '\ufeffBOM and acentos: áéíóú',
    'tabs\tLF\nCRLF\r\n',
    '{"ok":false,"data":"text"}',
    'PK is a text prefix. RIFF is also a word. Unicode: 🌴\r\n',
  ])('keeps UTF-8 text usable without requiring vision: %j', async text => {
    const subject = await setup(Buffer.from(text), { name: 'note.txt', catalogState: 'missing' })
    expect(subject.output.content).toBe(text.replace(/^\ufeff/, ''))
    expect(subject.output.attachments).toBeUndefined()
    await subject.adapter.completeWithTools({ messages: subject.messages, tools: [] })
    expect(subject.metadataFetch).not.toHaveBeenCalled()
    expect(sdkCreate).toHaveBeenCalledTimes(1)
    subject.budget.close()
  })

  it.each([
    Buffer.from('a\0b'),
    Buffer.from([0xc3, 0x28]),
    Buffer.from([0x01, 0x41]),
    Buffer.from('%PDF-1.7'),
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
    Buffer.from('<svg/>'),
  ])('returns a reference instead of interpreting unsupported bytes as text', async bytes => {
    const subject = await setup(bytes, { name: 'misleading.txt' })
    expect(JSON.parse(subject.output.content).delivery).toBe('reference_only')
    expect(subject.output.attachments).toBeUndefined()
    expect(subject.metadataFetch).not.toHaveBeenCalled()
    subject.budget.close()
  })

  it.each([
    { catalogState: 'unsupported' },
    { catalogState: 'unknown' },
    { catalogState: 'missing' },
  ] as const)(
    'returns an explicit reference when catalog image capability is not established: %j',
    async options => {
      const subject = await setup(createCanvas(1, 1).toBuffer('image/png'), options)
      expect(JSON.parse(subject.output.content).delivery).toBe('reference_only')
      expect(subject.output.attachments).toBeUndefined()
      expect(subject.messages.some(m => m.contentParts?.some(p => p.type === 'image'))).toBe(false)
      subject.budget.close()
    }
  )

  it('rechecks the actual destination instead of forwarding images to an unknown fallback', async () => {
    const transport = codexFixture()
    const subject = await setup(createCanvas(1, 1).toBuffer('image/png'), {
      llm: transport.llm,
      catalogState: 'codex-present',
    })
    const completeSingleTurnWithTools = vi.fn().mockResolvedValue({
      content: 'degraded',
      tool_calls: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      finish_reason: 'stop',
    })
    const fallback = new LlmPortAdapter(
      {
        completeSingleTurn: vi.fn(),
        completeSingleTurnWithTools,
        getProviderType: () => 'openai' as const,
        classifyError: vi.fn(),
      },
      'unknown-model',
      'openai'
    )
    const fallbackMessages = structuredClone(subject.messages)
    await fallback.completeWithTools({ messages: fallbackMessages, tools: [] })
    expect(completeSingleTurnWithTools).toHaveBeenCalledTimes(1)
    expect(fallbackMessages.some(m => m.contentParts?.some(p => p.type === 'image'))).toBe(true)
    expect(JSON.stringify(completeSingleTurnWithTools.mock.calls[0][0])).not.toContain(
      '"type":"image"'
    )
    expect(sdkCreate).not.toHaveBeenCalled()
    subject.budget.close()
  })
})
