'use strict'

// Unit/contract tests for the development-only lifecycle. Kubernetes is mocked
// only at its boundary; child-process supervision uses real local processes.
// These tests do not certify a browser journey or cluster/dataplane behavior.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const {
  Journal,
  journalPath,
  readJournal,
  assertJournalBinding,
  createOwned,
  deleteOwned,
  waitFor,
  createCommandRunner,
  createKubeClient,
  resourcePath,
  RUN_LABEL,
} = require('../e2e/_lib/wrc-egress-lifecycle.cjs')

const repository = fs.realpathSync(path.resolve(__dirname, '../..'))
const lifecycle = path.join(repository, 'scripts/e2e/_lib/wrc-egress-lifecycle.cjs')
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'wrc-lifecycle-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
function fixture(t) {
  const directory = temporary(t)
  const binding = {
    repository: directory,
    branch: 'fix/unit-lifecycle',
    profile: 'unit-profile',
    context: 'unit-context',
    head: 'historical-head',
  }
  const state = { version: 1, runId: randomUUID(), binding, resources: [] }
  const file = journalPath(directory, binding.profile)
  const journal = new Journal(file, state)
  const object = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'unit-resource',
      namespace: 'unit-namespace',
      labels: { [RUN_LABEL]: state.runId },
    },
    data: { fixture: 'unit' },
  }
  const created = structuredClone(object)
  created.metadata.uid = 'created-uid'
  created.metadata.resourceVersion = 'initial-rv'
  return { directory, binding, state, file, journal, object, created }
}
function apiError(code) {
  return Object.assign(new Error(`API ${code}`), { code })
}

test('journal creates private durable state, saves atomically, and removes only its own run', t => {
  const { journal, file, state } = fixture(t)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(readJournal(file), state)
  state.phase = 'restoring'
  journal.save()
  assert.equal(readJournal(file).phase, 'restoring')
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1)
  journal.remove()
  assert.equal(fs.existsSync(file), false)
})

test('journal binding permits historical HEAD but rejects every stable owner mismatch', t => {
  const { state, binding } = fixture(t)
  assert.doesNotThrow(() => assertJournalBinding(state, { ...binding, head: 'current-head' }))
  for (const key of ['repository', 'branch', 'profile', 'context']) {
    assert.throws(
      () => assertJournalBinding(state, { ...binding, [key]: `foreign-${key}` }),
      /JOURNAL_OWNER_MISMATCH/
    )
    assert.throws(
      () => assertJournalBinding(state, { ...binding, [key]: '' }),
      /JOURNAL_OWNER_MISMATCH/
    )
  }
})

test('journal refuses replacement, hard links, public permissions, invalid JSON and oversized state', t => {
  const { journal, file, state, directory } = fixture(t)
  fs.writeFileSync(file, JSON.stringify({ ...state, runId: randomUUID() }))
  assert.throws(() => journal.save(), /JOURNAL_REPLACED/)
  assert.throws(() => journal.remove(), /JOURNAL_REPLACED/)
  fs.writeFileSync(file, JSON.stringify(state))
  const link = path.join(directory, 'hardlink.json')
  fs.linkSync(file, link)
  assert.throws(() => readJournal(file), /UNSAFE_JOURNAL_FILE/)
  fs.unlinkSync(link)
  fs.chmodSync(file, 0o644)
  assert.throws(() => readJournal(file), /UNSAFE_JOURNAL_FILE/)
  fs.chmodSync(file, 0o600)
  fs.writeFileSync(file, '{')
  assert.throws(() => readJournal(file), SyntaxError)
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1))
  assert.throws(() => readJournal(file), /INVALID_JOURNAL_SIZE/)
})

test('journal paths reject traversal, noncanonical roots, and symbolic files or ancestors', t => {
  const { directory, file, state } = fixture(t)
  for (const profile of ['../escape', '/absolute', 'nested/profile', '', '..']) {
    assert.throws(() => journalPath(directory, profile), /INVALID_PROFILE/)
  }
  const alias = path.join(directory, 'repository-alias')
  fs.symlinkSync(directory, alias)
  assert.throws(() => journalPath(alias, 'unit-profile'), /NONCANONICAL_REPOSITORY/)
  const target = path.join(directory, 'private-journal.json')
  fs.renameSync(file, target)
  fs.symlinkSync(target, file)
  assert.throws(() => readJournal(file), /UNSAFE_JOURNAL_FILE/)
  fs.unlinkSync(file)
  const parent = path.dirname(file)
  const parentTarget = path.join(directory, 'journal-target')
  fs.renameSync(parent, parentTarget)
  fs.symlinkSync(parentTarget, parent)
  assert.throws(() => new Journal(file, state), /UNSAFE_JOURNAL_PARENT/)
})

