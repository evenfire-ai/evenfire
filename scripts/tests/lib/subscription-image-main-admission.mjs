// Host-side builders for the sealed main admission. Pure data shaping only:
// every value either comes from a real docker inspect / kubectl / owned file
// read by the caller, or the builder refuses. The full physical verification
// stays in subscription-image-runner-contract.mjs inside the container.
import {
  MAIN_ADMISSION_KIND,
  PORT_FORWARD_SERVICES,
  RUNNER_ADMISSION_ROOT,
  RUNNER_RUN_BASE,
  RunnerAdmissionError,
  digest,
  parsePortForwardRecord,
  pinnedBaseImage,
  resolveSuite,
  suiteBuildArgs,
} from './subscription-image-runner-contract.mjs'

const refuse = code => {
  throw new RunnerAdmissionError(code)
}
const PERSONAL = /(^|\/)(Users|\.ssh|\.aws|\.gnupg|\.config|keychains?|credentials?|docker\.sock)(\/|$)/i
const ALLOWED_CONTAINER_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TERM',
  'NODE_VERSION',
  'YARN_VERSION',
  'SUBSCRIPTION_IMAGE_RUN_ID',
])

export function runtimeFromInspect(inspect, { runId, suiteId, home }) {
  const hostConfig = inspect?.HostConfig
  if (
    typeof inspect?.Id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(inspect.Id) ||
    typeof inspect.Image !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(inspect.Image) ||
    !Number.isFinite(Date.parse(inspect.Created)) ||
    typeof inspect.Config?.User !== 'string' ||
    inspect.State?.Running !== true ||
    !hostConfig ||
    hostConfig.ReadonlyRootfs !== true ||
    hostConfig.Privileged !== false ||
    (hostConfig.PidMode || 'private') !== 'private' ||
    (hostConfig.IpcMode || 'private') !== 'private' ||
    typeof hostConfig.NetworkMode !== 'string' ||
    !hostConfig.NetworkMode ||
    hostConfig.NetworkMode === 'host' ||
    hostConfig.NetworkMode.startsWith('container:') ||
    !Array.isArray(hostConfig.CapDrop) ||
    hostConfig.CapDrop.join(',') !== 'ALL' ||
    !Array.isArray(hostConfig.SecurityOpt) ||
    hostConfig.SecurityOpt.some(
      value => typeof value !== 'string' || /seccomp=unconfined|no-new-privileges/i.test(value)
    )
  )
    refuse('HOST_INSPECT_RUNTIME_REFUSED')
  const mounts = Array.isArray(inspect.Mounts) ? inspect.Mounts : []
  const admissionMounts = mounts.filter(mount => mount.Destination === RUNNER_ADMISSION_ROOT)
  const tmpfsOk =
    typeof home === 'string' &&
    home.startsWith('/') &&
    [home, RUNNER_RUN_BASE, '/tmp'].every(destination => {
      const matches = mounts.filter(mount => mount.Destination === destination)
      return matches.length === 1 && matches[0].Type === 'tmpfs' && matches[0].RW === true
    })
  if (
    mounts.length !== 4 ||
    admissionMounts.length !== 1 ||
    admissionMounts[0].Type !== 'bind' ||
    admissionMounts[0].RW !== false ||
    typeof admissionMounts[0].Source !== 'string' ||
    !admissionMounts[0].Source ||
    mounts.some(mount => mount.Type === 'bind' && mount.Destination !== RUNNER_ADMISSION_ROOT) ||
    mounts.some(
      mount => PERSONAL.test(String(mount.Source ?? '')) || PERSONAL.test(String(mount.Destination ?? ''))
    ) ||
    !tmpfsOk
  )
    refuse('HOST_INSPECT_MOUNTS_REFUSED')
  const envEntries = Array.isArray(inspect.Config?.Env) ? inspect.Config.Env : []
  for (const entry of envEntries) {
    const split = typeof entry === 'string' ? entry.indexOf('=') : -1
    if (split <= 0) refuse('HOST_CONTAINER_ENV_REFUSED')
    const name = entry.slice(0, split)
    if (!ALLOWED_CONTAINER_ENV.has(name) || /(SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY|AUTH)/i.test(name))
      refuse('HOST_CONTAINER_ENV_REFUSED')
  }
  if (!envEntries.includes(`SUBSCRIPTION_IMAGE_RUN_ID=${runId}`))
    refuse('HOST_CONTAINER_ENV_RUN_BINDING')
  if (typeof suiteId !== 'string' || !suiteId) refuse('HOST_SUITE_REQUIRED')
  return {
    readOnlyRootfs: true,
    privileged: false,
    pidMode: 'private',
    ipcMode: 'private',
    networkMode: hostConfig.NetworkMode,
    user: inspect.Config.User,
    capDrop: ['ALL'],
    seccompMode: 'filter',
    containerId: inspect.Id,
    createdAt: new Date(Date.parse(inspect.Created)).toISOString(),
  }
}

