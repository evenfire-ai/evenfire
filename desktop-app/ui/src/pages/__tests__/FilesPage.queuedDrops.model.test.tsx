// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import fc from 'fast-check'
import { readGfsAccessState } from '@lib/gfsSessionAuthority'
import type { Tone } from '@/uiTypes'
import {
  AUTHORITY_FRESH_MS,
  IGNORED_UPLOAD_RECEIPT,
  type QueuedDropFixtures,
  type QueuedDropPage,
  mountQueuedDropPage,
  queuedDropFixtures,
  queuedDropScope,
  settle,
} from './__fixtures__/queuedDropHarness'

/**
 * Model-based oracle for queued drop uploads against the real FilesPage.
 * Commands drop files, leave and re-enter Files, end the session in main and
 * in the renderer, revoke on the server and degrade authority reads;
 * `fc.scheduler()` orders the resolution of every affordances read, session
 * confirmation and upload. Each upload and toast is snapshotted at the IPC /
 * toast seam, and the invariants are checked at rest against a trivial
 * reference: per dropped file, the session it was dropped under and whether
 * that session ended since.
 *
 * Attempt boundaries are not observable at the IPC seam (a fresh-cache attempt
 * makes no call before its session confirmation). Instead every toast is
 * attributed to the scheduled IPC whose resolution produced it: a step that
 * was blocked on an IPC issued before a session ended may still report once,
 * anything driven by a later IPC started after the end.
 */

const SEED = Number(process.env.QUEUED_DROPS_ORACLE_SEED ?? 33_151_121)
const RUNS = Number(process.env.QUEUED_DROPS_ORACLE_RUNS ?? 100)
const FILE_POOL = ['a.txt', 'b.txt', 'c.txt']

interface Origin {
  scope: string
  gen: number
}
interface FileRecord extends Origin {
  path: string
  dropSeq: number
  /** False once the origin session ended (switch, logout, revocation). */
  live: boolean
  uploaded: boolean
}
interface CallRecord {
  seq: number
  path: string
  mainGen: number
  access: 'active' | 'revoked'
}
interface ToastRecord {
  seq: number
  message: string
  tone: Tone
  published: Origin
  /** The scheduled IPC whose resolution produced the toast; null inside a command. */
  task: number | null
  /** Toasted synchronously by a drop that started no run (precondition, not a result). */
  refusal?: boolean
}
interface SessionEnd {
  seq: number
  /** Files of a session that was no longer published, still not uploaded (H4b). */
  foreignPending: number
}
interface Model {
  seq: number
  mainGen: number
  env: number
  filesMounted: boolean
  loggedOutMain: boolean
  loggedOutRenderer: boolean
  revoked401: boolean
  writeRevoked: boolean
  failNextRead: boolean
  drops: number
  files: FileRecord[]
  calls: CallRecord[]
  toasts: ToastRecord[]
  taskCreatedAt: Map<number, number>
  /** Tasks whose IPC answered that the session is gone (a 401, or main on another generation). */
  sessionGoneTasks: Set<number>
  currentTask: number | null
  sessionEnds: SessionEnd[]
  /** Upload 401s delivered while their origin was still the published session. */
  unauthorized: Array<Origin & { seq: number }>
  readsWhileUnmounted: number
  expiresWhileUnmounted: number
  conflicts: number
  executed: Set<string>
}
interface Real {
  scheduler: fc.Scheduler
  page: QueuedDropPage
  serverNames: string[]
}
type Command = fc.AsyncCommand<Model, Real>

const sameOrigin = (a: Origin, b: Origin) => a.scope === b.scope && a.gen === b.gen
const publishedOf = (page: QueuedDropPage): Origin => ({
  scope: queuedDropScope(page.harness()),
  gen: page.harness().generation,
})

async function step(model: Model, real: Real) {
  await act(async () => {
    await real.scheduler.waitOne()
  })
  await settle(2)
  model.currentTask = null
}

async function flush(model: Model, real: Real) {
  for (let round = 0; round < 400; round += 1) {
    if (real.scheduler.count() === 0) {
      await settle(4)
      if (real.scheduler.count() === 0) return
    }
    await step(model, real)
  }
  throw new Error('the page never came to rest')
}

