/**
 * Anthropic Claude LLM provider with tool/function calling support.
 */
import Anthropic from '@anthropic-ai/sdk'
import { LlmErrorCode } from '../core/errors'
import type { SystemPromptParts } from '../core/reasoning/systemPrompt'
import {
  AnthropicTokenCounter,
  type AnthropicTokenCounterOptions,
} from '../core/tokenizer/anthropicTokenCounter'
import type { TokenCounter } from '../core/tokenizer/tokenCounter'
import {
  CompletionResponse,
  ChatMessage as CoreChatMessage,
  FinishReason,
  ToolCompletionResponse,
  ToolDefinition,
} from '../core/types'
import { convertToClaudeMessages, separateSystemMessage } from './claude/messageTranslate'
import { classifyByHttpStatus, classifyUnknown } from './errorClassification'
import type { LlmProvider } from './registryCore'
import type { ClassifiedError, SingleTurnProvider } from './types'

export class ClaudeProvider implements SingleTurnProvider {
  private client: Anthropic
  private defaultModel: string

  constructor(apiKeyOrClient: string | Anthropic, defaultModel: string = 'claude-sonnet-4-6') {
    if (typeof apiKeyOrClient === 'string') {
      this.client = new Anthropic({ apiKey: apiKeyOrClient })
    } else {
      this.client = apiKeyOrClient
    }
    this.defaultModel = defaultModel
    console.log(`[Claude] Initialized with model: ${defaultModel}`)
  }

  /**
   * Get the provider type.
   */
  getProviderType(): LlmProvider {
    return 'claude'
  }

  /**
   * Build the provider-aware token counter. Keeps the SDK client private —
   * the counter receives it at construction time and the rest of the codebase
   * never sees the raw `Anthropic` instance. Key rotation that swaps this
   * provider also brings a fresh counter for free.
   */
  createTokenCounter(modelName: string, options?: AnthropicTokenCounterOptions): TokenCounter {
    return new AnthropicTokenCounter(this.client, modelName, options)
  }

  classifyError(err: unknown): ClassifiedError {
    const httpClassification = classifyByHttpStatus(err)
    if (httpClassification) {
      // Anthropic quirk: insufficient credit is reported as HTTP 400
      // (not 402), detectable only by message substring.
      if (
        httpClassification.code === LlmErrorCode.ApiCallFailed &&
        /credit balance is too low/i.test(httpClassification.message)
      ) {
        return {
          ...httpClassification,
          code: LlmErrorCode.InsufficientQuota,
          retryable: false,
        }
      }
      return httpClassification
    }
    return classifyUnknown(err)
  }

  // ─── Single-Turn Methods ──────────────────────────────────

