import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { REPETITIONS, distribution, matrix, parseOptions } from '../bench-chat-open.mjs'
import { captureFilesystemFailures } from './fixtures.mjs'
import { AUTHORITY_SCOPE } from './fixtures.mjs'
import head from './head.mjs'
import { auditRuntime, checkWorktreeClean } from './sources.mjs'
import v011 from './v0.11.0.mjs'

const ts = createRequire(import.meta.url)('typescript')

test('quick retains both cleanup populations and the failing-filesystem scenario with 30 repetitions', () => {
  assert.equal(REPETITIONS, 30)
  assert.equal(matrix(false).length, 27)
  assert.deepEqual(matrix(true), [
    { agents: 5, chatsPerAgent: 20, pendingCleanupsPerAgent: 0, cleanupFilesystem: 'healthy' },
    { agents: 5, chatsPerAgent: 20, pendingCleanupsPerAgent: 10, cleanupFilesystem: 'healthy' },
    { agents: 5, chatsPerAgent: 20, pendingCleanupsPerAgent: 10, cleanupFilesystem: 'EACCES' },
  ])
})

test('version restriction preserves historical refs and rejects duplicates or command-like refs', () => {
  assert.deepEqual(
    parseOptions(['--versions', 'v0.11.0,v0.10.0', '--quick', '--out', 'r.json']).versions,
    ['v0.11.0', 'v0.10.0']
  )
  assert.throws(() => parseOptions(['--versions', 'v0.10.0,v0.10.0', '--out', 'r.json']))
  assert.throws(() => parseOptions(['--versions', '--help']))
  assert.throws(() => parseOptions(['--versions', 'origin/dev', '--out', 'r.json']))
})

test('--out is required and --allow-dirty is opt-in', () => {
  assert.throws(() => parseOptions(['--quick']), /--out is required/)
  const options = parseOptions(['--quick', '--out', 'r.json'])
  assert.equal(options.out.endsWith('r.json'), true)
  assert.equal(options.allowDirty, false)
  assert.equal(parseOptions(['--allow-dirty', '--out', 'r.json']).allowDirty, true)
  assert.equal(parseOptions(['--help']).help, true)
})

test('a dirty HEAD tree is refused unless allowed, and then recorded as dirty', () => {
  assert.equal(checkWorktreeClean('', false), false)
  assert.throws(() => checkWorktreeClean(' M desktop-app/src/ipc.ts', false), /--allow-dirty/)
  assert.equal(checkWorktreeClean(' M desktop-app/src/ipc.ts', true), true)
})

test('nearest-rank p95 uses the 29th of 30 observations and rejects missing/nonfinite samples', () => {
  const samples = Array.from({ length: 30 }, (_, index) => 30 - index)
  assert.deepEqual(distribution(samples), { samples: 30, p50Ms: 15, p95Ms: 29, samplesMs: samples })
  assert.throws(() => distribution([]))
  assert.throws(() => distribution([0, NaN]))
})

