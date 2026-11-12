/**
 * Wire protocol strategy for the OpenAI driver family. A protocol owns how a
 * core request becomes an SDK payload and how the SDK result becomes the core
 * contract; it never decides endpoint quirks or model parameters (those arrive
 * already resolved in the encode context).
 */
import type OpenAI from 'openai'
import type {
  CompletionResponse,
  ChatMessage as CoreChatMessage,
  ToolCompletionResponse,
  ToolDefinition,
} from '../../../core/types'
import type { LlmProvider } from '../../registryCore'
import type { ResolvedModelParams } from '../modelParamPolicy'

export type WireProtocolId = 'openai-chat' | 'openai-responses'

/**
 * Who is encoding or decoding. A protocol that carries provider continuity
 * stamps it on decode and replays it on encode only to an identical identity.
 */
export interface DriverIdentity {
  readonly provider: LlmProvider
  readonly protocol: WireProtocolId
  readonly model: string
  /** Distinct per driver instance. */
  readonly epoch: string
}

export interface EncodeContext extends DriverIdentity {
  readonly params: ResolvedModelParams
  /** Whether the endpoint requires `reasoning_content` on assistant tool-call messages. */
  readonly reasoningContent: boolean
}

export interface EncodeTextInput {
  readonly messages: readonly CoreChatMessage[]
  readonly max_tokens?: number
  readonly temperature?: number
}

export interface EncodeToolsInput extends EncodeTextInput {
  readonly tools: readonly ToolDefinition[]
  readonly tool_choice?: string
}

export type DecodeContext = DriverIdentity

export interface WireProtocol<Payload = unknown, Raw = unknown> {
  readonly id: WireProtocolId
  /** Pure: no network, no clock. */
  encodeText(input: EncodeTextInput, ctx: EncodeContext): Payload
  /** Pure: no network, no clock. */
  encodeTools(input: EncodeToolsInput, ctx: EncodeContext): Payload
  /** Pure: raw SDK result → core contract. */
  decodeText(raw: Raw, ctx: DecodeContext): CompletionResponse
  /** Pure: raw SDK result → core contract. */
  decodeTools(raw: Raw, ctx: DecodeContext): ToolCompletionResponse
  /**
   * The only effect. The client is passed per call (never stored) because the
   * driver's client is swappable after construction.
   */
  send(client: OpenAI, payload: Payload, signal?: AbortSignal): Promise<Raw>
}
