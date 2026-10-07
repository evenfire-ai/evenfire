// Protocol tests use actual Node stdin and native PNG/JPEG assets. Unit pod
// metadata never reaches a cluster and is not browser or G8 evidence.
// E2E_GUARDIAN_IPC_FLOW: private frame admission and materialization only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inputFrames, sealSourceManifest } from '../e2e/run-subscription-image-journeys.mjs'
import { buildRemainingFixtureFrame, createRemainingPixelAssets, remainingAssetPath } from '../e2e/prepare-subscription-remaining-fixtures.mjs'
import { DECODER_TIMEOUT_MS, decodeInChild } from '../e2e/fixtures/subscription-image-decoder.mjs'
import { digest, expectedJourneyNames, resolveSuite } from './lib/subscription-image-runner-contract.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
const privateRoot = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-input-unit-')))
  fs.chmodSync(root, 0o700)
  return root
}
function unitAdmission(suiteId = 'subscription-image-input', mode = 'fixture') {
  const admission = {
    runId: 'subscription-image-123456789abc', mode, suiteId,
    profile: 'qa-owned-unit', context: 'qa-owned-unit', gitHead: 'a'.repeat(40),
    sourceManifestSha256: 'b'.repeat(64),
    bindings: ['grok', 'codex'].map(kind => ({ provider: `${kind}-subscription`,
      hostRef: `qa-${kind}`, hostLabel: `QA ${kind}`, modelId: `${kind}-image`,
      modelLabel: `${kind} Image`, unsupportedModelId: `${kind}-text` })),
  }
  admission.vendorSources = Object.fromEntries(admission.bindings.map((binding, index) =>
    [binding.provider, { profile: admission.profile, gitHead: admission.gitHead,
      podUid: uuid(index + 1), imageId: `sha256:${'c'.repeat(64)}`,
      fixtureImportSha256: 'd'.repeat(64) }]))
  return admission
}
// Random throwaway values test in-memory delivery without using a real account.
const UNIT_LOGIN_EMAIL = `${randomUUID()}@example.invalid`
const UNIT_LOGIN_VALUE = randomUUID()
const login = admission => ({ kind: 'evenfire-subscription-image-login-v1',
  runId: admission.runId, email: UNIT_LOGIN_EMAIL, password: UNIT_LOGIN_VALUE })
