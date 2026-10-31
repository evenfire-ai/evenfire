import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  IDENTITY_ERROR_CODES,
  IDENTITY_ERROR_PHASES,
  createFixtureIdentityJournal,
  recordFixtureConnection,
} from '../../tests/e2e/fixtures/codex-subscription/approved-tools-setup/identity-lifecycle.mjs'
import {
  connectionCaptureName,
  validateConnectionCapture,
} from './approved-tools-connection-journal.mjs'
import {
  captureControlApi,
  controlApiFixtureEnv,
  controlApiFixtureImage,
  controlApiPatch,
  recoverControlApiForCleanup,
  restoreControlApi,
  validateControlApiPatch,
} from './approved-tools-control-api-lifecycle.mjs'
import { buildApprovedToolsImageProof } from './approved-tools-image-proof.mjs'
import {
  cleanupJournaledFixtureResources,
  createJournaledFixtureResources,
  fixtureDeleteRequest,
  fixtureResourceGetArgs,
  validateFixtureDeleteRequest,
} from './approved-tools-resource-cleanup.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const sizes = [83, 150, 250]
const fixtureImage = 'clerum/codex-approved-tools-mcp-e2e:test'
const proxyImage = 'clerum/codex-approved-tools-proxy-e2e:test'
export const controlApiMarkerCheck = `const fs = require('node:fs'); const marker = JSON.parse(fs.readFileSync('/tmp/approved-tools-oauth-active.json', 'utf8')); if (marker.pid !== 1 || process.env.NODE_ENV !== 'test' || process.env.EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE !== '1' || marker.run !== process.env.APPROVED_TOOLS_RUN_ID || marker.profile !== process.env.MINIKUBE_PROFILE || marker.profile !== process.env.CONTROL_API_REAL_PG_CONTEXT || !process.env.KUBERNETES_SERVICE_HOST) throw Error('Invalid fixture marker'); process.kill(marker.pid, 0); process.stdout.write(JSON.stringify(marker))`
const proxyRunAnnotation = 'evenfire.ai/codex-tools-fixture-run'
const workflowImage = 'clerum/workflow-custom-sdk-e2e:approved-tools-test'
const workflowFeatureCheck = `process.stdout.write(JSON.stringify(process.env.WRC_ENABLE_CUSTOM_COORDINATOR_IMAGE === 'true' && process.env.WRC_REQUIRE_COORDINATOR_IMAGE_DIGEST === 'false' && (process.env.WRC_ALLOWED_COORDINATOR_IMAGE_PREFIXES || '').split(',').some(prefix => prefix.trim() && '${workflowImage}'.startsWith(prefix.trim()))))`
// MS-SUB: one boolean per requested flag, so a refused subscription gate names
// the exact flag rather than the whole set. The remote program is a fixed shape
// closed over the flag list, never free text.
export function flagProbeScript(keys) {
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    keys.some(key => typeof key !== 'string' || !/^[A-Z][A-Z0-9_]{0,80}$/.test(key))
  )
    throw new Error('Invalid feature probe')
  return `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key] === 'true']))))`
}
const proxyFlags = [
  'CODEX_APPROVED_TOOLS_TEST_ONLY',
  'CODEX_APPROVED_TOOLS_MINIKUBE_PROFILE',
  'NODE_ENV',
]
const hybridProxyFlags = [
  ...proxyFlags,
  'APPROVED_TOOLS_UPSTREAM_MODE',
  'CODEX_REAL_UPSTREAM_CONFIRM',
]

export function validateProvider(provider) {
  if (!['codex', 'grok'].includes(provider)) throw new Error('Invalid approved-tools provider')
  return provider
}

// The suite is a required selection with no default: an unset value is a
// misconfigured lane, not an approved-tools run. `approved-tools` is the base
// journey suite (seven cases); `native-workflow` owns the one workflow case and
// the resources it alone uses (#1048 MS-NW); `model-step-retry` runs the visible
// setup plus C1-C12.
export const APPROVED_TOOLS_SUITES = Object.freeze([
  'approved-tools',
  'native-workflow',
  'model-step-retry',
])

export function validateSuite(suite) {
  if (!APPROVED_TOOLS_SUITES.includes(suite))
    throw new Error(
      'APPROVED_TOOLS_SUITE_UNSUPPORTED: expected approved-tools, native-workflow or model-step-retry'
    )
  return suite
}

// Allowed provider x suite x upstream-mode combinations. Prepared by this
// script: codex+approved-tools+{deterministic,real-hybrid}, codex+native-workflow
// +deterministic, codex+model-step-retry+deterministic,
// grok+model-step-retry+deterministic. `real` prepares nothing here but stays a
// legal matrix cell for the runner and the config.
export function validateSuiteMatrix(provider, suite, mode) {
  validateProvider(provider)
  validateSuite(suite)
  if (!['deterministic', 'real', 'real-hybrid'].includes(mode))
    throw new Error('APPROVED_TOOLS_SUITE_UNSUPPORTED: invalid upstream mode')
  if (provider === 'grok' && (suite !== 'model-step-retry' || mode !== 'deterministic'))
    throw new Error(
      'APPROVED_TOOLS_SUITE_UNSUPPORTED: grok model-step lane requires the model-step-retry suite and deterministic upstream'
    )
  if (suite === 'model-step-retry' && mode !== 'deterministic')
    throw new Error(
      'APPROVED_TOOLS_SUITE_UNSUPPORTED: model-step-retry suite requires deterministic upstream'
    )
  // The native workflow journey runs against the deterministic coordinator
  // fixture only; the real and real-hybrid cells never prepare it.
  if (suite === 'native-workflow' && mode !== 'deterministic')
    throw new Error(
      'APPROVED_TOOLS_SUITE_UNSUPPORTED: native-workflow suite requires deterministic upstream'
    )
  return suite
}

// Restore binds the env suite to the recorded state. A state written before the
// field existed is accepted only as the approved-tools shape it must have been.
export function validateSuiteOwnership(state, suite) {
  validateSuite(suite)
  if (state.suite !== undefined) {
    if (state.suite !== suite) throw new Error('FIXTURE_SUITE_MISMATCH: recorded suite differs')
    return suite
  }
  if (suite !== 'approved-tools' || (state.provider ?? 'codex') !== 'codex')
    throw new Error(
      'LEGACY_STATE_SUITE_UNSUPPORTED: a state without suite is accepted only as approved-tools'
    )
  const scenarios = state.scenarios
  if (
    !Array.isArray(scenarios) ||
    scenarios.length !== 3 ||
    sizes.some(size => scenarios.filter(row => row?.catalogSize === size).length !== 1)
  )
    throw new Error('LEGACY_STATE_SCENARIO_SHAPE_MISMATCH: expected the 83/150/250 scenarios')
  if (!state.workflowScenario)
    throw new Error('LEGACY_STATE_WORKFLOW_SHAPE_MISMATCH: approved-tools records a workflow')
  if (state.identityJournal?.grants?.workflow === undefined)
    throw new Error('LEGACY_STATE_GRANT_SHAPE_MISMATCH: approved-tools records a workflow grant')
  return suite
}

function proxyPreset(provider) {
  validateProvider(provider)
  return provider === 'grok'
    ? {
        name: 'grok-llm-proxy',
        image: 'clerum/grok-approved-tools-proxy-e2e:test',
        flags: [
          'GROK_APPROVED_TOOLS_TEST_ONLY',
          'GROK_APPROVED_TOOLS_MINIKUBE_PROFILE',
          'NODE_ENV',
        ],
      }
    : { name: 'codex-llm-proxy', image: proxyImage, flags: proxyFlags }
}

export function requireGrokConnectionName(value) {
  const name = value?.trim()
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name))
    throw new Error(
      'GROK_CONNECTION_REQUIRED: set APPROVED_TOOLS_GROK_CONNECTION_NAME to the user-authorized Control UI connection'
    )
  return name
}

// MS-SUB: read-only subscription gates. Both providers are checked here so a
// lane stops before its first mutation, not in the setup UI after the identities
// and the agent exist. Nothing in this section writes: no fixture state, no API
// login (so no password-admission cost), no cluster mutation.
export const CODEX_SUBSCRIPTION_GATE_DISABLED = 'CODEX_SUBSCRIPTION_GATE_DISABLED'
export const GROK_SUBSCRIPTION_GATE_DISABLED = 'GROK_SUBSCRIPTION_GATE_DISABLED'

/** The closed per-provider tokens the gate may print. */
export function subscriptionGateToken(provider) {
  return validateProvider(provider) === 'grok'
    ? GROK_SUBSCRIPTION_GATE_DISABLED
    : CODEX_SUBSCRIPTION_GATE_DISABLED
}

/** The model every prepared agent of this provider runs (the lane's model). */
export function providerModelName(provider) {
  return validateProvider(provider) === 'grok' ? GROK_MODEL_NAME : 'gpt-5.3-codex'
}

/**
 * The flags each provider's lane needs in the running workloads. Each flag is
 * required only on the workload that consumes it: control-api reads the
 * CONTROL_API_* subscription flags, each proxy reads its own
 * *_LLM_PROXY_EXECUTION_ENABLED (grok-llm-proxy/src/config.ts reads
 * GROK_LLM_PROXY_EXECUTION_ENABLED; nothing in control-api does), and the Host
 * flag is Codex-only.
 */
export function subscriptionGateFlags(provider) {
  validateProvider(provider)
  return provider === 'grok'
    ? {
        controlApi: ['CONTROL_API_GROK_SUBSCRIPTION_ENABLED'],
        proxy: ['GROK_LLM_PROXY_EXECUTION_ENABLED'],
        host: [],
      }
    : {
        controlApi: ['CONTROL_API_CODEX_SUBSCRIPTION_ENABLED'],
        proxy: ['CODEX_LLM_PROXY_EXECUTION_ENABLED'],
        host: ['MCP_HOST_CODEX_SUBSCRIPTION_ENABLED'],
      }
}

/**
 * The provider flag gate. `execFlags` reads the live environment of one workload
 * and returns `{ [flag]: boolean }`; `hostConfig` is the `mcp-host-config`
 * ConfigMap. A false flag fails with the provider token and the exact flag name,
 * so the operator can name what is off without reading a workload.
 */
export function checkSubscriptionGates({ provider, execFlags, hostConfig }) {
  const token = subscriptionGateToken(provider)
  const flags = subscriptionGateFlags(provider)
  for (const [deploymentName, keys] of [
    ['control-api', flags.controlApi],
    [provider === 'grok' ? 'grok-llm-proxy' : 'codex-llm-proxy', flags.proxy],
  ]) {
    if (!keys.length) continue
    const observed = execFlags(deploymentName, keys)
    for (const key of keys)
      if (observed?.[key] !== true) throw new Error(`${token}: ${key}`)
  }
  for (const key of flags.host)
    if (hostConfig?.data?.[key] !== 'true') throw new Error(`${token}: ${key}`)
  return { provider, checked: [...flags.controlApi, ...flags.proxy, ...flags.host] }
}

// The Grok connection is user-owned: the lane only reads it. These are the only
// two statements the gate issues, and neither names a ciphertext column.
export const GROK_CONNECTION_SELECT = `SELECT connection_key, display_name, status, revoked_at, catalog_status
    FROM grok_subscription_connections WHERE connection_key = $1 OR display_name = $1`
export const GROK_CATALOG_SELECT = `SELECT m.model, m.enabled, m.stale
    FROM grok_catalog_models m
    JOIN grok_subscription_connections c ON c.id = m.connection_id
    WHERE c.connection_key = $1 OR c.display_name = $1`
// `assertGrokConnectionKey` (control-api/src/services/grokSubscriptionSchema.ts:4-16):
// a key outside this grammar is hidden from the admin list, so a lane that
// names it can never be bound from the Control UI.
export const GROK_CONNECTION_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
export const GROK_MODEL_NAME = 'grok-4.6'

export function isAddressableGrokConnectionKey(value) {
  const key = typeof value === 'string' ? value.trim() : ''
  return (
    GROK_CONNECTION_KEY_PATTERN.test(key) &&
    key !== 'unassigned' &&
    key !== 'deployment-default'
  )
}

/**
 * Evaluates the two read-only row sets the gate collected. Every refusal has its
 * own token, and the pass names the connection, its status and its catalog
 * status so the lane's evidence proves what it accepted.
 */
