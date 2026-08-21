/**
 * Boundary pipeline tests (spec §2, §4). Drives `createGuardrailBoundary` with a
 * fake `Contributors` so the pipeline is exercised without a real lane.
 */
import { describe, expect, it, vi } from 'vitest'
import { createGuardrailBoundary } from '../boundary'
import type { Contributor, Contributors, Decision } from '../types'

type I = { v: string }
type R = string

function contribs(list: Array<Contributor<I, R>>): Contributors<I, R, unknown> {
  return {
    pre: async () => list,
    post: async () => [],
  }
}

function one(decision: Decision, sourceId = 's', reasonCode = 'r'): Contributor<I, R> {
  return { phase: 'pre', source: 'host_rule', sourceId, decision, reasonCode }
}

const identity = {}

describe('GuardrailBoundary pipeline', () => {
  it('allow → executes at-most-once and returns the result (§2)', async () => {
    const execute = vi.fn(async (inp: I) => `ran:${inp.v}`)
    const b = createGuardrailBoundary<I, R, unknown>({
      lane: 'tool',
      hasRules: true,
      contributors: contribs([one('allow')]),
    })
    const out = await b.guard({ identity, input: { v: 'x' }, execute })
    expect(out).toEqual({ kind: 'executed', result: 'ran:x' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('deny blocks execution (§3)', async () => {
    const execute = vi.fn(async () => 'ran')
    const b = createGuardrailBoundary<I, R, unknown>({
      lane: 'tool',
      hasRules: true,
      contributors: contribs([one('allow', 'a'), one('deny', 'b', 'blocked')]),
    })
    const out = await b.guard({ identity, input: { v: 'x' }, execute })
    expect(out).toEqual({ kind: 'denied', reasonCode: 'blocked' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('ask does not execute; caller routes to approval (§6.3)', async () => {
    const execute = vi.fn(async () => 'ran')
    const b = createGuardrailBoundary<I, R, unknown>({
      lane: 'tool',
      hasRules: true,
      contributors: contribs([one('ask', 'a', 'confirm')]),
    })
    const out = await b.guard({ identity, input: { v: 'x' }, execute })
    expect(out).toEqual({ kind: 'ask', reasonCode: 'confirm' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('no contributions + hasRules → unmatched default ask (§3)', async () => {
    const b = createGuardrailBoundary<I, R, unknown>({
      lane: 'tool',
      hasRules: true,
      contributors: contribs([]),
    })
    const out = await b.guard({ identity, input: { v: 'x' }, execute: async () => 'ran' })
    expect(out.kind).toBe('ask')
  })

  it('no contributions + no rules → no_decision proceeds (§3, no-config compat)', async () => {
    const execute = vi.fn(async () => 'ran')
    const b = createGuardrailBoundary<I, R, unknown>({
      lane: 'tool',
      hasRules: false,
      contributors: contribs([]),
    })
    const out = await b.guard({ identity, input: { v: 'x' }, execute })
    expect(out).toEqual({ kind: 'executed', result: 'ran' })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  describe('rewrite re-aggregation (§4.1 / F8)', () => {
    it('a pre rewrite restarts the chain; a rule sees the rewritten input', async () => {
      // A deny rule fires only while v==="bad"; a hook sanitizes bad→safe. After
      // the rewrite the deny re-evaluates the FINAL input ('safe') and no longer
      // fires — so a rewrite that sanitizes a bad input is honored (spec §4.1).
      const dynamic: Contributors<I, R, unknown> = {
        pre: async input => {
          if (input.v === 'bad') {
            return [
              {
                phase: 'pre',
                source: 'host_rule',
                sourceId: 'denyBad',
                decision: 'deny',
                reasonCode: 'bad',
              },
              {
                phase: 'pre',
                source: 'hook',
                sourceId: 'fix',
                decision: 'allow',
                reasonCode: 'fixed',
                rewrite: { v: 'safe' },
              },
            ]
          }
          return [
            {
              phase: 'pre',
              source: 'host_rule',
              sourceId: 'ok',
              decision: 'allow',
              reasonCode: 'ok',
            },
          ]
        },
        post: async () => [],
      }
      const execute = vi.fn(async (inp: I) => `ran:${inp.v}`)
      const b = createGuardrailBoundary<I, R, unknown>({
        lane: 'tool',
        hasRules: true,
        contributors: dynamic,
      })
      const out = await b.guard({ identity, input: { v: 'bad' }, execute })
      // The deny saw the FINAL input ('safe'), so it did not fire → executed on 'safe'.
      expect(out).toEqual({ kind: 'executed', result: 'ran:safe' })
      expect(execute).toHaveBeenCalledWith({ v: 'safe' })
    })

    it('honors each source rewrite at most once (terminates)', async () => {
      // A contributor that always emits a rewrite would loop forever without the
      // at-most-once-per-source guard.
      const looping: Contributors<I, R, unknown> = {
        pre: async input => [
          {
            phase: 'pre',
            source: 'hook',
            sourceId: 'loop',
            decision: 'allow',
            reasonCode: 'r',
            rewrite: { v: input.v + '!' },
          },
        ],
        post: async () => [],
      }
      const b = createGuardrailBoundary<I, R, unknown>({
        lane: 'tool',
        hasRules: true,
        contributors: looping,
      })
      const out = await b.guard({ identity, input: { v: 'a' }, execute: async i => `ran:${i.v}` })
      // Applied exactly once → 'a!'.
      expect(out).toEqual({ kind: 'executed', result: 'ran:a!' })
    })
  })
})
