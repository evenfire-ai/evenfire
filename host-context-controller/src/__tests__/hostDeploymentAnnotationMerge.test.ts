import { describe, expect, it } from 'vitest'
import * as k8s from '@kubernetes/client-node'
import { preserveDeploymentAnnotationsExcept } from '../hostReconciler'

const GUARDRAILS = 'clerum.io/guardrails-revision'
const RESTARTED_AT = 'kubectl.kubernetes.io/restartedAt'

function deployment(templateAnnotations?: Record<string, string>): k8s.V1Deployment {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'chatllm', namespace: 'mcp-host' },
    spec: {
      selector: { matchLabels: { app: 'chatllm' } },
      template: {
        metadata: { ...(templateAnnotations ? { annotations: templateAnnotations } : {}) },
        spec: { containers: [] },
      },
    },
  }
}

const merge = (desired: k8s.V1Deployment, existing: k8s.V1Deployment) =>
  preserveDeploymentAnnotationsExcept(desired, existing, [GUARDRAILS])?.spec?.template?.metadata
    ?.annotations

describe('preserveDeploymentAnnotationsExcept — pod-template merge', () => {
  // T5 regression. `mergeAnnotations` is {...existing, ...desired}, so before this
  // an omitted controller-owned key kept its live value: dropping spec.guardrails
  // produced a pod template byte-identical to the running one, deploymentMatches-
  // Desired returned true, and replaceWithConflictRetry skipped the write. The
  // agent kept enforcing guardrails the operator had uninstalled.
  it('drops a controller-owned annotation the desired template omits', () => {
    const merged = merge(deployment(), deployment({ [GUARDRAILS]: 'abc123' }))

    expect(merged?.[GUARDRAILS]).toBeUndefined()
  })

  it('produces a pod-template diff on removal, so the pod rolls', () => {
    const existing = deployment({ [GUARDRAILS]: 'abc123' })
    const merged = merge(deployment(), existing)

    expect(merged).not.toEqual(existing.spec?.template?.metadata?.annotations)
  })

  it('keeps the desired value when guardrails are present', () => {
    const merged = merge(deployment({ [GUARDRAILS]: 'new' }), deployment({ [GUARDRAILS]: 'old' }))

    expect(merged?.[GUARDRAILS]).toBe('new')
  })

  it('preserves operator/runtime annotations HCC does not author', () => {
    const merged = merge(
      deployment(),
      deployment({ [GUARDRAILS]: 'abc123', [RESTARTED_AT]: '2026-08-18T10:00:00Z' })
    )

    expect(merged?.[RESTARTED_AT]).toBe('2026-08-18T10:00:00Z')
    expect(merged?.[GUARDRAILS]).toBeUndefined()
  })

  it('leaves annotations undefined when the drop empties the map', () => {
    const merged = merge(deployment(), deployment({ [GUARDRAILS]: 'abc123' }))

    expect(merged).toBeUndefined()
  })

  it('is a no-op when neither side carries the controller-owned key', () => {
    const merged = merge(deployment({ [RESTARTED_AT]: 'x' }), deployment())

    expect(merged).toEqual({ [RESTARTED_AT]: 'x' })
  })
})
