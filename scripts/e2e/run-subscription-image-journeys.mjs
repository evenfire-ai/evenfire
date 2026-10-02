#!/usr/bin/env node
// E2E_GUARDIAN_IPC_FLOW: an inspected Linux runner launches the existing visible
// Desktop journeys. This entry never seeds, logs in through an API, mutates
// browser storage, or replaces Host/authorization/database/proxy behavior.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  MAIN_RECEIPT_FILES,
  RUNNER_ADMISSION_ROOT,
  RUNNER_RUN_BASE,
  RunnerAdmissionError,
  SESSION_OBSERVATION_FILE,
  SESSION_READY_MARKER,
  admitVendorFrame,
  digest,
  inspectPrivateIsolation,
  observeLinuxRunner,
  observePrivateIsolation,
  readPrivateJson,
  readMainRecord,
  readPrivateRecord,
  resolveSuite,
  verifyMainAdmission,
  verifyMountIsolation,
  verifyNativePrivateKeychain,
  verifySealedArtifacts,
  verifySuiteReport,
  verifySourceManifest,
} from '../tests/lib/subscription-image-runner-contract.mjs'
import { startPrivateSession } from './fixtures/subscription-image-session.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const RUN_BASE = RUNNER_RUN_BASE
const ADMISSION_ROOT = RUNNER_ADMISSION_ROOT
const MAX_FRAME_BYTES = 4 * 1024 * 1024
const SESSION_ADMISSION_DEADLINE_MS = 2_700_000
const VOLUME_MANIFEST_FILE = 'volume-manifest.json'
const refuse = code => {
  throw new RunnerAdmissionError(code)
}
const privateJson = (filename, value) => {
  fs.writeFileSync(filename, JSON.stringify(value), {
    flag: 'wx',
    mode: 0o600,
  })
}

export function runnerPlan() {
  return {
    kind: 'evenfire-subscription-image-runner-plan-v1',
    sourceOnly: true,
    image:
      'Node24 Linux base pinned by digest in subscription-image-runner.base-image; the reviewed base must ship sfw and the OS X/dbus/keyring packages',
    runtime: {
      user: '10001:10001',
      readOnlyRootfs: true,
      network: 'Dedicated reviewed bridge',
      ipc: 'private',
      pid: 'private',
      capDrop: ['ALL'],
      chromiumSandbox: 'Enabled; reviewed seccomp permits the required unprivileged namespaces',
      tmpfs: [
        '/home/evenfire-e2e:rw,nosuid,nodev,mode=0700,uid=10001,gid=10001',
        `${RUN_BASE}:rw,nosuid,nodev,mode=0700,uid=10001,gid=10001`,
        '/tmp:rw,nosuid,nodev,mode=1777',
      ],
      readOnlyMount: `${ADMISSION_ROOT}: independently inspected main admission and process bindings only`,
    },
    order: [
      'Build the minimal reviewed context from the exact owned commit',
      'bootstrap: start Xvfb, a private session bus and an encrypted gnome-keyring store, then collect physical account/namespaces/mounts/process/socket observations',
      'Main copies the session observation plus docker inspect, stack marker and forward records, then seals the admission in the read-only volume',
      'run: stream credentials and actual proxy vendor frames over stdin; no credentials in Docker env/argv or evidence',
      'Restore test-only vendor hooks and owned relays under the profile lease after completion',
    ],
    fixtureBoundary:
      'Only the existing vendor --import module in the actual Grok/Codex proxy processes; fixture results are not G8',
    sourceContext: [
      'desktop-app package/lock, production src/ui/assets, selected six subscription tests/helpers',
      'mcp-host package/lock and the exact local package dependency closure',
      'new runner/helpers plus existing vendor/challenge files; main-owned true HEAD/tree/blob manifest, no Git metadata',
      'No environment files, personal config, runtime logs, credentials or whole-repository COPY',
    ],
    missingJourneys: [
      'tool screenshot near 20 MiB',
      'authorized GFS image flow',
      'visible admission saturation and subsequent primary recovery',
    ],
    deadlineMs: 3_600_000,
  }
}