const command = (
  name: string,
  run: (model: Model, real: Real) => Promise<void>,
  check: (model: Model) => boolean = () => true
): Command => ({
  check,
  async run(model, real) {
    model.currentTask = null
    await run(model, real)
    model.executed.add(name)
  },
  toString: () => name,
})

function endSession(model: Model, real: Real, evaluated: boolean) {
  model.seq += 1
  for (const file of model.files) file.live = false
  if (!evaluated) return
  const published = publishedOf(real.page)
  model.sessionEnds.push({
    seq: model.seq,
    foreignPending: model.files.filter(file => !file.uploaded && !sameOrigin(file, published))
      .length,
  })
}

let dropCounter = 0
const dropPaths = new WeakMap<File, string>()

function dropCommand(count: number): Command {
  return command(
    `Drop(${count})`,
    async (model, real) => {
      if (!real.page.region()) return
      dropCounter += 1
      const files = FILE_POOL.slice(0, count).map(name => {
        const file = new File([name], name, { type: 'text/plain' })
        dropPaths.set(file, `/fixture/drop-${dropCounter}/${name}`)
        return file
      })
      const toastsBefore = model.toasts.length
      model.seq += 1
      const dropSeq = model.seq
      act(() => {
        real.page.drop(files)
      })
      // A drop refused up front (no folder yet, no write access) toasts once
      // synchronously and starts no run.
      if (model.toasts.length > toastsBefore) {
        for (const toast of model.toasts.slice(toastsBefore)) toast.refusal = true
        return
      }
      model.drops += 1
      const origin = publishedOf(real.page)
      for (const file of files) {
        model.files.push({
          ...origin,
          path: dropPaths.get(file)!,
          dropSeq,
          // Dropped into a session the server already revoked: it ends at the
          // first IPC, like the files queued before the revocation.
          live: !model.revoked401,
          uploaded: false,
        })
      }
    },
    model => model.filesMounted && !model.loggedOutMain
  )
}

const commands = {
  leaveFiles: command(
    'LeaveFiles',
    async (model, real) => {
      model.filesMounted = false
      await real.page.leave()
    },
    model => model.filesMounted
  ),
  enterFiles: command(
    'EnterFiles',
    async (model, real) => {
      model.filesMounted = true
      await real.page.enter()
    },
    model => !model.filesMounted && !model.loggedOutMain
  ),
  // DEC-15-4: S2 is not evaluated after an environment switch.
  switchEnvironment: command(
    'SwitchEnvironment',
    async (model, real) => {
      endSession(model, real, false)
      model.mainGen += 1
      model.env += 1
      await real.page.publishSession({ env: model.env, generation: model.mainGen })
    },
    // `revoke401` persists on the server; a new session after it is out of the model.
    model => !model.loggedOutMain && !model.revoked401
  ),
  logoutMain: command(
    'LogoutMain',
    async (model, real) => {
      endSession(model, real, true)
      model.mainGen += 1
      model.loggedOutMain = true
    },
    model => !model.loggedOutMain
  ),
  logoutRenderer: command(
    'LogoutRenderer',
    async (model, real) => {
      model.loggedOutRenderer = true
      model.filesMounted = false
      await real.page.leave()
      await act(async () => real.page.queryClient.clear())
    },
    model => model.loggedOutMain && !model.loggedOutRenderer
  ),
  revoke401: command(
    'Revoke401',
    async (model, real) => {
      endSession(model, real, true)
      model.revoked401 = true
    },
    model => !model.revoked401
  ),
  revokeWriteBit: command(
    'RevokeWriteBit',
    async model => {
      model.writeRevoked = true
    },
    model => !model.writeRevoked
  ),
  readError: command(
    'ReadError',
    async model => {
      model.failNextRead = true
    },
    model => !model.loggedOutMain
  ),
  expireCache: command('ExpireCache', async (model, real) => {
    if (!model.filesMounted) model.expiresWhileUnmounted += 1
    real.page.advanceClock(AUTHORITY_FRESH_MS + 1_000)
  }),
  step: command('Step', async (model, real) => {
    if (real.scheduler.count() > 0) await step(model, real)
  }),
} satisfies Record<string, Command>

