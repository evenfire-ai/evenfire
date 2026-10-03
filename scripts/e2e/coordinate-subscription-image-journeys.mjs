#!/usr/bin/env node
// E2E_GUARDIAN_IPC_FLOW: leased QA preparation and external vendor observation.
// Desktop login, selection, attachment, approval and Send remain visible.
// Operator material is retained in RAM and crosses child stdin only.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { prepare, run as command } from './prepare-subscription-image-admission.mjs'
import { run as seed, parseOptions, Channel, buildAuthorizeMemoryCompanionBundle,
  openAuthorizeAdmissionPressure } from '../tests/measure-control-api-authorize-memory.mjs'
import { prepareRemainingFixtures } from './prepare-subscription-remaining-fixtures.prepare.mjs'
import { pressureCommandDeadlineMs } from './fixtures/subscription-image-admission-pressure.mjs'
import { admitVendorFrame, digest, RUNNER_RUN_BASE, resolveSuite } from '../tests/lib/subscription-image-runner-contract.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)
const projection = require('../../packages/codex-catalog-projection/index.cjs')
const imageCapability = require('../../packages/llm-providers/imageInput.cjs')
const NAMESPACE = 'control-plane'
const IMPORT_PATH = '/app/scripts/e2e/fixtures/subscription-image-provider.mjs'
const PROXY_DOCKERFILE = 'scripts/e2e/fixtures/subscription-image-proxy.Dockerfile'
const PROVIDERS = ['grok-subscription', 'codex-subscription']
export const CATALOG_CRON_KEYS = ['LLM_CATALOG_SYNC_CRON_ENABLED', 'SUBSCRIPTION_CATALOG_SYNC_CRON_ENABLED']
const fail = code => { throw new Error(code) }
const assert = (value, code) => { if (!value) fail(code) }
const validImageId = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '')
const imageId = value => /sha256:[a-f0-9]{64}$/.exec(value ?? '')?.[0]
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const json = (context, args, input) => JSON.parse(command('kubectl', ['--context', context,
  '--request-timeout=15s', ...args], { input, timeout: 30_000 }))
const getDeployment = (context, name) => json(context, ['-n', NAMESPACE, 'get', 'deployment', name, '-o', 'json'])
const patchDeployment = (context, name, patch) => command('kubectl', ['--context', context,
  '--request-timeout=15s', '-n', NAMESPACE, 'patch', 'deployment', name, '--type=json',
  '--patch-file=/dev/stdin'], { input: JSON.stringify(patch), timeout: 30_000 })

async function until(check, accept, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (accept(value)) return value
    if (Date.now() >= deadline) fail(code)
    await pause(100)
  }
}

/** Snapshot only the controlled fields; retain no unrelated environment values. */
export function snapshotDeployment(deployment, containerName, names) {
  const containers = deployment?.spec?.template?.spec?.containers
  assert(deployment?.spec?.replicas === 1 && !deployment.spec.template.spec.hostNetwork &&
    typeof deployment.metadata?.uid === 'string' && Array.isArray(containers), 'COORDINATOR_DEPLOYMENT_INVALID')
  const matches = containers.filter(value => value.name === containerName)
  assert(matches.length === 1, 'COORDINATOR_CONTAINER_AMBIGUOUS')
  const container = matches[0], env = {}
  for (const name of names) {
    const values = (container.env ?? []).filter(value => value.name === name)
    assert(values.length <= 1 && values.every(value => !value.valueFrom && typeof value.value === 'string'),
      'COORDINATOR_CONTROLLED_ENV_INVALID')
    if (values.length) env[name] = values[0].value
  }
  if (env.NODE_OPTIONS !== undefined) assert(/^--max-old-space-size=\d+$/.test(env.NODE_OPTIONS),
    'COORDINATOR_ORIGINAL_NODE_OPTIONS_UNSUPPORTED')
  assert(names.filter(name => !['NODE_OPTIONS', 'NODE_ENV', ...CATALOG_CRON_KEYS].includes(name)).every(name => !(name in env)),
    'COORDINATOR_UNRESTORED_FIXTURE')
  assert(CATALOG_CRON_KEYS.every(name => env[name] === undefined || ['true', 'false'].includes(env[name])),
    'COORDINATOR_CATALOG_CRON_VALUE_UNSUPPORTED')
  return { uid: deployment.metadata.uid, containerName, image: container.image, env, names: [...names] }
}

