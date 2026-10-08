import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  baseImage,
  fixtureImage,
  fixturePassLine,
  installSignalRestore,
  laneRuntime,
  legacyLeaseReplicaPlan,
  legacyLeaseVacuity,
  legacyLeaseVacuityManifestPath,
  modelInputs,
  playwrightLaneConfig,
  playwrightVerdict,
  proveImages,
  proveVacuityImages,
  requireOwnedResource,
  runAnnotation,
  sanitizeFixtureReport,
  selectFixtureAction,
} from './image-capabilities-fixture.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const laneConfigFile = lane =>
  path.join(repoRoot, playwrightLaneConfig({ IMAGE_CAPABILITIES_LANE: lane }).config)
function playwrightReport({ lane = 'image', stats = {}, errors = [], titles } = {}) {
  const { grep } = playwrightLaneConfig({ IMAGE_CAPABILITIES_LANE: lane })
  const specTitles = titles ?? [`${grep}a journey`]
  return {
    config: { configFile: laneConfigFile(lane) },
    suites: [
      {
        title: 'qa-recorder.spec.ts',
        specs: specTitles.map(title => ({ title, ok: true })),
        suites: [],
      },
    ],
    errors,
    stats: { expected: specTitles.length, skipped: 0, unexpected: 0, flaky: 0, ...stats },
  }
}

const head = 'a'.repeat(40)
const profile = 'clerum-image-fixture-12345678'
const ids = { [baseImage]: `sha256:${'b'.repeat(64)}`, [fixtureImage]: `sha256:${'c'.repeat(64)}` }
function manifest() {
  return {
    profile,
    images: { ...ids },
    sourceRevisions: { [baseImage]: head, [fixtureImage]: head },
    derivedFrom: { [fixtureImage]: { ref: baseImage, id: ids[baseImage] } },
  }
}

test('the Playwright lane defaults to the image journey and accepts only known lanes', () => {
  assert.deepEqual(playwrightLaneConfig({}), {
    lane: 'image',
    config: 'desktop-app/test/e2e-playwright/playwright.image-capabilities.config.ts',
    label: 'image-capabilities-playwright',
    grep: 'image-capabilities fixture: ',
  })
  assert.deepEqual(playwrightLaneConfig({ IMAGE_CAPABILITIES_LANE: 'document-upload' }), {
    lane: 'document-upload',
    config: 'desktop-app/test/e2e-playwright/playwright.document-upload.config.ts',
    label: 'document-upload-playwright',
    grep: 'document-upload fixture: ',
  })
  for (const lane of ['', 'documents', '../evil.config.ts', '__proto__', 'toString']) {
    assert.throws(
      () => playwrightLaneConfig({ IMAGE_CAPABILITIES_LANE: lane }),
      /IMAGE_CAPABILITIES_LANE must be one of image, document-upload/,
      lane
    )
  }
})

test('restore never resolves the Playwright lane, so a stale or invalid lane cannot block restoration', () => {
  for (const lane of [undefined, 'image', 'typo', '', '__proto__', '../evil.config.ts']) {
    const env = lane === undefined ? {} : { IMAGE_CAPABILITIES_LANE: lane }
    // Witness: the restore path was selected, and it carries no lane at all.
    assert.deepEqual(selectFixtureAction('restore', env), { action: 'restore' }, String(lane))
  }
})

test('run still resolves and validates the Playwright lane', () => {
  assert.deepEqual(selectFixtureAction(undefined, {}), {
    action: 'run',
    ...playwrightLaneConfig({}),
  })
  assert.deepEqual(selectFixtureAction('run', { IMAGE_CAPABILITIES_LANE: 'document-upload' }), {
    action: 'run',
    ...playwrightLaneConfig({ IMAGE_CAPABILITIES_LANE: 'document-upload' }),
  })
  for (const lane of ['typo', '', '__proto__']) {
    assert.throws(
      () => selectFixtureAction('run', { IMAGE_CAPABILITIES_LANE: lane }),
      /IMAGE_CAPABILITIES_LANE must be one of image, document-upload/,
      lane
    )
  }
  assert.throws(() => selectFixtureAction('cleanup', {}), /Expected run or restore/)
})

