import type * as k8s from '@kubernetes/client-node'

/**
 * Adapted from host-context-controller/src/__tests__/asApiserverNetworkPolicy.ts.
 * Dropped: `driftPort`, `updatedPolicyLogs`, and the merge of recorded peers.
 * The packages are separate npm projects without a workspace, so the fixture
 * cannot be imported across them.
 *
 * Recorded kube-apiserver GET of a NetworkPolicy after client-node decode
 * (`from` → `_from`), not a field list copied from the comparator. Nested port
 * defaults are merged from this blob (and `RECORDED_DEFAULT_PORT`) onto desired
 * ports so a newer apiserver default-fill goes red until the comparator learns
 * it. Do not reconstruct ports from desired alone.
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
  recordedRules: typeof rules
): typeof rules {
  if (!rules) return rules
  // Unlike the HCC original, recorded peers are not merged into the rule: a
  // desired rule without `_from`/`to` (allow-all) must not gain a recorded peer
  // the apiserver never adds. Only port defaults come from the recording.
  return rules.map((rule, ruleIndex) => {
    const recordedRule = recordedRules?.[ruleIndex]
    if (!rule.ports) return { ...rule, ports: undefined }
    return {
      ...rule,
      ports: rule.ports.map((port, portIndex) => {
        const recordedPort = recordedRule?.ports?.[portIndex]
        return {
          ...RECORDED_DEFAULT_PORT,
          ...recordedPort,
          ...port,
          protocol: port.protocol ?? recordedPort?.protocol ?? RECORDED_DEFAULT_PORT.protocol,
        }
      }),
    }
  })
}

/**
 * The object a GET returns after the apiserver stored `desired`: recorded
 * server metadata, desired identity labels/annotations, and default-filled
 * spec fields. The caller sets the resourceVersion it wants to model.
 */
export function asApiserverNetworkPolicy(desired: k8s.V1NetworkPolicy): k8s.V1NetworkPolicy {
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
      annotations: desired.metadata?.annotations,
      ownerReferences: desired.metadata?.ownerReferences,
      selfLink: `/apis/networking.k8s.io/v1/namespaces/${desired.metadata?.namespace}/networkpolicies/${desired.metadata?.name}`,
    },
    spec: {
      ...recorded.spec,
      podSelector: desired.spec?.podSelector ?? {},
      policyTypes,
      ingress: stampPorts(desired.spec?.ingress, recorded.spec?.ingress),
      egress: stampPorts(desired.spec?.egress, recorded.spec?.egress),
    },
  }
}
