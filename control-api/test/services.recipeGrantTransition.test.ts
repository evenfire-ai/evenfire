import { describe, expect, it } from 'vitest'
import { resolveRecipeGrantTransition } from '../src/services/recipeGrantTransition.js'

const ALIAS = 'clerum.io/codex-connection-ref'
const CANONICAL = 'clerum.io/subscription-connection-ref'

const CODEX_SPEC = { agent: { provider: 'codex-subscription', model: 'gpt-5.1' } }
const GROK_SPEC = { agent: { provider: 'grok-subscription', model: 'grok-4.6' } }
const GROK_STEP_SPEC = {
  agent: { provider: 'openai', model: 'gpt-5.1' },
  steps: [{ id: 's', agent: { provider: 'grok-subscription', model: 'grok-4.6' } }],
}
const STATIC_SPEC = { agent: { provider: 'openai', model: 'gpt-5.1' } }
const SDK_STATIC_SPEC = {
  pluginWorkloadSdk: { promptBridge: { allowedModels: ['gpt-5.3-codex'] } },
  workloads: [{ id: 'svc', type: 'deployment', image: 'svc:latest' }],
}

function body(spec: Record<string, unknown>, annotations?: Record<string, unknown>) {
  return { spec, ...(annotations ? { metadata: { annotations } } : {}) }
}

function rules(result: ReturnType<typeof resolveRecipeGrantTransition>): string[] {
  return result.ok ? [] : result.errors.map(error => error.rule ?? '')
}