export async function evaluateGrokSubscription(db, { connectionName, modelName }) {
  const name = requireGrokConnectionName(connectionName)
  if (typeof modelName !== 'string' || !modelName.trim())
    throw new Error('GROK_CONNECTION_MODEL_MISSING: the lane names no model')
  const connections = (await db.query(GROK_CONNECTION_SELECT, [name])).rows
  if (!Array.isArray(connections)) throw new Error('GROK_CONNECTION_MISSING: no row set returned')
  if (connections.length === 0)
    throw new Error(`GROK_CONNECTION_MISSING: no Grok connection matches '${name}'`)
  if (connections.length > 1)
    throw new Error(`GROK_CONNECTION_AMBIGUOUS: ${connections.length} Grok connections match '${name}'`)
  const [row] = connections
  if (row.revoked_at !== null || row.status === 'revoked')
    throw new Error(`GROK_CONNECTION_REVOKED: ${row.connection_key}`)
  if (row.status !== 'connected')
    throw new Error(`GROK_CONNECTION_NOT_CONNECTED: ${row.connection_key} is ${row.status}`)
  if (!isAddressableGrokConnectionKey(row.connection_key))
    throw new Error(`GROK_CONNECTION_NOT_ADDRESSABLE: ${row.connection_key}`)
  if (row.catalog_status !== 'ready')
    throw new Error(`GROK_CONNECTION_CATALOG_NOT_READY: ${row.connection_key} is ${row.catalog_status}`)
  const models = (await db.query(GROK_CATALOG_SELECT, [name])).rows
  if (!Array.isArray(models)) throw new Error('GROK_CONNECTION_MODEL_MISSING: no model row set returned')
  const entry = models.find(candidate => candidate?.model === modelName)
  if (!entry) throw new Error(`GROK_CONNECTION_MODEL_MISSING: ${modelName}`)
  if (entry.enabled !== true)
    throw new Error(`GROK_CONNECTION_MODEL_UNAVAILABLE: ${modelName} is disabled`)
  if (entry.stale !== false)
    throw new Error(`GROK_CONNECTION_MODEL_UNAVAILABLE: ${modelName} is stale`)
  return {
    connectionKey: row.connection_key,
    displayName: row.display_name,
    status: row.status,
    catalogStatus: row.catalog_status,
    model: entry.model,
    modelEnabled: entry.enabled === true,
  }
}

/**
 * The in-pod read. It runs the two SELECTs above inside one `READ ONLY`
 * transaction on a single pooled client (a `pool.query` sequence does not pin a
 * connection) and prints the two bounded row sets; the host evaluates them with
 * `evaluateGrokSubscription`, so the refusal logic has exactly one home. The
 * connection name arrives as `node -e <script> <name>` (argv[1]), never inside
 * the program text.
 */
export const grokSubscriptionProbeScript = `const connectionName = process.argv[1]
import('/app/control-api/dist/db.js').then(async ({ pool }) => {
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    const connections = (await client.query(${JSON.stringify(GROK_CONNECTION_SELECT)}, [connectionName])).rows
    const models = (await client.query(${JSON.stringify(GROK_CATALOG_SELECT)}, [connectionName])).rows
    await client.query('ROLLBACK')
    process.stdout.write(JSON.stringify({ connections, models }))
  } finally {
    client.release()
    await pool.end()
  }
}).catch(error => {
  process.stderr.write(String(error && error.message ? error.message : error).slice(0, 512) + '\\n')
  process.exit(1)
})`

/** The connection-name argument the probe accepts; same closed set as the env name. */
export const GROK_CONNECTION_ARGUMENT = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,199}$/

const grokConnectionColumns = ['connection_key', 'display_name', 'status', 'revoked_at', 'catalog_status']

/** Strictly bounded parse of the probe output: the exact projected columns. */
export function parseGrokSubscriptionProbe(output) {
  const parsed = JSON.parse(output)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('GROK_CONNECTION_READ_FAILED: invalid probe output')
  const { connections, models } = parsed
  if (!Array.isArray(connections) || !Array.isArray(models))
    throw new Error('GROK_CONNECTION_READ_FAILED: invalid probe output')
  for (const row of connections) {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new Error('GROK_CONNECTION_READ_FAILED: invalid connection row')
    if (Object.keys(row).some(key => !grokConnectionColumns.includes(key)))
      throw new Error('GROK_CONNECTION_READ_FAILED: unexpected connection column')
    if (typeof row.connection_key !== 'string' || typeof row.status !== 'string')
      throw new Error('GROK_CONNECTION_READ_FAILED: invalid connection row')
  }
  for (const row of models) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 3)
      throw new Error('GROK_CONNECTION_READ_FAILED: invalid catalog row')
    if (typeof row.model !== 'string' || typeof row.enabled !== 'boolean' || typeof row.stale !== 'boolean')
      throw new Error('GROK_CONNECTION_READ_FAILED: invalid catalog row')
  }
  return { connections, models }
}

/** Replays the in-pod read into the same query surface the evaluator uses. */
export function replayedGrokSubscriptionDatabase(rows) {
  return {
    async query(sql) {
      if (sql === GROK_CONNECTION_SELECT) return { rows: rows.connections }
      if (sql === GROK_CATALOG_SELECT) return { rows: rows.models }
      throw new Error('GROK_CONNECTION_READ_FAILED: unexpected statement')
    },
  }
}

/**
 * The read-only transport every subscription gate call uses. All three
 * operations are strict: the flag probe is a fixed program, the Grok read is a
 * fixed program plus a closed-set connection name, and the Host ConfigMap read is
 * memoized so the gate and the Host-config capture observe one read.
 */
export function subscriptionGateTransport({ provider, kubectl }) {
  let hostConfig
  return (operation, deploymentName, keys) => {
    if (operation === 'read-host-config') {
      if (!hostConfig)
        hostConfig = JSON.parse(
          kubectl(['-n', 'mcp-host', 'get', 'configmap/mcp-host-config', '-o', 'json'])
        )
      return hostConfig
    }
    if (operation === 'exec-flags') {
      const observed = JSON.parse(
        kubectl([
          '-n',
          'control-plane',
          'exec',
          `deployment/${deploymentName}`,
          '--',
          'node',
          '-e',
          flagProbeScript(keys),
        ])
      )
      if (!observed || typeof observed !== 'object' || Array.isArray(observed))
        throw new Error(`${subscriptionGateToken(provider)}: ${deploymentName} printed no flags`)
      const flags = {}
      for (const key of keys) flags[key] = observed[key] === true
      return flags
    }
    if (operation === 'grok-probe')
      return kubectl([
        '-n',
        'control-plane',
        'exec',
        'deployment/control-api',
        '--',
        'node',
        '-e',
        grokSubscriptionProbeScript,
        requireGrokConnectionName(process.env.APPROVED_TOOLS_GROK_CONNECTION_NAME),
      ])
    throw new Error('Invalid subscription gate operation')
  }
}

/**
 * Standalone `check-subscriptions`: every provider's read-only gate, run by the
 * lane's launcher before any mutation and again as prepare's first step. It
 * returns the bounded receipt the caller prints; it never touches fixture state.
 */
export async function checkSubscriptions({ provider, kubectlExec, connectionName, modelName }) {
  validateProvider(provider)
  const hostConfig = kubectlExec('read-host-config')
  const gates = checkSubscriptionGates({
    provider,
    execFlags: (deploymentName, keys) => kubectlExec('exec-flags', deploymentName, keys),
    hostConfig,
  })
  if (provider === 'grok') {
    const probe = parseGrokSubscriptionProbe(kubectlExec('grok-probe', connectionName))
    const receipt = await evaluateGrokSubscription(replayedGrokSubscriptionDatabase(probe), {
      connectionName,
      modelName,
    })
    return { ...gates, connection: receipt }
  }
  return { ...gates, connection: undefined }
}

/** The exact probe programs each workload may run for the subscription gate. */
export function subscriptionProbeScripts(resource) {
  const probes = {
    'deployment/control-api': [
      flagProbeScript(subscriptionGateFlags('codex').controlApi),
      flagProbeScript(subscriptionGateFlags('grok').controlApi),
    ],
    'deployment/codex-llm-proxy': [flagProbeScript(subscriptionGateFlags('codex').proxy)],
    'deployment/grok-llm-proxy': [flagProbeScript(subscriptionGateFlags('grok').proxy)],
  }
  return probes[resource] ?? []
}


// Only this one nonsecret setting belongs to the mutation. An absent original
// is recorded as null so JSON merge patch deletes it on restore.
export function captureHostConfig(config) {
  const metadata = config?.metadata
  const value = config?.data?.CODEX_TOOL_PRESENTATION ?? null
  if (
    !/^[a-zA-Z0-9-]{1,128}$/.test(metadata?.uid ?? '') ||
    !/^[0-9]{1,32}$/.test(metadata?.resourceVersion ?? '') ||
    metadata.annotations?.[proxyRunAnnotation] !== undefined ||
    ![null, 'direct', 'discovery', 'auto'].includes(value)
  )
    throw new Error('Host ConfigMap ownership or presentation is invalid')
  return { metadata: { uid: metadata.uid, resourceVersion: metadata.resourceVersion }, value }
}

function hostConfigPatch(metadata, value, run) {
  return {
    metadata: {
      uid: metadata.uid,
      resourceVersion: metadata.resourceVersion,
      annotations: { [proxyRunAnnotation]: run },
    },
    data: { CODEX_TOOL_PRESENTATION: value },
  }
}

function validateHostConfigPatch(patch) {
  const metadata = patch?.metadata
  const run = metadata?.annotations?.[proxyRunAnnotation]
  const value = patch?.data?.CODEX_TOOL_PRESENTATION
  if (
    !/^[a-zA-Z0-9-]{1,128}$/.test(metadata?.uid ?? '') ||
    !/^[0-9]{1,32}$/.test(metadata?.resourceVersion ?? '') ||
    !(run === null || /^approved-tools-[a-f0-9]{12}$/.test(run ?? '')) ||
    ![null, 'direct', 'discovery', 'auto'].includes(value) ||
    (run !== null && value !== 'auto') ||
    JSON.stringify(patch) !== JSON.stringify(hostConfigPatch(metadata, value, run))
  )
    throw new Error('Invalid Host ConfigMap patch')
}

export async function applyHostConfig({ state, get, patch }) {
  const live = await get()
  if (JSON.stringify(captureHostConfig(live)) !== JSON.stringify(state.hostConfig))
    throw new Error('Host ConfigMap ownership changed before patch')
  await patch(hostConfigPatch(live.metadata, 'auto', state.run))
  const applied = await get()
  if (
    applied.metadata?.uid !== state.hostConfig.metadata.uid ||
    applied.data?.CODEX_TOOL_PRESENTATION !== 'auto' ||
    applied.metadata.annotations?.[proxyRunAnnotation] !== state.run ||
    !/^[0-9]{1,32}$/.test(applied.metadata.resourceVersion ?? '') ||
    applied.metadata.resourceVersion === live.metadata.resourceVersion
  )
    throw new Error('Host ConfigMap patch witness missing')
  state.hostConfig.appliedResourceVersion = applied.metadata.resourceVersion
}

export async function restoreHostConfig({ state, get, patch }) {
  const captured = state.hostConfig
  const live = await get()
  if (live.metadata?.uid !== captured.metadata.uid)
    throw new Error('Host ConfigMap ownership changed')
  const run = live.metadata.annotations?.[proxyRunAnnotation]
  if (run === undefined && (live.data?.CODEX_TOOL_PRESENTATION ?? null) === captured.value) return
  if (run !== state.run || live.data?.CODEX_TOOL_PRESENTATION !== 'auto')
    throw new Error('Host ConfigMap ownership changed')
  await patch(hostConfigPatch(live.metadata, captured.value, null))
  const restored = await get()
  if (
    restored.metadata?.uid !== captured.metadata.uid ||
    restored.metadata.annotations?.[proxyRunAnnotation] !== undefined ||
    (restored.data?.CODEX_TOOL_PRESENTATION ?? null) !== captured.value
  )
    throw new Error('Host ConfigMap restoration witness missing')
}

// Read-only running-image proof, separate from the profile's tag inventory.
export function observeGrokProxyPods(pods, state) {
  const expected = state.imageProof.images['clerum/grok-approved-tools-proxy-e2e:test']
  if (!/^sha256:[a-f0-9]{64}$/.test(expected ?? '') || !Array.isArray(pods?.items))
    throw new Error('Grok proxy pod image proof is missing')
  const active = pods.items.filter(pod => !pod.metadata?.deletionTimestamp)
  if (active.length === 0) throw new Error('Grok proxy pod image proof has no active pods')
  return active.map(pod => {
    const container = pod.spec?.containers?.find(entry => entry.name === 'grok-llm-proxy')
    const status = pod.status?.containerStatuses?.find(entry => entry.name === 'grok-llm-proxy')
    const imageID = status?.imageID?.match(/(?:^|:\/\/|@)(sha256:[a-f0-9]{64})$/)?.[1]
    if (
      pod.metadata?.namespace !== 'control-plane' ||
      pod.metadata.labels?.app !== 'grok-llm-proxy' ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(pod.metadata.uid ?? '') ||
      !/^[0-9]{1,32}$/.test(pod.metadata.resourceVersion ?? '') ||
      container?.image !== 'clerum/grok-approved-tools-proxy-e2e:test' ||
      pod.status?.phase !== 'Running' ||
      status?.ready !== true ||
      imageID !== expected
    )
      throw new Error('Grok proxy pod image or readiness witness mismatch')
    return { uid: pod.metadata.uid, resourceVersion: pod.metadata.resourceVersion, imageID }
  })
}

