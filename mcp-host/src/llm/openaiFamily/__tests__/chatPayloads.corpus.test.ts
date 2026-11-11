/**
 * Byte-level oracle for the OpenAI wire family (openai, azure and the
 * OpenAI-compatible descriptors pinned in FAMILY).
 *
 * Once the composition refactor has landed, this corpus is a regression
 * snapshot of that behavior, not an equivalence oracle against older code.
 *
 * The base corpus was generated from the pre-composition drivers by running
 * this same file with UPDATE_CHAT_CORPUS=1, except the `missing-credential|*`
 * entries: they were regenerated from the composed drivers once only the SDK
 * error's first sentence was recorded, and that sentence is the same one the
 * pre-composition drivers raise. Every provider is built through the
 * real factory (`makeProvider`) and its SDK client is swapped for a recorder
 * after construction, so what is compared is exactly what the driver hands to
 * `chat.completions.create` (payload + request options), plus the decoded core
 * result, the provider identity/visual limits, Azure client construction and
 * error classification. Responses fed back are recorded API outputs; decode
 * variants mutate a single field of a recorded response.
 *
 * The official endpoint now speaks Responses, so its `call|openai|…` rows run
 * against the official profile pinned to Chat (same parameter rows, identity
 * and visual limits). Production never builds that combination: the rows are
 * kept because Azure still serializes through the same Chat code, and they
 * guard it byte for byte with the richest parameter rows. Its identity,
 * classification and credential rows still come from the real factory.
 *
 * The Responses wire has no byte-for-byte corpus: its payloads are asserted
 * field by field in the Responses protocol tests, so a field reorder or a
 * dropped explicit `undefined` on that wire goes unnoticed.
 *
 * Serialization keeps key order and marks `undefined`-valued keys, so a
 * refactor that reorders fields or drops an explicit `undefined` shows up here
 * even though JSON on the wire would hide it.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import OpenAI from 'openai'
import type { ChatMessage, ToolDefinition } from '../../../core/types'
import type { ImageTransportOperation } from '../../imageInput'
import { OpenAIProvider } from '../../openai'
import { makeProvider } from '../../registry'
import { type LlmProvider, isLlmProvider } from '../../registryCore'
import type { SingleTurnProvider } from '../../types'
import {
  AZURE_ENDPOINT,
  FAMILY,
  RECORDED_TEXT_RESPONSE,
  RECORDED_TOOLS_RESPONSE,
  buildFamilyProvider,
  officialChatProfile,
} from './familyHarness'

const FIXTURES = join(__dirname, '__fixtures__')
const CORPUS_PATH = join(FIXTURES, 'chatPayloads.base.json')
const UPDATE = process.env.UPDATE_CHAT_CORPUS === '1'
const IN_CI = !!process.env.CI && process.env.CI !== 'false' && process.env.CI !== '0'

function stable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (v === undefined) return '__undefined__'
      if (v instanceof AbortSignal) return '__abort_signal__'
      return v
    }) ?? '"__undefined__"'
  )
}

const CALLER_SIGNAL = new AbortController().signal

type Recording = {
  calls: { payload: unknown; options: unknown }[]
  responsesTouched: boolean
}

function installRecorder(provider: SingleTurnProvider, response: unknown): Recording {
  const holder = provider as unknown as { client: { baseURL: string } }
  const original = holder.client
  const recording: Recording = { calls: [], responsesTouched: false }
  holder.client = {
    baseURL: original.baseURL,
    chat: {
      completions: {
        create: async (payload: unknown, options?: { signal?: AbortSignal }) => {
          recording.calls.push({
            payload: stable(payload),
            options:
              options === undefined
                ? '__undefined__'
                : `keys=${Object.keys(options).join(',')};signal=${
                    options.signal === undefined
                      ? 'undefined'
                      : options.signal === CALLER_SIGNAL
                        ? 'caller'
                        : 'other'
                  }`,
          })
          return structuredClone(response)
        },
      },
    },
    get responses() {
      recording.responsesTouched = true
      return {
        create: () => {
          throw new Error('responses.create must not be reached')
        },
      }
    },
  } as never
  return recording
}

// 1x1 PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const SYSTEM: ChatMessage = { role: 'system', content: 'You are a unit.' }
const USER: ChatMessage = { role: 'user', content: 'What is the weather in Paris?' }
const USER_IMAGE: ChatMessage = {
  role: 'user',
  content: 'Describe this\nimage',
  contentParts: [
    { type: 'text', text: 'Describe this' },
    { type: 'image', mimeType: 'image/png', data: PNG, width: 1, height: 1 },
    { type: 'text', text: 'image' },
  ],
}
const HISTORY: ChatMessage[] = [
  SYSTEM,
  USER,
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      { id: 'call_a', name: 'get_weather', arguments: { city: 'Paris' } },
      { id: 'call_b', name: 'get_time', arguments: {} },
    ],
  },
  { role: 'tool', tool_call_id: 'call_a', name: 'get_weather', content: '{"temp":21}' },
  { role: 'tool', tool_call_id: 'call_b', name: 'get_time', content: '12:00' },
  {
    role: 'assistant',
    content: 'Checking once more.',
    tool_calls: [{ id: 'call_c', name: 'get_weather', arguments: { city: 'Lyon', n: [1, 2] } }],
  },
  { role: 'tool', tool_call_id: 'call_c', content: 'sunny' },
  { role: 'system', content: 'Mid-conversation operator note.' },
  { role: 'assistant', content: 'It is 21C and sunny.' },
  { role: 'user', content: 'Thanks' },
]
const REASONING_HISTORY: ChatMessage[] = [
  USER,
  {
    role: 'assistant',
    content: 'Let me check.',
    reasoning_content: 'The user wants weather; call get_weather.',
    tool_calls: [{ id: 'call_r', name: 'get_weather', arguments: { city: 'Paris' } }],
  },
  { role: 'tool', tool_call_id: 'call_r', content: '{"temp":21}' },
  {
    role: 'assistant',
    content: 'No tool here.',
    reasoning_content: 'Reasoning on a plain assistant message is never sent.',
  },
  { role: 'user', content: 'And tomorrow?' },
]
const TOOLS: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: 'Weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
  { name: 'files__read', description: 'Read', parameters: { type: 'object' } },
]
/** Cases that vary something other than tool mapping only need one tool. */
const ONE_TOOL: ToolDefinition[] = [{ name: 't', description: 'd', parameters: { type: 'object' } }]