test('the PASS line names the lane only when the persisted state was produced by that lane', () => {
  const evidence = '/runs/image-capabilities-0123456789ab'
  const state = { lane: 'document-upload', playwright: 'PASS', restored: true }
  // Witness: a state written by the requested lane yields the lane-bearing PASS line.
  assert.equal(
    fixturePassLine(state, { lane: 'document-upload', evidence }),
    `IMAGE_CAPABILITIES_E2E_PASS lane=document-upload evidence=${evidence}\n`
  )
  for (const [label, mutated] of [
    ['other lane', { ...state, lane: 'image' }],
    ['missing lane', { playwright: 'PASS', restored: true }],
    [
      'inherited lane',
      Object.assign(Object.create({ lane: 'document-upload' }), {
        playwright: 'PASS',
        restored: true,
      }),
    ],
  ]) {
    assert.throws(
      () => fixturePassLine(mutated, { lane: 'document-upload', evidence }),
      /Run state lane mismatch/,
      label
    )
  }
  assert.throws(
    () =>
      fixturePassLine({ ...state, playwright: undefined }, { lane: 'document-upload', evidence }),
    /Run state has no Playwright PASS/
  )
  assert.throws(
    () => fixturePassLine({ ...state, restored: false }, { lane: 'document-upload', evidence }),
    /Run state was not restored/
  )
})

test('the Playwright verdict is PASS only for a complete, clean report from the lane config', () => {
  // Witness: a clean run of the requested lane is PASS.
  assert.equal(
    playwrightVerdict(playwrightReport(), { lane: 'image', configFile: laneConfigFile('image') }),
    'PASS'
  )
  assert.equal(
    playwrightVerdict(playwrightReport({ lane: 'document-upload' }), {
      lane: 'document-upload',
      configFile: laneConfigFile('document-upload'),
    }),
    'PASS'
  )
  const options = { lane: 'image', configFile: laneConfigFile('image') }
  for (const [label, report, pattern] of [
    ['zero tests', playwrightReport({ titles: [] }), /Playwright ran no expected tests/],
    [
      'all skipped',
      playwrightReport({ stats: { expected: 0, skipped: 1 } }),
      /Playwright ran no expected tests/,
    ],
    ['one skipped', playwrightReport({ stats: { skipped: 1 } }), /skipped=1/],
    ['one unexpected', playwrightReport({ stats: { unexpected: 1 } }), /unexpected=1/],
    ['one flaky', playwrightReport({ stats: { flaky: 1 } }), /flaky=1/],
    [
      'non-integer count',
      playwrightReport({ stats: { expected: '1' } }),
      /Playwright ran no expected tests/,
    ],
    [
      'missing stats',
      { ...playwrightReport(), stats: undefined },
      /Playwright ran no expected tests/,
    ],
    ['global error', playwrightReport({ errors: [{ message: 'boom' }] }), /global errors/],
    [
      'other lane config',
      { ...playwrightReport(), config: { configFile: laneConfigFile('document-upload') } },
      /config mismatch/,
    ],
    ['missing config', { ...playwrightReport(), config: {} }, /config mismatch/],
    [
      'spec outside the lane selection',
      playwrightReport({
        titles: ['image-capabilities fixture: a journey', 'optional QA recorder: real'],
      }),
      /outside the image lane/,
    ],
    [
      'malformed suites',
      { ...playwrightReport(), suites: undefined },
      /Incomplete Playwright suites/,
    ],
  ]) {
    assert.throws(() => playwrightVerdict(report, options), pattern, label)
  }
})

test('the Playwright verdict fails a report whose suites list fewer specs than it counted', () => {
  const options = { lane: 'image', configFile: laneConfigFile('image') }
  const titles = ['a', 'b', 'c'].map(name => `image-capabilities fixture: ${name}`)
  // Witness: the complete report of three expected specs is PASS.
  assert.equal(playwrightVerdict(playwrightReport({ titles }), options), 'PASS')
  for (const [label, suites] of [
    ['empty suites', []],
    [
      'truncated suites',
      [{ title: 'qa-recorder.spec.ts', specs: [{ title: titles[0], ok: true }], suites: [] }],
    ],
  ]) {
    const report = { ...playwrightReport({ titles }), suites }
    assert.equal(report.stats.expected, 3, label)
    assert.throws(
      () => playwrightVerdict(report, options),
      /Playwright report lists \d specs for 3 expected tests/,
      label
    )
  }
})