// Shared deadline budget: the outer prepare runner wraps Electron
// verification, the static audit, and the inner Playwright run (including its
// spawn grace). The outer deadline derives from those phases plus
// scheduling/reporting grace. Every bound stays finite.
export const APPROVED_TOOLS_PLAYWRIGHT_TIMEOUT_MS = 35 * 60_000
export const APPROVED_TOOLS_ELECTRON_CHECK_TIMEOUT_MS = 30_000
export const APPROVED_TOOLS_STATIC_AUDIT_TIMEOUT_MS = 30_000
export const APPROVED_TOOLS_PLAYWRIGHT_SPAWN_GRACE_MS = 15_000
export const APPROVED_TOOLS_RUNNER_KILL_GRACE_SECONDS = 5
export const APPROVED_TOOLS_RUNNER_SCHEDULING_GRACE_MS = 60_000
export const APPROVED_TOOLS_RUNNER_TIMEOUT_SECONDS = Math.ceil(
  (APPROVED_TOOLS_PLAYWRIGHT_TIMEOUT_MS +
    APPROVED_TOOLS_ELECTRON_CHECK_TIMEOUT_MS +
    APPROVED_TOOLS_STATIC_AUDIT_TIMEOUT_MS +
    APPROVED_TOOLS_PLAYWRIGHT_SPAWN_GRACE_MS +
    APPROVED_TOOLS_RUNNER_SCHEDULING_GRACE_MS) /
    1000
)
export const APPROVED_TOOLS_RUNNER_OUTER_SPAWN_TIMEOUT_MS =
  APPROVED_TOOLS_RUNNER_TIMEOUT_SECONDS * 1000 + 20_000
export const APPROVED_TOOLS_MAX_DEADLINE_MS = 45 * 60_000
export function runnerPhaseBudgetMs() {
  return {
    playwright: APPROVED_TOOLS_PLAYWRIGHT_TIMEOUT_MS,
    electronCheck: APPROVED_TOOLS_ELECTRON_CHECK_TIMEOUT_MS,
    staticAudit: APPROVED_TOOLS_STATIC_AUDIT_TIMEOUT_MS,
    playwrightSpawnGrace: APPROVED_TOOLS_PLAYWRIGHT_SPAWN_GRACE_MS,
    schedulingGrace: APPROVED_TOOLS_RUNNER_SCHEDULING_GRACE_MS,
    runnerTimeoutSeconds: APPROVED_TOOLS_RUNNER_TIMEOUT_SECONDS,
    runnerOuterSpawnTimeoutMs: APPROVED_TOOLS_RUNNER_OUTER_SPAWN_TIMEOUT_MS,
    maxDeadlineMs: APPROVED_TOOLS_MAX_DEADLINE_MS,
  }
}

export function makeScenarios(run, ports, probePort, provider, connectionName, suite) {
  validateSuiteMatrix(provider, suite, 'deterministic')
  if (provider === 'grok') requireGrokConnectionName(connectionName)
  const selectedSizes = suite === 'model-step-retry' ? [83] : sizes
  if (!/^approved-tools-[a-f0-9]{12}$/.test(run)) throw new Error('Invalid fixture run identity')
  if (
    ports.length !== selectedSizes.length ||
    new Set([...ports, probePort]).size !== selectedSizes.length + 1 ||
    [...ports, probePort].some(p => !Number.isInteger(p) || p < 1024 || p > 65535)
  )
    throw new Error('Invalid fixture ports')
  return selectedSizes.map((catalogSize, index) =>
    scenarioMetadata(
      run,
      String(catalogSize),
      catalogSize,
      ports[index],
      probePort,
      provider,
      connectionName
    )
  )
}

function scenarioMetadata(
  run,
  label,
  catalogSize,
  port,
  probePort,
  provider = 'codex',
  connectionName
) {
  return {
    ...(provider === 'grok' ? { provider } : {}),
    catalogSize,
    runId: `${run}-${label}`,
    agentName: `${run}-agent-${label}`,
    agentDisplayName: `${provider === 'grok' ? 'Grok' : 'Codex'} tools ${label} ${run}`,
    contextName: `${run}-context-${label}`,
    connectorName: `${run}-mcp-${label}`,
    subscriptionName:
      provider === 'grok'
        ? requireGrokConnectionName(connectionName)
        : `Codex fixture ${label} ${run}`,
    connectionKey: `${run}-grant-${label}`,
    modelName: providerModelName(provider),
    fixtureUrl: `http://127.0.0.1:${port}`,
    upstreamEvidenceUrl: `http://127.0.0.1:${probePort}`,
  }
}

export function makeWorkflowScenario(run, port, probePort) {
  if (
    !/^approved-tools-[a-f0-9]{12}$/.test(run) ||
    port === probePort ||
    [port, probePort].some(p => !Number.isInteger(p) || p < 1024 || p > 65535)
  )
    throw new Error('Invalid workflow fixture identity or ports')
  return {
    ...scenarioMetadata(run, 'workflow', 83, port, probePort),
    workflowName: `${run}-recipe`,
    workflowNamespace: 'sandbox-recipes',
  }
}

export function makeWorkflowResources(scenario) {
  const labels = {
    'evenfire.ai/e2e-suite': 'codex-approved-tools',
    'evenfire.ai/e2e-run': scenario.runId,
  }
  // Output scope is the parent recipe for both its runtime and triggered child
  // runs. The component selector excludes every other pod in that lineage.
  const coordinator = {
    matchLabels: {
      'clerum.io/workflow-output-scope': scenario.workflowName,
      'clerum.io/component': 'workflow-coordinator',
    },
  }
  const backend = { matchLabels: { 'clerum.io/mcpserver': scenario.connectorName } }
  const namespace = name => ({ matchLabels: { 'kubernetes.io/metadata.name': name } })
  return [
    {
      apiVersion: 'clerum.io/v1alpha1',
      kind: 'WorkflowRecipe',
      metadata: {
        name: scenario.workflowName,
        namespace: scenario.workflowNamespace,
        labels,
        annotations: { 'clerum.io/codex-connection-ref': scenario.connectionKey },
      },
      spec: {
        coordinatorImage: workflowImage,
        // WRC requires a broker agent for declared MCP dependencies. The fixture
        // coordinator never requests a model; the binding remains explicit.
        agent: { provider: 'codex-subscription', model: scenario.modelName },
        // Actual MCP dependency makes WRC defer the parent until a triggered run;
        // a bare id-only custom step would otherwise start eagerly.
        steps: [{ id: 'receipt', mcpServers: ['receipt'] }],
        mcpServers: [
          {
            id: 'receipt',
            endpoint: `http://${scenario.connectorName}.mcp-server.svc.cluster.local:8080/mcp`,
          },
        ],
        output: { destination: 'pvc', format: 'json' },
        triggers: { onDemand: { requiresApproval: true, allowedActors: ['user'] } },
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: `${scenario.workflowName}-receipt-egress`,
        namespace: scenario.workflowNamespace,
        labels,
      },
      spec: {
        podSelector: coordinator,
        policyTypes: ['Egress'],
        egress: [
          {
            to: [{ namespaceSelector: namespace('mcp-server'), podSelector: backend }],
            ports: [{ protocol: 'TCP', port: 8080 }],
          },
        ],
      },
    },
    {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: `${scenario.workflowName}-receipt-ingress`,
        namespace: 'mcp-server',
        labels,
      },
      spec: {
        podSelector: backend,
        policyTypes: ['Ingress'],
        ingress: [
          {
            from: [
              {
                namespaceSelector: namespace(scenario.workflowNamespace),
                podSelector: coordinator,
              },
            ],
            ports: [{ protocol: 'TCP', port: 8080 }],
          },
        ],
      },
    },
  ]
}

export function makeResources(scenarios) {
  return scenarios.flatMap(s => {
    const labels = {
      'evenfire.ai/e2e-suite': 'codex-approved-tools',
      'evenfire.ai/e2e-run': s.runId,
    }
    return [
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'Context',
        metadata: { name: s.contextName, namespace: 'mcp-server', labels },
        spec: { contextId: s.contextName, mcpServers: [] },
      },
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'Host',
        metadata: { name: s.agentName, namespace: 'mcp-host', labels },
        spec: {
          host: s.agentDisplayName,
          contextRef: s.contextName,
          model: {
            provider: s.provider === 'grok' ? 'grok-subscription' : 'codex-subscription',
            name: s.modelName,
            connectionRef: 'unassigned',
          },
          channels: [],
          ...(s.workflowName
            ? {
                workflowControl: {
                  scopes: [
                    'workflow:list',
                    'workflow:read',
                    'workflow:trigger',
                    'workflow:approval:resolve',
                    'workflow:approval:decide',
                  ],
                },
              }
            : {}),
        },
      },
      {
        apiVersion: 'clerum.io/v1alpha1',
        kind: 'McpServer',
        metadata: { name: s.connectorName, namespace: 'mcp-server', labels },
        spec: {
          image: fixtureImage,
          imagePullPolicy: 'Never',
          enabled: true,
          description: `Isolated approved-tools catalog ${s.catalogSize}`,
          transport: {
            type: 'streamableHttp',
            url: `http://${s.connectorName}.mcp-server.svc.cluster.local:8080/mcp`,
            port: 8080,
          },
          healthCheck: { port: 8080 },
          auth: { type: 'none' },
          env: [
            { name: 'CATALOG_SIZE', value: String(s.catalogSize) },
            { name: 'RUN_ID', value: s.runId },
            { name: 'BIND_ADDRESS', value: '0.0.0.0' },
          ],
          resources: {
            requests: { cpu: '10m', memory: '32Mi' },
            limits: { cpu: '200m', memory: '128Mi' },
          },
        },
      },
    ]
  })
}

// The suite decides which fixtures a lane prepares (#1048 MS-NW). The base
// journeys own the three receipt catalogs and nothing else; only the
// native-workflow suite owns the workflow backend, its port, its `WorkflowRecipe`
// and the coordinator policy that admits its image. `model-step-retry` prepares
// the single 83-tool catalog the retry cases use.
const suiteScenarioLabels = Object.freeze({
  'approved-tools': ['83', '150', '250'],
  'native-workflow': ['workflow'],
  'model-step-retry': ['83'],
})

/**
 * How many profile-owned loopback ports this suite run needs: one per prepared
 * agent plus the shared upstream probe. The base suite prepares three catalogs
 * and the probe (4); the other two prepare one agent and the probe (2).
 */
export function suitePortCount(suite) {
  validateSuite(suite)
  return suiteScenarioLabels[suite].length + 1
}

/**
 * The whole fixture set a suite run prepares, as pure data. `ports` are the
 * non-probe ports in prepared order and `probePort` the shared upstream probe.
 * The caller allocates them, dry-runs the returned resources against the server,
 * and only then mutates the profile.
 */
export function makeSuiteFixtures({ run, suite, provider = 'codex', connectionName, ports, probePort }) {
  validateSuiteMatrix(provider, suite, 'deterministic')
  const labels = suiteScenarioLabels[suite]
  if (!Array.isArray(ports) || ports.length !== labels.length)
    throw new Error(`APPROVED_TOOLS_SUITE_UNSUPPORTED: ${suite} needs ${labels.length} fixture ports`)
  if (suite === 'native-workflow') {
    const workflowScenario = makeWorkflowScenario(run, ports[0], probePort)
    return {
      scenarios: [],
      workflowScenario,
      allScenarios: [workflowScenario],
      resources: [...makeResources([workflowScenario]), ...makeWorkflowResources(workflowScenario)],
    }
  }
  const scenarios = makeScenarios(run, ports, probePort, provider, connectionName, suite)
  return {
    scenarios,
    workflowScenario: undefined,
    allScenarios: scenarios,
    resources: makeResources(scenarios),
  }
}

// `kubectl create --dry-run=server -f - -o json` on a List prints either one
// List document or, as kubectl v1.36 does, one JSON object per item. Accept
// exactly those two shapes; anything else is a malformed response.
export function parseDryRunItems(output) {
  const objects = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < output.length; index++) {
    const char = output[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (depth === 0) {
      if (/\s/.test(char)) continue
      if (char !== '{') throw new Error('Dry-run output is not a sequence of JSON objects')
      start = index
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) objects.push(JSON.parse(output.slice(start, index + 1)))
    }
  }
  if (depth !== 0 || inString) throw new Error('Dry-run output ends inside a JSON object')
  if (objects.length === 0) throw new Error('Dry-run output is empty')
  if (objects.length === 1 && objects[0].kind === 'List') {
    if (!Array.isArray(objects[0].items)) throw new Error('Dry-run List has no items')
    return objects[0].items
  }
  if (objects.some(object => object.kind === 'List'))
    throw new Error('Dry-run output mixes a List with other objects')
  return objects
}

