import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  agentDisplayLabels,
  sessionDisplayLabels,
  sessionPresentationKey,
} from '../agentDisplayLabels'

describe('final agent presentation identity', () => {
  it('reserves legitimate names that impersonate generated labels (R3-M1)', () => {
    const names = {
      'support-staging': 'Customer Support',
      support: 'Customer Support',
      'support-production': 'Customer Support (support-staging)',
    }
    const labels = agentDisplayLabels(Object.keys(names), names)
    expect(new Set(Object.values(labels)).size).toBe(3)
    expect(labels['support-production']).toBe(names['support-production'])
    expect(labels['support-staging']).toContain('support-staging')
  })

  it('keeps unique names concise and protects missing-catalog fallbacks', () => {
    expect(agentDisplayLabels(['a', 'b'], { a: 'Friendly' })).toEqual({ a: 'Friendly', b: 'b' })
    const labels = agentDisplayLabels(['a', 'b', 'c'], { a: 'b', c: 'b (b)' })
    expect(new Set(Object.values(labels)).size).toBe(3)
    expect(labels.c).toBe('b (b)')
    expect(agentDisplayLabels(['constructor', '__proto__', 'toString'], {})).toEqual({
      constructor: 'constructor',
      ['__proto__']: '__proto__',
      toString: 'toString',
    })
  })

  it('is stable under input ordering and bounded for adversarial reserved names', () => {
    const names = { a: 'X', b: 'X', c: 'X (a)', d: 'X (a; 2)', e: 'X (a; 3)' }
    const refs = Object.keys(names)
    const labels = agentDisplayLabels(refs, names)
    expect(new Set(Object.values(labels)).size).toBe(refs.length)
    expect(agentDisplayLabels([...refs].reverse(), names)).toEqual(labels)
  })

  it('keeps final labels distinct for arbitrary valid text and identity characters', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ maxLength: 30 }), { minLength: 1, maxLength: 20 }),
        fc.array(fc.string({ maxLength: 30 }), { minLength: 1, maxLength: 5 }),
        (refs, displayNames) => {
          const names = Object.fromEntries(
            refs.map((ref, index) => [ref, displayNames[index % displayNames.length]!])
          )
          const labels = agentDisplayLabels(refs, names)
          expect(new Set(Object.values(labels)).size).toBe(refs.length)
          expect(agentDisplayLabels([...refs].reverse(), names)).toEqual(labels)
        }
      ),
      { numRuns: 200 }
    )
  })
})

describe('final composed session presentation', () => {
  it('reserves original titles before composing duplicate-title accessible names', () => {
    const sessions = [
      { agentRef: 'support', id: 'chat-1', title: 'Task' },
      { agentRef: 'support', id: 'chat-2', title: 'Task' },
      { agentRef: 'other', id: 'chat-3', title: 'Task (Support · chat-1)' },
    ]
    const labels = sessionDisplayLabels(sessions, { support: 'Support', other: 'Other' })
    expect(new Set(Object.values(labels).map(item => item.label)).size).toBe(3)
    expect(labels[sessionPresentationKey('other', 'chat-3')]!.label).toBe(sessions[2]!.title)
    expect(labels[sessionPresentationKey('support', 'chat-1')]!.secondary).toBe(
      'Support · chat-1; 2'
    )
    expect(
      sessionDisplayLabels([...sessions].reverse(), { support: 'Support', other: 'Other' })
    ).toEqual(labels)
  })

  it('retains concise unique titles and makes arbitrary composed names unique', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(fc.string({ maxLength: 10 }), fc.string({ maxLength: 10 })), {
          minLength: 1,
          maxLength: 15,
          selector: pair => JSON.stringify(pair),
        }),
        fc.array(fc.string({ maxLength: 20 }), { minLength: 1, maxLength: 3 }),
        (identities, titles) => {
          const sessions = identities.map(([agentRef, id], index) => ({
            agentRef,
            id,
            title: titles[index % titles.length]!,
          }))
          const labels = sessionDisplayLabels(sessions, {})
          expect(new Set(Object.values(labels).map(item => item.label)).size).toBe(sessions.length)
          expect(sessionDisplayLabels([...sessions].reverse(), {})).toEqual(labels)
        }
      ),
      { numRuns: 200 }
    )
    expect(
      sessionDisplayLabels([{ agentRef: 'missing', id: 'id', title: 'Ordinary' }], {})
    ).toEqual({
      [sessionPresentationKey('missing', 'id')]: { label: 'Ordinary', secondary: 'missing' },
    })
  })
})
