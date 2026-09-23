import { describe, expect, it } from 'vitest'
import type { CodexConfigMapView } from '@clerum/codex-catalog-projection'
import { computeGrokPolicyHash } from '@clerum/grok-provider-attempt-contract'
import { computeCodexPolicyHash } from '@clerum/llm-provider-attempt-contract'
import type { WorkflowRecipeSpec } from '../types'
import {
  type CodexAllowlistView,
  type CodexReconcileContext,
  projectCodexRecipeVerdict,
} from './codexRecipeVerdict'
import { parseAllowedModelsSnapshot, snapshotFromConfigMapError } from './llmAllowedModelsSnapshot'

/*
 * The Codex seam was fixed four times and each fix converged one more
 * dimension: `readOk`, then `snapshotError`, while `provenance` stayed free to
 * diverge. These tests pin the verdict as a whole, so a future dimension
 * cannot be added on only one side.
 *
 * The last case in the file is the invariant sweep: it quantifies over every
 * row rather than trusting that someone remembered to assert it per case.
 *
 * Views are built by the SAME producers `refreshCodexSnapshot` uses. Where a
 * ConfigMap is present that is a typing fix rather than new coverage: the
 * verdict re-derives from `view.configMap` and reads `view.snapshot` only for
 * an unassigned grant. Where no ConfigMap arrived at all, the snapshot IS the
 * only input, so deriving it from the real error producer is what keeps these
 * cases from drifting away from what production would hand them.
 */

const MODEL = 'gpt-5.6-luna'
const GRANT = 'team-plus'
const RECIPE = 'notify-app'
const UNASSIGNED = 'unassigned'
const GROK_MODEL = 'grok-4.6'
const GROK_GRANT = 'team-grok'

const codexSpec = (): WorkflowRecipeSpec =>
  ({ agent: { provider: 'codex-subscription', model: MODEL } }) as unknown as WorkflowRecipeSpec

function eligibleConfigMap(overrides?: {
  annotations?: Record<string, string>
  models?: string[]
}): CodexConfigMapView {
  return {
    metadata: {
      annotations: {
        'clerum.io/catalog-revision': '3',
        'clerum.io/connection-revision': '1',
        'clerum.io/codex-connection-status': 'connected',
        'clerum.io/codex-enabled': 'true',
        ...overrides?.annotations,
      },
    },
    data: {
      'codex-subscription': JSON.stringify(
        (overrides?.models ?? [MODEL]).map(model => ({ model, stale: false }))
      ),
    },
  }
}

/** Exactly how `refreshCodexSnapshot` assembles the view it hands every consumer. */
const viewFrom = (configMap: CodexConfigMapView | undefined): CodexAllowlistView => ({
  configMap,
  snapshot: parseAllowedModelsSnapshot(configMap),
})

/** A view whose ConfigMap never arrived — the snapshot-error dimension. */
const unreadableView = (): CodexAllowlistView => ({
  snapshot: snapshotFromConfigMapError('missing'),
})

function context(overrides?: Partial<CodexReconcileContext>): CodexReconcileContext {
  return {
    recipeUid: 'uid-1',
    recipeName: RECIPE,
    runtimeScopeRecipeName: RECIPE,
    claimedParent: false,
    parentSpec: null,
    connectionKey: GRANT,
    ...overrides,
  }
}

const verdict = (
  ctx: CodexReconcileContext,
  view: CodexAllowlistView,
  hostAgent: { provider: string; model: string } | undefined = {
    provider: 'codex-subscription',
    model: MODEL,
  }
) =>
  projectCodexRecipeVerdict({
    ownSpec: codexSpec(),
    context: ctx,
    hostAgent,
    view,
    grokSubscriptionEnabled: true,
  })

