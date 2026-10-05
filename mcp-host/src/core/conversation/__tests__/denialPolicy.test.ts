import { describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../../types'
import {
  hasActiveDenials,
  isDenied,
  liftDenial,
  parseDenials,
  recordDenial,
  serializeDenials,
} from '../denialPolicy'

function conversation(): Pick<Conversation, 'denials' | 'auto_approved_tools'> {
  return { auto_approved_tools: new Set() }
}

describe('denialPolicy', () => {
  it('records a denial and revokes an earlier Always approve for that tool', () => {
    const conv = conversation()
    conv.auto_approved_tools.add('shell_exec')
    conv.auto_approved_tools.add('file_read')

    recordDenial(conv, 'shell_exec', 'user-a')

    expect(isDenied(conv, 'shell_exec')).toBe(true)
    expect(hasActiveDenials(conv)).toBe(true)
    expect(conv.auto_approved_tools.has('shell_exec')).toBe(false)
    expect(conv.auto_approved_tools.has('file_read')).toBe(true)
  })

  it('keeps the latest denier', () => {
    const conv = conversation()
    recordDenial(conv, 'shell_exec', 'user-a')
    recordDenial(conv, 'shell_exec', 'user-b')

    expect(liftDenial(conv, 'shell_exec', 'user-a')).toBe('kept_for_denier')
    expect(liftDenial(conv, 'shell_exec', 'user-b')).toBe('lifted')
  })

  it.each([
    ['the denier', 'user-a', 'user-a', 'lifted'],
    ['another user', 'user-a', 'user-b', 'kept_for_denier'],
    ['no approver id', 'user-a', undefined, 'kept_for_denier'],
    ['any approver when the denier is unknown', undefined, 'user-b', 'lifted'],
  ] as const)('lifting by %s', (_label, denier, approver, outcome) => {
    const conv = conversation()
    recordDenial(conv, 'shell_exec', denier)

    expect(liftDenial(conv, 'shell_exec', approver)).toBe(outcome)
    expect(isDenied(conv, 'shell_exec')).toBe(outcome !== 'lifted')
  })

  it('reports a tool that was not denied', () => {
    expect(liftDenial(conversation(), 'shell_exec', 'user-a')).toBe('not_denied')
  })

  it('round-trips through the persisted JSON', () => {
    const conv = conversation()
    recordDenial(conv, 'shell_exec', 'user-a')
    recordDenial(conv, 'legacy_tool')

    const raw = serializeDenials(conv)

    expect(JSON.parse(raw)).toEqual([
      { tool: 'shell_exec', userId: 'user-a' },
      { tool: 'legacy_tool', userId: null },
    ])
    expect(parseDenials(raw, vi.fn())).toEqual(conv.denials)
  })

  it.each([
    ['truncated JSON', '{"tool":', 0],
    ['a non-array', '{"tool":"x"}', 0],
    ['an entry without a tool', '[{"userId":"u"},{"tool":"ok","userId":"u"}]', 1],
  ])('reports %s as unreadable', (_label, raw, kept) => {
    const onUnreadable = vi.fn()

    const denials = parseDenials(raw, onUnreadable)

    expect(onUnreadable).toHaveBeenCalled()
    expect(denials.size).toBe(kept)
  })

  it('reads NULL and an empty list as no denials, silently', () => {
    const onUnreadable = vi.fn()

    expect(parseDenials(null, onUnreadable).size).toBe(0)
    expect(parseDenials('[]', onUnreadable).size).toBe(0)
    expect(onUnreadable).not.toHaveBeenCalled()
  })
})
