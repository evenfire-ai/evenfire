import assert from 'node:assert/strict'
import test from 'node:test'
import {
  captureControlApi,
  controlApiFixtureEnv,
  controlApiFixtureImage,
  controlApiFixtureMountPath,
  controlApiFixtureVolume,
  controlApiPatch,
  controlApiRunAnnotation,
  recoverControlApiForCleanup,
  restoreControlApi,
  validateControlApiPatch,
} from './approved-tools-control-api-lifecycle.mjs'
import {
  controlApiMarkerCheck,
  restoreOwnedFixture,
  validateKubectlArgs,
} from './prepare-codex-approved-tools.mjs'

const profile = 'clerum-approved-tools-a1b2c3d4'
const run = 'approved-tools-a1b2c3d4e5f6'
function deployment() {
  return {
    metadata: { uid: 'api-uid', resourceVersion: '123' },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: 'control-api',
              image: 'clerum/control-api:test',
              imagePullPolicy: 'Never',
              env: [
                { name: 'NODE_ENV', value: 'production' },
                { name: 'UNRELATED', value: 'preserved' },
              ],
            },
          ],
        },
      },
    },
  }
}
function fixture() {
  const d = deployment()
  d.spec.template.metadata = { annotations: { [controlApiRunAnnotation]: run } }
  d.spec.template.spec.containers[0].image = controlApiFixtureImage
  d.spec.template.spec.containers[0].env = controlApiFixtureEnv(run, profile)
  d.spec.template.spec.volumes = [{ name: controlApiFixtureVolume, emptyDir: {} }]
  d.spec.template.spec.containers[0].volumeMounts = [
    { name: controlApiFixtureVolume, mountPath: controlApiFixtureMountPath },
  ]
  return d
}
test('fixture patch mounts a writable /tmp for the activation marker and restore deletes it', () => {
  const install = controlApiPatch({
    metadata: deployment().metadata,
    image: controlApiFixtureImage,
    imagePullPolicy: 'Never',
    env: controlApiFixtureEnv(run, profile),
    run,
  })
  assert.doesNotThrow(() => validateControlApiPatch(install, profile))
  assert.deepEqual(install.spec.template.spec.volumes, [
    { name: controlApiFixtureVolume, emptyDir: {} },
  ])
  assert.deepEqual(install.spec.template.spec.containers[0].volumeMounts, [
    { name: controlApiFixtureVolume, mountPath: '/tmp' },
  ])
  const original = captureControlApi(deployment(), profile)
  const restore = controlApiPatch({ ...original, run: null })
  assert.doesNotThrow(() => validateControlApiPatch(restore, profile))
  assert.deepEqual(restore.spec.template.spec.volumes, [
    { name: controlApiFixtureVolume, $patch: 'delete' },
  ])
  assert.deepEqual(restore.spec.template.spec.containers[0].volumeMounts, [
    { mountPath: '/tmp', $patch: 'delete' },
  ])
  for (const mutate of [
    p => {
      p.spec.template.spec.volumes = []
    },
    p => {
      p.spec.template.spec.volumes[0] = { name: controlApiFixtureVolume, hostPath: { path: '/' } }
    },
    p => {
      p.spec.template.spec.containers[0].volumeMounts[0].mountPath = '/app'
    },
    p => {
      delete p.spec.template.spec.containers[0].volumeMounts
    },
  ]) {
    const p = structuredClone(install)
    mutate(p)
    assert.throws(() => validateControlApiPatch(p, profile), /Unexpected Control API patch fields/)
  }
})
test('an original deployment that already uses the fixture volume or /tmp is refused', async () => {
  for (const mutate of [
    d => {
      d.spec.template.spec.volumes = [{ name: controlApiFixtureVolume, emptyDir: {} }]
    },
    d => {
      d.spec.template.spec.containers[0].volumeMounts = [{ name: 'scratch', mountPath: '/tmp' }]
    },
  ]) {
    const d = deployment()
    mutate(d)
    assert.throws(() => captureControlApi(d, profile), /test ownership/)
    const original = captureControlApi(deployment(), profile)
    const calls = []
    await assert.rejects(
      restoreControlApi({
        state: { run, controlApi: original },
        profile,
        get: () => {
          calls.push('get')
          return d
        },
        patch: () => assert.fail(),
        wait: () => assert.fail(),
      }),
      /original deployment does not match/
    )
    assert.deepEqual(calls, ['get'])
  }
})
test('snapshot captures only restorable affected bindings and refuses unsafe originals', () => {
  const original = captureControlApi(deployment(), profile)
  assert.equal(JSON.stringify(original).includes('UNRELATED'), false)
  for (const mutate of [
    d => {
      d.spec.template.spec.containers[0].image = 'foreign/image:test'
    },
    d => {
      d.spec.template.spec.containers[0].env[0] = {
        name: 'NODE_ENV',
        valueFrom: { secretKeyRef: { name: 'secret', key: 'env' } },
      }
    },
    d => {
      d.metadata.resourceVersion = ''
    },
  ]) {
    const d = deployment()
    mutate(d)
    assert.throws(() => captureControlApi(d, profile))
  }
})
test('kubectl permits only the exact guarded Control API patch', () => {
  const patch = controlApiPatch({
    metadata: deployment().metadata,
    image: controlApiFixtureImage,
    imagePullPolicy: 'Never',
    env: controlApiFixtureEnv(run, profile),
    run,
  })
  const args = p => [
    `--context=${profile}`,
    '--request-timeout=30s',
    '-n',
    'control-plane',
    'patch',
    'deployment/control-api',
    '--type=strategic',
    '-p',
    JSON.stringify(p),
  ]
  assert.doesNotThrow(() => validateKubectlArgs(args(patch), profile))
  for (const mutate of [
    p => {
      p.metadata.resourceVersion = ''
    },
    p => {
      p.spec.replicas = 0
    },
    p => {
      p.spec.template.spec.containers[0].env.pop()
    },
    p => {
      p.spec.template.spec.containers[0].env[0].value = 'production'
    },
    p => {
      p.spec.template.metadata.annotations[controlApiRunAnnotation] = null
    },
  ]) {
    const p = structuredClone(patch)
    mutate(p)
    assert.throws(() => validateKubectlArgs(args(p), profile))
  }
})
test('restore uses current resourceVersion, original affected env, and waits for Ready', async () => {
  const original = captureControlApi(deployment(), profile)
  const live = fixture()
  live.metadata.resourceVersion = '124'
  const calls = []
  await restoreControlApi({
    state: { run, controlApi: original },
    profile,
    get: () => live,
    patch: p => {
      validateControlApiPatch(p, profile)
      calls.push(p)
    },
    wait: () => calls.push('ready'),
  })
  assert.equal(calls[0].metadata.resourceVersion, '124')
  assert.deepEqual(calls[0].spec.template.spec.containers[0].env, original.env)
  assert.equal(calls[1], 'ready')
  live.spec.template.metadata.annotations[controlApiRunAnnotation] = 'approved-tools-000000000000'
  await assert.rejects(
    restoreControlApi({
      state: { run, controlApi: original },
      profile,
      get: () => live,
      patch: () => assert.fail(),
      wait: () => assert.fail(),
    }),
    /binding changed/
  )
})
test('cleanup orders resources then identities then API and restores API despite failures', async () => {
  for (const fail of [null, 'resources', 'identities', 'api']) {
    const calls = []
    const state = {
      profile,
      worktree: '/owned',
      head: 'head',
      run,
      proxyUid: 'proxy',
      originalProxyImage: 'clerum/codex-llm-proxy:test',
      identitySeedStarted: true,
      identityJournal: { status: 'created' },
      controlApi: {},
      resources: [{}],
      forwards: [],
    }
    const adapters = {
      state,
      profile,
      worktree: '/owned',
      head: 'head',
      getDeployment: () => ({
        metadata: { uid: 'proxy' },
        spec: {
          template: {
            spec: { containers: [{ name: 'codex-llm-proxy', image: state.originalProxyImage }] },
          },
        },
      }),
      waitProxyRollout: () => {},
      cleanupResources: () => {
        calls.push('resources')
        if (fail === 'resources') throw Error('resources')
      },
      cleanupIdentities: () => {
        calls.push('identities')
        if (fail === 'identities') throw Error('identities')
        state.identityJournal.status = 'cleaned'
      },
      restoreApi: () => {
        calls.push('api')
        if (fail === 'api') throw Error('api')
      },
    }
    if (fail) await assert.rejects(restoreOwnedFixture(adapters))
    else await restoreOwnedFixture(adapters)
    assert.deepEqual(
      calls,
      fail === 'resources' ? ['resources', 'api'] : ['resources', 'identities', 'api']
    )
    assert.equal(state.restored, fail === null)
  }
})