function sourceIdentity() {
  const filename = path.join(REPO_ROOT, 'subscription-image-source.json')
  const stat = fs.lstatSync(filename)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
    refuse('SOURCE_MANIFEST_BOUND')
  const raw = fs.readFileSync(filename)
  const manifest = JSON.parse(raw.toString('utf8'))
  verifySourceManifest(manifest, REPO_ROOT)
  return {
    gitHead: manifest.gitHead,
    gitTree: manifest.gitTree,
    inputManifestSha256: manifest.inputManifestSha256,
    manifestSha256: digest(raw),
  }
}

export function sealSourceManifest(repoRoot) {
  const inputBytes = fs.readFileSync(path.join(repoRoot, 'subscription-image-input-source.json'))
  const input = JSON.parse(inputBytes.toString('utf8'))
  const files = []
  const walk = relative => {
    const filename = path.join(repoRoot, relative),
      stat = fs.lstatSync(filename)
    if (stat.isSymbolicLink()) refuse('SOURCE_SYMLINK')
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(filename).sort()) walk(path.join(relative, name))
    } else if (stat.isFile())
      files.push({
        path: relative,
        bytes: stat.size,
        sha256: digest(fs.readFileSync(filename)),
      })
    else refuse('SOURCE_SPECIAL_FILE')
  }
  for (const relative of [
    'desktop-app/dist',
    'desktop-app/ui-dist',
    'desktop-app/test/e2e-playwright',
    'desktop-app/package.json',
    'desktop-app/package-lock.json',
    'mcp-host/package.json',
    'mcp-host/package-lock.json',
    'scripts/e2e/run-subscription-image-journeys.mjs',
    'scripts/e2e/fixtures',
    'scripts/tests/lib/subscription-image-runner-contract.mjs',
    'scripts/tests/lib/subscription-image-source-context.mjs',
    'subscription-image-input-source.json',
    'packages',
  ])
    walk(relative)
  const manifest = {
    kind: 'evenfire-subscription-image-source-v1',
    gitHead: input.gitHead,
    gitTree: input.gitTree,
    inputManifestSha256: digest(inputBytes),
    files,
  }
  verifySourceManifest(manifest, repoRoot)
  fs.writeFileSync(
    path.join(repoRoot, 'subscription-image-source.json'),
    JSON.stringify(manifest),
    { flag: 'wx', mode: 0o444 }
  )
}

function inspectPhysical(bindings) {
  const physical = observeLinuxRunner()
  const home = physical.observation.home
  const stat = fs.lstatSync(home)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== physical.observation.uid ||
    (stat.mode & 0o077) !== 0
  )
    refuse('PRIVATE_HOME_OWNERSHIP')
  const mountIds = verifyMountIsolation(physical.mounts, home, RUN_BASE, ADMISSION_ROOT)
  const isolation = inspectPrivateIsolation(
    bindings,
    physical.observation,
    process.env,
    RUN_BASE,
    mountIds
  )
  return { physical, isolation, source: sourceIdentity() }
}

