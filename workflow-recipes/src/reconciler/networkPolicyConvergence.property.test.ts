import { describe, expect, it } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { ObjectSerializer } from '@kubernetes/client-node/dist/gen/models/ObjectSerializer'
import fc from 'fast-check'
import type { WorkflowRecipeCRD } from '../types'
import {
  buildNetworkPolicyReplacement,
  classifyOwnerlessNetworkPolicyOwnership,
  decideNetworkPolicyConvergence,
  networkPolicyMatchesDesired,
} from './networkPolicyConvergence'
import {
  buildUiEgressNetworkPolicy,
  buildUiIngressNetworkPolicy,
  buildWorkloadIngressNetworkPolicy,
} from './resourceBuilder'

// Exercise the installed Kubernetes model/wire conversion. The few server
// defaults below are explicit: ObjectSerializer itself is not an API server.
function apiRoundTrip(policy: k8s.V1NetworkPolicy): k8s.V1NetworkPolicy {
  const wire = ObjectSerializer.serialize(policy, 'V1NetworkPolicy', '')
  if (!wire.spec.policyTypes?.length) {
    wire.spec.policyTypes = wire.spec.egress?.length ? ['Ingress', 'Egress'] : ['Ingress']
  }
  for (const rule of [...(wire.spec.ingress ?? []), ...(wire.spec.egress ?? [])]) {
    for (const port of rule.ports ?? []) port.protocol ??= 'TCP'
  }
  return ObjectSerializer.deserialize(JSON.parse(JSON.stringify(wire)), 'V1NetworkPolicy', '')
}

const scenario = fc.record({
  id: fc.integer({ min: 1, max: 1_000_000 }),
  ports: fc.uniqueArray(fc.integer({ min: 1, max: 65535 }), { minLength: 1, maxLength: 6 }),
  revision: fc.integer({ min: 1, max: 1_000_000 }),
  protocol: fc.constantFrom('TCP' as const, 'UDP' as const),
  reverse: fc.boolean(),
})

function generatedPolicies(input: fc.ArbitraryValue<typeof scenario>) {
  const ports = input.reverse ? [...input.ports].reverse() : input.ports
  const recipe: WorkflowRecipeCRD = {
    apiVersion: 'clerum.io/v1alpha1',
    kind: 'WorkflowRecipe',
    metadata: { name: `recipe-${input.id}`, namespace: 'sandbox-recipes', uid: `uid-${input.id}` },
    spec: {
      workloads: [{ id: 'backend', type: 'deployment', image: 'nginx:1.30.1-alpine' }],
      ui: {
        workloadRef: 'backend',
        port: ports[0],
        egress: { internal: ports.map(port => ({ workloadRef: 'backend', port })) },
      },
    },
  }
  return [
    buildUiEgressNetworkPolicy(recipe, 'sandbox-ui', 'sandbox-recipes', [])!,
    buildUiIngressNetworkPolicy(recipe, 'backend', ports, 'sandbox-recipes', 'sandbox-ui')!,
    buildWorkloadIngressNetworkPolicy(
      recipe.spec.workloads[0],
      recipe,
      'sandbox-recipes',
      ports.map(port => ({
        fromWorkloadId: 'caller',
        fromNamespace: 'sandbox-recipes',
        port,
        protocol: input.protocol,
      }))
    )!,
  ]
}

