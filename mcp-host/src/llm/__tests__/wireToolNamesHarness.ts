/**
 * Builds every direct provider through the real `makeProvider` and replaces
 * only its SDK client (the network boundary) with a fake that records the
 * request body and answers with one tool call in that provider's own response
 * shape. The chat and Responses answers are the recorded API responses with
 * the tool name swapped.
 *
 * Deliberately free of imports from `../toolWireNames`: the byte-identity
 * golden is produced by this harness against the adapters before the wire-name
 * edge existed.
 */
import { vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChatMessage, ToolDefinition } from '../../core/types'
import { makeProvider } from '../registry'
import { ALL_PROVIDERS, type LlmProvider, descriptorFor } from '../registryCore'
import type { SingleTurnProvider } from '../types'
import serverNames from './fixtures/serverNames.json'

const FAMILY_FIXTURES = join(__dirname, '..', 'openaiFamily', '__tests__', '__fixtures__')

/** Every provider whose adapter talks to the LLM directly (the proxied two are excluded). */
export const DIRECT_PROVIDERS: readonly LlmProvider[] = ALL_PROVIDERS.filter(
  p => p !== 'codex-subscription' && p !== 'grok-subscription'
)

export type WireFamily = 'chat' | 'responses' | 'claude' | 'vertex' | 'bedrock'

export function familyOf(id: LlmProvider): WireFamily {
  if (id === 'openai') return 'responses'
  if (id === 'claude') return 'claude'
  if (id === 'vertex') return 'vertex'
  if (id === 'bedrock') return 'bedrock'
  return 'chat'
}

// ─── Real server names (produced by control-api, see the golden) ────────────

export interface CatalogServerName {
  readonly catalogId: string
  readonly grantScope: string
  readonly name: string
}

// Annotated rather than cast, so a golden that drops a field fails typecheck.
const CATALOG: readonly CatalogServerName[] = serverNames.catalog

function catalogSlot(catalogId: string, grantScope: string): string {
  const entry = CATALOG.find(e => e.catalogId === catalogId && e.grantScope === grantScope)
  if (!entry) throw new Error(`serverNames golden has no catalog slot ${catalogId} (${grantScope})`)
  return entry.name
}

export const REGISTRY_SERVER_NAMES: readonly string[] = serverNames.registry.map(e => e.name)
export const CATALOG_SERVER_NAMES: readonly string[] = CATALOG.map(e => e.name)
export const NOTION_SERVER = serverNames.registry.find(
  e => e.entryName === '@evenfire/notion-remote'
)!.name
export const ATLASSIAN_SERVER = serverNames.registry.find(
  e => e.entryName === '@evenfire/atlassian-remote'
)!.name
export const CATALOG_NOTION_SERVER = catalogSlot('@evenfire/notion-remote', 'user')

// ─── Construction ───────────────────────────────────────────────────────────

const FAKE_SERVICE_ACCOUNT = JSON.stringify({
  client_email: 'unit@unit-project.iam.gserviceaccount.com',
  private_key: 'unit-fake-private-key',
  project_id: 'unit-project',
})

const ENV: Record<string, string> = {
  AZURE_OPENAI_ENDPOINT: 'https://unit-resource.openai.azure.com/',
  AWS_REGION: 'us-east-1',
  VERTEX_PROJECT_ID: 'unit-project',
  VERTEX_LOCATION: 'us-central1',
}

export interface CapturingProvider {
  provider: SingleTurnProvider
  /** Bodies sent to the SDK, in call order. */
  bodies: unknown[]
  /** Name of the tool call the next response carries; `null` answers without tool calls. */
  respondWith(name: string | null): void
  /** Which SDK method was used, per call (`responses` vs `chat` for the OpenAI family). */
  methods: string[]
  /** The fake SDK client, for code that builds on the provider's client (token counter). */
  client: Record<string, unknown>
}