/** UID/RV/image/field CAS in both directions, preserving unrelated fields. */
export function deploymentMutationPatch(current, original, applied, restore = false) {
  assert(current?.metadata?.uid === original.uid && typeof current.metadata.resourceVersion === 'string',
    'COORDINATOR_DEPLOYMENT_OWNER_CHANGED')
  const containers = current.spec.template.spec.containers
  const index = containers.findIndex(value => value.name === original.containerName)
  assert(index >= 0, 'COORDINATOR_CONTAINER_CHANGED')
  const container = containers[index], base = `/spec/template/spec/containers/${index}`
  const expected = restore ? applied : original, desired = restore ? original : applied
  assert(container.image === expected.image, 'COORDINATOR_IMAGE_RESTORE_CONFLICT')
  for (const name of original.names) {
    const values = (container.env ?? []).filter(value => value.name === name)
    assert(values.length <= 1 && isDeepStrictEqual(values[0], expected.env[name] === undefined ? undefined :
      { name, value: expected.env[name] }), 'COORDINATOR_ENV_RESTORE_CONFLICT')
  }
  const patch = [{ op: 'test', path: '/metadata/uid', value: original.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
    { op: 'test', path: `${base}/name`, value: original.containerName },
    { op: 'test', path: `${base}/image`, value: expected.image },
    { op: 'replace', path: `${base}/image`, value: desired.image }]
  if (!container.env) patch.push({ op: 'add', path: `${base}/env`, value: [] })
  const removals = []
  for (const name of original.names) {
    const ei = (container.env ?? []).findIndex(value => value.name === name)
    if (ei >= 0) patch.push({ op: 'test', path: `${base}/env/${ei}`, value: container.env[ei] })
    if (desired.env[name] === undefined) {
      if (ei >= 0) removals.push({ op: 'remove', path: `${base}/env/${ei}` })
    } else patch.push({ op: ei >= 0 ? 'replace' : 'add', path: ei >= 0 ? `${base}/env/${ei}` : `${base}/env/-`,
      value: { name, value: desired.env[name] } })
  }
  removals.sort((a, b) => Number(b.path.split('/').at(-1)) - Number(a.path.split('/').at(-1)))
  return [...patch, ...removals]
}

function readyPod(context, name, deploymentUid) {
  const replicas = json(context, ['-n', NAMESPACE, 'get', 'replicaset', '-o', 'json']).items
    .filter(row => row.metadata.ownerReferences?.some(owner => owner.uid === deploymentUid && owner.controller === true))
  const ids = new Set(replicas.map(row => row.metadata.uid))
  const pods = json(context, ['-n', NAMESPACE, 'get', 'pods', '-o', 'json']).items.filter(row =>
    !row.metadata.deletionTimestamp && row.status.phase === 'Running' &&
    row.metadata.ownerReferences?.some(owner => ids.has(owner.uid) && owner.controller === true) &&
    row.status.containerStatuses?.some(container => container.name === name && container.ready))
  return pods.length === 1 ? pods[0] : undefined
}

export async function openControlApiCatalogIsolation(options) {
  assert(options.profile === options.context && options.profile !== 'clerum-test' &&
    !/(^|-)(prod|production)(-|$)/i.test(options.profile), 'COORDINATOR_CATALOG_CONTEXT_INVALID')
  command('bash', [path.join(ROOT, 'scripts/minikube/require-t2-mutation-lock.sh')], { timeout: 10_000 })
  const resource = getDeployment(options.context, 'control-api')
  const original = snapshotDeployment(resource, 'control-api', CATALOG_CRON_KEYS)
  const pod = await until(() => readyPod(options.context, 'control-api', original.uid), Boolean, 120_000,
    'COORDINATOR_CATALOG_API_NOT_READY')
  const baseImageId = imageId(pod.status.containerStatuses.find(value => value.name === 'control-api').imageID)
  assert(validImageId(baseImageId), 'COORDINATOR_CATALOG_API_IMAGE_UNKNOWN')
  const applied = { image: original.image, env: Object.fromEntries(CATALOG_CRON_KEYS.map(name => [name, 'false'])) }
  const state = { name: 'control-api', original, applied, baseImageId, changed: true }
  try {
    patchDeployment(options.context, state.name, deploymentMutationPatch(resource, original, applied))
    command('kubectl', ['--context', options.context, '-n', NAMESPACE, 'rollout', 'status', 'deployment/control-api', '--timeout=120s'],
      { timeout: 150_000 })
    const ready = await until(() => readyPod(options.context, 'control-api', original.uid), Boolean, 120_000,
      'COORDINATOR_CATALOG_API_NOT_READY')
    const flags = json(options.context, ['-n', NAMESPACE, 'exec', ready.metadata.name, '-c', 'control-api', '--',
      'env', '-u', 'NODE_OPTIONS', 'node', '-e',
      "const c=require('./dist/config.js').config;process.stdout.write(JSON.stringify({llm:c.llmCatalogSyncCronEnabled,subscription:c.subscriptionCatalogSyncCronEnabled}))"])
    assert(flags.llm === false && flags.subscription === false, 'COORDINATOR_CATALOG_CRONS_STILL_ENABLED')
    return state
  } catch (error) {
    // No QA mutation has started while opening this fence, so restore its exact
    // original fields even when rollout/observation fails.
    await restoreDeployments(options.context, [state])
    throw error
  }
}

function releaseOptionsForQa(options, receiptFile) {
  const fields = { ...options.publicArguments, 'fixtures-receipt': receiptFile,
    report: path.join(path.dirname(options.report), `${options.runId}-qa-finalization.json`), prepare: 'restart' }
  for (const key of ['prepare-fixtures', 'budget-ids', 'gfs-parent-rid', 'operator-user']) delete fields[key]
  return parseOptions(Object.entries(fields).flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, String(value)]))
}

/** Physical callers keep this one real CAS fence across all cgroup windows and
 * image suites. Its methods use the existing private driver/runner; no raw
 * credential enters options, receipts or the recovery record.
 */
export async function withControlApiFixtureRuntime(options, privateMaterial, work) {
  const fence = await openControlApiCatalogIsolation(options)
  const images = []
  let memoryState = options.fixtureBinding ? 'created' : 'not-created'
  let receiptFile = options.publicArguments?.['fixtures-receipt'], referenceOptions = options
  let result, failure
  const check = value => assert(value.profile === options.profile && value.context === options.context && value.runId === options.runId && value.prepare === 'restart',
    'COORDINATOR_CATALOG_SCOPE_CHANGED')
  const runtime = { initialSnapshot: fence.original,
    async run(value) {
      check(value); referenceOptions = value
      if (value.prepareFixtures) memoryState = 'created-or-unknown'
      else if (value.fixtureBinding) { memoryState = 'created'; receiptFile = value.publicArguments['fixtures-receipt'] }
      const report = await seed(value, privateMaterial)
      if (value.prepareFixtures) { memoryState = 'created'; receiptFile = value.report }
      return report
    },
    async journey(argumentsForRunner, value) {
      check(value)
      if (value.prepareFixtures) memoryState = 'created-or-unknown'
      if (value.fixtureBinding) { memoryState = 'created'; receiptFile = value.publicArguments['fixtures-receipt']; referenceOptions = value }
      const grantStatus = { state: 'not-created', bindings: [] }; images.push(grantStatus)
      const report = await coordinate(argumentsForRunner, value, privateMaterial, { catalogFence: fence, grantStatus })
      if (value.prepareFixtures) { memoryState = 'created'; receiptFile = value.report; referenceOptions = value }
      return report
    },
  }
  try { result = await work(runtime) } catch (error) { failure = error }
  finally {
    if (memoryState === 'created' && receiptFile) {
      try {
        const released = await seed(releaseOptionsForQa(referenceOptions, receiptFile), privateMaterial, async session => session.revokeMemory())
        assert(released.kind === 'control-api-authorize-qa-finalization.v1' && released.fixtureFinalization?.verified === true &&
          released.fixtureFinalization.state === 'revoked' && released.fixtureFinalization.grantsRevoked === 2 &&
          released.fixtureFinalization.hostsDetached === 2, 'COORDINATOR_MEMORY_QA_FINALIZATION_UNPROVED')
        memoryState = 'revoked'
      } catch (error) { failure ??= error }
    }
    const restoreSafe = catalogRestorationSafe(memoryState, images)
    if (restoreSafe) {
      try { await restoreDeployments(options.context, [fence]) } catch (error) { failure ??= error }
    } else {
      // Keep both actual cron overrides false: connected opaque QA can be
      // touched by Control API's direct first cron tick, outside vendor hooks.
      try {
        writeCatalogRecovery(path.join(path.dirname(options.report), `${options.runId}-catalog-recovery.json`),
          fence, options, memoryState, images)
      } catch (error) { failure ??= error }
      failure ??= new Error('COORDINATOR_CATALOG_RESTORE_BLOCKED_BY_QA')
    }
  }
  if (failure) throw new Error(/^[A-Z0-9_]+$/.test(failure.message) ? failure.message : 'COORDINATOR_CATALOG_SCOPE_FAILED')
  return result
}