test('certification guard rejects an intermediate symlink even before any journal exists', t => {
  const directory = temporary(t)
  const outside = path.join(directory, 'outside')
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(directory, '.local-notes'))
  const result = spawnSync(process.execPath, [lifecycle, directory, 'unit-profile'], {
    encoding: 'utf8',
    timeout: 3000,
  })
  assert.notEqual(result.status, 0, 'unsafe journal ancestry must not certify an empty lane')
  assert.match(result.stderr, /WRC_EGRESS_RECOVERY_REQUIRED/)
})

test('certification guard accepts genuine absence and rejects an outstanding valid journal', t => {
  const directory = temporary(t)
  const absent = spawnSync(process.execPath, [lifecycle, directory, 'unit-profile'], {
    encoding: 'utf8',
    timeout: 3000,
  })
  assert.equal(absent.status, 0)
  const { directory: owned } = fixture(t)
  const pending = spawnSync(process.execPath, [lifecycle, owned, 'unit-profile'], {
    encoding: 'utf8',
    timeout: 3000,
  })
  assert.notEqual(pending.status, 0)
  assert.match(pending.stderr, /WRC_EGRESS_RECOVERY_REQUIRED/)
})

test('creation persists its uncertain attempt before I/O and accepts only its acknowledged identity', async t => {
  const { journal, file, object, created } = fixture(t)
  let observedAttempt = false
  const result = await createOwned(
    {
      create: async body => {
        assert.deepEqual(body, object)
        observedAttempt = readJournal(file).resources[0].uid === null
        return created
      },
    },
    journal,
    object
  )
  assert.equal(observedAttempt, true)
  assert.deepEqual(result, created)
  assert.equal(readJournal(file).resources[0].uid, created.metadata.uid)
})

test('creation rejects missing run ownership before recording or issuing an attempt', async t => {
  const { journal, file, object } = fixture(t)
  delete object.metadata.labels[RUN_LABEL]
  let creates = 0
  await assert.rejects(
    createOwned(
      {
        create: async () => {
          creates++
        },
      },
      journal,
      object
    ),
    /MISSING_RUN_OWNERSHIP/
  )
  assert.equal(creates, 0)
  assert.deepEqual(readJournal(file).resources, [])
})

for (const code of [403, 409, 503]) {
  test(`rejected or ambiguous create ${code} never authorizes cleanup of an unacknowledged object`, async t => {
    const { journal, object, created } = fixture(t)
    const failure = apiError(code)
    await assert.rejects(
      createOwned(
        {
          create: async () => {
            throw failure
          },
        },
        journal,
        object
      ),
      error => error === failure
    )
    assert.equal(journal.state.resources[0].uid, null)
    let deletes = 0
    await assert.rejects(
      deleteOwned(
        {
          get: async () => created,
          delete: async () => {
            deletes++
          },
        },
        journal,
        journal.state.resources[0]
      ),
      /UNPROVEN_CLEANUP_OWNERSHIP/
    )
    assert.equal(deletes, 0)
  })
}

for (const [label, mutate] of [
  [
    'missing UID',
    object => {
      delete object.metadata.uid
    },
  ],
  [
    'foreign run',
    object => {
      object.metadata.labels[RUN_LABEL] = randomUUID()
    },
  ],
  [
    'different name',
    object => {
      object.metadata.name = 'another-resource'
    },
  ],
  [
    'different namespace',
    object => {
      object.metadata.namespace = 'another-namespace'
    },
  ],
]) {
  test(`creation refuses an acknowledgement with ${label}`, async t => {
    const { journal, object, created } = fixture(t)
    mutate(created)
    await assert.rejects(
      createOwned({ create: async () => created }, journal, object),
      /UNPROVEN_CREATED_RESOURCE|CREATED_IDENTITY_MISMATCH/
    )
    assert.equal(journal.state.resources[0].uid, null)
  })
}

