// desktop-app/test/e2e-playwright/helpers/legacyLeaseRestart.ts
//
// E2E_GUARDIAN_IPC_FLOW: this module drives no browser transition. It owns the
// cluster side of the legacy processing-lease restart lane (issue #1022): the
// workload stop/start scenarios, the seed of one legacy lease on the Host PVC,
// and read-only readers for the three signals the spec asserts after each
// scenario. The Desktop journey itself lives in the spec.
//
// Every kubectl call names the validated branch profile as its context and is
// bounded by a timeout. Arguments travel as a vector, never through a shell.
// Waits poll a live condition with a deadline; none of them is a fixed sleep.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

const PROFILE_PATTERN = /^clerum-.+-[a-f0-9]{8}$/
const RUN_ID_PATTERN = /^image-capabilities-[a-f0-9]{12}$/
const SHA256_HEX = /^[a-f0-9]{64}$/

export const LEGACY_LEASE_LANE_MODES = ['fixed', 'vacuity'] as const
export type LegacyLeaseLaneMode = (typeof LEGACY_LEASE_LANE_MODES)[number]

/** The Host whose PVC carries the GFS download store (the fixture lane's Host). */
export const HOST = {
  namespace: 'mcp-host',
  deployment: 'chatllm',
  container: 'mcp-host',
  selector: 'app=chatllm',
} as const
export const HCC = {
  namespace: 'control-plane',
  deployment: 'host-context-controller',
  selector: 'app=host-context-controller',
} as const
export const WRC = {
  namespace: 'control-plane',
  deployment: 'workflow-recipes',
  selector: 'app=workflow-recipes',
} as const
export const GFS_WORKLOADS = [
  {
    namespace: 'gfs',
    deployment: 'gfsc-writer',
    selector: 'app=gfs-controller,clerum.io/gfsc-role=writer',
  },
  {
    namespace: 'gfs',
    deployment: 'gfsc-reader',
    selector: 'app=gfs-controller,clerum.io/gfsc-role=reader',
  },
] as const

/** The store ledger on the Host PVC, mounted at /workspace. */
export const STORE_LEDGER_PATH = '/workspace/.gfs-download-store/ledger-v1.json'
export const LEGACY_DISCARD_COUNTER = 'clerum_gfs_legacy_processing_leases_discarded_total'
const STORE_LOG_COMPONENT = 'GfsDownloadStore'
const DISCARD_MSG_PREFIX = 'GFS download store discarded '
const UNKNOWN_MSG_PREFIX = 'GFS download store could not confirm the discard of '

export const SEED_LABEL_KEY = 'evenfire.ai/legacy-lease-seed'

export interface LegacyLeaseLaneEnv {
  profile: string
  mode: LegacyLeaseLaneMode
  runId: string
}

/** Reads and validates the runner-owned bindings of this lane. */
export function requireLegacyLeaseLaneEnv(
  env: NodeJS.ProcessEnv = process.env
): LegacyLeaseLaneEnv {
  const problems: string[] = []
  const profile = (env.MINIKUBE_PROFILE ?? '').trim()
  if (!PROFILE_PATTERN.test(profile))
    problems.push(`MINIKUBE_PROFILE is not a branch profile ("${profile}")`)
  if ((env.CONTROL_API_REAL_PG_CONTEXT ?? '').trim() !== profile)
    problems.push('CONTROL_API_REAL_PG_CONTEXT must equal MINIKUBE_PROFILE')
  if ((env.E2E_K8S_CONTEXT ?? '').trim() !== profile)
    problems.push('E2E_K8S_CONTEXT must equal MINIKUBE_PROFILE (the GFS fixture helpers read it)')
  const mode = (env.LEGACY_LEASE_LANE_MODE ?? '').trim()
  if (!(LEGACY_LEASE_LANE_MODES as readonly string[]).includes(mode))
    problems.push(`LEGACY_LEASE_LANE_MODE must be fixed or vacuity ("${mode}")`)
  const runId = (env.LEGACY_LEASE_SEED_LABEL_VALUE ?? '').trim()
  if (!RUN_ID_PATTERN.test(runId) || runId !== (env.IMAGE_CAPABILITIES_RUN_ID ?? '').trim())
    problems.push('LEGACY_LEASE_SEED_LABEL_VALUE must equal IMAGE_CAPABILITIES_RUN_ID')
  if (problems.length > 0) {
    throw new Error(
      'legacy-lease-restart lane is not configured:\n' +
        problems.map(problem => `  - ${problem}`).join('\n') +
        '\nRun it through `make minikube-run-legacy-lease-restart` (or the -vacuity target).'
    )
  }
  return { profile, mode: mode as LegacyLeaseLaneMode, runId }
}