export function buildCapturingProvider(id: LlmProvider): CapturingProvider {
  const d = descriptorFor(id)
  const credentials = Object.fromEntries(
    d.credentialSlots.map(s => [
      s.dataKey,
      id === 'vertex' ? FAKE_SERVICE_ACCOUNT : `unit-${id}-${s.dataKey}`,
    ])
  )
  const provider = makeProvider(id, credentials, undefined, { env: name => ENV[name] })
  const holder = provider as unknown as { client: { baseURL?: unknown } }
  const baseURL = holder.client?.baseURL
  const bodies: unknown[] = []
  const methods: string[] = []
  let next: string | null = null
  const record = (method: string, body: unknown) => {
    // Snapshot: a later mutation of the caller's objects must not rewrite history.
    bodies.push(JSON.parse(JSON.stringify(body)))
    methods.push(method)
  }

  const family = familyOf(id)
  let client: Record<string, unknown>
  if (family === 'chat' || family === 'responses') {
    client = {
      baseURL,
      chat: {
        completions: {
          create: vi.fn(async (body: unknown) => {
            record('chat', body)
            return chatResponse(next)
          }),
        },
      },
      responses: {
        create: vi.fn(async (body: unknown) => {
          record('responses', body)
          return responsesResponse(next)
        }),
      },
    }
  } else if (family === 'claude') {
    client = {
      baseURL,
      messages: {
        create: vi.fn(async (body: unknown) => {
          record('messages', body)
          return claudeResponse(next)
        }),
      },
      beta: {
        messages: {
          countTokens: vi.fn(async (body: unknown) => {
            record('countTokens', body)
            return { input_tokens: 4242 }
          }),
        },
      },
    }
  } else if (family === 'vertex') {
    client = {
      generateContent: vi.fn(async (body: unknown) => {
        record('generateContent', body)
        return vertexResponse(next)
      }),
    }
  } else {
    client = {
      converse: vi.fn(async (body: unknown) => {
        record('converse', body)
        return bedrockResponse(next)
      }),
    }
  }
  ;(provider as unknown as { client: unknown }).client = client
  return {
    provider,
    bodies,
    methods,
    client,
    respondWith: name => {
      next = name
    },
  }
}

// ─── Fake SDK responses ─────────────────────────────────────────────────────

function chatResponse(name: string | null): unknown {
  const recorded = JSON.parse(
    readFileSync(join(FAMILY_FIXTURES, 'chatCompletion.tools.recorded.json'), 'utf8')
  )
  if (name === null) {
    recorded.choices[0].message.tool_calls = undefined
    recorded.choices[0].message.content = 'done'
    recorded.choices[0].finish_reason = 'stop'
  } else {
    recorded.choices[0].message.tool_calls[0].function.name = name
  }
  return recorded
}

function responsesResponse(name: string | null): unknown {
  const fixture = name === null ? 'v1-text-gpt-6.1-terra' : 'v1-fc-gpt-6.1-terra'
  const recorded = JSON.parse(
    readFileSync(join(FAMILY_FIXTURES, 'responses', `${fixture}.json`), 'utf8')
  ).res
  if (name !== null) {
    const call = recorded.output.find((i: { type: string }) => i.type === 'function_call')
    call.name = name
  }
  return recorded
}

function claudeResponse(name: string | null): unknown {
  return {
    id: 'msg_unit',
    type: 'message',
    role: 'assistant',
    model: 'claude-unit',
    content:
      name === null
        ? [{ type: 'text', text: 'done' }]
        : [{ type: 'tool_use', id: 'toolu_unit', name, input: {} }],
    stop_reason: name === null ? 'end_turn' : 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 },
  }
}