export function catalogRestorationSafe(memoryState, images) {
  return ['not-created', 'revoked'].includes(memoryState) &&
    images.every(value => ['not-created', 'revoked'].includes(value.state))
}

function writeCatalogRecovery(filename, fence, options, memoryState, images) {
  const directory = path.dirname(filename), stat = fs.lstatSync(directory)
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && !(stat.mode & 0o077) &&
    fs.realpathSync(directory) === directory, 'COORDINATOR_RECOVERY_DIRECTORY_UNSAFE')
  fs.writeFileSync(filename, JSON.stringify({ kind: 'evenfire-control-api-qa-catalog-isolation-v1',
    profile: options.profile, context: options.context, runId: options.runId,
    deploymentUid: fence.original.uid, imageId: fence.baseImageId, initialControlledEnv: fence.original.env,
    retainedControlledEnv: fence.applied.env, memoryQaState: memoryState,
    imageQa: images.map(value => ({ state: value.state, bindings: value.bindings })),
    reason: 'CATALOG_CRONS_REMAIN_FALSE_UNTIL_ALL_OWNED_QA_REVOCATIONS_VERIFIED', recordedAt: new Date().toISOString(),
  }), { flag: 'wx', mode: 0o600 })
}

export function verifyQaModelProjection(configMap, binding) {
  const bound = binding.provider === 'grok-subscription' ? projection.toEligibleGrokPolicyBinding : projection.toEligiblePolicyBinding
  const models = JSON.parse(configMap.data?.[binding.provider] ?? '[]')
  for (const [model, expected] of [[binding.modelId, 'supported'], [binding.unsupportedModelId, 'unsupported'],
    [binding.fallback.modelId, 'supported']]) {
    const eligible = bound(configMap, binding.connectionKey, model)
    const matches = models.filter(value => value.model === model)
    assert(eligible.binding?.credentialRevision === binding.credentialRevision &&
      eligible.binding.catalogRevision === binding.catalogRevision && matches.length === 1 &&
      imageCapability.resolveImageInputCapability(matches[0].imageInput, { transportSupported: true }).state === expected,
      'COORDINATOR_ACTUAL_MODEL_ELIGIBILITY_UNPROVED')
  }
  assert(binding.fallback.provider === binding.provider && binding.fallback.modelId !== binding.modelId &&
    binding.fallback.modelId !== binding.unsupportedModelId, 'COORDINATOR_FALLBACK_GRANT_INVALID')
  return true
}

// The actual import publishes its own allowlisted witness. This reader returns
// only that witness and the append-only ledger; no process environment/argv,
// credentials, request body or diagnostic output is read.
export const VENDOR_OBSERVATION_PROGRAM = String.raw`
const fs=require('node:fs');let raw='';
process.stdin.on('data',chunk=>{raw+=chunk;if(raw.length>65536)process.exit(1)});
process.stdin.on('end',()=>{try{
 const input=JSON.parse(raw);
 const read=file=>{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||
  (stat.mode&511)!==384||stat.uid!==process.getuid()||stat.size>4*1024*1024)throw Error('VENDOR_RECORD_INVALID');
  return JSON.parse(fs.readFileSync(file,'utf8'))};
 const witness=read(input.evidencePath+'.runtime.json');
 if(witness.pid!==Number(witness.pid)||!Number.isSafeInteger(witness.pid)||witness.pid<1||
    fs.readFileSync('/proc/'+witness.pid+'/stat','utf8').split(') ')[1].split(' ')[19]!==witness.startTime)throw Error('VENDOR_PROCESS_CHANGED');
 process.stdout.write(JSON.stringify({witness,ledger:read(input.evidencePath)}));
}catch{process.exitCode=1}});`

