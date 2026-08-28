import { vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'

/**
 * Recorded kube-apiserver GET of a namespaced Role (`kubectl get role -o json`
 * shape), not a field list copied from the comparator. Stamp
 * controller-owned name/labels/rules via `asApiserverRole`. Label keys are
 * inserted in reverse author order, and each rule is rebuilt in
 * V1PolicyRule.attributeTypeMap order, so a byte-identical fixture cannot hide
 * a missing canonicalize. The skip must still see `rules` or it fail-opens.
 */
export const RECORDED_ROLE: k8s.V1Role = {
  apiVersion: 'rbac.authorization.k8s.io/v1',
  kind: 'Role',
  metadata: {
    annotations: {
      'kubectl.kubernetes.io/last-applied-configuration': '{}',
    },
    creationTimestamp: new Date('2026-04-01T00:00:00.000Z'),
    generation: 1,
    managedFields: [
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        fieldsType: 'FieldsV1',
        fieldsV1: { 'f:rules': {} },
        manager: 'kube-apiserver',
        operation: 'Update',
        time: new Date('2026-04-01T00:00:00.000Z'),
      },
    ],
    name: 'recorded-role',
    namespace: 'recorded-ns',
    resourceVersion: '1784167',
    uid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    selfLink: '/apis/rbac.authorization.k8s.io/v1/namespaces/recorded-ns/roles/recorded-role',
    labels: {
      'clerum.io/host': 'recorded',
      'clerum.io/managed-by': 'host-context-controller',
    },
  },
  rules: [],
}

function shuffleLabelKeys(labels: Record<string, string>): Record<string, string> {
  const shuffled: Record<string, string> = {}
  for (const key of Object.keys(labels).reverse()) {
    shuffled[key] = labels[key]
  }
  return shuffled
}

/**
 * Rebuild a rule in client-node ObjectSerializer / V1PolicyRule.attributeTypeMap
 * order so a missing key-canonicalize cannot hide behind a cloned builder object.
 * FIXTURE-ROLE-1 pins this order against the live client-node class.
 */
export function asApiserverPolicyRule(rule: k8s.V1PolicyRule): k8s.V1PolicyRule {
  const live: Record<string, unknown> = {}
  if (rule.apiGroups !== undefined) live.apiGroups = rule.apiGroups
  if (rule.nonResourceURLs !== undefined) live.nonResourceURLs = rule.nonResourceURLs
  if (rule.resourceNames !== undefined) live.resourceNames = rule.resourceNames
  if (rule.resources !== undefined) live.resources = rule.resources
  if (rule.verbs !== undefined) live.verbs = rule.verbs
  return live as unknown as k8s.V1PolicyRule
}

export function asApiserverRole(desired: k8s.V1Role): k8s.V1Role {
  const recorded = structuredClone(RECORDED_ROLE)
  const labels = desired.metadata?.labels ?? {}
  return {
    ...recorded,
    metadata: {
      ...recorded.metadata,
      name: desired.metadata?.name,
      namespace: desired.metadata?.namespace,
      labels: shuffleLabelKeys({ ...labels }),
      annotations: {
        ...recorded.metadata?.annotations,
        ...desired.metadata?.annotations,
      },
      ownerReferences: desired.metadata?.ownerReferences,
      selfLink: `/apis/rbac.authorization.k8s.io/v1/namespaces/${desired.metadata?.namespace}/roles/${desired.metadata?.name}`,
    },
    rules: (desired.rules ?? []).map(asApiserverPolicyRule),
  }
}

export function updatedRoleLogs(log: ReturnType<typeof vi.spyOn>, needle: string): string[] {
  return log.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes('Updated Role') && line.includes(needle))
}
