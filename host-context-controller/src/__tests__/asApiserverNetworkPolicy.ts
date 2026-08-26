import { vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'

/**
 * Recorded kube-apiserver GET of a NetworkPolicy after client-node decode
 * (`from` → `_from`), not a field list copied from the comparator.
 * Stamp controller-owned name/labels/podSelector/rules via
 * `asApiserverNetworkPolicy`. When a newer apiserver default-fills a field,
 * refresh this blob so the suite goes red until the comparator learns it.
 */
export const RECORDED_NETWORKPOLICY: k8s.V1NetworkPolicy = {
  apiVersion: 'networking.k8s.io/v1',
  kind: 'NetworkPolicy',
  metadata: {
    annotations: {
      'kubectl.kubernetes.io/last-applied-configuration': '{}',
    },
    creationTimestamp: new Date('2026-04-01T00:00:00.000Z'),
    generation: 1,
    managedFields: [
      {
        apiVersion: 'networking.k8s.io/v1',
        fieldsType: 'FieldsV1',
        fieldsV1: { 'f:spec': { 'f:podSelector': {} } },
        manager: 'kube-apiserver',
        operation: 'Update',
        time: new Date('2026-04-01T00:00:00.000Z'),
      },
    ],
    name: 'recorded-np',
    namespace: 'recorded-ns',
    resourceVersion: '1783417',
    uid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    selfLink: '/apis/networking.k8s.io/v1/namespaces/recorded-ns/networkpolicies/recorded-np',
  },
  spec: {
    podSelector: { matchLabels: { app: 'recorded' } },
    policyTypes: ['Ingress'],
    ingress: [
      {
        _from: [{ podSelector: { matchLabels: { app: 'peer' } } }],
        ports: [{ port: 8080, protocol: 'TCP' }],
      },
    ],
  },
}

function stampPorts(
  rules: k8s.V1NetworkPolicyIngressRule[] | k8s.V1NetworkPolicyEgressRule[] | undefined,
  driftPort?: number
): typeof rules {
  if (!rules) return rules
  return rules.map((rule, ruleIndex) => ({
    ...rule,
    ports: (rule.ports ?? []).map((port, portIndex) => ({
      ...port,
      protocol: port.protocol ?? 'TCP',
      port: ruleIndex === 0 && portIndex === 0 && driftPort !== undefined ? driftPort : port.port,
    })),
  }))
}

export function asApiserverNetworkPolicy(
  desired: k8s.V1NetworkPolicy,
  drift?: { port?: number }
): k8s.V1NetworkPolicy {
  const recorded = structuredClone(RECORDED_NETWORKPOLICY)
  const hasEgress = (desired.spec?.egress?.length ?? 0) > 0
  const policyTypes = desired.spec?.policyTypes ?? (hasEgress ? ['Ingress', 'Egress'] : ['Ingress'])
  return {
    ...recorded,
    metadata: {
      ...recorded.metadata,
      name: desired.metadata?.name,
      namespace: desired.metadata?.namespace,
      labels: desired.metadata?.labels,
      // Do not merge recorded last-applied: the shared helper has no
      // mergeExisting, so an extra live annotation is a real write.
      annotations: desired.metadata?.annotations,
      ownerReferences: desired.metadata?.ownerReferences,
      selfLink: `/apis/networking.k8s.io/v1/namespaces/${desired.metadata?.namespace}/networkpolicies/${desired.metadata?.name}`,
    },
    spec: {
      ...recorded.spec,
      podSelector: desired.spec?.podSelector ?? {},
      policyTypes,
      ingress: stampPorts(desired.spec?.ingress, drift?.port),
      egress: stampPorts(desired.spec?.egress, desired.spec?.ingress ? undefined : drift?.port),
    },
  }
}

export function updatedPolicyLogs(log: ReturnType<typeof vi.spyOn>, needle: string): string[] {
  return log.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes('Updated') && line.includes(needle))
}