async function activateVendors({ contextDir, source, memoryOptions, qa, runId, states }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'deploy/minikube/.image-manifest.json'), 'utf8'))
  assert(manifest.profile === memoryOptions.profile, 'COORDINATOR_IMAGE_MANIFEST_PROFILE')
  const hostRef = 'clerum/mcp-host:test', hostId = manifest.images[hostRef]
  assert(validImageId(hostId) && manifest.sourceRevisions?.[hostRef] === source.gitHead,
    'COORDINATOR_EXACT_MUSL_HOST_IMAGE_REQUIRED')
  const sources = {}
  for (const provider of PROVIDERS) {
    const name = `${provider.startsWith('grok') ? 'grok' : 'codex'}-llm-proxy`
    const resource = getDeployment(memoryOptions.context, name)
    const names = ['NODE_ENV', 'NODE_OPTIONS', 'EVENFIRE_SUBSCRIPTION_IMAGE_VENDOR_FIXTURE',
      'SUBSCRIPTION_IMAGE_FIXTURE_PROVIDER', 'SUBSCRIPTION_IMAGE_EVIDENCE_PATH', 'E2E_SUBSCRIPTION_IMAGE_RUN_ID',
      'E2E_GROK_IMAGE_MODEL', 'E2E_GROK_IMAGE_UNSUPPORTED_MODEL', 'E2E_CODEX_IMAGE_MODEL', 'E2E_CODEX_IMAGE_UNSUPPORTED_MODEL']
    const original = snapshotDeployment(resource, name, names)
    const baseId = manifest.images[original.image] ?? manifest.images[`docker.io/${original.image}`]
    const basePod = await until(() => readyPod(memoryOptions.context, name, original.uid), Boolean, 120_000,
      'COORDINATOR_BASE_PROXY_NOT_READY')
    assert(validImageId(baseId) && imageId(basePod.status.containerStatuses.find(value => value.name === name).imageID) === baseId &&
      (manifest.sourceRevisions?.[original.image] ?? manifest.sourceRevisions?.[`docker.io/${original.image}`]) === source.gitHead,
      'COORDINATOR_BASE_PROXY_SOURCE_MISMATCH')
    const baseDist = command('kubectl', ['--context', memoryOptions.context, '-n', NAMESPACE, 'exec', basePod.metadata.name,
      '-c', name, '--', 'env', '-u', 'NODE_OPTIONS', 'node', '-e',
      "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('dist/main.js')).digest('hex'))"],
      { timeout: 30_000 }).trim()
    const fixtureTag = `clerum/${name}-image-qa:${runId.slice(-12)}`
    const built = JSON.parse(command('bash', [path.join(ROOT, 'scripts/e2e/build-subscription-image-proxy.sh'),
      memoryOptions.profile, contextDir, original.image, baseId, hostId, fixtureTag, source.gitHead], { timeout: 450_000 }))
    assert(built.baseImageId === baseId && built.hostImageId === hostId && built.gitHead === source.gitHead &&
      validImageId(built.imageId), 'COORDINATOR_DERIVED_BUILD_IDENTITY')
    const env = { ...original.env, NODE_ENV: 'test', NODE_OPTIONS: [original.env.NODE_OPTIONS,
      `--import=${IMPORT_PATH}`].filter(Boolean).join(' '), EVENFIRE_SUBSCRIPTION_IMAGE_VENDOR_FIXTURE: '1',
      SUBSCRIPTION_IMAGE_FIXTURE_PROVIDER: provider,
      SUBSCRIPTION_IMAGE_EVIDENCE_PATH: `/tmp/evenfire-vendor/${runId}-${provider}.json`, E2E_SUBSCRIPTION_IMAGE_RUN_ID: runId }
    for (const binding of qa.bindings) {
      const prefix = binding.provider.startsWith('grok') ? 'GROK' : 'CODEX'
      env[`E2E_${prefix}_IMAGE_MODEL`] = binding.modelId
      env[`E2E_${prefix}_IMAGE_UNSUPPORTED_MODEL`] = binding.unsupportedModelId
    }
    const applied = { image: fixtureTag, env }
    const state = { name, original, applied, baseImageId: baseId, fixtureImageId: built.imageId,
      gitHead: source.gitHead, changed: true, provider }; states.push(state)
    patchDeployment(memoryOptions.context, name, deploymentMutationPatch(getDeployment(memoryOptions.context, name), original, applied))
    command('kubectl', ['--context', memoryOptions.context, '-n', NAMESPACE, 'rollout', 'status', `deployment/${name}`, '--timeout=120s'],
      { timeout: 150_000 })
    const pod = await until(() => readyPod(memoryOptions.context, name, original.uid), Boolean, 120_000,
      'COORDINATOR_DERIVED_PROXY_NOT_READY')
    const observation = json(memoryOptions.context, ['-n', NAMESPACE, 'exec', '-i', pod.metadata.name, '-c', name,
      '--', 'env', '-u', 'NODE_OPTIONS', '-u', 'EVENFIRE_SUBSCRIPTION_IMAGE_VENDOR_FIXTURE',
      'node', '-e', VENDOR_OBSERVATION_PROGRAM], JSON.stringify({ evidencePath: env.SUBSCRIPTION_IMAGE_EVIDENCE_PATH }))
    const actual = observation.witness
    assert(actual.kind === 'evenfire-subscription-image-vendor-runtime-v1' && actual.runId === runId && actual.provider === provider &&
      /^24\./.test(actual.nodeVersion) && actual.musl === true && actual.nodeOptionsSha256 === digest(env.NODE_OPTIONS) &&
      actual.importSha256 === digest(fs.readFileSync(path.join(contextDir, 'scripts/e2e/fixtures/subscription-image-provider.mjs'))) &&
      actual.productionDistSha256 === baseDist, 'COORDINATOR_ACTUAL_IMPORT_OR_DIST_MISMATCH')
    const physicalImageId = imageId(pod.status.containerStatuses.find(value => value.name === name).imageID)
    assert(physicalImageId === built.imageId && physicalImageId !== baseId, 'COORDINATOR_DERIVED_IMAGE_UNPROVED')
    const witness = { profile: memoryOptions.profile, gitHead: source.gitHead, podUid: pod.metadata.uid,
      imageId: physicalImageId, fixtureImportSha256: actual.importSha256,
      deploymentUid: original.uid, pid: actual.pid, processStartTime: actual.startTime,
      productionDistSha256: baseDist, baseImageId: baseId, hostImageId: hostId }
    Object.assign(state, { podName: pod.metadata.name, witness, env, runtimeWitness: actual })
    sources[provider] = witness
  }
  return sources
}

function selectedFields(resource, original) {
  assert(resource.metadata.uid === original.uid, 'COORDINATOR_DEPLOYMENT_OWNER_CHANGED')
  const container = resource.spec.template.spec.containers.find(value => value.name === original.containerName)
  const env = {}
  for (const name of original.names) {
    const values = (container.env ?? []).filter(value => value.name === name)
    assert(values.length <= 1 && values.every(value => !value.valueFrom), 'COORDINATOR_RESTORE_ENV_AMBIGUOUS')
    if (values.length) env[name] = values[0].value
  }
  return { image: container.image, env }
}