const vendor = (admission, binding, attempts = []) => ({
  kind: 'evenfire-subscription-image-vendor-frame-v1', runId: admission.runId,
  provider: binding.provider, source: admission.vendorSources[binding.provider],
  ledger: { kind: 'evenfire-subscription-image-vendor-v1', runId: admission.runId, attempts },
})
const initialFrames = admission => [login(admission), ...admission.bindings.map(binding => vendor(admission, binding))]
const ndjson = frames => Buffer.from(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n')

async function remainingFrame(admission, root) {
  const assets = createRemainingPixelAssets({ admission, runRoot: root })
  const fixtures = Object.fromEntries(admission.bindings.map((binding, index) => {
    const identity = { hostRef: binding.hostRef, podUid: uuid(index + 1), imageId: `sha256:${'c'.repeat(64)}` }
    const selected = assets.filter(asset => asset.provider === binding.provider)
    if (admission.suiteId === 'tool-screenshot') {
      const asset = selected[0]
      return [binding.provider, { ...identity, hostImagePath: `/tmp/evenfire-qa-screen-${uuid(index + 3)}.png`,
        fixtureImagePath: remainingAssetPath(root, admission.suiteId, asset.name), imageSha256: asset.sha256,
        region: { x: 0, y: 0, w: 512, h: 512 } }]
    }
    if (admission.suiteId === 'gfs-image') return [binding.provider, { ...identity, folderNames: ['QA protocol images'],
      files: selected.map((asset, assetIndex) => {
        const pickerResourceId = uuid(index * 10 + assetIndex + 11)
        const resourceId = pickerResourceId.replaceAll('-', '')
        return { name: asset.name, drive: 'main', pickerResourceId, resourceId, version: 1,
          gfsUri: `gfs://main/${resourceId}`, mimeType: asset.mimeType,
          sizeBytes: Buffer.from(asset.contentsBase64, 'base64').length,
          fixtureImagePath: remainingAssetPath(root, admission.suiteId, asset.name), imageSha256: asset.sha256,
          width: 512, height: 512 }
      }) }]
    // commandDeadlineMs = max(read, work + closeGrace + 5000) + 5000 for the
    // compiled companion policy; the eligible fallback is a same-provider alternate.
    return [binding.provider, { ...identity, controlApiPodUid: uuid(40), controlApiImageId: `sha256:${'e'.repeat(64)}`,
      maxInFlight: 2, readDeadlineMs: 500,
      pressure: { receiptFile: '/runner-admission/pressure-metadata.json',
        workDeadlineMs: 1000, closeGraceMs: 250, commandDeadlineMs: 11250 },
      fallback: { provider: binding.provider, modelId: `${binding.modelId}-alternate` } }]
  }))
  return buildRemainingFixtureFrame({ admission, runRoot: root, fixtures, assets })
}

function unexpectedReceiverStderr(value) {
  // Node 24 reparses this pure TS fixture contract as ESM. Admit only this
  // exact known warning block; all other warnings/diagnostics remain failures.
  const contract = pathToFileURL(path.join(repoRoot, 'desktop-app/test/e2e-playwright/subscriptionRemainingJourneysContract.ts')).href
  const warning = [
    `[MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of ${contract} is not specified and it doesn't parse as CommonJS.`,
    'Reparsing as ES module because module syntax was detected. This incurs a performance overhead.',
    `To eliminate this warning, add "type": "module" to ${path.join(repoRoot, 'desktop-app/package.json')}.`,
    '(Use `node --trace-warnings ...` to show where the warning was created)',
    '',
  ].join('\n')
  const escaped = warning.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return value.replace(new RegExp(`\\(node:[0-9]+\\) ${escaped}`, 'g'), '')
}

// The runner's own inputFrames default. A shorter window lets the admission
// deadline race the native decoder on slow CI runners, so a decode-failure
// case can surface as PRIVATE_INPUT_DEADLINE instead of its real cause.
const RUNNER_INPUT_DEADLINE_MS = 30_000

async function nativeReceiver(t, admission, root, deadlineMs = RUNNER_INPUT_DEADLINE_MS) {
  const runner = pathToFileURL(path.join(repoRoot, 'scripts/e2e/run-subscription-image-journeys.mjs')).href
  // The child uses the actual runner receiver. IPC only controls unit lifecycle
  // and probes; all admitted frames cross the native stdin pipe.
  const code = `
    import fs from 'node:fs';
    import { inputFrames } from ${JSON.stringify(runner)};
    const loginEnv = {}, channel = inputFrames(${JSON.stringify(admission)}, ${JSON.stringify(root)},
      { loginEnv, deadlineMs: ${deadlineMs} });
    let ready = false;
    const emit = value => console.log(JSON.stringify(value));
    channel.ready.then(env => { ready = true; emit({ kind: 'ready', env }); }).catch(() => {});
    channel.failure.catch(error => {
      emit({ kind: 'failed', code: error.code ?? error.message });
      channel.close(); process.stdin.destroy(); process.disconnect(); process.exitCode = 1;
    });
    process.on('message', message => {
      if (message === 'probe') emit({ kind: 'probe', ready, inputEnded: process.stdin.readableEnded,
        vendors: ['grok-subscription', 'codex-subscription'].map(provider => {
          const filename = ${JSON.stringify(root)} + '/' + provider + '-vendor.json';
          return fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')).attempts.length : null;
        }) });
      if (message === 'finish') {
        channel.assertHealthy();
        if (!ready) throw Error('UNIT_RECEIVER_NOT_READY');
        channel.close(); process.stdin.destroy(); process.disconnect(); process.exitCode = 0;
      }
    });
    emit({ kind: 'listening' });
  `
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'], timeout: 15_000,
    env: { PATH: path.dirname(process.execPath) },
  })
  const events = [], waiters = []
  let stdout = '', stderr = '', closed = false, exitResult
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (producerExit, signal) => {
      closed = true
      exitResult = { producerExit, signal, stderr }
      resolve(exitResult)
      for (const notify of [...waiters]) notify()
    })
  })
  child.stdin.on('error', () => {})
  child.stderr.on('data', chunk => { stderr += chunk; assert.ok(stderr.length < 64 * 1024) })
  child.stdout.on('data', chunk => {
    stdout += chunk
    assert.ok(stdout.length < 64 * 1024)
    for (let end; (end = stdout.indexOf('\n')) !== -1;) {
      events.push(JSON.parse(stdout.slice(0, end)))
      stdout = stdout.slice(end + 1)
      for (const notify of [...waiters]) notify()
    }
  })
  const next = (kind, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); reject(Error(`UNIT_RECEIVER_${kind}_TIMEOUT`)) }, timeoutMs)
    const check = () => {
      const index = events.findIndex(value => value.kind === kind)
      if (index < 0 && !closed) return
      clearTimeout(timer)
      const queued = waiters.indexOf(check)
      if (queued >= 0) waiters.splice(queued, 1)
      if (index >= 0) resolve(events.splice(index, 1)[0])
      else reject(Error(`UNIT_RECEIVER_EXIT_BEFORE_${kind}: exit=${exitResult.producerExit}, signal=${exitResult.signal}`))
    }
    waiters.push(check); check()
  })
  const probeUntil = async predicate => {
    const deadline = Date.now() + 5_000
    for (let probes = 0; probes < 128 && Date.now() <= deadline; probes++) {
      child.send('probe')
      const state = await next('probe')
      if (predicate(state)) return state
      // Yield to actual IPC/stdin events; no clock delay is used as readiness.
      await new Promise(resolve => setImmediate(resolve))
    }
    throw Error('UNIT_RECEIVER_STATE_DEADLINE')
  }
  t.after(async () => {
    if (!closed) child.kill('SIGTERM')
    await completion
  })
  await next('listening')
  return { child, events, next, completion, probeUntil,
    send: frames => child.stdin.write(ndjson(frames)),
    finish: async () => {
      child.send('finish')
      const result = await completion
      assert.equal(result.producerExit, 0)
      assert.equal(result.signal, null)
      assert.equal(unexpectedReceiverStderr(result.stderr), '')
    } }
}

