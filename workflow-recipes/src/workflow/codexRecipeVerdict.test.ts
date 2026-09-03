import { describe, expect, it } from 'vitest'
import type { CodexConfigMapView } from '@clerum/codex-catalog-projection'
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
 * Views are built by the SAME producers the reconciler uses — a hand-written
 * snapshot would let a ConfigMap-shape change break parsing in production
 * while these stayed green, because the verdict only falls back to
 * `view.snapshot` when it cannot re-derive from `view.configMap`.
 */

const MODEL = 'gpt-5.6-luna'
const GRANT = 'team-plus'
const RECIPE = 'notify-app'
const UNASSIGNED = 'unassigned'

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
) => projectCodexRecipeVerdict({ ownSpec: codexSpec(), context: ctx, hostAgent, view })

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
    }
  })
})
