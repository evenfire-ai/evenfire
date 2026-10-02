// Metadata-only unit fixtures test admission refusals. They are not physical
// Linux observations, a runner receipt, keychain proof, or visible E2E passes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  admitVendorFrame,
  digest,
  expectedJourneyNames,
  isEncryptedKeyringHeader,
  parseMountInfo,
  privateBusPath,
  readPrivateJson,
  readMainRecord,
  verifyRuntimeReceipts,
  unixSocketInode,
  verifyAccount,
  verifyJourneyReport,
  verifyMainAdmission,
  verifyMountIsolation,
  verifyPrivateIsolation,
  verifyRunnerEnvironment,
  verifySocketBinding,
  sfwFreeAsset,
  verifySourceManifest,
  verifyThirdPartyArtifact,
} from './lib/subscription-image-runner-contract.mjs'
import { runtimeFromInspect } from './lib/subscription-image-main-admission.mjs'
import { allowedSourcePath } from './lib/subscription-image-source-context.mjs'
import {
  verifyPressureMetadata,
  verifyPressureObservation,
} from '../e2e/fixtures/subscription-image-admission-pressure.mjs'

const home = '/home/evenfire-e2e',
  base = '/run/evenfire-e2e',
  admissionRoot = '/runner-admission'
const observed = {
  platform: 'linux',
  uid: 10001,
  gid: 10001,
  home,
  mountNamespace: 'mnt:[123]',
  pidNamespace: 'pid:[234]',
  userNamespace: 'user:[345]',
  mountInfoSha256: 'a'.repeat(64),
}
const processRow = (pid, executable) => ({
  pid,
  uid: observed.uid,
  startTime: '321',
  executable,
  executablePath: `/usr/bin/${executable}`,
  argvSha256: 'b'.repeat(64),
  mountNamespace: observed.mountNamespace,
  pidNamespace: observed.pidNamespace,
  userNamespace: observed.userNamespace,
})
const isolation = {
  homeMountId: '3',
  runMountId: '4',
  tmpMountId: '5',
  admissionMountId: '6',
  sessionBus: {
    ...processRow(100, 'dbus-daemon'),
    socketPath: `${home}/runtime/bus`,
    socketInode: '700',
    address: `unix:path=${home}/runtime/bus`,
  },
  display: {
    ...processRow(101, 'Xvfb'),
    socketPath: '/tmp/.X11-unix/X17',
    socketInode: '701',
    value: ':17',
    xauthorityPath: `${home}/.Xauthority`,
  },
  keyring: processRow(102, 'gnome-keyring-daemon'),
}
const environment = {
  HOME: home,
  DISPLAY: isolation.display.value,
  XAUTHORITY: isolation.display.xauthorityPath,
  DBUS_SESSION_BUS_ADDRESS: isolation.sessionBus.address,
}
const rawMounts = [
  '1 0 0:1 / / ro,relatime - overlay overlay ro',
  '2 1 0:2 / /proc rw,nosuid,nodev,noexec - proc proc rw',
  `3 1 0:3 / ${home} rw,nosuid,nodev - tmpfs tmpfs rw`,
  `4 1 0:4 / ${base} rw,nosuid,nodev - tmpfs tmpfs rw`,
  '5 1 0:5 / /tmp rw,nosuid,nodev - tmpfs tmpfs rw',
  '6 1 0:6 /private/e2e-admission /runner-admission ro - ext4 /dev/root ro',
].join('\n')

test('mount guard requires readonly image/admission and three fresh unshadowed tmpfs mounts', () => {
  assert.deepEqual(verifyMountIsolation(parseMountInfo(rawMounts), home, base, admissionRoot), {
    homeMountId: '3',
    runMountId: '4',
    tmpMountId: '5',
    admissionMountId: '6',
  })
  for (const changed of [
    rawMounts.replace('/ / ro,relatime', '/ / rw,relatime'),
    rawMounts.replace('/runner-admission ro', '/runner-admission rw'),
    rawMounts.replace(`0:3 / ${home}`, `0:3 /home/personal ${home}`),
    `${rawMounts}\n7 3 0:7 / /home/evenfire-e2e/keyring rw - tmpfs tmpfs rw`,
    `${rawMounts}\n7 1 0:7 / /proc/private-bus rw - tmpfs tmpfs rw`,
    `${rawMounts}\n7 1 0:7 /Users/operator /host-home ro - ext4 /dev/root ro`,
  ])
    assert.throws(() => verifyMountIsolation(parseMountInfo(changed), home, base, admissionRoot))
})