describe('resolveRecipeGrantTransition', () => {
  describe('alias/canonical disagreement', () => {
    it.each([
      ['Codex', CODEX_SPEC],
      ['Grok', GROK_SPEC],
      ['static', STATIC_SPEC],
      ['SDK static', SDK_STATIC_SPEC],
    ])('rejects non-empty unequal annotations on a %s spec without throwing', (_label, spec) => {
      const input = body(spec, { [ALIAS]: 'a', [CANONICAL]: 'b' })
      expect(() => resolveRecipeGrantTransition({ body: input })).not.toThrow()
      expect(rules(resolveRecipeGrantTransition({ body: input }))).toEqual([
        'subscriptionAnnotationsDisagree',
      ])
      expect(
        rules(
          resolveRecipeGrantTransition({
            body: input,
            current: { spec: STATIC_SPEC, annotations: {} },
          })
        )
      ).toEqual(['subscriptionAnnotationsDisagree'])
    })
  })

  describe('create / validate (no stored recipe)', () => {
    it('requires a grant when a broker recipe omits annotations', () => {
      expect(rules(resolveRecipeGrantTransition({ body: body(CODEX_SPEC) }))).toEqual([
        'codexRecipeGrantRequired',
      ])
      expect(rules(resolveRecipeGrantTransition({ body: body(GROK_STEP_SPEC) }))).toEqual([
        'grokRecipeGrantRequired',
      ])
    })

    it('writes the Codex shape for alias-only and canonical-only Codex writers', () => {
      expect(
        resolveRecipeGrantTransition({ body: body(CODEX_SPEC, { [ALIAS]: 'team-plus' }) })
      ).toEqual({ ok: true, annotations: { [ALIAS]: 'team-plus', [CANONICAL]: 'team-plus' } })
      expect(
        resolveRecipeGrantTransition({ body: body(CODEX_SPEC, { [CANONICAL]: 'team-a' }) })
      ).toEqual({ ok: true, annotations: { [ALIAS]: 'team-a', [CANONICAL]: 'team-a' } })
    })

    it('writes the Grok shape and rejects a Codex alias on a Grok recipe', () => {
      expect(
        resolveRecipeGrantTransition({
          body: body(GROK_SPEC, { [ALIAS]: '', [CANONICAL]: 'team-grok' }),
        })
      ).toEqual({ ok: true, annotations: { [ALIAS]: '', [CANONICAL]: 'team-grok' } })
      expect(
        rules(
          resolveRecipeGrantTransition({
            body: body(GROK_SPEC, { [ALIAS]: 'team-grok', [CANONICAL]: 'team-grok' }),
          })
        )
      ).toEqual(['subscriptionAnnotationsDisagree'])
    })

    it('rejects explicit unassigned and malformed keys', () => {
      expect(
        rules(resolveRecipeGrantTransition({ body: body(CODEX_SPEC, { [ALIAS]: 'unassigned' }) }))
      ).toEqual(['codexRecipeGrantRequired'])
      expect(
        rules(
          resolveRecipeGrantTransition({ body: body(CODEX_SPEC, { [ALIAS]: '', [CANONICAL]: '' }) })
        )
      ).toEqual(['codexRecipeGrantRequired'])
      expect(
        rules(resolveRecipeGrantTransition({ body: body(CODEX_SPEC, { [ALIAS]: 'Bad_Key' }) }))
      ).toEqual(['codexRecipeGrantInvalid'])
      expect(
        rules(resolveRecipeGrantTransition({ body: body(GROK_SPEC, { [CANONICAL]: '' }) }))
      ).toEqual(['grokRecipeGrantRequired'])
      expect(
        rules(resolveRecipeGrantTransition({ body: body(GROK_SPEC, { [CANONICAL]: 'Bad_Key' }) }))
      ).toEqual(['grokRecipeGrantInvalid'])
    })

    it('never writes grant annotations for a static recipe', () => {
      expect(
        resolveRecipeGrantTransition({ body: body(STATIC_SPEC, { [ALIAS]: '', [CANONICAL]: '' }) })
      ).toEqual({ ok: true, annotations: {} })
      expect(
        resolveRecipeGrantTransition({ body: body(SDK_STATIC_SPEC, { [ALIAS]: 'team-plus' }) })
      ).toEqual({ ok: true, annotations: {} })
    })
  })

  describe('same broker update', () => {
    const codexStored = { [ALIAS]: 'team-plus', [CANONICAL]: 'team-plus' }
    const grokStored = { [ALIAS]: '', [CANONICAL]: 'team-grok' }

    it('keeps the stored grant when annotations are omitted', () => {
      expect(
        resolveRecipeGrantTransition({
          body: body(CODEX_SPEC),
          current: { spec: CODEX_SPEC, annotations: codexStored },
        })
      ).toEqual({ ok: true, annotations: {} })
      expect(
        resolveRecipeGrantTransition({
          body: body(GROK_SPEC),
          current: { spec: GROK_SPEC, annotations: grokStored },
        })
      ).toEqual({ ok: true, annotations: {} })
    })

    it('rewrites an explicit same-broker grant in that broker shape', () => {
      expect(
        resolveRecipeGrantTransition({
          body: body(CODEX_SPEC, { [ALIAS]: 'personal-pro', [CANONICAL]: 'personal-pro' }),
          current: { spec: CODEX_SPEC, annotations: codexStored },
        })
      ).toEqual({ ok: true, annotations: { [ALIAS]: 'personal-pro', [CANONICAL]: 'personal-pro' } })
      expect(
        resolveRecipeGrantTransition({
          body: body(GROK_SPEC, { [CANONICAL]: 'other-grok' }),
          current: { spec: GROK_SPEC, annotations: grokStored },
        })
      ).toEqual({ ok: true, annotations: { [ALIAS]: '', [CANONICAL]: 'other-grok' } })
    })

    it('rejects an explicit same-broker clear', () => {
      expect(
        rules(
          resolveRecipeGrantTransition({
            body: body(CODEX_SPEC, { [ALIAS]: '', [CANONICAL]: '' }),
            current: { spec: CODEX_SPEC, annotations: codexStored },
          })
        )
      ).toEqual(['codexRecipeGrantRequired'])
    })
  })

  describe('broker change', () => {
    it('Codex→Grok with omitted annotations requires an explicit grant', () => {
      expect(
        rules(
          resolveRecipeGrantTransition({
            body: body(GROK_SPEC),
            current: {
              spec: CODEX_SPEC,
              annotations: { [ALIAS]: 'team-plus', [CANONICAL]: 'team-plus' },
            },
          })
        )
      ).toEqual(['providerChangeRequiresGrant'])
    })

    it('Codex→Grok explicit canonical writes the Grok shape (alias cleared)', () => {
      expect(
        resolveRecipeGrantTransition({
          body: body(GROK_SPEC, { [CANONICAL]: 'team-grok' }),
          current: {
            spec: CODEX_SPEC,
            annotations: { [ALIAS]: 'team-plus', [CANONICAL]: 'team-plus' },
          },
        })
      ).toEqual({ ok: true, annotations: { [ALIAS]: '', [CANONICAL]: 'team-grok' } })
    })

    it('Codex→Grok explicit non-empty alias is rejected', () => {
      expect(
        rules(
          resolveRecipeGrantTransition({
            body: body(GROK_SPEC, { [ALIAS]: 'team-plus' }),
            current: {
              spec: CODEX_SPEC,
              annotations: { [ALIAS]: 'team-plus', [CANONICAL]: 'team-plus' },
            },
          })
        )
      ).toEqual(['subscriptionAnnotationsDisagree'])
    })

    it('Grok→Codex with omitted annotations requires an explicit grant', () => {
      expect(
        rules(
          resolveRecipeGrantTransition({
            body: body(CODEX_SPEC),
            current: { spec: GROK_SPEC, annotations: { [ALIAS]: '', [CANONICAL]: 'team-grok' } },
          })
        )
      ).toEqual(['providerChangeRequiresGrant'])
    })

    it('Grok→Codex canonical-only writes the Codex shape instead of clearing', () => {
      expect(
        resolveRecipeGrantTransition({
          body: body(CODEX_SPEC, { [CANONICAL]: 'team-codex' }),
          current: { spec: GROK_SPEC, annotations: { [ALIAS]: '', [CANONICAL]: 'team-grok' } },
        })
      ).toEqual({ ok: true, annotations: { [ALIAS]: 'team-codex', [CANONICAL]: 'team-codex' } })
    })

    it('Grok→Codex explicit empty grant is rejected, never silently cleared', () => {
      expect(
        rules(
          resolveRecipeGrantTransition({
            body: body(CODEX_SPEC, { [ALIAS]: '', [CANONICAL]: '' }),
            current: { spec: GROK_SPEC, annotations: { [ALIAS]: '', [CANONICAL]: 'team-grok' } },
          })
        )
      ).toEqual(['codexRecipeGrantRequired'])
    })

    it('static→broker with omitted annotations requires a grant', () => {
      expect(
        rules(
          resolveRecipeGrantTransition({
            body: body(CODEX_SPEC),
            current: {
              spec: SDK_STATIC_SPEC,
              annotations: { [ALIAS]: '', [CANONICAL]: 'sdk-grok' },
            },
          })
        )
      ).toEqual(['codexRecipeGrantRequired'])
    })

    it('static→broker explicit grant writes the broker shape', () => {
      expect(
        resolveRecipeGrantTransition({
          body: body(GROK_SPEC, { [ALIAS]: '', [CANONICAL]: 'team-grok' }),
          current: { spec: STATIC_SPEC, annotations: {} },
        })
      ).toEqual({ ok: true, annotations: { [ALIAS]: '', [CANONICAL]: 'team-grok' } })
    })
  })

  describe('leaving a broker', () => {
    it.each([
      ['omitted', undefined],
      ['explicit empty', { [ALIAS]: '', [CANONICAL]: '' }],
    ])('broker→static without SDK clears both annotations (%s)', (_label, annotations) => {
      for (const prev of [
        { spec: CODEX_SPEC, annotations: { [ALIAS]: 'team-plus', [CANONICAL]: 'team-plus' } },
        { spec: GROK_SPEC, annotations: { [ALIAS]: '', [CANONICAL]: 'team-grok' } },
      ]) {
        expect(
          resolveRecipeGrantTransition({ body: body(STATIC_SPEC, annotations), current: prev })
        ).toEqual({ ok: true, annotations: { [ALIAS]: '', [CANONICAL]: '' } })
      }
    })

    it.each([
      ['omitted', undefined],
      ['explicit empty', { [ALIAS]: '', [CANONICAL]: '' }],
    ])('broker→static with SDK keeps the SDK-owned identity (%s)', (_label, annotations) => {
      expect(
        resolveRecipeGrantTransition({
          body: body(SDK_STATIC_SPEC, annotations),
          current: {
            spec: CODEX_SPEC,
            annotations: { [ALIAS]: 'team-plus', [CANONICAL]: 'team-plus' },
          },
        })
      ).toEqual({ ok: true, annotations: {} })
    })

    it('static→static keeps the stored identity even when the editor sends empty annotations', () => {
      expect(
        resolveRecipeGrantTransition({
          body: body(SDK_STATIC_SPEC, { [ALIAS]: '', [CANONICAL]: '' }),
          current: { spec: SDK_STATIC_SPEC, annotations: { [ALIAS]: '', [CANONICAL]: 'sdk-grok' } },
        })
      ).toEqual({ ok: true, annotations: {} })
    })
  })

  it('ignores non-string annotation values and never throws on malformed input', () => {
    expect(() =>
      resolveRecipeGrantTransition({
        body: { spec: CODEX_SPEC, metadata: { annotations: { [ALIAS]: 42, [CANONICAL]: null } } },
      })
    ).not.toThrow()
    expect(
      rules(
        resolveRecipeGrantTransition({
          body: { spec: CODEX_SPEC, metadata: { annotations: { [ALIAS]: 42 } } },
        })
      )
    ).toEqual(['codexRecipeGrantRequired'])
    expect(() =>
      resolveRecipeGrantTransition({
        body: { metadata: { annotations: { [ALIAS]: 'a', [CANONICAL]: 'b' } } },
        current: { spec: undefined, annotations: undefined },
      })
    ).not.toThrow()
  })
})
