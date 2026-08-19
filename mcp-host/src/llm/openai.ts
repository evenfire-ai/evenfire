/**
 * OpenAI LLM provider with tool/function calling support.
 */
import OpenAI from 'openai'
import {
  CompletionResponse,
  ChatMessage as CoreChatMessage,
  FinishReason,
  ToolCompletionResponse,
  ToolDefinition,
} from '../core/types'
import { classifyByHttpStatus, classifyUnknown } from './errorClassification'
import type { LlmProvider } from './registryCore'
import type { ClassifiedError, SingleTurnProvider } from './types'

export class OpenAIProvider implements SingleTurnProvider {
  private client: OpenAI
  private defaultModel: string

  constructor(apiKeyOrClient: string | OpenAI, defaultModel: string = 'gpt-5.4-mini') {
    if (typeof apiKeyOrClient === 'string') {
      this.client = new OpenAI({ apiKey: apiKeyOrClient })
    } else {
      this.client = apiKeyOrClient
    }
    this.defaultModel = defaultModel
    console.log(`[OpenAI] Initialized with model: ${defaultModel}`)
  }

  /**
   * Get the provider type.
   */
  getProviderType(): LlmProvider {
    return 'openai'
  }

  /**
   * OpenAI's reasoning/latest model families reject the legacy `max_tokens`
   * request field and require `max_completion_tokens`. Keep the internal
   * provider contract stable (`max_tokens`) while translating only those
   * native models at the wire boundary. OpenAI-compatible providers override
   * this hook because their portability contract still uses `max_tokens`.
   */
  protected usesMaxCompletionTokens(): boolean {
    return /^(?:gpt-5(?:[.-]|$)|o[1-9](?:[.-]|$))/i.test(this.defaultModel)
  }

  private tokenLimitOptions(maxTokens: number | undefined): {
    max_tokens?: number
    max_completion_tokens?: number
  } {
    if (maxTokens === undefined) return {}
    return this.usesMaxCompletionTokens()
      ? { max_completion_tokens: maxTokens }
      : { max_tokens: maxTokens }
  }

  classifyError(err: unknown): ClassifiedError {
    return classifyByHttpStatus(err) ?? classifyUnknown(err)
  }

  // ─── Single-Turn Methods ──────────────────────────────────

  async completeSingleTurn(
    messages: CoreChatMessage[],
    options?: { max_tokens?: number; temperature?: number; signal?: AbortSignal }
  ): Promise<CompletionResponse> {
    const openaiMessages = messages.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    }))

    const response = await this.client.chat.completions.create(
      {
        model: this.defaultModel,
        messages: openaiMessages,
        ...this.tokenLimitOptions(options?.max_tokens),
        temperature: options?.temperature,
      },
      { signal: options?.signal }
    )

    const choice = response.choices[0]
    const usageReported =
      response.usage != null &&
      Number.isInteger(response.usage.prompt_tokens) &&
      response.usage.prompt_tokens >= 0 &&
      Number.isInteger(response.usage.completion_tokens) &&
      response.usage.completion_tokens >= 0
    return {
      content: choice.message.content ?? '',
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? 0,
      },
      usage_reported: usageReported,
      finish_reason: this.mapFinishReason(choice.finish_reason),
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
    const openaiMessages = this.convertToOpenAIMessages(messages)

    // OpenAI rejects tools: [] with 400 error — must be undefined when empty
    const openaiTools =
      tools.length > 0
        ? tools.map(t => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }))
        : undefined

    const response = await this.client.chat.completions.create(
      {
        model: this.defaultModel,
        messages: openaiMessages,
        tools: openaiTools,
        tool_choice: openaiTools
          ? ((options?.tool_choice ?? 'auto') as OpenAI.ChatCompletionToolChoiceOption)
          : undefined,
        ...this.tokenLimitOptions(options?.max_tokens),
        temperature: options?.temperature,
      },
      { signal: options?.signal }
    )

    const choice = response.choices[0]
    const message = choice.message

    const toolCalls =
      message.tool_calls?.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: this.parseArguments(tc.function.arguments),
      })) ?? null

    const usageReported =
      response.usage != null &&
      Number.isInteger(response.usage.prompt_tokens) &&
      response.usage.prompt_tokens >= 0 &&
      Number.isInteger(response.usage.completion_tokens) &&
      response.usage.completion_tokens >= 0
    return {
      content: message.content,
      tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
        total_tokens: response.usage?.total_tokens ?? 0,
      },
      usage_reported: usageReported,
      finish_reason: this.mapFinishReason(choice.finish_reason),
    }
  }

  private convertToOpenAIMessages(
    messages: CoreChatMessage[]
  ): OpenAI.ChatCompletionMessageParam[] {
    return messages.map(m => {
      if (m.role === 'tool') {
        // Tool messages must be text-only (OpenAI rejects images in tool role).
        // Images from tool results are sent in a subsequent user message.
        return {
          role: 'tool' as const,
          tool_call_id: m.tool_call_id!,
          content: m.content,
        }
      }
      if (m.role === 'user' && m.contentParts?.length) {
        // User messages with images (e.g., screenshots from desktop tools)
        const content = m.contentParts.map(part => {
          if (part.type === 'text') {
            return { type: 'text' as const, text: part.text }
          }
          return {
            type: 'image_url' as const,
            image_url: { url: `data:${part.mimeType};base64,${part.data}` },
          }
        })
        return { role: 'user' as const, content }
      }
      if (m.role === 'assistant' && m.tool_calls) {
        return {
          role: 'assistant' as const,
          content: m.content || null,
          tool_calls: m.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        }
      }
      return {
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
      }
    })
  }

  private parseArguments(argsString: string): Record<string, unknown> {
    try {
      return JSON.parse(argsString)
    } catch {
      return { _raw: argsString }
    }
  }

  private mapFinishReason(reason: string | null | undefined): FinishReason {
    switch (reason) {
      case 'stop':
        return FinishReason.Stop
      case 'length':
        return FinishReason.Length
      case 'tool_calls':
        return FinishReason.ToolUse
      case 'content_filter':
        return FinishReason.ContentFilter
      default:
        return FinishReason.Unknown
    }
  }
}
