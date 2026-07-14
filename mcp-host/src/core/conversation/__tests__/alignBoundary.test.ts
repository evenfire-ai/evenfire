import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../types'
import {
  alignBoundary,
  applyAlignedCut,
  findLastUserIndex,
  turnIndexToMessageIndex,
} from '../compaction'

/**
 * Note on fixtures: many tests below append an extra `user + assistant`
 * "tail" turn at the end. That keeps `lastUserIdx` >= proposedCut so the
 * anchor (Rule 3) doesn't override the cut we're trying to test. To
 * verify each rule in isolation you have to keep the last user out of
 * the archived range.
 */

describe('alignBoundary — backward (Rule 1)', () => {
  it('walks back when the cut splits an assistant.tool_calls / tool pair', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'old task' }, // 0
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_x', name: 'shell', arguments: {} }],
      }, // 1
      { role: 'tool', content: 'ok', tool_call_id: 'tc_x' }, // 2
      { role: 'assistant', content: 'done' }, // 3
      { role: 'user', content: 'active task' }, // 4 — last user, anchor safe
      { role: 'assistant', content: 'working' }, // 5
    ]

    // cut=2 would archive the lead and leave the tool orphaned in kept.
    // Backward pulls cut to 1 so the pair stays paired.
    expect(alignBoundary(messages, 2)).toBe(1)
  })

  it('walks back through a multi-tool group when one tool straddles the cut', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'old' }, // 0
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'tc_a', name: 'a', arguments: {} },
          { id: 'tc_b', name: 'b', arguments: {} },
        ],
      }, // 1
      { role: 'tool', content: 'a-result', tool_call_id: 'tc_a' }, // 2
      { role: 'tool', content: 'b-result', tool_call_id: 'tc_b' }, // 3
      { role: 'assistant', content: 'done' }, // 4
      { role: 'user', content: 'next' }, // 5 — last user, anchor safe
      { role: 'assistant', content: 'ok' }, // 6
    ]

    // cut=3 splits the multi-tool group. Both (1a) and (1b) fire until
    // the entire lead/tools group lives on the kept side.
    expect(alignBoundary(messages, 3)).toBe(1)
  })

  it('Golden A (plan §7.1) — orphan tool + last-user anchor combined', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first task' }, // 0
      { role: 'assistant', content: 'doing it' }, // 1
      { role: 'user', content: 'next task' }, // 2 — last user
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_a', name: 'shell', arguments: {} }],
      }, // 3
      { role: 'tool', content: 'ok', tool_call_id: 'tc_a' }, // 4
      { role: 'assistant', content: 'done' }, // 5
    ]

    // proposedCut=4 splits the pair → backward pulls to 3. The anchor then
    // notices the last user at idx 2 is still being archived → cut=2.
    expect(alignBoundary(messages, 4)).toBe(2)
  })
})

describe('alignBoundary — forward (Rule 2)', () => {
  it('Golden B (plan §7.2) — assistant.tool_calls with no matching tool advances past', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q' }, // 0
      { role: 'assistant', content: 'thinking' }, // 1
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'orphan', name: 'x', arguments: {} }],
      }, // 2 — orphan lead (call cancelled)
      { role: 'user', content: 'never mind' }, // 3 — last user, anchor safe
      { role: 'assistant', content: 'ok' }, // 4
    ]

    // cut=2 would keep the orphan lead in kept. Forward advances past it.
    expect(alignBoundary(messages, 2)).toBe(3)
  })

  it('does NOT push forward when the lead has matching results in kept', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'old' }, // 0
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_a', name: 'x', arguments: {} }],
      }, // 1
      { role: 'tool', content: 'ok', tool_call_id: 'tc_a' }, // 2
      { role: 'user', content: 'next' }, // 3 — last user, anchor safe
      { role: 'assistant', content: 'r' }, // 4
    ]

    // cut=1 keeps [lead, tool, user, assistant]. The pair is intact in
    // kept; lead is NOT orphan-anywhere → no forward push.
    expect(alignBoundary(messages, 1)).toBe(1)
  })
})

