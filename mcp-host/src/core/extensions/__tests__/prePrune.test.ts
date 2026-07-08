/**
 * T1.2 — Pre-pruning goldens.
 *
 * Covers the 7 test cases from
 * `.specs/mcp-hermes/implementation-plans/T1.2-pre-pruning.md` §8.
 * Plus two wiring tests: (a) `PressureContextManager` is bit-identical when
 * the master flag is off, (b) emits the savings event when the flag is on.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeFakeConversation } from '../../conversation/__testing__/makeFakeConversation'
import { validateToolLinkages } from '../../orchestration/toolUseLoop'
import { heuristicCount } from '../../tokenizer/heuristic'
import type { ChatMessage } from '../../types'
import { PressureContextManager } from '../contextManager'
import {
  DEFAULT_PRE_PRUNE_OPTIONS,
  canonicalize,
  computeProtectedTailStart,
  dedupToolResults,
  hash,
  jsonSafeTruncateArgs,
  oneLineSummaries,
  prePrune,
  stripHistoricalMedia,
} from '../prePrune'

// `protectedTailTurns: 0` means "no tail" so every message is candidate for
// pruning. Tests that exercise an individual pass use this to make
// assertions deterministic.
const NO_TAIL_OPTIONS = { ...DEFAULT_PRE_PRUNE_OPTIONS, protectedTailTurns: 0 }

function userMsg(content: string): ChatMessage {
  return { role: 'user', content }
}

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, name, arguments: args }],
  }
}

function toolResult(id: string, name: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: id, name, content }
}

describe('T1.2 prePrune — dedupToolResults', () => {
  it('§8.1 collapses identical tool outputs into back-references', () => {
    const messages: ChatMessage[] = [
      userMsg('list'),
      assistantToolCall('tc_1', 'ls', { path: '/' }),
      toolResult('tc_1', 'ls', 'file1\nfile2\nfile3'),
      userMsg('list again'),
      assistantToolCall('tc_2', 'ls', { path: '/' }),
      toolResult('tc_2', 'ls', 'file1\nfile2\nfile3'),
      userMsg('and again'),
      assistantToolCall('tc_3', 'ls', { path: '/' }),
      toolResult('tc_3', 'ls', 'file1\nfile2\nfile3'),
    ]

    const out = dedupToolResults(messages, messages.length)

    expect(out[2].content).toBe('file1\nfile2\nfile3')
    expect(out[5].content).toBe('[duplicate of tool_call_id=tc_1]')
    expect(out[8].content).toBe('[duplicate of tool_call_id=tc_1]')
    // Linkages must remain valid even when the dedup replaced content.
    expect(() => validateToolLinkages(out)).not.toThrow()
  })

  it('§8.2 canonicalizes JSON key order before hashing', () => {
    const messages: ChatMessage[] = [
      assistantToolCall('tc_1', 'get', {}),
      toolResult('tc_1', 'get', '{"a":1,"b":2}'),
      assistantToolCall('tc_2', 'get', {}),
      toolResult('tc_2', 'get', '{"b":2,"a":1}'),
    ]

    const out = dedupToolResults(messages, messages.length)

    // Two tool messages with logically-identical JSON but different key
    // order must collapse to the same back-reference.
    expect(out[3].content).toBe('[duplicate of tool_call_id=tc_1]')
    // And the canonicalize helper agrees they hash to the same value.
    expect(hash('{"a":1,"b":2}')).toBe(hash('{"b":2,"a":1}'))
    expect(canonicalize('{"a":1,"b":2}')).toBe(canonicalize('{"b":2,"a":1}'))
  })
})

describe('T1.2 prePrune — oneLineSummaries', () => {
  it('§8.3 replaces oversized tool outputs with a one-line summary', () => {
    // ~210 words → ~277 tokens (floor(210×1.3)+4). Comfortably above the
    // 200-token threshold.
    const longOutput = Array.from({ length: 210 }, () => 'lorem').join(' ')
    const messages: ChatMessage[] = [
      userMsg('q'),
      assistantToolCall('tc_1', 'shell_exec', { command: 'npm test' }),
      toolResult('tc_1', 'shell_exec', longOutput),
    ]

    const out = oneLineSummaries(messages, messages.length, 200)

    expect(out[2].content).toMatch(/^\[shell_exec\]/)
    expect(out[2].content).toMatch(/bytes$/)
    expect(out[2].tool_call_id).toBe('tc_1')
    // Original assistant.tool_calls untouched.
    expect(out[1].tool_calls).toEqual(messages[1].tool_calls)
    // Linkages remain valid.
    expect(() => validateToolLinkages(out)).not.toThrow()
    // Result is significantly smaller.
    expect(out[2].content.length).toBeLessThan(messages[2].content.length / 5)
  })

  it('skips already-deduped tool messages', () => {
    const longOutput = Array.from({ length: 210 }, () => 'x').join(' ')
    const messages: ChatMessage[] = [
      assistantToolCall('tc_1', 'shell_exec', { command: 'npm test' }),
      toolResult('tc_1', 'shell_exec', longOutput),
      assistantToolCall('tc_2', 'shell_exec', { command: 'npm test' }),
      toolResult('tc_2', 'shell_exec', longOutput),
    ]

    const deduped = dedupToolResults(messages, messages.length)
    const out = oneLineSummaries(deduped, deduped.length, 200)

    expect(out[3].content).toBe('[duplicate of tool_call_id=tc_1]')
    expect(out[1].content).toMatch(/^\[shell_exec\]/)
  })
})

describe('T1.2 prePrune — jsonSafeTruncateArgs', () => {
  it('§8.4 truncates oversized arguments while keeping JSON parseable', () => {
    const giantString = 'x'.repeat(8 * 1024)
    const messages: ChatMessage[] = [assistantToolCall('tc_1', 'write_file', { code: giantString })]

    const out = jsonSafeTruncateArgs(messages, messages.length, 4096)

    const tc = out[0].tool_calls![0]
    const serialized = JSON.stringify(tc.arguments)
    expect(serialized.length).toBeLessThanOrEqual(4096)
    expect(() => JSON.parse(serialized)).not.toThrow()
    expect(tc.name).toBe('write_file')
    expect(tc.id).toBe('tc_1')
    expect(String(tc.arguments.code)).toMatch(/chars omitted\)$/)
  })

  it('walks nested objects to find the longest string to trim', () => {
    const longString = 'a'.repeat(8 * 1024)
    const args = { meta: { note: 'tiny' }, payload: { body: longString } }
    const messages: ChatMessage[] = [assistantToolCall('tc_1', 'mcp__http__post', args)]

    const out = jsonSafeTruncateArgs(messages, messages.length, 4096)

    const tc = out[0].tool_calls![0]
    const newArgs = tc.arguments as { meta: { note: string }; payload: { body: string } }
    expect(newArgs.meta.note).toBe('tiny') // small fields untouched
    expect(newArgs.payload.body).toMatch(/chars omitted\)$/)
    expect(JSON.stringify(tc.arguments).length).toBeLessThanOrEqual(4096)
  })
})

describe('T1.2 prePrune — stripHistoricalMedia', () => {
  it('§8.5 redacts old image parts but preserves the latest user message intact', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'q1',
        contentParts: [{ type: 'image', mimeType: 'image/png', data: 'BASE64A' }],
      },
      { role: 'assistant', content: 'a1' },
      {
        role: 'user',
        content: 'q2',
        contentParts: [{ type: 'image', mimeType: 'image/png', data: 'BASE64B' }],
      },
    ]

    // protectedTailStart=2 corresponds to "protect the last 1 user turn" —
    // the last user message at index 2 is the live frame.
    const out = stripHistoricalMedia(messages, 2)

    expect(out[0].contentParts?.[0].type).toBe('text')
    expect((out[0].contentParts![0] as { text: string }).text).toMatch(/\[image redacted/)
    // Last user message untouched.
    expect(out[2].contentParts?.[0].type).toBe('image')
    expect((out[2].contentParts![0] as { data: string }).data).toBe('BASE64B')
  })

  it('is a no-op when there are no historical images', () => {
    const messages: ChatMessage[] = [userMsg('hello'), { role: 'assistant', content: 'hi' }]
    const out = stripHistoricalMedia(messages, 1)
    // Identity by reference — no allocation when nothing to do.
    expect(out).toBe(messages)
  })

  it('B3 regression — preserves images inside the protected tail (protectedTailTurns>1)', () => {
    // Three user turns with images. With protectedTailStart=2 (protect last
    // 2 user turns), images in turns 2 and 3 (indices 2 and 4) must survive.
    // Pre-B3 the function ignored protectedTailStart and only spared the
    // last user — turn 2's image would have been wrongly redacted.
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: 'q1',
        contentParts: [{ type: 'image', mimeType: 'image/png', data: 'OLD_IMG' }],
      },
      { role: 'assistant', content: 'a1' },
      {
        role: 'user',
        content: 'q2',
        contentParts: [{ type: 'image', mimeType: 'image/png', data: 'MID_IMG' }],
      },
      { role: 'assistant', content: 'a2' },
      {
        role: 'user',
        content: 'q3',
        contentParts: [{ type: 'image', mimeType: 'image/png', data: 'NEW_IMG' }],
      },
    ]

    const out = stripHistoricalMedia(messages, 2) // protect indices >= 2

    // Index 0 (outside the protected tail) → redacted.
    expect(out[0].contentParts?.[0].type).toBe('text')
    // Indices 2 and 4 are INSIDE the protected tail → preserved.
    expect(out[2].contentParts?.[0].type).toBe('image')
    expect((out[2].contentParts![0] as { data: string }).data).toBe('MID_IMG')
    expect(out[4].contentParts?.[0].type).toBe('image')
    expect((out[4].contentParts![0] as { data: string }).data).toBe('NEW_IMG')
  })
})

describe('T1.2 prePrune — protected tail', () => {
  it('computeProtectedTailStart counts user messages from the end', () => {
    const messages: ChatMessage[] = [
      userMsg('t1'),
      { role: 'assistant', content: 'a1' },
      userMsg('t2'),
      { role: 'assistant', content: 'a2' },
      userMsg('t3'),
      { role: 'assistant', content: 'a3' },
    ]

    expect(computeProtectedTailStart(messages, 1)).toBe(4) // last user
    expect(computeProtectedTailStart(messages, 2)).toBe(2) // 2nd-to-last user
    expect(computeProtectedTailStart(messages, 3)).toBe(0) // all is tail
    expect(computeProtectedTailStart(messages, 5)).toBe(0) // fewer turns
    expect(computeProtectedTailStart(messages, 0)).toBe(messages.length)
  })

  it('§8.6 prePrune does not touch messages inside the protected tail', () => {
    // 5 turns where every tool result is a literal duplicate. With
    // protectedTailTurns=3 only the first 2 turns are eligible.
    const sameOutput = 'list output\nfile1\nfile2'
    const messages: ChatMessage[] = []
    for (let i = 1; i <= 5; i++) {
      messages.push(userMsg(`turn ${i}`))
      messages.push(assistantToolCall(`tc_${i}`, 'ls', { path: '/' }))
      messages.push(toolResult(`tc_${i}`, 'ls', sameOutput))
    }

    const opts = { ...DEFAULT_PRE_PRUNE_OPTIONS, protectedTailTurns: 3 }
    const { messages: out } = prePrune(messages, opts)

    // First-occurrence (turn 1) is the canonical, turn 2 is deduped, turns
    // 3-5 are inside the tail and remain intact.
    expect(out[2].content).toBe(sameOutput)
    expect(out[5].content).toBe('[duplicate of tool_call_id=tc_1]')
    expect(out[8].content).toBe(sameOutput) // turn 3 — inside tail
    expect(out[11].content).toBe(sameOutput) // turn 4 — inside tail
    expect(out[14].content).toBe(sameOutput) // turn 5 — inside tail
    expect(() => validateToolLinkages(out)).not.toThrow()
  })
})

describe('T1.2 prePrune — composed savings (§8.7)', () => {
  it('reaches 30%+ reduction on a realistic tool-heavy fixture', () => {
    // Port of plan §8.7: 3 fs listings + 2 package.json reads + 2 npm-test
    // runs, all duplicates. Each output ~1000+ chars to dominate the heuristic.
    const fsListing = ['src/', 'package.json', 'README.md', 'tsconfig.json']
      .flatMap(name => Array.from({ length: 30 }, (_, i) => `${name}-entry-${i}.ts`))
      .join('\n')
    const pkgJson = JSON.stringify(
      {
        name: 'demo',
        dependencies: Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [`dep-${i}`, '^1.0.0'])
        ),
      },
      null,
      2
    )
    const npmTestLog = Array.from({ length: 220 }, (_, i) => `  ✔ test case ${i} passed`).join('\n')

    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }]

    // 3 fs listings
    for (let i = 1; i <= 3; i++) {
      messages.push(userMsg(`list filesystem ${i}`))
      messages.push(assistantToolCall(`fs_${i}`, 'shell_exec', { command: 'ls -R' }))
      messages.push(toolResult(`fs_${i}`, 'shell_exec', fsListing))
    }
    // 2 package.json reads
    for (let i = 1; i <= 2; i++) {
      messages.push(userMsg(`read package.json ${i}`))
      messages.push(assistantToolCall(`pkg_${i}`, 'shell_exec', { command: 'cat package.json' }))
      messages.push(toolResult(`pkg_${i}`, 'shell_exec', pkgJson))
    }
    // 2 npm-test runs
    for (let i = 1; i <= 2; i++) {
      messages.push(userMsg(`run tests ${i}`))
      messages.push(assistantToolCall(`npm_${i}`, 'shell_exec', { command: 'npm test' }))
      messages.push(toolResult(`npm_${i}`, 'shell_exec', npmTestLog))
    }
    // One final user turn so the tail anchor doesn't swallow everything.
    messages.push(userMsg('done?'))

    const pre = heuristicCount(messages)
    const { messages: out, postTokens } = prePrune(messages, NO_TAIL_OPTIONS)

    expect(() => validateToolLinkages(out)).not.toThrow()
    const reduction = (pre - postTokens) / pre
    expect(reduction).toBeGreaterThanOrEqual(0.3)
  })
})

describe('T1.2 wiring — PressureContextManager', () => {
  it('is bit-identical when prePruneEnabled=false (zero-regression)', async () => {
    const messages = buildPressureFixture()
    const conv = makeFakeConversation()
    const manager = new PressureContextManager(
      4_000,
      undefined,
      undefined,
      undefined,
      {} // no prePruneEnabled, no events
    )
    const out = await manager.manage(messages.slice(), conv)
    const baseline = await new PressureContextManager(4_000).manage(messages.slice(), conv)
    expect(out).toEqual(baseline)
  })

  it('emits compaction:pre_prune_executed when a pass mutated the messages', async () => {
    const messages = buildPressureFixtureWithDuplicates()
    const conv = makeFakeConversation()
    const emit = vi.fn()
    const manager = new PressureContextManager(800, undefined, undefined, undefined, {
      prePruneEnabled: true,
      prePruneOptions: { ...DEFAULT_PRE_PRUNE_OPTIONS, protectedTailTurns: 0 },
      events: { emit, on: vi.fn(), off: vi.fn() },
    })

    await manager.manage(messages, conv)

    const prePruneEvents = emit.mock.calls.filter(
      ([ev]) => (ev as { type: string }).type === 'compaction:pre_prune_executed'
    )
    expect(prePruneEvents.length).toBeGreaterThanOrEqual(1)
    const payload = prePruneEvents[0][0] as { data: Record<string, unknown> }
    expect(payload.data.savingsTokens).toBeGreaterThan(0)
    expect(payload.data.passesApplied).toEqual(expect.arrayContaining(['dedup']))
  })
})

function buildPressureFixture(): ChatMessage[] {
  const padContent = Array.from({ length: 100 }, () => 'lorem ipsum dolor sit amet').join(' ')
  const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
  for (let i = 0; i < 10; i++) {
    msgs.push(userMsg(`q${i}`))
    msgs.push({ role: 'assistant', content: padContent })
  }
  return msgs
}

function buildPressureFixtureWithDuplicates(): ChatMessage[] {
  // Each tool result has ~400 words → ~524 tokens. 4 duplicate results push
  // the heuristic well above the 800-token budget so pressure ≥ 0.8 and
  // pre-prune fires.
  const sameOutput = Array.from({ length: 400 }, (_, i) => `entry-${i}`).join(' ')
  const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
  for (let i = 1; i <= 4; i++) {
    msgs.push(userMsg(`q${i}`))
    msgs.push(assistantToolCall(`tc_${i}`, 'ls', { path: '/' }))
    msgs.push(toolResult(`tc_${i}`, 'ls', sameOutput))
  }
  return msgs
}
