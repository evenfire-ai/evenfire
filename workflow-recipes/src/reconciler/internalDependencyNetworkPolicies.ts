import * as k8s from '@kubernetes/client-node'
import { createHash } from 'node:crypto'
import type { WorkflowRecipeCRD, WorkloadDef } from '../types'

export const INTERNAL_DEPENDENCY_POLICY_TYPE = 'internal-dependency'
export const INTERNAL_DEPENDENCY_DESIRED_HASH_ANNOTATION =
  'clerum.io/internal-dependency-desired-hash'
export const NETWORK_POLICY_TYPE_LABEL = 'clerum.io/policy-type'
export const NETWORK_POLICY_DIRECTION_LABEL = 'clerum.io/policy-direction'
export const NETWORK_POLICY_SOURCE_WORKLOAD_LABEL = 'clerum.io/source-workload'
export const NETWORK_POLICY_TARGET_WORKLOAD_LABEL = 'clerum.io/target-workload'

const MANAGED_BY_LABEL = 'clerum.io/managed-by'
const RECIPE_LABEL = 'clerum.io/recipe'
const WORKLOAD_LABEL = 'clerum.io/workload'
const RECIPE_NAMESPACE_LABEL = 'clerum.io/recipe-namespace'
const RECIPE_NAME_LABEL = 'clerum.io/recipe-name'

export interface InternalDependencyPolicyTarget {
  targetWorkloadId: string
  targetNamespace: string
  port: number
  protocol: 'TCP' | 'UDP'
}

export interface InternalDependencyPolicySource {
  sourceWorkloadId: string
  sourceNamespace: string
  port: number
  protocol: 'TCP' | 'UDP'
}

function composePolicyName(prefix: string, recipeName: string, workloadId: string): string {
  const direct = `${prefix}-${recipeName}-${workloadId}`
  if (direct.length <= 63) return direct

  const hash = createHash('sha256').update(direct).digest('hex').slice(0, 8)
  const segmentBudget = Math.max(2, 63 - prefix.length - 3 - hash.length)
  const recipeBudget = Math.max(1, Math.floor(segmentBudget / 2))
  const workloadBudget = Math.max(1, segmentBudget - recipeBudget)
  let resolvedRecipeBudget = Math.min(recipeName.length, recipeBudget)
  let resolvedWorkloadBudget = Math.min(workloadId.length, workloadBudget)
  let remaining = segmentBudget - resolvedRecipeBudget - resolvedWorkloadBudget

  if (remaining > 0 && resolvedRecipeBudget < recipeName.length) {
    const add = Math.min(remaining, recipeName.length - resolvedRecipeBudget)
    resolvedRecipeBudget += add
    remaining -= add
  }
  if (remaining > 0 && resolvedWorkloadBudget < workloadId.length) {
    const add = Math.min(remaining, workloadId.length - resolvedWorkloadBudget)
    resolvedWorkloadBudget += add
  }

  const recipeStem =
    recipeName.slice(0, resolvedRecipeBudget).replace(/-+$/g, '') ||
    'recipe'.slice(0, resolvedRecipeBudget)
  const workloadStem =
    workloadId.slice(0, resolvedWorkloadBudget).replace(/-+$/g, '') ||
    'workload'.slice(0, resolvedWorkloadBudget)
  return `${prefix}-${recipeStem}-${workloadStem}-${hash}`
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function desiredHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16)
}

function baseLabels(
  recipe: WorkflowRecipeCRD,
  direction: 'egress' | 'ingress'
): Record<string, string> {
  const recipeName = recipe.metadata.name
  return {
    [MANAGED_BY_LABEL]: 'workflow-recipes',
    [RECIPE_LABEL]: recipeName,
    [RECIPE_NAMESPACE_LABEL]: recipe.metadata.namespace ?? '',
    [RECIPE_NAME_LABEL]: recipeName,
    [NETWORK_POLICY_TYPE_LABEL]: INTERNAL_DEPENDENCY_POLICY_TYPE,
    [NETWORK_POLICY_DIRECTION_LABEL]: direction,
  }
}

export function internalDependencyEgressPolicyName(
  recipeName: string,
  sourceWorkloadId: string
): string {
  return composePolicyName('wr-intdep-egress', recipeName, sourceWorkloadId)
}