test('mount parser decodes paths and refuses malformed evidence', () => {
  assert.equal(
    parseMountInfo('1 0 0:1 / /unit\\040path ro - tmpfs tmpfs ro')[0].point,
    '/unit path'
  )
  assert.throws(() => parseMountInfo('not mount evidence'))
})

test('OS account guard cannot be satisfied by HOME alone or an ambiguous passwd entry', () => {
  const account = `evenfire-e2e:x:10001:10001::${home}:/bin/sh`
  assert.doesNotThrow(() => verifyAccount(account, 10001, 10001, home, 'evenfire-e2e'))
  for (const args of [
    [account, 0, 10001, home, 'evenfire-e2e'],
    [account, 10001, 10002, home, 'evenfire-e2e'],
    [account, 10001, 10001, '/outside', 'evenfire-e2e'],
    [`${account}\n${account}`, 10001, 10001, home, 'evenfire-e2e'],
  ])
    assert.throws(() => verifyAccount(...args))
})

test('inherited sockets, runtime path escapes and Electron sandbox overrides are refused', () => {
  assert.doesNotThrow(() =>
    verifyRunnerEnvironment({ HOME: home, XDG_CONFIG_HOME: `${home}/config` }, observed)
  )
  for (const extra of [
    { SSH_AUTH_SOCK: '/outside/agent' },
    { NODE_OPTIONS: '--inspect' },
    { ELECTRON_DISABLE_SANDBOX: '1' },
    { ELECTRON_RUN_AS_NODE: '1' },
    { XAUTHORITY: '/outside/auth' },
    { HOME: '/outside' },
  ])
    assert.throws(() => verifyRunnerEnvironment({ HOME: home, ...extra }, observed))
})

test('private bus address accepts one filesystem endpoint and its observed GUID only', () => {
  assert.equal(
    privateBusPath(`${isolation.sessionBus.address},guid=${'a'.repeat(32)}`),
    isolation.sessionBus.socketPath
  )
  for (const address of [
    'unix:abstract=personal',
    `${isolation.sessionBus.address};unix:path=/other`,
    'tcp:host=localhost,port=1234',
    'unix:path=relative',
  ])
    assert.throws(() => privateBusPath(address))
})

test('keyring header guard refuses plaintext and unsupported cipher/version data', () => {
  const bytes = Buffer.from('GnomeKeyring\n\r\0\n\0\0\0\0')
  assert.equal(isEncryptedKeyringHeader(bytes), true)
  assert.equal(isEncryptedKeyringHeader(Buffer.from('[keyring]\ndisplay-name=unit')), false)
  const other = Buffer.from(bytes)
  other[18] = 1
  assert.equal(isEncryptedKeyringHeader(other), false)
})

test('socket proof requires exactly one kernel inode and one FD held by the named live process', () => {
  const table = `Num RefCount Protocol Flags Type St Inode Path\n0000: 0002 0000 00010000 0001 01 700 ${isolation.sessionBus.socketPath}`
  assert.equal(unixSocketInode(table, isolation.sessionBus.socketPath), '700')
  assert.doesNotThrow(() => verifySocketBinding('700', ['socket:[700]', '/dev/null']))
  assert.throws(() =>
    unixSocketInode(
      `${table}\n0001: 0002 0000 00010000 0001 01 701 ${isolation.sessionBus.socketPath}`,
      isolation.sessionBus.socketPath
    )
  )
  assert.throws(() => verifySocketBinding('700', ['socket:[701]']))
  assert.throws(() => verifySocketBinding('700', ['socket:[700]', 'socket:[700]']))
})