function vertexResponse(name: string | null): unknown {
  return {
    candidates: [
      {
        content: {
          parts: name === null ? [{ text: 'done' }] : [{ functionCall: { name, args: {} } }],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
  }
}

function bedrockResponse(name: string | null): unknown {
  return {
    output: {
      message: {
        content:
          name === null
            ? [{ text: 'done' }]
            : [{ toolUse: { toolUseId: 'tu_unit', name, input: {} } }],
      },
    },
    stopReason: name === null ? 'end_turn' : 'tool_use',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  }
}

// ─── Reading the wire body ──────────────────────────────────────────────────

export interface WireToolDecl {
  name: string
  description: string
}

type Json = Record<string, any>

/** The tool declarations of a body, in the order they were sent. */
export function wireToolDecls(family: WireFamily, body: unknown): WireToolDecl[] {
  const b = body as Json
  switch (family) {
    case 'chat':
      return (b.tools ?? []).map((t: Json) => ({
        name: t.function.name,
        description: t.function.description,
      }))
    case 'responses':
    case 'claude':
      return (b.tools ?? []).map((t: Json) => ({ name: t.name, description: t.description }))
    case 'vertex':
      return (b.config?.tools?.[0]?.functionDeclarations ?? []).map((t: Json) => ({
        name: t.name,
        description: t.description,
      }))
    case 'bedrock':
      return (b.toolConfig?.tools ?? []).map((t: Json) => ({
        name: t.toolSpec.name,
        description: t.toolSpec.description,
      }))
  }
}

/** Every tool name a body carries in its history (calls and, in vertex, responses). */
export function wireHistoryNames(family: WireFamily, body: unknown): string[] {
  const b = body as Json
  const out: string[] = []
  switch (family) {
    case 'chat':
      for (const m of b.messages ?? []) {
        for (const tc of m.tool_calls ?? []) out.push(tc.function.name)
        if (typeof m.name === 'string') out.push(m.name)
      }
      break
    case 'responses':
      for (const i of b.input ?? []) if (i.type === 'function_call') out.push(i.name)
      break
    case 'claude':
      for (const m of b.messages ?? []) {
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c.type === 'tool_use') out.push(c.name)
        }
      }
      break
    case 'vertex':
      for (const c of b.contents ?? []) {
        for (const p of c.parts ?? []) {
          if (p.functionCall) out.push(p.functionCall.name)
          if (p.functionResponse) out.push(p.functionResponse.name)
        }
      }
      break
    case 'bedrock':
      for (const m of b.messages ?? []) {
        for (const c of m.content ?? []) if (c.toolUse) out.push(c.toolUse.name)
      }
      break
  }
  return out
}

/** Vertex pairs a `functionResponse` with the preceding `functionCall` by name. */
export function vertexCallResponsePairs(body: unknown): Array<{ call: string; response: string }> {
  const contents = (body as Json).contents ?? []
  const pairs: Array<{ call: string; response: string }> = []
  let calls: string[] = []
  for (const c of contents) {
    for (const p of c.parts ?? []) {
      if (p.functionCall) calls.push(p.functionCall.name)
      if (p.functionResponse)
        pairs.push({ call: calls.shift()!, response: p.functionResponse.name })
    }
    if (c.role === 'model' && !(c.parts ?? []).some((p: Json) => p.functionCall)) calls = []
  }
  return pairs
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

export function toolDef(name: string): ToolDefinition {
  return {
    name,
    description: `Run ${name}.`,
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  }
}

/** A finished tool turn naming `calls`, with one tool message per call. */
export function toolTurn(
  calls: Array<{ id: string; name: string }>,
  toolMessageNames: Array<string | undefined>
): ChatMessage[] {
  return [
    { role: 'user', content: 'Look it up.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: calls.map(c => ({ id: c.id, name: c.name, arguments: { q: 'x' } })),
    },
    ...calls.map(
      (c, i): ChatMessage => ({
        role: 'tool',
        tool_call_id: c.id,
        content: `result ${i}`,
        ...(toolMessageNames[i] !== undefined ? { name: toolMessageNames[i] } : {}),
      })
    ),
    { role: 'user', content: 'And now?' },
  ]
}
