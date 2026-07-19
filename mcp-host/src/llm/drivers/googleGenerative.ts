/**
 * Google Vertex AI (Gemini) provider — own-SDK arm (R4).
 *
 * SDK choice: `@google/genai` in Vertex mode (`vertexai: true`). Rationale:
 *   - it is Google's current, actively-maintained unified GenAI SDK (the older
 *     `@google-cloud/vertexai` is in maintenance);
 *   - it accepts credentials CONSTRUCTED IN MEMORY from the service-account JSON
 *     via `googleAuthOptions.credentials` — so we never write a key file nor set
 *     `GOOGLE_APPLICATION_CREDENTIALS` (spec §3-R4.1 hard requirement);
 *   - a single modular dependency (no monolith), `require()`d lazily in
 *     {@link buildGoogleGenerativeDriver} so it is parsed only when a Host
 *     actually runs on Vertex.
 *
 * Scope: Gemini text + multimodal (image INPUT via `inlineData`). Image
 * generation is out of scope. The driver never imports the SDK at module load
 * (not even as a type) — the runtime client is injected — so the CommonJS lazy
 * require in `buildGoogleGenerativeDriver` is the only load site.
 */
import { LlmErrorCode } from '../../core/errors'
import {
  CompletionResponse,
  ChatMessage as CoreChatMessage,
  FinishReason,
  ToolCompletionResponse,
  ToolDefinition,
} from '../../core/types'
import type { ProviderCredentials } from '../../types'
import { classifyUnknown } from '../errorClassification'
import type { LlmProvider } from '../registryCore'
import type { ClassifiedError, SingleTurnProvider } from '../types'

// ─── SDK-agnostic wire shapes ────────────────────────────────────────────────
// Loose structural types so this module never depends on the @google/genai
// package at compile time (keeps the lazy-require boundary honest).

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
  inlineData?: { mimeType: string; data: string }
}
interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}
interface GeminiRequest {
  model: string
  contents: GeminiContent[]
  config?: {
    systemInstruction?: string
    tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }>
    maxOutputTokens?: number
    temperature?: number
    abortSignal?: AbortSignal
  }
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

/** The minimal surface of the Vertex client the driver consumes. */
export interface GeminiGenerateClient {
  generateContent(input: GeminiRequest): Promise<GeminiResponse>
}

export class GoogleGenerativeDriver implements SingleTurnProvider {
  private client: GeminiGenerateClient
  private defaultModel: string

  constructor(client: GeminiGenerateClient, defaultModel: string) {
    this.client = client
    this.defaultModel = defaultModel
    console.log(`[Vertex] Initialized with model: ${defaultModel}`)
  }

  getProviderType(): LlmProvider {
    return 'vertex'
  }

  classifyError(err: unknown): ClassifiedError {
    return classifyGoogleError(err)
  }

  // ─── Single-Turn Methods ────────────────────────────────────────────────

  async completeSingleTurn(
    messages: CoreChatMessage[],
    options?: { max_tokens?: number; temperature?: number; signal?: AbortSignal }
  ): Promise<CompletionResponse> {
    const { systemInstruction, contents } = this.toGeminiContents(messages)
    const response = await this.client.generateContent({
      model: this.defaultModel,
      contents,
      config: {
        systemInstruction: systemInstruction || undefined,
        maxOutputTokens: options?.max_tokens,
        temperature: options?.temperature,
        abortSignal: options?.signal,
      },
    })

    const parts = response.candidates?.[0]?.content?.parts ?? []
    const textContent = parts.map(p => p.text ?? '').join('')
    return {
      content: textContent,
      usage: mapUsage(response),
      finish_reason: mapFinishReason(response.candidates?.[0]?.finishReason, parts),
    }
  }