export function stackReceiptFrom({ profile, context, configMap, portsEnvRaw, fetchedAt }) {
  const data = configMap?.data
  if (
    !data ||
    typeof data.gitHead !== 'string' ||
    !/^[a-f0-9]{40}$/.test(data.gitHead) ||
    typeof data.worktreeId !== 'string' ||
    !/^[a-f0-9]{40}$/.test(data.worktreeId) ||
    typeof data.clusterFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.clusterFingerprint) ||
    typeof data.imagesGeneratedAt !== 'string' ||
    !data.imagesGeneratedAt ||
    typeof configMap?.metadata?.resourceVersion !== 'string' ||
    !configMap.metadata.resourceVersion
  )
    refuse('HOST_STACK_MARKER_REFUSED')
  if (typeof portsEnvRaw !== 'string' || !portsEnvRaw.length) refuse('HOST_PORTS_ENV_REFUSED')
  return {
    kind: 'evenfire-subscription-image-stack-marker-v1',
    context,
    configMapName: 'clerum-pre-gate-sync-state',
    resourceVersion: configMap.metadata.resourceVersion,
    fetchedAt,
    profile,
    portsEnvRaw,
    portsEnvSha256: digest(portsEnvRaw),
    data: {
      gitHead: data.gitHead,
      worktreeId: data.worktreeId,
      clusterFingerprint: data.clusterFingerprint,
      imagesGeneratedAt: data.imagesGeneratedAt,
      imageSource: data.imageSource ?? '',
      imageTag: data.imageTag ?? '',
    },
  }
}

export function portForwardReceiptFrom({ records, profile, context, portsEnvRaw, verifiedAt }) {
  const ports = {}
  for (const line of String(portsEnvRaw).split('\n')) {
    const split = line.indexOf('=')
    if (split > 0) ports[line.slice(0, split)] = line.slice(split + 1)
  }
  const entries = {}
  for (const [kind, expected] of Object.entries(PORT_FORWARD_SERVICES)) {
    const raw = records?.[kind]
    if (typeof raw !== 'string' || !raw.length) refuse('HOST_PORT_FORWARD_RECORD_REQUIRED')
    const record = parsePortForwardRecord(raw)
    if (
      record.profile !== profile ||
      record.context !== context ||
      record.namespace !== expected.namespace ||
      record.service !== expected.service ||
      record.remotePort !== expected.remotePort ||
      String(record.localPort) !== String(ports[expected.key] ?? '')
    )
      refuse('HOST_PORT_FORWARD_RECORD_MISMATCH')
    entries[kind] = { raw, recordSha256: digest(raw), pid: record.pid, processStart: record.processStart }
  }
  return {
    kind: 'evenfire-subscription-image-port-forwards-v1',
    profile,
    context,
    verifiedAt,
    entries,
  }
}

export function buildAdmission({
  runId,
  suiteId,
  mode,
  profile,
  context,
  repoRoot,
  source,
  gitHead,
  gitTree,
  inputManifestSha256,
  sourceManifestSha256,
  imageId,
  runtime,
  observation,
  networkNamespace,
  ipcNamespace,
  stack,
  receipts,
  bindings,
  transports,
  vendorSources,
  uiFeatures,
  thirdPartyArtifacts,
}) {
  const suite = resolveSuite(suiteId)
  const base = pinnedBaseImage(repoRoot)
  if (!suite.modes.includes(mode)) refuse('SUITE_MODE_NOT_ADMITTED')
  if (!gitHead || !gitTree || !sourceManifestSha256) refuse('HOST_SOURCE_IDENTITY_REQUIRED')
  if (
    !stack ||
    !receipts ||
    typeof imageId !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(imageId) ||
    !Array.isArray(bindings) ||
    bindings.length !== 2
  )
    refuse('HOST_ADMISSION_INPUT')
  if (
    !Array.isArray(thirdPartyArtifacts) ||
    thirdPartyArtifacts.length !== 1 ||
    thirdPartyArtifacts[0].name !== 'sfw-free' ||
    !/^[a-f0-9]{64}$/.test(thirdPartyArtifacts[0].sha256 ?? '')
  )
    refuse('HOST_THIRD_PARTY_ARTIFACT_REQUIRED')
  return {
    kind: MAIN_ADMISSION_KIND,
    runId,
    suiteId,
    mode,
    profile,
    context,
    repoRoot,
    gitHead,
    gitTree,
    inputManifestSha256,
    sourceManifestSha256,
    imageId,
    baseImage: base.reference,
    uiFeatures: { ...suiteBuildArgs(suite), ...(uiFeatures ?? {}) },
    runtime,
    observation,
    networkNamespace,
    ipcNamespace,
    stack: {
      gitHead,
      worktreeId: stack.data.worktreeId,
      clusterFingerprint: stack.data.clusterFingerprint,
      imagesGeneratedAt: stack.data.imagesGeneratedAt,
      portsReceiptSha256: stack.portsEnvSha256,
    },
    receipts,
    thirdPartyArtifacts,
    bindings,
    transports,
    ...(vendorSources ? { vendorSources } : {}),
  }
}