export function internalDependencyIngressPolicyName(
  recipeName: string,
  targetWorkloadId: string
): string {
  return composePolicyName('wr-intdep-ingress', recipeName, targetWorkloadId)
}

export function buildInternalDependencyEgressNetworkPolicy(
  sourceWorkload: WorkloadDef,
  recipe: WorkflowRecipeCRD,
  sourceNamespace: string,
  targets: InternalDependencyPolicyTarget[]
): k8s.V1NetworkPolicy | null {
  if (targets.length === 0) return null

  const recipeName = recipe.metadata.name
  const sortedTargets = [...targets].sort((a, b) =>
    [a.targetNamespace, a.targetWorkloadId, String(a.port), a.protocol]
      .join('\0')
      .localeCompare([b.targetNamespace, b.targetWorkloadId, String(b.port), b.protocol].join('\0'))
  )

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: internalDependencyEgressPolicyName(recipeName, sourceWorkload.id),
      namespace: sourceNamespace,
      labels: {
        ...baseLabels(recipe, 'egress'),
        [WORKLOAD_LABEL]: sourceWorkload.id,
        [NETWORK_POLICY_SOURCE_WORKLOAD_LABEL]: sourceWorkload.id,
      },
      annotations: {
        [INTERNAL_DEPENDENCY_DESIRED_HASH_ANNOTATION]: desiredHash({
          sourceWorkloadId: sourceWorkload.id,
          sourceNamespace,
          targets: sortedTargets,
        }),
      },
    },
    spec: {
      podSelector: {
        matchLabels: {
          [MANAGED_BY_LABEL]: 'workflow-recipes',
          [RECIPE_LABEL]: recipeName,
          [WORKLOAD_LABEL]: sourceWorkload.id,
        },
      },
      policyTypes: ['Egress'],
      egress: sortedTargets.map(target => ({
        to: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': target.targetNamespace },
            },
            podSelector: {
              matchLabels: {
                [MANAGED_BY_LABEL]: 'workflow-recipes',
                [RECIPE_LABEL]: recipeName,
                [WORKLOAD_LABEL]: target.targetWorkloadId,
              },
            },
          },
        ],
        ports: [{ port: target.port, protocol: target.protocol }],
      })),
    },
  }
}

export function buildInternalDependencyIngressNetworkPolicy(
  targetWorkload: WorkloadDef,
  recipe: WorkflowRecipeCRD,
  targetNamespace: string,
  sources: InternalDependencyPolicySource[]
): k8s.V1NetworkPolicy | null {
  if (sources.length === 0) return null

  const recipeName = recipe.metadata.name
  const sortedSources = [...sources].sort((a, b) =>
    [a.sourceNamespace, a.sourceWorkloadId, String(a.port), a.protocol]
      .join('\0')
      .localeCompare([b.sourceNamespace, b.sourceWorkloadId, String(b.port), b.protocol].join('\0'))
  )

  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: internalDependencyIngressPolicyName(recipeName, targetWorkload.id),
      namespace: targetNamespace,
      labels: {
        ...baseLabels(recipe, 'ingress'),
        [WORKLOAD_LABEL]: targetWorkload.id,
        [NETWORK_POLICY_TARGET_WORKLOAD_LABEL]: targetWorkload.id,
      },
      annotations: {
        [INTERNAL_DEPENDENCY_DESIRED_HASH_ANNOTATION]: desiredHash({
          targetWorkloadId: targetWorkload.id,
          targetNamespace,
          sources: sortedSources,
        }),
      },
    },
    spec: {
      podSelector: {
        matchLabels: {
          [MANAGED_BY_LABEL]: 'workflow-recipes',
          [RECIPE_LABEL]: recipeName,
          [WORKLOAD_LABEL]: targetWorkload.id,
        },
      },
      policyTypes: ['Ingress'],
      ingress: sortedSources.map(source => ({
        _from: [
          {
            namespaceSelector: {
              matchLabels: { 'kubernetes.io/metadata.name': source.sourceNamespace },
            },
            podSelector: {
              matchLabels: {
                [MANAGED_BY_LABEL]: 'workflow-recipes',
                [RECIPE_LABEL]: recipeName,
                [WORKLOAD_LABEL]: source.sourceWorkloadId,
              },
            },
          },
        ],
        ports: [{ port: source.port, protocol: source.protocol }],
      })),
    },
  }
}