export type Kubectl = (args: string[], options?: { timeoutMs?: number; input?: string }) => string

export function kubectlFor(profile: string): Kubectl {
  if (!PROFILE_PATTERN.test(profile)) throw new Error(`refusing kubectl for "${profile}"`)
  return (args, options = {}) => {
    const timeoutMs = options.timeoutMs ?? 30_000
    try {
      return execFileSync(
        'kubectl',
        ['--context', profile, `--request-timeout=${Math.ceil(timeoutMs / 1000)}s`, ...args],
        {
          encoding: 'utf8',
          timeout: timeoutMs + 5_000,
          input: options.input,
          maxBuffer: 16 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      )
    } catch (error) {
      const stderr =
        typeof (error as { stderr?: unknown }).stderr === 'string'
          ? (error as { stderr: string }).stderr.trim()
          : ''
      throw new Error(`kubectl ${args.join(' ')} failed: ${(error as Error).message}\n${stderr}`)
    }
  }
}

/** Polls `probe` until it returns a value, or fails with the last observation. */
export async function waitFor<T>(
  label: string,
  timeoutMs: number,
  probe: () => { done: true; value: T } | { done: false; observed: string }
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let observed = 'not yet observed'
  for (;;) {
    const result = probe()
    if (result.done) return result.value
    observed = result.observed
    if (Date.now() >= deadline)
      throw new Error(`${label}: not reached within ${timeoutMs} ms (${observed})`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

export interface PodState {
  name: string
  uid: string
  phase: string
  terminating: boolean
  ready: boolean
  /** A container of this pod has started running at least once. */
  started: boolean
  image: string
}

export function readPods(kubectl: Kubectl, namespace: string, selector: string): PodState[] {
  const list = JSON.parse(
    kubectl(['-n', namespace, 'get', 'pod', '-l', selector, '-o', 'json'])
  ) as {
    items: Array<{
      metadata: { name: string; uid: string; deletionTimestamp?: string }
      spec: { containers: Array<{ image: string }> }
      status: {
        phase?: string
        conditions?: Array<{ type: string; status: string }>
        containerStatuses?: Array<{
          started?: boolean
          state?: { running?: unknown; terminated?: unknown }
          lastState?: { running?: unknown; terminated?: unknown }
        }>
      }
    }>
  }
  return list.items.map(item => ({
    name: item.metadata.name,
    uid: item.metadata.uid,
    phase: item.status.phase ?? 'Unknown',
    terminating: Boolean(item.metadata.deletionTimestamp),
    ready: (item.status.conditions ?? []).some(c => c.type === 'Ready' && c.status === 'True'),
    started: (item.status.containerStatuses ?? []).some(
      c =>
        c.started === true ||
        Boolean(c.state?.running) ||
        Boolean(c.state?.terminated) ||
        Boolean(c.lastState?.running) ||
        Boolean(c.lastState?.terminated)
    ),
    image: item.spec.containers[0]?.image ?? '',
  }))
}

function describePods(pods: PodState[]): string {
  return pods.length === 0
    ? 'no pods'
    : pods
        .map(
          p =>
            `${p.name}(${p.uid.slice(0, 8)} ${p.phase}${p.terminating ? ' terminating' : ''}${p.ready ? ' ready' : ''})`
        )
        .join(', ')
}

export function deploymentReplicas(kubectl: Kubectl, namespace: string, name: string): number {
  const replicas = JSON.parse(kubectl(['-n', namespace, 'get', 'deployment', name, '-o', 'json']))
    .spec.replicas
  if (!Number.isSafeInteger(replicas)) throw new Error(`${namespace}/${name} has no spec.replicas`)
  return replicas as number
}

export function scale(kubectl: Kubectl, namespace: string, name: string, replicas: number): void {
  kubectl(['-n', namespace, 'scale', `deployment/${name}`, `--replicas=${replicas}`])
}

export function rolloutStatus(kubectl: Kubectl, namespace: string, name: string): void {
  kubectl(['-n', namespace, 'rollout', 'status', `deployment/${name}`, '--timeout=180s'], {
    timeoutMs: 190_000,
  })
}

export function rolloutRestart(kubectl: Kubectl, namespace: string, name: string): void {
  kubectl(['-n', namespace, 'rollout', 'restart', `deployment/${name}`])
}

export async function waitNoPods(
  kubectl: Kubectl,
  namespace: string,
  selector: string,
  label: string
): Promise<void> {
  await waitFor(`${label} has no pods`, 120_000, () => {
    const pods = readPods(kubectl, namespace, selector)
    return pods.length === 0
      ? { done: true, value: undefined }
      : { done: false, observed: describePods(pods) }
  })
}

/** Exactly one Ready, non-terminating pod whose UID is not in `previous`. */
export async function waitSingleNewReadyPod(
  kubectl: Kubectl,
  namespace: string,
  selector: string,
  previous: ReadonlySet<string>,
  label: string,
  timeoutMs = 300_000
): Promise<PodState> {
  return waitFor(`${label} has one new Ready pod`, timeoutMs, () => {
    const pods = readPods(kubectl, namespace, selector)
    const [only] = pods
    if (pods.length === 1 && only && only.ready && !only.terminating && !previous.has(only.uid))
      return { done: true, value: only }
    return { done: false, observed: describePods(pods) }
  })
}

export interface PvcIdentity {
  name: string
  uid: string
}

/** The PVC the Host deployment mounts as its workspace, by claim name and UID. */
export function hostPvcIdentity(kubectl: Kubectl): PvcIdentity {
  const deployment = JSON.parse(
    kubectl(['-n', HOST.namespace, 'get', 'deployment', HOST.deployment, '-o', 'json'])
  ) as {
    spec: {
      template: {
        spec: { volumes?: Array<{ name: string; persistentVolumeClaim?: { claimName: string } }> }
      }
    }
  }
  const claims = (deployment.spec.template.spec.volumes ?? [])
    .filter(volume => volume.name === 'workspace' && volume.persistentVolumeClaim)
    .map(volume => volume.persistentVolumeClaim!.claimName)
  if (claims.length !== 1) throw new Error(`Host deployment mounts ${claims.length} workspace PVCs`)
  const name = claims[0]!
  const uid = kubectl([
    '-n',
    HOST.namespace,
    'get',
    'pvc',
    name,
    '-o',
    'jsonpath={.metadata.uid}',
  ]).trim()
  if (!uid) throw new Error(`PVC ${name} has no UID`)
  return { name, uid }
}

// ---------------------------------------------------------------------------
// Seeding one legacy lease on the stopped Host's PVC.
// ---------------------------------------------------------------------------

export interface LegacyLeaseRecord {
  leaseId: string
  callerIdentity: string
  recordIds: string[]
  acquiredAt: string
  expiresAt: string
}

/**
 * A valid, non-expired lease owned by a foreign caller, with no writer session
 * (written by an earlier boot) and no records: exactly the shape a pre-#1019
 * shell left behind when its Host died mid-command.
 */
export function legacyLease(now = Date.now()): LegacyLeaseRecord {
  const leaseId = randomUUID()
  return {
    leaseId,
    callerIdentity: `legacy-lease-e2e-foreign-${leaseId.slice(0, 8)}`,
    recordIds: [],
    acquiredAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
  }
}

/**
 * Runs inside the seed pod as the Host's own uid/gid. Read-modify-write with
 * the store's own publication sequence (temp file 0600, fsync, rename, fsync of
 * the directory), then a re-read that must show the lease and the unchanged
 * record set. It refuses a ledger that already carries leases.
 */
const SEED_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const ledgerPath = ${JSON.stringify(STORE_LEDGER_PATH)}
const lease = JSON.parse(process.env.LEGACY_LEASE)
const before = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
if (before.schemaVersion !== 1) throw new Error('ledger schemaVersion is not 1')
if (before.processingLeases !== undefined) throw new Error('ledger already carries processingLeases')
const recordIds = Object.keys(before.records || {}).sort()
const next = { ...before, processingLeases: { [lease.leaseId]: lease } }
const temporary = ledgerPath + '.tmp-' + randomUUID()
const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
try { fs.writeSync(fd, JSON.stringify(next)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
fs.renameSync(temporary, ledgerPath)
const dir = fs.openSync(path.dirname(ledgerPath), 'r')
try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
const after = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
const afterIds = Object.keys(after.records || {}).sort()
const seeded = after.processingLeases && after.processingLeases[lease.leaseId]
if (!seeded || JSON.stringify(seeded) !== JSON.stringify(lease)) throw new Error('seeded lease not read back')
if (JSON.stringify(afterIds) !== JSON.stringify(recordIds)) throw new Error('record set changed')
const info = fs.statSync(ledgerPath)
process.stdout.write('LEGACY_LEASE_SEED ' + JSON.stringify({ leaseId: lease.leaseId, records: afterIds.length, mode: (info.mode & 0o777).toString(8), uid: info.uid, gid: info.gid }) + '\\n')
`

export interface SeedSummary {
  leaseId: string
  records: number
  mode: string
  uid: number
  gid: number
}

export function parseSeedSummary(logs: string, leaseId: string): SeedSummary {
  const lines = logs.split('\n').filter(line => line.startsWith('LEGACY_LEASE_SEED '))
  if (lines.length !== 1) throw new Error(`seed pod printed ${lines.length} summaries`)
  const summary = JSON.parse(lines[0]!.slice('LEGACY_LEASE_SEED '.length)) as SeedSummary
  if (summary.leaseId !== leaseId) throw new Error('seed summary names another lease')
  if (summary.mode !== '600' || summary.uid !== 1001 || summary.gid !== 1001)
    throw new Error(`seeded ledger has mode ${summary.mode} owner ${summary.uid}:${summary.gid}`)
  return summary
}

/**
 * Seeds the lease while HCC and the Host are at zero and the Host pod is gone.
 * The pod runs the Host's image as uid/gid 1001 (the Host's own identity) and
 * mounts the same PVC. It is deleted before this returns, on every path.
 */
export async function seedLegacyLease(
  kubectl: Kubectl,
  input: { runId: string; scenario: string; pvc: PvcIdentity; lease: LegacyLeaseRecord }
): Promise<SeedSummary> {
  if (deploymentReplicas(kubectl, HOST.namespace, HOST.deployment) !== 0)
    throw new Error('refusing to seed: the Host is not scaled to zero')
  if (deploymentReplicas(kubectl, HCC.namespace, HCC.deployment) !== 0)
    throw new Error('refusing to seed: HCC is not scaled to zero')
  const hostPods = readPods(kubectl, HOST.namespace, HOST.selector)
  if (hostPods.length !== 0)
    throw new Error(`refusing to seed: Host pods remain (${describePods(hostPods)})`)
  const image = JSON.parse(
    kubectl(['-n', HOST.namespace, 'get', 'deployment', HOST.deployment, '-o', 'json'])
  ).spec.template.spec.containers.find((c: { name: string }) => c.name === HOST.container)?.image
  if (typeof image !== 'string' || !image) throw new Error('Host container image not found')
  const name = `legacy-lease-seed-${input.runId.slice(-12)}-${input.scenario.toLowerCase()}`
  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace: HOST.namespace,
      labels: { [SEED_LABEL_KEY]: input.runId },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      securityContext: {
        runAsUser: 1001,
        runAsGroup: 1001,
        fsGroup: 1001,
        runAsNonRoot: true,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: 'seed',
          image,
          imagePullPolicy: 'IfNotPresent',
          command: ['node', '-e', SEED_SCRIPT],
          env: [{ name: 'LEGACY_LEASE', value: JSON.stringify(input.lease) }],
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
          },
          resources: {
            limits: { cpu: '200m', memory: '128Mi' },
            requests: { cpu: '50m', memory: '64Mi' },
          },
          volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
        },
      ],
      volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: input.pvc.name } }],
    },
  }
  kubectl(['-n', HOST.namespace, 'create', '-f', '-'], { input: JSON.stringify(pod) })
  try {
    const phase = await waitFor(`seed pod ${name} finishes`, 120_000, () => {
      const current = kubectl([
        '-n',
        HOST.namespace,
        'get',
        'pod',
        name,
        '-o',
        'jsonpath={.status.phase}',
      ]).trim()
      return current === 'Succeeded' || current === 'Failed'
        ? { done: true, value: current }
        : { done: false, observed: current || 'Pending' }
    })
    const logs = kubectl(['-n', HOST.namespace, 'logs', name, '-c', 'seed'])
    if (phase !== 'Succeeded') throw new Error(`seed pod ${name} ${phase}:\n${logs.slice(-2000)}`)
    return parseSeedSummary(logs, input.lease.leaseId)
  } finally {
    kubectl(
      [
        '-n',
        HOST.namespace,
        'delete',
        'pod',
        name,
        '--ignore-not-found',
        '--wait=true',
        '--timeout=90s',
      ],
      {
        timeoutMs: 100_000,
      }
    )
  }
}

// ---------------------------------------------------------------------------
// Scenarios.
// ---------------------------------------------------------------------------

export const SCENARIOS = ['S-crash', 'S-graceful', 'S-hcc', 'S-gfs', 'S-update'] as const
export type Scenario = (typeof SCENARIOS)[number]

export interface ScenarioResult {
  scenario: Scenario
  pvc: PvcIdentity
  previousHostUid: string
  host: PodState
  seed: SeedSummary
  lease: LegacyLeaseRecord
  /** Workloads the scenario replaced, with their pod UIDs before and after. */
  replaced: Array<{ workload: string; before: string[]; after: string }>
}

function singleReadyPod(
  kubectl: Kubectl,
  namespace: string,
  selector: string,
  label: string
): PodState {
  const pods = readPods(kubectl, namespace, selector).filter(p => !p.terminating)
  const [only] = pods
  if (pods.length !== 1 || !only?.ready)
    throw new Error(`${label} is not one Ready pod (${describePods(pods)})`)
  return only
}

/**
 * Stops the Host. `crash` kills the running pod without grace and scales the
 * deployment to zero at once, so the replacement the ReplicaSet creates in
 * between must never start a container: if one does, the crash window was
 * lost and the scenario fails instead of silently becoming a graceful stop.
 */
async function stopHost(
  kubectl: Kubectl,
  mode: 'crash' | 'graceful',
  running: PodState
): Promise<void> {
  if (mode === 'graceful') {
    scale(kubectl, HOST.namespace, HOST.deployment, 0)
    await waitNoPods(kubectl, HOST.namespace, HOST.selector, 'Host')
    return
  }
  kubectl([
    '-n',
    HOST.namespace,
    'delete',
    'pod',
    running.name,
    '--force',
    '--grace-period=0',
    '--wait=false',
  ])
  scale(kubectl, HOST.namespace, HOST.deployment, 0)
  const startedReplacements = new Set<string>()
  await waitFor('Host has no pods after the crash', 120_000, () => {
    const pods = readPods(kubectl, HOST.namespace, HOST.selector)
    for (const pod of pods)
      if (pod.uid !== running.uid && pod.started) startedReplacements.add(pod.name)
    return pods.length === 0
      ? { done: true, value: undefined }
      : { done: false, observed: describePods(pods) }
  })
  if (startedReplacements.size > 0)
    throw new Error(
      `CRASH_WINDOW_LOST: a replacement Host pod started before the scale to zero (${[...startedReplacements].join(', ')})`
    )
}

async function restartWorkload(
  kubectl: Kubectl,
  workload: { namespace: string; deployment: string; selector: string }
): Promise<{ workload: string; before: string[]; after: string }> {
  const before = readPods(kubectl, workload.namespace, workload.selector).map(p => p.uid)
  if (before.length === 0) throw new Error(`${workload.deployment} has no pod to restart`)
  rolloutRestart(kubectl, workload.namespace, workload.deployment)
  rolloutStatus(kubectl, workload.namespace, workload.deployment)
  const pod = await waitSingleNewReadyPod(
    kubectl,
    workload.namespace,
    workload.selector,
    new Set(before),
    workload.deployment
  )
  return { workload: workload.deployment, before, after: pod.uid }
}

/**
 * Runs one scenario end to end: HCC to zero, Host stopped, lease seeded, the
 * scenario's own restarts, then HCC and the Host back. Returns the new Host pod.
 * Every step leaves HCC and the Host at their pre-scenario replicas on success;
 * on failure, `ensureWorkloadsUp` (and the runner's restoration) bring them back.
 */
export async function runScenario(
  kubectl: Kubectl,
  input: { scenario: Scenario; runId: string }
): Promise<ScenarioResult> {
  const { scenario } = input
  const replaced: ScenarioResult['replaced'] = []
  const pvcBefore = hostPvcIdentity(kubectl)
  const running = singleReadyPod(kubectl, HOST.namespace, HOST.selector, 'Host')
  const hccBefore = singleReadyPod(kubectl, HCC.namespace, HCC.selector, 'HCC')
  if (deploymentReplicas(kubectl, HOST.namespace, HOST.deployment) !== 1)
    throw new Error('Host deployment is not at one replica before the scenario')
  if (deploymentReplicas(kubectl, HCC.namespace, HCC.deployment) !== 1)
    throw new Error('HCC deployment is not at one replica before the scenario')

  // HCC first: it owns the Host deployment and would scale it back up.
  scale(kubectl, HCC.namespace, HCC.deployment, 0)
  await waitNoPods(kubectl, HCC.namespace, HCC.selector, 'HCC')
  await stopHost(kubectl, scenario === 'S-crash' ? 'crash' : 'graceful', running)

  const lease = legacyLease()
  const seed = await seedLegacyLease(kubectl, {
    runId: input.runId,
    scenario,
    pvc: pvcBefore,
    lease,
  })

  const startHostThenHcc = async () => {
    scale(kubectl, HOST.namespace, HOST.deployment, 1)
    scale(kubectl, HCC.namespace, HCC.deployment, 1)
  }
  switch (scenario) {
    case 'S-crash':
      await startHostThenHcc()
      break
    case 'S-graceful':
      // A new template while stopped: the next pod is a fresh rollout, the way
      // a graceful `rollout restart` replaces the Host.
      rolloutRestart(kubectl, HOST.namespace, HOST.deployment)
      await startHostThenHcc()
      break
    case 'S-hcc':
      await startHostThenHcc()
      break
    case 'S-gfs':
      for (const workload of GFS_WORKLOADS) replaced.push(await restartWorkload(kubectl, workload))
      await startHostThenHcc()
      break
    case 'S-update':
      // Upgrade order: GFS, WRC, HCC, then the Host.
      for (const workload of GFS_WORKLOADS) replaced.push(await restartWorkload(kubectl, workload))
      replaced.push(await restartWorkload(kubectl, WRC))
      rolloutRestart(kubectl, HOST.namespace, HOST.deployment)
      scale(kubectl, HCC.namespace, HCC.deployment, 1)
      rolloutStatus(kubectl, HCC.namespace, HCC.deployment)
      scale(kubectl, HOST.namespace, HOST.deployment, 1)
      break
  }

  const hccPod = await waitSingleNewReadyPod(
    kubectl,
    HCC.namespace,
    HCC.selector,
    new Set([hccBefore.uid]),
    'HCC'
  )
  replaced.push({ workload: HCC.deployment, before: [hccBefore.uid], after: hccPod.uid })
  const host = await waitSingleNewReadyPod(
    kubectl,
    HOST.namespace,
    HOST.selector,
    new Set([running.uid]),
    'Host'
  )
  rolloutStatus(kubectl, HOST.namespace, HOST.deployment)
  // HCC's first reconcile must not roll the Host again: the pod that booted on
  // the seeded ledger is the one whose signals are read.
  const settled = singleReadyPod(kubectl, HOST.namespace, HOST.selector, 'Host')
  if (settled.uid !== host.uid)
    throw new Error(`HCC replaced the Host pod after it booted (${host.uid} -> ${settled.uid})`)
  const pvcAfter = hostPvcIdentity(kubectl)
  if (pvcAfter.name !== pvcBefore.name || pvcAfter.uid !== pvcBefore.uid)
    throw new Error(
      `Host PVC changed across ${scenario}: ${JSON.stringify(pvcBefore)} -> ${JSON.stringify(pvcAfter)}`
    )
  return { scenario, pvc: pvcAfter, previousHostUid: running.uid, host, seed, lease, replaced }
}

/** Brings HCC and the Host back to one replica after a failed scenario. */
export function ensureWorkloadsUp(kubectl: Kubectl): void {
  if (deploymentReplicas(kubectl, HOST.namespace, HOST.deployment) !== 1)
    scale(kubectl, HOST.namespace, HOST.deployment, 1)
  if (deploymentReplicas(kubectl, HCC.namespace, HCC.deployment) !== 1)
    scale(kubectl, HCC.namespace, HCC.deployment, 1)
  rolloutStatus(kubectl, HCC.namespace, HCC.deployment)
  rolloutStatus(kubectl, HOST.namespace, HOST.deployment)
}

// ---------------------------------------------------------------------------
// Signal readers (read-only) and pure verdicts.
// ---------------------------------------------------------------------------

export function readStoreLedger(kubectl: Kubectl, podName: string): Record<string, unknown> {
  const raw = kubectl([
    '-n',
    HOST.namespace,
    'exec',
    podName,
    '-c',
    HOST.container,
    '--',
    'cat',
    STORE_LEDGER_PATH,
  ])
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('store ledger is not a JSON object')
  return parsed as Record<string, unknown>
}

export function readHostLogLines(kubectl: Kubectl, podName: string): string[] {
  return kubectl(['-n', HOST.namespace, 'logs', podName, '-c', HOST.container], {
    timeoutMs: 60_000,
  })
    .split('\n')
    .filter(line => line.trim().length > 0)
}

export function readHostMetrics(kubectl: Kubectl, podName: string): string {
  return kubectl([
    '-n',
    HOST.namespace,
    'exec',
    podName,
    '-c',
    HOST.container,
    '--',
    'node',
    '-e',
    "fetch('http://127.0.0.1:8080/metrics').then(r=>{if(!r.ok)throw new Error('metrics '+r.status);return r.text()}).then(t=>process.stdout.write(t))",
  ])
}

/**
 * The value of an unlabelled metric, or null when the exposition has no such
 * sample. A metric with labels, or more than one sample, is refused.
 */
export function parseMetricValue(text: string, name: string): number | null {
  const samples = text
    .split('\n')
    .filter(
      line => !line.startsWith('#') && (line.startsWith(`${name} `) || line.startsWith(`${name}{`))
    )
  if (samples.length === 0) return null
  if (samples.length !== 1) throw new Error(`${name} has ${samples.length} samples`)
  const match = new RegExp(`^${name}(?:\\{\\})? ([0-9.eE+-]+)$`).exec(samples[0]!.trim())
  if (!match) throw new Error(`${name} sample is not an unlabelled number: ${samples[0]}`)
  const value = Number(match[1])
  if (!Number.isFinite(value)) throw new Error(`${name} sample is not finite`)
  return value
}

interface StoreLogLine {
  component?: unknown
  msg?: unknown
  discarded?: unknown
  legacyProcessingLeases?: unknown
  outcome?: unknown
}

function storeLogLines(logLines: string[]): StoreLogLine[] {
  const parsed: StoreLogLine[] = []
  for (const line of logLines) {
    if (!line.startsWith('{')) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      (value as StoreLogLine).component === STORE_LOG_COMPONENT
    )
      parsed.push(value as StoreLogLine)
  }
  return parsed
}

export type RecoveryOutcome = 'discarded' | 'unknown-outcome'

/**
 * Signal 2 on the fixed Host. The ledger must have no `processingLeases`, and
 * exactly one of the two outcomes must be visible: one confirmed discard of
 * one lease with the counter at 1, or one unknown-outcome warning with the
 * counter at 0. The counter is read from a pod that just booted, so its value
 * is the delta. A missing counter is a failure: it is the liveness witness
 * that the metric registry of the fixed build is the one that answered.
 */
export function legacyLeaseRecoveryVerdict(input: {
  ledger: Record<string, unknown>
  logLines: string[]
  counter: number | null
}): RecoveryOutcome {
  if (Object.hasOwn(input.ledger, 'processingLeases'))
    throw new Error('the ledger still carries processingLeases after the restart')
  if (input.counter === null)
    throw new Error(`${LEGACY_DISCARD_COUNTER} is not exposed by the Host`)
  const lines = storeLogLines(input.logLines)
  const discards = lines.filter(
    line =>
      typeof line.msg === 'string' &&
      line.msg.startsWith(DISCARD_MSG_PREFIX) &&
      typeof line.discarded === 'number'
  )
  const unknown = lines.filter(
    line =>
      line.outcome === 'unknown' &&
      typeof line.msg === 'string' &&
      line.msg.startsWith(UNKNOWN_MSG_PREFIX) &&
      typeof line.legacyProcessingLeases === 'number'
  )
  if (
    discards.length === 1 &&
    unknown.length === 0 &&
    discards[0]!.discarded === 1 &&
    input.counter === 1
  )
    return 'discarded'
  if (
    unknown.length === 1 &&
    discards.length === 0 &&
    unknown[0]!.legacyProcessingLeases === 1 &&
    input.counter === 0
  )
    return 'unknown-outcome'
  throw new Error(
    `no recovery outcome: ${discards.length} discard line(s) ` +
      `(${discards.map(line => String(line.discarded)).join(',') || '-'}), ` +
      `${unknown.length} unknown-outcome line(s), counter ${input.counter}`
  )
}

/**
 * The vacuity witness on the pre-fix Host: the seeded lease is still in the
 * ledger, nothing was discarded, and the counter does not exist. Together with
 * the journey failing at the shell with download_busy, this shows the lane can
 * tell the fixed build from the broken one.
 */
export function vacuityStoreVerdict(input: {
  ledger: Record<string, unknown>
  logLines: string[]
  counter: number | null
  leaseId: string
}): 'lease-retained' {
  const leases = input.ledger.processingLeases as Record<string, unknown> | undefined
  if (!leases || typeof leases !== 'object' || !Object.hasOwn(leases, input.leaseId))
    throw new Error('the pre-fix Host no longer carries the seeded lease')
  const discards = storeLogLines(input.logLines).filter(
    line => typeof line.msg === 'string' && line.msg.startsWith(DISCARD_MSG_PREFIX)
  )
  if (discards.length !== 0) throw new Error('the pre-fix Host logged a legacy-lease discard')
  if (input.counter !== null) throw new Error(`the pre-fix Host exposes ${LEGACY_DISCARD_COUNTER}`)
  return 'lease-retained'
}

export interface StoreRecord {
  id: string
  hostPath: string
  sizeBytes: number
  sha256?: string
  state: string
}

export function storeRecords(ledger: Record<string, unknown>): StoreRecord[] {
  const records = ledger.records
  if (typeof records !== 'object' || records === null || Array.isArray(records))
    throw new Error('store ledger has no records object')
  return Object.values(records as Record<string, StoreRecord>)
}

/** The one completed record this journey added, matching the GFS source bytes. */
export function downloadedRecord(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  source: { sha256: string; bytes: number }
): StoreRecord {
  if (!SHA256_HEX.test(source.sha256)) throw new Error('source sha256 is not a digest')
  const known = new Set(storeRecords(before).map(record => record.id))
  const added = storeRecords(after).filter(record => !known.has(record.id))
  const matching = added.filter(
    record =>
      record.state === 'completed' &&
      record.sha256 === source.sha256 &&
      record.sizeBytes === source.bytes
  )
  if (added.length !== 1 || matching.length !== 1)
    throw new Error(
      `expected one new completed record for ${source.sha256}/${source.bytes} bytes; ` +
        `added ${JSON.stringify(added.map(r => ({ state: r.state, sha256: r.sha256, sizeBytes: r.sizeBytes })))}`
    )
  return matching[0]!
}

/** sha256 and size of a file on the Host PVC, computed in the Host container. */
export function hostFileDigest(
  kubectl: Kubectl,
  podName: string,
  hostPath: string
): { sha256: string; bytes: number } {
  if (path_is_unsafe(hostPath)) throw new Error(`refusing to read ${hostPath}`)
  const out = kubectl([
    '-n',
    HOST.namespace,
    'exec',
    podName,
    '-c',
    HOST.container,
    '--',
    'node',
    '-e',
    "const b=require('node:fs').readFileSync(process.argv[1]);process.stdout.write(require('node:crypto').createHash('sha256').update(b).digest('hex')+' '+b.length)",
    `/workspace/${hostPath}`,
  ]).trim()
  const [sha256, bytes] = out.split(' ')
  if (!sha256 || !SHA256_HEX.test(sha256) || !/^\d+$/.test(bytes ?? ''))
    throw new Error(`unexpected digest output: ${out}`)
  return { sha256, bytes: Number(bytes) }
}

function path_is_unsafe(hostPath: string): boolean {
  return hostPath.startsWith('/') || hostPath.split('/').some(part => part === '..' || part === '')
}
