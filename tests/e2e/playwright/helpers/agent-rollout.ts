import { execFileSync } from 'node:child_process'
import { required } from './approved-tools-scenarios'

// Saving a model binding or an approval map changes the agent's contract, which
// makes HCC rotate the runtime token and roll the Deployment
// (`host-context-controller/src/hostReconciler.ts:1402`, `rolloutRequired:
// true`). While that rollout is in flight the old pod is terminating and
// rpc-proxy answers `list-models` through its legacy error path
// (`rpc-proxy/src/routes/rpc.ts:1056-1119`), so the Desktop model store lands in
// `loadFailed` and renders "Models unavailable" instead of the model menu. A
// test that saves and immediately launches the Desktop app is racing that
// rollout.
//
// The fixture creates every agent Host in `mcp-host`
// (`scripts/e2e/prepare-codex-approved-tools.mjs:230`) and HCC names the
// Deployment after the Host in the Host's own namespace (`hostReconciler.ts:3526`),
// so the object is `mcp-host/<agentName>` by construction, not by convention.
const NAMESPACE = 'mcp-host'
const POLL_INTERVAL_MS = 2_000

type DeploymentSnapshot = {
  generation: number
  observedGeneration: number
  replicas: number
  updatedReplicas: number
  readyReplicas: number
  availableReplicas: number
  unavailableReplicas: number
}

function readAgentDeployment(agentName: string): DeploymentSnapshot {
  const raw = execFileSync(
    'kubectl',
    [
      '--context',
      required('MINIKUBE_PROFILE'),
      '--request-timeout=30s',
      '-n',
      NAMESPACE,
      'get',
      `deployment/${agentName}`,
      '-o',
      'json',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
  const deployment = JSON.parse(raw) as {
    metadata?: { generation?: number }
    spec?: { replicas?: number }
    status?: {
      observedGeneration?: number
      updatedReplicas?: number
      readyReplicas?: number
      availableReplicas?: number
      unavailableReplicas?: number
    }
  }
  return {
    generation: deployment.metadata?.generation ?? 0,
    observedGeneration: deployment.status?.observedGeneration ?? 0,
    replicas: deployment.spec?.replicas ?? 0,
    updatedReplicas: deployment.status?.updatedReplicas ?? 0,
    readyReplicas: deployment.status?.readyReplicas ?? 0,
    availableReplicas: deployment.status?.availableReplicas ?? 0,
    unavailableReplicas: deployment.status?.unavailableReplicas ?? 0,
  }
}

export function readAgentDeploymentGeneration(agentName: string): number {
  return readAgentDeployment(agentName).generation
}

export async function waitForAgentRollout(
  agentName: string,
  baselineGeneration: number,
  timeoutMs = 120_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let convergedGeneration: number | undefined
  let last: DeploymentSnapshot | undefined
  while (Date.now() < deadline) {
    const snapshot = readAgentDeployment(agentName)
    last = snapshot
    const converged =
      // The generation moving past the baseline is the liveness witness: if the
      // save triggered no rollout at all, this waits and then fails, rather than
      // returning instantly on a Deployment that was already converged.
      snapshot.generation > baselineGeneration &&
      snapshot.observedGeneration >= snapshot.generation &&
      snapshot.replicas > 0 &&
      snapshot.updatedReplicas === snapshot.replicas &&
      snapshot.readyReplicas === snapshot.replicas &&
      snapshot.availableReplicas === snapshot.replicas &&
      snapshot.unavailableReplicas === 0
    // Two consecutive polls on the same generation. A second spec change landing
    // late bumps the generation again, and a single converged reading would
    // otherwise describe a rollout that is already obsolete.
    if (converged && convergedGeneration === snapshot.generation) return
    convergedGeneration = converged ? snapshot.generation : undefined
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(
    `Agent ${agentName} did not converge within ${timeoutMs} ms of generation ${baselineGeneration}: ` +
      JSON.stringify(last)
  )
}