function initialModel(): Model {
  return {
    seq: 0,
    mainGen: 1,
    env: 0,
    filesMounted: true,
    loggedOutMain: false,
    loggedOutRenderer: false,
    revoked401: false,
    writeRevoked: false,
    failNextRead: false,
    drops: 0,
    files: [],
    calls: [],
    toasts: [],
    taskCreatedAt: new Map(),
    sessionGoneTasks: new Set(),
    currentTask: null,
    sessionEnds: [],
    unauthorized: [],
    readsWhileUnmounted: 0,
    expiresWhileUnmounted: 0,
    conflicts: 0,
    executed: new Set(),
  }
}

let fixtures: QueuedDropFixtures | null = null

async function setUp(scheduler: fc.Scheduler, model: Model): Promise<Real> {
  const fx = (fixtures ??= await queuedDropFixtures())
  let intercepting = false
  let tasks = 0
  const schedule = <T,>(label: string, settleValue: () => Promise<T> | T): Promise<T> => {
    if (!intercepting) return Promise.resolve().then(settleValue)
    tasks += 1
    const task = tasks
    model.seq += 1
    model.taskCreatedAt.set(task, model.seq)
    const mainGenAtCall = model.mainGen
    return scheduler.schedule(Promise.resolve(), label).then(async () => {
      model.currentTask = task
      if (label === 'session' && model.mainGen !== mainGenAtCall) {
        model.sessionGoneTasks.add(task)
      }
      try {
        return await settleValue()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === fx.readUnauthorized || message === fx.uploadUnauthorized) {
          model.sessionGoneTasks.add(task)
        }
        throw error
      }
    })
  }
  // eslint-disable-next-line prefer-const -- bound once the page is mounted
  let page: QueuedDropPage
  const serverNames: string[] = []

  const affordances = vi.fn((_resourceId: string, _drive?: string) => {
    if (!model.filesMounted) model.readsWhileUnmounted += 1
    return schedule('affordances', async () => {
      // Main without the session (logout) or a revoked session: unauthenticated.
      if (model.revoked401 || model.loggedOutMain) throw new Error(fx.readUnauthorized)
      if (model.failNextRead) {
        model.failNextRead = false
        throw new Error(fx.readFailure)
      }
      return model.writeRevoked ? fx.readOnly : fx.writable
    })
  })
  const createFileFromPath = vi.fn(
    (_parent: string, name: string, path: string, _drive?: string) => {
      const file = model.files.find(candidate => candidate.path === path)
      model.seq += 1
      model.calls.push({
        seq: model.seq,
        path,
        mainGen: model.mainGen,
        access: file ? readGfsAccessState(page.queryClient, file.scope, file.gen) : 'revoked',
      })
      return schedule(`upload:${name}`, async () => {
        if (model.revoked401 || model.loggedOutMain) {
          if (file && sameOrigin(file, publishedOf(page))) {
            model.seq += 1
            model.unauthorized.push({ seq: model.seq, scope: file.scope, gen: file.gen })
          }
          throw new Error(fx.uploadUnauthorized)
        }
        if (serverNames.includes(name)) {
          model.conflicts += 1
          throw new Error(fx.conflict)
        }
        serverNames.push(name)
        if (file) file.uploaded = true
        return IGNORED_UPLOAD_RECEIPT
      })
    }
  )
  page = await mountQueuedDropPage(fx, {
    affordances,
    createFileFromPath,
    getSessionGeneration: () => schedule('session', async () => model.mainGen),
    listedNames: () => serverNames,
    pathForFile: file => dropPaths.get(file),
    onToast: (message, tone, published) => {
      model.seq += 1
      model.toasts.push({
        seq: model.seq,
        message,
        tone,
        published: { scope: queuedDropScope(published), gen: published.generation },
        task: model.currentTask,
      })
    },
  })
  intercepting = true
  return { scheduler, page, serverNames }
}