async function loopbackRelay(target) {
  const endpoint = new URL(target)
  const sockets = new Set()
  // A fixed-target byte relay preserves HTTP bodies and RPC WebSocket
  // upgrades. It never treats a client request URL as a new proxy target.
  const server = net.createServer(socket => {
    const upstream = net.connect({
      host: endpoint.hostname.replace(/^\[|\]$/g, ''),
      port: Number(endpoint.port),
    })
    sockets.add(socket)
    sockets.add(upstream)
    for (const peer of [socket, upstream]) {
      peer.setTimeout(180_000, () => {
        socket.destroy()
        upstream.destroy()
      })
      peer.once('error', () => {
        socket.destroy()
        upstream.destroy()
      })
      peer.once('close', () => sockets.delete(peer))
    }
    socket.once('close', () => upstream.destroy())
    upstream.once('close', () => socket.destroy())
    socket.pipe(upstream)
    upstream.pipe(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new RunnerAdmissionError('LOOPBACK_RELAY_NOT_BOUND')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise(resolve => {
        for (const socket of sockets) socket.destroy()
        server.close(resolve)
      }),
  }
}

function inputFrames(admission, root) {
  let buffered = Buffer.alloc(0),
    receivedLogin = false
  const previous = new Map(admission.bindings.map(binding => [binding.provider, []]))
  const vendorReady = new Set()
  let resolveReady, rejectReady, rejectFailure
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const failure = new Promise((_resolve, reject) => {
    rejectFailure = reject
  })
  // Retain a handler immediately, including before the runner starts waiting.
  void failure.catch(() => {})
  const fail = err => {
    rejectReady(err)
    rejectFailure(err)
  }
  const timer = setTimeout(
    () => rejectReady(new RunnerAdmissionError('PRIVATE_INPUT_DEADLINE')),
    30_000
  )
  const accept = frame => {
    if (frame.kind === 'evenfire-subscription-image-login-v1') {
      if (
        receivedLogin ||
        frame.runId !== admission.runId ||
        typeof frame.email !== 'string' ||
        frame.email.length > 320 ||
        typeof frame.password !== 'string' ||
        !frame.password ||
        frame.password.length > 1024
      )
        refuse('PRIVATE_LOGIN_FRAME')
      // The authorized test login stays only in this process and the existing
      // visible-login fixture's child environment. Never persist or echo it.
      process.env.E2E_SUBSCRIPTION_IMAGE_LOGIN_EMAIL = frame.email
      process.env.E2E_SUBSCRIPTION_IMAGE_LOGIN_PASSWORD = frame.password
      receivedLogin = true
    } else {
      const binding = admission.bindings.find(candidate => candidate.provider === frame.provider)
      if (admission.mode !== 'fixture' || !binding) refuse('VENDOR_FRAME_NOT_AUTHORIZED')
      const source = admission.vendorSources?.[frame.provider]
      if (
        !source?.podUid ||
        !/^sha256:[a-f0-9]{64}$/.test(source.imageId) ||
        !/^[a-f0-9]{64}$/.test(source.fixtureImportSha256) ||
        source.profile !== admission.profile ||
        source.gitHead !== admission.gitHead
      )
        refuse('PHYSICAL_VENDOR_SOURCE_REQUIRED')
      const ledger = admitVendorFrame(
        frame,
        admission.runId,
        binding,
        source,
        previous.get(frame.provider)
      )
      const destination = path.join(root, `${frame.provider}-vendor.json`),
        temporary = `${destination}.next`
      fs.writeFileSync(temporary, JSON.stringify(ledger), {
        flag: 'wx',
        mode: 0o600,
      })
      fs.renameSync(temporary, destination)
      previous.set(frame.provider, ledger.attempts)
      vendorReady.add(frame.provider)
    }
    if (receivedLogin && (admission.mode === 'real' || vendorReady.size === 2)) {
      clearTimeout(timer)
      resolveReady()
    }
  }
  const onData = chunk => {
    try {
      if (buffered.length + chunk.length > MAX_FRAME_BYTES) refuse('PRIVATE_INPUT_FRAME_BOUND')
      buffered = Buffer.concat([buffered, chunk])
      for (let end; (end = buffered.indexOf(10)) !== -1; ) {
        const line = buffered.subarray(0, end)
        buffered = buffered.subarray(end + 1)
        if (!line.length) refuse('PRIVATE_INPUT_FRAME_EMPTY')
        try {
          accept(JSON.parse(line.toString('utf8')))
        } finally {
          line.fill(0)
        }
      }
    } catch (err) {
      fail(err)
      process.stdin.pause()
    }
  }
  process.stdin.on('data', onData)
  const onEnd = () => {
    if (!receivedLogin || admission.mode === 'fixture')
      fail(new RunnerAdmissionError('PRIVATE_INPUT_ENDED'))
  }
  process.stdin.once('end', onEnd)
  const onError = () => fail(new RunnerAdmissionError('PRIVATE_INPUT_FAILED'))
  process.stdin.once('error', onError)
  return {
    ready,
    failure,
    close: () => {
      clearTimeout(timer)
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('error', onError)
      process.stdin.pause()
      buffered.fill(0)
    },
  }
}

async function prepare(admissionFile) {
  process.umask(0o077)
  const mainRecord = readMainRecord(admissionFile)
  const admission = mainRecord.value
  const inspected = inspectPhysical(admission.isolation)
  const receipts = {
    inspect: readMainRecord(path.join(ADMISSION_ROOT, MAIN_RECEIPT_FILES.inspect)),
    stack: readMainRecord(path.join(ADMISSION_ROOT, MAIN_RECEIPT_FILES.stack)),
    portForwards: readMainRecord(path.join(ADMISSION_ROOT, MAIN_RECEIPT_FILES.portForwards)),
  }
  const volumeManifest = readMainRecord(path.join(ADMISSION_ROOT, VOLUME_MANIFEST_FILE)).value
  if (
    volumeManifest?.kind !== 'evenfire-subscription-image-volume-manifest-v1' ||
    !Array.isArray(volumeManifest.manifest) ||
    volumeManifest.manifest.length !== 4
  )
    refuse('ADMISSION_VOLUME_MANIFEST')
  for (const row of volumeManifest.manifest) {
    const record = readMainRecord(path.join(ADMISSION_ROOT, row.name))
    if (record.sha256 !== row.sha256 || fs.statSync(path.join(ADMISSION_ROOT, row.name)).size !== row.bytes)
      refuse('ADMISSION_VOLUME_MANIFEST_MISMATCH')
  }
  verifyMainAdmission(
    admission,
    inspected.physical,
    inspected.source,
    REPO_ROOT,
    process.env,
    'admit',
    receipts
  )
  verifySealedArtifacts(admission)
  const suite = resolveSuite(admission.suiteId)
  const root = path.join(RUN_BASE, admission.runId)
  fs.writeFileSync(path.join(RUN_BASE, 'runner-created'), admission.runId, {
    flag: 'wx',
    mode: 0o600,
  })
  fs.mkdirSync(root, { mode: 0o700 })
  const rest = await loopbackRelay(admission.transports.rest.origin)
  let rpc, channel
  try {
    rpc = await loopbackRelay(admission.transports.rpc.origin)
    /** @type {NodeJS.ProcessEnv} */
    const env = {}
    for (const name of [
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'LANG',
      'LC_ALL',
      'DISPLAY',
      'DBUS_SESSION_BUS_ADDRESS',
      'XAUTHORITY',
      'XDG_RUNTIME_DIR',
      'XDG_CONFIG_HOME',
      'XDG_CACHE_HOME',
      'XDG_DATA_HOME',
      'TMPDIR',
      'GROK_REAL_UPSTREAM_CONFIRM',
      'CODEX_REAL_UPSTREAM_CONFIRM',
      'SUBSCRIPTION_IMAGE_FIXTURE_CONFIRM',
    ]) {
      if (process.env[name]) env[name] = process.env[name]
    }
    Object.assign(env, {
      E2E_SUBSCRIPTION_IMAGE_INPUT: '1',
      E2E_SUBSCRIPTION_IMAGE_MODE: admission.mode,
      E2E_SUBSCRIPTION_IMAGE_RUN_ID: admission.runId,
      E2E_SUBSCRIPTION_IMAGE_SUITE: admission.suiteId,
      MINIKUBE_PROFILE: admission.profile,
      CONTROL_API_REAL_PG_CONTEXT: admission.context,
      SUBSCRIPTION_IMAGE_RUN_ROOT: root,
      SUBSCRIPTION_IMAGE_RUNNER_RECEIPT: path.join(root, 'runner.json'),
      EXTERNAL_REST_API_BASE_URL: rest.url,
      RPC_PROXY_BASE_URL: rpc.url,
    })
    for (const binding of admission.bindings) {
      const prefix = binding.provider === 'grok-subscription' ? 'GROK' : 'CODEX'
      for (const [field, suffix] of [
        ['hostRef', 'HOST_REF'],
        ['hostLabel', 'HOST_LABEL'],
        ['modelId', 'MODEL'],
        ['modelLabel', 'MODEL_LABEL'],
        ['unsupportedModelId', 'UNSUPPORTED_MODEL'],
        ['unsupportedModelLabel', 'UNSUPPORTED_MODEL_LABEL'],
      ])
        env[`E2E_${prefix}_IMAGE_${suffix}`] = binding[field]
      if (admission.mode === 'fixture')
        env[`E2E_${prefix}_IMAGE_EVIDENCE_PATH`] = path.join(
          root,
          `${binding.provider}-vendor.json`
        )
    }
    channel = inputFrames(admission, root)
    await channel.ready
    env.E2E_SUBSCRIPTION_IMAGE_LOGIN_EMAIL = process.env.E2E_SUBSCRIPTION_IMAGE_LOGIN_EMAIL
    env.E2E_SUBSCRIPTION_IMAGE_LOGIN_PASSWORD = process.env.E2E_SUBSCRIPTION_IMAGE_LOGIN_PASSWORD
    const contract = await import(
      pathToFileURL(
        path.join(REPO_ROOT, 'desktop-app/test/e2e-playwright/subscriptionImageRunContract.ts')
      ).href
    )
    const run = contract.requireSubscriptionImageRun(env)
    const desktopRequire = createRequire(path.join(REPO_ROOT, 'desktop-app/package.json'))
    const electronPath = desktopRequire('electron')
    if (typeof electronPath !== 'string' || !fs.statSync(electronPath).isFile())
      refuse('LINUX_ELECTRON_REQUIRED')
    const fd = fs.openSync(electronPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const magic = Buffer.alloc(4)
      if (fs.readSync(fd, magic, 0, 4, 0) !== 4 || magic.toString('hex') !== '7f454c46')
        refuse('LINUX_ELECTRON_REQUIRED')
    } finally {
      fs.closeSync(fd)
    }
    createRequire(path.join(REPO_ROOT, 'scripts/e2e/fixtures/subscription-image-challenge.cjs'))(
      './subscription-image-challenge.cjs'
    ).requirePixelRenderer()
    verifyNativePrivateKeychain(REPO_ROOT, env)
    const physical = observeLinuxRunner()
    const mountIds = verifyMountIsolation(
      physical.mounts,
      physical.observation.home,
      RUN_BASE,
      ADMISSION_ROOT
    )
    const isolation = observePrivateIsolation(
      admission.isolation,
      physical.observation,
      env,
      root,
      mountIds
    )
    privateJson(run.runnerReceipt, {
      kind: 'evenfire-subscription-image-runner-v2',
      runId: run.runId,
      repoRoot: REPO_ROOT,
      gitHead: inspected.source.gitHead,
      gitTree: inspected.source.gitTree,
      inputManifestSha256: inspected.source.inputManifestSha256,
      profile: run.profile,
      context: run.context,
      restUrl: run.restUrl,
      rpcUrl: run.rpcUrl,
      bindings: run.bindings,
      observation: physical.observation,
      isolation,
      mainAdmissionFile: admissionFile,
      mainAdmissionSha256: mainRecord.sha256,
      admittedAt: new Date().toISOString(),
      sourceManifestSha256: inspected.source.manifestSha256,
      mode: run.mode,
      suiteId: run.suiteId,
    })
    return {
      run,
      suite,
      env,
      root,
      desktopRequire,
      inputFailure: channel.failure,
      close: async () => {
        channel.close()
        await Promise.all([rest.close(), rpc.close()])
      },
    }
  } catch (err) {
    channel?.close()
    await Promise.all([rest.close(), rpc?.close()])
    throw err
  }
}

async function runJourneys(prepared) {
  const cli = prepared.desktopRequire.resolve('@playwright/test/cli')
  const child = spawn(
    process.execPath,
    [
      cli,
      'test',
      `--config=${prepared.suite.configFile}`,
      '--reporter=json',
    ],
    {
      cwd: path.join(REPO_ROOT, 'desktop-app'),
      env: prepared.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  // Do not persist raw child diagnostics, trace contents, credentials or image
  // bodies. Artifacts remain in this private tmpfs until main reviews export.
  const hashes = { stdout: createHash('sha256'), stderr: createHash('sha256') }
  const reportChunks = []
  let reportBytes = 0
  child.stdout.on('data', value => {
    hashes.stdout.update(value)
    reportBytes += value.length
    if (reportBytes <= 16 * 1024 * 1024) reportChunks.push(value)
    else stop('report-bound')
  })
  child.stderr.on('data', value => hashes.stderr.update(value))
  let cancellationCause
  let hardStop
  const terminate = signal => {
    if (Number.isInteger(child.pid) && child.exitCode === null) {
      try {
        process.kill(-child.pid, signal)
      } catch (err) {
        if (err.code !== 'ESRCH') throw err
      }
    }
  }
  const stop = cause => {
    if (cancellationCause) return
    cancellationCause = cause
    terminate('SIGTERM')
    hardStop = setTimeout(() => terminate('SIGKILL'), 10_000)
  }
  const signalStop = () => stop('signal')
  process.once('SIGTERM', signalStop)
  process.once('SIGINT', signalStop)
  let inputFailed = false
  void prepared.inputFailure.catch(() => {
    inputFailed = true
    stop('input')
  })
  const deadline = setTimeout(() => stop('deadline'), runnerPlan().deadlineMs)
  let result
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
  } finally {
    clearTimeout(deadline)
    clearTimeout(hardStop)
    process.off('SIGTERM', signalStop)
    process.off('SIGINT', signalStop)
  }
  let namedCases, reportFailure
  try {
    namedCases = verifySuiteReport(
      JSON.parse(Buffer.concat(reportChunks).toString('utf8')),
      prepared.run.mode,
      prepared.suite,
      path.join(REPO_ROOT, prepared.suite.specFile)
    )
  } catch (err) {
    reportFailure = err instanceof RunnerAdmissionError ? err.code : 'JOURNEY_REPORT_INVALID'
  }
  // Only case identities/status and digests leave memory; reporter diagnostics
  // may contain auth details and are never copied into the receipt.
  privateJson(path.join(prepared.root, 'journey-result.json'), {
    kind: 'evenfire-subscription-image-result-v1',
    runId: prepared.run.runId,
    suiteId: prepared.suite.suiteId,
    mode: prepared.run.mode,
    producerExit: result.code,
    signal: result.signal,
    cancellationCause,
    inputFailed,
    stdoutSha256: hashes.stdout.digest('hex'),
    stderrSha256: hashes.stderr.digest('hex'),
    namedCases,
    reportFailure,
    evidenceClass:
      prepared.run.mode === 'fixture' ? 'external-vendor-fixture' : 'real-subscription',
  })
  return result.code === 0 && !cancellationCause && !inputFailed && !reportFailure ? 0 : 1
}

async function runAdmission(input) {
  const prepared = await prepare(input)
  try {
    console.log(
      JSON.stringify({
        kind: 'runner-admitted',
        runId: prepared.run.runId,
        mode: prepared.run.mode,
        suiteId: prepared.suite.suiteId,
        receipt: prepared.run.runnerReceipt,
      })
    )
    return await runJourneys(prepared)
  } finally {
    await prepared.close()
  }
}

// Prep phase of the per-run named volume. Reads the four main-sealed JSON files
// as base64 NDJSON on stdin (host originals stay 0600 on the host) and writes
// them 0600 owned by the container user, then exits. The run container mounts
// the same volume read-only.
async function admissionWrite() {
  process.umask(0o077)
  const expected = ['main-admission.json', ...Object.values(MAIN_RECEIPT_FILES)]
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 4 * 1024 * 1024) refuse('ADMISSION_WRITE_BOUND')
    chunks.push(chunk)
  }
  const lines = Buffer.concat(chunks)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
  if (lines.length !== expected.length) refuse('ADMISSION_WRITE_FRAMES')
  const manifest = []
  for (const line of lines) {
    const frame = JSON.parse(line)
    if (!expected.includes(frame.name)) refuse('ADMISSION_WRITE_NAME')
    const payload = Buffer.from(frame.contentsBase64, 'base64')
    fs.writeFileSync(path.join(ADMISSION_ROOT, frame.name), payload, { flag: 'wx', mode: 0o600 })
    manifest.push({ name: frame.name, sha256: digest(payload), bytes: payload.length })
  }
  fs.writeFileSync(
    path.join(ADMISSION_ROOT, VOLUME_MANIFEST_FILE),
    JSON.stringify({ kind: 'evenfire-subscription-image-volume-manifest-v1', manifest }),
    { flag: 'wx', mode: 0o600 }
  )
  console.log(JSON.stringify({ kind: 'runner-admission-written', manifest }))
  return 0
}

async function waitForMainAdmission(admissionFile) {
  const deadline = Date.now() + SESSION_ADMISSION_DEADLINE_MS
  let interrupted = false
  const onSignal = () => {
    interrupted = true
  }
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  try {
    for (;;) {
      if (interrupted) refuse('RUNNER_INTERRUPTED')
      if (fs.existsSync(admissionFile)) return
      if (Date.now() > deadline) refuse('MAIN_ADMISSION_TIMEOUT')
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  } finally {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
  }
}

// Inspected bootstrap: create the private session, publish its physical
// observation for main, then wait for the sealed admission before launching.
async function bootstrap(admissionFile) {
  process.umask(0o077)
  const runId = process.env.SUBSCRIPTION_IMAGE_RUN_ID
  if (!/^subscription-image-[a-f0-9]{12}$/.test(runId ?? ''))
    refuse('SUBSCRIPTION_IMAGE_RUN_ID_REQUIRED')
  if (fs.existsSync(path.join(RUN_BASE, SESSION_READY_MARKER)))
    refuse('SESSION_ALREADY_BOOTSTRAPPED')
  const initial = observeLinuxRunner()
  const home = initial.observation.home
  const desktopRequire = createRequire(path.join(REPO_ROOT, 'desktop-app/package.json'))
  privateJson(path.join(RUN_BASE, SESSION_READY_MARKER), runId)
  const session = await startPrivateSession({ home, repoRoot: REPO_ROOT, desktopRequire })
  for (const [name, value] of Object.entries(session.env)) process.env[name] = value
  const physical = observeLinuxRunner()
  const mountIds = verifyMountIsolation(physical.mounts, home, RUN_BASE, ADMISSION_ROOT)
  const isolation = observePrivateIsolation(
    session.expected,
    physical.observation,
    process.env,
    RUN_BASE,
    mountIds
  )
  const observationFile = path.join(RUN_BASE, SESSION_OBSERVATION_FILE)
  privateJson(observationFile, {
    kind: 'evenfire-subscription-image-session-observation-v1',
    runId,
    observation: physical.observation,
    networkNamespace: physical.networkNamespace,
    ipcNamespace: physical.ipcNamespace,
    isolation,
    source: sourceIdentity(),
    startedAt: new Date().toISOString(),
  })
  console.log(JSON.stringify({ kind: 'runner-session-ready', output: observationFile }))
  try {
    await waitForMainAdmission(admissionFile)
    session.assertAlive()
    return await runAdmission(admissionFile)
  } catch (err) {
    session.stop()
    throw err
  }
}

export async function main(args = process.argv.slice(2)) {
  const [mode = 'run', input] = args
  if (args.length > 2) refuse('RUNNER_ARGUMENTS')
  if (mode === 'plan') {
    console.log(JSON.stringify(runnerPlan(), null, 2))
    return 0
  }
  if (mode === 'admission-write') {
    if (input) refuse('RUNNER_ARGUMENTS')
    return admissionWrite()
  }
  if (!['bootstrap', 'inspect', 'run'].includes(mode) || !input || !path.isAbsolute(input))
    refuse('RUNNER_ARGUMENTS')
  if (path.dirname(input) !== ADMISSION_ROOT) refuse('MAIN_ADMISSION_PATH')
  if (mode === 'inspect') {
    observeLinuxRunner()
    const inspected = inspectPhysical(readPrivateJson(input))
    const output = path.join(RUN_BASE, 'physical-inspection.json')
    privateJson(output, {
      kind: 'evenfire-subscription-image-inspection-v1',
      ...inspected,
    })
    console.log(JSON.stringify({ kind: 'runner-inspected', output }))
    return 0
  }
  if (mode === 'bootstrap') return bootstrap(input)
  return runAdmission(input)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(code => {
      process.exitCode = code
    })
    .catch(err => {
      console.error(
        JSON.stringify({
          kind: 'runner-refused',
          code: err instanceof RunnerAdmissionError ? err.code : 'RUNNER_OPERATION_FAILED',
        })
      )
      process.exitCode = 1
    })
}