describe('projectCodexRecipeVerdict', () => {
  it('reports an unreadable ConfigMap as uncertain and withholds the binding', () => {
    const v = verdict(context(), unreadableView())
    expect(v.projection.eligibility).toBe('uncertain')
    expect(v.hostBinding).toBeNull()
  })

  it('reports a readable but malformed ConfigMap as uncertain, not as a decision', () => {
    const cm = eligibleConfigMap({ annotations: { 'clerum.io/catalog-revision': 'not-a-number' } })
    const v = verdict(context(), viewFrom(cm))
    expect(v.projection.eligibility).toBe('uncertain')
    expect(v.hostBinding).toBeNull()
  })

  // The two provenance-uncertain states. Both were `ineligible`
  // on the configure path while the scope path already called them uncertain,
  // so a binding-less v3 configure wiped a live host binding over a transient
  // condition.
  it('reports an unavailable parent spec as uncertain even with an eligible own catalog', () => {
    const v = verdict(
      context({
        runtimeScopeRecipeName: 'parent-recipe',
        parentSpec: null,
        connectionKey: UNASSIGNED,
      }),
      viewFrom(eligibleConfigMap())
    )
    expect(v.provenanceReason).toBe('parent_spec_unavailable')
    expect(v.projection.eligibility).toBe('uncertain')
    expect(v.hostBinding).toBeNull()
  })

  it('reports a rejected parent claim as uncertain even when the own grant is eligible', () => {
    // The inverse divergence: the configure path used to MINT a binding here
    // while the scope path withheld `llm:codex:execute` — an execution binding
    // on a host whose freshly issued JWT lacks the scope.
    const v = verdict(
      context({ claimedParent: true, runtimeScopeRecipeName: RECIPE }),
      viewFrom(eligibleConfigMap())
    )
    expect(v.provenanceReason).toBe('parent_provenance_rejected')
    expect(v.projection.eligibility).toBe('uncertain')
    expect(v.hostBinding).toBeNull()
  })

  it('treats an authoritative unassigned grant as a decision, not as uncertainty', () => {
    // Not over-blocking: with authority established, "no grant assigned" is a
    // real answer and a binding-less configure is the correct outcome.
    const v = verdict(context({ connectionKey: UNASSIGNED }), viewFrom(eligibleConfigMap()))
    expect(v.provenance).toBe('authoritative')
    expect(v.projection.eligibility).not.toBe('uncertain')
    expect(v.hostBinding).toBeNull()
  })

  it('mints the hashed five-field proof for an authoritative eligible catalog', () => {
    const v = verdict(context(), viewFrom(eligibleConfigMap()))
    expect(v.projection.eligibility).toBe('eligible')
    expect(v.hostBinding).toEqual({
      connectionKey: GRANT,
      catalogRevision: 3,
      credentialRevision: 1,
      model: MODEL,
      bindingHash: computeCodexPolicyHash({
        model: MODEL,
        catalogRevision: 3,
        credentialRevision: 1,
        connectionKey: GRANT,
      }),
    })
  })

  it('withholds the binding for a host agent on another model while keeping the scope', () => {
    // The one remaining asymmetry: an eligible projection with no host binding
    // is a decision about THIS pod's agent, not doubt about the catalog.
    const v = verdict(context(), viewFrom(eligibleConfigMap()), {
      provider: 'codex-subscription',
      model: 'some-other-model',
    })
    expect(v.projection.eligibility).toBe('eligible')
    expect(v.hostBinding).toBeNull()
  })

  it('withholds the binding for a non-Codex host agent', () => {
    const v = verdict(context(), viewFrom(eligibleConfigMap()), {
      provider: 'openai',
      model: MODEL,
    })
    expect(v.hostBinding).toBeNull()
    expect(v.hostBindingReason).toBe('host_agent_not_codex')
  })

  it('holds the binding/eligibility invariants across every case', () => {
    const cases: Array<[string, ReturnType<typeof verdict>]> = [
      ['unreadable', verdict(context(), unreadableView())],
      [
        'malformed',
        verdict(
          context(),
          viewFrom(eligibleConfigMap({ annotations: { 'clerum.io/catalog-revision': 'nope' } }))
        ),
      ],
      [
        'parent-unavailable',
        verdict(
          context({
            runtimeScopeRecipeName: 'parent',
            parentSpec: null,
            connectionKey: UNASSIGNED,
          }),
          viewFrom(eligibleConfigMap())
        ),
      ],
      ['parent-rejected', verdict(context({ claimedParent: true }), viewFrom(eligibleConfigMap()))],
      [
        'unassigned',
        verdict(context({ connectionKey: UNASSIGNED }), viewFrom(eligibleConfigMap())),
      ],
      ['eligible', verdict(context(), viewFrom(eligibleConfigMap()))],
      [
        'wrong-model',
        verdict(context(), viewFrom(eligibleConfigMap()), {
          provider: 'codex-subscription',
          model: 'other',
        }),
      ],
    ]
    for (const [name, v] of cases) {
      if (v.hostBinding !== null) {
        expect(`${name}:${v.projection.eligibility}`).toBe(`${name}:eligible`)
        expect(`${name}:${v.provenance}`).toBe(`${name}:authoritative`)
      }
      if (v.projection.eligibility === 'uncertain') {
        expect(`${name}:${v.hostBinding === null}`).toBe(`${name}:true`)
      }
      if (v.grokBinding !== null) {
        expect(`${name}:${v.grokProjection.eligibility}`).toBe(`${name}:eligible`)
        expect(`${name}:${v.provenance}`).toBe(`${name}:authoritative`)
      }
      if (v.grokProjection.eligibility === 'uncertain') {
        expect(`${name}:${v.grokBinding === null}`).toBe(`${name}:true`)
      }
    }
  })
})