test('cleanup uses fresh UID/resourceVersion preconditions and verifies authoritative absence', async t => {
  const { journal, created } = fixture(t)
  const entry = {
    kind: created.kind,
    name: created.metadata.name,
    namespace: created.metadata.namespace,
    uid: created.metadata.uid,
  }
  let live = { ...created, metadata: { ...created.metadata, resourceVersion: 'fresh-rv' } }
  const calls = []
  await deleteOwned(
    {
      get: async () => {
        calls.push('get')
        return live
      },
      delete: async (identity, fence) => {
        calls.push('delete')
        assert.deepEqual(identity, entry)
        assert.deepEqual(fence, { uid: entry.uid, resourceVersion: 'fresh-rv' })
        live = null
      },
    },
    journal,
    entry
  )
  assert.deepEqual(calls, ['get', 'delete', 'get'])
})

test('cleanup distinguishes failed observation, authoritative absence, and a foreign UID', async t => {
  const { journal, created } = fixture(t)
  const entry = {
    kind: created.kind,
    name: created.metadata.name,
    namespace: created.metadata.namespace,
    uid: created.metadata.uid,
  }
  let deletes = 0
  const del = async () => {
    deletes++
  }
  await assert.rejects(
    deleteOwned(
      {
        get: async () => {
          throw apiError(503)
        },
        delete: del,
      },
      journal,
      entry
    ),
    /API 503/
  )
  await deleteOwned({ get: async () => null, delete: del }, journal, entry)
  await assert.rejects(
    deleteOwned(
      {
        get: async () => ({ ...created, metadata: { ...created.metadata, uid: 'recreated-uid' } }),
        delete: del,
      },
      journal,
      entry
    ),
    /UNPROVEN_CLEANUP_OWNERSHIP/
  )
  assert.equal(deletes, 0)
})

test('cleanup forwards its bounded predicate signal to the authoritative absence GET', async t => {
  const { journal, created } = fixture(t)
  const entry = {
    kind: created.kind,
    name: created.metadata.name,
    namespace: created.metadata.namespace,
    uid: created.metadata.uid,
  }
  let gets = 0
  await deleteOwned(
    {
      get: async (_identity, remaining, signal) => {
        if (++gets === 1) return created
        assert(remaining > 0 && remaining <= 90000)
        assert(signal instanceof AbortSignal, 'the predicate signal must reach its real I/O')
        return null
      },
      delete: async () => {},
    },
    journal,
    entry
  )
})

test('cleanup does not retry a failed delete with an unfenced or newly recreated object', async t => {
  const { journal, created } = fixture(t)
  const entry = {
    kind: created.kind,
    name: created.metadata.name,
    namespace: created.metadata.namespace,
    uid: created.metadata.uid,
  }
  let gets = 0
  let deletes = 0
  const recreated = { ...created, metadata: { ...created.metadata, uid: 'recreated-uid' } }
  await assert.rejects(
    deleteOwned(
      {
        get: async () => (++gets === 1 ? created : recreated),
        delete: async () => {
          deletes++
          throw apiError(409)
        },
      },
      journal,
      entry
    ),
    /API 409|RESOURCE_RECREATED|UNPROVEN_CLEANUP/
  )
  assert.equal(deletes, 1)
  gets = 0
  await assert.rejects(
    deleteOwned(
      {
        get: async () => (++gets === 1 ? created : recreated),
        delete: async () => {},
      },
      journal,
      entry
    ),
    /RESOURCE_RECREATED_DURING_CLEANUP/
  )
})

test('delete failure is cleared only when a subsequent successful GET proves absence', async t => {
  const { journal, created } = fixture(t)
  const entry = {
    kind: created.kind,
    name: created.metadata.name,
    namespace: created.metadata.namespace,
    uid: created.metadata.uid,
  }
  let gets = 0
  await deleteOwned(
    {
      get: async () => (++gets === 1 ? created : null),
      delete: async () => {
        throw apiError(503)
      },
    },
    journal,
    entry
  )
  gets = 0
  await assert.rejects(
    deleteOwned(
      {
        get: async () => {
          if (++gets === 1) return created
          throw apiError(503)
        },
        delete: async () => {
          throw apiError(503)
        },
      },
      journal,
      entry
    ),
    /API 503/
  )
})

