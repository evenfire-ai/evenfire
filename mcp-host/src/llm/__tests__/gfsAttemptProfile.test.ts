import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../core/types'
import { ClaudeProvider } from '../claude'
import { OpenAIProvider } from '../openai'
import { OpenAICompatibleProvider } from '../openaiCompatible'
import { recordedResponse } from '../openaiFamily/__tests__/responsesFixtures'
import { JPEG_2X2_BASE64, PNG_2X2_BASE64 } from './codexImageFixtures'

const { compatibleCreate } = vi.hoisted(() => ({ compatibleCreate: vi.fn() }))
// External SDK boundary only; the compatible provider and its inherited gate run.
vi.mock('openai', () => ({
  default: class {
    baseURL: string
    constructor(options: { baseURL?: string }) {
      this.baseURL = options.baseURL ?? 'https://api.openai.com/v1'
    }
    chat = { completions: { create: compatibleCreate } }
  },
}))

function messages(gfs = true): ChatMessage[] {
  return [
    {
      role: 'user',
      content: 'Inspect the image',
      contentParts: [
        {
          type: 'image',
          mimeType: 'image/png',
          data: PNG_2X2_BASE64,
          width: 2,
          height: 2,
          ...(gfs
            ? {
                source: {
                  kind: 'gfs' as const,
                  drive: 'main',
                  resourceId: 'a'.repeat(32),
                  gfsUri: `gfs://main/${'a'.repeat(32)}`,
                  version: 7,
                  name: 'unit.png',
                },
              }
            : {}),
        },
      ],
    },
  ]
}
/** The image URLs of the `input_image` parts of a Responses request. */
function inputImages(request: unknown): string[] {
  return (request as { input: Array<{ content?: unknown }> }).input.flatMap(item =>
    Array.isArray(item.content)
      ? (item.content as Array<{ type?: string; image_url?: string }>)
          .filter(part => part.type === 'input_image')
          .map(part => part.image_url!)
      : []
  )
}

const parts = {
  stable: 'stable',
  context: 'context',
  stableHash: 'unit-stable',
  contextHash: 'unit-context',
}