test('private isolation metadata refuses changed PID lifetime, UID, namespace, socket or keyring', () => {
  assert.doesNotThrow(() =>
    verifyPrivateIsolation(isolation, structuredClone(isolation), observed, environment, base)
  )
  for (const patch of [
    { startTime: '322' },
    { uid: 10002 },
    { mountNamespace: 'mnt:[other]' },
    { socketInode: 'other' },
    { socketPath: '/outside/bus' },
  ]) {
    const changed = structuredClone(isolation)
    Object.assign(changed.sessionBus, patch)
    assert.throws(() => verifyPrivateIsolation(isolation, changed, observed, environment, base))
  }
  const changed = structuredClone(isolation)
  changed.keyring.executablePath = `${home}/gnome-keyring-daemon`
  assert.throws(() => verifyPrivateIsolation(changed, changed, observed, environment, base))
  assert.throws(() =>
    verifyPrivateIsolation(
      isolation,
      isolation,
      observed,
      { ...environment, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/outside/bus' },
      base
    )
  )
})

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const pinnedBase = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'scripts/e2e/fixtures/subscription-image-runner.base-image'), 'utf8')
)
const forwardRecord = (service, namespace, localPort, remotePort) =>
  `1000\nPORT_FORWARD_OWNER_VERSION=1\nPID=1000\nPROCESS_START=Thu Oct  2 00:00:00 2026\n` +
  `PROFILE=unit-owned\nCONTEXT=unit-owned\nWORKTREE=/unit/worktree\nNAMESPACE=${namespace}\n` +
  `SERVICE=${service}\nLOCAL_PORT=${localPort}\nREMOTE_PORT=${remotePort}\nADDRESS=127.0.0.1\n`

