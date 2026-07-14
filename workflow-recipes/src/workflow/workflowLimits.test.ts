import { describe, expect, it } from 'vitest'
import { validateWorkflowRecipeLimits } from './workflowLimits'

const config = {
  workflowMaxWorkloadsPerRecipe: 25,
  workflowUiEgressInternalMaxItems: 25,
  workflowMaxSteps: 100,
  workflowStepDependsOnMaxItems: 100,
  workflowStepAllowedToolsMaxItems: 50,
  workflowStepMcpServersMaxItems: 20,
  workflowMaxRunDurationSeconds: 3600,
  workflowStatefulSetMaxReplicas: 20,
  workflowStatefulSetMaxVolumeClaimTemplates: 4,
  workflowStatefulSetMaxPvcPreflightChecks: 80,
}

describe('validateWorkflowRecipeLimits egress limits', () => {
  it('fails closed when workloads exceed the configured maximum', () => {
    const error = validateWorkflowRecipeLimits(
      {
        workloads: Array.from({ length: 26 }, (_, index) => ({
          id: `service-${index}`,
          type: 'deployment',
          image: 'nginx:1.30.1-alpine',
        })),
      } as never,
      config
    )

    expect(error).toBe('spec.workloads must contain at most 25 items')
  })

  it('fails closed when UI internal egress refs exceed the configured maximum', () => {
    const error = validateWorkflowRecipeLimits(
      {
        ui: {
          workloadRef: 'web',
          port: 8080,
          egress: {
            internal: Array.from({ length: 26 }, (_, index) => ({
              workloadRef: `api-${index}`,
              port: 8000,
            })),
          },
        },
      } as never,
      config
    )

    expect(error).toBe('spec.ui.egress.internal must contain at most 25 items')
  })

  it('fails closed when workload egressBindings exceed the CRD maximum', () => {
    const error = validateWorkflowRecipeLimits(
      {
        workloads: [
          {
            id: 'web-search',
            egressBindings: Array.from({ length: 21 }, (_, index) => ({
              dns: `api-${index}.example.com`,
              port: 443,
              protocol: 'TCP',
            })),
          },
        ],
      } as never,
      config
    )

    expect(error).toBe('spec.workloads[0].egressBindings must contain at most 20 items')
  })

  it('fails closed when StatefulSet replicas exceed the configured maximum', () => {
    const error = validateWorkflowRecipeLimits(
      {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            replicas: 21,
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      } as never,
      {
        ...config,
        workflowStatefulSetMaxReplicas: 2,
        workflowStatefulSetMaxPvcPreflightChecks: 8,
      }
    )

    expect(error).toBe('spec.workloads[0].replicas must be at most 2')
  })

  it('fails closed when StatefulSet volumeClaimTemplates exceed the configured maximum', () => {
    const error = validateWorkflowRecipeLimits(
      {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            volumeClaimTemplates: Array.from({ length: 5 }, (_, index) => ({
              name: `data-${index}`,
              size: '10Gi',
              accessMode: 'ReadWriteOnce',
              storageClass: 'standard',
            })),
          },
        ],
      } as never,
      {
        ...config,
        workflowStatefulSetMaxVolumeClaimTemplates: 1,
        workflowStatefulSetMaxPvcPreflightChecks: 20,
      }
    )

    expect(error).toBe('spec.workloads[0].volumeClaimTemplates must contain at most 1 items')
  })

  it('fails closed when StatefulSet PVC ownership checks exceed the derived maximum', () => {
    const error = validateWorkflowRecipeLimits(
      {
        workloads: [
          {
            id: 'db',
            type: 'statefulset',
            image: 'postgres:16',
            replicas: 4,
            volumeClaimTemplates: [
              {
                name: 'pgdata',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
              {
                name: 'wal',
                size: '10Gi',
                accessMode: 'ReadWriteOnce',
                storageClass: 'standard',
              },
            ],
          },
        ],
      } as never,
      {
        ...config,
        workflowStatefulSetMaxReplicas: 4,
        workflowStatefulSetMaxVolumeClaimTemplates: 2,
        workflowStatefulSetMaxPvcPreflightChecks: 6,
      }
    )

    expect(error).toBe('spec.workloads[0] StatefulSet PVC ownership checks must be at most 6')
  })

  it('fails closed when runtime or step HTTP egress allowedHosts exceed the maximum', () => {
    const hosts = Array.from({ length: 21 }, (_, index) => `api-${index}.example.com`)
    const error = validateWorkflowRecipeLimits(
      {
        runtimeEgress: { http: { allowedHosts: hosts } },
        steps: [
          {
            id: 'fetch',
            run: { capabilities: { http: { allowedHosts: hosts } } },
          },
        ],
      } as never,
      config
    )

    expect(error).toBe('spec.runtimeEgress.http.allowedHosts must contain at most 20 items')
  })
})