type Case = {
  name: string
  run: (p: SingleTurnProvider) => Promise<unknown>
  response: unknown
}

const text = (name: string, messages: ChatMessage[], options?: object): Case => ({
  name,
  response: RECORDED_TEXT_RESPONSE,
  run: p => p.completeSingleTurn(messages, options as never),
})
const tools = (
  name: string,
  messages: ChatMessage[],
  options?: object,
  defs: ToolDefinition[] = TOOLS
): Case => ({
  name,
  response: RECORDED_TOOLS_RESPONSE,
  run: p => p.completeSingleTurnWithTools(messages, defs, options as never),
})

const FULL_CASES: Case[] = [
  text('text/no-options', [SYSTEM, USER]),
  text('text/options', [SYSTEM, USER], {
    max_tokens: 256,
    temperature: 0.7,
    signal: CALLER_SIGNAL,
  }),
  text('text/image', [SYSTEM, USER_IMAGE], { signal: CALLER_SIGNAL }),
  text('text/history', HISTORY),
  text('text/temperature-1.8', [USER], { temperature: 1.8 }),
  text('text/temperature-negative', [USER], { temperature: -0.5 }),
  text('text/tool-choice-required-ignored', [USER], { tool_choice: 'required' }),
  tools('tools/no-options', [SYSTEM, USER]),
  tools(
    'tools/options',
    [SYSTEM, USER],
    { max_tokens: 512, temperature: 0.2, signal: CALLER_SIGNAL },
    ONE_TOOL
  ),
  tools('tools/empty-tool-list', [SYSTEM, USER], { tool_choice: 'required' }, []),
  tools('tools/image', [SYSTEM, USER_IMAGE], undefined, ONE_TOOL),
  tools('tools/image-verified', [SYSTEM, USER_IMAGE], { verifyImageInput: true }, ONE_TOOL),
  tools('tools/text-verified', [SYSTEM, USER], { verifyImageInput: true }, ONE_TOOL),
  tools('tools/history', HISTORY, { signal: CALLER_SIGNAL }),
  tools('tools/reasoning-content', REASONING_HISTORY, undefined, ONE_TOOL),
  tools('tools/tool-choice-required', [USER], { tool_choice: 'required' }, ONE_TOOL),
  tools('tools/tool-choice-none', [USER], { tool_choice: 'none' }, ONE_TOOL),
  tools('tools/temperature-1.8', [USER], { temperature: 1.8, tool_choice: 'auto' }, ONE_TOOL),
  tools('tools/temperature-1', [USER], { temperature: 1 }, ONE_TOOL),
]

