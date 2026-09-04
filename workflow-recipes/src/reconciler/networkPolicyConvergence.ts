import * as k8s from '@kubernetes/client-node'
import {
  RESOLVED_AT_ANNOTATION,
  STATE_ANNOTATION,
  TARGETS_ANNOTATION,
} from '@clerum/network-policy-core'
import { SPEC_HASH_ANNOTATION } from './specHash'

export type NetworkPolicyFamily =
  | 'ui-ingress'
  | 'workload-ingress'
  | 'workload-egress'
  | 'internal-dependency'
  | 'oauth-broker-egress'
  | 'webhook-gateway'

export type NetworkPolicyOwnershipDecision =
  | { kind: 'owned' }
  | { kind: 'repairable-owner' }
  | {
      kind: 'conflict'
      reason:
        | 'desired-owner-uid-missing'
        | 'identity-label-mismatch'
        | 'controller-owner-mismatch'
        | 'owner-reference-mismatch'
    }

export type NetworkPolicyConvergenceDecision =
  | { action: 'unchanged' }
  | { action: 'replace'; reason: 'live-drift' | 'owner-repair' }
  | { action: 'retry'; reason: 'terminating' }
  | {
      action: 'conflict'
      reason:
        | 'desired-owner-uid-missing'
        | 'identity-label-mismatch'
        | 'controller-owner-mismatch'
        | 'owner-reference-mismatch'
    }

const GATEWAY_IDENTITY_LABELS = [
  'clerum.io/managed-by',
  'clerum.io/recipe-namespace',
  'clerum.io/recipe-name',
  'clerum.io/webhook-gateway',
] as const

// These keys remain WRC-owned when external egress is removed from desired.
// Other annotation namespaces are not ownership boundaries: preserve every
// unauthored key, including keys authored by other clerum.io controllers.
const EGRESS_STATE_ANNOTATIONS = new Set([
  RESOLVED_AT_ANNOTATION,
  STATE_ANNOTATION,
  TARGETS_ANNOTATION,
])

function projectOwnedAnnotations(
  desired: Record<string, string> | undefined,
  existing: Record<string, string> | undefined,
  temporal = false
): Record<string, string> {
  const keys = new Set([...Object.keys(desired ?? {}), ...EGRESS_STATE_ANNOTATIONS])
  return Object.fromEntries(
    [...keys].flatMap(key => {
      if (key === SPEC_HASH_ANNOTATION) return []
      // The accumulator owns renewal cadence for present temporal state. Its
      // removal still has to reach apply, even when the enforced rules match.
      if (temporal && EGRESS_STATE_ANNOTATIONS.has(key) && desired?.[key] !== undefined) return []
      return existing?.[key] === undefined ? [] : [[key, existing[key]]]
    })
  )
}

/** Build a PUT from the same live snapshot used for ownership and drift checks. */
export function buildNetworkPolicyReplacement(
  desired: k8s.V1NetworkPolicy,
  existing: k8s.V1NetworkPolicy
): k8s.V1NetworkPolicy {
  const replacement = structuredClone(desired)
  const liveMetadata = existing.metadata ?? {}
  const annotations = { ...liveMetadata.annotations }
  for (const key of EGRESS_STATE_ANNOTATIONS) delete annotations[key]
  Object.assign(annotations, desired.metadata?.annotations)
  delete annotations[SPEC_HASH_ANNOTATION]
  replacement.metadata = {
    ...replacement.metadata,
    labels: { ...liveMetadata.labels, ...replacement.metadata?.labels },
    annotations,
    ...(liveMetadata.finalizers?.length || replacement.metadata?.finalizers?.length
      ? {
          finalizers: [
            ...new Set([
              ...(liveMetadata.finalizers ?? []),
              ...(replacement.metadata?.finalizers ?? []),
            ]),
          ],
        }
      : {}),
    resourceVersion: liveMetadata.resourceVersion,
  }
  // ownerReferences intentionally come only from desired after the ownership
  // veto. Foreign lifecycle owners must not be adopted, retained, or erased.
  return replacement
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return Object.fromEntries(entries.map(([key, child]) => [key, canonicalizeValue(child)]))
  }
  return value
}