describe('generated NetworkPolicy serialization and replacement properties', () => {
  it('preserves real producer enforcement through model and wire round trips', () => {
    fc.assert(
      fc.property(scenario, input => {
        for (const desired of generatedPolicies(input)) {
          if (input.reverse) {
            for (const rule of [
              ...(desired.spec!.ingress ?? []),
              ...(desired.spec!.egress ?? []),
            ]) {
              for (const port of rule.ports ?? []) {
                if (port.protocol === 'TCP') delete port.protocol
              }
            }
            if (desired.spec!.policyTypes?.[0] === 'Ingress') {
              delete desired.spec!.policyTypes
              desired.spec!.egress = []
            } else {
              desired.spec!.ingress = []
            }
          }
          const before = structuredClone(desired)
          const wire = ObjectSerializer.serialize(desired, 'V1NetworkPolicy', '')
          if (desired.spec!.ingress?.length) {
            expect(wire.spec.ingress[0].from).toEqual(desired.spec!.ingress[0]._from)
            expect(wire.spec.ingress[0]._from).toBeUndefined()
          }
          expect(networkPolicyMatchesDesired(desired, wire)).toBe(true)
          const live = apiRoundTrip(desired)
          expect(networkPolicyMatchesDesired(desired, live)).toBe(true)
          expect(networkPolicyMatchesDesired(desired, apiRoundTrip(live))).toBe(true)
          // Comparison must retain the generated security boundary, not just
          // accept all API responses as equivalent.
          const drifted = apiRoundTrip(desired)
          drifted.spec!.podSelector = {}
          expect(networkPolicyMatchesDesired(desired, drifted)).toBe(false)
          expect(desired).toEqual(before)
        }
      }),
      { numRuns: 100 }
    )
  })

  it('makes replacement idempotent and composes desired updates across both writer families', () => {
    fc.assert(
      fc.property(scenario, scenario, (first, second) => {
        const initial = generatedPolicies(first)
        const updates = generatedPolicies({ ...second, id: first.id })
        for (let index = 0; index < initial.length; index++) {
          const family = index === 1 ? 'ui-ingress' : index === 2 ? 'workload-ingress' : undefined
          const desired = initial[index]
          const live = apiRoundTrip(desired)
          live.metadata!.resourceVersion = String(first.revision)
          live.metadata!.labels!['admission.example/revision'] = String(first.id)
          live.metadata!.annotations = {
            'clerum.io/external-controller-note': String(first.id),
            'clerum.io/egress-fqdn-state': 'retired-state',
            'clerum.io/spec-hash': 'legacy-hash',
          }
          live.metadata!.finalizers = ['admission.example/hold']
          live.spec!.podSelector = {}
          const snapshot = structuredClone(live)
          const replacement = buildNetworkPolicyReplacement(desired, live)
          expect(replacement.metadata!.resourceVersion).toBe(String(first.revision))
          expect(networkPolicyMatchesDesired(desired, apiRoundTrip(replacement))).toBe(true)
          if (family) {
            expect(
              decideNetworkPolicyConvergence(family, desired, apiRoundTrip(replacement))
            ).toEqual({
              action: 'unchanged',
            })
          }
          expect(buildNetworkPolicyReplacement(desired, apiRoundTrip(replacement))).toEqual(
            replacement
          )

          const update = updates[index]
          // Updating the same identity with a new port set must compose just as
          // applying the newest desired state directly to the original snapshot.
          const composed = buildNetworkPolicyReplacement(update, apiRoundTrip(replacement))
          expect(composed).toEqual(buildNetworkPolicyReplacement(update, live))
          expect(composed.spec).toEqual(update.spec)
          expect(composed.metadata!.annotations).toEqual({
            'clerum.io/external-controller-note': String(first.id),
          })
          expect(composed.metadata!.labels!['admission.example/revision']).toBe(String(first.id))
          expect(composed.metadata!.finalizers).toEqual(['admission.example/hold'])
          expect(networkPolicyMatchesDesired(update, apiRoundTrip(composed))).toBe(true)
          if (family) {
            expect(decideNetworkPolicyConvergence(family, update, apiRoundTrip(composed))).toEqual({
              action: 'unchanged',
            })
          }
          expect(live).toEqual(snapshot)
          // Replacement is only legal after ownership checks. An unexpected
          // lifecycle owner must still be vetoed even for matching enforcement.
          const foreign = apiRoundTrip(composed)
          foreign.metadata!.ownerReferences = [
            {
              apiVersion: 'apps/v1',
              kind: 'Deployment',
              name: 'foreign',
              uid: `foreign-${first.id}`,
              controller: true,
            },
          ]
          if (family) {
            expect(decideNetworkPolicyConvergence(family, update, foreign)).toEqual({
              action: 'conflict',
              reason: 'owner-reference-mismatch',
            })
          } else {
            expect(classifyOwnerlessNetworkPolicyOwnership(foreign)).toEqual({
              kind: 'conflict',
              reason: 'owner-reference-mismatch',
            })
          }
        }
      }),
      { numRuns: 100 }
    )
  })
})