test('requires both exact source revisions and the live derived-base identity', () => {
  assert.deepEqual(proveImages(manifest(), ids, head, profile), { head, profile, images: ids })
  for (const mutate of [
    value => {
      value.profile = 'foreign-profile'
    },
    value => {
      value.sourceRevisions[baseImage] = 'd'.repeat(40)
    },
    value => {
      value.sourceRevisions[fixtureImage] = 'd'.repeat(40)
    },
    value => {
      value.derivedFrom[fixtureImage].id = `sha256:${'d'.repeat(64)}`
    },
    value => {
      value.images[`docker.io/${fixtureImage}`] = `sha256:${'d'.repeat(64)}`
    },
  ]) {
    const changed = manifest()
    mutate(changed)
    assert.throws(() => proveImages(changed, ids, head, profile))
  }
  assert.throws(() =>
    proveImages(manifest(), { ...ids, [fixtureImage]: `sha256:${'d'.repeat(64)}` }, head, profile)
  )
})

test('fixture catalog declares supported, unsupported and run-scoped unknown without provider-wide inference', () => {
  const rows = modelInputs('image-capabilities-123456abcdef')
  assert.deepEqual(
    rows.map(row => [row.model, row.image_input.state]),
    [
      ['glm-5.3-flash', 'supported'],
      ['glm-5.3', 'unsupported'],
      ['image-fixture-unknown-123456abcdef', 'unknown'],
    ]
  )
  assert.ok(
    rows.every(
      row =>
        row.provider === 'zai' &&
        row.image_input.evidence.reference === 'evidence:image-capabilities-123456abcdef'
    )
  )
  assert.throws(() => modelInputs('../foreign'))
})

test('restoration refuses recreated or foreign-owned Kubernetes resources', () => {
  const resource = { metadata: { uid: 'original', annotations: { [runAnnotation]: 'our-run' } } }
  requireOwnedResource(resource, 'original', 'our-run')
  assert.throws(() => requireOwnedResource(resource, 'replaced', 'our-run'))
  assert.throws(() => requireOwnedResource(resource, 'original', 'another-run'))
  assert.throws(() =>
    requireOwnedResource({ metadata: { uid: 'original' } }, 'original', 'our-run')
  )
})

function signalTarget() {
  const target = new EventEmitter()
  target.exits = []
  target.exit = code => target.exits.push(code)
  return target
}

for (const [signal, code] of [
  ['SIGTERM', 143],
  ['SIGINT', 130],
]) {
  test(`a ${signal} runs restoration once and exits ${code}`, async () => {
    const target = signalTarget()
    const messages = []
    let calls = 0
    installSignalRestore(
      target,
      async () => {
        calls += 1
      },
      text => messages.push(text)
    )
    target.emit(signal, signal)
    target.emit(signal, signal)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 1)
    assert.deepEqual(target.exits, [code])
    assert.match(messages.join(''), new RegExp(`interrupted by ${signal}`))
  })
}

test('a failed restoration exits 1 and reports the message', async () => {
  const target = signalTarget()
  const messages = []
  installSignalRestore(
    target,
    async () => {
      throw new Error('deployment/chatllm rollback timed out')
    },
    text => messages.push(text)
  )
  target.emit('SIGTERM', 'SIGTERM')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(target.exits, [1])
  assert.match(messages.join(''), /restoration failed: deployment\/chatllm rollback timed out/)
})

test('uninstalling removes both signal handlers', () => {
  const target = signalTarget()
  const uninstall = installSignalRestore(
    target,
    async () => {},
    () => {}
  )
  assert.equal(target.listenerCount('SIGINT'), 1)
  assert.equal(target.listenerCount('SIGTERM'), 1)
  uninstall()
  assert.equal(target.listenerCount('SIGINT'), 0)
  assert.equal(target.listenerCount('SIGTERM'), 0)
})

