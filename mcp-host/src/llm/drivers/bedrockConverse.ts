/**
 * Amazon Bedrock provider — own-SDK arm (R4).
 *
 * SDK choice: `@aws-sdk/client-bedrock-runtime` (AWS SDK v3, modular) via the
 * Converse API. Rationale:
 *   - Converse is Bedrock's provider-agnostic tool-calling surface (`toolConfig`
 *     + `toolUse`/`toolResult` blocks), so one arm serves every Bedrock-hosted
 *     model without per-vendor request shaping;
 *   - v3 is modular — only the `bedrock-runtime` client ships, never the
 *     `aws-sdk` v2 monolith — and it is `require()`d LAZILY in
 *     {@link buildBedrockConverseDriver} so it is parsed only when a Host runs
 *     on Bedrock. SigV4 signing is handled by the SDK from the injected keys.
 *
 * The driver never imports the SDK at module load (not even as a type) — the
 * runtime client is injected — so the CommonJS lazy require in the builder is
 * the only load site.
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
import { classifyByHttpStatus, classifyUnknown } from '../errorClassification'
import type { LlmProvider } from '../registryCore'
import type { ClassifiedError, SingleTurnProvider } from '../types'

// ─── SDK-agnostic wire shapes (Converse API) ─────────────────────────────────

interface BedrockContentBlock {
  text?: string
  toolUse?: { toolUseId: string; name: string; input: Record<string, unknown> }
  toolResult?: {
    toolUseId: string
    content: Array<{ text?: string }>
    status?: 'success' | 'error'
  }
  image?: { format: string; source: { bytes: Uint8Array } }
}
interface BedrockMessage {
  role: 'user' | 'assistant'
  content: BedrockContentBlock[]
}
interface BedrockConverseRequest {
  modelId: string
  system?: Array<{ text: string }>
  messages: BedrockMessage[]
  toolConfig?: {
    tools: Array<{
      toolSpec: {
        name: string
        description: string
        inputSchema: { json: Record<string, unknown> }
      }
    }>
  }
  inferenceConfig?: { maxTokens?: number; temperature?: number }
}
interface BedrockConverseResponse {
  output?: { message?: { content?: BedrockContentBlock[] } }
  stopReason?: string
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
}

/** The minimal surface of the Bedrock client the driver consumes. */
export interface BedrockConverseClient {
  converse(
    input: BedrockConverseRequest,
    options?: { signal?: AbortSignal }
  ): Promise<BedrockConverseResponse>
}

export class BedrockConverseDriver implements SingleTurnProvider {
  private client: BedrockConverseClient
  private defaultModel: string

  constructor(client: BedrockConverseClient, defaultModel: string) {
    this.client = client
    this.defaultModel = defaultModel
    console.log(`[Bedrock] Initialized with model: ${defaultModel}`)
  }

  getProviderType(): LlmProvider {
    return 'bedrock'
  }

  classifyError(err: unknown): ClassifiedError {
    return classifyBedrockError(err)
  }

  // ─── Single-Turn Methods ────────────────────────────────────────────────