test('live marker probe is allowlisted exactly and validates the active run and process', () => {
  const args = source => [
    `--context=${profile}`,
    '--request-timeout=30s',
    '-n',
    'control-plane',
    'exec',
    'deployment/control-api',
    '--',
    'node',
    '-e',
    source,
  ]
  assert.doesNotThrow(() => validateKubectlArgs(args(controlApiMarkerCheck), profile))
  assert.throws(() =>
    validateKubectlArgs(args(controlApiMarkerCheck + ';process.exit(0)'), profile)
  )
  const probe = new Function('require', 'process', controlApiMarkerCheck)
  const marker = { run, profile, pid: 1 }
  const env = Object.fromEntries(controlApiFixtureEnv(run, profile).map(e => [e.name, e.value]))
  env.KUBERNETES_SERVICE_HOST = '10.0.0.1'
  let output
  const proc = {
    env,
    kill: pid => assert.equal(pid, 1),
    stdout: {
      write: value => {
        output = JSON.parse(value)
      },
    },
  }
  const requireFixture = () => ({
    readFileSync: filename => {
      assert.equal(filename, '/tmp/approved-tools-oauth-active.json')
      return JSON.stringify(marker)
    },
  })
  probe(requireFixture, proc)
  assert.deepEqual(output, marker)
  marker.run = 'approved-tools-000000000000'
  assert.throws(() => probe(requireFixture, proc), /Invalid fixture marker/)
  marker.run = run
  marker.pid = 2
  assert.throws(() => probe(requireFixture, proc), /Invalid fixture marker/)
})

