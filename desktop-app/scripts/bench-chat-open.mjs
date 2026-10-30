#!/usr/bin/env node
/**
 * ChatStore chat-open benchmark (issue #1091, plan sections 7.1 and 11).
 *
 * Run from desktop-app with Node 24 and installed HEAD dependencies:
 *   node scripts/bench-chat-open.mjs --quick --versions v0.10.0,v0.11.0 \
 *     --out <primary-checkout>/.local-notes/issue1091-evidence/chat-open-quick.json
 *   node scripts/bench-chat-open.mjs \
 *     --out <primary-checkout>/.local-notes/issue1091-evidence/chat-open-full.json
 *
 * --versions selects any comma-separated subset of v0.10.0,v0.11.0,HEAD.
 * --quick uses 5 agents x 20 chats; both pending-cleanup values and the permanent
 * EACCES scenario still run, with 30 fresh-bind repetitions each. The full matrix
 * is {5,25,100} agents x {20,200,1000} chats PER AGENT x {0,10} cleanups PER AGENT.
 * A successful cleanup and a persistent filesystem failure are separate scenarios.
 *
 * Historical sources are extracted using git archive -> tar, made read-only and
 * compiled with HEAD's node_modules/.bin/tsc into os.tmpdir(). HEAD snapshots the
 * live worktree; its source hashes and commit are recorded. A HEAD with
 * uncommitted changes is refused unless --allow-dirty is passed, and the JSON
 * then records dirty: true. No checkout, dependency installation or Electron launch.
 * The emitted runtime graph is audited before import. We bypass only Electron's
 * binding module: a fresh ChatStore + setAuthorityScope reproduces the completed
 * bind; HEAD's actual compiled runChatGetIndex implements the measured handler.
 *
 * Fixtures contain synthetic catalogs and valid transcripts written by the
 * version's own ChatStore. Only the opened chats have nonempty transcripts.
 * Each repetition uses a fresh mkdtemp directory and store; setup, assertions and
 * teardown are outside timing. Data is never written to user configuration dirs.
 * "First" means first call after bind, not an OS-cold disk read (seeding warms
 * the filesystem cache). Full/partial pages return exactly 100/37 messages.
 * Extra warm-page stages repeat those reads on the same store. p50/p95 use the
 * nearest-rank estimator and retain all raw milliseconds for audit.
 *
 * Pre-cleanup versions retain the same additive pending fields/artifacts but do
 * not implement cleanup; this is explicit in JSON, never simulated as a feature.
 * Failure injection targets only fixture .corrupt readdir calls (EACCES), matching
 * chatStore.test.ts:305. Numeric failure/warning witnesses accompany retained
 * queues/artifacts. An unmeasured real delete + fail + retry proves the model.
 * Imported historical warnings are counted without logging IDs or error text.
 * Warm stage-p95 sums and paired warm-open p95 are both reported; this Node
 * benchmark does not measure the renderer chat-open time.
 *
 * --out is required: results are evidence and must not land in a directory the
 * OS clears. The output is exclusively created; an existing file is an error.
 * JSON is also printed to stdout. Sources/data are removed even on failure; the
 * JSON remains for review.
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { arch, cpus, loadavg, platform, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  FULL_CHAT,
  FULL_MESSAGES,
  PAGE_SIZE,
  PARTIAL_CHAT,
  PARTIAL_MESSAGES,
  PARTIAL_SIZE,
  TARGET_AGENT,
  captureFilesystemFailures,
  createFixture,
  inspectFixture,
  verifyFailingFilesystemModel,
} from './bench-chat-open/fixtures.mjs'
import { compileVersion, git, setSourcePermissions } from './bench-chat-open/sources.mjs'

export const REPETITIONS = 30
const ADAPTER_FILES = new Map([
  ['v0.10.0', 'v0.10.0.mjs'],
  ['v0.11.0', 'v0.11.0.mjs'],
  ['HEAD', 'head.mjs'],
])

export function parseOptions(args) {
  const options = {
    versions: [...ADAPTER_FILES.keys()],
    quick: false,
    allowDirty: false,
    out: undefined,
    help: false,
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--quick') options.quick = true
    else if (arg === '--allow-dirty') options.allowDirty = true
    else if (arg === '--help') options.help = true
    else if (arg === '--versions' || arg === '--out') {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      if (arg === '--out') options.out = resolve(value)
      else {
        const versions = value.split(',').map(version => version.trim())
        if (
          versions.some(version => !ADAPTER_FILES.has(version)) ||
          new Set(versions).size !== versions.length
        ) {
          throw new Error('--versions must contain unique supported refs')
        }
        options.versions = versions
      }
    } else throw new Error(`Unknown option: ${arg}`)
  }
  if (!options.help && !options.out) {
    throw Object.assign(new Error('--out is required'), { code: 'OUT_REQUIRED' })
  }
  return options
}

export function matrix(quick) {
  const cases = []
  for (const agents of quick ? [5] : [5, 25, 100]) {
    for (const chatsPerAgent of quick ? [20] : [20, 200, 1000]) {
      for (const pendingCleanupsPerAgent of [0, 10]) {
        for (const cleanupFilesystem of pendingCleanupsPerAgent
          ? ['healthy', 'EACCES']
          : ['healthy']) {
          cases.push({ agents, chatsPerAgent, pendingCleanupsPerAgent, cleanupFilesystem })
        }
      }
    }
  }
  return cases
}

export function distribution(values) {
  assert.ok(values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0))
  const sorted = [...values].sort((left, right) => left - right)
  return {
    samples: values.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samplesMs: values,
  }
}

async function measure(operation) {
  const start = performance.now()
  const value = await operation()
  return { ms: performance.now() - start, value }
}

async function runScenario(runDir, adapter, compiled, dimensions) {
  const stageSamples = Object.fromEntries(
    [
      'firstGetIndexAfterBind',
      'nextGetIndex',
      'setLastActive',
      'loadMessagesFullPage',
      'loadMessagesPartialPage',
      'loadMessagesFullPageWarm',
      'loadMessagesPartialPageWarm',
      'chatOpenWarm',
    ].map(stage => [stage, []])
  )
  const witnesses = []
  const initialLoad = loadavg()
  for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
    const fixture = await createFixture({
      runDir,
      adapter,
      ChatStore: compiled.ChatStore,
      ...dimensions,
    })
    const capture = captureFilesystemFailures(
      fixture.root,
      dimensions.cleanupFilesystem === 'EACCES'
    )
    try {
      const store = adapter.bind(compiled.ChatStore, fixture.root)
      const context = compiled.context(store)
      const first = await measure(() => context.getIndex(TARGET_AGENT))
      assert.equal(first.value.chats.length, dimensions.chatsPerAgent)
      const next = await measure(() => context.getIndex(TARGET_AGENT))
      assert.equal(next.value.chats.length, dimensions.chatsPerAgent)
      const active = await measure(() => store.setLastActiveChatId(TARGET_AGENT, FULL_CHAT))
      const full = await measure(() => store.loadMessages(TARGET_AGENT, FULL_CHAT, PAGE_SIZE, 0))
      assert.deepEqual(full.value, FULL_MESSAGES)
      const partial = await measure(() =>
        store.loadMessages(TARGET_AGENT, PARTIAL_CHAT, PAGE_SIZE, 0)
      )
      assert.deepEqual(partial.value, PARTIAL_MESSAGES)
      const fullWarm = await measure(() =>
        store.loadMessages(TARGET_AGENT, FULL_CHAT, PAGE_SIZE, 0)
      )
      assert.deepEqual(fullWarm.value, FULL_MESSAGES)
      const partialWarm = await measure(() =>
        store.loadMessages(TARGET_AGENT, PARTIAL_CHAT, PAGE_SIZE, 0)
      )
      assert.deepEqual(partialWarm.value, PARTIAL_MESSAGES)
      const values = [
        first.ms,
        next.ms,
        active.ms,
        full.ms,
        partial.ms,
        fullWarm.ms,
        partialWarm.ms,
        first.ms + active.ms + fullWarm.ms,
      ]
      Object.keys(stageSamples).forEach((stage, index) => stageSamples[stage].push(values[index]))
      if (context.settle) await context.settle()
      const state = await inspectFixture(fixture, dimensions.chatsPerAgent)
      const pendingTotal = dimensions.agents * dimensions.pendingCleanupsPerAgent
      if (!adapter.handlesPendingCleanups || dimensions.cleanupFilesystem === 'EACCES') {
        assert.equal(state.pending, pendingTotal)
        assert.equal(state.retainedArtifactDirectories, pendingTotal)
      } else {
        assert.equal(state.pending, 0)
        assert.equal(state.retainedArtifactDirectories, 0)
      }
      if (adapter.handlesPendingCleanups && dimensions.cleanupFilesystem === 'EACCES') {
        assert.ok(capture.counters.filesystemFailures > 0)
        assert.ok(capture.counters.warnings > 0)
      }
      witnesses.push({
        repetition,
        ...state,
        ...capture.counters,
        cleanupErrors: context.cleanupErrors,
        catalogBytes: fixture.catalogBytes,
        indexChats: first.value.chats.length,
        fullPageMessages: full.value.length,
        partialPageMessages: partial.value.length,
      })
    } finally {
      capture.restore()
      await fs.rm(fixture.root, { recursive: true, force: true })
    }
  }
  const stages = Object.fromEntries(
    Object.entries(stageSamples).map(([stage, samples]) => [stage, distribution(samples)])
  )
  return {
    ...dimensions,
    repetitions: REPETITIONS,
    loadavgBefore: initialLoad,
    loadavgAfter: loadavg(),
    stages,
    warmStageP95SumMs:
      stages.firstGetIndexAfterBind.p95Ms +
      stages.setLastActive.p95Ms +
      stages.loadMessagesFullPageWarm.p95Ms,
    witnesses,
  }
}

export function comparisons(results) {
  const baseline = results.find(result => result.version === 'v0.10.0')
  if (!baseline) return []
  const key = scenario =>
    JSON.stringify([
      scenario.agents,
      scenario.chatsPerAgent,
      scenario.pendingCleanupsPerAgent,
      scenario.cleanupFilesystem,
    ])
  const byScenario = new Map(baseline.scenarios.map(scenario => [key(scenario), scenario]))
  return results
    .filter(result => result !== baseline)
    .flatMap(result =>
      result.scenarios.map(scenario => {
        const reference = byScenario.get(key(scenario))
        assert.ok(reference && reference.warmStageP95SumMs > 0)
        return {
          version: result.version,
          agents: scenario.agents,
          chatsPerAgent: scenario.chatsPerAgent,
          pendingCleanupsPerAgent: scenario.pendingCleanupsPerAgent,
          cleanupFilesystem: scenario.cleanupFilesystem,
          baselineWarmStageP95SumMs: reference.warmStageP95SumMs,
          warmStageP95SumMs: scenario.warmStageP95SumMs,
          changePercent: (scenario.warmStageP95SumMs / reference.warmStageP95SumMs - 1) * 100,
          withinTenPercent: scenario.warmStageP95SumMs <= reference.warmStageP95SumMs * 1.1,
        }
      })
    )
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args)
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/bench-chat-open.mjs --out path [--quick] [--allow-dirty] [--versions v0.10.0,v0.11.0,HEAD]\n'
    )
    return
  }
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error('This benchmark requires Node 24')
  if (process.env.EVENFIRE_CHAT_SPANS_FILE)
    throw new Error('Unset EVENFIRE_CHAT_SPANS_FILE for comparable timing')
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const repoRoot = git(desktopRoot, ['rev-parse', '--show-toplevel'])
  const runDir = await fs.mkdtemp(join(tmpdir(), 'evenfire-chat-open-'))
  const { out } = options
  const started = performance.now()
  try {
    const prepared = []
    for (const ref of options.versions) {
      const { default: adapter } = await import(`./bench-chat-open/${ADAPTER_FILES.get(ref)}`)
      const compiled = await compileVersion({
        adapter,
        repoRoot,
        desktopRoot,
        runDir,
        allowDirty: options.allowDirty,
      })
      prepared.push({ adapter, compiled })
    }
    const results = []
    for (const { adapter, compiled } of prepared) {
      process.stderr.write(
        `Benchmark ${adapter.ref}: ${matrix(options.quick).length} scenarios x ${REPETITIONS} repetitions\n`
      )
      const failingFilesystemModel = await verifyFailingFilesystemModel({
        runDir,
        adapter,
        ChatStore: compiled.ChatStore,
      })
      const scenarios = []
      for (const dimensions of matrix(options.quick)) {
        scenarios.push(await runScenario(runDir, adapter, compiled, dimensions))
      }
      results.push({ ...compiled.metadata, failingFilesystemModel, scenarios })
    }
    const cpuInfo = cpus()
    assert.ok(cpuInfo.length > 0)
    const summary = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      nodeVersion: process.version,
      machine: {
        platform: platform(),
        arch: arch(),
        cpuModel: cpuInfo[0].model,
        logicalCpus: cpuInfo.length,
        loadavg: loadavg(),
      },
      quick: options.quick,
      repetitions: REPETITIONS,
      pageSize: PAGE_SIZE,
      partialPageMessages: PARTIAL_SIZE,
      percentileMethod: 'nearest-rank',
      durationMs: performance.now() - started,
      out,
      results,
      comparisons: comparisons(results),
    }
    const json = `${JSON.stringify(summary, null, 2)}\n`
    await fs.writeFile(out, json, { flag: 'wx', mode: 0o600 })
    process.stdout.write(json)
  } finally {
    // A compile/verification failure can leave a read-only source snapshot.
    for (const entry of await fs.readdir(runDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('source-')) {
        const root = join(runDir, entry.name, 'snapshot')
        await setSourcePermissions(root, false)
      }
    }
    await fs.rm(runDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Keep arbitrary imported error text and identifiers out of benchmark logs.
    process.stderr.write(
      `${JSON.stringify({
        benchmark: 'chat-open',
        outcome: 'error',
        code: error.code ?? error.name,
        commandExit: error.status ?? null,
      })}\n`
    )
    process.exitCode = 1
  })
}