for (const suiteId of ['tool-screenshot', 'gfs-image', 'admission-recovery']) {
  test(`native stdin accepts ${suiteId} before returning its exact suite opt-in and private receipt`, async t => {
    const root = privateRoot(), admission = unitAdmission(suiteId)
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const frame = await remainingFrame(admission, root), receiver = await nativeReceiver(t, admission, root)
    const inputs = initialFrames(admission)
    receiver.send([...inputs, frame])
    const ready = await receiver.next('ready'), suite = resolveSuite(suiteId)
    const receiptPath = path.join(root, `remaining-${suiteId}.json`)
    assert.deepEqual(ready.env, { [suite.optInEnv]: '1', [suite.fixtureReceiptEnv]: receiptPath })
    assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.join(root, `remaining-${suiteId}`)).mode & 0o777, 0o700)
    for (const asset of frame.assets) {
      const filename = remainingAssetPath(root, suiteId, asset.name)
      assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
      assert.equal(digest(fs.readFileSync(filename)), asset.sha256)
    }
    for (const filename of fs.readdirSync(root).filter(name => name.endsWith('.json'))) {
      const contents = fs.readFileSync(path.join(root, filename), 'utf8')
      assert.equal(contents.includes(inputs[0].email), false)
      assert.equal(contents.includes(inputs[0].password), false)
    }
    await receiver.finish()
  })
}