test('the playwright log redacts the admin password, the session cookie and bearer-shaped tokens', () => {
  const password = 'fixture-admin-password-4c1e'
  const cookie = 'sid=9f3a7c2e1b'
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.c2lnbmF0dXJl'
  const output = [
    `login with ${password}`,
    `session ${cookie} established`,
    `token ${jwt} issued`,
    'Authorization: Bearer opaque-bearer-value',
    '3 passed (41.2s)',
  ].join('\n')
  const report = sanitizeFixtureReport(output, [password, cookie])
  assert.ok(!report.includes(password))
  assert.ok(!report.includes(cookie))
  assert.ok(!report.includes(jwt))
  assert.ok(!report.includes('opaque-bearer-value'))
  assert.match(report, /3 passed \(41\.2s\)/)
})

// ---------------------------------------------------------------------------
// Issue #1022: legacy processing-lease restart lanes.
// ---------------------------------------------------------------------------

test('the legacy-lease lanes share one config and select disjoint journeys', () => {
  const fixed = playwrightLaneConfig({ IMAGE_CAPABILITIES_LANE: 'legacy-lease-restart' })
  const vacuity = playwrightLaneConfig({ IMAGE_CAPABILITIES_LANE: 'legacy-lease-restart-vacuity' })
  assert.equal(
    fixed.config,
    'desktop-app/test/e2e-playwright/playwright.legacy-lease-restart.config.ts'
  )
  assert.equal(vacuity.config, fixed.config)
  assert.equal(fixed.grep, 'legacy-lease-restart fixture: ')
  assert.equal(vacuity.grep, 'legacy-lease-restart vacuity: ')
  assert.equal(vacuity.grep.startsWith(fixed.grep), false)
  assert.equal(fixed.grep.startsWith(vacuity.grep), false)
  const options = {
    lane: 'legacy-lease-restart',
    configFile: laneConfigFile('legacy-lease-restart'),
  }
  const scenarioTitles = ['S-crash', 'S-graceful', 'S-hcc', 'S-gfs', 'S-update'].map(
    scenario => `legacy-lease-restart fixture: ${scenario}`
  )
  // Witness: the lane's own five scenario titles are PASS.
  assert.equal(
    playwrightVerdict(
      playwrightReport({ lane: 'legacy-lease-restart', titles: scenarioTitles }),
      options
    ),
    'PASS'
  )
  // A clean report that lost scenarios is not the lane.
  assert.throws(
    () =>
      playwrightVerdict(
        playwrightReport({ lane: 'legacy-lease-restart', titles: scenarioTitles.slice(0, 2) }),
        options
      ),
    /lists 2 legacy-lease-restart specs, expected 5/
  )
  // The vacuity lane is exactly its one S-crash journey.
  assert.equal(
    playwrightVerdict(
      playwrightReport({
        lane: 'legacy-lease-restart-vacuity',
        titles: ['legacy-lease-restart vacuity: S-crash'],
      }),
      {
        lane: 'legacy-lease-restart-vacuity',
        configFile: laneConfigFile('legacy-lease-restart-vacuity'),
      }
    ),
    'PASS'
  )
  // A vacuity title in the fixed lane's report is outside that lane.
  assert.throws(
    () =>
      playwrightVerdict(
        playwrightReport({
          lane: 'legacy-lease-restart',
          titles: ['legacy-lease-restart vacuity: S-crash'],
        }),
        options
      ),
    /outside the legacy-lease-restart lane/
  )
})

test('each lane runtime names its Host image and deadline; existing lanes are unchanged', () => {
  for (const lane of ['image', 'document-upload']) {
    assert.deepEqual(laneRuntime(lane), { fixtureImage, timeoutSeconds: 900, legacyLease: null })
  }
  assert.deepEqual(laneRuntime('legacy-lease-restart'), {
    fixtureImage,
    timeoutSeconds: 3600,
    legacyLease: 'fixed',
  })
  assert.deepEqual(laneRuntime('legacy-lease-restart-vacuity'), {
    fixtureImage: 'clerum/image-capabilities-mcp-host:legacy-lease-vacuity',
    timeoutSeconds: 900,
    legacyLease: 'vacuity',
  })
  // The vacuity images never reuse a HEAD tag.
  assert.notEqual(legacyLeaseVacuity.fixtureImage, fixtureImage)
  assert.notEqual(legacyLeaseVacuity.baseImage, baseImage)
  for (const lane of ['typo', '__proto__', '']) {
    assert.throws(() => laneRuntime(lane), /Unknown lane/, lane)
  }
})