  async completeSingleTurn(
    messages: CoreChatMessage[],
    options?: { max_tokens?: number; temperature?: number; signal?: AbortSignal }
  ): Promise<CompletionResponse> {
    const { system, converseMessages } = this.toBedrockMessages(messages)
    const response = await this.client.converse(
      {
        modelId: this.defaultModel,
        system: system.length > 0 ? system : undefined,
        messages: converseMessages,
        inferenceConfig: inferenceConfig(options),
      },
      { signal: options?.signal }
    )

    return {
      content: extractText(response) ?? '',
      usage: mapUsage(response),
      usage_reported: hasAuthoritativeUsage(response),
      finish_reason: mapStopReason(response.stopReason),
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
    const { system, converseMessages } = this.toBedrockMessages(messages)
    const toolConfig =
      tools.length > 0
        ? {
            tools: tools.map(t => ({
              toolSpec: {
                name: t.name,
                description: t.description,
                inputSchema: { json: t.parameters },
              },
            })),
          }
        : undefined

    const response = await this.client.converse(
      {
        modelId: this.defaultModel,
        system: system.length > 0 ? system : undefined,
        messages: converseMessages,
        toolConfig,
        inferenceConfig: inferenceConfig(options),
      },
      { signal: options?.signal }
    )

    const blocks = response.output?.message?.content ?? []
    const toolCalls = blocks
      .filter(b => b.toolUse)
      .map(b => ({
        id: b.toolUse!.toolUseId,
        name: b.toolUse!.name,
        arguments: (b.toolUse!.input ?? {}) as Record<string, unknown>,
      }))

    return {
      content: extractText(response),
      tool_calls: toolCalls.length > 0 ? toolCalls : null,
      usage: mapUsage(response),
      finish_reason: mapStopReason(response.stopReason),
    }
  }

  // ─── Message translation ─────────────────────────────────────────────────

  /**
   * Convert the normalized ChatMessage[] into Converse `messages` + a `system`
   * block list. Consecutive `tool` messages collapse into a SINGLE user message
   * carrying one `toolResult` block per tool call — Converse requires tool
   * results grouped into the user turn that answers the preceding assistant
   * `toolUse` turn.
   */
  private toBedrockMessages(messages: CoreChatMessage[]): {
    system: Array<{ text: string }>
    converseMessages: BedrockMessage[]
  } {
    const system: Array<{ text: string }> = []
    const out: BedrockMessage[] = []

    for (const m of messages) {
      if (m.role === 'system') {
        system.push({ text: m.content })
        continue
      }
      if (m.role === 'tool') {
        const block: BedrockContentBlock = {
          toolResult: {
            toolUseId: m.tool_call_id ?? '',
            content: [{ text: m.content }],
            status: 'success',
          },
        }
        // Group into the current trailing user message if it already holds tool
        // results; otherwise open a new user turn.
        const last = out[out.length - 1]
        if (last && last.role === 'user' && last.content.every(c => c.toolResult)) {
          last.content.push(block)
        } else {
          out.push({ role: 'user', content: [block] })
        }
        continue
      }
      if (m.role === 'assistant') {
        const content: BedrockContentBlock[] = []
        if (m.content) content.push({ text: m.content })
        for (const tc of m.tool_calls ?? []) {
          content.push({ toolUse: { toolUseId: tc.id, name: tc.name, input: tc.arguments } })
        }
        out.push({ role: 'assistant', content: content.length > 0 ? content : [{ text: '' }] })
        continue
      }
      // user
      if (m.contentParts?.length) {
        const content: BedrockContentBlock[] = m.contentParts.map(part =>
          part.type === 'text'
            ? { text: part.text }
            : {
                image: {
                  format: part.mimeType === 'image/png' ? 'png' : 'jpeg',
                  source: { bytes: base64ToBytes(part.data) },
                },
              }
        )
        out.push({ role: 'user', content })
        continue
      }
      out.push({ role: 'user', content: [{ text: m.content }] })
    }

    return { system, converseMessages: out }
  }
}

function inferenceConfig(options?: {
  max_tokens?: number
  temperature?: number
}): { maxTokens?: number; temperature?: number } | undefined {
  if (options?.max_tokens === undefined && options?.temperature === undefined) return undefined
  return { maxTokens: options?.max_tokens, temperature: options?.temperature }
}

function extractText(response: BedrockConverseResponse): string | null {
  const blocks = response.output?.message?.content ?? []
  const text = blocks.map(b => b.text ?? '').join('')
  return text.length > 0 ? text : null
}

function mapUsage(response: BedrockConverseResponse): CompletionResponse['usage'] {
  const u = response.usage ?? {}
  const input = u.inputTokens ?? 0
  const output = u.outputTokens ?? 0
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: u.totalTokens ?? input + output,
  }
}

function hasAuthoritativeUsage(response: BedrockConverseResponse): boolean {
  const usage = response.usage
  const input = usage?.inputTokens
  const output = usage?.outputTokens
  return (
    usage != null &&
    typeof input === 'number' &&
    Number.isInteger(input) &&
    input >= 0 &&
    typeof output === 'number' &&
    Number.isInteger(output) &&
    output >= 0
  )
}

function mapStopReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return FinishReason.Stop
    case 'max_tokens':
      return FinishReason.Length
    case 'tool_use':
      return FinishReason.ToolUse
    case 'content_filtered':
      return FinishReason.ContentFilter
    default:
      return FinishReason.Unknown
  }
}

