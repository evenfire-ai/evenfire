import { expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// E2E_GUARDIAN_IPC_FLOW: Host lifecycle is observed read-only through Kubernetes;
// Desktop RPC runs in the main process, outside renderer HTTP observation.
const execFileAsync = promisify(execFile)
const HOST_NAMESPACE = 'mcp-host'

export async function kubectl(
  context: string,
  args: string[],
  timeoutMs = 20_000
): Promise<string> {
  if (!context.trim() || context.startsWith('-'))
    throw new Error('An explicit kube context is required.')
  const { stdout } = await execFileAsync('kubectl', ['--context', context, ...args], {
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout.toString()
}

export async function jsonKubectl<T>(
  context: string,
  namespace: string,
  resource: string
): Promise<T> {
  return JSON.parse(await kubectl(context, ['-n', namespace, 'get', resource, '-o', 'json'])) as T
}

/** The fields of the Deployment, Host and Pod JSON that a snapshot reads. */
type DeploymentJson = { spec?: { replicas?: number }; status?: { readyReplicas?: number } }
type HostJson = {
  status?: {
    lifecycle?: { state?: string; reason?: string }
    conditions?: Array<{ type?: string; status?: string; reason?: string }>
  }
}
type PodListJson = {
  items?: Array<{
    metadata?: { name?: string }
    status?: { containerStatuses?: Array<{ imageID?: string }> }
  }>
}

export type HostSnapshot = {
  lifecycleState: string
  lifecycleReason: string
  replicas: number
  readyReplicas: number
  podNames: string[]
  imageIds: string[]
  pullPolicyRejection: string | null
}

export async function readHostSnapshot(
  deployment: string,
  hostName: string,
  context: string
): Promise<HostSnapshot> {
  const [deploymentJson, hostJson, podsJson] = await Promise.all([
    jsonKubectl<DeploymentJson>(context, HOST_NAMESPACE, `deployment.apps/${deployment}`),
    jsonKubectl<HostJson>(context, HOST_NAMESPACE, `host/${hostName}`),
    kubectl(context, ['-n', HOST_NAMESPACE, 'get', 'pods', '-l', `app=${hostName}`, '-o', 'json']),
  ])
  const pods = (JSON.parse(podsJson) as PodListJson).items ?? []
  const lifecycle = hostJson.status?.lifecycle ?? {}
  const pullPolicyRejection = (hostJson.status?.conditions ?? []).find(
    condition => condition.type === 'StatelessPullPolicyRejected' && condition.status === 'True'
  )
  return {
    lifecycleState: String(lifecycle.state ?? ''),
    lifecycleReason: String(lifecycle.reason ?? ''),
    replicas: Number(deploymentJson.spec?.replicas ?? -1),
    readyReplicas: Number(deploymentJson.status?.readyReplicas ?? 0),
    podNames: pods
      .map(pod => pod.metadata?.name)
      .filter((name): name is string => Boolean(name))
      .sort(),
    imageIds: [
      ...new Set<string>(
        pods.flatMap(pod =>
          (pod.status?.containerStatuses ?? [])
            .map(container => container.imageID)
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
        )
      ),
    ].sort(),
    pullPolicyRejection: pullPolicyRejection?.reason ?? null,
  }
}

export async function waitForStatelessSuspended(
  timeoutMs: number,
  context: string,
  deployment: string,
  hostName: string
): Promise<{
  snapshot: HostSnapshot
  elapsedMs: number
}> {
  const started = Date.now()
  let last = await readHostSnapshot(deployment, hostName, context)
  while (Date.now() - started < timeoutMs) {
    last = await readHostSnapshot(deployment, hostName, context)
    if (
      last.lifecycleState === 'suspended' &&
      last.replicas === 0 &&
      last.readyReplicas === 0 &&
      last.podNames.length === 0
    ) {
      expect(last.lifecycleReason, 'stateless suspension must be caused by idle timeout').toBe(
        'idle'
      )
      return { snapshot: last, elapsedMs: Date.now() - started }
    }
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
  throw new Error(
    `Stateless host did not reach verified replicas-0 suspension: ${JSON.stringify(last)}`
  )
}

export async function waitForStatelessReady(
  timeoutMs: number,
  context: string,
  deployment: string,
  hostName: string
): Promise<{
  snapshot: HostSnapshot
  elapsedMs: number
}> {
  const started = Date.now()
  let last = await readHostSnapshot(deployment, hostName, context)
  while (Date.now() - started < timeoutMs) {
    last = await readHostSnapshot(deployment, hostName, context)
    if (last.replicas >= 1 && last.readyReplicas >= 1 && last.podNames.length > 0) {
      return { snapshot: last, elapsedMs: Date.now() - started }
    }
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  throw new Error(`Stateless host did not become Ready: ${JSON.stringify(last)}`)
}
