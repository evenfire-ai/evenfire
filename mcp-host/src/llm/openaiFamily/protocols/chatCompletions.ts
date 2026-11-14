/**
 * `/chat/completions` wire protocol. Messages are rebuilt field by field, so a
 * core field this protocol does not know about never reaches the wire.
 */
import type OpenAI from 'openai'
import type {
  CompletionResponse,
  ChatMessage as CoreChatMessage,
  ToolCompletionResponse,
} from '../../../core/types'
import type { ResolvedModelParams } from '../modelParamPolicy'
import { isUsageReported, mapFinishReason, parseArguments } from '../shared'
import type { EncodeContext, WireProtocol } from './types'

type ChatPayload = OpenAI.ChatCompletionCreateParamsNonStreaming
type ChatResult = OpenAI.ChatCompletion

function tokenLimit(
  maxTokens: number | undefined,
  params: ResolvedModelParams
): { max_tokens?: number; max_completion_tokens?: number } {
  if (maxTokens === undefined) return {}
  return params.tokenField === 'max_completion_tokens'
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens }
}

function temperatureField(
  temperature: number | undefined,
  params: ResolvedModelParams
): { temperature?: number } {
  return params.temperature === 'pass' ? { temperature } : {}
}

function convertMessages(
  messages: readonly CoreChatMessage[],
  ctx: EncodeContext
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
    if (m.role === 'assistant') {
      if (m.tool_calls) {
        const assistantMessage = {
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
        } as Record<string, unknown>
        // Only endpoints that require it get reasoning back; elsewhere a
        // provider-specific field from another provider's history must not
        // leak after a failover.
        if (m.reasoning_content && ctx.reasoningContent) {
          assistantMessage.reasoning_content = m.reasoning_content
        }
        return assistantMessage as unknown as OpenAI.ChatCompletionAssistantMessageParam
      }
      return { role: 'assistant' as const, content: m.content }
    }
    if (m.role === 'user') {
      return { role: 'user' as const, content: m.content }
    }
    // Operator/soul instruction channel. This API is WRC-JWT gated; the
    // host must forward system text to the model. Do not fold user/tool
    // content into this branch — that union was js/system-prompt-injection.
    return { role: 'system' as const, content: m.content }
  })
}

function usageOf(response: ChatResult) {
  return {
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
    },
    usage_reported:
      response.usage != null &&
      isUsageReported(response.usage.prompt_tokens, response.usage.completion_tokens),
  }
}

export const chatCompletionsProtocol: WireProtocol<ChatPayload, ChatResult> = {
  id: 'openai-chat',

  encodeText(input, ctx) {
    // Plain completion keeps only role + text; image parts are not sent here.
    const messages = input.messages.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    }))
    return {
      model: ctx.model,
      messages,
      ...tokenLimit(input.max_tokens, ctx.params),
      ...temperatureField(input.temperature, ctx.params),
    }
  },

  encodeTools(input, ctx) {
    // OpenAI rejects tools: [] with 400 error — must be undefined when empty
    const tools =
      input.tools.length > 0
        ? input.tools.map(t => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }))
        : undefined
    return {
      model: ctx.model,
      messages: convertMessages(input.messages, ctx),
      tools,
      tool_choice: tools
        ? ((input.tool_choice ?? 'auto') as OpenAI.ChatCompletionToolChoiceOption)
        : undefined,
      ...tokenLimit(input.max_tokens, ctx.params),
      ...temperatureField(input.temperature, ctx.params),
    }
  },

  decodeText(response): CompletionResponse {
    const choice = response.choices[0]
    const { usage, usage_reported } = usageOf(response)
    return {
      content: choice.message.content ?? '',
      usage,
      usage_reported,
      finish_reason: mapFinishReason(choice.finish_reason),
    }
  },

  decodeTools(response): ToolCompletionResponse {
    const choice = response.choices[0]
    const message = choice.message
    const toolCalls =
      message.tool_calls?.map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: parseArguments(tc.function.arguments),
      })) ?? null
    const reasoningContent = (message as { reasoning_content?: unknown }).reasoning_content
    const { usage, usage_reported } = usageOf(response)
    return {
      content: message.content,
      tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : null,
      reasoning_content: typeof reasoningContent === 'string' ? reasoningContent : null,
      usage,
      usage_reported,
      finish_reason: mapFinishReason(choice.finish_reason),
    }
  },

  send(client, payload, signal) {
    return client.chat.completions.create(payload, { signal })
  },
}