test('waitFor rejects a true predicate that finishes after its absolute deadline', async () => {
  let now = 100
  await assert.rejects(
    waitFor(
      'late',
      20,
      async remaining => {
        assert.equal(remaining, 20)
        now = 121
        return true
      },
      { now: () => now }
    ),
    error => /TIMEOUT:late/.test(error.message) && error.exitCode === 124
  )
})

test('waitFor does not accept true after cancellation during the predicate', async () => {
  const cancellation = new AbortController()
  const reason = new Error('cancelled during predicate')
  await assert.rejects(
    waitFor(
      'cancelled',
      1000,
      async () => {
        cancellation.abort(reason)
        return true
      },
      { signal: cancellation.signal }
    ),
    error => error === reason
  )
})

test('waitFor propagates parent cancellation to in-flight predicate I/O', async () => {
  const cancellation = new AbortController()
  const reason = new Error('cancelled in-flight')
  let receivedSignal
  await assert.rejects(
    waitFor(
      'in-flight',
      100,
      async (_remaining, signal) => {
        receivedSignal = signal
        cancellation.abort(reason)
        return new Promise(() => {})
      },
      { signal: cancellation.signal }
    ),
    error => error === reason
  )
  assert.equal(receivedSignal.aborted, true)
})

test('waitFor cancels a hung predicate at its own deadline and never treats an exception as ready', async () => {
  let signal
  await assert.rejects(
    waitFor('hung', 20, async (_remaining, current) => {
      signal = current
      return new Promise(() => {})
    }),
    /TIMEOUT:hung/
  )
  assert.equal(signal.aborted, true)
  const failure = new Error('predicate failed')
  await assert.rejects(
    waitFor('failed', 100, async () => {
      throw failure
    }),
    error => error === failure
  )
})

test('Kubernetes client distinguishes failed GET from authoritative empty NotFound and always supplies context', async () => {
  const calls = []
  const identity = { kind: 'ConfigMap', name: 'unit-resource', namespace: 'unit-namespace' }
  let response = ''
  const client = createKubeClient(repository, 'unit-context', async (args, options) => {
    calls.push({ args, options })
    if (response instanceof Error) throw response
    return response
  })
  assert.equal(await client.get(identity, 1234), null)
  assert(calls[0].args.includes('--context=unit-context'))
  assert(calls[0].args.includes('--ignore-not-found=true'))
  assert.equal(calls[0].options.timeoutMs, 1234)
  response = apiError(503)
  await assert.rejects(client.get(identity), /API 503/)
  response = '{'
  await assert.rejects(client.get(identity), SyntaxError)
})

test('Kubernetes reads cap their own request budget and refuse an expired phase before spawning', async () => {
  const calls = []
  const client = createKubeClient(repository, 'unit-profile', async (args, options) => {
    calls.push({ args, options })
    return args.includes('get') && args.includes('pods') ? '{"items":[]}' : ''
  })
  const identity = { kind: 'Service', namespace: 'unit', name: 'service' }
  await client.get(identity, 90_000)
  await client.list('pods', 'unit', 'app=unit', 900)
  assert.equal(calls[0].options.timeoutMs, 30_000)
  assert.equal(calls[1].options.timeoutMs, 900)
  await assert.rejects(client.get(identity, 0), error => error.exitCode === 124)
  assert.equal(calls.length, 2)
})