export function assertResourceRoundTrip(expected, observed) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(observed) || observed.length !== expected.length)
      throw new Error('Fixture array was not preserved by the API server')
    expected.forEach((item, index) => assertResourceRoundTrip(item, observed[index]))
  } else if (expected && typeof expected === 'object') {
    if (!observed || typeof observed !== 'object')
      throw new Error('Fixture object was not preserved by the API server')
    for (const [key, value] of Object.entries(expected))
      assertResourceRoundTrip(value, observed[key])
  } else if (expected !== observed)
    throw new Error('Fixture field was not preserved by the API server')
}

// All reads and state writes use the opened descriptor, not a path reopened
// after a check. Nonblocking open lets us reject FIFOs without hanging.
export function openOwnedFile(
  root,
  name,
  { create = false, writable = false, maxBytes = 4 * 1024 * 1024 } = {}
) {
  if (path.basename(name) !== name || !name || name === '.' || name === '..')
    throw new Error('Expected a single owned filename')
  const directory = fs.openSync(
    root,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
  )
  try {
    const parent = fs.fstatSync(directory)
    if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o022)
      throw new Error('Unsafe owner directory')
    const fd = fs.openSync(
      path.join(root, name),
      (writable || create ? fs.constants.O_RDWR : fs.constants.O_RDONLY) |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK |
        (create ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0),
      0o600
    )
    try {
      const stat = fs.fstatSync(fd)
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== parent.uid ||
        stat.mode & 0o022 ||
        stat.size > maxBytes
      )
        throw new Error('Unsafe or oversized owned file')
      return { fd, dev: stat.dev, ino: stat.ino, maxBytes }
    } catch (error) {
      fs.closeSync(fd)
      throw error
    }
  } finally {
    fs.closeSync(directory)
  }
}

export function readOwnedDescriptor(file) {
  const before = fs.fstatSync(file.fd)
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.dev !== file.dev ||
    before.ino !== file.ino ||
    before.size > file.maxBytes
  )
    throw new Error('Owned file changed')
  const buffer = Buffer.alloc(file.maxBytes + 1)
  let offset = 0
  while (offset < buffer.length) {
    const count = fs.readSync(file.fd, buffer, offset, buffer.length - offset, offset)
    if (!count) break
    offset += count
  }
  const after = fs.fstatSync(file.fd)
  if (
    offset > file.maxBytes ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    after.nlink !== 1
  )
    throw new Error('Owned file changed or exceeds its byte budget')
  return buffer.subarray(0, offset).toString('utf8')
}

export function readOwnedFile(root, name, maxBytes) {
  const file = openOwnedFile(root, name, { maxBytes })
  try {
    return readOwnedDescriptor(file)
  } finally {
    fs.closeSync(file.fd)
  }
}

export function validateProfile(profile) {
  if (
    typeof profile !== 'string' ||
    !/^clerum-[a-z0-9-]+-[a-f0-9]{7,8}$/.test(profile) ||
    profile.length > 100
  )
    throw new Error('Invalid owned profile')
  return profile
}

export function validateOwnerArgs(args, recording, profile, pidDirectory) {
  validateProfile(profile)
  if (args.length !== (recording ? 9 : 8)) throw new Error('Invalid owner argument count')
  const [record, ...tail] = args
  if (recording && !/^[1-9][0-9]{0,9}$/.test(tail.shift())) throw new Error('Invalid child PID')
  const [target, context, worktree, namespace, service, localPort, remotePort] = tail
  if (
    target !== profile ||
    context !== profile ||
    worktree !== repo ||
    !['control-plane', 'mcp-server'].includes(namespace) ||
    !/^((codex|grok)-llm-proxy|approved-tools-[a-f0-9]{12}-mcp-(83|150|250|workflow))$/.test(
      service
    )
  )
    throw new Error('Invalid owner binding')
  if (
    !/^[0-9]{4,5}$/.test(localPort) ||
    Number(localPort) < 1024 ||
    Number(localPort) > 65535 ||
    remotePort !== (namespace === 'control-plane' ? '9090' : '8080')
  )
    throw new Error('Invalid owner port')
  if (
    path.dirname(record) !== pidDirectory ||
    !/^approved-tools-[a-f0-9]{12}-((codex|grok)-llm-proxy|approved-tools-[a-f0-9]{12}-mcp-(83|150|250|workflow))\.pid$/.test(
      path.basename(record)
    )
  )
    throw new Error('Invalid owner record path')
  if (
    !path.basename(record).endsWith(`-${service}.pid`) ||
    (namespace === 'control-plane') !== /^(codex|grok)-llm-proxy$/.test(service)
  )
    throw new Error('Invalid owner service binding')
  return args
}

export function validateProxyImage(image, imagePullPolicy, provider = 'codex') {
  validateProvider(provider)
  const allowed =
    provider === 'grok'
      ? /^(clerum\/grok-(llm-proxy|approved-tools-proxy-e2e)|ghcr\.io\/evenfire-ai\/grok-llm-proxy)(:[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})$/
      : /^(clerum\/codex-(llm-proxy|approved-tools-proxy-e2e)|ghcr\.io\/evenfire-ai\/codex-llm-proxy)(:[a-zA-Z0-9._-]+|@sha256:[a-f0-9]{64})$/
  if (!allowed.test(image) || !['Always', 'IfNotPresent', 'Never'].includes(imagePullPolicy))
    throw new Error('Invalid proxy image')
}

export function validateKubectlArgs(args, profile, { input, resourceCleanup } = {}) {
  if (args[0] !== `--context=${validateProfile(profile)}` || args[1] !== '--request-timeout=30s')
    throw new Error('Invalid kubectl context or timeout')
  const operation = args.slice(2)
  const exact = allowed => JSON.stringify(operation) === JSON.stringify(allowed)
  if (resourceCleanup) {
    const { entry, live, run } = resourceCleanup
    if (exact(fixtureResourceGetArgs(entry, run)) && input === undefined) return args
    const request = fixtureDeleteRequest(entry, live, run)
    if (exact(['delete', '--raw', request.path, '-f', '-'])) {
      validateFixtureDeleteRequest({ ...request, body: JSON.parse(input) }, entry, live, run)
      return args
    }
    throw new Error('Invalid owned resource cleanup operation')
  }
  if (
    exact(['create', '--dry-run=server', '-f', '-', '-o', 'json']) ||
    exact(['create', '-f', '-', '-o', 'json'])
  )
    return args
  const [flag, namespace, verb, resource] = operation
  if (flag !== '-n' || !['control-plane', 'mcp-host', 'mcp-server'].includes(namespace))
    throw new Error('Unsupported namespace')
  if (
    verb === 'get' &&
    operation.length === 6 &&
    operation[4] === '-o' &&
    operation[5] === 'json' &&
    ((namespace === 'control-plane' &&
      [
        'deployment/codex-llm-proxy',
        'service/codex-llm-proxy',
        'deployment/grok-llm-proxy',
        'service/grok-llm-proxy',
        'deployment/control-api',
      ].includes(resource)) ||
      (namespace === 'mcp-host' && resource === 'configmap/mcp-host-config'))
  )
    return args
  if (
    operation.length === 6 &&
    operation[5] === '--timeout=180s' &&
    ((verb === 'rollout' && resource === 'status') ||
      (verb === 'wait' && resource === '--for=create')) &&
    ((namespace === 'control-plane' &&
      [
        'deployment/codex-llm-proxy',
        'deployment/grok-llm-proxy',
        'deployment/control-api',
      ].includes(operation[4])) ||
      (namespace === 'mcp-server' &&
        /^deployment\/approved-tools-[a-f0-9]{12}-mcp-(83|150|250|workflow)$/.test(operation[4])))
  )
    return args
  if (exact(['-n', 'control-plane', 'get', 'pods', '-l', 'app=grok-llm-proxy', '-o', 'json']))
    return args
  if (
    namespace === 'mcp-host' &&
    verb === 'patch' &&
    resource === 'configmap/mcp-host-config' &&
    operation.length === 7 &&
    operation[4] === '--type=merge' &&
    operation[5] === '-p'
  ) {
    validateHostConfigPatch(JSON.parse(operation[6]))
    return args
  }
  if (
    namespace === 'control-plane' &&
    verb === 'patch' &&
    resource === 'deployment/control-api' &&
    operation.length === 7 &&
    operation[4] === '--type=strategic' &&
    operation[5] === '-p'
  ) {
    validateControlApiPatch(JSON.parse(operation[6]), profile)
    return args
  }
  if (
    namespace === 'control-plane' &&
    verb === 'patch' &&
    ['deployment/codex-llm-proxy', 'deployment/grok-llm-proxy'].includes(resource) &&
    operation.length === 7 &&
    operation[4] === '--type=strategic' &&
    operation[5] === '-p'
  ) {
    const provider = resource === 'deployment/grok-llm-proxy' ? 'grok' : 'codex'
    const proxy = proxyPreset(provider)
    const flags = proxy.flags
    const allowedFlags = provider === 'codex' ? hybridProxyFlags : flags
    const patch = JSON.parse(operation[6])
    if (
      patch.metadata !== undefined &&
      (Object.keys(patch.metadata).length !== 2 ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(patch.metadata.uid ?? '') ||
        !/^[0-9]{1,32}$/.test(patch.metadata.resourceVersion ?? ''))
    )
      throw new Error('Invalid proxy object binding')
    const annotations = patch?.spec?.template?.metadata?.annotations
    if (
      annotations !== undefined &&
      (Object.keys(annotations).length !== 1 ||
        !(
          annotations[proxyRunAnnotation] === null ||
          /^approved-tools-[a-f0-9]{12}$/.test(annotations[proxyRunAnnotation] ?? '')
        ))
    )
      throw new Error('Invalid proxy run binding')
    const entries = patch?.spec?.template?.spec?.containers
    if (!Array.isArray(entries) || entries.length !== 1) throw new Error('Invalid proxy patch')
    const c = entries[0]
    if (c.name !== proxy.name) throw new Error('Invalid proxy image')
    validateProxyImage(c.image, c.imagePullPolicy, provider)
    if (
      !Array.isArray(c.env) ||
      !(provider === 'grok' ? [3] : [3, 5]).includes(c.env.length) ||
      new Set(c.env.map(e => e.name)).size !== c.env.length ||
      (c.env.length === 5 && hybridProxyFlags.some(name => !c.env.some(e => e.name === name))) ||
      (c.env.length === 3 && flags.some(name => !c.env.some(e => e.name === name))) ||
      c.env.some(
        e =>
          !allowedFlags.includes(e.name) ||
          Object.keys(e).length !== 2 ||
          (e.$patch !== 'delete' &&
            !(e.name === 'NODE_ENV'
              ? ['production', 'development', 'test'].includes(e.value)
              : e.name === flags[0]
                ? e.value === '1'
                : e.name === flags[1]
                  ? e.value === profile
                  : e.name === 'APPROVED_TOOLS_UPSTREAM_MODE'
                    ? e.value === 'real-hybrid'
                    : e.value === '1'))
      )
    )
      throw new Error('Invalid proxy environment')
    const normalized = {
      ...(patch.metadata === undefined
        ? {}
        : {
            metadata: {
              uid: patch.metadata.uid,
              resourceVersion: patch.metadata.resourceVersion,
            },
          }),
      spec: {
        template: {
          ...(annotations === undefined ? {} : { metadata: { annotations } }),
          spec: {
            containers: [
              { name: c.name, image: c.image, imagePullPolicy: c.imagePullPolicy, env: c.env },
            ],
          },
        },
      },
    }
    if (JSON.stringify(normalized) !== JSON.stringify(patch))
      throw new Error('Unexpected proxy patch fields')
    return args
  }
  // Remote Node programs are fixed feature probes or the bounded repository
  // seed, never selected through environment variables or an arbitrary path.
  if (namespace === 'control-plane' && verb === 'exec') {
    if (
      operation.length === 8 &&
      operation[4] === '--' &&
      operation[5] === 'node' &&
      operation[6] === '-e'
    ) {
      if (resource === 'deployment/control-api' && operation[7] === controlApiMarkerCheck)
        return args
      if (resource === 'deployment/workflow-recipes' && operation[7] === workflowFeatureCheck)
        return args
      if (subscriptionProbeScripts(resource).includes(operation[7])) return args
    }
    if (
      operation.length === 9 &&
      resource === 'deployment/control-api' &&
      operation[4] === '--' &&
      operation[5] === 'node' &&
      operation[6] === '-e' &&
      operation[7] === grokSubscriptionProbeScript &&
      GROK_CONNECTION_ARGUMENT.test(operation[8] ?? '')
    )
      return args
    if (
      operation.length === 10 &&
      resource === '-i' &&
      operation[4] === 'deployment/control-api' &&
      operation[5] === '--' &&
      operation[6] === 'node' &&
      operation[7] === '--input-type=module' &&
      operation[8] === '--eval' &&
      operation[9] ===
        readOwnedFile(
          path.join(repo, 'tests/e2e/fixtures/codex-subscription/approved-tools-setup'),
          'seed.mjs',
          128 * 1024
        )
    )
      return args
  }
  throw new Error('Unsupported kubectl operation')
}

