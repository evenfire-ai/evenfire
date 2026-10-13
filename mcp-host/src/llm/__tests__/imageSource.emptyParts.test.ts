import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../core/types'
import { projectMessage } from '../imageSource'

// An empty contentParts array is "no parts": the turn stays V1 byte-identical.
describe('projectMessage with an empty contentParts array', () => {
  it('keeps a user turn byte-identical to V1 and keeps its content', () => {
    const message = { role: 'user', content: 'hello', contentParts: [] } as ChatMessage
    expect(JSON.stringify(projectMessage(message, 'codex_request_invalid'))).toBe(
      JSON.stringify({ role: 'user', content: 'hello' })
    )
  })

  it('does not refuse an assistant turn that carries no parts', () => {
    const message = { role: 'assistant', content: 'done', contentParts: [] } as ChatMessage
    expect(projectMessage(message, 'codex_request_invalid')).toEqual({
      role: 'assistant',
      content: 'done',
    })
  })
})