async function restoreDeployments(context, states) {
  const failures = []
  for (const state of [...states].reverse()) {
    if (!state.changed) continue
    try {
      const current = getDeployment(context, state.name)
      const wanted = { image: state.original.image, env: state.original.env }
      if (!isDeepStrictEqual(selectedFields(current, state.original), wanted))
        patchDeployment(context, state.name, deploymentMutationPatch(current, state.original, state.applied, true))
      command('kubectl', ['--context', context, '-n', NAMESPACE, 'rollout', 'status', `deployment/${state.name}`, '--timeout=120s'],
        { timeout: 150_000 })
      assert(isDeepStrictEqual(selectedFields(getDeployment(context, state.name), state.original), wanted),
        'COORDINATOR_RESTORATION_UNPROVED')
      const pod = await until(() => readyPod(context, state.name, state.original.uid), Boolean, 120_000, 'COORDINATOR_RESTORED_POD_UNREADY')
      assert(imageId(pod.status.containerStatuses.find(value => value.name === state.name).imageID) === state.baseImageId,
        'COORDINATOR_RESTORED_IMAGE_ID_CHANGED')
      state.changed = false
    } catch { failures.push(state.name) }
  }
  assert(failures.length === 0, 'COORDINATOR_RESTORATION_FAILED')
}

export async function * vendorFrames({ admission, states, loginFrame, remainingFrame, observe, signal }) {
  yield Buffer.from(JSON.stringify(loginFrame) + '\n')
  if (remainingFrame) yield Buffer.from(JSON.stringify(remainingFrame) + '\n')
  const previous = new Map(PROVIDERS.map(provider => [provider, []]))
  const hashes = new Map()
  while (!signal.aborted) {
    for (const state of states.filter(value => value.provider)) {
      const observed = await observe(state)
      const frame = { kind: 'evenfire-subscription-image-vendor-frame-v1', runId: admission.runId,
        provider: state.provider, source: state.witness, ledger: observed.ledger }
      const binding = admission.bindings.find(value => value.provider === state.provider)
      admitVendorFrame(frame, admission.runId, binding, admission.vendorSources[state.provider], previous.get(state.provider))
      const hash = digest(JSON.stringify(frame))
      if (hash !== hashes.get(state.provider)) {
        previous.set(state.provider, structuredClone(frame.ledger.attempts)); hashes.set(state.provider, hash)
        yield Buffer.from(JSON.stringify(frame) + '\n')
      }
    }
    if (!signal.aborted) await pause(50) // Receipt polling never advances UI.
  }
}

export const PRESSURE_RELAY_PROGRAM = String.raw`
import fs from 'node:fs';import net from 'node:net';
const socketPath=process.argv[1];
if(!/^\/run\/evenfire-e2e\/pressure-[a-f0-9]{12}\.sock$/.test(socketPath)||fs.existsSync(socketPath))throw Error('RELAY_PATH_INVALID');
const pending=new Map(),sockets=new Set();let next=0,buffer='';
const server=net.createServer(socket=>{let raw='';sockets.add(socket);socket.requestBusy=false;
 socket.on('data',chunk=>{raw+=chunk;if(raw.length>65536||socket.requestBusy){socket.destroy();return}
  const end=raw.indexOf('\n');if(end<0)return;
  const line=raw.slice(0,end);raw=raw.slice(end+1);if(raw){socket.destroy();return}
  const callId=String(++next);pending.set(callId,socket);socket.requestBusy=true;socket.pause();
  process.stdout.write(JSON.stringify({callId,input:JSON.parse(line)})+'\n');
 });socket.on('close',()=>{sockets.delete(socket);for(const [id,value]of pending)if(value===socket)pending.delete(id)});
});
process.stdin.on('data',chunk=>{buffer+=chunk;if(buffer.length>65536)throw Error('RELAY_BOUND');
 for(let end;(end=buffer.indexOf('\n'))>=0;){const frame=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
  const socket=pending.get(frame.callId);if(!socket)throw Error('RELAY_UNKNOWN_REPLY');pending.delete(frame.callId);
  socket.write(JSON.stringify(frame.data)+'\n');socket.requestBusy=false;socket.resume();
 }});
process.stdin.on('end',()=>{for(const socket of sockets)socket.destroy();server.close(()=>{
 if(fs.existsSync(socketPath))fs.unlinkSync(socketPath);process.exitCode=0})});
server.listen(socketPath,()=>{fs.chmodSync(socketPath,384);process.stdout.write(JSON.stringify({ready:true,socketPath})+'\n')});`

/** A broken relay must not bypass native request release or Channel shutdown. */
export async function closePressureResources(relay, pressure) {
  const results = await Promise.allSettled([relay, pressure].map(resource =>
    Promise.resolve().then(() => resource?.close())))
  const failures = results.filter(value => value.status === 'rejected').map(value => value.reason)
  if (failures.length) throw new AggregateError(failures, 'COORDINATOR_PRESSURE_RESTORATION_FAILED')
}

/** A successful runner does not authorize canonical vendor restoration. The
 * actual seeder must first acknowledge both owned grant revocations/detaches.
 */
export async function withImageQaSession(session, runId, grantStatus, work) {
  grantStatus.state = 'created-or-unknown'
  try {
    const qa = await session.prepareImages(runId)
    grantStatus.state = 'created'
    grantStatus.bindings = qa.bindings.map(({ provider, hostRef, hostUid, connectionKey, connectionId }) =>
      ({ provider, hostRef, hostUid, connectionKey, connectionId }))
    return await work(qa)
  } finally {
    const restored = await session.revokeImages()
    assert(restored.verified === true && (grantStatus.state !== 'created' ||
      (restored.grantsRevoked === grantStatus.bindings.length && restored.hostsDetached === grantStatus.bindings.length)),
      'COORDINATOR_QA_GRANT_RESTORATION_FAILED')
    grantStatus.state = 'revoked'
  }
}

