import { vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'
import { updatedLogs } from '../../test/__fixtures__/updatedLogs'

/**
 * Recorded kube-apiserver GET of a NetworkPolicy after client-node decode
 * (`from` → `_from`), not a field list copied from the comparator.
 * Stamp controller-owned name/labels/podSelector/rules via
 * `asApiserverNetworkPolicy`. Nested port defaults are merged from this blob
 * (and `RECORDED_DEFAULT_PORT`) onto desired ports so a newer apiserver
 * default-fill goes red until the comparator learns it. Do not reconstruct
 * ports from desired alone.
 */

/** Recorded apiserver default-fill on a port that omits protocol. */
const RECORDED_DEFAULT_PORT: k8s.V1NetworkPolicyPort = { protocol: 'TCP' }

/** Recorded apiserver policyTypes when the live object has egress rules. */
const RECORDED_EGRESS_POLICY_TYPES: string[] = ['Ingress', 'Egress']
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
  recordedRules: typeof rules,
  driftPort?: number
): typeof rules {
  if (!rules) return rules
  return rules.map((rule, ruleIndex) => {
    const recordedRule = recordedRules?.[ruleIndex]
    if (!rule.ports) return { ...recordedRule, ...rule, ports: undefined }
    return {
      ...recordedRule,
      ...rule,
      ports: rule.ports.map((port, portIndex) => {
        const recordedPort = recordedRule?.ports?.[portIndex]
        return {
          ...RECORDED_DEFAULT_PORT,
          ...recordedPort,
          ...port,
          protocol: port.protocol ?? recordedPort?.protocol ?? RECORDED_DEFAULT_PORT.protocol,
          port:
            ruleIndex === 0 && portIndex === 0 && driftPort !== undefined ? driftPort : port.port,
        }
      }),
    }
  })
}

export function asApiserverNetworkPolicy(
  desired: k8s.V1NetworkPolicy,
  drift?: { port?: number }
): k8s.V1NetworkPolicy {
  const recorded = structuredClone(RECORDED_NETWORKPOLICY)
  const hasEgress = (desired.spec?.egress?.length ?? 0) > 0
  const explicitTypes = desired.spec?.policyTypes
  const policyTypes =
    explicitTypes && explicitTypes.length > 0
      ? explicitTypes
      : hasEgress
        ? [...RECORDED_EGRESS_POLICY_TYPES]
        : [...(recorded.spec?.policyTypes ?? ['Ingress'])]
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
      ingress: stampPorts(desired.spec?.ingress, recorded.spec?.ingress, drift?.port),
      egress: stampPorts(
        desired.spec?.egress,
        recorded.spec?.egress,
        desired.spec?.ingress ? undefined : drift?.port
      ),
    },
  }
}

export function updatedPolicyLogs(log: ReturnType<typeof vi.spyOn>, needle: string): string[] {
  return updatedLogs(log, 'Updated', needle)
}