function mainMetadata() {
  const createdAt = new Date(Date.now() - 1000).toISOString()
  const source = {
    gitHead: 'a'.repeat(40),
    gitTree: 'b'.repeat(40),
    inputManifestSha256: 'c'.repeat(64),
    manifestSha256: 'd'.repeat(64),
  }
  const stack = {
    gitHead: source.gitHead,
    worktreeId: 'e'.repeat(40),
    clusterFingerprint: 'f'.repeat(64),
    imagesGeneratedAt: '2026-10-02T00:00:00Z',
    portsReceiptSha256: '1'.repeat(64),
  }
  const portsEnvRaw = 'EXTERNAL_REST_API_PORT=34051\nRPC_PROXY_PORT=34052\n'
  const stackReceipt = {
    kind: 'evenfire-subscription-image-stack-marker-v1',
    context: 'unit-owned',
    configMapName: 'clerum-pre-gate-sync-state',
    resourceVersion: '12345',
    fetchedAt: createdAt,
    profile: 'unit-owned',
    portsEnvRaw,
    portsEnvSha256: digest(portsEnvRaw),
    data: {
      gitHead: source.gitHead,
      worktreeId: stack.worktreeId,
      clusterFingerprint: stack.clusterFingerprint,
      imagesGeneratedAt: stack.imagesGeneratedAt,
      imageSource: 'local',
      imageTag: 'unit',
    },
  }
  const restRaw = forwardRecord('external-rest-api', 'profiles', 34051, 8091)
  const rpcRaw = forwardRecord('rpc-proxy', 'rpc-proxy', 34052, 8094)
  const portForwardsReceipt = {
    kind: 'evenfire-subscription-image-port-forwards-v1',
    profile: 'unit-owned',
    context: 'unit-owned',
    verifiedAt: createdAt,
    entries: {
      rest: { raw: restRaw, recordSha256: digest(restRaw), pid: 1000, processStart: 'unit-start' },
      rpc: { raw: rpcRaw, recordSha256: digest(rpcRaw), pid: 1000, processStart: 'unit-start' },
    },
  }
  const inspectReceipt = {
    container: {
      Id: '9'.repeat(64),
      Image: `sha256:${'2'.repeat(64)}`,
      Created: createdAt,
      Config: {
        User: '10001:10001',
        Env: ['HOME=/home/evenfire-e2e', 'SUBSCRIPTION_IMAGE_RUN_ID=subscription-image-123456abcdef'],
      },
      State: { Running: true },
      HostConfig: {
        ReadonlyRootfs: true,
        Privileged: false,
        PidMode: 'private',
        IpcMode: 'private',
        NetworkMode: 'bridge',
        CapDrop: ['ALL'],
        SecurityOpt: [],
      },
      Mounts: [
        { Type: 'volume', Name: 'evenfire-sir-123456abcdef-admission', Source: '/var/lib/docker/volumes/evenfire-sir-123456abcdef-admission/_data', Destination: '/runner-admission', RW: false },
        { Type: 'tmpfs', Source: 'tmpfs', Destination: home, RW: true },
        { Type: 'tmpfs', Source: 'tmpfs', Destination: '/run/evenfire-e2e', RW: true },
        { Type: 'tmpfs', Source: 'tmpfs', Destination: '/tmp', RW: true },
      ],
    },
    securityOptions: ['name=seccomp,profile=builtin'],
  }
  const admission = {
    kind: 'evenfire-subscription-image-main-admission-v2',
    runId: 'subscription-image-123456abcdef',
    suiteId: 'subscription-image-input',
    mode: 'fixture',
    ...source,
    sourceManifestSha256: source.manifestSha256,
    repoRoot,
    imageId: `sha256:${'2'.repeat(64)}`,
    baseImage: pinnedBase.reference,
    uiFeatures: {},
    observation: observed,
    networkNamespace: 'net:[456]',
    ipcNamespace: 'ipc:[567]',
    profile: 'unit-owned',
    context: 'unit-owned',
    stack: { ...stack, portsReceiptSha256: stackReceipt.portsEnvSha256 },
    runtime: {
      readOnlyRootfs: true,
      privileged: false,
      pidMode: 'private',
      ipcMode: 'private',
      networkMode: 'unit-owned-bridge',
      user: '10001:10001',
      capDrop: ['ALL'],
      seccompMode: 'filter',
      containerId: '9'.repeat(64),
      createdAt,
    },
    receipts: {
      generatedAt: createdAt,
      dockerInspectSha256: digest(JSON.stringify(inspectReceipt)),
      stackMarkerSha256: digest(JSON.stringify(stackReceipt)),
      portForwardsSha256: digest(JSON.stringify(portForwardsReceipt)),
    },
    volume: {
      name: 'evenfire-sir-123456abcdef-admission',
      driver: 'local',
      createdAt,
      inspectSha256: '7'.repeat(64),
    },
    thirdPartyArtifacts: [
      {
        name: 'sfw-free',
        version: '1.15.1',
        arch: 'arm64',
        sha256: '8'.repeat(64),
        bytes: 136907904,
        elfMachine: 0xb7,
      },
    ],
    bindings: [{ provider: 'grok-subscription' }, { provider: 'codex-subscription' }],
    transports: Object.fromEntries(
      [
        ['rest', 'external-rest-api', '34051'],
        ['rpc', 'rpc-proxy', '34052'],
      ].map(([kind, service, port]) => [
        kind,
        {
          origin: `http://host.docker.internal:${port}`,
          service,
          profile: 'unit-owned',
          context: 'unit-owned',
          worktreeId: stack.worktreeId,
          gitHead: stack.gitHead,
          portsReceiptSha256: stack.portsReceiptSha256,
          forwardBindingSha256: '6'.repeat(64),
        },
      ])
    ),
  }
  admission.transports.rest.forwardBindingSha256 = digest(restRaw)
  admission.transports.rpc.forwardBindingSha256 = digest(rpcRaw)
  admission.transports.rest.portsReceiptSha256 = stackReceipt.portsEnvSha256
  admission.transports.rpc.portsReceiptSha256 = stackReceipt.portsEnvSha256
  const physical = {
    observation: observed,
    networkNamespace: 'net:[456]',
    ipcNamespace: 'ipc:[567]',
  }
  const receipts = {
    inspect: { value: inspectReceipt, sha256: digest(JSON.stringify(inspectReceipt)) },
    stack: { value: stackReceipt, sha256: digest(JSON.stringify(stackReceipt)) },
    portForwards: { value: portForwardsReceipt, sha256: digest(JSON.stringify(portForwardsReceipt)) },
  }
  return { source, admission, physical, receipts }
}
test('main admission binds the real source manifest, stack marker, private runtime and both forward records', () => {
  const { source, admission, physical, receipts } = mainMetadata()
  assert.doesNotThrow(() =>
    verifyMainAdmission(admission, physical, source, repoRoot, { HOME: home }, 'admit', receipts)
  )
  for (const change of [
    value => {
      value.gitHead = '7'.repeat(40)
    },
    value => {
      value.gitTree = '7'.repeat(40)
    },
    value => {
      value.context = 'different'
    },
    value => {
      value.runtime.privileged = true
    },
    value => {
      value.runtime.networkMode = 'host'
    },
    value => {
      value.runtime.pidMode = 'host'
    },
    value => {
      value.stack.portsReceiptSha256 = '7'.repeat(64)
    },
    value => {
      value.transports.rpc.origin = value.transports.rest.origin
    },
    value => {
      value.transports.rpc.origin = 'http://127.0.0.1:8091'
    },
    value => {
      value.transports.rest.worktreeId = '7'.repeat(40)
    },
  ]) {
    const changed = structuredClone(admission)
    change(changed)
    assert.throws(() =>
      verifyMainAdmission(changed, physical, source, repoRoot, { HOME: home }, 'admit', receipts)
    )
  }
  const stale = structuredClone(admission)
  stale.runtime.createdAt = new Date(Date.now() - 700_000).toISOString()
  assert.throws(() =>
    verifyMainAdmission(stale, physical, source, repoRoot, { HOME: home }, 'admit', receipts)
  )
  const swapped = structuredClone(admission)
  swapped.uiFeatures = { VITE_SHOW_GLOBAL_FILE_SYSTEM_COMPOSER_ITEM: 'true' }
  assert.throws(() =>
    verifyMainAdmission(swapped, physical, source, repoRoot, { HOME: home }, 'admit', receipts)
  )
})