function command(
  operation,
  args,
  {
    input,
    timeout = 60_000,
    inherit = false,
    resourceCleanup,
    onRunnerStart,
    identityResult = false,
  } = {}
) {
  const env = { ...process.env }
  for (const key of Object.keys(env))
    if (
      ['BASH_ENV', 'ENV', 'SHELLOPTS', 'CDPATH', 'NODE_OPTIONS', 'NODE_PATH'].includes(key) ||
      key.startsWith('BASH_FUNC_')
    )
      delete env[key]
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > APPROVED_TOOLS_MAX_DEADLINE_MS)
    throw new Error('Invalid deadline')
  const options = {
    cwd: repo,
    env,
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'],
  }
  let result
  switch (operation) {
    case 'lease':
      result = spawnSync('bash', ['scripts/minikube/require-t2-mutation-lock.sh'], options)
      break
    case 'head':
      result = spawnSync('git', ['rev-parse', 'HEAD'], options)
      break
    case 'image-inventory':
      if (args.length !== 0) throw new Error('Unexpected image inventory arguments')
      result = spawnSync(
        'minikube',
        [
          '--profile',
          validateProfile(required('MINIKUBE_PROFILE')),
          'image',
          'ls',
          '--format=json',
        ],
        options
      )
      break
    case 'kubectl':
      result = spawnSync(
        'kubectl',
        validateKubectlArgs(args, required('MINIKUBE_PROFILE'), { input, resourceCleanup }),
        options
      )
      break
    case 'pf_owner_record_process':
      result = spawnSync(
        'bash',
        ['scripts/e2e/codex-approved-tools-pf-owner.sh', 'record', ...args],
        options
      )
      break
    case 'pf_owner_record_process_matches':
      result = spawnSync(
        'bash',
        ['scripts/e2e/codex-approved-tools-pf-owner.sh', 'matches', ...args],
        options
      )
      break
    case 'pf_owner_cleanup_record':
      result = spawnSync(
        'bash',
        ['scripts/e2e/codex-approved-tools-pf-owner.sh', 'cleanup', ...args],
        options
      )
      break
    case 'runner': {
      const child = spawn(
        process.execPath,
        [
          'scripts/minikube/run-with-deadline.mjs',
          '--timeout-seconds',
          String(APPROVED_TOOLS_RUNNER_TIMEOUT_SECONDS),
          '--kill-grace-seconds',
          String(APPROVED_TOOLS_RUNNER_KILL_GRACE_SECONDS),
          '--label',
          'approved-tools-runner',
          '--',
          process.execPath,
          'scripts/e2e/run-codex-approved-tools.mjs',
        ],
        {
          cwd: repo,
          env,
          stdio: 'inherit',
          timeout: APPROVED_TOOLS_RUNNER_OUTER_SPAWN_TIMEOUT_MS,
        }
      )
      onRunnerStart?.(child)
      return new Promise((resolve, reject) => {
        child.once('error', () => reject(new Error('Bounded fixture operation failed')))
        child.once('close', (code, signal) => {
          if (signal || code !== 0) reject(new Error('Bounded fixture operation failed'))
          else resolve('')
        })
      })
    }
    default:
      throw new Error('Unsupported fixture process')
  }
  // Subprocess output can include runtime state. Only callers parse their
  // specific safe result; never embed raw stderr/stdout in an exception.
  if (result.error || result.signal) throw new Error('Bounded fixture operation failed')
  if (identityResult) {
    // The identity operation is the one subprocess whose bounded stdout carries
    // a closed-set result even on failure; the caller classifies the status.
    if (Buffer.byteLength(result.stdout ?? '') > IDENTITY_RESULT_LIMIT_BYTES)
      throw new Error('Invalid identity result size')
    return { status: result.status, stdout: result.stdout ?? '' }
  }
  if (result.status !== 0) throw new Error('Bounded fixture operation failed')
  return result.stdout ?? ''
}

