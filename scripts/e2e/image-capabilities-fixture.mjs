import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import {
  openOwnedFile,
  readOwnedFile,
  validateRunDirectory,
} from './prepare-codex-approved-tools.mjs'

export const fixtureImage = 'clerum/image-capabilities-mcp-host:test'
export const baseImage = 'clerum/mcp-host:test'
export const runAnnotation = 'evenfire.ai/image-capabilities-run'
export const fixtureConfigKeys = [
  'NODE_ENV',
  'EVENFIRE_IMAGE_CAPABILITIES_FIXTURE',
  'IMAGE_CAPABILITIES_RUN_ID',
  'IMAGE_CAPABILITIES_CREDENTIAL_SHA256',
  'MINIKUBE_PROFILE',
  'CONTROL_API_REAL_PG_CONTEXT',
]

export function proveImages(manifest, observed, head, profile) {
  if (!/^[a-f0-9]{40}$/.test(head) || manifest.profile !== profile)
    throw new Error('Fixture image ownership mismatch')
  for (const ref of [baseImage, fixtureImage]) {
    const id = manifest.images?.[ref]
    if (
      manifest.images?.[`docker.io/${ref}`] !== undefined &&
      manifest.images[`docker.io/${ref}`] !== id
    )
      throw new Error('Conflicting image aliases')
    if (
      !/^sha256:[a-f0-9]{64}$/.test(id ?? '') ||
      id !== observed[ref] ||
      manifest.sourceRevisions?.[ref] !== head
    )
      throw new Error('Fixture image identity or source revision mismatch')
  }
  const binding = manifest.derivedFrom?.[fixtureImage]
  if (binding?.ref !== baseImage || binding.id !== observed[baseImage])
    throw new Error('Fixture derived-base mismatch')
  return { head, profile, images: observed }
}

export function modelInputs(runId) {
  if (!/^image-capabilities-[a-f0-9]{12}$/.test(runId)) throw new Error('Invalid fixture run')
  return [
    { model: 'glm-5.3-flash', state: 'supported' },
    { model: 'glm-5.3', state: 'unsupported' },
    { model: `image-fixture-unknown-${runId.slice(-12)}`, state: 'unknown' },
  ].map(({ model, state }) => ({
    provider: 'zai',
    model,
    enabled: true,
    image_input: {
      state,
      evidence: {
        source: 'curated',
        reference: `evidence:${runId}`,
        checkedAt: new Date().toISOString(),
      },
    },
  }))
}

export function requireOwnedResource(resource, uid, runId) {
  if (resource?.metadata?.uid !== uid || resource.metadata.annotations?.[runAnnotation] !== runId)
    throw new Error('Fixture resource owner changed; refusing mutation')
}