function projectAuthoredMap(
  desired: Record<string, string> | undefined,
  existing: Record<string, string> | undefined
): Record<string, string> {
  return Object.fromEntries(
    Object.keys(desired ?? {}).flatMap(key =>
      existing?.[key] === undefined ? [] : [[key, existing[key]]]
    )
  )
}

function projectNetworkPolicyForComparison(
  desired: k8s.V1NetworkPolicy,
  candidate: k8s.V1NetworkPolicy
): k8s.V1NetworkPolicy {
  const desiredMetadata = desired.metadata ?? {}
  const candidateMetadata = candidate.metadata ?? {}
  return {
    apiVersion: candidate.apiVersion,
    kind: candidate.kind,
    metadata: {
      name: candidateMetadata.name,
      namespace: candidateMetadata.namespace,
      labels: projectAuthoredMap(desiredMetadata.labels, candidateMetadata.labels),
      annotations: projectOwnedAnnotations(
        desiredMetadata.annotations,
        candidateMetadata.annotations
      ),
      ...(desiredMetadata.ownerReferences?.length
        ? { ownerReferences: candidateMetadata.ownerReferences }
        : {}),
    },
    spec: structuredClone(candidate.spec),
  }
}

function normalizeIngressFrom(rule: k8s.V1NetworkPolicyIngressRule): void {
  const record = rule as k8s.V1NetworkPolicyIngressRule & {
    from?: k8s.V1NetworkPolicyPeer[]
  }
  if (record._from === undefined && record.from !== undefined) record._from = record.from
  delete record.from
}

function normalizeProjectedNetworkPolicy(normalized: k8s.V1NetworkPolicy): unknown {
  const spec = normalized.spec
  if (spec) {
    const hasEgressRules = (spec.egress?.length ?? 0) > 0
    if (!spec.policyTypes?.length) {
      spec.policyTypes = hasEgressRules ? ['Ingress', 'Egress'] : ['Ingress']
    } else {
      spec.policyTypes = [...spec.policyTypes].sort()
    }
    for (const rule of spec.ingress ?? []) normalizeIngressFrom(rule)
    for (const rule of [...(spec.ingress ?? []), ...(spec.egress ?? [])]) {
      for (const port of rule.ports ?? []) {
        if (port.protocol === 'TCP') delete port.protocol
      }
    }
    if (spec.ingress?.length === 0) delete spec.ingress
    if (spec.egress?.length === 0) delete spec.egress
  }

  return canonicalizeValue(normalized)
}

export function normalizeNetworkPolicyForComparison(policy: k8s.V1NetworkPolicy): unknown {
  return normalizeProjectedNetworkPolicy(projectNetworkPolicyForComparison(policy, policy))
}

export function networkPolicyMatchesDesired(
  desired: k8s.V1NetworkPolicy | undefined,
  existing: k8s.V1NetworkPolicy | undefined
): boolean {
  try {
    if (!desired?.spec || !existing?.spec) return false
    return (
      JSON.stringify(
        normalizeProjectedNetworkPolicy(projectNetworkPolicyForComparison(desired, desired))
      ) ===
      JSON.stringify(
        normalizeProjectedNetworkPolicy(projectNetworkPolicyForComparison(desired, existing))
      )
    )
  } catch {
    return false
  }
}

/**
 * Compare the stable identity metadata that the workload-egress prefilter must
 * never hide. Present temporal DNS/state values follow the accumulator's
 * persistence cadence; retired state keys, stable annotations, labels,
 * lifecycle owner and a terminating object must still reach the live apply.
 */
export function networkPolicyMetadataMatchesDesired(
  desired: k8s.V1NetworkPolicy,
  existing: k8s.V1NetworkPolicy
): boolean {
  if (existing.metadata?.deletionTimestamp) return false
  if (classifyNetworkPolicyOwnership('workload-egress', desired, existing).kind !== 'owned') {
    return false
  }
  const project = (policy: k8s.V1NetworkPolicy) =>
    canonicalizeValue({
      apiVersion: policy.apiVersion,
      kind: policy.kind,
      name: policy.metadata?.name,
      namespace: policy.metadata?.namespace,
      labels: projectAuthoredMap(desired.metadata?.labels, policy.metadata?.labels),
      annotations: projectOwnedAnnotations(
        desired.metadata?.annotations,
        policy.metadata?.annotations,
        true
      ),
      ownerReferences: desired.metadata?.ownerReferences?.length
        ? policy.metadata?.ownerReferences
        : undefined,
    })
  return JSON.stringify(project(desired)) === JSON.stringify(project(existing))
}

