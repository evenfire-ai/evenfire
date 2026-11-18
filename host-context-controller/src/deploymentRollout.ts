import type * as k8s from '@kubernetes/client-node'

export type DeploymentRolloutEvaluation = {
  ready: boolean
  generation: number
  detail: string
}

/**
 * Evaluate a Deployment's rollout state, generation-aware.
 *
 * `readyReplicas > 0` is NOT enough (issue #223): during a rolling update the
 * OLD pod is still Ready, so a new pod that never starts would be reported as
 * healthy. A rollout has actually converged only when the controller has
 * observed the current generation AND every replica is updated, ready, and
 * available.
 *
 * `totalReplicas === updatedReplicas` is the part that catches a FAILED
 * rollout of a credential rotation (issue #223, E2): with replicas=1 and the
 * default RollingUpdate (maxSurge=1, maxUnavailable=0), a new pod that
 * crash-loops on a bad credential never becomes Ready, so Kubernetes keeps
 * the OLD pod. That old pod holds readyReplicas=1 and availableReplicas=1, so
 * unavailableReplicas stays 0 and updatedReplicas reaches 1 — every other
 * signal looks converged. Only `status.replicas` (total managed pods) reveals
 * the leftover: it stays at 2 while the new pod crash-loops, and drops to 1
 * only once the rollout truly completes. Without this check the poll would
 * report a failed rotation as healthy and never write RolloutIncomplete.
 *
 * `detail` carries the numbers into status conditions so a stuck rollout says
 * what is stuck instead of just "not ready".
 *
 * `generation` is the Deployment's `metadata.generation`, exposed so a caller
 * can tell "same rollout, keep counting" apart from "NEW rollout, fresh
 * window" (issue #223, E2). It plays no part in the readiness verdict above.
 */
export function evaluateDeploymentRollout(
  deployment: k8s.V1Deployment
): DeploymentRolloutEvaluation {
  const desired = deployment.spec?.replicas ?? 1
  const generation = deployment.metadata?.generation ?? 0
  const observedGeneration = deployment.status?.observedGeneration ?? 0
  const updatedReplicas = deployment.status?.updatedReplicas ?? 0
  const readyReplicas = deployment.status?.readyReplicas ?? 0
  const totalReplicas = deployment.status?.replicas ?? 0
  const unavailableReplicas = deployment.status?.unavailableReplicas ?? 0

  const ready =
    observedGeneration >= generation &&
    updatedReplicas === desired &&
    readyReplicas === desired &&
    totalReplicas === updatedReplicas &&
    unavailableReplicas === 0

  return {
    ready,
    generation,
    detail:
      `generation ${observedGeneration}/${generation}, ` +
      `updated ${updatedReplicas}/${desired}, ready ${readyReplicas}/${desired}, ` +
      `total ${totalReplicas}, unavailable ${unavailableReplicas}`,
  }
}