test('cleanup waits for aborted polling processes to finish before returning ownership to the restorer', async () => {
  let finish
  const client = createKubeClient(
    repository,
    'unit-profile',
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const observation = client.get({ kind: 'Service', namespace: 'unit', name: 'service' })
  let drained = false
  const cleanup = client.setCleanup(true).then(() => {
    drained = true
  })
  await Promise.resolve()
  assert.equal(drained, false)
  finish('')
  assert.equal(await observation, null)
  await cleanup
  assert.equal(drained, true)
})

test('Kubernetes resource operations reject invalid status-derived identities before dispatch', async () => {
  let calls = 0
  const client = createKubeClient(repository, 'unit-profile', async () => {
    calls++
    return '{}'
  })
  for (const identity of [
    { kind: 'Deployment', name: 'invalid name', namespace: 'unit' },
    { kind: 'Service', name: '-invalid', namespace: 'unit' },
    { kind: 'NetworkPolicy', name: 'valid', namespace: '' },
    { kind: 'Unknown', name: 'valid', namespace: 'unit' },
  ]) {
    await assert.rejects(client.get(identity), /INVALID_RESOURCE_IDENTITY/)
    await assert.rejects(client.patch(identity, []), /INVALID_RESOURCE_IDENTITY/)
  }
  assert.equal(calls, 0)
})

test('Kubernetes mutations require the live lease before create/patch/delete and preserve raw delete fencing', async () => {
  const calls = []
  const identity = { kind: 'ConfigMap', name: 'unit-resource', namespace: 'unit-namespace' }
  const client = createKubeClient(repository, 'unit-context', async (args, options) => {
    calls.push({ args, options })
    return '{}'
  })
  await client.create({ kind: 'ConfigMap', metadata: identity })
  await client.patch(identity, [{ op: 'test', path: '/metadata/uid', value: 'uid' }])
  await client.delete(identity, { uid: 'uid', resourceVersion: 'rv' })
  assert.equal(calls.length, 6)
  for (const index of [0, 2, 4]) {
    assert.equal(calls[index].args[0], 'bash')
    assert.match(calls[index].args[1], /require-t2-mutation-lock\.sh$/)
    assert(calls[index + 1].args.includes('--context=unit-context'))
  }
  assert(calls[5].args.includes(`--raw=${resourcePath(identity)}`))
  assert.deepEqual(JSON.parse(calls[5].options.input).preconditions, {
    uid: 'uid',
    resourceVersion: 'rv',
  })
  let mutations = 0
  const denied = createKubeClient(repository, 'unit-context', async args => {
    if (args[0] === 'bash') throw new Error('lease rejected')
    mutations++
    return '{}'
  })
  await assert.rejects(
    denied.delete(identity, { uid: 'uid', resourceVersion: 'rv' }),
    /lease rejected/
  )
  assert.equal(mutations, 0)
})

test(
  'command runner returns successful output and keeps a separate cleanup budget after cancellation',
  { timeout: 5000 },
  async () => {
    const cancellation = new AbortController()
    const run = createCommandRunner(repository, cancellation)
    assert.equal(
      await run([process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], {
        input: 'unit-input',
        timeoutMs: 2000,
      }),
      'unit-input'
    )
    const reason = new Error('main run interrupted')
    cancellation.abort(reason)
    await assert.rejects(
      run([process.execPath, '-e', 'process.exit(0)']),
      error => error === reason
    )
    assert.equal(
      await run([process.execPath, '-e', 'process.stdout.write("restored")'], {
        cleanup: true,
        timeoutMs: 2000,
      }),
      'restored'
    )
  }
)

for (const cleanup of [false, true]) {
  test(
    `command runner never starts an already-cancelled operation (cleanup=${cleanup})`,
    { timeout: 5000 },
    async t => {
      const directory = temporary(t)
      const marker = path.join(directory, 'must-not-run')
      const cancellation = new AbortController()
      const operation = new AbortController()
      operation.abort(new Error('operation already cancelled'))
      const run = createCommandRunner(repository, cancellation)
      await assert.rejects(
        run(
          [
            process.execPath,
            '-e',
            'require("node:fs").writeFileSync(process.argv[1], "ran")',
            marker,
          ],
          {
            cleanup,
            signal: operation.signal,
            timeoutMs: 2000,
          }
        )
      )
      assert.equal(fs.existsSync(marker), false)
    }
  )
}

test(
  'command runner enforces the requested millisecond budget before later side effects',
  { timeout: 5000 },
  async t => {
    const directory = temporary(t)
    const marker = path.join(directory, 'late-effect')
    const run = createCommandRunner(repository, new AbortController())
    await assert.rejects(
      run(
        [
          process.execPath,
          '-e',
          'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "late"), 250)',
          marker,
        ],
        {
          timeoutMs: 40,
        }
      ),
      error => error.exitCode === 124
    )
    assert.equal(
      fs.existsSync(marker),
      false,
      'work must terminate at the operation deadline, not merely be judged late after completion'
    )
  }
)

test(
  'command runner bounds output and does not expose child output in its error',
  { timeout: 5000 },
  async () => {
    const run = createCommandRunner(repository, new AbortController())
    await assert.rejects(
      run([process.execPath, '-e', 'process.stdout.write("unit-payload".repeat(500000))'], {
        timeoutMs: 2000,
      }),
      error =>
        /WRC_GATE_OPERATION_FAILED/.test(error.message) && !error.message.includes('unit-payload')
    )
  }
)

function observeJsonFile(file, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    // Watch an explicit readiness artifact. Stat polling avoids the platform's
    // finite native watcher quota without guessing when a child is ready.
    const changed = () => {
      if (!fs.existsSync(file)) return
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'))
        clearTimeout(timer)
        fs.unwatchFile(file, changed)
        resolve(value)
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          clearTimeout(timer)
          fs.unwatchFile(file, changed)
          reject(error)
        }
      }
    }
    fs.watchFile(file, { interval: 20 }, changed)
    const timer = setTimeout(() => {
      fs.unwatchFile(file, changed)
      reject(new Error('child readiness deadline'))
    }, timeoutMs)
  })
}