test('private JSON refuses wrong mode, symlink and hardlink without accepting an environment assertion', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subscription-runner-unit-'))
  try {
    const filename = path.join(root, 'unit-admission.json')
    fs.writeFileSync(filename, JSON.stringify({ kind: 'unit-only-json' }), {
      mode: 0o600,
    })
    assert.equal(readPrivateJson(filename).kind, 'unit-only-json')
    fs.chmodSync(filename, 0o644)
    assert.throws(() => readPrivateJson(filename))
    fs.chmodSync(filename, 0o600)
    fs.symlinkSync(filename, path.join(root, 'link.json'))
    assert.throws(() => readPrivateJson(path.join(root, 'link.json')))
    fs.linkSync(filename, path.join(root, 'hard.json'))
    assert.throws(() => readPrivateJson(filename))
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})

test('minimal source context excludes ignored/private/Git files and unrelated repository paths', () => {
  const packages = ['packages/llm-provider-attempt-contract']
  for (const filename of [
    'desktop-app/src/main.ts',
    'desktop-app/ui/src/App.tsx',
    'packages/llm-provider-attempt-contract/testImageFixtures.cjs',
  ])
    assert.equal(allowedSourcePath(filename, packages), true)
  for (const filename of [
    '.git/HEAD',
    'desktop-app/.env',
    'desktop-app/src/session.key',
    'desktop-app/src/__tests__/personal.test.ts',
    'control-api/src/main.ts',
    'packages/not-in-closure/index.js',
    '../escape',
    '/outside',
  ])
    assert.equal(allowedSourcePath(filename, packages), false)
  assert.throws(() =>
    verifySourceManifest(
      {
        kind: 'evenfire-subscription-image-source-v1',
        gitHead: 'a'.repeat(40),
        files: [],
      },
      '/unit'
    )
  )
})

test('vendor frames require the sealed physical proxy identity and an unchanged bounded history', () => {
  const binding = {
    provider: 'grok-subscription',
    modelId: 'unit-vision',
    unsupportedModelId: 'unit-text',
  }
  const source = {
    profile: 'unit-owned',
    podUid: 'unit-pod',
    imageId: `sha256:${'a'.repeat(64)}`,
  }
  const row = {
    sequence: 1,
    provider: binding.provider,
    model: binding.modelId,
    receiptId: '11111111-1111-4111-8111-111111111111',
    imageSha256: ['b'.repeat(64)],
    mimeTypes: ['image/png'],
    requestSha256: 'c'.repeat(64),
    responseKind: 'pixels',
    outputSha256: 'd'.repeat(64),
  }
  const frame = {
    kind: 'evenfire-subscription-image-vendor-frame-v1',
    runId: 'unit-run',
    provider: binding.provider,
    source,
    ledger: {
      kind: 'evenfire-subscription-image-vendor-v1',
      runId: 'unit-run',
      attempts: [row],
    },
  }
  assert.equal(admitVendorFrame(frame, 'unit-run', binding, source, []).attempts.length, 1)
  for (const change of [
    value => {
      value.source.podUid = 'other'
    },
    value => {
      value.ledger.attempts[0].sequence = 2
    },
    value => {
      value.ledger.attempts[0].rawBody = 'forbidden extra field'
    },
    value => {
      value.ledger.attempts[0].model = 'unowned'
    },
  ]) {
    const changed = structuredClone(frame)
    change(changed)
    assert.throws(() => admitVendorFrame(changed, 'unit-run', binding, source, []))
  }
  const changed = structuredClone(frame)
  changed.ledger.attempts[0].outputSha256 = 'e'.repeat(64)
  assert.throws(() => admitVendorFrame(changed, 'unit-run', binding, source, [row]))
})