test('native stdin waits for a delayed remaining fixture after both vendor frames and login are accepted', async t => {
  const root = privateRoot(), admission = unitAdmission('gfs-image')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const frame = await remainingFrame(admission, root), receiver = await nativeReceiver(t, admission, root)
  receiver.send(initialFrames(admission))
  assert.deepEqual(await receiver.probeUntil(state => state.vendors.every(count => count === 0)),
    { kind: 'probe', ready: false, inputEnded: false, vendors: [0, 0] })
  receiver.send([frame]); await receiver.next('ready'); await receiver.finish()
})

test('native async decode failure never becomes ready and cannot publish a preparation receipt', async t => {
  const root = privateRoot(), admission = unitAdmission('gfs-image')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const frame = await remainingFrame(admission, root), receiver = await nativeReceiver(t, admission, root)
  const asset = frame.assets[1], valid = Buffer.from(asset.contentsBase64, 'base64'), corrupt = Buffer.alloc(valid.length)
  valid.copy(corrupt, 0, 0, 3)
  valid.copy(corrupt, corrupt.length - 2, valid.length - 2)
  asset.contentsBase64 = corrupt.toString('base64'); asset.sha256 = digest(corrupt)
  frame.receipt.fixtures[asset.provider].files.find(file => file.name === asset.name).imageSha256 = asset.sha256
  receiver.send([...initialFrames(admission), frame])
  // A corrupt image may fail at once or run until the decoder kills its child
  // at DECODER_TIMEOUT_MS; both end as "image decoder exited". The wait must
  // outlast that bound or the harness timeout wins the race on slow runners.
  assert.match((await receiver.next('failed', DECODER_TIMEOUT_MS + 10_000)).code, /image decoder exited/)
  assert.equal(receiver.events.some(value => value.kind === 'ready'), false)
  assert.equal(fs.existsSync(path.join(root, 'remaining-gfs-image.json')), false)
  assert.equal(fs.existsSync(path.join(root, 'remaining-gfs-image')), false)
  assert.equal((await receiver.completion).producerExit, 1)
  // The same parent process must survive malformed native decoding and then
  // decode real pixels. Recovery cannot be inferred from a rejection alone.
  const parentPid = process.pid
  await assert.rejects(decodeInChild(corrupt), /image decoder exited/)
  const decoded = await decodeInChild(valid)
  assert.equal(process.pid, parentPid)
  assert.equal(decoded.width, 512)
  assert.equal(decoded.height, 512)
  assert.match(decoded.code, /^[A-F0-9]{16}$/)
})