describe('alignBoundary — last-user anchor (Rule 3)', () => {
  it('Golden C (plan §7.3) — would-archive last user message is forced into kept', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'old task 1' }, // 0
      { role: 'assistant', content: 'r1' }, // 1
      { role: 'user', content: 'old task 2' }, // 2
      { role: 'assistant', content: 'r2' }, // 3
      { role: 'user', content: 'ACTIVE TASK' }, // 4 — must survive
      { role: 'assistant', content: 'working...' }, // 5
    ]

    expect(alignBoundary(messages, 5)).toBe(4)
  })

  it('leaves the cut alone when the last user is already in kept', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'old' }, // 0
      { role: 'assistant', content: 'r' }, // 1
      { role: 'user', content: 'active' }, // 2 — last user, in kept
      { role: 'assistant', content: 'r2' }, // 3
    ]
    expect(alignBoundary(messages, 2)).toBe(2)
  })

  it('does nothing when there are no user messages (cron-style trigger)', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'autonomous output' },
      { role: 'assistant', content: 'more output' },
    ]
    expect(alignBoundary(messages, 1)).toBe(1)
    expect(findLastUserIndex(messages)).toBe(-1)
  })
})

describe('alignBoundary — edge cases', () => {
  it('clamps proposedCut to [0, len]', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' },
    ]
    expect(alignBoundary(messages, -5)).toBe(0)
    // cut=10 clamps to 2; anchor pulls last user (idx 0) into kept.
    expect(alignBoundary(messages, 10)).toBe(0)
  })

  it('handles an empty array', () => {
    expect(alignBoundary([], 0)).toBe(0)
    expect(alignBoundary([], 5)).toBe(0)
  })

  it('cut=0 stays at 0 (everything kept)', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]
    expect(alignBoundary(messages, 0)).toBe(0)
  })
})

describe('applyAlignedCut', () => {
  it('Golden D (plan §7.4) — chained with anchor produces a linkage-safe kept set', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'doing it' },
      { role: 'user', content: 'next task' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'tc_a', name: 'shell', arguments: {} }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'tc_a' },
      { role: 'assistant', content: 'done' },
    ]

    const { kept, archived } = applyAlignedCut([], messages, 4)

    // cut aligned to 2 (Rule 1: 4 → 3, then Rule 3 anchor: 3 → 2).
    // archived = [u 'first task', a 'doing it']
    // kept    = [u 'next task', lead, tool, a 'done']
    expect(archived).toHaveLength(2)
    expect(kept).toHaveLength(4)
    expect(kept[0].role).toBe('user')
    expect(kept[0].content).toBe('next task')
    expect(kept[1].role).toBe('assistant')
    expect(kept[1].tool_calls).toBeDefined()
    expect(kept[2].role).toBe('tool')
    expect(kept[2].tool_call_id).toBe('tc_a')
  })

  it('prepends systemMsgs to the kept tail', () => {
    const system: ChatMessage[] = [{ role: 'system', content: 'You are X.' }]
    const nonSystem: ChatMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]
    const { kept } = applyAlignedCut(system, nonSystem, 1)
    // anchor pulls cut to 0 (last user is at idx 0).
    expect(kept[0]).toEqual(system[0])
    expect(kept).toHaveLength(3)
  })
})

describe('turnIndexToMessageIndex', () => {
  it('maps turn boundaries to flat message indices', () => {
    const turns: ChatMessage[][] = [
      [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
      ],
      [
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2' },
        { role: 'tool', content: 't', tool_call_id: 'x' },
      ],
      [{ role: 'user', content: 'q3' }],
    ]
    expect(turnIndexToMessageIndex(turns, 0)).toBe(0)
    expect(turnIndexToMessageIndex(turns, 1)).toBe(2)
    expect(turnIndexToMessageIndex(turns, 2)).toBe(5)
    expect(turnIndexToMessageIndex(turns, 3)).toBe(6)
  })

  it('clamps out-of-range indices', () => {
    const turns: ChatMessage[][] = [[{ role: 'user', content: 'q' }]]
    expect(turnIndexToMessageIndex(turns, -1)).toBe(0)
    expect(turnIndexToMessageIndex(turns, 99)).toBe(1)
  })
})