  async completeSingleTurnWithTools(
    messages: CoreChatMessage[],
    tools: ToolDefinition[],
    options?: {
      max_tokens?: number
      temperature?: number
      tool_choice?: string
      signal?: AbortSignal
    }
  ): Promise<ToolCompletionResponse> {
    const { systemInstruction, contents } = this.toGeminiContents(messages)
    const functionDeclarations = tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))

    const response = await this.client.generateContent({
      model: this.defaultModel,
      contents,
      config: {
        systemInstruction: systemInstruction || undefined,
        // Gemini rejects an empty tools array — omit when there are no tools.
        tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
        maxOutputTokens: options?.max_tokens,
        temperature: options?.temperature,
        abortSignal: options?.signal,
      },
    })

    const parts = response.candidates?.[0]?.content?.parts ?? []
    const textContent = parts.map(p => p.text ?? '').join('') || null

    // Gemini function calls carry no opaque id (it matches responses by name);
    // synthesize a stable per-response id so the normalized ToolCall shape and
    // the downstream tool loop keep working. On the next turn the round-trip
    // recovers the function name from the assistant message we emit (or the
    // tool message's own `name`), so the synthetic id never has to survive.
    let callIndex = 0
    const toolCalls = parts
      .filter(p => p.functionCall)
      .map(p => ({
        id: `call_${callIndex++}`,
        name: p.functionCall!.name,
        arguments: (p.functionCall!.args ?? {}) as Record<string, unknown>,
      }))

    return {
      content: textContent,
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      usage: mapUsage(response),
      finish_reason: mapFinishReason(response.candidates?.[0]?.finishReason, parts),
    }
  }

  // ─── Message translation ─────────────────────────────────────────────────

  /**
   * Convert the normalized ChatMessage[] into Gemini `contents` + a joined
   * `systemInstruction`. Tool results are matched back to their function name
   * via the id→name map built from the assistant tool_calls in the SAME
   * history (Gemini keys function responses by name, not by id).
   */
  private toGeminiContents(messages: CoreChatMessage[]): {
    systemInstruction: string
    contents: GeminiContent[]
  } {
    const idToName = new Map<string, string>()
    for (const m of messages) {
      if (m.role === 'assistant' && m.tool_calls) {
        for (const tc of m.tool_calls) idToName.set(tc.id, tc.name)
      }
    }

    const systemParts: string[] = []
    const contents: GeminiContent[] = []

    for (const m of messages) {
      if (m.role === 'system') {
        systemParts.push(m.content)
        continue
      }
      if (m.role === 'assistant') {
        const parts: GeminiPart[] = []
        if (m.content) parts.push({ text: m.content })
        for (const tc of m.tool_calls ?? []) {
          parts.push({ functionCall: { name: tc.name, args: tc.arguments } })
        }
        contents.push({ role: 'model', parts: parts.length > 0 ? parts : [{ text: '' }] })
        continue
      }
      if (m.role === 'tool') {
        const name = m.name ?? (m.tool_call_id ? idToName.get(m.tool_call_id) : undefined) ?? 'tool'
        contents.push({
          role: 'user',
          parts: [{ functionResponse: { name, response: { result: m.content } } }],
        })
        continue
      }
      // user
      if (m.contentParts?.length) {
        const parts: GeminiPart[] = m.contentParts.map(part =>
          part.type === 'text'
            ? { text: part.text }
            : { inlineData: { mimeType: part.mimeType, data: part.data } }
        )
        contents.push({ role: 'user', parts })
        continue
      }
      contents.push({ role: 'user', parts: [{ text: m.content }] })
    }

    return { systemInstruction: systemParts.join('\n\n'), contents }
  }
}

function mapUsage(response: GeminiResponse): CompletionResponse['usage'] {
  const u = response.usageMetadata ?? {}
  const input = u.promptTokenCount ?? 0
  const output = u.candidatesTokenCount ?? 0
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: u.totalTokenCount ?? input + output,
  }
}

function mapFinishReason(reason: string | undefined, parts: GeminiPart[]): FinishReason {
  if (parts.some(p => p.functionCall)) return FinishReason.ToolUse
  switch (reason) {
    case 'STOP':
      return FinishReason.Stop
    case 'MAX_TOKENS':
      return FinishReason.Length
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return FinishReason.ContentFilter
    default:
      return FinishReason.Unknown
  }
}

/**
 * Classify a Google/GCP error into a ClassifiedError. GCP surfaces errors both
 * as HTTP status numbers and as gRPC-style string status codes
 * (RESOURCE_EXHAUSTED, PERMISSION_DENIED, …); both are handled. Must never throw.
 */