  async completeSingleTurn(
    messages: CoreChatMessage[],
    options?: { max_tokens?: number; temperature?: number; signal?: AbortSignal }
  ): Promise<CompletionResponse> {
    const { systemPrompt, claudeMessages } = this.separateSystemMessage(messages)

    const response = await this.client.messages.create(
      {
        model: this.defaultModel,
        system: systemPrompt || undefined,
        messages: claudeMessages.map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        })),
        max_tokens: options?.max_tokens ?? 4096,
        temperature: options?.temperature,
      },
      { signal: options?.signal }
    )

    const textContent = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')

    return {
      content: textContent,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      finish_reason: this.mapStopReason(response.stop_reason),
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
    const { systemPrompt, claudeMessages } = this.separateSystemMessage(messages)
    const formattedMessages = this.convertToClaudeMessages(claudeMessages)

    const claudeTools = tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }))

    const response = await this.client.messages.create(
      {
        model: this.defaultModel,
        system: systemPrompt || undefined,
        messages: formattedMessages,
        tools: claudeTools.length > 0 ? claudeTools : undefined,
        max_tokens: options?.max_tokens ?? 4096,
        temperature: options?.temperature,
      },
      { signal: options?.signal }
    )

    const textContent =
      response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('') || null

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    )
    const toolCalls =
      toolUseBlocks.length > 0
        ? toolUseBlocks.map(b => ({
            id: b.id,
            name: b.name,
            arguments: b.input as Record<string, unknown>,
          }))
        : null

    return {
      content: textContent,
      tool_calls: toolCalls,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      finish_reason: this.mapStopReason(response.stop_reason),
    }
  }

  // ─── T2.2 Cache-aware single-turn methods ─────────────────────────

  /**
   * T2.2 — Cache-aware completion. Emits the `system` field as an array of
   * `TextBlockParam` with `cache_control: { type: 'ephemeral' }` on every
   * tier so Anthropic prefix-caches the entire system block. Tools travel in
   * their dedicated parameter (no `tools` text in the system) sorted by name
   * so add/remove of a single tool only shifts the delta in the `tools` cache
   * slot, leaving the surrounding entries stable.
   */
  async completeSingleTurnWithToolsAndCache(
    parts: SystemPromptParts,
    messages: CoreChatMessage[],
    tools: ToolDefinition[],
    options?: {
      max_tokens?: number
      temperature?: number
      tool_choice?: string
      signal?: AbortSignal
    }
  ): Promise<ToolCompletionResponse> {
    const formattedMessages = this.convertToClaudeMessages(messages)
    const claudeTools = tools
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool['input_schema'],
      }))

    const systemBlocks: Array<Anthropic.TextBlockParam> = []
    if (parts.stable) {
      systemBlocks.push({
        type: 'text',
        text: parts.stable,
        cache_control: { type: 'ephemeral' },
      } as Anthropic.TextBlockParam)
    }
    if (parts.context) {
      systemBlocks.push({
        type: 'text',
        text: parts.context,
        cache_control: { type: 'ephemeral' },
      } as Anthropic.TextBlockParam)
    }

    const response = await this.client.messages.create(
      {
        model: this.defaultModel,
        system: systemBlocks.length > 0 ? systemBlocks : undefined,
        messages: formattedMessages,
        tools: claudeTools.length > 0 ? claudeTools : undefined,
        max_tokens: options?.max_tokens ?? 4096,
        temperature: options?.temperature,
      },
      { signal: options?.signal }
    )

    const textContent =
      response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('') || null

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    )
    const toolCalls =
      toolUseBlocks.length > 0
        ? toolUseBlocks.map(b => ({
            id: b.id,
            name: b.name,
            arguments: b.input as Record<string, unknown>,
          }))
        : null

    // P1-006: map Anthropic SDK field names to mcp-host's abbreviated schema.
    const u = response.usage as Anthropic.Usage & {
      cache_read_input_tokens?: number | null
      cache_creation_input_tokens?: number | null
    }
    return {
      content: textContent,
      tool_calls: toolCalls,
      usage: {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        total_tokens: u.input_tokens + u.output_tokens,
        cache_read_tokens: u.cache_read_input_tokens ?? 0,
        cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      },
      finish_reason: this.mapStopReason(response.stop_reason),
    }
  }

  /**
   * T2.2 — Cache-aware completion without tools. Same wire-shape decisions as
   * `completeSingleTurnWithToolsAndCache` minus the `tools` parameter. Used
   * by `PressureContextManager.summarize` when wired through the cache path
   * (rare; the tool-less path is mostly background summarization).
   */
  async completeSingleTurnAndCache(
    parts: SystemPromptParts,
    messages: CoreChatMessage[],
    options?: { max_tokens?: number; temperature?: number; signal?: AbortSignal }
  ): Promise<CompletionResponse> {
    const claudeMessages = this.convertToClaudeMessages(messages)
    const systemBlocks: Array<Anthropic.TextBlockParam> = []
    if (parts.stable) {
      systemBlocks.push({
        type: 'text',
        text: parts.stable,
        cache_control: { type: 'ephemeral' },
      } as Anthropic.TextBlockParam)
    }
    if (parts.context) {
      systemBlocks.push({
        type: 'text',
        text: parts.context,
        cache_control: { type: 'ephemeral' },
      } as Anthropic.TextBlockParam)
    }

    const response = await this.client.messages.create(
      {
        model: this.defaultModel,
        system: systemBlocks.length > 0 ? systemBlocks : undefined,
        messages: claudeMessages,
        max_tokens: options?.max_tokens ?? 4096,
        temperature: options?.temperature,
      },
      { signal: options?.signal }
    )

    const textContent = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')

    const u = response.usage as Anthropic.Usage & {
      cache_read_input_tokens?: number | null
      cache_creation_input_tokens?: number | null
    }
    return {
      content: textContent,
      usage: {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        total_tokens: u.input_tokens + u.output_tokens,
        cache_read_tokens: u.cache_read_input_tokens ?? 0,
        cache_write_tokens: u.cache_creation_input_tokens ?? 0,
      },
      finish_reason: this.mapStopReason(response.stop_reason),
    }
  }

  private separateSystemMessage(messages: CoreChatMessage[]): {
    systemPrompt: string | null
    claudeMessages: CoreChatMessage[]
  } {
    return separateSystemMessage(messages)
  }

  private convertToClaudeMessages(messages: CoreChatMessage[]): Anthropic.MessageParam[] {
    return convertToClaudeMessages(messages)
  }

  private mapStopReason(reason: string | null | undefined): FinishReason {
    switch (reason) {
      case 'end_turn':
        return FinishReason.Stop
      case 'max_tokens':
        return FinishReason.Length
      case 'tool_use':
        return FinishReason.ToolUse
      default:
        return FinishReason.Unknown
    }
  }
}
