import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { LlmPortAdapter } from '../core/adapters/llmPortAdapter'
import type { NativeToolConfig } from '../core/interfaces'
import { appendToolResults } from '../core/orchestration/toolUseLoopMessages'
import { NativeToolRegistry } from '../core/tools/nativeToolRegistry'
import type { Attachment, ChatMessage, ToolResult } from '../core/types'
import { OpenAIProvider } from '../llm/openai'
import { OpenAICompatibleProvider } from '../llm/openaiCompatible'
import { VisualInputBudget } from '../visualInput/policy'
import { projectGfsApproval } from '../visualInput/suspension'

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
const config: NativeToolConfig = {
  workspacePath: '/tmp',
  shellTimeout: 5000,
  toolTimeout: 60000,
  toolProgressInterval: 0,
  httpAllowlist: [],
  envAllowlist: [],
  memoryMaxSize: 1048576,
}

async function setup(
  bytes: Buffer,
  options: { name?: string; modalities?: string[]; missing?: boolean } = {}
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
    createGfscClient({
      get: () => undefined,
      readFile: async () => 'integration-only-identity',
      fetch: gfsFetch,
    })
  )
  const metadataFetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          data: {
            id: model,
            ...(options.missing
              ? {}
              : { architecture: { input_modalities: options.modalities ?? ['text', 'image'] } }),
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
  const provider = new OpenAICompatibleProvider(
    {
      id: 'openrouter',
      baseURL: 'https://openrouter.ai/api/v1',
      defaultModel: model,
    },
    'integration-only-provider-identity',
    model
  )
  const budget = new VisualInputBudget()
  const adapter = new LlmPortAdapter(
    provider,
    model,
    'openrouter',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    budget
  )
  const tool = new NativeToolRegistry(config, 'gfs-image-integration').get('clerum__gfs_read')!
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
  return { adapter, messages, output, gfsFetch, metadataFetch, budget, collected, tool }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('GFS bytes to actual provider request', () => {
  it.each(['unchanged', 'replaced', 'revoked'] as const)(
    'requires a new authorized read after suspension when the resource is %s',
    async state => {
      const original = createCanvas(2, 2).toBuffer('image/png')
      const subject = await setup(original)
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
        expect(images[0].source?.version).toBe(state === 'replaced' ? 8 : 7)
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
    await expect(
      subject.adapter.completeWithTools({ messages: shaped, tools: [] })
    ).rejects.toThrow('Image input must remain in its user visual message')
    expect(sdkCreate).not.toHaveBeenCalled()
    subject.budget.close()
  })
  it('keeps the destination gate after shaping removes optional image provenance fields', async () => {
    const subject = await setup(createCanvas(1, 1).toBuffer('image/png'))
    const shaped = subject.messages.map(message => ({
      ...message,
      contentParts: message.contentParts?.map(part =>
        part.type === 'image'
          ? { type: 'image' as const, mimeType: part.mimeType, data: part.data }
          : part
      ),
    }))
    const fallback = new LlmPortAdapter(
      new OpenAIProvider('integration-only', 'unknown-model'),
      'unknown-model',
      'openai',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      subject.budget
    )
    await expect(fallback.completeWithTools({ messages: shaped, tools: [] })).rejects.toThrow(
      'Image input is not verified'
    )
    expect(sdkCreate).not.toHaveBeenCalled()
    await subject.adapter.completeWithTools({ messages: shaped, tools: [] })
    expect(sdkCreate).toHaveBeenCalledTimes(1)
    subject.budget.close()
  })
  it.each(['image/png', 'image/jpeg'] as const)(
    'delivers unchanged %s bytes as a visual part',
    async mime => {
      const canvas = createCanvas(8, 8)
      const context = canvas.getContext('2d')
      context.fillStyle = '#186bcc'
      context.fillRect(0, 0, 8, 8)
      const bytes =
        mime === 'image/png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg')
      const subject = await setup(bytes, { name: 'incorrect-extension.txt' })
      expect(subject.output.is_error).toBe(false)
      expect(subject.output.attachments?.[0].visualSource).toMatchObject({
        gfsUri: uri,
        version: 7,
      })
      expect(subject.collected).toEqual([])
      await subject.adapter.completeWithTools({ messages: subject.messages, tools: [] })
      const request = sdkCreate.mock.calls[0][0]
      const imagePart = request.messages
        .flatMap((m: { content: unknown }) => (Array.isArray(m.content) ? m.content : []))
        .find((p: { type?: string }) => p.type === 'image_url')
      expect(imagePart.image_url.url).toBe(`data:${mime};base64,${bytes.toString('base64')}`)
      const toolMessage = request.messages.find((m: { role: string }) => m.role === 'tool')
      expect(typeof toolMessage.content).toBe('string')
      expect(toolMessage.content).not.toContain(bytes.toString('base64'))
      expect(subject.metadataFetch).toHaveBeenCalledTimes(1)
      expect(subject.metadataFetch.mock.calls[0][0]).toBe(
        `https://openrouter.ai/api/v1/model/example/vision-model`
      )
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
    const subject = await setup(Buffer.from(text), { name: 'note.txt', modalities: ['text'] })
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
  ])('returns a reference instead of interpreting unsupported bytes as text', async bytes => {
    const subject = await setup(bytes, { name: 'misleading.txt' })
    expect(JSON.parse(subject.output.content).delivery).toBe('reference_only')
    expect(subject.output.attachments).toBeUndefined()
    expect(subject.metadataFetch).not.toHaveBeenCalled()
    subject.budget.close()
  })

  it.each([{ modalities: ['text'] }, { missing: true }])(
    'returns an explicit reference when image capability is not established: %j',
    async options => {
      const subject = await setup(createCanvas(1, 1).toBuffer('image/png'), options)
      expect(JSON.parse(subject.output.content).delivery).toBe('reference_only')
      expect(subject.output.attachments).toBeUndefined()
      expect(subject.messages.some(m => m.contentParts?.some(p => p.type === 'image'))).toBe(false)
      subject.budget.close()
    }
  )

  it('rechecks the actual destination instead of forwarding images to an unknown fallback', async () => {
    const subject = await setup(createCanvas(1, 1).toBuffer('image/png'))
    const fallback = new LlmPortAdapter(
      new OpenAIProvider('integration-only', 'unknown-model'),
      'unknown-model',
      'openai'
    )
    await expect(
      fallback.completeWithTools({ messages: subject.messages, tools: [] })
    ).rejects.toThrow('Image input is not verified')
    expect(sdkCreate).not.toHaveBeenCalled()
    subject.budget.close()
  })
})