function processRunning(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], {
    encoding: 'utf8',
    timeout: 1000,
  })
  if (result.error) throw result.error
  assert.equal(result.stderr.trim(), '', 'failed process inspection cannot prove a child exited')
  return result.status === 0 && result.stdout.trim() !== '' && !result.stdout.trim().startsWith('Z')
}

test(
  'command cancellation reaps a TERM-resistant descendant before resolving cleanup ownership',
  { timeout: 8000 },
  async t => {
    const directory = temporary(t)
    const marker = path.join(directory, 'children.json')
    const readiness = observeJsonFile(marker)
    const cancellation = new AbortController()
    const run = createCommandRunner(repository, cancellation)
    const grandchildCode =
      'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'
    const parentCode = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], {stdio:['ignore','pipe','ignore']});
    process.on('SIGTERM', () => process.exit(0));
    child.stdout.once('data', () => require('node:fs').writeFileSync(process.argv[1], JSON.stringify({parent:process.pid,descendant:child.pid})));
    setInterval(()=>{},1000);
  `
    const operation = run([process.execPath, '-e', parentCode, marker], { timeoutMs: 6000 })
    // Attach rejection immediately so an unexpected early child failure is never
    // an unhandled rejection while the independent readiness event is awaited.
    const outcome = operation.then(
      value => ({ value }),
      error => ({ error })
    )
    const pids = await readiness
    t.after(() => {
      for (const pid of [pids.parent, pids.descendant]) {
        if (processRunning(pid)) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch (error) {
            if (error.code !== 'ESRCH') throw error
          }
        }
      }
    })
    assert(processRunning(pids.parent))
    assert(processRunning(pids.descendant))
    cancellation.abort(Object.assign(new Error('terminated by test'), { exitCode: 143 }))
    const result = await outcome
    assert(result.error, 'cancellation must never report success')
    assert.equal(result.error.exitCode, 143)
    assert.equal(processRunning(pids.parent), false)
    assert.equal(processRunning(pids.descendant), false)
  }
)

test(
  'natural direct-child exit does not leave a daemonized descendant running',
  { timeout: 5000 },
  async t => {
    const directory = temporary(t)
    const marker = path.join(directory, 'daemon.json')
    const readiness = observeJsonFile(marker)
    const run = createCommandRunner(repository, new AbortController())
    const code = `
    const child = require('node:child_process').spawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {stdio:['ignore','pipe','ignore']});
    child.stdout.once('data', () => {
      require('node:fs').writeFileSync(process.argv[1], JSON.stringify({pid:child.pid}));
      process.exit(0);
    });
  `
    const operation = run([process.execPath, '-e', code, marker], { timeoutMs: 3000 })
    const outcome = operation.then(
      value => ({ value }),
      error => ({ error })
    )
    const { pid } = await readiness
    t.after(() => {
      if (processRunning(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          if (error.code !== 'ESRCH') throw error
        }
      }
    })
    const result = await outcome
    assert.equal(result.error, undefined)
    assert.equal(processRunning(pid), false)
  }
)
