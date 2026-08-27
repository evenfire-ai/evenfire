import { vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'

/**
 * Recorded kube-apiserver GET of a namespaced Role (`kubectl get role -o json`
 * shape), not a field list copied from the comparator. Stamp
 * controller-owned name/labels/rules via `asApiserverRole`. Label keys are
 * inserted in reverse author order so a byte-identical fixture cannot hide a
 * missing canonicalize. Do not reconstruct rules from desired alone when
 * asserting the read carried `rules` — the skip must see them or it fail-opens.
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
    rules: structuredClone(desired.rules ?? []),
  }
}

export function updatedRoleLogs(log: ReturnType<typeof vi.spyOn>, needle: string): string[] {
  return log.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes('Updated Role') && line.includes(needle))
}