const MODEL_CASES: Case[] = [
  text('text/max-tokens', [USER], { max_tokens: 100, temperature: 0.3 }),
  tools('tools/max-tokens', [USER], { max_tokens: 100 }, ONE_TOOL),
  tools('tools/no-max-tokens', [USER], undefined, ONE_TOOL),
]
/** The model sweep only varies the param policy, which is per endpoint kind. */
const MODEL_SWEEP_PROVIDERS: LlmProvider[] = ['openai', 'azure', 'groq']
const MODELS = ['gpt-5', 'gpt-5.2-pro', 'GPT-5-mini', 'o3', 'o1-mini', 'gpt-4o', 'gpt-50', 'o10x']

type RecordedChat = {
  choices: {
    finish_reason: unknown
    message: {
      content: unknown
      tool_calls?: { function: { arguments: string } }[]
      reasoning_content?: unknown
    }
  }[]
  usage?: { prompt_tokens: number; completion_tokens: number }
}

function derived(recorded: unknown, mutate: (r: RecordedChat) => void): unknown {
  const response = structuredClone(recorded) as RecordedChat
  mutate(response)
  return response
}
const textDecode = (name: string, mutate: (r: RecordedChat) => void): Case => ({
  name: `decode/text/${name}`,
  response: derived(RECORDED_TEXT_RESPONSE, mutate),
  run: p => p.completeSingleTurn([USER]),
})
const toolsDecode = (name: string, mutate: (r: RecordedChat) => void): Case => ({
  name: `decode/tools/${name}`,
  response: derived(RECORDED_TOOLS_RESPONSE, mutate),
  run: p => p.completeSingleTurnWithTools([USER], ONE_TOOL),
})
const message = (r: RecordedChat) => r.choices[0].message
const usageVariants = (make: typeof textDecode) => [
  make('usage-absent', r => delete r.usage),
  make('usage-negative', r => {
    r.usage!.prompt_tokens = -1
  }),
  make('usage-non-integer', r => {
    r.usage!.completion_tokens = 1.5
  }),
]
const finishVariants = (make: typeof textDecode) =>
  ['length', 'content_filter', 'function_call', null].map(reason =>
    make(`finish-${String(reason)}`, r => {
      r.choices[0].finish_reason = reason
    })
  )

/** Native error codes are shared by every compatible; two of them stand for the rest. */
const CLASSIFY_PROVIDERS: LlmProvider[] = ['openai', 'azure', 'zai', 'bailian', 'groq']

/** Decode is endpoint-independent; one provider per endpoint kind is enough. */
const DECODE_PROVIDERS: LlmProvider[] = ['openai', 'azure', 'zai']
const DECODE_CASES: Case[] = [
  textDecode('content-null', r => {
    message(r).content = null
  }),
  ...finishVariants(textDecode),
  ...usageVariants(textDecode),
  toolsDecode('content-null', r => {
    message(r).content = null
  }),
  toolsDecode('content-text', r => {
    message(r).content = 'Calling the tool.'
  }),
  toolsDecode('tool-calls-empty', r => {
    message(r).tool_calls = []
  }),
  toolsDecode('tool-calls-absent', r => {
    delete message(r).tool_calls
  }),
  toolsDecode('invalid-arguments', r => {
    message(r).tool_calls![0].function.arguments = '{"city":'
  }),
  toolsDecode('reasoning-content', r => {
    message(r).reasoning_content = 'The user wants the weather.'
  }),
  toolsDecode('reasoning-content-non-string', r => {
    message(r).reasoning_content = 42
  }),
  ...finishVariants(toolsDecode),
  ...usageVariants(toolsDecode),
]

const VISUAL_OPS: ImageTransportOperation[] = [
  'complete',
  'completeWithTools',
  'completeAndCache',
  'completeWithToolsAndCache',
]

function sdkError(status: number | undefined, body: object | undefined, message?: string) {
  // Without headers the SDK collapses every status into APIConnectionError.
  return OpenAI.APIError.generate(status, body, message, {})
}