const grokSpec = (): WorkflowRecipeSpec =>
  ({ agent: { provider: 'grok-subscription', model: GROK_MODEL } }) as unknown as WorkflowRecipeSpec

function eligibleGrokConfigMap(): CodexConfigMapView {
  return {
    metadata: {
      annotations: {
        'clerum.io/grok-enabled': 'true',
        'clerum.io/grok-connection-status': 'connected',
        'clerum.io/grok-connections': JSON.stringify({
          [GROK_GRANT]: {
            status: 'connected',
            catalogRevision: 5,
            connectionRevision: 2,
            models: [GROK_MODEL],
          },
        }),
      },
    },
    data: {},
  }
}

describe('projectCodexRecipeVerdict Grok mint', () => {
  it('mints a Grok binding even when the Codex projection is ineligible', () => {
    const v = projectCodexRecipeVerdict({
      ownSpec: grokSpec(),
      context: context({ connectionKey: UNASSIGNED, grokConnectionKey: GROK_GRANT }),
      hostAgent: { provider: 'grok-subscription', model: GROK_MODEL },
      view: viewFrom(eligibleGrokConfigMap()),
      grokSubscriptionEnabled: true,
    })
    expect(v.projection.eligibility).not.toBe('eligible')
    expect(v.hostBinding).toBeNull()
    expect(v.grokProjection.eligibility).toBe('eligible')
    expect(v.grokBinding).toEqual({
      connectionKey: GROK_GRANT,
      catalogRevision: 5,
      credentialRevision: 2,
      model: GROK_MODEL,
      bindingHash: computeGrokPolicyHash({
        model: GROK_MODEL,
        catalogRevision: 5,
        credentialRevision: 2,
        connectionKey: GROK_GRANT,
      }),
    })
  })

  it('withholds Grok scope and binding when provenance is uncertain', () => {
    const v = projectCodexRecipeVerdict({
      ownSpec: grokSpec(),
      context: context({
        runtimeScopeRecipeName: 'parent-recipe',
        parentSpec: null,
        connectionKey: UNASSIGNED,
        grokConnectionKey: GROK_GRANT,
      }),
      hostAgent: { provider: 'grok-subscription', model: GROK_MODEL },
      view: viewFrom(eligibleGrokConfigMap()),
      grokSubscriptionEnabled: true,
    })
    expect(v.grokProjection.eligibility).toBe('uncertain')
    expect(v.grokProjection.reason).toBe('provenance_uncertain')
    expect(v.grokProjection.requiresGrokProxyEgress).toBe(false)
    expect(v.grokProjection.derivedScopes).toEqual([])
    expect(v.grokBinding).toBeNull()
  })

  it('does not mint a Grok binding for an unassigned Grok grant', () => {
    const v = projectCodexRecipeVerdict({
      ownSpec: grokSpec(),
      context: context({ connectionKey: UNASSIGNED, grokConnectionKey: UNASSIGNED }),
      hostAgent: { provider: 'grok-subscription', model: GROK_MODEL },
      view: viewFrom(eligibleGrokConfigMap()),
      grokSubscriptionEnabled: true,
    })
    expect(v.grokBinding).toBeNull()
    expect(v.grokBindingReason).toBe('unassigned')
  })
})

/*
 * A-RP-007 / C-RP-011: WRC_GROK_SUBSCRIPTION_ENABLED is part of the ONE Grok
 * verdict. Scopes, grok-proxy egress, the SDK bootstrap binding and the pod
 * env all read this verdict (or the same flag), so with the WRC switch off an
 * eligible catalog annotation must not leave any of them live.
 */