export function classifyGoogleError(err: unknown): ClassifiedError {
  const e = (err ?? {}) as {
    status?: number | string
    code?: number | string
    message?: string
    error?: { code?: number; status?: string; message?: string }
  }
  const message = e.error?.message ?? e.message ?? 'Unknown Vertex error'
  const httpStatus =
    (typeof e.status === 'number' && e.status) ||
    (typeof e.code === 'number' && e.code) ||
    (typeof e.error?.code === 'number' && e.error.code) ||
    undefined
  const statusString =
    (typeof e.status === 'string' && e.status) ||
    (typeof e.code === 'string' && e.code) ||
    e.error?.status ||
    undefined

  if (httpStatus !== undefined) {
    if (httpStatus === 429) return { code: LlmErrorCode.RateLimited, retryable: true, message }
    if (httpStatus === 401 || httpStatus === 403)
      return { code: LlmErrorCode.AuthenticationFailed, retryable: false, message }
    if (httpStatus >= 500 && httpStatus < 600)
      return { code: LlmErrorCode.ModelOverloaded, retryable: true, message }
    if (httpStatus === 400) return { code: LlmErrorCode.ApiCallFailed, retryable: false, message }
  }

  switch (statusString) {
    case 'RESOURCE_EXHAUSTED':
      return { code: LlmErrorCode.RateLimited, retryable: true, message }
    case 'PERMISSION_DENIED':
    case 'UNAUTHENTICATED':
      return { code: LlmErrorCode.AuthenticationFailed, retryable: false, message }
    case 'UNAVAILABLE':
    case 'INTERNAL':
    case 'DEADLINE_EXCEEDED':
      return { code: LlmErrorCode.ModelOverloaded, retryable: true, message }
    case 'INVALID_ARGUMENT':
    case 'FAILED_PRECONDITION':
    case 'NOT_FOUND':
      return { code: LlmErrorCode.ApiCallFailed, retryable: false, message }
  }

  return classifyUnknown(err)
}

// ─── Lazy construction (own-SDK arm) ─────────────────────────────────────────

interface ServiceAccountJson {
  client_email?: string
  private_key?: string
  project_id?: string
}

/** The options object handed to `new GoogleGenAI(...)`. */
export interface VertexClientOptions {
  vertexai: true
  project: string
  location: string
  googleAuthOptions: {
    credentials: { client_email: string; private_key: string }
    projectId: string
  }
}

/**
 * Pure: derive the Vertex client options from the credential bag + pod env,
 * constructing the auth credentials IN MEMORY from the service-account JSON —
 * never via a `GOOGLE_APPLICATION_CREDENTIALS` file. `VERTEX_PROJECT_ID`
 * (falling back to the JSON's `project_id`) is required; `VERTEX_LOCATION`
 * defaults to us-central1. Throws (never echoing the secret) on a missing/
 * malformed JSON or an unresolvable project id. Separated from
 * {@link buildGoogleGenerativeDriver} so all the wiring is testable without the
 * SDK.
 */
export function buildVertexClientOptions(credentials: ProviderCredentials): VertexClientOptions {
  const rawJson = credentials['vertex-service-account-json']
  if (!rawJson) throw new Error('vertex: missing service-account JSON credential')

  let sa: ServiceAccountJson
  try {
    sa = JSON.parse(rawJson) as ServiceAccountJson
  } catch {
    // Never echo the parse error — a SyntaxError can embed a snippet of the key.
    throw new Error('vertex: service-account JSON is not valid JSON')
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error('vertex: service-account JSON missing client_email/private_key')
  }

  const projectId = process.env.VERTEX_PROJECT_ID || sa.project_id
  if (!projectId) throw new Error('vertex: VERTEX_PROJECT_ID is required')
  const location = process.env.VERTEX_LOCATION || 'us-central1'

  return {
    vertexai: true,
    project: projectId,
    location,
    googleAuthOptions: {
      credentials: { client_email: sa.client_email, private_key: sa.private_key },
      projectId,
    },
  }
}

/**
 * Build a {@link GoogleGenerativeDriver} from the credential bag. LAZILY
 * `require()`s `@google/genai` (CommonJS) so the SDK is parsed only when a Host
 * runs on Vertex. Credential wiring is delegated to
 * {@link buildVertexClientOptions}; `createLLMProvider` catches any throw and
 * degrades (never crashes).
 */
export function buildGoogleGenerativeDriver(
  credentials: ProviderCredentials,
  model: string
): SingleTurnProvider {
  const options = buildVertexClientOptions(credentials)

  // Lazy CommonJS require — only reached for a Vertex Host.

  const { GoogleGenAI } = require('@google/genai') as {
    GoogleGenAI: new (opts: VertexClientOptions) => {
      models: { generateContent(input: GeminiRequest): Promise<GeminiResponse> }
    }
  }
  const genai = new GoogleGenAI(options)

  const client: GeminiGenerateClient = {
    generateContent: input => genai.models.generateContent(input),
  }
  return new GoogleGenerativeDriver(client, model)
}