export function qaRestorationTargets(grantState, states) {
  return { restore: states.filter(state => !state.provider || grantState === 'revoked'),
    retain: states.filter(state => state.provider && state.changed && grantState !== 'revoked') }
}

function writeQaRecovery(filename, grantStatus, states, options, runId) {
  const directory = path.dirname(filename), stat = fs.lstatSync(directory)
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() &&
    !(stat.mode & 0o077) && fs.realpathSync(directory) === directory, 'COORDINATOR_RECOVERY_DIRECTORY_UNSAFE')
  fs.writeFileSync(filename, JSON.stringify({ kind: 'evenfire-subscription-image-qa-recovery-v1',
    runId, profile: options.profile, context: options.context, recordedAt: new Date().toISOString(),
    qaGrantState: grantStatus.state, qaBindings: grantStatus.bindings,
    vendorsRetained: states.map(state => ({ provider: state.provider, name: state.name,
      deploymentUid: state.original.uid, originalImageId: state.baseImageId, originalImage: state.original.image,
      fixtureImageId: state.fixtureImageId, gitHead: state.gitHead,
      originalControlledEnv: state.original.env, fixtureImage: state.applied.image,
      fixtureControlledEnv: state.applied.env, witness: state.witness })),
    canonicalRestore: 'BLOCKED_UNTIL_OWNED_GRANT_REVOCATION_VERIFIED',
  }), { flag: 'wx', mode: 0o600 })
}

async function pressureRelay({ containerName, pressure, metadata, processIdentity }) {
  const child = spawn('docker', ['exec', '-i', containerName, 'node', '--input-type=module', '-e', PRESSURE_RELAY_PROGRAM,
    metadata.socketPath], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume(); child.stdout.setEncoding('utf8')
  let buffer = '', chain = Promise.resolve(), failed, readyResolve, readyReject, accepting = true
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const observation = value => ({ ok: true, pressureRunId: metadata.pressureRunId, maxInFlight: metadata.maxInFlight,
    owners: { baseline: 0, held: value.inFlight, drained: value.inFlight },
    counts: { sameRunAttempts: value.counts.total, sameRunTickets: value.counts.tickets, reservations: value.counts.reservationRows },
    pids: [value.pid], inspector: { pid: value.pid, startTime: processIdentity.startTime } })
  child.stdout.on('data', chunk => {
    if (!accepting) return
    buffer += chunk
    if (Buffer.byteLength(buffer) > 65536) { failed = true; readyReject(new Error('PRESSURE_RELAY_BOUND')); child.kill('SIGTERM'); return }
    for (let end; (end = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      chain = chain.then(async () => {
        const frame = JSON.parse(line)
        if (frame.ready === true) { assert(frame.socketPath === metadata.socketPath, 'PRESSURE_RELAY_PATH_CHANGED'); readyResolve(); return }
        const input = frame.input
        assert(input.pressureRunId === metadata.pressureRunId && ['hello', 'hold', 'owners', 'release', 'close'].includes(input.command),
          'PRESSURE_RELAY_COMMAND_INVALID')
        let value
        if (input.command === 'hold') {
          assert(input.maxInFlight === metadata.maxInFlight, 'PRESSURE_RELAY_POLICY_CHANGED')
          value = await pressure.hold()
        } else if (['release', 'close'].includes(input.command)) value = await pressure.release()
        else value = await pressure.owners()
        const data = observation(value)
        if (input.command === 'hold') data.owners.drained = 0
        child.stdin.write(JSON.stringify({ callId: frame.callId, data }) + '\n')
      }).catch(() => { failed = true; readyReject(new Error('PRESSURE_RELAY_FAILED')); child.kill('SIGTERM') })
    }
  })
  child.once('error', () => { failed = true; readyReject(new Error('PRESSURE_RELAY_START_FAILED')) })
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    if (code !== 0 || signal) { failed = true; readyReject(new Error('PRESSURE_RELAY_PRODUCER_FAILED')) }
    resolve({ code, signal })
  }))
  const timer = setTimeout(() => { readyReject(new Error('PRESSURE_RELAY_READY_TIMEOUT')); child.kill('SIGTERM') }, 30_000)
  try { await ready } finally { clearTimeout(timer) }
  let closing
  return { assertHealthy: () => assert(!failed, 'PRESSURE_RELAY_PRODUCER_FAILED'),
    close: () => closing ??= (async () => {
      accepting = false
      await chain; child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      const result = await exited; clearTimeout(timer)
      assert(!failed && result.code === 0 && !result.signal, 'PRESSURE_RELAY_PRODUCER_FAILED')
    })() }
}