function required(key) {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key}`)
  return value
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
  return port
}

async function waitHttp(url, accept) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.ok && accept(await response.json())) return
    } catch {
      /* bounded readiness polling of a freshly started owned process */
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('Fixture readiness deadline exceeded')
}

// Independent forward cleanup with strict proxy-write guards.
//
// Profile/worktree ownership is required before any side effect. A HEAD
// change does not block cleanup of our own forwards: when profile and
// worktree still match and the live deployment identity (UID) plus image
// binding are valid, restoration proceeds and the old HEAD is recorded in
// state.headAudit. Proxy patching keeps its UID/image guards; forward cleanup
// uses the ownership-checked cleanup path and runs even when the proxy step
// fails. restored is set only when proxy and every cleanup complete.
// One closed bound for every identity-operation result read on this host.
const IDENTITY_RESULT_LIMIT_BYTES = 256 * 1024
const identityErrorCodes = new Set(IDENTITY_ERROR_CODES)
const identityErrorPhases = new Set(IDENTITY_ERROR_PHASES)

export function parseIdentityJournal(output, expected, status) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > IDENTITY_RESULT_LIMIT_BYTES)
    throw new Error('Invalid identity result size')
  let result
  for (const line of output.split('\n')) {
    try {
      const value = JSON.parse(line)
      if (value?.e2eIdentity) result = value.e2eIdentity
    } catch {
      /* Service logs are not identity operation results. */
    }
  }
  const fields = [
    'version',
    'mode',
    'run',
    'profile',
    'context',
    'users',
    'team',
    'grants',
    'connections',
    ...(expected.provider === 'grok' ? ['provider'] : []),
  ]
  if (
    !result ||
    result.status !== status ||
    fields.some(key => JSON.stringify(result[key]) !== JSON.stringify(expected[key])) ||
    Object.keys(result).some(key => ![...fields, 'status', 'cleanupOutcome'].includes(key))
  )
    throw new Error('Identity operation result does not match recorded intent')
  return result
}

// The cleanup request the host sends to the isolated seed. It names the lane's
// Control Admin (`adminUsername`) so the governed retirement records a real
// operator, and it never carries a credential: preparation keeps those in the
// process environment.
export function identityCleanupRequest(input) {
  return {
    action: 'cleanup',
    mode: 'deterministic',
    suite: input.suite,
    run: input.run,
    profile: input.profile,
    context: input.profile,
    provider: input.provider,
    adminUsername: input.adminUsername,
    scenarios: input.workflowScenario
      ? [...input.scenarios, input.workflowScenario]
      : input.scenarios,
    initialJournal: input.initialJournal,
  }
}

function lastIdentityLine(output, key) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > IDENTITY_RESULT_LIMIT_BYTES)
    return null
  let value = null
  for (const line of output.split('\n')) {
    try {
      const parsed = JSON.parse(line)
      if (parsed?.[key]) value = parsed[key]
    } catch {
      /* Service logs are not identity operation results. */
    }
  }
  return value
}

// A failed identity operation reports only this coded line. Anything else is
// `unparseable`: raw text is never retained, echoed or persisted.
export function parseIdentityFailure(output) {
  const reported = lastIdentityLine(output, 'e2eIdentityError')
  if (
    !reported ||
    typeof reported !== 'object' ||
    Object.keys(reported).length !== 3 ||
    !identityErrorPhases.has(reported.phase) ||
    !identityErrorCodes.has(reported.code) ||
    !(/^[0-9A-Z]{5}$/.test(reported.sqlstate ?? '') || reported.sqlstate === 'UNKNOWN')
  )
    return { code: 'unparseable', phase: 'unknown', sqlstate: 'UNKNOWN' }
  return { code: reported.code, phase: reported.phase, sqlstate: reported.sqlstate }
}

export function identityFailureMessage(failure) {
  const suffix = failure.sqlstate === 'UNKNOWN' ? '' : `_${failure.sqlstate}`
  return `IDENTITY_${failure.phase}_${failure.code}${suffix}`
}

export function isIdentityFailureMessage(value) {
  if (typeof value !== 'string' || !value.startsWith('IDENTITY_')) return false
  const parts = value.slice('IDENTITY_'.length).split('_')
  if (parts.length < 2) return false
  const phase = parts.shift()
  if (!identityErrorPhases.has(phase)) return false
  if (parts.length > 1 && (/^[0-9A-Z]{5}$/.test(parts.at(-1)) || parts.at(-1) === 'UNKNOWN'))
    parts.pop()
  return identityErrorCodes.has(parts.join('_'))
}

export function ingestFixtureConnections(state, read, save) {
  if (state.provider === 'grok') {
    if (state.identityJournal.connections.length !== 0)
      throw new Error('Grok connection is user-owned')
    return
  }
  const input = {
    mode: 'deterministic',
    suite: state.suite,
    run: state.run,
    profile: state.profile,
    context: state.profile,
    // The model-step-retry suite records no workflow scenario.
    scenarios: state.workflowScenario
      ? [...state.scenarios, state.workflowScenario]
      : state.scenarios,
  }
  const env = Object.fromEntries(
    controlApiFixtureEnv(state.run, state.profile).map(e => [e.name, e.value])
  )
  for (const scenario of ['83', '150', '250', 'workflow']) {
    const raw = read(connectionCaptureName(scenario))
    if (raw === null) continue
    const binding = {
      run: state.run,
      profile: state.profile,
      context: state.profile,
      scenario,
      fixtureUserId: state.identityJournal.users[0].id,
    }
    const evidence = validateConnectionCapture(JSON.parse(raw), binding)
    const existing = state.identityJournal.connections.find(entry => entry.scenario === scenario)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(evidence))
        throw new Error('Conflicting recorded connection capture')
      continue
    }
    recordFixtureConnection(input, state.identityJournal, { env }, evidence)
    save()
  }
}

export async function restoreOwnedFixture({
  state,
  profile,
  worktree,
  head,
  getDeployment,
  patchProxy,
  waitProxyRollout,
  cleanupForward,
  cleanupResources,
  cleanupIdentities,
  restoreApi,
  restoreHostConfig: restoreConfig,
}) {
  if (!state || state.profile !== profile || state.worktree !== worktree)
    throw new Error('Fixture ownership mismatch')
  const provider = validateProvider(state.provider ?? 'codex') // Existing state files predate provider selection.
  const proxy = proxyPreset(provider)
  state.restored = false
  if (state.head !== head) {
    state.headAudit = { createdHead: state.head, restoredAtHead: head }
  }
  let proxyError = null
  try {
    const deployment = await getDeployment()
    const container = deployment?.spec?.template?.spec?.containers?.find(c => c.name === proxy.name)
    if (deployment?.metadata?.uid !== state.proxyUid || !container)
      throw new Error('Proxy deployment ownership changed')
    const runBinding = deployment.spec.template.metadata?.annotations?.[proxyRunAnnotation]
    if (runBinding !== undefined && runBinding !== state.run)
      throw new Error('Proxy belongs to another fixture run')
    if (container.image === proxy.image) {
      if (!/^approved-tools-[a-f0-9]{12}$/.test(state.run ?? '') || runBinding !== state.run)
        throw new Error('Proxy fixture run binding is missing')
      const env = (state.mode === 'real-hybrid' ? hybridProxyFlags : proxy.flags).map(name => ({
        name,
        $patch: 'delete',
      }))
      if (state.originalNodeEnv) env[2] = state.originalNodeEnv
      await patchProxy({
        metadata: {
          uid: deployment.metadata.uid,
          resourceVersion: deployment.metadata.resourceVersion,
        },
        image: state.originalProxyImage,
        imagePullPolicy: state.originalImagePullPolicy,
        env,
        annotations: { [proxyRunAnnotation]: null },
      })
    } else if (container.image !== state.originalProxyImage)
      throw new Error('Refusing to restore an unrelated proxy image')
    else if (runBinding !== undefined)
      throw new Error('Original proxy still has a fixture run binding')
    await waitProxyRollout()
  } catch (error) {
    proxyError = error
  }
  const cleanupErrors = []
  for (const binding of state.forwards ?? []) {
    try {
      await cleanupForward(binding)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  let resourcesFailed = false
  try {
    if (state.resources?.length && !cleanupResources)
      throw new Error('Resource cleanup adapter is required')
    if (cleanupResources) await cleanupResources()
  } catch (error) {
    resourcesFailed = true
    cleanupErrors.push(error)
  }
  if (state.identitySeedStarted) {
    try {
      if (resourcesFailed) throw new Error('Resources remain; identity cleanup deferred')
      if (!cleanupIdentities) throw new Error('Identity cleanup adapter is required')
      await cleanupIdentities()
      if (state.identityJournal?.status !== 'cleaned')
        throw new Error('Fixture identity cleanup is incomplete')
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (state.hostConfig) {
    try {
      if (!restoreConfig) throw new Error('Host ConfigMap restore adapter is required')
      await restoreConfig()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (state.controlApi) {
    try {
      if (!restoreApi) throw new Error('Control API restore adapter is required')
      await restoreApi()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (proxyError || cleanupErrors.length > 0) {
    throw proxyError ?? cleanupErrors[0]
  }
  state.restored = true
  return state
}

export function validateRunDirectory(canonical, evidence) {
  const root = fs.realpathSync(path.join(canonical, '.local-notes/infra/runs'))
  if (path.relative(fs.realpathSync(canonical), root) !== '.local-notes/infra/runs')
    throw new Error('Unsafe canonical evidence root')
  const resolved = fs.realpathSync(evidence)
  if (path.dirname(resolved) !== root || fs.lstatSync(evidence).isSymbolicLink())
    throw new Error('Evidence must be a dedicated canonical run directory')
  return resolved
}

async function main() {
  process.umask(0o077)
  if (!process.version.startsWith('v24.')) throw new Error('Node24 is required')
  const action = process.argv[2] ?? 'prepare'
  if (!['prepare', 'run', 'restore', 'check-subscriptions'].includes(action))
    throw new Error('Expected prepare, run, restore, or check-subscriptions')
  const provider = validateProvider(required('APPROVED_TOOLS_PROVIDER'))
  const suite = validateSuite(required('APPROVED_TOOLS_SUITE'))
  // MS-SUB: the standalone read-only gate. It takes no mutation lease, writes no
  // fixture state and opens no Control UI session, so the lane's launcher can run
  // it before anything else and stop on a token without leaving a footprint.
  if (action === 'check-subscriptions') {
    validateSuiteMatrix(provider, suite, 'deterministic')
    const checkProfile = required('MINIKUBE_PROFILE')
    if (
      checkProfile !== required('CONTROL_API_REAL_PG_CONTEXT') ||
      !/^clerum-.+-[a-f0-9]{7,8}$/.test(checkProfile)
    )
      throw new Error('Owned branch Minikube context required')
    const checkKubectl = args =>
      command('kubectl', ['--context=' + checkProfile, '--request-timeout=30s', ...args])
    const receipt = await checkSubscriptions({
      provider,
      connectionName: process.env.APPROVED_TOOLS_GROK_CONNECTION_NAME,
      modelName: providerModelName(provider),
      kubectlExec: subscriptionGateTransport({ provider, kubectl: checkKubectl }),
    })
    process.stdout.write(
      `${JSON.stringify({ subscription: 'ready', provider, suite, checked: receipt.checked.length, ...(receipt.connection ? { connectionKey: receipt.connection.connectionKey, status: receipt.connection.status, catalogStatus: receipt.connection.catalogStatus, model: receipt.connection.model } : {}) })}\n`
    )
    return
  }
  const proxy = proxyPreset(provider)
  if (action !== 'restore') {
    const mode = required('APPROVED_TOOLS_UPSTREAM_MODE')
    validateSuiteMatrix(provider, suite, mode)
    if (provider === 'grok')
      requireGrokConnectionName(process.env.APPROVED_TOOLS_GROK_CONNECTION_NAME)
  }
  const profile = required('MINIKUBE_PROFILE')
  if (
    profile !== required('CONTROL_API_REAL_PG_CONTEXT') ||
    !/^clerum-.+-[a-f0-9]{7,8}$/.test(profile)
  )
    throw new Error('Owned branch Minikube context required')
  command('lease', [])
  const evidence = validateRunDirectory(
    required('APPROVED_TOOLS_CANONICAL_ROOT'),
    required('APPROVED_TOOLS_EVIDENCE_DIR')
  )
  const kc = args => ['--context=' + profile, '--request-timeout=30s', ...args]
  const kubectl = (args, options) => command('kubectl', kc(args), options)
  // MS-SUB: the read-only subscription gate is the preparation's first step for
  // every lane, real-hybrid included, so nothing is mutated when the provider's
  // subscription path is unavailable. The standalone `check-subscriptions`
  // action runs the same code without a lease or a run directory.
  const subscriptionTransport = action === 'restore' ? undefined : subscriptionGateTransport({ provider, kubectl })
  if (subscriptionTransport) {
    const subscriptionReceipt = await checkSubscriptions({
      provider,
      connectionName: process.env.APPROVED_TOOLS_GROK_CONNECTION_NAME,
      modelName: providerModelName(provider),
      kubectlExec: subscriptionTransport,
    })
    if (subscriptionReceipt.connection)
      process.stdout.write(
        `${JSON.stringify({ subscription: 'ready', connectionKey: subscriptionReceipt.connection.connectionKey, status: subscriptionReceipt.connection.status, catalogStatus: subscriptionReceipt.connection.catalogStatus, model: subscriptionReceipt.connection.model })}\n`
      )
  }
  const head = command('head', []).trim()
  const profilePidDirectory = fs.realpathSync(
    path.join(required('T2_PROFILE_ROOT'), profile, 'pids')
  )
  const owner = (fn, args) => {
    if (
      ![
        'pf_owner_record_process',
        'pf_owner_record_process_matches',
        'pf_owner_cleanup_record',
      ].includes(fn)
    )
      throw new Error('Invalid owner function')
    return command(
      fn,
      validateOwnerArgs(args, fn === 'pf_owner_record_process', profile, profilePidDirectory)
    )
  }
  const validateForward = binding => {
    owner('pf_owner_record_process_matches', [
      binding.record,
      profile,
      profile,
      repo,
      binding.namespace,
      binding.service,
      String(binding.localPort),
      String(binding.remotePort),
    ])
  }
  let state
  let stateFile
  const save = () => {
    // An interrupted in-place write may be incomplete. Restoration then fails
    // JSON validation; it never guesses the previous image or deletes records.
    // The existing descriptor prevents a replacement path redirecting writes.
    const data = Buffer.from(JSON.stringify(state, null, 2) + '\n')
    if (data.length > stateFile.maxBytes || fs.fstatSync(stateFile.fd).nlink !== 1)
      throw new Error('Invalid state write')
    fs.ftruncateSync(stateFile.fd, 0)
    fs.writeSync(stateFile.fd, data, 0, data.length, 0)
    fs.fsyncSync(stateFile.fd)
  }
  const verifyApiMarker = () => {
    const marker = JSON.parse(
      kubectl([
        '-n',
        'control-plane',
        'exec',
        'deployment/control-api',
        '--',
        'node',
        '-e',
        controlApiMarkerCheck,
      ])
    )
    if (marker.run !== state.run || marker.profile !== profile || marker.pid !== 1)
      throw new Error('Control API live fixture marker mismatch')
    const live = getApi()
    if (
      live.metadata.uid !== state.controlApi.metadata.uid ||
      live.spec.template.metadata?.annotations?.[proxyRunAnnotation] !== state.run ||
      live.spec.template.spec.containers.find(c => c.name === 'control-api')?.image !==
        controlApiFixtureImage
    )
      throw new Error('Control API live fixture deployment mismatch')
  }
  const runIdentityOperation = input => {
    verifyApiMarker()
    const source = readOwnedFile(
      path.join(repo, 'tests/e2e/fixtures/codex-subscription/approved-tools-setup'),
      'seed.mjs',
      128 * 1024
    )
    const result = kubectl(
      [
        '-n',
        'control-plane',
        'exec',
        '-i',
        'deployment/control-api',
        '--',
        'node',
        '--input-type=module',
        '--eval',
        source,
      ],
      { input: JSON.stringify(input), timeout: 90_000, identityResult: true }
    )
    if (result.status !== 0) {
      const failure = parseIdentityFailure(result.stdout)
      // The remote journal already recorded its terminal status before it
      // reported. Keep the host copy aligned when that line is present.
      if (lastIdentityLine(result.stdout, 'e2eIdentity') !== null)
        state.identityJournal = parseIdentityJournal(
          result.stdout,
          state.identityJournal,
          'recovery-required'
        )
      if (input.action === 'cleanup') state.identityCleanupFailure = failure
      save()
      throw new Error(identityFailureMessage(failure))
    }
    state.identityJournal = parseIdentityJournal(
      result.stdout,
      state.identityJournal,
      input.action === 'create' ? 'created' : 'cleaned'
    )
    if (input.action === 'cleanup') delete state.identityCleanupFailure
    save()
  }
  const getOwnedResource = entry => {
    const output = kubectl(fixtureResourceGetArgs(entry, state.run), {
      resourceCleanup: { entry, run: state.run },
    }).trim()
    return output === '' ? null : JSON.parse(output)
  }
  const getHostConfig = () =>
    JSON.parse(kubectl(['-n', 'mcp-host', 'get', 'configmap/mcp-host-config', '-o', 'json']))
  const patchHostConfig = patch =>
    kubectl([
      '-n',
      'mcp-host',
      'patch',
      'configmap/mcp-host-config',
      '--type=merge',
      '-p',
      JSON.stringify(patch),
    ])
  const getApi = () =>
    JSON.parse(kubectl(['-n', 'control-plane', 'get', 'deployment/control-api', '-o', 'json']))
  const patchApi = patch =>
    kubectl([
      '-n',
      'control-plane',
      'patch',
      'deployment/control-api',
      '--type=strategic',
      '-p',
      JSON.stringify(patch),
    ])
  const waitApi = () =>
    kubectl(
      ['-n', 'control-plane', 'rollout', 'status', 'deployment/control-api', '--timeout=180s'],
      { timeout: 190_000 }
    )
  async function restore() {
    try {
      await restoreOwnedFixture({
        state,
        profile,
        worktree: repo,
        head,
        getDeployment: () =>
          JSON.parse(
            kubectl(['-n', 'control-plane', 'get', `deployment/${proxy.name}`, '-o', 'json'])
          ),
        patchProxy: ({ metadata, image, imagePullPolicy, env, annotations }) =>
          kubectl([
            '-n',
            'control-plane',
            'patch',
            `deployment/${proxy.name}`,
            '--type=strategic',
            '-p',
            JSON.stringify({
              metadata,
              spec: {
                template: {
                  metadata: { annotations },
                  spec: {
                    containers: [{ name: proxy.name, image, imagePullPolicy, env }],
                  },
                },
              },
            }),
          ]),
        waitProxyRollout: () =>
          kubectl(
            [
              '-n',
              'control-plane',
              'rollout',
              'status',
              `deployment/${proxy.name}`,
              '--timeout=180s',
            ],
            { timeout: 190_000 }
          ),
        cleanupForward: binding =>
          owner('pf_owner_cleanup_record', [
            binding.record,
            profile,
            profile,
            repo,
            binding.namespace,
            binding.service,
            String(binding.localPort),
            String(binding.remotePort),
          ]),
        restoreHostConfig: () =>
          restoreHostConfig({ state, get: getHostConfig, patch: patchHostConfig }),
        restoreApi: () =>
          restoreControlApi({ state, profile, get: getApi, patch: patchApi, wait: waitApi }),
        cleanupIdentities: async () => {
          ingestFixtureConnections(
            state,
            name => {
              let file
              try {
                file = openOwnedFile(evidence, name, { maxBytes: 4096 })
              } catch (error) {
                if (error.code === 'ENOENT') return null
                throw error
              }
              try {
                if ((fs.fstatSync(file.fd).mode & 0o777) !== 0o600)
                  throw new Error('Connection capture must have mode 0600')
                return readOwnedDescriptor(file)
              } finally {
                fs.closeSync(file.fd)
              }
            },
            save
          )
          const pending = await recoverControlApiForCleanup({
            state,
            profile,
            get: getApi,
            patch: patchApi,
            wait: waitApi,
            verify: verifyApiMarker,
          })
          if (!pending) return
          runIdentityOperation(
            identityCleanupRequest({
              suite,
              run: state.run,
              profile,
              provider,
              // The lane's own Control Admin records the governed retirement.
              adminUsername: required('TEST_ADMIN_USERNAME'),
              scenarios: state.scenarios,
              workflowScenario: state.workflowScenario,
              initialJournal: state.identityJournal,
            })
          )
        },
        cleanupResources: () =>
          cleanupJournaledFixtureResources({
            journal: state.resources,
            run: state.run,
            save,
            get: getOwnedResource,
            waitForDeletion: async entry => {
              const deadline = Date.now() + 30_000
              do {
                const live = getOwnedResource(entry)
                if (live === null) return null
                // Stop immediately on replacement or lost labels; otherwise
                // poll foreground deletion within a finite cleanup deadline.
                fixtureDeleteRequest(entry, live, state.run)
                await new Promise(resolve => setTimeout(resolve, 200))
              } while (Date.now() < deadline)
              throw new Error('Fixture foreground deletion deadline exceeded')
            },
            remove: (request, entry, live) =>
              kubectl(['delete', '--raw', request.path, '-f', '-'], {
                input: JSON.stringify(request.body),
                resourceCleanup: { entry, live, run: state.run },
              }),
          }),
      })
      save()
    } catch (error) {
      try {
        if (state && state.profile === profile && state.worktree === repo) save()
      } catch {
        // Persisting the HEAD audit must not mask the original restore failure.
      }
      throw error
    }
  }
  let restorePromise
  let interruptedSignal
  let activeRunner
  const pendingForwardChildren = new Set()
  const restoreOnce = () => (restorePromise ??= restore())
  // A restore failure hides its own reason behind the fixed operator line. The
  // coded identity failure is the one exception: it is a closed token, so it is
  // printed next to the line instead of being dropped.
  const reportRestoreFailure = (label, error) => {
    if (isIdentityFailureMessage(error?.message)) process.stderr.write(`${error.message}\n`)
    process.stderr.write(label)
  }
  const assertActive = () => {
    if (interruptedSignal) throw new Error(`Preparation interrupted by ${interruptedSignal}`)
  }
  const installSignalRestore = () => {
    const onSignal = signal => {
      if (interruptedSignal) return
      interruptedSignal = signal
      process.stderr.write(
        `Approved tools preparation interrupted by ${signal}; restoring the owned fixture\n`
      )
      for (const child of pendingForwardChildren) child.kill('SIGTERM')
      const runner = activeRunner
      if (runner) runner.kill(signal)
      const runnerClosed =
        runner && runner.exitCode === null && runner.signalCode === null
          ? new Promise(resolve => runner.once('close', resolve))
          : Promise.resolve()
      void runnerClosed.then(restoreOnce).then(
        () => process.exit(signal === 'SIGINT' ? 130 : 143),
        error => {
          reportRestoreFailure(
            'Approved tools signal restore failed; recovery required. Durable fixture state remains for the explicit restore target\n',
            error
          )
          process.exit(1)
        }
      )
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    return () => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    }
  }
  if (action === 'restore') {
    stateFile = openOwnedFile(evidence, 'fixture-state.json', { writable: true })
    try {
      state = JSON.parse(readOwnedDescriptor(stateFile))
      if ((state.provider ?? 'codex') !== provider)
        throw new Error('Fixture provider ownership mismatch')
      // A legacy state is upgraded in place once its recorded shape proves the
      // suite; a later restore then uses the strict rule.
      state.suite = validateSuiteOwnership(state, suite)
      await restore()
    } finally {
      fs.closeSync(stateFile.fd)
    }
    return
  }
  if (required('APPROVED_TOOLS_UPSTREAM_MODE') === 'real-hybrid') {
    if (action !== 'run' || process.env.CODEX_REAL_UPSTREAM_CONFIRM !== '1')
      throw new Error('Real hybrid requires run mode and explicit subscription confirmation')
    for (const name of ['TEST_USER_EMAIL', 'TEST_USER_PASSWORD', 'APPROVED_TOOLS_SCENARIOS'])
      required(name)
    const scenarios = JSON.parse(required('APPROVED_TOOLS_SCENARIOS'))
    if (
      !Array.isArray(scenarios) ||
      scenarios.length !== 3 ||
      [83, 150, 250].some(size => scenarios.filter(row => row?.catalogSize === size).length !== 1)
    )
      throw new Error('Real hybrid requires three prepared approved-tools scenarios')
    for (const row of scenarios) {
      for (const key of ['runId', 'agentName', 'agentDisplayName', 'modelName', 'fixtureUrl']) {
        if (typeof row[key] !== 'string' || !row[key].trim())
          throw new Error(`Real hybrid scenario missing ${key}`)
      }
      const fixture = new URL(row.fixtureUrl)
      if (
        !['http:', 'https:'].includes(fixture.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(fixture.hostname) ||
        !fixture.port ||
        fixture.username ||
        fixture.password ||
        fixture.pathname !== '/' ||
        fixture.search ||
        fixture.hash
      )
        throw new Error('Real hybrid fixture evidence must use an owned loopback origin')
    }
    const imageManifest = JSON.parse(
      readOwnedFile(path.join(repo, 'deploy/minikube'), '.image-manifest.json', 4 * 1024 * 1024)
    )
    const inventory = JSON.parse(command('image-inventory', [], { timeout: 30_000 }))
    if (!Array.isArray(inventory))
      throw new Error('IMAGE_PROOF_MANIFEST_INVALID: invalid inventory')
    const observedImages = inventory.flatMap(item => {
      if (item.repoTags == null) return []
      if (!Array.isArray(item.repoTags) || typeof item.id !== 'string')
        throw new Error('IMAGE_PROOF_MANIFEST_INVALID: invalid inventory item')
      const id = item.id.startsWith('sha256:') ? item.id : `sha256:${item.id}`
      return item.repoTags.map(ref => ({ ref, id }))
    })
    const imageProof = buildApprovedToolsImageProof({
      profile,
      provider,
      sourceHead: head,
      manifest: imageManifest,
      images: observedImages,
    })
    const deployment = JSON.parse(
      kubectl(['-n', 'control-plane', 'get', `deployment/${proxy.name}`, '-o', 'json'])
    )
    const container = deployment.spec.template.spec.containers.find(c => c.name === proxy.name)
    if (
      !container ||
      container.image === proxy.image ||
      deployment.spec.template.metadata?.annotations?.[proxyRunAnnotation] !== undefined ||
      (container.env ?? []).some(e =>
        (provider === 'codex' ? hybridProxyFlags : proxy.flags)
          .filter(name => name !== 'NODE_ENV')
          .includes(e.name)
      )
    )
      throw new Error('Proxy already has test ownership')
    validateProxyImage(container.image, container.imagePullPolicy, provider)
    const originalNodeEnv = container.env?.find(e => e.name === 'NODE_ENV')
    if (originalNodeEnv && !['production', 'development', 'test'].includes(originalNodeEnv.value))
      throw new Error('Unsupported explicit NODE_ENV binding')
    const run = 'approved-tools-' + randomBytes(6).toString('hex')
    const port = await freePort()
    const upstreamEvidenceUrl = `http://127.0.0.1:${port}`
    const hybridScenarios = scenarios.map(row => ({ ...row, upstreamEvidenceUrl }))
    state = {
      mode: 'real-hybrid',
      suite,
      provider,
      profile,
      worktree: repo,
      head,
      run,
      imageProof,
      forwards: [],
      resources: [],
      identitySeedStarted: false,
      originalProxyImage: container.image,
      originalImagePullPolicy: container.imagePullPolicy,
      originalNodeEnv,
      proxyUid: deployment.metadata.uid,
      hostConfig: captureHostConfig(getHostConfig()),
      restored: false,
    }
    stateFile = openOwnedFile(evidence, 'fixture-state.json', { create: true })
    save()
    const removeSignals = installSignalRestore()
    try {
      await applyHostConfig({ state, get: getHostConfig, patch: patchHostConfig })
      save()
      kubectl([
        '-n',
        'control-plane',
        'patch',
        `deployment/${proxy.name}`,
        '--type=strategic',
        '-p',
        JSON.stringify({
          metadata: {
            uid: deployment.metadata.uid,
            resourceVersion: deployment.metadata.resourceVersion,
          },
          spec: {
            template: {
              metadata: { annotations: { [proxyRunAnnotation]: run } },
              spec: {
                containers: [
                  {
                    name: proxy.name,
                    image: proxy.image,
                    imagePullPolicy: 'Never',
                    env: [
                      { name: 'NODE_ENV', value: 'test' },
                      { name: proxy.flags[0], value: '1' },
                      { name: proxy.flags[1], value: profile },
                      { name: 'APPROVED_TOOLS_UPSTREAM_MODE', value: 'real-hybrid' },
                      { name: 'CODEX_REAL_UPSTREAM_CONFIRM', value: '1' },
                    ],
                  },
                ],
              },
            },
          },
        }),
      ])
      kubectl(
        ['-n', 'control-plane', 'rollout', 'status', `deployment/${proxy.name}`, '--timeout=180s'],
        { timeout: 190_000 }
      )
      const record = path.join(profilePidDirectory, `${run}-codex-llm-proxy.pid`)
      validateOwnerArgs(
        [record, profile, profile, repo, 'control-plane', proxy.name, String(port), '9090'],
        false,
        profile,
        profilePidDirectory
      )
      const log = fs.openSync(path.join(evidence, 'pf-codex-llm-proxy.log'), 'wx', 0o600)
      const child = spawn(
        'kubectl',
        [
          `--context=${profile}`,
          '-n',
          'control-plane',
          'port-forward',
          '--address=127.0.0.1',
          'svc/codex-llm-proxy',
          `${port}:9090`,
        ],
        { cwd: repo, detached: true, stdio: ['ignore', log, log] }
      )
      pendingForwardChildren.add(child)
      try {
        await new Promise((resolve, reject) => {
          child.once('spawn', resolve)
          child.once('error', reject)
        })
      } finally {
        fs.closeSync(log)
      }
      assertActive()
      child.unref()
      try {
        owner('pf_owner_record_process', [
          record,
          String(child.pid),
          profile,
          profile,
          repo,
          'control-plane',
          proxy.name,
          String(port),
          '9090',
        ])
      } catch (error) {
        child.kill('SIGTERM')
        throw error
      }
      state.forwards.push({
        record,
        namespace: 'control-plane',
        service: proxy.name,
        localPort: port,
        remotePort: 9090,
      })
      save()
      pendingForwardChildren.delete(child)
      await waitHttp(
        `${upstreamEvidenceUrl}/approved-tools/evidence`,
        value => value.injected503 === 0 && Number.isSafeInteger(value.forwarded)
      )
      assertActive()
      owner('pf_owner_record_process_matches', [
        record,
        profile,
        profile,
        repo,
        'control-plane',
        proxy.name,
        String(port),
        '9090',
      ])
      process.env.APPROVED_TOOLS_SCENARIOS = JSON.stringify(hybridScenarios)
      // Real-hybrid prepares no workflow row; a stale handoff key would point the
      // runner's evidence read at another run.
      delete process.env.APPROVED_TOOLS_WORKFLOW_SCENARIO
      try {
        await command('runner', [], {
          timeout: APPROVED_TOOLS_RUNNER_OUTER_SPAWN_TIMEOUT_MS,
          inherit: true,
          onRunnerStart: child => {
            activeRunner = child
          },
        })
      } finally {
        activeRunner = undefined
      }
      assertActive()
      await restoreOnce()
      process.stdout.write(
        `${JSON.stringify({ fixture: 'real-hybrid', restored: state.restored })}\n`
      )
    } catch (error) {
      try {
        await restoreOnce()
      } catch (restoreError) {
        reportRestoreFailure(
          'Hybrid proxy restore failed; use the explicit restore target before another gate\n',
          restoreError
        )
      }
      throw error
    } finally {
      removeSignals()
      fs.closeSync(stateFile.fd)
    }
    return
  }
  if (required('APPROVED_TOOLS_UPSTREAM_MODE') !== 'deterministic')
    throw new Error(
      'Synthetic preparation is deterministic-only; real accounts require separate authorized preconditions'
    )
  // Both sources are mandatory before any fixture mutation. A seed alone
  // cannot provide the external consent flow exercised by the browser.
  readOwnedFile(
    path.join(repo, 'tests/e2e/fixtures/codex-subscription/approved-tools-oauth'),
    'provider.mjs',
    128 * 1024
  )
  const seedFile = path.join(
    repo,
    'tests/e2e/fixtures/codex-subscription/approved-tools-setup/seed.mjs'
  )
  readOwnedFile(path.dirname(seedFile), path.basename(seedFile), 128 * 1024)
  for (const name of [
    'TEST_ADMIN_USERNAME',
    'TEST_ADMIN_PASSWORD',
    'TEST_USER_PASSWORD',
    'APPROVED_TOOLS_UNAUTHORIZED_PASSWORD',
  ])
    required(name)
  // The supported Minikube overlays enable these already. Refuse a stale or
  // differently configured runtime; fixture setup must not weaken feature gates.
  // The subscription gate for this lane already ran as preparation's first step.
  const hostFlags = subscriptionTransport('read-host-config')
  // The workflow coordinator policy admits the fixture image only for the suite
  // that prepares a WorkflowRecipe (#1048 MS-NW).
  if (
    suite === 'native-workflow' &&
    kubectl([
      '-n',
      'control-plane',
      'exec',
      'deployment/workflow-recipes',
      '--',
      'node',
      '-e',
      workflowFeatureCheck,
    ]).trim() !== 'true'
  )
    throw new Error(
      'Workflow fixture image is not permitted by the running Minikube coordinator policy'
    )
  const imageManifest = JSON.parse(
    readOwnedFile(path.join(repo, 'deploy/minikube'), '.image-manifest.json', 4 * 1024 * 1024)
  )
  const inventory = JSON.parse(command('image-inventory', [], { timeout: 30_000 }))
  if (!Array.isArray(inventory)) throw new Error('IMAGE_PROOF_MANIFEST_INVALID: invalid inventory')
  const observedImages = inventory.flatMap(item => {
    if (item.repoTags == null) return []
    if (!Array.isArray(item.repoTags) || typeof item.id !== 'string')
      throw new Error('IMAGE_PROOF_MANIFEST_INVALID: invalid inventory item')
    const id = item.id.startsWith('sha256:') ? item.id : `sha256:${item.id}`
    return item.repoTags.map(ref => ({ ref, id }))
  })
  const imageProof = buildApprovedToolsImageProof({
    profile,
    provider,
    suite,
    sourceHead: head,
    manifest: imageManifest,
    images: observedImages,
  })
  const run = 'approved-tools-' + randomBytes(6).toString('hex')
  // The same fresh identity names feed both setup and the visible login runner.
  process.env.TEST_USER_EMAIL = `${run}@example.test`
  process.env.APPROVED_TOOLS_UNAUTHORIZED_EMAIL = `${run}-unauthorized@example.test`
  // The suite decides the prepared set (#1048 MS-NW): the base journeys own the
  // three receipt catalogs and the probe, native-workflow squares the one workflow
  // agent, and model-step-retry the single 83-tool catalog.
  const ports = []
  const portCount = suitePortCount(suite)
  while (ports.length < portCount) {
    const port = await freePort()
    if (!ports.includes(port)) ports.push(port)
  }
  const probePort = ports.at(-1)
  const { scenarios, workflowScenario, allScenarios, resources } = makeSuiteFixtures({
    run,
    suite,
    provider,
    connectionName: process.env.APPROVED_TOOLS_GROK_CONNECTION_NAME,
    ports: ports.slice(0, -1),
    probePort,
  })
  const proposed = { apiVersion: 'v1', kind: 'List', items: resources }
  const validated = parseDryRunItems(
    kubectl(['create', '--dry-run=server', '-f', '-', '-o', 'json'], {
      input: JSON.stringify(proposed),
    })
  )
  assertResourceRoundTrip(resources, validated)
  const proxyService = JSON.parse(
    kubectl(['-n', 'control-plane', 'get', `service/${proxy.name}`, '-o', 'json'])
  )
  if (!proxyService.spec.ports.some(p => p.port === 9090))
    throw new Error('Proxy probe Service port is missing')
  const deployment = JSON.parse(
    kubectl(['-n', 'control-plane', 'get', `deployment/${proxy.name}`, '-o', 'json'])
  )
  const container = deployment.spec.template.spec.containers.find(c => c.name === proxy.name)
  if (
    !container ||
    container.image === proxy.image ||
    deployment.spec.template.metadata?.annotations?.[proxyRunAnnotation] !== undefined ||
    (container.env ?? []).some(e =>
      (provider === 'codex' ? hybridProxyFlags : proxy.flags)
        .filter(name => name !== 'NODE_ENV')
        .includes(e.name)
    )
  )
    throw new Error('Proxy already has test ownership')
  const originalNodeEnv = container.env?.find(e => e.name === 'NODE_ENV')
  if (originalNodeEnv && !['production', 'development', 'test'].includes(originalNodeEnv.value))
    throw new Error('Unsupported explicit NODE_ENV binding')
  // Refuse an unsupported original image before any fixture resource is created.
  validateProxyImage(container.image, container.imagePullPolicy, provider)
  const controlApi = captureControlApi(getApi(), profile)
  const identityBinding = {
    mode: 'deterministic',
    suite,
    provider,
    run,
    profile,
    context: profile,
    scenarios: allScenarios,
  }
  const identityJournal = createFixtureIdentityJournal(identityBinding, {
    env: {
      NODE_ENV: 'test',
      EVENFIRE_APPROVED_TOOLS_OAUTH_FIXTURE: '1',
      APPROVED_TOOLS_RUN_ID: run,
      MINIKUBE_PROFILE: profile,
      CONTROL_API_REAL_PG_CONTEXT: profile,
    },
  })
  state = {
    provider,
    suite,
    profile,
    worktree: repo,
    head,
    imageProof,
    run,
    scenarios,
    workflowScenario,
    forwards: [],
    resources: [],
    identityJournal,
    identitySeedStarted: false,
    controlApi,
    hostConfig: captureHostConfig(hostFlags),
    originalProxyImage: container.image,
    originalImagePullPolicy: container.imagePullPolicy,
    originalNodeEnv,
    proxyUid: deployment.metadata.uid,
    restored: false,
  }
  stateFile = openOwnedFile(evidence, 'fixture-state.json', { create: true })
  save()
  const removeSignals = installSignalRestore()
  async function startForward(namespace, service, localPort, remotePort, health, accept) {
    const record = path.join(profilePidDirectory, `${run}-${service}.pid`)
    validateOwnerArgs(
      [record, profile, profile, repo, namespace, service, String(localPort), String(remotePort)],
      false,
      profile,
      profilePidDirectory
    )
    const log = fs.openSync(path.join(evidence, `pf-${service}.log`), 'wx', 0o600)
    const child = spawn(
      'kubectl',
      [
        `--context=${validateProfile(profile)}`,
        '-n',
        namespace,
        'port-forward',
        '--address=127.0.0.1',
        `svc/${service}`,
        `${localPort}:${remotePort}`,
      ],
      { cwd: repo, detached: true, stdio: ['ignore', log, log] }
    )
    pendingForwardChildren.add(child)
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve)
        child.once('error', reject)
      })
    } finally {
      fs.closeSync(log)
    }
    assertActive()
    child.unref()
    const binding = { record, namespace, service, localPort, remotePort }
    try {
      owner('pf_owner_record_process', [
        record,
        String(child.pid),
        profile,
        profile,
        repo,
        namespace,
        service,
        String(localPort),
        String(remotePort),
      ])
    } catch (error) {
      child.kill('SIGTERM')
      throw error
    }
    state.forwards.push(binding)
    save()
    pendingForwardChildren.delete(child)
    await waitHttp(health, accept)
    assertActive()
    validateForward(binding)
  }
  try {
    await applyHostConfig({ state, get: getHostConfig, patch: patchHostConfig })
    save()
    patchApi(
      controlApiPatch({
        metadata: controlApi.metadata,
        image: controlApiFixtureImage,
        imagePullPolicy: 'Never',
        env: controlApiFixtureEnv(run, profile),
        run,
      })
    )
    waitApi()
    verifyApiMarker()
    await createJournaledFixtureResources({
      resources,
      run,
      journal: state.resources,
      save,
      create: resource =>
        JSON.parse(
          kubectl(['create', '-f', '-', '-o', 'json'], {
            input: JSON.stringify(resource),
          })
        ),
      validateCreated: assertResourceRoundTrip,
    })
    assertActive()
    kubectl([
      '-n',
      'control-plane',
      'patch',
      `deployment/${proxy.name}`,
      '--type=strategic',
      '-p',
      JSON.stringify({
        metadata: {
          uid: deployment.metadata.uid,
          resourceVersion: deployment.metadata.resourceVersion,
        },
        spec: {
          template: {
            metadata: { annotations: { [proxyRunAnnotation]: state.run } },
            spec: {
              containers: [
                {
                  name: proxy.name,
                  image: proxy.image,
                  imagePullPolicy: 'Never',
                  env: [
                    { name: 'NODE_ENV', value: 'test' },
                    { name: proxy.flags[0], value: '1' },
                    { name: proxy.flags[1], value: profile },
                  ],
                },
              ],
            },
          },
        },
      }),
    ])
    kubectl(
      ['-n', 'control-plane', 'rollout', 'status', `deployment/${proxy.name}`, '--timeout=180s'],
      { timeout: 190_000 }
    )
    if (provider === 'grok') {
      state.proxyPods = observeGrokProxyPods(
        JSON.parse(
          kubectl(['-n', 'control-plane', 'get', 'pods', '-l', 'app=grok-llm-proxy', '-o', 'json'])
        ),
        state
      )
      save()
    }
    await startForward(
      'control-plane',
      proxy.name,
      probePort,
      9090,
      `${scenarios[0].upstreamEvidenceUrl}/approved-tools/evidence`,
      value => Array.isArray(value.requests)
    )
    for (const [index, scenario] of allScenarios.entries()) {
      kubectl(
        [
          '-n',
          'mcp-server',
          'wait',
          '--for=create',
          `deployment/${scenario.connectorName}`,
          '--timeout=180s',
        ],
        { timeout: 190_000 }
      )
      kubectl(
        [
          '-n',
          'mcp-server',
          'rollout',
          'status',
          `deployment/${scenario.connectorName}`,
          '--timeout=180s',
        ],
        { timeout: 190_000 }
      )
      await startForward(
        'mcp-server',
        scenario.connectorName,
        ports[index],
        8080,
        `${scenario.fixtureUrl}/health`,
        value =>
          value.ready === true &&
          value.catalogSize === scenario.catalogSize &&
          value.runId === scenario.runId
      )
      assertActive()
    }
    const seedInput = {
      action: 'create',
      ...identityBinding,
      initialJournal: state.identityJournal,
      mode: 'deterministic',
      profile,
      scenarios: allScenarios,
      workflowScenario,
      userDisplayName: run,
      adminUsername: required('TEST_ADMIN_USERNAME'),
      adminPassword: required('TEST_ADMIN_PASSWORD'),
      userEmail: required('TEST_USER_EMAIL'),
      userPassword: required('TEST_USER_PASSWORD'),
      unauthorizedEmail: required('APPROVED_TOOLS_UNAUTHORIZED_EMAIL'),
      unauthorizedPassword: required('APPROVED_TOOLS_UNAUTHORIZED_PASSWORD'),
    }
    state.identitySeedStarted = true
    save()
    runIdentityOperation(seedInput)
    fs.writeFileSync(
      path.join(evidence, 'scenarios.json'),
      JSON.stringify(scenarios, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 }
    )
    if (workflowScenario)
      fs.writeFileSync(
        path.join(evidence, 'workflow-scenario.json'),
        JSON.stringify(workflowScenario, null, 2) + '\n',
        { flag: 'wx', mode: 0o600 }
      )
    state.ready = true
    save()
    if (action === 'run') {
      process.env.APPROVED_TOOLS_FIXTURE_USER_ID = state.identityJournal.users[0].id
      process.env.APPROVED_TOOLS_SCENARIOS = JSON.stringify(scenarios)
      // A suite that prepares no workflow row must not inherit one from the
      // caller's environment: the runner reads this key to find the fixture
      // evidence origin, and a stale row would describe another run.
      if (workflowScenario) {
        process.env.APPROVED_TOOLS_WORKFLOW_SCENARIO = JSON.stringify(workflowScenario)
      } else {
        delete process.env.APPROVED_TOOLS_WORKFLOW_SCENARIO
      }
      try {
        await command('runner', [], {
          timeout: APPROVED_TOOLS_RUNNER_OUTER_SPAWN_TIMEOUT_MS,
          inherit: true,
          onRunnerStart: child => {
            activeRunner = child
          },
        })
      } finally {
        activeRunner = undefined
      }
      assertActive()
      await restoreOnce()
    }
    process.stdout.write(
      `${JSON.stringify({
        fixture: 'ready',
        mode: 'deterministic',
        suite,
        scenariosFile: path.join(evidence, 'scenarios.json'),
        ...(workflowScenario
          ? { workflowScenarioFile: path.join(evidence, 'workflow-scenario.json') }
          : {}),
        restored: state.restored,
      })}\n`
    )
  } catch (error) {
    try {
      await restoreOnce()
    } catch (restoreError) {
      reportRestoreFailure(
        'Fixture restore failed; use the explicit restore target before another gate\n',
        restoreError
      )
    }
    throw error
  } finally {
    removeSignals()
    fs.closeSync(stateFile.fd)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    // A closed set of messages may be printed: the subscription gate tokens
    // (`CODEX_SUBSCRIPTION_GATE_DISABLED`, `GROK_SUBSCRIPTION_GATE_DISABLED`, the
    // `GROK_CONNECTION_*` refusals, which name a flag or a connection key and
    // never a credential) and the coded identity failure. Everything else keeps
    // the fixed operator line, so no runtime or database text reaches the console.
    if (
      error.message.startsWith('GROK_CONNECTION_') ||
      error.message.startsWith('GROK_SUBSCRIPTION_GATE_DISABLED:') ||
      error.message.startsWith('CODEX_SUBSCRIPTION_GATE_DISABLED:')
    )
      process.stderr.write(error.message + '\n')
    else if (isIdentityFailureMessage(error.message)) process.stderr.write(error.message + '\n')
    process.stderr.write(
      'Approved tools preparation failed; review bounded sanitized fixture evidence\n'
    )
    process.exitCode = 1
  })
}