test('serial async draining rejects a duplicate fixture queued behind valid native preparation before ready', async () => {
  const root = privateRoot(), admission = unitAdmission('tool-screenshot'), input = new PassThrough()
  const channel = inputFrames(admission, root, { input, loginEnv: {} })
  try {
    const frame = await remainingFrame(admission, root)
    input.write(ndjson([...initialFrames(admission), frame, frame]))
    await assert.rejects(channel.ready, /REMAINING_FIXTURE_NOT_AUTHORIZED/)
    await assert.rejects(channel.failure, /REMAINING_FIXTURE_NOT_AUTHORIZED/)
    assert.throws(channel.assertHealthy, /REMAINING_FIXTURE_NOT_AUTHORIZED/)
    assert.equal(fs.existsSync(path.join(root, 'remaining-tool-screenshot.json')), true)
  } finally { channel.close(); input.destroy(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('native stream retains validated append-only vendor frames and rejects a changed accepted history', async t => {
  const root = privateRoot(), admission = unitAdmission()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const receiver = await nativeReceiver(t, admission, root)
  receiver.send(initialFrames(admission))
  assert.deepEqual((await receiver.next('ready')).env, {})
  const binding = admission.bindings[0], row = { sequence: 1, provider: binding.provider, model: binding.modelId,
    receiptId: uuid(50), imageSha256: [], mimeTypes: [], requestSha256: 'f'.repeat(64), responseKind: 'text' }
  const filename = path.join(root, `${binding.provider}-vendor.json`)
  receiver.send([vendor(admission, binding, [row])])
  assert.deepEqual(await receiver.probeUntil(state => state.vendors[0] === 1),
    { kind: 'probe', ready: true, inputEnded: false, vendors: [1, 0] })
  receiver.send([vendor(admission, binding, [{ ...row, requestSha256: 'e'.repeat(64) }])])
  assert.equal((await receiver.next('failed')).code, 'VENDOR_EVIDENCE_HISTORY_CHANGED')
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')).attempts, [row])
  assert.equal((await receiver.completion).producerExit, 1)
})

test('native fixture EOF after readiness remains an input failure; real composer login may end cleanly', async t => {
  for (const mode of ['fixture', 'real']) {
    const root = privateRoot(), admission = unitAdmission('subscription-image-input', mode)
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const receiver = await nativeReceiver(t, admission, root)
    receiver.send(mode === 'fixture' ? initialFrames(admission) : [login(admission)])
    await receiver.next('ready')
    receiver.child.stdin.end()
    if (mode === 'fixture') {
      assert.equal((await receiver.next('failed')).code, 'PRIVATE_INPUT_ENDED')
      assert.equal((await receiver.completion).producerExit, 1)
    } else {
      await receiver.probeUntil(state => state.inputEnded)
      await receiver.finish()
    }
  }
})

test('native dropped stdin, malformed input and admission deadline fail instead of leaving readiness pending', async t => {
  for (const control of ['drop', 'malformed', 'deadline']) {
    const root = privateRoot(), admission = unitAdmission('tool-screenshot')
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const receiver = await nativeReceiver(t, admission, root, control === 'deadline' ? 75 : RUNNER_INPUT_DEADLINE_MS)
    if (control === 'drop') receiver.child.stdin.end()
    if (control === 'malformed') receiver.child.stdin.write('{invalid}\n')
    const failure = await receiver.next('failed')
    assert.match(failure.code, control === 'drop' ? /PRIVATE_INPUT_ENDED/ : control === 'deadline' ? /PRIVATE_INPUT_DEADLINE/ : /JSON/)
    assert.equal(receiver.events.some(value => value.kind === 'ready'), false)
    assert.equal((await receiver.completion).producerExit, 1)
  }
})

test('a readable error or unexpected close rejects both readiness and ongoing input health', async () => {
  for (const control of ['error', 'close']) {
    const root = privateRoot(), input = new PassThrough()
    const channel = inputFrames(unitAdmission('gfs-image'), root, { input, loginEnv: {} })
    try {
      input.destroy(control === 'error' ? new Error('Unit transport interruption') : undefined)
      const code = control === 'error' ? 'PRIVATE_INPUT_FAILED' : 'PRIVATE_INPUT_ENDED'
      await assert.rejects(channel.ready, error => error.code === code)
      await assert.rejects(channel.failure, error => error.code === code)
      assert.throws(channel.assertHealthy, error => error.code === code)
      assert.deepEqual(fs.readdirSync(root), [])
    } finally { channel.close(); fs.rmSync(root, { recursive: true, force: true }) }
  }
})

test('private receiver bounds a single frame, queued bytes and queued frames before accepting them', async () => {
  const admission = unitAdmission(), binding = admission.bindings[0]
  for (const [bytes, code] of [
    [Buffer.alloc(8 * 1024 * 1024 + 1, 32), 'PRIVATE_INPUT_FRAME_BOUND'],
    [Buffer.alloc(16 * 1024 * 1024 + 1, 32), 'PRIVATE_INPUT_PENDING_BYTES_BOUND'],
    [ndjson(Array.from({ length: 33 }, () => vendor(admission, binding))), 'PRIVATE_INPUT_PENDING_FRAMES_BOUND'],
  ]) {
    const root = privateRoot(), input = new PassThrough(), channel = inputFrames(admission, root, { input, loginEnv: {} })
    try {
      input.write(bytes)
      await assert.rejects(channel.ready, error => error.code === code)
      await assert.rejects(channel.failure, error => error.code === code)
      assert.deepEqual(fs.readdirSync(root), [])
    } finally { channel.close(); input.destroy(); fs.rmSync(root, { recursive: true, force: true }) }
  }
})

test('remaining fixtures cannot activate the composer inventory or a real preparation lane', async () => {
  for (const admission of [unitAdmission(), unitAdmission('tool-screenshot', 'real')]) {
    const root = privateRoot(), input = new PassThrough(), channel = inputFrames(admission, root, { input, loginEnv: {} })
    try {
      const fixtureAdmission = { ...admission, suiteId: 'tool-screenshot', mode: 'fixture' }
      const frame = await remainingFrame(fixtureAdmission, root)
      input.write(ndjson([frame]))
      await assert.rejects(channel.ready, admission.mode === 'real' ? /REQUIRES_OPERATOR/ : /NOT_AUTHORIZED/)
      assert.deepEqual(fs.readdirSync(root), [])
    } finally { channel.close(); input.destroy(); fs.rmSync(root, { recursive: true, force: true }) }
  }
  assert.equal(expectedJourneyNames('fixture').length, 14)
  assert.equal(expectedJourneyNames('real').length, 15)
})

test('sealing the exact runner source includes all four preparation helpers and refuses an omitted helper', () => {
  const helpers = ['prepare-subscription-remaining-fixtures.mjs', 'prepare-subscription-remaining-fixtures.gfs.mjs',
    'prepare-subscription-remaining-fixtures.runtime.mjs', 'prepare-subscription-remaining-fixtures.prepare.mjs']
  const root = privateRoot()
  try {
    // Tiny prebuilt-output fixtures model manifest closure only. They are never
    // executed, installed, sent to an image build, or claimed as UI evidence.
    for (const relative of [
      'desktop-app/dist/main.js', 'desktop-app/ui-dist/index.html', 'desktop-app/package.json',
      'desktop-app/package-lock.json', 'mcp-host/package.json', 'mcp-host/package-lock.json',
      'desktop-app/test/e2e-playwright/subscriptionImageFixtures.ts',
      'desktop-app/test/e2e-playwright/subscriptionImageRunContract.ts',
      'desktop-app/test/e2e-playwright/subscriptionRemainingJourneysContract.ts',
      'desktop-app/test/e2e-playwright/subscription-image-input.spec.ts',
      'desktop-app/test/e2e-playwright/playwright.subscription-image.config.ts',
      'scripts/e2e/fixtures/subscription-image-challenge.cjs', 'scripts/e2e/fixtures/subscription-image-session.mjs',
      'scripts/e2e/fixtures/subscription-image-decoder.mjs',
      'scripts/e2e/fixtures/subscription-image-runner.base-image',
      'scripts/tests/lib/subscription-image-runner-contract.mjs', 'scripts/tests/lib/subscription-image-source-context.mjs',
    ]) {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
      fs.writeFileSync(path.join(root, relative), '// Unit manifest artifact; never executed.\n')
    }
    fs.mkdirSync(path.join(root, 'packages'))
    fs.copyFileSync(path.join(repoRoot, 'scripts/e2e/run-subscription-image-journeys.mjs'), path.join(root, 'scripts/e2e/run-subscription-image-journeys.mjs'))
    for (const name of helpers) fs.copyFileSync(path.join(repoRoot, 'scripts/e2e', name), path.join(root, 'scripts/e2e', name))
    fs.writeFileSync(path.join(root, 'subscription-image-input-source.json'), JSON.stringify({ gitHead: 'a'.repeat(40), gitTree: 'b'.repeat(40) }))
    sealSourceManifest(root)
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'subscription-image-source.json'), 'utf8'))
    assert.ok(helpers.every(name => manifest.files.some(file => file.path === `scripts/e2e/${name}`)))
    fs.unlinkSync(path.join(root, 'subscription-image-source.json'))
    fs.unlinkSync(path.join(root, 'scripts/e2e', helpers[1]))
    assert.throws(() => sealSourceManifest(root), /ENOENT/)
    assert.equal(fs.existsSync(path.join(root, 'subscription-image-source.json')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