export async function coordinate(prepareArguments, memoryOptions, privateMaterial, catalogRuntime) {
  assert(process.versions.node.startsWith('24.') && fs.realpathSync(process.cwd()) === ROOT, 'COORDINATOR_NODE24_WORKTREE_REQUIRED')
  assert((memoryOptions.prepareFixtures === true || memoryOptions.fixtureBinding) && privateMaterial && typeof privateMaterial.operatorPassword === 'string' &&
    privateMaterial.operatorPassword.length >= 8 && privateMaterial.operatorPassword.length <= 1024 &&
    (privateMaterial.cookie === undefined || (typeof privateMaterial.cookie === 'string' &&
      privateMaterial.cookie.length <= 8192 && !/[\r\n\0]/.test(privateMaterial.cookie))) &&
    Object.keys(privateMaterial).every(key => ['operatorPassword', 'cookie'].includes(key)),
    'COORDINATOR_PRIVATE_OPERATOR_REQUIRED')
  assert(memoryOptions.operatorUser === `${memoryOptions.runId}-operator`, 'COORDINATOR_ISOLATED_OPERATOR_REQUIRED')
  assert(memoryOptions.prepare === 'restart', 'COORDINATOR_RECONCILED_BASELINE_REQUIRED')
  const values = Object.fromEntries(Array.from({ length: prepareArguments.length / 2 }, (_, index) =>
    [prepareArguments[index * 2].slice(2), prepareArguments[index * 2 + 1]]))
  assert(values.mode === 'fixture' && values.profile === memoryOptions.profile && /^subscription-image-[a-f0-9]{12}$/.test(values['run-id'] ?? '') &&
    values.frames === '-' && !values.bindings && path.isAbsolute(values.scratch), 'COORDINATOR_PUBLIC_ARGUMENTS_INVALID')
  const suite = resolveSuite(values.suite)
  command('bash', [path.join(ROOT, 'scripts/minikube/require-t2-mutation-lock.sh')], { timeout: 10_000 })
  const states = [], abort = new AbortController()
  const grantStatus = catalogRuntime?.grantStatus ?? { state: 'not-created', bindings: [] }
  let catalogFence = catalogRuntime?.catalogFence, memoryState = memoryOptions.fixtureBinding ? 'created' : 'not-created'
  let result, failure, relay, pressure
  let pressureClosing
  const closePressure = () => pressureClosing ??= closePressureResources(relay, pressure)
  const onSignal = () => abort.abort(new Error('COORDINATOR_INTERRUPTED'))
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal)
  try {
    if (!catalogFence) catalogFence = await openControlApiCatalogIsolation(memoryOptions)
    if (values.suite === 'admission-recovery') {
      const resource = getDeployment(memoryOptions.context, 'control-api')
      const original = snapshotDeployment(resource, 'control-api', ['NODE_OPTIONS'])
      const basePod = await until(() => readyPod(memoryOptions.context, 'control-api', original.uid), Boolean, 120_000,
        'COORDINATOR_BASE_API_NOT_READY')
      const baseImageId = imageId(basePod.status.containerStatuses.find(value => value.name === 'control-api').imageID)
      assert(validImageId(baseImageId), 'COORDINATOR_BASE_API_IMAGE_UNKNOWN')
      const applied = { image: original.image, env: { NODE_OPTIONS:
        `--max-old-space-size=${memoryOptions.candidate.heapSizeMiB} --inspect=127.0.0.1:${memoryOptions.inspectorPort}` } }
      const state = { name: 'control-api', original, applied, baseImageId, changed: true }; states.push(state)
      patchDeployment(memoryOptions.context, state.name, deploymentMutationPatch(resource, original, applied))
      command('kubectl', ['--context', memoryOptions.context, '-n', NAMESPACE, 'rollout', 'status', 'deployment/control-api', '--timeout=120s'],
        { timeout: 150_000 })
    }
    if (memoryOptions.prepareFixtures) memoryState = 'created-or-unknown'
    await seed(memoryOptions, privateMaterial, async session => {
      memoryState = 'created'
      await withImageQaSession(session, values['run-id'], grantStatus, async qa => {
        assert(qa.credentialState === 'opaque-qa-not-real-G8' && qa.vendorCronsDisabled === true &&
          qa.operatorDesktopUserId === session.fixtures.operatorDesktopUserId && qa.operatorDesktopUserId !== session.fixtures.operatorId,
          'COORDINATOR_DESKTOP_OPERATOR_UNPROVED')
        const configMap = json(memoryOptions.context, ['-n', memoryOptions.hostNamespace, 'get', 'configmap',
          'clerum-llm-allowed-models', '-o', 'json'])
        for (const binding of qa.bindings) verifyQaModelProjection(configMap, binding)
        let closed = false, remainingFrame
        const flow = { bindings: qa.bindings.map(({ provider, hostRef, hostLabel, modelId, modelLabel,
          unsupportedModelId, unsupportedModelLabel }) => ({ provider, hostRef, hostLabel, modelId, modelLabel,
          unsupportedModelId, unsupportedModelLabel })),
          async beforeBuild(input) {
            flow.vendorSources = await activateVendors({ ...input, memoryOptions, qa, runId: values['run-id'], states })
          },
          async configure(admission, { containerName }) {
            let metadata
            if (admission.suiteId === 'admission-recovery') {
              const child = spawn('kubectl', ['--context', memoryOptions.context, '-n', NAMESPACE, 'exec', '-i', session.apiPod.name,
                '-c', 'control-api', '--', 'env', '-u', 'NODE_OPTIONS', 'node', '--max-old-space-size=64',
                '--input-type=module', '-e', buildAuthorizeMemoryCompanionBundle()], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] })
              pressure = await openAuthorizeAdmissionPressure(new Channel(child, pressureCommandDeadlineMs(memoryOptions.candidate)), {
                candidate: memoryOptions.candidate, inspectorPort: memoryOptions.inspectorPort,
                runId: `pr806-memory-${admission.runId.slice(-12)}`, hostNamespace: memoryOptions.hostNamespace,
                bindings: qa.bindings.map(value => ({ hostRef: value.hostRef, hostUid: value.hostUid })) })
              const owner = await pressure.owners()
              const processIdentity = json(memoryOptions.context, ['-n', NAMESPACE, 'exec', '-i', session.apiPod.name,
                '-c', 'control-api', '--', 'env', '-u', 'NODE_OPTIONS', 'node', '-e',
                "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const pid=JSON.parse(s).pid;const startTime=require('node:fs').readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ')[19];process.stdout.write(JSON.stringify({pid,startTime}))})"],
                JSON.stringify({ pid: owner.pid }))
              metadata = { kind: 'evenfire-subscription-image-pressure-metadata-v1', profile: admission.profile,
                context: admission.context, worktreeId: admission.stack.worktreeId,
                sourceManifestSha256: admission.sourceManifestSha256, podUid: session.apiPod.uid,
                imageId: session.apiPod.imageId, pressureRunId: `subscription-image-pressure-${admission.runId.slice(-12)}`,
                hostRefs: qa.bindings.map(value => value.hostRef), maxInFlight: memoryOptions.candidate.concurrency,
                readDeadlineMs: pressure.policy.readDeadlineMs, workDeadlineMs: pressure.policy.workDeadlineMs,
                closeGraceMs: pressure.policy.closeGraceMs, commandDeadlineMs: pressure.commandDeadlineMs,
                socketPath: `${RUNNER_RUN_BASE}/pressure-${admission.runId.slice(-12)}.sock` }
              relay = await pressureRelay({ containerName, pressure, metadata, processIdentity })
            }
            if (suite.fixtureReceiptEnv) {
              const prepared = await prepareRemainingFixtures({ admission, runRoot: `${RUNNER_RUN_BASE}/${admission.runId}`,
                hostBindings: qa.bindings,
                prepareGfs: input => session.prepareGfs({ ...input, userId: qa.operatorDesktopUserId,
                  parentResourceId: session.fixtures.gfs.parentResourceId }),
                pressure: metadata && { ...metadata,
                  receiptFile: '/runner-admission/main-admission.json' } })
              remainingFrame = prepared.frame
            }
            return metadata ? { pressureMetadata: metadata } : undefined
          },
          frames(admission) {
            const loginFrame = Object.fromEntries([['kind', 'evenfire-subscription-image-login-v1'],
              ['runId', admission.runId], ['email', qa.loginEmail], ['password', privateMaterial.operatorPassword]])
            return Readable.from(vendorFrames({ admission, states, remainingFrame, loginFrame, signal: abort.signal,
              observe: state => {
                relay?.assertHealthy()
                const current = readyPod(memoryOptions.context, state.name, state.original.uid)
                assert(current?.metadata?.uid === state.witness.podUid &&
                  imageId(current.status.containerStatuses.find(value => value.name === state.name).imageID) === state.witness.imageId,
                  'COORDINATOR_VENDOR_POD_CHANGED')
                const observed = json(memoryOptions.context, ['-n', NAMESPACE, 'exec', '-i', state.podName, '-c', state.name,
                  '--', 'env', '-u', 'NODE_OPTIONS', '-u', 'EVENFIRE_SUBSCRIPTION_IMAGE_VENDOR_FIXTURE', 'node', '-e', VENDOR_OBSERVATION_PROGRAM],
                  JSON.stringify({ evidencePath: state.env.SUBSCRIPTION_IMAGE_EVIDENCE_PATH }))
                assert(isDeepStrictEqual(observed.witness, state.runtimeWitness), 'COORDINATOR_VENDOR_SOURCE_CHANGED')
                return observed
              } }), { objectMode: false, highWaterMark: 64 * 1024 })
          },
          async close() {
            if (closed) return
            closed = true; abort.abort()
            await closePressure()
          },
        }
        result = await prepare(prepareArguments, flow)
        assert(result === 0 && !abort.signal.reason?.message?.includes('INTERRUPTED'), 'COORDINATOR_RUNNER_FAILED')
      })
    })
  } catch (error) { failure = error }
  finally {
    abort.abort()
    try { await closePressure() } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'COORDINATOR_OPERATION_AND_CLEANUP_FAILED') : error
    }
    const targets = qaRestorationTargets(grantStatus.state, states)
    try { await restoreDeployments(memoryOptions.context, targets.restore) } catch (error) {
      failure = failure ? new AggregateError([failure, error], 'COORDINATOR_OPERATION_AND_CLEANUP_FAILED') : error
    }
    if (targets.retain.length) {
      try {
        writeQaRecovery(path.join(path.dirname(memoryOptions.report), `${values['run-id']}-qa-recovery.json`),
          grantStatus, targets.retain, memoryOptions, values['run-id'])
      } catch (error) {
        failure = failure ? new AggregateError([failure, error], 'COORDINATOR_OPERATION_AND_CLEANUP_FAILED') : error
      }
      failure ??= new Error('COORDINATOR_CANONICAL_VENDOR_RESTORE_BLOCKED')
    }
    if (catalogFence && !catalogRuntime) {
      if (memoryState === 'not-created' && ['not-created', 'revoked'].includes(grantStatus.state)) {
        try { await restoreDeployments(memoryOptions.context, [catalogFence]) } catch (error) { failure ??= error }
      } else {
        try { writeCatalogRecovery(path.join(path.dirname(memoryOptions.report), `${values['run-id']}-catalog-isolation.json`),
          catalogFence, memoryOptions, memoryState, [grantStatus]) } catch (error) { failure ??= error }
      }
    }
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal)
  }
  if (failure) throw new Error(/^[A-Z0-9_]+$/.test(failure.message) ? failure.message : 'COORDINATOR_FAILED')
  return { kind: 'evenfire-subscription-image-coordinator-v1', producerExit: result,
    vendorBoundary: 'derived-external-fetch-only', restoration: { verified: true, scope: 'vendor-images-and-inspector' },
    catalogIsolation: { retainedForMemoryFixtures: memoryState === 'created',
      ...(catalogFence ? { initialSnapshot: catalogFence.original } : {}) }, realOAuthOrG8: 'NOT_RUN' }
}

