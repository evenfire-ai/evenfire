/**
 * Pure conversion between Clerum's internal ChatMessage shape and Anthropic's
 * Messages API request format. Extracted from `ClaudeProvider` so the token
 * counter (`AnthropicTokenCounter`) translates messages with the EXACT same
 * logic the provider uses — otherwise the counter would measure something the
 * API doesn't bill for.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage } from '../../core/types'

export function separateSystemMessage(messages: ChatMessage[]): {
  systemPrompt: string | null
  claudeMessages: ChatMessage[]
} {
  const systemMsgs = messages.filter(m => m.role === 'system')
  const otherMsgs = messages.filter(m => m.role !== 'system')
  return {
    systemPrompt: systemMsgs.length > 0 ? systemMsgs.map(m => m.content).join('\n\n') : null,
    claudeMessages: otherMsgs,
  }
}

export function convertToClaudeMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = []

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      const content: (Anthropic.TextBlock | Anthropic.ToolUseBlock)[] = []
      if (msg.content) {
        content.push({ type: 'text', text: msg.content } as Anthropic.TextBlock)
      }
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        })
      }
      result.push({ role: 'assistant', content })
    } else if (msg.role === 'tool') {
      let toolContent: string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> =
        msg.content
      if (msg.contentParts?.length) {
        toolContent = msg.contentParts.map(part => {
          if (part.type === 'text') {
            return { type: 'text' as const, text: part.text }
          }
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: part.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: part.data,
            },
          }
        })
      }
      const toolResult: Anthropic.ToolResultBlockParam = {
        type: 'tool_result' as const,
        tool_use_id: msg.tool_call_id!,
        content: toolContent,
        is_error: false,
      }

      const lastMsg = result[result.length - 1]
      if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
        lastMsg.content.push(toolResult)
      } else {
        result.push({ role: 'user', content: [toolResult] })
      }
    } else if (msg.role === 'user' && msg.contentParts?.length) {
      const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> =
        msg.contentParts.map(part => {
          if (part.type === 'text') {
            return { type: 'text' as const, text: part.text }
          }
          return {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: part.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: part.data,
            },
          }
        })
      result.push({ role: 'user', content })
    } else {
      result.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      })
    }
  }

  return result
}
