import { expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// E2E_GUARDIAN_IPC_FLOW: Host lifecycle is observed read-only through Kubernetes;
// Desktop RPC runs in the main process, outside renderer HTTP observation.
const execFileAsync = promisify(execFile)
const STATELESS_NAMESPACE = 'mcp-host'

async function kubectl(context: string, args: string[]): Promise<string> {
  if (!context.trim() || context.startsWith('-'))
    throw new Error('An explicit kube context is required.')
  const { stdout } = await execFileAsync('kubectl', ['--context', context, ...args], {
    timeout: 20_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout.toString()
}

async function jsonKubectl(context: string, resource: string): Promise<any> {
  return JSON.parse(
    await kubectl(context, ['-n', STATELESS_NAMESPACE, 'get', resource, '-o', 'json'])
  )
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
    jsonKubectl(context, `deployment.apps/${deployment}`),
    jsonKubectl(context, `host/${hostName}`),
    kubectl(context, [
      '-n',
      STATELESS_NAMESPACE,
      'get',
      'pods',
      '-l',
      `app=${hostName}`,
      '-o',
      'json',
    ]),
  ])
  const pods = JSON.parse(podsJson).items ?? []
  const spec = deploymentJson.spec ?? {}
  const status = deploymentJson.status ?? {}
  const lifecycle = hostJson.status?.lifecycle ?? {}
  const pullPolicyRejection = (hostJson.status?.conditions ?? []).find(
    (condition: { type?: string; status?: string }) =>
      condition.type === 'StatelessPullPolicyRejected' && condition.status === 'True'
  )
  return {
    lifecycleState: String(lifecycle.state ?? ''),
    lifecycleReason: String(lifecycle.reason ?? ''),
    replicas: Number(spec.replicas ?? -1),
    readyReplicas: Number(status.readyReplicas ?? 0),
    podNames: pods
      .map((pod: { metadata?: { name?: string } }) => pod.metadata?.name)
      .filter(Boolean)
      .sort(),
    imageIds: [
      ...new Set<string>(
        pods.flatMap((pod: { status?: { containerStatuses?: Array<{ imageID?: string }> } }) =>
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
