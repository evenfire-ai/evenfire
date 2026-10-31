import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  clearComposerDraft,
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
} from '../composerDraftStore'

type Operation =
  | { kind: 'write'; tabId: 'tab-a' | 'tab-b'; value: string }
  | { kind: 'clear'; tabId: 'tab-a' | 'tab-b' }
  | { kind: 'read'; tabId: 'tab-a' | 'tab-b' }

const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  fc.record({
    kind: fc.constant<'write'>('write'),
    tabId: fc.constantFrom<'tab-a' | 'tab-b'>('tab-a', 'tab-b'),
    value: fc.string({ minLength: 1, maxLength: 24 }),
  }),
  fc.record({
    kind: fc.constant<'clear'>('clear'),
    tabId: fc.constantFrom<'tab-a' | 'tab-b'>('tab-a', 'tab-b'),
  }),
  fc.record({
    kind: fc.constant<'read'>('read'),
    tabId: fc.constantFrom<'tab-a' | 'tab-b'>('tab-a', 'tab-b'),
  })
)

describe('New Chat draft tab ownership against the owner-directed reference model', () => {
  afterEach(() => resetComposerDraftStore())

  it('keeps each blank-chat tab independently writable, readable, and clearable', () => {
    fc.assert(
      fc.property(fc.array(operationArbitrary, { minLength: 1, maxLength: 40 }), operations => {
        resetComposerDraftStore()
        const reference = new Map<'tab-a' | 'tab-b', string>()
        for (const operation of operations) {
          if (operation.kind === 'write') {
            // The contract grants each New Chat tab its own slot; no tab may
            // acquire another tab's slot merely because the selected agent matches.
            expect(setComposerDraft(null, operation.value, 'agent-same', operation.tabId)).toBe(
              true
            )
            reference.set(operation.tabId, operation.value)
          } else if (operation.kind === 'clear') {
            const tabHadDraft = reference.has(operation.tabId)
            const cleared = clearComposerDraft(null, 'agent-same', operation.tabId)
            if (tabHadDraft) expect(cleared).toBe(true)
            reference.delete(operation.tabId)
          } else {
            expect(getComposerDraft(null, 'agent-same', operation.tabId)).toBe(
              reference.get(operation.tabId) ?? ''
            )
          }
          expect(getComposerDraft(null, 'agent-same', 'tab-a')).toBe(reference.get('tab-a') ?? '')
          expect(getComposerDraft(null, 'agent-same', 'tab-b')).toBe(reference.get('tab-b') ?? '')
        }
      }),
      { numRuns: 100 }
    )
  })

  it('isolates the legacy tab-less slot from workspace-tab drafts', () => {
    resetComposerDraftStore()
    expect(setComposerDraft(null, 'legacy', 'agent-same')).toBe(true)
    expect(getComposerDraft(null, 'agent-same')).toBe('legacy')
    expect(getComposerDraft(null, 'agent-same', 'tab-a')).toBe('')
    expect(setComposerDraft(null, 'tab draft', 'agent-same', 'tab-a')).toBe(true)
    expect(getComposerDraft(null, 'agent-same')).toBe('legacy')
    expect(getComposerDraft(null, 'agent-same', 'tab-a')).toBe('tab draft')
    expect(clearComposerDraft(null, 'agent-same', 'tab-a')).toBe(true)
    expect(getComposerDraft(null, 'agent-same')).toBe('legacy')
  })
})