const ERRORS: Record<string, () => unknown> = {
  'zai-1113-429': () => sdkError(429, { error: { code: '1113', message: 'Insufficient balance' } }),
  'zai-1211-400': () => sdkError(400, { error: { code: '1211', message: 'Unknown model' } }),
  'zai-numeric-1220': () => sdkError(400, { error: { code: 1220, message: 'No access' } }),
  'bailian-arrearage': () => sdkError(400, { error: { code: 'Arrearage', message: 'Overdue' } }),
  'bailian-model-not-found': () =>
    sdkError(404, { error: { code: 'ModelNotFound', message: 'missing' } }),
  'bailian-access-denied': () =>
    sdkError(403, { error: { code: 'Model.AccessDenied', message: 'denied' } }),
  'openai-model-not-found': () =>
    sdkError(404, {
      error: { code: 'model_not_found', type: 'invalid_request_error', message: 'nope' },
    }),
  'openai-insufficient-quota': () =>
    sdkError(429, { error: { code: 'insufficient_quota', message: 'quota' } }),
  'openai-invalid-key': () => sdkError(401, { error: { code: 'invalid_api_key', message: 'k' } }),
  'rate-limited': () => sdkError(429, { error: { message: 'slow down' } }),
  'server-500': () => sdkError(500, { error: { message: 'boom' } }),
  'overloaded-529': () => sdkError(529, undefined, 'overloaded'),
  'bad-request-400': () =>
    sdkError(400, { error: { code: 'context_length_exceeded', message: 'too long' } }),
  'unknown-code-400': () => sdkError(400, { error: { code: 'other_code', message: 'x' } }),
  abort: () => new OpenAI.APIUserAbortError(),
  connection: () => new OpenAI.APIConnectionError({ message: 'socket hang up' }),
  'plain-error': () => new Error('kaboom'),
  'top-level-code': () => Object.assign(new Error('top'), { code: '1113' }),
  'string-thrown': () => 'just a string',
  'null-thrown': () => null,
}

function visualLimits(provider: SingleTurnProvider, op: ImageTransportOperation) {
  return provider.getVisualDeliveryLimits ? provider.getVisualDeliveryLimits(op) : '__absent__'
}

function clientIdentity(provider: SingleTurnProvider) {
  const client = (
    provider as unknown as {
      client: { baseURL: string; apiKey: string; _options?: Record<string, unknown> }
    }
  ).client
  return stable({
    baseURL: client.baseURL,
    apiKey: client.apiKey,
    defaultHeaders: client._options?.defaultHeaders,
    defaultQuery: client._options?.defaultQuery,
  })
}

/**
 * Payload cases decode the same recorded response, so their decoded result is
 * kept as a digest; the decode cases keep it in full.
 */
async function runCase(
  id: LlmProvider,
  model: string | undefined,
  c: Case,
  result: 'full' | 'digest'
) {
  const provider =
    id === 'openai'
      ? new OpenAIProvider(`unit-${id}-key`, model, officialChatProfile())
      : buildFamilyProvider(id, model)
  const recording = installRecorder(provider, c.response)
  let outcome: unknown
  try {
    const decoded = stable(await c.run(provider))
    outcome =
      result === 'full'
        ? { result: decoded }
        : {
            resultDigest: createHash('sha256')
              .update(JSON.stringify(decoded))
              .digest('hex')
              .slice(0, 16),
          }
  } catch (err) {
    outcome = { error: { name: (err as Error).name, message: (err as Error).message } }
  }
  return stable({
    calls: recording.calls,
    ...(recording.responsesTouched ? { responsesTouched: true } : {}),
    ...(outcome as object),
  })
}

