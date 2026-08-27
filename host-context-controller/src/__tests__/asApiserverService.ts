import { vi } from 'vitest'
import type * as k8s from '@kubernetes/client-node'

/**
 * Recorded kube-apiserver GET of a ClusterIP Service (`kubectl get svc -o json`
 * shape), not a field list copied from `normalizeServiceForComparison`.
 * Stamp controller-owned name/selector/ports via `asApiserverService`.
 * When a newer apiserver default-fills a field, refresh this blob so the
 * suite goes red until the comparator learns that default.
 */
export const RECORDED_CLUSTERIP_SERVICE: k8s.V1Service = {
  apiVersion: 'v1',
  kind: 'Service',
  metadata: {
    annotations: {
      'kubectl.kubernetes.io/last-applied-configuration': '{}',
    },
    creationTimestamp: new Date('2026-04-01T00:00:00.000Z'),
    generation: 1,
    managedFields: [
      {
        apiVersion: 'v1',
        fieldsType: 'FieldsV1',
        fieldsV1: { 'f:spec': { 'f:ports': {} } },
        manager: 'kube-apiserver',
        operation: 'Update',
        time: new Date('2026-04-01T00:00:00.000Z'),
      },
    ],
    name: 'recorded-svc',
    namespace: 'recorded-ns',
    resourceVersion: '1776125',
    uid: '11111111-2222-3333-4444-555555555555',
    selfLink: '/api/v1/namespaces/recorded-ns/services/recorded-svc',
  },
  spec: {
    clusterIP: '10.96.14.7',
    clusterIPs: ['10.96.14.7'],
    internalTrafficPolicy: 'Cluster',
    ipFamilies: ['IPv4'],
    ipFamilyPolicy: 'SingleStack',
    ports: [{ name: 'http', port: 8080, protocol: 'TCP', targetPort: 8080 }],
    selector: { app: 'recorded' },
    sessionAffinity: 'None',
    type: 'ClusterIP',
  },
  status: { loadBalancer: {} },
}

export function asApiserverService(
  desired: k8s.V1Service,
  drift?: { port?: number }
): k8s.V1Service {
  const recorded = structuredClone(RECORDED_CLUSTERIP_SERVICE)
  const ports = (desired.spec?.ports ?? []).map(port => ({
    protocol: 'TCP' as const,
    name: port.name,
    port: drift?.port ?? port.port,
    targetPort: port.targetPort ?? port.port,
  }))
  return {
    ...recorded,
    metadata: {
      ...recorded.metadata,
      name: desired.metadata?.name,
      namespace: desired.metadata?.namespace,
      labels: desired.metadata?.labels,
      annotations: {
        ...recorded.metadata?.annotations,
        ...desired.metadata?.annotations,
      },
      ownerReferences: desired.metadata?.ownerReferences,
      selfLink: `/api/v1/namespaces/${desired.metadata?.namespace}/services/${desired.metadata?.name}`,
    },
    spec: {
      ...recorded.spec,
      selector: desired.spec?.selector,
      ports,
    },
  }
}

export function updatedServiceLogs(log: ReturnType<typeof vi.spyOn>, needle: string): string[] {
  return log.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes('Updated') && line.includes(needle))
}