function base64ToBytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'))
}

/**
 * Classify an AWS SDK v3 error into a ClassifiedError. Bedrock errors carry a
 * modeled `.name` (ThrottlingException, AccessDeniedException, …) and an HTTP
 * status in `$metadata.httpStatusCode`; the modeled name takes precedence, with
 * the HTTP status as a fallback. Must never throw.
 */
export function classifyBedrockError(err: unknown): ClassifiedError {
  const e = (err ?? {}) as {
    name?: string
    message?: string
    $metadata?: { httpStatusCode?: number }
  }
  const message = e.message ?? 'Unknown Bedrock error'

  switch (e.name) {
    case 'ThrottlingException':
    case 'TooManyRequestsException':
      return { code: LlmErrorCode.RateLimited, retryable: true, message }
    case 'AccessDeniedException':
    case 'UnrecognizedClientException':
    case 'IncompleteSignatureException':
    case 'InvalidSignatureException':
      return { code: LlmErrorCode.AuthenticationFailed, retryable: false, message }
    case 'ServiceQuotaExceededException':
      return { code: LlmErrorCode.InsufficientQuota, retryable: false, message }
    case 'ValidationException':
      return { code: LlmErrorCode.ApiCallFailed, retryable: false, message }
    case 'ModelTimeoutException':
    case 'ModelNotReadyException':
    case 'ServiceUnavailableException':
    case 'InternalServerException':
      return { code: LlmErrorCode.ModelOverloaded, retryable: true, message }
  }

  const status = e.$metadata?.httpStatusCode
  if (status !== undefined) {
    const byStatus = classifyByHttpStatus({ status, message })
    if (byStatus) return byStatus
  }
  return classifyUnknown(err)
}

// ─── Lazy construction (own-SDK arm) ─────────────────────────────────────────

/** The config object handed to `new BedrockRuntimeClient(...)`. */
export interface BedrockClientConfig {
  region: string
  credentials: { accessKeyId: string; secretAccessKey: string }
}

/**
 * Pure: derive the Bedrock client config from the credential bag + pod env.
 * Both AWS key slots are required (also validated upstream in
 * `createLLMProvider`); `AWS_REGION` is required non-secret pod env
 * (`host-<ref>-env`). Throws on a missing region / key. Separated from
 * {@link buildBedrockConverseDriver} so the wiring is testable without the SDK.
 */
export function buildBedrockClientConfig(credentials: ProviderCredentials): BedrockClientConfig {
  const accessKeyId = credentials['aws-access-key-id']
  const secretAccessKey = credentials['aws-secret-access-key']
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('bedrock: missing AWS access-key-id / secret-access-key')
  }
  const region = process.env.AWS_REGION
  if (!region) throw new Error('bedrock: AWS_REGION is required')
  return { region, credentials: { accessKeyId, secretAccessKey } }
}

/**
 * Build a {@link BedrockConverseDriver} from the credential bag. LAZILY
 * `require()`s `@aws-sdk/client-bedrock-runtime` (CommonJS) so the SDK is parsed
 * only when a Host runs on Bedrock. Config wiring is delegated to
 * {@link buildBedrockClientConfig}; `createLLMProvider` catches any throw and
 * degrades (never crashes).
 */
export function buildBedrockConverseDriver(
  credentials: ProviderCredentials,
  model: string
): SingleTurnProvider {
  const clientConfig = buildBedrockClientConfig(credentials)

  // Lazy CommonJS require — only reached for a Bedrock Host.

  const { BedrockRuntimeClient, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime') as {
    BedrockRuntimeClient: new (opts: BedrockClientConfig) => {
      send(
        command: unknown,
        options?: { abortSignal?: AbortSignal }
      ): Promise<BedrockConverseResponse>
    }
    ConverseCommand: new (input: BedrockConverseRequest) => unknown
  }
  const raw = new BedrockRuntimeClient(clientConfig)

  const client: BedrockConverseClient = {
    converse: (input, options) =>
      raw.send(new ConverseCommand(input), { abortSignal: options?.signal }),
  }
  return new BedrockConverseDriver(client, model)
}