describe('projectCodexRecipeVerdict Grok WRC switch', () => {
  const grokVerdict = (input: {
    ownSpec?: WorkflowRecipeSpec
    ctx?: Partial<CodexReconcileContext>
    hostAgent?: { provider: string; model: string }
    grokSubscriptionEnabled: boolean
  }) =>
    projectCodexRecipeVerdict({
      ownSpec: input.ownSpec ?? grokSpec(),
      context: context({ connectionKey: UNASSIGNED, grokConnectionKey: GROK_GRANT, ...input.ctx }),
      hostAgent: input.hostAgent ?? { provider: 'grok-subscription', model: GROK_MODEL },
      view: viewFrom(eligibleGrokConfigMap()),
      grokSubscriptionEnabled: input.grokSubscriptionEnabled,
    })

  const stepLevelGrokSpec = (): WorkflowRecipeSpec =>
    ({
      agent: { provider: 'openai', model: 'gpt-4o' },
      steps: [{ id: 'grok-step', agent: { provider: 'grok-subscription', model: GROK_MODEL } }],
    }) as unknown as WorkflowRecipeSpec

  const sdkOnlyGrokSpec = (): WorkflowRecipeSpec =>
    ({
      agent: { provider: 'grok-subscription', model: GROK_MODEL },
      pluginWorkloadSdk: { capabilities: ['promptBridge'] },
    }) as unknown as WorkflowRecipeSpec

  function expectGrokWithheld(v: ReturnType<typeof grokVerdict>) {
    expect(v.grokProjection.eligibility).toBe('ineligible')
    expect(v.grokProjection.reason).toBe('wrc_flag_off')
    expect(v.grokProjection.derivedScopes).toEqual([])
    expect(v.grokProjection.eligibleTargets).toEqual([])
    expect(v.grokProjection.requiresGrokProxyEgress).toBe(false)
    expect(v.grokBinding).toBeNull()
    expect(v.grokBindingReason).toBe('wrc_flag_off')
  }

  it('withholds Grok scope, egress and binding for an ordinary recipe when the WRC flag is off', () => {
    expectGrokWithheld(grokVerdict({ grokSubscriptionEnabled: false }))
  })

  it('withholds Grok scope and egress for a step-level Grok recipe when the WRC flag is off', () => {
    const on = grokVerdict({ ownSpec: stepLevelGrokSpec(), grokSubscriptionEnabled: true })
    expect(on.grokProjection.derivedScopes).toEqual(['llm:grok:execute'])
    expect(on.grokProjection.requiresGrokProxyEgress).toBe(true)
    const off = grokVerdict({ ownSpec: stepLevelGrokSpec(), grokSubscriptionEnabled: false })
    expect(off.grokProjection.reason).toBe('wrc_flag_off')
    expect(off.grokProjection.derivedScopes).toEqual([])
    expect(off.grokProjection.requiresGrokProxyEgress).toBe(false)
  })

  it('withholds the SDK-only Grok bootstrap binding when the WRC flag is off', () => {
    const on = grokVerdict({ ownSpec: sdkOnlyGrokSpec(), grokSubscriptionEnabled: true })
    expect(on.grokBinding).not.toBeNull()
    expectGrokWithheld(grokVerdict({ ownSpec: sdkOnlyGrokSpec(), grokSubscriptionEnabled: false }))
  })

  it('is a decision, not uncertainty: the WRC flag off wins over undecidable provenance', () => {
    const v = grokVerdict({
      ctx: { runtimeScopeRecipeName: 'parent-recipe', parentSpec: null },
      grokSubscriptionEnabled: false,
    })
    expectGrokWithheld(v)
  })

  it('leaves the eligible Grok verdict unchanged when the WRC flag is on', () => {
    const v = grokVerdict({ grokSubscriptionEnabled: true })
    expect(v.grokProjection.eligibility).toBe('eligible')
    expect(v.grokProjection.derivedScopes).toEqual(['llm:grok:execute'])
    expect(v.grokProjection.requiresGrokProxyEgress).toBe(true)
    expect(v.grokBinding?.connectionKey).toBe(GROK_GRANT)
  })

  it('never changes the Codex verdict', () => {
    const on = verdict(context(), viewFrom(eligibleConfigMap()))
    const off = projectCodexRecipeVerdict({
      ownSpec: codexSpec(),
      context: context(),
      hostAgent: { provider: 'codex-subscription', model: MODEL },
      view: viewFrom(eligibleConfigMap()),
      grokSubscriptionEnabled: false,
    })
    expect(off.projection).toEqual(on.projection)
    expect(off.hostBinding).toEqual(on.hostBinding)
    expect(off.hostBinding).not.toBeNull()
  })
})