test('v2 named admission volume is the only permitted main-side inspect mount', () => {
  const { admission, receipts } = mainMetadata()
  const inspect = structuredClone(receipts.inspect.value.container)
  inspect.Mounts[0] = {
    Type: 'volume',
    Name: admission.volume.name,
    Source: `/var/lib/docker/volumes/${admission.volume.name}/_data`,
    Destination: '/runner-admission',
    RW: false,
  }
  const options = { runId: admission.runId, suiteId: admission.suiteId, home }
  assert.doesNotThrow(() => runtimeFromInspect(inspect, options))
  for (const change of [
    value => { value.Mounts[0].Type = 'bind' },
    value => { value.Mounts[0].Name = 'evenfire-sir-ffffffffffff-admission' },
    value => { value.Mounts[0].RW = true },
    value => { value.Mounts.push({ Type: 'volume', Name: 'extra', Destination: '/extra', RW: false }) },
    value => { value.Mounts[0].Source = '/Users/operator/private' },
  ]) {
    const changed = structuredClone(inspect)
    change(changed)
    assert.throws(() => runtimeFromInspect(changed, options))
  }
})

test('v2 runtime receipt verifies the exact named read-only admission volume', () => {
  const { admission, receipts } = mainMetadata()
  receipts.inspect.value.container.Mounts[0] = {
    Type: 'volume',
    Name: admission.volume.name,
    Source: `/var/lib/docker/volumes/${admission.volume.name}/_data`,
    Destination: '/runner-admission',
    RW: false,
  }
  assert.doesNotThrow(() => verifyRuntimeReceipts(admission, receipts))
  for (const change of [
    value => { value.inspect.value.container.Mounts[0].Type = 'bind' },
    value => { value.inspect.value.container.Mounts[0].Name = 'foreign-volume' },
    value => { value.inspect.value.container.Mounts[0].RW = true },
    value => { value.inspect.value.container.Mounts.push({ Type: 'tmpfs', Destination: '/extra', RW: true }) },
  ]) {
    const changed = structuredClone(receipts)
    change(changed)
    assert.throws(() => verifyRuntimeReceipts(admission, changed))
  }
})

