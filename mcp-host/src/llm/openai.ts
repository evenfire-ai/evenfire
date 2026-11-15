/**
 * OpenAI wire-family driver with tool/function calling support.
 *
 * One driver serves official OpenAI, Azure OpenAI and every OpenAI-compatible
 * third party. What differs per endpoint lives in its `EndpointProfile`, the
 * request/response mapping in the profile's `WireProtocol`, and the accepted
 * parameters per model in the profile's `ModelParamPolicy`.
 */
import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import type {
  CompletionResponse,
  ChatMessage as CoreChatMessage,
  ToolCompletionResponse,
  ToolDefinition,
} from '../core/types'
import { logger } from '../logger'
import { assertVisualRequestFits } from '../visualInput/requestPolicy'
import type { ImageTransportOperation } from './imageInput'
import type { EndpointProfile } from './openaiFamily/endpointProfile'
import { applyOptionPolicy, officialOpenAIProfile } from './openaiFamily/endpointProfiles'
import { chatCompletionsProtocol } from './openaiFamily/protocols/chatCompletions'
import { responsesProtocol } from './openaiFamily/protocols/responses'
import type {
  DriverIdentity,
  EncodeContext,
  WireProtocol,
  WireProtocolId,
} from './openaiFamily/protocols/types'
import { classifyFamilyError } from './openaiFamily/shared'
import type { LlmProvider } from './registryCore'
import { fromWireResponse, toWireRequest } from './toolWireNames'
import type { ClassifiedError, SingleTurnProvider } from './types'

const PROTOCOLS: Record<WireProtocolId, WireProtocol> = {
  'openai-chat': chatCompletionsProtocol,
  'openai-responses': responsesProtocol as WireProtocol,
}

export class OpenAIProvider implements SingleTurnProvider {
  // Read on every call, never cached by the profile or protocol: callers may
  // swap the client after construction and must hit the new one.
  private client: OpenAI
  private defaultModel: string
  private readonly profile: EndpointProfile
  private readonly protocol: WireProtocol
  /**
   * A new instance is a new owner of provider continuity: `{provider, model}`
   * cannot tell another credential or a cold resume apart, and replaying a blob
   * minted under a different account is never valid.
   */
  private readonly epoch = randomUUID()

  constructor(
    apiKeyOrClient: string | OpenAI,
    defaultModel: string = 'gpt-5.4-mini',
    profile: EndpointProfile = officialOpenAIProfile()
  ) {
    this.profile = profile
    this.protocol = PROTOCOLS[profile.protocol]
    this.client = profile.createClient(apiKeyOrClient)
    this.defaultModel = defaultModel
    logger.info({ model: defaultModel }, 'OpenAI transport initialized')
  }

  getVisualDeliveryLimits(operation: ImageTransportOperation) {
    return this.profile.visualLimits(this.client.baseURL, operation)
  }

  getProviderType(): LlmProvider {
    return this.profile.id
  }

  classifyError(err: unknown): ClassifiedError {
    return classifyFamilyError(err, this.profile.classify)
  }

  private identity(): DriverIdentity {
    return {
      provider: this.profile.id,
      protocol: this.protocol.id,
      model: this.defaultModel,
      epoch: this.epoch,
    }
  }

  private encodeContext(): EncodeContext {
    return {
      ...this.identity(),
      params: this.profile.params.resolve(this.defaultModel, this.protocol.id),
      reasoningContent: this.profile.reasoningContent,
    }
  }

  private decodeContext(): DriverIdentity {
    return this.identity()
  }

  // ─── Single-Turn Methods ──────────────────────────────────

  async completeSingleTurn(
    messages: CoreChatMessage[],
    rawOptions?: { max_tokens?: number; temperature?: number; signal?: AbortSignal }
  ): Promise<CompletionResponse> {
    const options = applyOptionPolicy(rawOptions, this.profile.options)
    const ctx = this.encodeContext()
    const payload = this.protocol.encodeText(
      { messages, max_tokens: options?.max_tokens, temperature: options?.temperature },
      ctx
    )
    assertVisualRequestFits(messages, messages, false, this.getVisualDeliveryLimits('complete'))
    const response = await this.protocol.send(this.client, payload, options?.signal)
    return this.protocol.decodeText(response, this.decodeContext())
  }

  async completeSingleTurnWithTools(
    messages: CoreChatMessage[],
    tools: ToolDefinition[],
    rawOptions?: {
      max_tokens?: number
      temperature?: number
      tool_choice?: string
      signal?: AbortSignal
      verifyImageInput?: boolean
    }
  ): Promise<ToolCompletionResponse> {
    const options = applyOptionPolicy(rawOptions, this.profile.options)
    const ctx = this.encodeContext()
    // Encode and decode both see wire names, so the Responses continuation
    // digest is computed over the same names it is later checked against.
    const wire = toWireRequest(messages, tools, this.profile.toolNameEnvelope)
    const payload = this.protocol.encodeTools(
      {
        messages: wire.messages,
        tools: wire.tools,
        // Only modes reach here today; a tool name would need `wire.names.toWire`.
        tool_choice: options?.tool_choice,
        max_tokens: options?.max_tokens,
        temperature: options?.temperature,
      },
      ctx
    )
    assertVisualRequestFits(
      messages,
      payload,
      options?.verifyImageInput === true,
      this.getVisualDeliveryLimits('completeWithTools')
    )
    const response = await this.protocol.send(this.client, payload, options?.signal)
    return fromWireResponse(this.protocol.decodeTools(response, this.decodeContext()), wire.names)
  }
}