test('the vacuity manifest lives under the canonical run root, per profile', () => {
  assert.equal(
    legacyLeaseVacuityManifestPath('/repo/evenfire', profile),
    `/repo/evenfire/.local-notes/infra/runs/legacy-lease-vacuity/${profile}/manifest.json`
  )
})

const vacuityIds = {
  [legacyLeaseVacuity.baseImage]: `sha256:${'e'.repeat(64)}`,
  [legacyLeaseVacuity.fixtureImage]: `sha256:${'f'.repeat(64)}`,
}
function vacuityManifest() {
  return {
    kind: 'legacy-lease-vacuity',
    profile,
    baseRevision: '74e0d81d9b70bbc0e123ed2bad89f08d3e13e99e',
    fixtureLayerRevision: head,
    images: { ...vacuityIds },
    derivedFrom: {
      [legacyLeaseVacuity.fixtureImage]: {
        ref: legacyLeaseVacuity.baseImage,
        id: vacuityIds[legacyLeaseVacuity.baseImage],
      },
    },
  }
}

test('vacuity images must come from the pre-fix base and this HEAD, for this profile', () => {
  // Witness: the well-formed manifest is proven.
  assert.deepEqual(proveVacuityImages(vacuityManifest(), vacuityIds, head, profile), {
    head,
    profile,
    baseRevision: '74e0d81d9b70bbc0e123ed2bad89f08d3e13e99e',
    images: vacuityIds,
  })
  for (const [label, mutate, pattern] of [
    ['other kind', value => (value.kind = 'image-manifest'), /ownership/],
    ['other profile', value => (value.profile = 'clerum-other-12345678'), /ownership/],
    ['built from HEAD', value => (value.baseRevision = head), /pre-fix base/],
    ['stale fixture layer', value => (value.fixtureLayerRevision = 'd'.repeat(40)), /this HEAD/],
    [
      'other base id',
      value => (value.images[legacyLeaseVacuity.baseImage] = `sha256:${'1'.repeat(64)}`),
      /identity/,
    ],
    [
      'fixture from another base',
      value => (value.derivedFrom[legacyLeaseVacuity.fixtureImage].id = `sha256:${'2'.repeat(64)}`),
      /derived-base/,
    ],
    [
      'fixture from the HEAD Host',
      value => (value.derivedFrom[legacyLeaseVacuity.fixtureImage].ref = baseImage),
      /derived-base/,
    ],
  ]) {
    const changed = vacuityManifest()
    mutate(changed)
    assert.throws(() => proveVacuityImages(changed, vacuityIds, head, profile), pattern, label)
  }
  // The node holds a different image than the manifest recorded.
  assert.throws(
    () =>
      proveVacuityImages(
        vacuityManifest(),
        { ...vacuityIds, [legacyLeaseVacuity.fixtureImage]: `sha256:${'3'.repeat(64)}` },
        head,
        profile
      ),
    /identity/
  )
  // A HEAD image manifest is never accepted as a vacuity proof.
  assert.throws(() => proveVacuityImages(manifest(), ids, head, profile), /ownership/)
})

test('restoration scales the Host before HCC and never accepts zero as restored', () => {
  const recorded = { host: 1, hcc: 1 }
  // Witness: both at zero yields a plan, Host first.
  assert.deepEqual(legacyLeaseReplicaPlan(recorded, { host: 0, hcc: 0 }), [
    { key: 'host', replicas: 1 },
    { key: 'hcc', replicas: 1 },
  ])
  assert.deepEqual(legacyLeaseReplicaPlan(recorded, { host: 1, hcc: 0 }), [
    { key: 'hcc', replicas: 1 },
  ])
  assert.deepEqual(legacyLeaseReplicaPlan(recorded, { host: 1, hcc: 1 }), [])
  for (const [label, bad] of [
    ['zero host', { host: 0, hcc: 1 }],
    ['zero hcc', { host: 1, hcc: 0 }],
    ['missing', {}],
    ['fractional', { host: 1.5, hcc: 1 }],
  ]) {
    assert.throws(() => legacyLeaseReplicaPlan(bad, { host: 1, hcc: 1 }), /Recorded/, label)
  }
  assert.throws(() => legacyLeaseReplicaPlan(recorded, { host: undefined, hcc: 1 }), /unreadable/)
})
