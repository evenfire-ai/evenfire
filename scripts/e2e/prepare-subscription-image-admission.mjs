#!/usr/bin/env node
// Host-side orchestration for the subscription-image runner chain:
// export allowlisted source -> build pinned image -> create private container ->
// copy the in-container session observation -> seal docker inspect, stack marker,
// owned forward records and the main admission -> stream operator frames ->
// collect receipts. It never reads repository environment files and never prints
// frame contents. Docker/kubectl stay explicit local CLIs with bounded deadlines.
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  MAIN_RECEIPT_FILES,
  PORT_FORWARD_SERVICES,
  RUNNER_ADMISSION_ROOT,
  RUNNER_RUN_BASE,
  RunnerAdmissionError,
  digest,
  parsePortsEnv,
  pinnedBaseImage,
  resolveSuite,
  sfwFreeAsset,
  suiteBuildArgs,
  verifyThirdPartyArtifact,
} from '../tests/lib/subscription-image-runner-contract.mjs'
import { exportSourceContext } from '../tests/lib/subscription-image-source-context.mjs'
import {
  buildAdmission,
  portForwardReceiptFrom,
  runtimeFromInspect,
  stackReceiptFrom,
} from '../tests/lib/subscription-image-main-admission.mjs'

const refuse = code => {
  throw new RunnerAdmissionError(code)
}
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CONTAINER_HOME = '/home/evenfire-e2e'
const DEFAULT_CACHE_ROOT = path.join(process.env.HOME ?? '', '.cache', 'clerum', 'minikube-profiles')

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) refuse('PREPARE_ARGUMENTS')
    values[key.slice(2)] = value
  }
  return values
}