async function main() {
  const argv = process.argv.slice(2)
  const index = argv.indexOf('--memory-config')
  assert(index >= 0 && argv[index + 1], 'COORDINATOR_MEMORY_CONFIG_REQUIRED')
  const [, filename] = argv.splice(index, 2)
  const memoryOptions = parseOptions(['--config', filename])
  let bytes = Buffer.alloc(0), material
  for await (const chunk of process.stdin) {
    bytes = Buffer.concat([bytes, chunk]); assert(bytes.length <= 64 * 1024, 'COORDINATOR_PRIVATE_INPUT_BOUND')
    const end = bytes.indexOf(10)
    if (end < 0) continue
    assert(end === bytes.length - 1, 'COORDINATOR_ONE_PRIVATE_INPUT_REQUIRED')
    material = JSON.parse(bytes.toString('utf8')); bytes.fill(0); bytes = Buffer.alloc(0); break
  }
  assert(material?.kind === 'evenfire-subscription-image-private-control-v1', 'COORDINATOR_PRIVATE_INPUT_REQUIRED')
  const privateMaterial = Object.fromEntries(['operatorPassword', 'cookie'].filter(field => material[field] !== undefined)
    .map(field => [field, material[field]]))
  material = undefined
  const result = await coordinate(argv, memoryOptions, privateMaterial)
  for (const field of Object.keys(privateMaterial)) delete privateMaterial[field]
  process.stdout.write(JSON.stringify(result) + '\n')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { process.stderr.write('SUBSCRIPTION_IMAGE_COORDINATOR_FAILED\n'); process.exitCode = 1 })