function assertAtRest(model: Model, real: Real) {
  const fileOf = (path: string) => model.files.find(candidate => candidate.path === path)

  // S1: an upload leaves only under its origin session, with access active,
  // and never after that session already answered an upload with a 401.
  for (const call of model.calls) {
    const file = fileOf(call.path)
    expect(file, `upload ${call.path} without a dropped file`).toBeDefined()
    expect({ mainGen: call.mainGen, access: call.access }, `S1 ${call.path}`).toEqual({
      mainGen: file!.gen,
      access: 'active',
    })
    const refused = model.unauthorized.find(
      denial => sameOrigin(denial, file!) && denial.seq < call.seq
    )
    expect(refused, `S1 ${call.path} sent after a 401 under its session`).toBeUndefined()
  }

  // S4: an upload 401 under the published session fails closed on that session.
  for (const denial of model.unauthorized) {
    expect(
      readGfsAccessState(real.page.queryClient, denial.scope, denial.gen),
      `S4 ${denial.scope}#${denial.gen} revoked after an upload 401`
    ).toBe('revoked')
  }

  // S3: no upload overwrote another.
  expect(new Set(real.serverNames).size, 'S3 unique names').toBe(real.serverNames.length)

  // V1: a live file is uploaded or its attempt toasted an error. Each failed
  // attempt toasts once, so per origin the missing files are bounded by the
  // error toasts emitted under that session after the earliest of them.
  const missing = model.files.filter(file => file.live && !file.uploaded)
  const origins = new Map<string, FileRecord[]>()
  for (const file of missing) {
    const key = `${file.scope}#${file.gen}`
    origins.set(key, [...(origins.get(key) ?? []), file])
  }
  for (const [key, files] of origins) {
    const since = Math.min(...files.map(file => file.dropSeq))
    const errors = model.toasts.filter(
      toast =>
        toast.tone === 'error' &&
        !toast.refusal &&
        toast.seq > since &&
        sameOrigin(toast.published, files[0]!)
    )
    expect(
      errors.length,
      `V1 ${key}: ${files.length} live file(s) neither uploaded nor reported: ${files
        .map(file => file.path)
        .join(', ')}`
    ).toBeGreaterThanOrEqual(files.length)
  }

  // S2: after a logout in main or a server revocation, only a step that was
  // already waiting on an IPC may still report, once (H17), and not when that
  // IPC answered that the session is gone: that step fails closed or aborts,
  // and whatever toasts in its wake belongs to a later step. Files of a
  // session that was no longer published may still toast in the new one (H4b).
  for (const end of model.sessionEnds) {
    const after = model.toasts.filter(toast => !toast.refusal && toast.seq > end.seq)
    const perTask = new Map<number, number>()
    let excess = 0
    for (const toast of after) {
      const createdAt = toast.task === null ? undefined : model.taskCreatedAt.get(toast.task)
      if (
        createdAt === undefined ||
        createdAt > end.seq ||
        model.sessionGoneTasks.has(toast.task!)
      ) {
        excess += 1
        continue
      }
      const count = (perTask.get(toast.task!) ?? 0) + 1
      perTask.set(toast.task!, count)
      if (count > 1) excess += 1
    }
    expect(
      excess,
      `S2 toasts from steps started after the session ended at #${end.seq}: ${after
        .map(toast => toast.message)
        .join(' | ')}`
    ).toBeLessThanOrEqual(end.foreignPending)
  }

  // K1: at most one authority read per attempt (a name conflict starts a new
  // attempt), plus one per run still reading when the cache expired (H18).
  expect(model.readsWhileUnmounted, 'K1 reads while Files is unmounted').toBeLessThanOrEqual(
    model.files.length + model.conflicts + model.expiresWhileUnmounted * model.drops
  )
}

interface Coverage {
  executed: Set<string>
  files: number
  uploads: number
  leftFiles: number
}

async function runSequence(
  scheduler: fc.Scheduler,
  sequence: Iterable<Command>,
  coverage?: Coverage
) {
  const model = initialModel()
  const real = await setUp(scheduler, model)
  try {
    await fc.asyncModelRun(() => ({ model, real }), sequence)
    await flush(model, real)
    assertAtRest(model, real)
    if (coverage) {
      model.executed.forEach(kind => coverage.executed.add(kind))
      coverage.files += model.files.length
      coverage.uploads += model.calls.length
      if (model.executed.has('LeaveFiles')) coverage.leftFiles += 1
    }
  } finally {
    cleanup()
    real.page.queryClient.clear()
    vi.restoreAllMocks()
  }
}

afterEach(() => {
  cleanup()
})