function recoveryState() {
  return {
    profile,
    worktree: '/owned',
    head: 'head',
    run,
    proxyUid: 'proxy',
    originalProxyImage: 'clerum/codex-llm-proxy:test',
    identitySeedStarted: true,
    identityJournal: { run, profile, context: profile, status: 'created' },
    controlApi: captureControlApi(deployment(), profile),
    resources: [],
    forwards: [],
  }
}
test('identity cleanup retry reinstalls the guarded API and restores it after both failed and successful attempts', async () => {
  const state = recoveryState()
  let live = fixture()
  let attempt = 0
  const mutations = []
  const api = {
    state,
    profile,
    get: () => live,
    patch: p => {
      validateControlApiPatch(p, profile)
      assert.equal(p.metadata.resourceVersion, live.metadata.resourceVersion)
      mutations.push(p.spec.template.spec.containers[0].image)
      live = {
        metadata: {
          ...p.metadata,
          resourceVersion: String(Number(p.metadata.resourceVersion) + 1),
        },
        spec: structuredClone(p.spec),
      }
      const c = live.spec.template.spec.containers[0]
      c.env = c.env.filter(e => e.$patch !== 'delete')
      c.volumeMounts = c.volumeMounts.filter(m => m.$patch !== 'delete')
      live.spec.template.spec.volumes = live.spec.template.spec.volumes.filter(
        v => v.$patch !== 'delete'
      )
      if (live.spec.template.metadata.annotations[controlApiRunAnnotation] === null)
        delete live.spec.template.metadata.annotations[controlApiRunAnnotation]
    },
    wait: () => {},
    verify: () => assert.equal(live.spec.template.spec.containers[0].image, controlApiFixtureImage),
  }
  const adapters = {
    state,
    profile,
    worktree: '/owned',
    head: 'head',
    getDeployment: () => ({
      metadata: { uid: 'proxy' },
      spec: {
        template: {
          spec: { containers: [{ name: 'codex-llm-proxy', image: state.originalProxyImage }] },
        },
      },
    }),
    waitProxyRollout: () => {},
    cleanupResources: () => {},
    cleanupIdentities: async () => {
      if (!(await recoverControlApiForCleanup(api))) return
      if (attempt++ === 0) throw Error('identity cleanup interrupted')
      state.identityJournal.status = 'cleaned'
    },
    restoreApi: () => restoreControlApi(api),
  }
  await assert.rejects(restoreOwnedFixture(adapters), /identity cleanup interrupted/)
  assert.equal(state.restored, false)
  assert.equal(live.spec.template.spec.containers[0].image, state.controlApi.image)
  await restoreOwnedFixture(adapters)
  assert.equal(state.restored, true)
  assert.deepEqual(mutations, [
    state.controlApi.image,
    controlApiFixtureImage,
    state.controlApi.image,
  ])
  await restoreOwnedFixture(adapters)
  assert.equal(mutations.length, 3)
})
test('recovery refuses changed original deployment, foreign run and unfinished resources before mutation', async () => {
  for (const mutate of [
    (s, d) => {
      d.metadata.uid = 'foreign'
    },
    (s, d) => {
      d.spec.template.spec.containers[0].image = 'clerum/control-api:other'
    },
    (s, d) => {
      d.spec.template.spec.containers[0].imagePullPolicy = 'Always'
    },
    (s, d) => {
      d.spec.template.spec.containers[0].env[0].value = 'development'
    },
    (s, d) => {
      d.spec.template.metadata = {
        annotations: { [controlApiRunAnnotation]: 'approved-tools-000000000000' },
      }
    },
    s => {
      s.resources = [{ status: 'created' }]
    },
    s => {
      s.identityJournal.run = 'approved-tools-000000000000'
    },
  ]) {
    const state = recoveryState()
    const live = deployment()
    mutate(state, live)
    const calls = []
    await assert.rejects(
      recoverControlApiForCleanup({
        state,
        profile,
        get: () => live,
        patch: () => calls.push('patch'),
        wait: () => calls.push('wait'),
        verify: () => calls.push('verify'),
      })
    )
    assert.deepEqual(calls, [])
  }
})
