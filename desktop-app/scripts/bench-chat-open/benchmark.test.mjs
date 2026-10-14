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
import { auditRuntime } from './sources.mjs'
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
  assert.deepEqual(parseOptions(['--versions', 'v0.11.0,v0.10.0', '--quick']).versions, [
    'v0.11.0',
    'v0.10.0',
  ])
  assert.throws(() => parseOptions(['--versions', 'v0.10.0,v0.10.0']))
  assert.throws(() => parseOptions(['--versions', '--help']))
  assert.throws(() => parseOptions(['--versions', 'origin/dev']))
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

test('HEAD delegates to the supplied compiled export and drains cleanup only after measurement', async () => {
  const calls = []
  const store = {
    async retryPendingDeleteCleanups(scope) {
      assert.deepEqual(scope, AUTHORITY_SCOPE)
      calls.push('settle')
    },
  }
  const result = { chats: [1] }
  // This distinct behavior witnesses delegation to the compiled export instead
  // of an adapter-owned copy of a historical store sequence.
  const runChatGetIndex = async (deps, agentRef) => {
    calls.push('export')
    assert.equal(deps.store, store)
    assert.equal(agentRef, 'synthetic')
    assert.deepEqual(deps.getChatDeletionFenceAuthority(), { authorityScope: AUTHORITY_SCOPE })
    deps.warnCleanupFailure(new Error('Synthetic warning'))
    return result
  }
  const context = head.context(store, { runChatGetIndex })
  assert.equal(await context.getIndex('synthetic'), result)
  assert.deepEqual(calls, ['export'])
  assert.equal(context.cleanupErrors, 1)
  await context.settle()
  assert.deepEqual(calls, ['export', 'settle'])
})