async function buildCorpus(): Promise<Record<string, unknown>> {
  const corpus: Record<string, unknown> = {}
  for (const id of FAMILY) {
    for (const c of FULL_CASES)
      corpus[`call|${id}|default|${c.name}`] = await runCase(id, undefined, c, 'digest')
    if (MODEL_SWEEP_PROVIDERS.includes(id)) {
      for (const model of MODELS) {
        for (const c of MODEL_CASES)
          corpus[`call|${id}|${model}|${c.name}`] = await runCase(id, model, c, 'digest')
      }
    }
    if (DECODE_PROVIDERS.includes(id)) {
      for (const c of DECODE_CASES)
        corpus[`call|${id}|default|${c.name}`] = await runCase(id, undefined, c, 'full')
    }

    const provider = buildFamilyProvider(id)
    corpus[`identity|${id}`] = stable({
      providerType: provider.getProviderType(),
      defaultModel: (provider as unknown as { defaultModel: unknown }).defaultModel,
      client: clientIdentity(provider),
      visualLimits: Object.fromEntries(VISUAL_OPS.map(op => [op, visualLimits(provider, op)])),
    })
    if (CLASSIFY_PROVIDERS.includes(id))
      corpus[`classify|${id}`] = stable(
        Object.fromEntries(
          Object.entries(ERRORS).map(([name, make]) => [name, provider.classifyError(make())])
        )
      )
  }

  const azureVariants: Record<string, Record<string, string>> = {
    'api-version': {
      AZURE_OPENAI_ENDPOINT: AZURE_ENDPOINT,
      AZURE_OPENAI_API_VERSION: ' 2025-04-01 ',
    },
    'blank-api-version': { AZURE_OPENAI_ENDPOINT: AZURE_ENDPOINT, AZURE_OPENAI_API_VERSION: '  ' },
    'trailing-slashes-and-space': { AZURE_OPENAI_ENDPOINT: '  https://r.example.azure.us///  ' },
    'path-endpoint': { AZURE_OPENAI_ENDPOINT: 'https://r.example.com/prefix' },
    'official-host': { AZURE_OPENAI_ENDPOINT: 'https://api.openai.com/v1' },
    missing: {},
    blank: { AZURE_OPENAI_ENDPOINT: '   ' },
    invalid: { AZURE_OPENAI_ENDPOINT: 'not a url' },
    http: { AZURE_OPENAI_ENDPOINT: 'http://r.openai.azure.com/' },
    ftp: { AZURE_OPENAI_ENDPOINT: 'ftp://r.openai.azure.com/' },
  }
  for (const [name, env] of Object.entries(azureVariants)) {
    try {
      const provider = buildFamilyProvider('azure', 'my-deployment', env)
      corpus[`azure-env|${name}`] = stable({
        client: clientIdentity(provider),
        defaultModel: (provider as unknown as { defaultModel: unknown }).defaultModel,
        visualLimits: Object.fromEntries(VISUAL_OPS.map(op => [op, visualLimits(provider, op)])),
      })
    } catch (err) {
      corpus[`azure-env|${name}`] = { error: (err as Error).message }
    }
  }

  // A missing credential must keep failing (or not) exactly where it did.
  const savedKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    for (const id of FAMILY) {
      try {
        const provider = makeProvider(id, {}, undefined, {
          env: name => ({ AZURE_OPENAI_ENDPOINT: AZURE_ENDPOINT })[name],
        })
        const client = (provider as unknown as { client: unknown }).client
        corpus[`missing-credential|${id}`] = { constructed: true, clientType: typeof client }
      } catch (err) {
        // The SDK's message goes on to embed a sample `apiKey: '...'` literal,
        // which the public-boundary secret scanner rejects; the first sentence
        // alone still pins where and why construction fails.
        corpus[`missing-credential|${id}`] = { error: (err as Error).message.split('; ')[0] }
      }
    }
  } finally {
    if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey
  }
  return corpus
}

describe('OpenAI wire family — byte-identical chat corpus', () => {
  it('matches the recorded chat corpus', async () => {
    const corpus = await buildCorpus()
    if (UPDATE) {
      // Fails before writing so a CI run never rewrites the oracle it is meant
      // to compare against.
      if (IN_CI) {
        throw new Error('UPDATE_CHAT_CORPUS must not be set in CI; regenerate the corpus locally')
      }
      // One entry per line keeps failures diffable without bloating the file.
      const lines = Object.entries(corpus).map(
        ([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`
      )
      writeFileSync(CORPUS_PATH, `{\n${lines.join(',\n')}\n}\n`)
      // A regeneration compares nothing, so it must never report green: a dev
      // regenerating on top of a regression would otherwise see it accepted.
      throw new Error(
        'chat corpus regenerated; review the fixture diff and re-run without UPDATE_CHAT_CORPUS to compare'
      )
    }
    expect(existsSync(CORPUS_PATH)).toBe(true)
    const base = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Record<string, unknown>
    expect(Object.keys(corpus)).toEqual(Object.keys(base))
    expect(
      Object.keys(corpus).filter(
        k => (corpus[k] as object | null) && 'responsesTouched' in (corpus[k] as object)
      )
    ).toEqual([])
    for (const key of Object.keys(base)) {
      expect(JSON.stringify(corpus[key]), key).toBe(JSON.stringify(base[key]))
    }
  })

  it('every pinned family member is still a registered provider', () => {
    expect(FAMILY.filter(id => !isLlmProvider(id))).toEqual([])
  })
})