test('v2 main records accept the runner UID with strict private file provenance', () => {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'subscription-main-record-'))
  try {
    const filename = path.join(directory, 'unit.json')
    fs.writeFileSync(filename, JSON.stringify({ kind: 'unit-only-json' }), { mode: 0o600 })
    assert.equal(readMainRecord(filename).uid, process.getuid())
    fs.chmodSync(filename, 0o644)
    assert.throws(() => readMainRecord(filename))
    fs.chmodSync(filename, 0o600)
    const alias = path.join(directory, 'alias.json')
    fs.symlinkSync(filename, alias)
    assert.throws(() => readMainRecord(alias))
    fs.unlinkSync(alias)
    fs.linkSync(filename, alias)
    assert.throws(() => readMainRecord(filename))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('tool vendor metadata stays closed, bounded and immutable without raw content', () => {
  const binding = { provider: 'grok-subscription', modelId: 'unit-vision', unsupportedModelId: 'unit-text' }
  const source = { profile: 'unit-owned', podUid: 'unit-pod', imageId: `sha256:${'a'.repeat(64)}` }
  const resource = { kind: 'gfs', drive: 'unit-drive', resourceId: 'a'.repeat(32), version: 1, gfsUri: `gfs://unit-drive/${'a'.repeat(32)}` }
  const row = {
    sequence: 1, provider: binding.provider, model: binding.modelId,
    receiptId: '11111111-1111-4111-8111-111111111111',
    imageSha256: [], mimeTypes: [], receivedImageDigests: [], receivedImageOrder: [], decodedPixels: [],
    requestSha256: 'b'.repeat(64), responseKind: 'tool_calls', outputSha256: 'c'.repeat(64),
    journey: 'gfs-image', stage: 'read',
    toolCalls: [{ id: 'call_unit', name: 'clerum__gfs_read', argumentsSha256: 'd'.repeat(64) }],
    toolOutputs: [{ id: 'call_previous', outputSha256: 'e'.repeat(64), resource }],
    referencedFiles: [{ referenceId: `gfs:unit-drive:${'a'.repeat(32)}@v1`, drive: 'unit-drive', resourceId: 'a'.repeat(32), version: 1, availability: 'available', byteLength: 1024 }],
  }
  const frame = { kind: 'evenfire-subscription-image-vendor-frame-v1', runId: 'unit-run', provider: binding.provider, source,
    ledger: { kind: 'evenfire-subscription-image-vendor-v1', runId: 'unit-run', attempts: [row] } }
  assert.equal(admitVendorFrame(frame, 'unit-run', binding, source, []).attempts.length, 1)
  assert.equal(admitVendorFrame(frame, 'unit-run', binding, source).attempts.length, 1)
  assert.throws(() => admitVendorFrame(frame, 'unit-run', binding, source, null))
  assert.equal(admitVendorFrame(frame, 'unit-run', binding, source, [row]).attempts.length, 1)
  for (const change of [
    value => { value.extraHeader = 'unknown' },
    value => { value.ledger.extraHeader = 'unknown' },
    value => { value.ledger.attempts[0].toolCalls[0].arguments = 'forbidden raw arguments' },
    value => { value.ledger.attempts[0].toolOutputs[0].output = 'forbidden raw output' },
    value => { value.ledger.attempts[0].toolCalls[0].argumentsSha256 = 'not-a-hash' },
    value => { value.ledger.attempts[0].toolCalls = Array.from({ length: 33 }, () => row.toolCalls[0]) },
    value => { value.ledger.attempts[0].toolOutputs[0].resource.gfsUri = 'https://example.invalid' },
    value => { value.ledger.attempts[0].referencedFiles[0].byteLength = Number.MAX_SAFE_INTEGER },
    value => { value.ledger.attempts[0].stage = 'capture' },
    value => { value.ledger.attempts[0].decodedPixels = [{ width: 512, height: 512, answer: 'forbidden' }] },
  ]) {
    const changed = structuredClone(frame)
    change(changed)
    assert.throws(() => admitVendorFrame(changed, 'unit-run', binding, source, []))
  }
  const changed = structuredClone(frame)
  changed.ledger.attempts[0].toolCalls[0].argumentsSha256 = 'f'.repeat(64)
  assert.throws(() => admitVendorFrame(changed, 'unit-run', binding, source, [row]))
})

test('named journey reporter rejects missing, skipped, duplicate or foreign-file cases even with producer exit zero', () => {
  // This synthetic reporter tests only the status guard, never an E2E pass.
  const file = '/unit/subscription-image-input.spec.ts'
  const cases = expectedJourneyNames('fixture')
  const report = {
    config: { rootDir: '/unit' },
    errors: [],
    stats: { expected: 14, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [
      {
        title: path.basename(file),
        specs: cases.map(title => ({
          title,
          file: path.basename(file),
          ok: true,
          tests: [
            {
              projectName: 'subscription-image-input',
              expectedStatus: 'passed',
              status: 'expected',
              results: [{ status: 'passed' }],
            },
          ],
        })),
      },
    ],
  }
  assert.equal(verifyJourneyReport(report, 'fixture', file).executed, 14)
  for (const change of [
    value => {
      value.stats.expected = 0
    },
    value => {
      value.suites[0].specs.pop()
    },
    value => {
      value.suites[0].specs[0].tests[0].results[0].status = 'skipped'
    },
    value => {
      value.suites[0].specs[0].file = 'unrelated.spec.ts'
    },
    value => {
      value.suites[0].specs[0].title = value.suites[0].specs[1].title
    },
  ]) {
    const changed = structuredClone(report)
    change(changed)
    assert.throws(() => verifyJourneyReport(changed, 'fixture', file))
  }
})

test('runner defaults to refusal; explicit plan never launches or produces a runtime receipt', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const runner = path.join(root, 'scripts/e2e/run-subscription-image-journeys.mjs')
  const options = {
    encoding: 'utf8',
    timeout: 5_000,
    env: { PATH: path.dirname(process.execPath) },
  }
  const defaultRun = spawnSync(process.execPath, [runner], options)
  assert.equal(defaultRun.status, 1)
  assert.match(defaultRun.stderr, /runner-refused/)
  const plan = spawnSync(process.execPath, [runner, 'plan'], options)
  assert.equal(plan.status, 0)
  assert.equal(JSON.parse(plan.stdout).sourceOnly, true)
  assert.doesNotMatch(plan.stdout, /runner-admitted|runner-v2/)
})

test('runner image uses only staged explicit copies, locked sfw installs and the nonroot account', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const dockerfile = fs.readFileSync(
    path.join(root, 'scripts/e2e/fixtures/subscription-image-runner.Dockerfile'),
    'utf8'
  )
  assert.doesNotMatch(
    dockerfile,
    /^COPY\s+\.\s|source-git|\.git\/HEAD|--ignore-scripts|--no-sandbox|--privileged|--network=host|apt-get\s+(upgrade|dist-upgrade)/m
  )
  assert.match(dockerfile, /apt-get install -y --no-install-recommends/)
  assert.match(dockerfile, /sfw npm ci --prefix desktop-app/)
  assert.match(dockerfile, /sfw npm ci --prefix mcp-host/)
  assert.match(dockerfile, /USER 10001:10001/)
  assert.match(dockerfile, /verifyInputSource/)
})