describe('physical GFS image profile gates', () => {
  it('derives a profile only from the real official instance and never from compatibility', () => {
    const client = {
      baseURL: 'https://api.openai.com/v1',
      chat: { completions: { create: vi.fn() } },
    }
    const official = new OpenAIProvider(client as never, 'unit-model')
    expect(official.getVisualDeliveryLimits('completeWithTools')).toMatchObject({
      maxVisualRequestBytes: 512_000_000,
      maxImages: 1500,
    })
    expect(official.getVisualDeliveryLimits('complete')).toBeNull()
    const compatible = new OpenAICompatibleProvider(
      { id: 'openrouter', baseURL: client.baseURL, defaultModel: 'unit-model' },
      'unit-only-provider-identity',
      'unit-model'
    )
    expect(compatible.getVisualDeliveryLimits('completeWithTools')).toBeNull()
    const claude = new ClaudeProvider(
      { baseURL: 'https://api.anthropic.com', messages: { create: vi.fn() } } as never,
      'unit-model'
    )
    expect(claude.getVisualDeliveryLimits('completeWithToolsAndCache')).toMatchObject({
      maxImageEncodedBytes: 10_000_000,
      maxImageBytes: 7_500_000,
      maxImages: 100,
    })
    expect(claude.getVisualDeliveryLimits('complete')).toBeNull()
  })
  it.each(['openai', 'openrouter'] as const)(
    'rejects profile-less %s pixels through plain and tool methods before the SDK',
    async type => {
      const create = type === 'openai' ? vi.fn() : compatibleCreate
      // The same spy on both protocols, so "never reached the SDK" covers whichever the profile speaks.
      const client = {
        baseURL: 'https://unit-only.invalid',
        chat: { completions: { create } },
        responses: { create },
      }
      const provider =
        type === 'openai'
          ? new OpenAIProvider(client as never, 'unit-model')
          : new OpenAICompatibleProvider(
              { id: 'openrouter', baseURL: client.baseURL, defaultModel: 'unit-model' },
              'unit-only-provider-identity',
              'unit-model'
            )
      const original = messages()
      const before = structuredClone(original)
      await expect(provider.completeSingleTurn(original)).rejects.toThrow('unsupported_format')
      await expect(provider.completeSingleTurnWithTools(original, [])).rejects.toThrow(
        'unsupported_format'
      )
      expect(create).not.toHaveBeenCalled()
      expect(original).toEqual(before)
    }
  )

  it('rejects profile-less Claude GFS pixels through every plain/cached/tool method', async () => {
    const create = vi.fn()
    const provider = new ClaudeProvider({ messages: { create } } as never, 'unit-model')
    const original = messages()
    await expect(provider.completeSingleTurn(original)).rejects.toThrow('unsupported_format')
    await expect(provider.completeSingleTurnWithTools(original, [])).rejects.toThrow(
      'unsupported_format'
    )
    await expect(provider.completeSingleTurnAndCache(parts, original)).rejects.toThrow(
      'unsupported_format'
    )
    await expect(provider.completeSingleTurnWithToolsAndCache(parts, original, [])).rejects.toThrow(
      'unsupported_format'
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('rechecks the OpenAI instance endpoint at physical dispatch', async () => {
    const create = vi.fn()
    const client = {
      baseURL: 'https://api.openai.com/v1',
      chat: { completions: { create } },
      responses: { create },
    }
    const provider = new OpenAIProvider(client as never, 'unit-model')
    expect(provider.getVisualDeliveryLimits('completeWithTools')).not.toBeNull()
    client.baseURL = 'https://unit-only.invalid/v1'
    await expect(provider.completeSingleTurnWithTools(messages(), [])).rejects.toThrow(
      'unsupported_format'
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('keeps valid official Claude pixels in the cached plain wire and rechecks the endpoint on reuse', async () => {
    const create = vi.fn(async (_request: unknown) => ({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }))
    const client = { baseURL: 'https://api.anthropic.com', messages: { create } }
    const provider = new ClaudeProvider(client as never, 'unit-model')
    const original = messages()
    const before = structuredClone(original)
    await provider.completeSingleTurnAndCache(parts, original)
    expect(JSON.stringify(create.mock.calls[0]![0])).toContain(PNG_2X2_BASE64)
    expect(create.mock.calls[0]![0]).toMatchObject({
      system: expect.arrayContaining([
        { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      ]),
    })
    client.baseURL = 'https://unit-only.invalid'
    await expect(provider.completeSingleTurnAndCache(parts, original)).rejects.toThrow(
      'unsupported_format'
    )
    expect(create).toHaveBeenCalledTimes(1)
    expect(original).toEqual(before)
  })

  it('rejects a direct Claude GFS bypass with unknown ordinary geometry before every image-capable SDK method', async () => {
    const create = vi.fn(async (_request: unknown) => ({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }))
    const provider = new ClaudeProvider(
      { baseURL: 'https://api.anthropic.com', messages: { create } } as never,
      'unit-model'
    )
    const original = messages()
    original.push({
      role: 'user',
      content: 'Composer image',
      contentParts: [{ type: 'image', mimeType: 'image/jpeg', data: JPEG_2X2_BASE64 }],
    })
    const before = structuredClone(original)
    await expect(provider.completeSingleTurnWithTools(original, [])).rejects.toThrow(
      'unsupported_format'
    )
    await expect(provider.completeSingleTurnAndCache(parts, original)).rejects.toThrow(
      'unsupported_format'
    )
    await expect(provider.completeSingleTurnWithToolsAndCache(parts, original, [])).rejects.toThrow(
      'unsupported_format'
    )
    expect(create).not.toHaveBeenCalled()
    expect(original).toEqual(before)
  })

  it('keeps official OpenAI GFS pixels without measured geometry because its profile imposes no shape bound', async () => {
    const create = vi.fn(async (_request: unknown) => recordedResponse('v1-text-gpt-4.1'))
    const provider = new OpenAIProvider(
      { baseURL: 'https://api.openai.com/v1', responses: { create } } as never,
      'unit-model'
    )
    const original = messages()
    const image = original[0]!.contentParts![0]!
    if (image.type !== 'image') throw new Error('expected image')
    delete image.width
    delete image.height
    await provider.completeSingleTurnWithTools(original, [])
    expect(inputImages(create.mock.calls[0]![0])).toEqual([
      `data:image/png;base64,${PNG_2X2_BASE64}`,
    ])
  })

  it('keeps ordinary Claude pixels without measured geometry when there are no GFS pixels', async () => {
    const create = vi.fn(async (_request: unknown) => ({
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }))
    const provider = new ClaudeProvider(
      { baseURL: 'https://api.anthropic.com', messages: { create } } as never,
      'unit-model'
    )
    const original = messages(false)
    const image = original[0]!.contentParts![0]!
    if (image.type !== 'image') throw new Error('expected image')
    delete image.width
    delete image.height
    await provider.completeSingleTurnWithTools(original, [])
    expect(JSON.stringify(create.mock.calls[0]![0])).toContain(PNG_2X2_BASE64)
  })

  it('keeps the OpenAI image wire behavior for ordinary non-GFS input', async () => {
    const create = vi.fn(async (_request: unknown) => recordedResponse('v1-text-gpt-4.1'))
    const provider = new OpenAIProvider(
      { baseURL: 'https://unit-only.invalid', responses: { create } } as never,
      'unit-model'
    )
    await provider.completeSingleTurnWithTools(messages(false), [])
    expect(inputImages(create.mock.calls[0]![0])).toEqual([
      `data:image/png;base64,${PNG_2X2_BASE64}`,
    ])
  })
})