function controllerOwners(policy: k8s.V1NetworkPolicy): k8s.V1OwnerReference[] {
  return (policy.metadata?.ownerReferences ?? []).filter(owner => owner.controller === true)
}

function sameOwnerIdentity(desired: k8s.V1OwnerReference, existing: k8s.V1OwnerReference): boolean {
  return (
    desired.apiVersion === existing.apiVersion &&
    desired.kind === existing.kind &&
    desired.name === existing.name
  )
}

function exactOwnerMatch(desired: k8s.V1OwnerReference, existing: k8s.V1OwnerReference): boolean {
  return (
    sameOwnerIdentity(desired, existing) &&
    desired.uid === existing.uid &&
    desired.controller === existing.controller &&
    desired.blockOwnerDeletion === existing.blockOwnerDeletion
  )
}

function gatewayIdentityLabelsMatch(
  desired: k8s.V1NetworkPolicy,
  existing: k8s.V1NetworkPolicy
): boolean {
  const desiredLabels = desired.metadata?.labels ?? {}
  const existingLabels = existing.metadata?.labels ?? {}
  return GATEWAY_IDENTITY_LABELS.every(
    key => Boolean(desiredLabels[key]) && desiredLabels[key] === existingLabels[key]
  )
}

export function classifyNetworkPolicyOwnership(
  family: NetworkPolicyFamily,
  desired: k8s.V1NetworkPolicy,
  existing: k8s.V1NetworkPolicy
): NetworkPolicyOwnershipDecision {
  const desiredOwners = controllerOwners(desired)
  const existingOwners = controllerOwners(existing)
  if (desiredOwners.length === 0) {
    return (existing.metadata?.ownerReferences?.length ?? 0) === 0
      ? { kind: 'owned' }
      : { kind: 'conflict', reason: 'owner-reference-mismatch' }
  }

  const desiredOwner = desiredOwners[0]
  if (!desiredOwner.uid) return { kind: 'conflict', reason: 'desired-owner-uid-missing' }

  // Admission metadata may coexist, but an additional lifecycle owner changes
  // garbage-collection authority. Only explicitly desired non-controller refs
  // are permitted; never silently drop an unexpected owner during replacement.
  const desiredOtherOwners = (desired.metadata?.ownerReferences ?? []).filter(
    owner => owner.controller !== true
  )
  const existingOtherOwners = (existing.metadata?.ownerReferences ?? []).filter(
    owner => owner.controller !== true
  )
  if (
    existingOtherOwners.length !== desiredOtherOwners.length ||
    existingOtherOwners.some(
      owner => !desiredOtherOwners.some(wanted => exactOwnerMatch(wanted, owner))
    )
  ) {
    return { kind: 'conflict', reason: 'owner-reference-mismatch' }
  }

  if (existingOwners.length === 1 && exactOwnerMatch(desiredOwner, existingOwners[0])) {
    return { kind: 'owned' }
  }

  if (family !== 'webhook-gateway' || !gatewayIdentityLabelsMatch(desired, existing)) {
    return { kind: 'conflict', reason: 'identity-label-mismatch' }
  }

  if (existingOwners.length === 0) return { kind: 'repairable-owner' }
  if (existingOwners.length === 1 && sameOwnerIdentity(desiredOwner, existingOwners[0])) {
    return { kind: 'repairable-owner' }
  }
  return { kind: 'conflict', reason: 'controller-owner-mismatch' }
}

export function decideNetworkPolicyConvergence(
  family: NetworkPolicyFamily,
  desired: k8s.V1NetworkPolicy,
  existing: k8s.V1NetworkPolicy
): NetworkPolicyConvergenceDecision {
  if (existing.metadata?.deletionTimestamp) return { action: 'retry', reason: 'terminating' }

  const ownership = classifyNetworkPolicyOwnership(family, desired, existing)
  if (ownership.kind === 'conflict') return { action: 'conflict', reason: ownership.reason }
  if (ownership.kind === 'repairable-owner') {
    return { action: 'replace', reason: 'owner-repair' }
  }
  if (networkPolicyMatchesDesired(desired, existing)) return { action: 'unchanged' }
  return { action: 'replace', reason: 'live-drift' }
}