const c = commands
const drop1 = dropCommand(1)
const drop2 = dropCommand(2)
const drop3 = dropCommand(3)
const keySequences: Array<[string, Command[]]> = [
  ['leave while the first upload runs (L5)', [drop2, c.step, c.leaveFiles, c.step, c.step]],
  [
    'leave with an expired authority',
    [drop2, c.step, c.leaveFiles, c.expireCache, c.step, c.step, c.step],
  ],
  [
    'read error after leaving (L14)',
    [drop2, c.step, c.leaveFiles, c.expireCache, c.readError, c.step, c.step],
  ],
  ['logout in main, cache still warm', [drop2, c.step, c.leaveFiles, c.logoutMain, c.step]],
  [
    'logout in main, then the renderer clears',
    [drop2, c.step, c.leaveFiles, c.logoutMain, c.step, c.logoutRenderer, c.step],
  ],
  ['revocation while the queue runs', [drop3, c.step, c.leaveFiles, c.revoke401, c.step]],
  [
    'revocation answered by the second upload',
    [drop3, c.step, c.step, c.step, c.leaveFiles, c.revoke401, c.step, c.step, c.step],
  ],
  [
    'orphan and a new Files upload the same names',
    [drop2, c.leaveFiles, c.enterFiles, c.step, c.step, drop2, c.step, c.step, c.step],
  ],
  [
    'environment switch after leaving',
    [drop2, c.step, c.leaveFiles, c.switchEnvironment, c.step, c.step],
  ],
  [
    'environment switch while the next file reads an expired authority',
    [drop2, c.leaveFiles, c.expireCache, c.step, c.switchEnvironment, c.step, c.step],
  ],
  [
    'write bit revoked after leaving',
    [drop2, c.step, c.leaveFiles, c.revokeWriteBit, c.expireCache, c.step],
  ],
  ['single file, stay on Files', [drop1, c.step, c.step, c.step]],
]

// Weighted towards the queue's own moves: session enders are rare in practice
// and end every later attempt, so at equal weight they dominate short runs.
const weightedCommands: Array<{ weight: number; arbitrary: fc.Arbitrary<Command> }> = [
  ...[drop1, drop2, drop3].map(cmd => ({ weight: 3, arbitrary: fc.constant(cmd) })),
  { weight: 10, arbitrary: fc.constant(commands.step) },
  { weight: 3, arbitrary: fc.constant(commands.leaveFiles) },
  { weight: 2, arbitrary: fc.constant(commands.enterFiles) },
  { weight: 2, arbitrary: fc.constant(commands.expireCache) },
  ...[
    commands.switchEnvironment,
    commands.logoutMain,
    commands.logoutRenderer,
    commands.revoke401,
    commands.revokeWriteBit,
    commands.readError,
  ].map(cmd => ({ weight: 1, arbitrary: fc.constant(cmd) })),
]

describe('queued drop uploads oracle (FilesPage)', () => {
  for (const [name, sequence] of keySequences) {
    it(`holds V1, S1–S4 and K1 for: ${name}`, async () => {
      await fc.assert(
        fc.asyncProperty(fc.scheduler(), async scheduler => runSequence(scheduler, sequence)),
        { numRuns: 3, seed: SEED, endOnFailure: true }
      )
    }, 30_000)
  }

  it('holds V1, S1–S4 and K1 over generated sequences', async () => {
    const coverage: Coverage = { executed: new Set(), files: 0, uploads: 0, leftFiles: 0 }
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.commands([fc.oneof(...weightedCommands)], { maxCommands: 24, size: 'large' }),
        async (scheduler, sequence) => runSequence(scheduler, sequence, coverage)
      ),
      { numRuns: RUNS, seed: SEED, endOnFailure: true }
    )
    for (const kind of ['Drop(2)', 'Step', 'LeaveFiles', 'LogoutMain', 'Revoke401']) {
      expect(coverage.executed, `generated runs never executed ${kind}`).toContain(kind)
    }
    expect(coverage.files, 'generated sequences dropped no file').toBeGreaterThan(0)
    expect(coverage.uploads, 'generated sequences uploaded nothing').toBeGreaterThan(0)
    expect(coverage.leftFiles, 'generated sequences never left Files').toBeGreaterThan(0)
  }, 120_000)
})