test('third-party sfw-free assets stay pinned and artifact drift is refused', () => {
  const arm = sfwFreeAsset('arm64'),
    x64 = sfwFreeAsset('x64')
  assert.equal(
    arm.url,
    'https://github.com/SocketDev/sfw-free/releases/download/v1.15.1/sfw-free-linux-arm64'
  )
  assert.equal(arm.sha256, '4d02d1c1f5d6b6444721b0a67bd0e80aab182fe7f22d692570d1c14797602c47')
  assert.equal(arm.bytes, 136907904)
  assert.equal(
    x64.url,
    'https://github.com/SocketDev/sfw-free/releases/download/v1.15.1/sfw-free-linux-x86_64'
  )
  assert.equal(x64.sha256, '8898d0667c2165aecd695ca797473ec3a429d2ed807d4d0bf9e67c45817ea809')
  assert.throws(() => sfwFreeAsset('ia32'))
  const body = Buffer.alloc(20)
  body.writeUInt32LE(0x464c457f, 0)
  body[4] = 2
  body[5] = 1
  body.writeUInt16LE(0xb7, 18)
  const asset = { sha256: digest(body), bytes: body.length, arch: 'arm64', machine: 0xb7 }
  assert.equal(verifyThirdPartyArtifact({ bytes: body, asset }).elfMachine, 0xb7)
  assert.throws(() =>
    verifyThirdPartyArtifact({ bytes: body, asset: { ...asset, sha256: 'a'.repeat(64) } })
  )
  assert.throws(() => verifyThirdPartyArtifact({ bytes: body, asset: { ...asset, machine: 0x3e } }))
  const text = Buffer.from('not-an-elf')
  assert.throws(() =>
    verifyThirdPartyArtifact({ bytes: text, asset: { ...asset, bytes: text.length, sha256: digest(text) } })
  )
})

test('pressure metadata and native owner observations refuse drift', () => {
  const metadata = {
    kind: 'evenfire-subscription-image-pressure-metadata-v1',
    profile: 'unit-owned',
    context: 'unit-owned',
    worktreeId: 'a'.repeat(40),
    sourceManifestSha256: 'b'.repeat(64),
    podUid: 'unit-pod',
    imageId: `sha256:${'c'.repeat(64)}`,
    pressureRunId: 'subscription-image-pressure-123456abcdef',
    hostRefs: ['unit-grok', 'unit-codex'],
    maxInFlight: 2,
    socketPath: '/run/evenfire-e2e/pressure.sock',
  }
  assert.doesNotThrow(() => verifyPressureMetadata(metadata))
  assert.throws(() => verifyPressureMetadata({ ...metadata, hostRefs: ['unit-grok', 'unit-grok'] }))
  assert.throws(() => verifyPressureMetadata({ ...metadata, socketPath: 'relative.sock' }))
  const value = {
    ok: true,
    pressureRunId: metadata.pressureRunId,
    maxInFlight: 2,
    owners: { baseline: 0, held: 2, drained: 0 },
    counts: { sameRunAttempts: 0, sameRunTickets: 0, reservations: 0 },
    pids: [42],
    inspector: { pid: 42, startTime: 'unit-start' },
  }
  assert.equal(verifyPressureObservation(value, { held: 2, drained: 0 }, metadata).owners.held, 2)
  assert.throws(() => verifyPressureObservation({ ...value, pids: [43] }, {}, metadata))
  assert.throws(() =>
    verifyPressureObservation({ ...value, counts: { ...value.counts, reservations: 1 } }, {}, metadata)
  )
  assert.throws(() =>
    verifyPressureObservation(
      { ...value, pressureRunId: 'subscription-image-pressure-ffffffffffff' },
      {},
      metadata
    )
  )
})


test('host command wrapper transmits the complete admission input to a native child', async () => {
  const { run } = await import('../e2e/prepare-subscription-image-admission.mjs')
  const input = JSON.stringify({ kind: 'unit-admission-io', count: 4 })
  const result = run(
    process.execPath,
    ['-e', "process.stdout.write(require('node:fs').readFileSync(0, 'utf8'))"],
    { input, timeout: 1000 }
  )
  assert.equal(result, input)
})