function required(values, name) {
  const value = values[name]
  if (!value) refuse('PREPARE_ARGUMENTS')
  return value
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeout ?? 900_000,
    input: options.input,
    stdio: options.stdio ?? [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
}

async function waitFor(check, code, deadlineMs, intervalMs = 1000) {
  const started = Date.now()
  for (;;) {
    let value
    try {
      value = check()
    } catch {
      value = null
    }
    if (value) return value
    if (Date.now() - started > deadlineMs) refuse(code)
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
}

function writePrivateJson(filename, value) {
  fs.writeFileSync(filename, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
}

export async function prepare(argv = process.argv.slice(2)) {
  const values = parseArgs(argv)
  const suiteId = required(values, 'suite')
  const mode = required(values, 'mode')
  const profile = values.profile ?? process.env.MINIKUBE_PROFILE
  const context = process.env.CONTROL_API_REAL_PG_CONTEXT ?? profile
  const scratch = required(values, 'scratch')
  const framesFile = required(values, 'frames')
  const detector = required(values, 'red-detector')
  const bindingsFile = required(values, 'bindings')
  const cacheRoot = values['cache-root'] ?? DEFAULT_CACHE_ROOT
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(profile ?? '') || profile === 'clerum-test')
    refuse('PREPARE_PROFILE_REQUIRED')
  if (context !== profile) refuse('PREPARE_CONTEXT_MISMATCH')
  const suite = resolveSuite(suiteId)
  if (!suite.modes.includes(mode)) refuse('SUITE_MODE_NOT_ADMITTED')
  // Login frames travel through the live private input channel, never a file.
  if (framesFile !== '-') refuse('PREPARE_PRIVATE_INPUT_REQUIRES_STDIN')
  if (!path.isAbsolute(scratch) || !path.isAbsolute(bindingsFile) || !path.isAbsolute(detector))
    refuse('PREPARE_ABSOLUTE_PATHS')
  if (scratch.startsWith(`${SCRIPT_ROOT}/`) || scratch === SCRIPT_ROOT)
    refuse('PREPARE_SCRATCH_INSIDE_REPO')
  for (const filename of [bindingsFile]) {
    const stat = fs.lstatSync(filename)
    const parent = path.dirname(filename)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o777) !== 0o600 ||
      fs.realpathSync(parent) !== parent
    )
      refuse('PREPARE_PRIVATE_INPUT')
  }
  if (fs.realpathSync(detector) !== detector) refuse('PREPARE_RED_DETECTOR')
  const runId = values['run-id'] ?? `subscription-image-${randomBytes(6).toString('hex')}`
  if (!/^subscription-image-[a-f0-9]{12}$/.test(runId)) refuse('PREPARE_RUN_ID')
  const containerName = `evenfire-sir-${runId.slice('subscription-image-'.length)}`
  privateDirectory(scratch)
  const contextDir = path.join(scratch, 'context')
  const admissionDir = path.join(scratch, 'admission-host')
  const receiptDir = path.join(scratch, 'receipts')
  if (fs.existsSync(contextDir) || fs.existsSync(admissionDir) || fs.existsSync(receiptDir))
    refuse('PREPARE_SCRATCH_NOT_FRESH')
  const base = pinnedBaseImage(SCRIPT_ROOT)
  const source = exportSourceContext(SCRIPT_ROOT, contextDir, detector)
  if (source.gitHead !== run('git', ['-C', SCRIPT_ROOT, 'rev-parse', 'HEAD']).trim())
    refuse('PREPARE_SOURCE_RACE')
  // Third-party artifact (separate allowlist and receipt; never part of the Git
  // source manifest). The host fetch stays behind the local sfw wrapper.
  const sfwAsset = sfwFreeAsset(values.arch ?? process.arch)
  const artifactPath = path.join(scratch, 'third-party-sfw-free')
  if (values['sfw-artifact']) {
    if (!path.isAbsolute(values['sfw-artifact'])) refuse('PREPARE_SFW_ARTIFACT_PATH')
    fs.copyFileSync(values['sfw-artifact'], artifactPath)
  } else {
    try {
      run('which', ['sfw'], { timeout: 10_000 })
    } catch {
      refuse('PREPARE_HOST_SFW_REQUIRED')
    }
    run(
      'sfw',
      ['curl', '-fsSL', '--retry', '2', '--max-time', '900', '-o', artifactPath, sfwAsset.url],
      { timeout: 1_000_000, stdio: ['ignore', 'inherit', 'inherit'] }
    )
  }
  fs.chmodSync(artifactPath, 0o755)
  const thirdPartyArtifact = verifyThirdPartyArtifact({
    bytes: fs.readFileSync(artifactPath),
    asset: sfwAsset,
  })
  fs.mkdirSync(path.join(contextDir, 'third-party'), { recursive: true, mode: 0o700 })
  fs.copyFileSync(artifactPath, path.join(contextDir, 'third-party', 'sfw-free'))
  fs.chmodSync(path.join(contextDir, 'third-party', 'sfw-free'), 0o755)
  writePrivateJson(path.join(scratch, 'third-party-sfw-free.receipt.json'), thirdPartyArtifact)
  const buildArgs = ['-f', path.join(SCRIPT_ROOT, 'scripts/e2e/fixtures/subscription-image-runner.Dockerfile'), '-t', containerName, '--build-arg', `RUNNER_BASE_IMAGE=${base.reference}`]
  for (const [name, value] of Object.entries(suiteBuildArgs(suite)))
    buildArgs.push('--build-arg', `${name}=${value}`)
  buildArgs.push(contextDir)
  run('docker', ['build', ...buildArgs], { stdio: ['ignore', 'inherit', 'inherit'] })
  privateDirectory(admissionDir)
  privateDirectory(receiptDir)
  const volumeName = `${containerName}-admission`
  try {
    run('docker', ['volume', 'inspect', volumeName], { timeout: 30_000 })
    refuse('PREPARE_VOLUME_ALREADY_EXISTS')
  } catch (err) {
    if (err instanceof RunnerAdmissionError) throw err
  }
  run('docker', ['volume', 'create', volumeName], { timeout: 60_000 })
  const volumeInspect = JSON.parse(run('docker', ['volume', 'inspect', volumeName]))[0]
  const mount = `${volumeName}:${RUNNER_ADMISSION_ROOT}:ro`
  const tmpfs = (target, options) => ['--tmpfs', `${target}:${options}`]
  const createArgs = [
    'create',
    '--name',
    containerName,
    '-i',
    '--user',
    '10001:10001',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--ipc=private',
    '--network',
    'bridge',
    '--add-host',
    'host.docker.internal:host-gateway',
    ...tmpfs(CONTAINER_HOME, 'rw,nosuid,nodev,mode=0700,uid=10001,gid=10001'),
    ...tmpfs(RUNNER_RUN_BASE, 'rw,nosuid,nodev,mode=0700,uid=10001,gid=10001'),
    ...tmpfs('/tmp', 'rw,nosuid,nodev,mode=1777'),
    '-v',
    mount,
    '-e',
    `SUBSCRIPTION_IMAGE_RUN_ID=${runId}`,
    containerName,
  ]
  run('docker', createArgs)
  run('docker', ['start', containerName], { stdio: ['ignore', 'inherit', 'inherit'] })
  const observationFile = path.join(scratch, 'session-observation.json')
  try {
    await waitFor(
      () => {
        try {
          run('docker', ['cp', `${containerName}:${RUNNER_RUN_BASE}/session-observation.json`, observationFile], {
            timeout: 20_000,
          })
        } catch {
          return null
        }
        return fs.existsSync(observationFile) ? observationFile : null
      },
      'PREPARE_SESSION_OBSERVATION_TIMEOUT',
      120_000
    )
    const observation = JSON.parse(fs.readFileSync(observationFile, 'utf8'))
    if (
      observation?.kind !== 'evenfire-subscription-image-session-observation-v1' ||
      observation.runId !== runId ||
      observation.source?.gitHead !== source.gitHead ||
      observation.source?.gitTree !== source.gitTree
    )
      refuse('PREPARE_SESSION_OBSERVATION_IDENTITY')
    const inspect = JSON.parse(run('docker', ['inspect', containerName]))[0]
    const runtime = runtimeFromInspect(inspect, {
      runId,
      suiteId,
      home: observation.observation.home,
    })
    const portsEnvRaw = fs.readFileSync(path.join(cacheRoot, profile, 'ports.env'), 'utf8')
    const ports = parsePortsEnv(portsEnvRaw)
    const records = {}
    for (const [kind, expected] of Object.entries(PORT_FORWARD_SERVICES)) {
      const recordFile = path.join(cacheRoot, profile, 'pids', `${expected.service}.pid`)
      const localPort = ports[expected.key]
      if (!Number.isSafeInteger(localPort)) refuse('PREPARE_PORTS_ENV_REQUIRED')
      run('bash', [
        path.join(SCRIPT_ROOT, 'scripts/e2e/subscription-image-pf-owner.sh'),
        'matches',
        recordFile,
        profile,
        profile,
        SCRIPT_ROOT,
        expected.namespace,
        expected.service,
        String(localPort),
        String(expected.remotePort),
      ])
      records[kind] = fs.readFileSync(recordFile, 'utf8')
    }
    const stack = stackReceiptFrom({
      profile,
      context,
      configMap: JSON.parse(
        run('kubectl', [
          `--context=${profile}`,
          '-n',
          'control-plane',
          'get',
          'configmap',
          'clerum-pre-gate-sync-state',
          '-o',
          'json',
        ])
      ),
      portsEnvRaw,
      fetchedAt: new Date().toISOString(),
    })
    if (stack.data.gitHead !== source.gitHead) refuse('PREPARE_STACK_HEAD_MISMATCH')
    const portForwards = portForwardReceiptFrom({
      records,
      profile,
      context,
      portsEnvRaw,
      verifiedAt: new Date().toISOString(),
    })
    const inspectReceipt = {
      container: inspect,
      securityOptions: JSON.parse(run('docker', ['info', '--format', '{{json .SecurityOptions}}'])),
    }
    const files = [
      [MAIN_RECEIPT_FILES.inspect, inspectReceipt],
      [MAIN_RECEIPT_FILES.stack, stack],
      [MAIN_RECEIPT_FILES.portForwards, portForwards],
    ]
    const receipts = {}
    const receiptNames = {
      [MAIN_RECEIPT_FILES.inspect]: 'inspect',
      [MAIN_RECEIPT_FILES.stack]: 'stack',
      [MAIN_RECEIPT_FILES.portForwards]: 'portForwards',
    }
    for (const [name, value] of files) {
      const filename = path.join(admissionDir, name)
      writePrivateJson(filename, value)
      receipts[receiptNames[name]] = { value, sha256: digest(JSON.stringify(value)) }
    }
    const sealedFilename = path.join(scratch, 'subscription-image-source.json')
    run('docker', ['cp', `${containerName}:/opt/evenfire/subscription-image-source.json`, sealedFilename])
    const bindings = JSON.parse(fs.readFileSync(bindingsFile, 'utf8'))
    const transports = Object.fromEntries(
      Object.entries(PORT_FORWARD_SERVICES).map(([kind, expected]) => [
        kind,
        {
          origin: `http://host.docker.internal:${ports[expected.key]}`,
          service: expected.service,
          profile,
          context,
          worktreeId: stack.data.worktreeId,
          gitHead: stack.data.gitHead,
          portsReceiptSha256: stack.portsEnvSha256,
          forwardBindingSha256: digest(records[kind]),
        },
      ])
    )
    const admission = buildAdmission({
      runId,
      suiteId,
      mode,
      profile,
      context,
      repoRoot: SCRIPT_ROOT,
      gitHead: source.gitHead,
      gitTree: source.gitTree,
      inputManifestSha256: source.inputManifestSha256,
      sourceManifestSha256: digest(fs.readFileSync(sealedFilename)),
      imageId: inspect.Image,
      thirdPartyArtifacts: [thirdPartyArtifact],
      runtime,
      observation: observation.observation,
      networkNamespace: observation.networkNamespace,
      ipcNamespace: observation.ipcNamespace,
      stack,
      receipts: {
        generatedAt: new Date().toISOString(),
        dockerInspectSha256: receipts.inspect.sha256,
        stackMarkerSha256: receipts.stack.sha256,
        portForwardsSha256: receipts.portForwards.sha256,
      },
      bindings,
      transports,
    })
    admission.volume = {
      name: volumeName,
      driver: 'local',
      createdAt: new Date(Date.parse(volumeInspect.CreatedAt)).toISOString(),
      inspectSha256: digest(JSON.stringify(volumeInspect)),
    }
    writePrivateJson(path.join(admissionDir, 'main-admission.json'), admission)
    const framesPayload = [
      'main-admission.json',
      ...Object.values(MAIN_RECEIPT_FILES),
    ]
      .map(name => {
        const contents = fs.readFileSync(path.join(admissionDir, name))
        return `${JSON.stringify({ name, contentsBase64: contents.toString('base64') })}\n`
      })
      .join('')
    run(
      'docker',
      [
        'run',
        '--rm',
        '--user',
        '10001:10001',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--network',
        'none',
        '-v',
        `${volumeName}:${RUNNER_ADMISSION_ROOT}`,
        '-i',
        '--entrypoint',
        'node',
        containerName,
        '/opt/evenfire/scripts/e2e/run-subscription-image-journeys.mjs',
        'admission-write',
      ],
      { input: framesPayload, timeout: 120_000 }
    )
    const attached = spawn('docker', ['attach', '--sig-proxy=false', containerName], {
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    let inputFailed = false
    const onInputError = () => {
      inputFailed = true
      attached.kill('SIGTERM')
    }
    attached.stdin.on('error', onInputError)
    process.stdin.once('error', onInputError)
    process.stdin.pipe(attached.stdin)
    let result
    try {
      result = await new Promise(resolve => attached.once('exit', (code, signal) => resolve({ code, signal })))
    } finally {
      process.stdin.unpipe(attached.stdin)
      process.stdin.off('error', onInputError)
      process.stdin.pause()
    }
    const status = run('docker', ['wait', containerName], { timeout: 30_000 }).trim()
    for (const name of ['runner.json', 'journey-result.json', path.basename(observationFile)]) {
      try {
        run('docker', ['cp', `${containerName}:${RUNNER_RUN_BASE}/${
          name === path.basename(observationFile) ? 'session-observation.json' : `${runId}/${name}`
        }`, path.join(receiptDir, name)], { timeout: 20_000 })
      } catch {
        // A missing receipt is reported below by the compact summary.
      }
    }
    const summary = {
      kind: 'evenfire-subscription-image-prepare-v1',
      runId,
      suiteId,
      mode,
      profile,
      container: containerName,
      attachExit: result.code,
      attachSignal: result.signal,
      inputFailed,
      containerStatus: status,
      admissionDir,
      receiptDir,
      scratch,
    }
    console.log(JSON.stringify(summary, null, 2))
    return status === '0' && result.code === 0 && !inputFailed ? 0 : 1
  } catch (err) {
    if (values.keep !== 'true') {
      try {
        run('docker', ['rm', '-f', containerName], { timeout: 60_000 })
      } catch {
        // The original failure is the reported outcome.
      }
      try {
        run('docker', ['volume', 'rm', '-f', `${containerName}-admission`], { timeout: 60_000 })
      } catch {
        // The original failure is the reported outcome.
      }
    }
    throw err
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepare()
    .then(code => {
      process.exitCode = code
    })
    .catch(err => {
      console.error(
        JSON.stringify({
          kind: 'prepare-refused',
          code: err instanceof RunnerAdmissionError ? err.code : 'PREPARE_FAILED',
        })
      )
      process.exitCode = 1
    })
}
