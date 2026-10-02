// E2E_GUARDIAN_IPC_FLOW: pure run admission; no environment files, login, launch, or network at module load.
import path from 'node:path'

export type SubscriptionImageProvider = 'grok-subscription' | 'codex-subscription'
export type ProviderBinding = {
  provider: SubscriptionImageProvider
  hostRef: string
  hostLabel: string
  modelId: string
  modelLabel: string
  unsupportedModelId: string
  unsupportedModelLabel: string
}
export type SubscriptionImageRun = {
  mode: 'fixture' | 'real'
  runId: string
  runnerReceipt: string
  runRoot: string
  evidencePaths?: Partial<Record<SubscriptionImageProvider, string>>
  profile: string
  context: string
  restUrl: string
  rpcUrl: string
  bindings: ProviderBinding[]
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Subscription image lane requires explicit ${name}`)
  return value
}
function absolute(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name)
  if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute`)
  return path.resolve(value)
}
function ownedUrl(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name)
  const url = new URL(value)
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname) ||
    ['3000', '8090', '8091', '8094', '8098'].includes(url.port)
  ) {
    throw new Error(`${name} must bind an explicit owned loopback port without credentials`)
  }
  return url.origin
}

export function requireSubscriptionImageRun(
  env: NodeJS.ProcessEnv = process.env
): SubscriptionImageRun {
  if (env.E2E_SUBSCRIPTION_IMAGE_INPUT !== '1') {
    throw new Error('Subscription image lane requires E2E_SUBSCRIPTION_IMAGE_INPUT=1')
  }
  const mode = required(env, 'E2E_SUBSCRIPTION_IMAGE_MODE')
  if (mode !== 'fixture' && mode !== 'real')
    throw new Error('E2E_SUBSCRIPTION_IMAGE_MODE must be fixture or real')
  const approvals =
    mode === 'real'
      ? ['GROK_REAL_UPSTREAM_CONFIRM', 'CODEX_REAL_UPSTREAM_CONFIRM']
      : ['SUBSCRIPTION_IMAGE_FIXTURE_CONFIRM']
  for (const name of approvals)
    if (env[name] !== '1') throw new Error(`Subscription image lane requires ${name}=1`)
  const runId = required(env, 'E2E_SUBSCRIPTION_IMAGE_RUN_ID')
  if (!/^subscription-image-[a-f0-9]{12}$/.test(runId))
    throw new Error('E2E_SUBSCRIPTION_IMAGE_RUN_ID must identify this run')
  const runnerReceipt = absolute(env, 'SUBSCRIPTION_IMAGE_RUNNER_RECEIPT')
  const runRoot = absolute(env, 'SUBSCRIPTION_IMAGE_RUN_ROOT')
  const profile = required(env, 'MINIKUBE_PROFILE')
  const context = required(env, 'CONTROL_API_REAL_PG_CONTEXT')
  if (
    profile !== context ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(profile) ||
    profile === 'clerum-test' ||
    /(^|[-_])(prod|production)([-_]|$)/i.test(profile)
  ) {
    throw new Error(
      'Subscription image lane requires the explicit owned development profile/context'
    )
  }
  const restUrl = ownedUrl(env, 'EXTERNAL_REST_API_BASE_URL')
  const rpcUrl = ownedUrl(env, 'RPC_PROXY_BASE_URL')
  if (restUrl === rpcUrl) throw new Error('REST and RPC bindings must differ')
  required(env, 'E2E_SUBSCRIPTION_IMAGE_LOGIN_EMAIL')
  required(env, 'E2E_SUBSCRIPTION_IMAGE_LOGIN_PASSWORD')
  const bindings = (['GROK', 'CODEX'] as const).map(kind => ({
    provider: `${kind.toLowerCase()}-subscription` as SubscriptionImageProvider,
    hostRef: required(env, `E2E_${kind}_IMAGE_HOST_REF`),
    hostLabel: required(env, `E2E_${kind}_IMAGE_HOST_LABEL`),
    modelId: required(env, `E2E_${kind}_IMAGE_MODEL`),
    modelLabel: required(env, `E2E_${kind}_IMAGE_MODEL_LABEL`),
    unsupportedModelId: required(env, `E2E_${kind}_IMAGE_UNSUPPORTED_MODEL`),
    unsupportedModelLabel: required(env, `E2E_${kind}_IMAGE_UNSUPPORTED_MODEL_LABEL`),
  }))
  if (
    bindings[0]!.hostRef === bindings[1]!.hostRef ||
    bindings.some(binding => binding.modelId === binding.unsupportedModelId)
  ) {
    throw new Error('Provider and capability bindings must identify distinct owned targets')
  }
  const evidencePaths: Partial<Record<SubscriptionImageProvider, string>> = {}
  if (mode === 'fixture') {
    for (const [kind, binding] of (['GROK', 'CODEX'] as const).map(
      (kind, index) => [kind, bindings[index]!] as const
    )) {
      const evidencePath = absolute(env, `E2E_${kind}_IMAGE_EVIDENCE_PATH`)
      const relative = path.relative(runRoot, evidencePath)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(
          `E2E_${kind}_IMAGE_EVIDENCE_PATH must be inside SUBSCRIPTION_IMAGE_RUN_ROOT`
        )
      }
      evidencePaths[binding.provider] = evidencePath
    }
    if (new Set(Object.values(evidencePaths)).size !== 2)
      throw new Error('Each physical proxy requires its own vendor evidence file')
  }
  return {
    mode,
    runId,
    runnerReceipt,
    runRoot,
    evidencePaths,
    profile,
    context,
    restUrl,
    rpcUrl,
    bindings,
  }
}

export type RunnerObservation = {
  platform: string
  uid: number
  gid: number
  home: string
  mountNamespace: string
  pidNamespace: string
  userNamespace: string
  mountInfoSha256: string
}

/** The main runner inspects physical mounts/namespaces first and seals these observations in its receipt. */
export function verifyRunnerObservation(
  expected: RunnerObservation,
  actual: RunnerObservation,
  env: NodeJS.ProcessEnv
): void {
  if (
    actual.platform !== 'linux' ||
    !Number.isInteger(actual.uid) ||
    actual.uid <= 0 ||
    !Number.isInteger(actual.gid) ||
    actual.gid <= 0
  ) {
    throw new Error('Subscription image isolation requires an inspected non-root Linux runner')
  }
  for (const field of [
    'platform',
    'uid',
    'gid',
    'home',
    'mountNamespace',
    'pidNamespace',
    'userNamespace',
    'mountInfoSha256',
  ] as const) {
    if (expected[field] !== actual[field])
      throw new Error(`Physical runner isolation changed: ${field}`)
  }
  if (
    !/^mnt:\[\d+\]$/.test(actual.mountNamespace) ||
    !/^pid:\[\d+\]$/.test(actual.pidNamespace) ||
    !/^user:\[\d+\]$/.test(actual.userNamespace) ||
    !/^[a-f0-9]{64}$/.test(actual.mountInfoSha256)
  ) {
    throw new Error('Physical runner isolation observations are incomplete')
  }
  if (!path.isAbsolute(actual.home) || env.HOME !== actual.home)
    throw new Error('Runner HOME does not match the OS account')
  if (env.DBUS_SESSION_BUS_ADDRESS || env.SSH_AUTH_SOCK)
    throw new Error('Inherited DBus/SSH socket is forbidden in the isolated runner')
}