function command(binary, args, { input, timeout = 60_000, env = process.env } = {}) {
  const result = spawnSync(binary, args, {
    input,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.error || result.status !== 0)
    throw new Error(`${binary} failed (status ${result.status ?? 'unavailable'})`)
  return result.stdout
}

async function main() {
  process.umask(0o077)
  if (!process.version.startsWith('v24.')) throw new Error('Node24 required')
  const root = fs.realpathSync(process.cwd())
  const profile = process.env.MINIKUBE_PROFILE
  if (
    !/^clerum-.+-[a-f0-9]{8}$/.test(profile ?? '') ||
    profile !== process.env.CONTROL_API_REAL_PG_CONTEXT
  )
    throw new Error('Matching branch profile and context required')
  command('bash', ['scripts/minikube/require-t2-mutation-lock.sh'])
  const head = command('git', ['rev-parse', 'HEAD']).trim()
  const branch = command('git', ['branch', '--show-current']).trim()
  if (command('git', ['status', '--porcelain']).trim()) throw new Error('Clean checkout required')
  const commonDir = command('git', [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]).trim()
  const canonical = fs.realpathSync(path.dirname(commonDir))
  if (path.basename(canonical) !== 'evenfire')
    throw new Error('Canonical Evenfire checkout required')
  const branchMake = path.join(canonical, '.local-notes/minikube-profiles/branch.mk')
  const info = command('make', ['-f', branchMake, 'branch-profile-info'])
  if (!info.includes(`profile: ${profile}\n`) || !info.includes(`repo: ${root}\n`))
    throw new Error('Branch helper identity mismatch')
  const urlFor = label => {
    const port = info.match(new RegExp(`^  ${label}:\\s+(\\d+)$`, 'm'))?.[1]
    if (!port || Number(port) < 1024 || Number(port) > 65535) throw new Error('Missing owned port')
    return `http://127.0.0.1:${port}`
  }
  command('make', ['-f', branchMake, 'branch-profile-health'])
  const api = `${urlFor('control-api')}/api/v1`
  const kc = (args, input) =>
    command('kubectl', [`--context=${profile}`, '--request-timeout=30s', ...args], {
      input,
      timeout: 180_000,
    })
  const get = (namespace, kind, name) =>
    JSON.parse(kc(['-n', namespace, 'get', kind, name, '-o', 'json']))
  const patch = (namespace, kind, name, operations) =>
    kc(
      ['-n', namespace, 'patch', kind, name, '--type=json', '--patch-file=/dev/stdin'],
      JSON.stringify(operations)
    )
  const stamp = resource => [
    { op: 'test', path: '/metadata/uid', value: resource.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: resource.metadata.resourceVersion },
  ]
  const escape = value => value.replaceAll('~', '~0').replaceAll('/', '~1')
  const annotate = resource => ({
    op: 'add',
    path: '/metadata/annotations',
    value: { ...resource.metadata.annotations, [runAnnotation]: state.runId },
  })
  const unmark = { op: 'remove', path: `/metadata/annotations/${escape(runAnnotation)}` }
  const waitHostImage = async image => {
    const until = Date.now() + 120_000
    while (Date.now() < until) {
      const deployment = get('mcp-host', 'deployment', 'chatllm')
      if (deployment.spec.template.spec.containers.some(c => c.image === image)) {
        kc(['-n', 'mcp-host', 'rollout', 'status', 'deployment/chatllm', '--timeout=120s'])
        return
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('HCC did not reconcile the expected Host image')
  }
  const action = process.argv[2] ?? 'run'
  if (!['run', 'restore'].includes(action)) throw new Error('Expected run or restore')
  const runRoot = path.join(canonical, '.local-notes/infra/runs')
  fs.mkdirSync(runRoot, { recursive: true })
  const runId = `image-capabilities-${randomBytes(6).toString('hex')}`
  const directory =
    action === 'restore' ? process.env.IMAGE_CAPABILITIES_RUN_DIR : path.join(runRoot, runId)
  if (!directory) throw new Error('Restore requires IMAGE_CAPABILITIES_RUN_DIR')
  if (action === 'run') fs.mkdirSync(directory, { mode: 0o700 })
  const evidence = validateRunDirectory(canonical, directory)
  let state =
    action === 'restore'
      ? JSON.parse(readOwnedFile(evidence, 'state.json'))
      : {
          runId,
          branch,
          profile,
          head,
          root,
          rows: [],
          changes: {},
          restored: false,
        }
  if (
    state.profile !== profile ||
    state.root !== root ||
    state.branch !== branch ||
    (action === 'run' && state.head !== head)
  )
    throw new Error('Run state identity mismatch')
  const save = () => {
    const destination = path.join(evidence, 'state.json')
    if (fs.existsSync(destination)) {
      const previous = openOwnedFile(evidence, 'state.json')
      fs.closeSync(previous.fd)
    }
    const name = `state-next-${randomBytes(6).toString('hex')}.json`
    const file = openOwnedFile(evidence, name, { create: true, writable: true })
    try {
      const payload = JSON.stringify(state, null, 2)
      fs.writeSync(file.fd, payload, 0, 'utf8')
      fs.fsyncSync(file.fd)
      fs.renameSync(path.join(evidence, name), destination)
      const parent = fs.openSync(
        evidence,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
      )
      try {
        fs.fsyncSync(parent)
      } finally {
        fs.closeSync(parent)
      }
    } finally {
      fs.closeSync(file.fd)
    }
  }
  if (action === 'run') {
    save()
    process.stdout.write(`IMAGE_CAPABILITIES_RUN_DIR=${evidence}\n`)
  }
  const authValue = command('bash', [
    '-c',
    'source "$1"; e2e_resolve_admin_password "$2"',
    'image-fixture',
    path.join(root, 'scripts/e2e/admin-credentials.sh'),
    root,
  ]).trim()
  if (!authValue) throw new Error('Owned lane admin login is not configured')
  const ADMIN_PASSWORD = authValue
  const auth = await fetch(`${api}/admin/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ADMIN_USERNAME ?? 'admin',
      password: ADMIN_PASSWORD,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!auth.ok) throw new Error(`Owned lane admin login failed (${auth.status})`)
  const cookie = auth.headers
    .getSetCookie()
    .find(value => value.startsWith('control_ui_admin_session='))
    ?.split(';')[0]
  if (!cookie) throw new Error('Admin session missing')
  const admin = async (method, route, body) => {
    const response = await fetch(`${api}/admin/${route}`, {
      method,
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Fixture admin operation failed (${response.status})`)
    return response.status === 204 ? null : response.json()
  }
  const restore = async () => {
    if (state.restored) return
    // Restore the model before removing its fixture-only catalog rows.
    if (state.changes.host) {
      const current = get('mcp-host', 'host', 'chatllm')
      const keys = ['model', 'allowedModels', 'secretRef', 'llmPolicy']
      const unchanged =
        current.metadata.uid === state.host.uid &&
        !current.metadata.annotations?.[runAnnotation] &&
        keys.every(key => isDeepStrictEqual(current.spec[key], state.host[key]))
      if (!unchanged) {
        requireOwnedResource(current, state.host.uid, state.runId)
        if (keys.some(key => !isDeepStrictEqual(current.spec[key], state.appliedHost[key])))
          throw new Error('Fixture Host fields changed concurrently')
        patch('mcp-host', 'host', 'chatllm', [
          ...stamp(current),
          ...['model', 'allowedModels', 'secretRef', 'llmPolicy']
            .map(key =>
              state.host[key] === undefined
                ? current.spec[key] === undefined
                  ? null
                  : { op: 'remove', path: `/spec/${key}` }
                : { op: 'add', path: `/spec/${key}`, value: state.host[key] }
            )
            .filter(Boolean),
          unmark,
        ])
      }
      state.changes.host = false
      save()
    }
    if (state.changes.config) {
      const current = get('mcp-host', 'configmap', 'mcp-host-config')
      const unchanged =
        current.metadata.uid === state.config.uid &&
        !current.metadata.annotations?.[runAnnotation] &&
        fixtureConfigKeys.every(key => current.data?.[key] === state.config.data[key])
      if (!unchanged) {
        requireOwnedResource(current, state.config.uid, state.runId)
        if (fixtureConfigKeys.some(key => current.data?.[key] !== state.appliedConfig[key]))
          throw new Error('Fixture configuration changed concurrently')
        patch('mcp-host', 'configmap', 'mcp-host-config', [
          ...stamp(current),
          ...fixtureConfigKeys
            .map(key =>
              state.config.data[key] === undefined
                ? current.data?.[key] === undefined
                  ? null
                  : { op: 'remove', path: `/data/${key}` }
                : { op: 'add', path: `/data/${key}`, value: state.config.data[key] }
            )
            .filter(Boolean),
          unmark,
        ])
      }
      state.changes.config = false
      save()
    }
    if (state.changes.hcc) {
      const current = get('control-plane', 'deployment', 'host-context-controller')
      const currentImage = current.spec.template.spec.containers
        .flatMap(c => c.env ?? [])
        .find(item => item.name === 'CONTEXT_MAPPER_HOST_IMAGE')?.value
      const unchanged =
        current.metadata.uid === state.hcc.uid &&
        !current.metadata.annotations?.[runAnnotation] &&
        currentImage === state.hcc.image
      if (!unchanged) {
        requireOwnedResource(current, state.hcc.uid, state.runId)
        patch('control-plane', 'deployment', 'host-context-controller', [
          ...stamp(current),
          {
            op: 'test',
            path: state.hcc.path.replace(/value$/, 'name'),
            value: 'CONTEXT_MAPPER_HOST_IMAGE',
          },
          { op: 'test', path: state.hcc.path, value: fixtureImage },
          { op: 'replace', path: state.hcc.path, value: state.hcc.image },
          unmark,
        ])
      }
      state.changes.hcc = false
      save()
      kc([
        '-n',
        'control-plane',
        'rollout',
        'status',
        'deployment/host-context-controller',
        '--timeout=120s',
      ])
    }
    for (const row of [...state.rows].reverse()) {
      if (row.restored) continue
      const current = (await admin('GET', 'llm-models')).rows.find(
        item => item.provider === row.provider && item.model === row.model
      )
      if (!current && !row.created) throw new Error('Original catalog row disappeared')
      const unchanged =
        current &&
        !row.created &&
        current.enabled === row.original.enabled &&
        isDeepStrictEqual(current.image_input, row.original.image_input)
      if (current && !unchanged) {
        if (
          (row.id && current.id !== row.id) ||
          current.image_input?.evidence?.reference !== `evidence:${state.runId}`
        )
          throw new Error('Catalog fixture owner changed')
        if (row.created) await admin('DELETE', `llm-models/${current.id}`)
        else await admin('PUT', `llm-models/${current.id}`, row.original)
      }
      row.restored = true
      save()
    }
    if (state.changes.key) {
      const metadata = kc([
        '-n',
        'mcp-host',
        'get',
        'secret',
        state.runId,
        '--ignore-not-found',
        '-o',
        'go-template={{.metadata.uid}} {{index .metadata.labels "evenfire.ai/image-capabilities-run"}}',
      ]).trim()
      if (metadata) {
        const [uid, owner] = metadata.split(/\s+/)
        if ((state.keyUid && uid !== state.keyUid) || owner !== state.runId)
          throw new Error('Fixture key owner changed')
        kc(
          ['delete', '--raw', `/api/v1/namespaces/mcp-host/secrets/${state.runId}`, '-f', '-'],
          JSON.stringify({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid } })
        )
      }
      state.changes.key = false
      save()
    }
    if (!state.hcc) {
      state.restored = true
      save()
      return
    }
    await waitHostImage(state.hcc.image)
    const hostDeployment = get('mcp-host', 'deployment', 'chatllm')
    if (!hostDeployment.spec.template.spec.containers.some(c => c.image === state.hcc.image))
      throw new Error('Production Host image not restored')
    const predicate = kc([
      '-n',
      'mcp-host',
      'exec',
      'deployment/chatllm',
      '--',
      'node',
      '-e',
      'process.stdout.write(String(!process.env.EVENFIRE_IMAGE_CAPABILITIES_FIXTURE && !require("node:fs").existsSync("/tmp/image-capabilities-evidence.json")))',
    ]).trim()
    if (predicate !== 'true') throw new Error('Fixture state remains in Host')
    state.restored = true
    save()
  }
  if (action === 'restore') {
    await restore()
    return
  }
  let failure
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, 'deploy/minikube/.image-manifest.json'), 'utf8')
    )
    const observed = Object.fromEntries(
      [baseImage, fixtureImage].map(ref => [
        ref,
        command('minikube', [
          '-p',
          profile,
          'ssh',
          '--',
          'docker',
          'image',
          'inspect',
          ref,
          '--format',
          '{{.Id}}',
        ]).trim(),
      ])
    )
    state.imageProof = proveImages(manifest, observed, head, profile)
    save()
    const host = get('mcp-host', 'host', 'chatllm')
    const hosts = JSON.parse(kc(['-n', 'mcp-host', 'get', 'hosts', '-o', 'json']))
    if (hosts.items.length !== 1 || hosts.items[0].metadata.uid !== host.metadata.uid)
      throw new Error('Fixture requires a dedicated single-Host profile')
    const hcc = get('control-plane', 'deployment', 'host-context-controller')
    const containerIndex = hcc.spec.template.spec.containers.findIndex(
      c => c.name === 'host-context-controller'
    )
    const envIndex = hcc.spec.template.spec.containers[containerIndex]?.env?.findIndex(
      e => e.name === 'CONTEXT_MAPPER_HOST_IMAGE'
    )
    if (containerIndex < 0 || envIndex < 0) throw new Error('HCC Host image configuration missing')
    const originalImage = hcc.spec.template.spec.containers[containerIndex].env[envIndex].value
    if (originalImage !== baseImage)
      throw new Error('Expected the owned local production Host image')
    const config = get('mcp-host', 'configmap', 'mcp-host-config')
    if (
      Object.keys(config.data ?? {}).some(
        key =>
          key.startsWith('IMAGE_CAPABILITIES_') || key === 'EVENFIRE_IMAGE_CAPABILITIES_FIXTURE'
      )
    )
      throw new Error('Unrestored image capability fixture configuration')
    for (const resource of [host, hcc, config])
      if (resource.metadata.annotations?.[runAnnotation])
        throw new Error('Unrestored fixture already owns resource')
    state.host = {
      uid: host.metadata.uid,
      ...Object.fromEntries(
        ['model', 'allowedModels', 'secretRef', 'llmPolicy'].map(key => [key, host.spec[key]])
      ),
    }
    state.hcc = {
      uid: hcc.metadata.uid,
      image: originalImage,
      path: `/spec/template/spec/containers/${containerIndex}/env/${envIndex}/value`,
    }
    state.config = {
      uid: config.metadata.uid,
      data: Object.fromEntries(
        fixtureConfigKeys
          .filter(key => key in (config.data ?? {}))
          .map(key => [key, config.data[key]])
      ),
    }
    save()
    const models = modelInputs(state.runId)
    const catalog = (await admin('GET', 'llm-models')).rows
    for (const model of models) {
      const prior = catalog.find(
        row => row.provider === model.provider && row.model === model.model
      )
      const row = {
        id: prior?.id,
        provider: model.provider,
        model: model.model,
        created: !prior,
        original: prior ? { enabled: prior.enabled, image_input: prior.image_input } : null,
      }
      state.rows.push(row)
      save()
      const saved = prior
        ? await admin('PUT', `llm-models/${prior.id}`, model)
        : await admin('POST', 'llm-models', model)
      row.id = saved.id
      save()
    }
    const fixtureKey = randomBytes(32).toString('hex')
    const keyHash = createHash('sha256').update(fixtureKey).digest('hex')
    state.changes.key = true
    save()
    const created = JSON.parse(
      kc(
        ['-n', 'mcp-host', 'create', '-f', '-', '-o', 'json'],
        JSON.stringify({
          apiVersion: 'v1',
          kind: 'Secret',
          metadata: {
            name: state.runId,
            namespace: 'mcp-host',
            labels: { [runAnnotation]: state.runId },
          },
          type: 'Opaque',
          stringData: { 'zai-api-key': fixtureKey },
        })
      )
    )
    state.keyUid = created.metadata.uid
    state.changes.key = true
    save()
    const data = {
      NODE_ENV: 'test',
      EVENFIRE_IMAGE_CAPABILITIES_FIXTURE: '1',
      IMAGE_CAPABILITIES_RUN_ID: state.runId,
      IMAGE_CAPABILITIES_CREDENTIAL_SHA256: keyHash,
      MINIKUBE_PROFILE: profile,
      CONTROL_API_REAL_PG_CONTEXT: profile,
    }
    state.appliedConfig = data
    state.appliedHost = {
      model: { provider: 'zai', name: 'glm-5.3-flash' },
      allowedModels: models.map(({ provider, model }) => ({ provider, model })),
      secretRef: state.runId,
    }
    state.changes.config = true
    save()
    const liveConfig = get('mcp-host', 'configmap', 'mcp-host-config')
    if (
      liveConfig.metadata.uid !== state.config.uid ||
      fixtureConfigKeys.some(key => liveConfig.data?.[key] !== state.config.data[key])
    )
      throw new Error('Host configuration changed before fixture preparation')
    patch('mcp-host', 'configmap', 'mcp-host-config', [
      ...stamp(liveConfig),
      annotate(liveConfig),
      ...Object.entries(data).map(([key, value]) => ({ op: 'add', path: `/data/${key}`, value })),
    ])
    state.changes.host = true
    save()
    const liveHost = get('mcp-host', 'host', 'chatllm')
    if (
      liveHost.metadata.uid !== state.host.uid ||
      ['model', 'allowedModels', 'secretRef', 'llmPolicy'].some(
        key => !isDeepStrictEqual(liveHost.spec[key], state.host[key])
      )
    )
      throw new Error('Host changed before fixture preparation')
    patch('mcp-host', 'host', 'chatllm', [
      ...stamp(liveHost),
      annotate(liveHost),
      { op: 'add', path: '/spec/model', value: { provider: 'zai', name: 'glm-5.3-flash' } },
      {
        op: 'add',
        path: '/spec/allowedModels',
        value: models.map(({ provider, model }) => ({ provider, model })),
      },
      { op: 'add', path: '/spec/secretRef', value: state.runId },
      ...(host.spec.llmPolicy === undefined ? [] : [{ op: 'remove', path: '/spec/llmPolicy' }]),
    ])
    state.changes.hcc = true
    save()
    const liveHcc = get('control-plane', 'deployment', 'host-context-controller')
    if (liveHcc.metadata.uid !== state.hcc.uid)
      throw new Error('HCC replaced before fixture preparation')
    patch('control-plane', 'deployment', 'host-context-controller', [
      ...stamp(liveHcc),
      annotate(liveHcc),
      {
        op: 'test',
        path: state.hcc.path.replace(/value$/, 'name'),
        value: 'CONTEXT_MAPPER_HOST_IMAGE',
      },
      { op: 'test', path: state.hcc.path, value: state.hcc.image },
      { op: 'replace', path: state.hcc.path, value: fixtureImage },
    ])
    kc([
      '-n',
      'control-plane',
      'rollout',
      'status',
      'deployment/host-context-controller',
      '--timeout=120s',
    ])
    await waitHostImage(fixtureImage)
    const wire = JSON.parse(
      kc([
        '-n',
        'mcp-host',
        'exec',
        'deployment/chatllm',
        '--',
        'cat',
        '/tmp/image-capabilities-evidence.json',
      ])
    )
    if (wire.runId !== state.runId || wire.profile !== profile)
      throw new Error('Fixture runtime marker mismatch')
    const environment = {
      ...process.env,
      NODE_ENV: 'test',
      IMAGE_CAPABILITIES_RUN_ID: state.runId,
      IMAGE_CAPABILITIES_RUN_DIR: evidence,
      E2E_HOST_REF: 'chatllm',
      E2E_DEV_LOGIN_EMAIL: 'admin@evenfire.local',
      E2E_DESKTOP_PASSWORD: ADMIN_PASSWORD,
      EXTERNAL_REST_API_BASE_URL: urlFor('external-rest-api'),
      RPC_PROXY_BASE_URL: urlFor('rpc-proxy'),
      QA_RECORDER_CONFIRM_CHAT: '1',
      QA_RECORDER_IMAGE_MODEL_SUPPORTED: 'glm-5.3-flash',
      QA_RECORDER_IMAGE_MODEL_UNSUPPORTED: 'glm-5.3',
      QA_RECORDER_IMAGE_MODEL_UNKNOWN: models[2].model,
      QA_RECORDER_ROOT: evidence,
    }
    command('npm', ['run', 'verify:electron', '--prefix', 'desktop-app'])
    process.stdout.write(`Image capability fixture ready: ${state.runId}\n`)
    const output = command(
      'node',
      [
        'scripts/minikube/run-with-deadline.mjs',
        '--timeout-seconds',
        '900',
        '--heartbeat-seconds',
        '20',
        '--kill-grace-seconds',
        '5',
        '--label',
        'image-capabilities-playwright',
        '--',
        'node',
        'desktop-app/node_modules/@playwright/test/cli.js',
        'test',
        '--config=desktop-app/test/e2e-playwright/playwright.image-capabilities.config.ts',
      ],
      { env: environment, timeout: 930_000 }
    )
    const file = openOwnedFile(evidence, 'playwright.log', { create: true })
    try {
      fs.writeFileSync(file.fd, output)
    } finally {
      fs.closeSync(file.fd)
    }
    state.playwright = 'PASS'
    save()
  } catch (error) {
    failure = error
  }
  try {
    await restore()
  } catch (error) {
    failure ??= error
  }
  if (failure) throw failure
  process.stdout.write(`IMAGE_CAPABILITIES_E2E_PASS evidence=${evidence}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`Image capability fixture stopped: ${error.message}\n`)
    process.exitCode = 1
  })
}