test('runtime audit accepts macOS temporary-path aliases and blocks escaping or Electron imports', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'chat-open-audit-test-'))
  try {
    const compiled = join(root, 'compiled')
    await fs.mkdir(compiled)
    const entry = join(compiled, 'entry.js')
    await fs.writeFile(entry, "require('node:fs'); require('./helper.js')\n")
    await fs.writeFile(join(compiled, 'helper.js'), "require('node:path')\n")
    const runtime = await auditRuntime(ts, compiled, [entry])
    assert.equal(runtime.files.length, 2)
    assert.ok(runtime.imports.includes('node:fs'))
    assert.ok(runtime.imports.includes('node:path'))
    await fs.writeFile(join(root, 'outside.js'), "require('node:os')\n")
    await assert.rejects(auditRuntime(ts, compiled, [join(root, 'outside.js')]), /escapes/)
    await fs.symlink(join(root, 'outside.js'), join(compiled, 'outside.js'))
    await fs.writeFile(entry, "require('./outside.js')\n")
    await assert.rejects(auditRuntime(ts, compiled, [entry]), /escapes/)
    await fs.writeFile(entry, "require('electron')\n")
    await assert.rejects(auditRuntime(ts, compiled, [entry]), /Non-Node runtime dependency/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('filesystem fault is confined to fixture cleanup, is witnessed, and restores the real filesystem', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'chat-open-fs-test-'))
  const original = fs.readdir
  try {
    const corrupt = join(root, 'agent', '.corrupt')
    await fs.mkdir(corrupt, { recursive: true })
    await fs.writeFile(join(corrupt, 'proof'), 'synthetic')
    const capture = captureFilesystemFailures(root, true)
    try {
      assert.ok((await fs.readdir(root)).includes('agent'))
      await assert.rejects(fs.readdir(corrupt), { code: 'EACCES' })
      assert.equal(capture.counters.filesystemFailures, 1)
    } finally {
      capture.restore()
    }
    assert.equal(fs.readdir, original)
    assert.deepEqual(await fs.readdir(corrupt), ['proof'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('v0.11.0 adapter reports a cleanup error and still reads the catalog in handler order', async () => {
  const calls = []
  const context = v011.context({
    async retryPendingDeleteCleanups() {
      calls.push('cleanup')
      throw Object.assign(new Error('Synthetic denial'), { code: 'EACCES' })
    },
    async getIndex() {
      calls.push('index')
      return { chats: [{}] }
    },
  })
  assert.equal((await context.getIndex('synthetic')).chats.length, 1)
  assert.deepEqual(calls, ['cleanup', 'index'])
  assert.equal(context.cleanupErrors, 1)
})

test('HEAD delegates to the compiled export and settle waits for the cleanups it started', async () => {
  const calls = []
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const result = { chats: [1] }
  const store = {
    async retryPendingDeleteCleanups(scope, agentRef) {
      assert.deepEqual(scope, AUTHORITY_SCOPE)
      calls.push(`cleanup:${agentRef}`)
      await gate
      calls.push('cleanup:end')
    },
    async getIndex(agentRef) {
      calls.push(`index:${agentRef}`)
      return result
    },
  }
  // A distinct export witnesses delegation to the compiled handler instead of
  // an adapter-owned copy of the store sequence.
  const runChatGetIndex = async (deps, agentRef) => {
    calls.push('export')
    const { authorityScope } = deps.getChatDeletionFenceAuthority()
    void deps.store
      .retryPendingDeleteCleanups(authorityScope, agentRef)
      .catch(deps.warnCleanupFailure)
    deps.warnCleanupFailure(new Error('Synthetic warning'))
    return deps.store.getIndex(agentRef)
  }
  const context = head.context(store, { runChatGetIndex })
  assert.equal(await context.getIndex('synthetic'), result)
  assert.deepEqual(calls, ['export', 'cleanup:synthetic', 'index:synthetic'])
  assert.equal(context.cleanupErrors, 1)

  let settled = false
  const settling = context.settle().then(() => {
    settled = true
  })
  await new Promise(resolve => setImmediate(resolve))
  // settle waits for the handler's own cleanup and starts none of its own.
  assert.equal(settled, false)
  release()
  await settling
  assert.deepEqual(calls, ['export', 'cleanup:synthetic', 'index:synthetic', 'cleanup:end'])
})

/** The shipped `runChatGetIndex`, transpiled from source. */
async function realRunChatGetIndex() {
  const source = await fs.readFile(
    new URL('../../src/chatGetIndexHandler.ts', import.meta.url),
    'utf8'
  )
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const compiled = { exports: {} }
  new Function('module', 'exports', outputText)(compiled, compiled.exports)
  assert.equal(typeof compiled.exports.runChatGetIndex, 'function')
  return compiled.exports.runChatGetIndex
}

test('HEAD drives the real chat:getIndex handler through the adapter deps', async () => {
  // The stub above witnesses delegation; this runs the shipped handler against
  // the adapter's untyped deps, so a renamed dependency fails here instead of
  // surfacing only as a cleanup warning in a benchmark run.
  const runChatGetIndex = await realRunChatGetIndex()

  const calls = []
  let release
  const gate = new Promise(resolve => {
    release = resolve
  })
  const result = { chats: [1] }
  const store = {
    async retryPendingDeleteCleanups(scope, agentRef) {
      assert.deepEqual(scope, AUTHORITY_SCOPE)
      calls.push(`cleanup:${agentRef}`)
      await gate
      calls.push('cleanup:end')
    },
    async getIndex(agentRef) {
      calls.push(`index:${agentRef}`)
      return result
    },
  }
  const context = head.context(store, {
    runChatGetIndex: (deps, agentRef) => {
      calls.push('export')
      return runChatGetIndex(deps, agentRef)
    },
  })

  let returned
  const reading = context.getIndex('synthetic').then(index => {
    returned = index
  })
  try {
    await new Promise(resolve => setImmediate(resolve))
    // The index is returned while the cleanup it started is still gated.
    assert.equal(returned, result)
    assert.deepEqual(calls, ['export', 'cleanup:synthetic', 'index:synthetic'])
  } finally {
    release()
    await reading
  }
  await context.settle()
  assert.deepEqual(calls, ['export', 'cleanup:synthetic', 'index:synthetic', 'cleanup:end'])
  assert.equal(context.cleanupErrors, 0)
})

test('HEAD counts a rejected cleanup from the real handler and still returns the index', async () => {
  const runChatGetIndex = await realRunChatGetIndex()
  const calls = []
  const result = { chats: [1] }
  const store = {
    async retryPendingDeleteCleanups(_scope, agentRef) {
      calls.push(`cleanup:${agentRef}`)
      throw new Error('Synthetic cleanup failure')
    },
    async getIndex(agentRef) {
      calls.push(`index:${agentRef}`)
      return result
    },
  }
  const context = head.context(store, { runChatGetIndex })
  assert.equal(await context.getIndex('synthetic'), result)
  await context.settle()
  // Witness: the handler started the cleanup that rejected.
  assert.deepEqual(calls, ['cleanup:synthetic', 'index:synthetic'])
  assert.equal(context.cleanupErrors, 1)
})
