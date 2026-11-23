import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashKey, onlineManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import fc from 'fast-check'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import {
  AGENT,
  DIRECT_GRANT,
  DOWNGRADE_SUCCESS,
  type InterceptedIpc,
  MEMBER,
  MEMBER_ID,
  PARENT_ONE,
  PARENT_ONE_GRANT,
  PARENT_TWO,
  PARENT_TWO_GRANT,
  type ParentUpdateOwner,
  type ParentUpdatePage,
  REMOVE_SUCCESS,
  SESSION_SCOPE,
  TARGET_ID,
  mountParentUpdatePage,
  waitSettled,
} from './parentUpdateHarness'

/**
 * Model-based oracle for the Share dialog's parent-folder confirmation, run
 * once per owner (the Files page and the sidebar's action host) against the
 * same reference model. Commands drive the real owner; `fc.scheduler()`
 * orders the resolution of every confirmation write, pre-flight affordances
 * read and session confirmation. Every write and toast is snapshotted at the
 * moment it reaches the IPC/toast seam, and the invariants are checked at
 * rest against a trivial reference: the plan's generation, the revocation
 * epoch at confirm, and whether anything disturbed the run.
 *
 * "NavigateAway" leaves the dialog's surface without closing it: FilesPage
 * unmounts; the host replaces Share with another action on the same row.
 */

const SEED = Number(process.env.PARENT_UPDATE_ORACLE_SEED ?? 33_081_119)
const RUNS = Number(process.env.PARENT_UPDATE_ORACLE_RUNS ?? 40)

type Mode = 'remove' | 'change-role'
const PLAN_WRITES: Record<Mode, string[]> = {
  remove: [
    `revokeGrant:${PARENT_ONE_GRANT}`,
    `revokeGrant:${PARENT_TWO_GRANT}`,
    `revokeGrant:${DIRECT_GRANT}`,
  ],
  'change-role': [`grant:${PARENT_ONE}`, `grant:${PARENT_TWO}`, `grant:${TARGET_ID}`],
}
const RUN_OUTCOME_PREFIXES = [
  'Access removed on',
  `${MEMBER} is now`,
  'Removed from',
  'Updated ',
  'Changed grant access',
]

interface Snapshot {
  seq: number
  mainGen: number
  rendererGen: number
  access: 'active' | 'revoked'
  epoch: number
}
interface WriteRecord extends Snapshot {
  target: string
}
interface ToastRecord extends Snapshot {
  message: string
  tone: string
}
interface RunRecord {
  mode: Mode
  gen: number
  epoch: number
  startIndex: number
  startSeq: number
  stable: boolean
  navigatedBeforeFirstWrite: boolean
}
interface AuthorityFailure {
  seq: number
  /** The live session it can revoke; -1 once the renderer published another. */
  gen: number
}
interface IssuedAuthorityFailure extends AuthorityFailure {
  /** The session the failing request was issued under. */
  issuedGen: number
}
/** A revocation the model itself caused; `gen` null covers every session (logout). */
interface ModelRevocation {
  seq: number
  gen: number | null
}

interface Real {
  owner: ParentUpdateOwner
  page: ParentUpdatePage
  scheduler: fc.Scheduler
  failureMessages: Record<'authority' | 'other', { write: string; preflight: string }>
}
interface Model {
  seq: number
  epoch: number
  dialogGen: number | null
  loggedOut: boolean
  pure: boolean
  failNext: 'authority' | 'other' | null
  failNextSession: boolean
  pendingConfirmationWrites: number
  writes: WriteRecord[]
  toasts: ToastRecord[]
  runs: RunRecord[]
  authorityFailures: IssuedAuthorityFailure[]
  revokedWrites: AuthorityFailure[]
  revocations: ModelRevocation[]
  sessionCallsAtMount: number
  retried: number
  executed: Set<string>
}
type Command = fc.AsyncCommand<Model, Real>

function snapshot(model: Model, page: ParentUpdatePage): Snapshot {
  model.seq += 1
  return {
    seq: model.seq,
    mainGen: page.mainGeneration(),
    rendererGen: page.rendererGeneration(),
    access: page.accessState(),
    epoch: model.epoch,
  }
}

function disturbRuns(model: Model) {
  for (const run of model.runs) run.stable = false
}

function confirmationWriteTarget(name: string, args: unknown[]): string | null {
  if (name === 'grant') {
    const subjects = args[1] as string[]
    return subjects[0] === `user:${MEMBER_ID}` ? `grant:${String(args[0])}` : null
  }
  return `${name}:${String(args[0])}`
}

async function flush(real: Real) {
  for (let round = 0; round < 40; round += 1) {
    if (real.scheduler.count() === 0) {
      await waitSettled(3)
      if (real.scheduler.count() === 0) return
    }
    await act(async () => {
      await real.scheduler.waitAll()
    })
  }
  throw new Error('the page never came to rest')
}

function shareDialog() {
  return screen.queryByRole('dialog', { name: 'Share folder Folder A' })
}

const command = (
  name: string,
  run: (model: Model, real: Real) => Promise<void>,
  check: (model: Model) => boolean = () => true
): Command => ({
  check,
  async run(model, real) {
    await run(model, real)
    model.executed.add(name)
  },
  toString: () => name,
})

const impure = (model: Model) => {
  model.pure = false
}

function tryCloseCommand(way: 'escape' | 'backdrop' | 'button'): Command {
  return command(`TryCloseDialog(${way})`, async model => {
    const dialog = shareDialog()
    if (!dialog) return
    const mustStayOpen = model.pendingConfirmationWrites > 0
    await act(async () => {
      if (way === 'escape') fireEvent.keyDown(window, { key: 'Escape' })
      else if (way === 'backdrop') fireEvent.mouseDown(dialog.parentElement!)
      else fireEvent.click(screen.getByRole('button', { name: 'Close share dialog' }))
    })
    // L3: nothing closes Share while a confirmed run still writes.
    if (mustStayOpen) expect(shareDialog()).not.toBeNull()
    if (!shareDialog()) model.dialogGen = null
  })
}

const commands = {
  openRemove: command('OpenRemove', async (model, real) => {
    const trigger = screen.queryByRole('button', { name: `Actions for ${MEMBER}` })
    if (!shareDialog() || screen.queryByRole('alertdialog') || !trigger) return
    if ((trigger as HTMLButtonElement).disabled) return
    await act(async () => fireEvent.click(trigger))
    const item = screen.queryByRole('menuitem', { name: 'Remove access' })
    if (item) await act(async () => fireEvent.click(item))
    void real
  }),
  openChangeRole: command('OpenChangeRole(read)', async () => {
    const role = screen.queryByRole('button', { name: `Access role for ${MEMBER}` })
    if (!shareDialog() || screen.queryByRole('alertdialog') || !role) return
    if ((role as HTMLButtonElement).disabled) return
    await act(async () => fireEvent.click(role))
    const option = screen.queryByRole('option', { name: 'Read' })
    if (option) await act(async () => fireEvent.click(option))
  }),
  confirm: command('Confirm', async (model, real) => {
    const dialog = screen.queryByRole('alertdialog')
    if (!dialog || model.dialogGen === null) return
    const button = within(dialog).queryByRole('button', {
      name: /^(Remove|Update role)$/,
    }) as HTMLButtonElement | null
    if (!button || button.disabled) return
    const mode: Mode = button.textContent === 'Remove' ? 'remove' : 'change-role'
    const page = real.page
    model.seq += 1
    model.runs.push({
      mode,
      gen: model.dialogGen,
      epoch: model.epoch,
      startIndex: model.writes.length,
      startSeq: model.seq,
      stable:
        page.mainGeneration() === model.dialogGen &&
        page.rendererGeneration() === model.dialogGen &&
        page.accessState() === 'active' &&
        model.failNext === null &&
        !model.failNextSession,
      navigatedBeforeFirstWrite: false,
    })
    await act(async () => fireEvent.click(button))
  }),
  cancel: command('Cancel', async () => {
    const dialog = screen.queryByRole('alertdialog')
    const button = dialog
      ? (within(dialog).queryByRole('button', { name: 'Cancel' }) as HTMLButtonElement | null)
      : null
    if (!button || button.disabled) return
    await act(async () => fireEvent.click(button))
  }),
  'tryClose-escape': tryCloseCommand('escape'),
  'tryClose-backdrop': tryCloseCommand('backdrop'),
  'tryClose-button': tryCloseCommand('button'),
  switchMain: command(
    'SwitchTeam(main)',
    async (model, real) => {
      impure(model)
      disturbRuns(model)
      real.page.switchMain()
    },
    model => !model.loggedOut
  ),
  publishSwitch: command(
    'SwitchTeam(renderer publishes)',
    async (model, real) => {
      if (real.page.mainGeneration() === real.page.rendererGeneration()) return
      impure(model)
      disturbRuns(model)
      await real.page.publishGeneration()
      if (!shareDialog()) model.dialogGen = null
    },
    model => !model.loggedOut
  ),
  revoke: command(
    'Revoke',
    async (model, real) => {
      impure(model)
      disturbRuns(model)
      model.epoch += 1
      model.seq += 1
      model.revocations.push({ seq: model.seq, gen: real.page.rendererGeneration() })
      real.page.revoke()
      // The revoked surface (and its Retry) renders after the owner's effects.
      await waitSettled(3)
      if (!shareDialog()) model.dialogGen = null
    },
    model => !model.loggedOut
  ),
  purge: command(
    'Revoke(purge)',
    async (model, real) => {
      impure(model)
      disturbRuns(model)
      model.epoch += 1
      model.seq += 1
      model.revocations.push({ seq: model.seq, gen: real.page.rendererGeneration() })
      real.page.purge()
      await waitSettled(3)
      if (!shareDialog()) model.dialogGen = null
    },
    model => !model.loggedOut
  ),
  retryAccess: command('RetryAccess', async (model, real) => {
    const retry = screen.queryByRole('button', { name: 'Retry file access' })
    if (!retry) return
    impure(model)
    await act(async () => fireEvent.click(retry))
    expect(real.page.accessState(), 'a retry restores access').toBe('active')
    model.retried += 1
  }),
  navigateAway: command('NavigateAway', async (model, real) => {
    if (!real.page.filesMounted()) return
    impure(model)
    for (const run of model.runs) {
      if (model.writes.length === run.startIndex) run.navigatedBeforeFirstWrite = true
    }
    await real.page.navigateAway()
    model.dialogGen = null
  }),
  returnToFiles: command(
    'ReturnToFiles',
    async (model, real) => {
      if (real.page.filesMounted()) return
      await real.page.returnToFiles()
    },
    model => !model.loggedOut
  ),
  openShare: command(
    'OpenShare',
    async (model, real) => {
      const share = screen.queryByRole('button', { name: 'Share Folder A' })
      if (shareDialog() || !share) return
      await act(async () => fireEvent.click(share))
      await waitSettled(3)
      if (shareDialog()) model.dialogGen = real.page.rendererGeneration()
    },
    model => !model.loggedOut
  ),
  goOffline: command('GoOffline', async (_model, real) => real.page.goOffline()),
  goOnline: command('GoOnline', async (_model, real) => real.page.goOnline()),
  logout: command(
    'Logout',
    async (model, real) => {
      impure(model)
      disturbRuns(model)
      model.epoch += 1
      model.loggedOut = true
      model.seq += 1
      model.revocations.push({ seq: model.seq, gen: null })
      if (real.owner === 'files') {
        await real.page.navigateAway()
        await act(async () => real.page.queryClient.clear())
      } else {
        await real.page.logout()
      }
      model.dialogGen = null
    },
    model => !model.loggedOut
  ),
  directRoleChange: command('DirectRoleChange', async model => {
    const role = screen.queryByRole('button', { name: `Access role for ${AGENT}` })
    if (!shareDialog() || !role || (role as HTMLButtonElement).disabled) return
    impure(model)
    await act(async () => fireEvent.click(role))
    const option = screen.queryByRole('option', { name: 'Editor' })
    if (option) await act(async () => fireEvent.click(option))
  }),
  failAuthority: command('FailNextWrite(authority)', async model => {
    impure(model)
    disturbRuns(model)
    model.failNext = 'authority'
  }),
  failOther: command('FailNextWrite(other)', async model => {
    impure(model)
    disturbRuns(model)
    model.failNext = 'other'
  }),
  failSession: command('FailNextSessionIpc', async model => {
    impure(model)
    disturbRuns(model)
    model.failNextSession = true
  }),
  step: command('Step', async (_model, real) => {
    if (real.scheduler.count() === 0) return
    await act(async () => {
      await real.scheduler.waitOne()
    })
  }),
} satisfies Record<string, Command>

function initialModel(): Model {
  return {
    seq: 0,
    epoch: 0,
    dialogGen: 1,
    loggedOut: false,
    pure: true,
    failNext: null,
    failNextSession: false,
    pendingConfirmationWrites: 0,
    writes: [],
    toasts: [],
    runs: [],
    authorityFailures: [],
    revokedWrites: [],
    revocations: [],
    sessionCallsAtMount: 0,
    retried: 0,
    executed: new Set(),
  }
}

async function setUp(
  owner: ParentUpdateOwner,
  scheduler: fc.Scheduler,
  model: Model
): Promise<Real> {
  // eslint-disable-next-line prefer-const -- assigned once the page exists
  let real: Real
  const intercept = (kind: InterceptedIpc, args: unknown[], settle: () => Promise<unknown>) => {
    const page = real.page
    if (kind === 'session') {
      const fail = model.failNextSession
      model.failNextSession = false
      return scheduler.schedule(Promise.resolve(), 'session').then(async () => {
        if (fail) throw new Error('session IPC failed')
        return settle()
      })
    }
    const failure = model.failNext
    model.failNext = null
    const confirmationTarget =
      kind === 'write' ? confirmationWriteTarget(String(args[0]), args.slice(1)) : null
    if (confirmationTarget) {
      model.writes.push({ ...snapshot(model, page), target: confirmationTarget })
      model.pendingConfirmationWrites += 1
    }
    const capturedGen = page.rendererGeneration()
    return scheduler
      .schedule(Promise.resolve(), `${kind}:${String(args[0])}`)
      .then(async () => {
        if (failure) {
          if (failure === 'authority') {
            model.seq += 1
            model.authorityFailures.push({
              seq: model.seq,
              gen: page.rendererGeneration() === capturedGen ? capturedGen : -1,
              issuedGen: capturedGen,
            })
          }
          const messages = real.failureMessages[failure]
          throw new Error(kind === 'preflight' ? messages.preflight : messages.write)
        }
        return settle()
      })
      .finally(() => {
        if (confirmationTarget) model.pendingConfirmationWrites -= 1
      })
  }
  const page = await mountParentUpdatePage({ agentGrant: true, intercept, owner })
  real = {
    owner,
    page,
    scheduler,
    failureMessages: {
      authority: {
        write: await page.failureMessage(401),
        preflight: await page.affordancesFailure(401),
      },
      other: {
        write: await page.failureMessage(500),
        preflight: await page.affordancesFailure(500),
      },
    },
  }
  page.pushToast.mockImplementation((message, tone) => {
    model.toasts.push({ ...snapshot(model, page), message, tone })
  })
  const revokedHashes = new Map(
    Array.from({ length: 12 }, (_, gen) => [
      hashKey(desktopQueryKeys.gfsAccessState(SESSION_SCOPE, gen)),
      gen,
    ])
  )
  page.queryClient.getQueryCache().subscribe(event => {
    const gen = revokedHashes.get(event.query.queryHash)
    if (gen === undefined || event.type !== 'updated') return
    if (event.query.state.data !== 'revoked') return
    model.seq += 1
    model.revokedWrites.push({ seq: model.seq, gen })
  })
  model.sessionCallsAtMount = page.getSessionGeneration.mock.calls.length
  return real
}

function assertAtRest(model: Model, real: Real) {
  const page = real.page
  const runFor = (index: number) =>
    [...model.runs].reverse().find(run => run.startIndex <= index) ?? null

  // S1 / S3: a confirmation write leaves only under its plan's session, with
  // access active and no revocation since the run started (retry or not).
  model.writes.forEach((write, index) => {
    const run = runFor(index)
    expect(run, `write ${write.target} without a confirmed run`).not.toBeNull()
    expect(write, `S1 ${write.target}`).toMatchObject({
      mainGen: run!.gen,
      rendererGen: run!.gen,
      access: 'active',
      epoch: run!.epoch,
    })
  })

  // One run at a time, in plan order; a run that had not written when the
  // user navigated away never starts.
  model.runs.forEach((run, index) => {
    const end = model.runs[index + 1]?.startIndex ?? model.writes.length
    const targets = model.writes.slice(run.startIndex, end).map(write => write.target)
    expect(PLAN_WRITES[run.mode].slice(0, targets.length), 'single run, plan order').toEqual(
      targets
    )
    if (run.navigatedBeforeFirstWrite) expect(targets, 'R7a').toEqual([])
    if (run.stable && !run.navigatedBeforeFirstWrite) {
      // L1: an undisturbed run applies every write, even after a navigation.
      expect(targets, 'L1 writes').toEqual(PLAN_WRITES[run.mode])
    }
  })

  // S2: no toast reaches the user under another session or revoked access.
  for (const toast of model.toasts) {
    expect(toast, `S2 "${toast.message}"`).toMatchObject({
      mainGen: toast.rendererGen,
      access: 'active',
    })
  }
  const outcomes = model.toasts.filter(toast =>
    RUN_OUTCOME_PREFIXES.some(prefix => toast.message.startsWith(prefix))
  )
  for (const toast of outcomes) {
    const run = [...model.runs].reverse().find(candidate => candidate.startSeq < toast.seq)
    expect(run, `outcome "${toast.message}" without a run`).toBeDefined()
    expect(toast.rendererGen, 'S2 outcome in its own session').toBe(run!.gen)
  }

  // L1: exactly one outcome per completed undisturbed run, none for a run
  // that never started.
  const completing = model.runs.filter(run => run.stable && !run.navigatedBeforeFirstWrite)
  const silent = model.runs.filter(run => run.navigatedBeforeFirstWrite)
  const undetermined = model.runs.length - completing.length - silent.length
  expect(outcomes.length, 'L1 outcomes').toBeGreaterThanOrEqual(completing.length)
  expect(outcomes.length, 'L1 outcomes').toBeLessThanOrEqual(completing.length + undetermined)
  for (const run of completing) {
    const expected = run.mode === 'remove' ? REMOVE_SUCCESS : DOWNGRADE_SUCCESS
    expect(outcomes.map(toast => toast.message)).toContain(expected)
  }

  // S4: a live-session 401 from a dialog IPC always ends revoked.
  for (const failure of model.authorityFailures) {
    if (failure.gen < 0) continue
    expect(
      model.revokedWrites.some(write => write.seq > failure.seq && write.gen === failure.gen),
      'S4 authority failure revoked'
    ).toBe(true)
  }
  // S4, other side: a revocation lands only on the session that earned it — a
  // model Revoke/Purge/Logout of that session, or a 401 issued under it. A
  // late 401 from a replaced session must not revoke the one that replaced it.
  for (const write of model.revokedWrites) {
    const earned =
      model.revocations.some(
        revocation =>
          revocation.seq < write.seq && (revocation.gen === null || revocation.gen === write.gen)
      ) ||
      model.authorityFailures.some(
        failure => failure.seq < write.seq && failure.issuedGen === write.gen
      )
    expect(earned, `S4 revocation of generation ${write.gen} without a cause`).toBe(true)
  }

  // L3: at rest the dialog can always be closed again.
  if (shareDialog()) {
    const close = screen.getByRole('button', { name: 'Close share dialog' }) as HTMLButtonElement
    expect(close.disabled, 'L3 close enabled at rest').toBe(false)
  }

  // K1: one session confirmation per write plus one per attempted outcome.
  if (model.pure) {
    const expectedCalls = model.runs.reduce(
      (total, run) =>
        total + PLAN_WRITES[run.mode].length + (run.navigatedBeforeFirstWrite ? 0 : 1),
      0
    )
    expect(
      page.getSessionGeneration.mock.calls.length - model.sessionCallsAtMount,
      'K1 session confirmations'
    ).toBe(expectedCalls)
  }
}

const allCommands = Object.values(commands)

interface OracleCoverage {
  executedKinds: Set<string>
  runs: number
  writes: number
  disturbedRuns: number
}

async function runSequence(
  owner: ParentUpdateOwner,
  coverage: OracleCoverage,
  scheduler: fc.Scheduler,
  sequence: Iterable<Command>,
  expectRetry = false
) {
  const model = initialModel()
  const real = await setUp(owner, scheduler, model)
  try {
    await fc.asyncModelRun(() => ({ model, real }), sequence)
    await flush(real)
    assertAtRest(model, real)
    if (expectRetry) expect(model.retried, 'the sequence retried access').toBeGreaterThan(0)
    model.executed.forEach(kind => coverage.executedKinds.add(kind))
    coverage.runs += model.runs.length
    coverage.writes += model.writes.length
    coverage.disturbedRuns += model.runs.filter(run => !run.stable).length
  } finally {
    cleanup()
    real.page.queryClient.clear()
    onlineManager.setOnline(true)
    vi.restoreAllMocks()
  }
}

const c = commands
const keySequences: Array<[string, Command[]]> = [
  [
    'latch: revoke + retry mid-write',
    [c.openRemove, c.confirm, c.step, c.step, c.revoke, c.retryAccess, c.step, c.step, c.step],
  ],
  [
    'purge + retry mid-write',
    [c.openRemove, c.confirm, c.step, c.step, c.purge, c.retryAccess, c.step, c.step],
  ],
  [
    'main switches after the first remove write',
    [c.openRemove, c.confirm, c.step, c.switchMain, c.step, c.step, c.step],
  ],
  [
    'main switches mid change-role',
    [
      c.openChangeRole,
      c.step,
      c.step,
      c.confirm,
      c.step,
      c.switchMain,
      c.step,
      c.step,
      c.publishSwitch,
      c.step,
    ],
  ],
  [
    'navigation after the first write',
    [c.openRemove, c.confirm, c.step, c.step, c.navigateAway, c.step, c.step],
  ],
  ['navigation before the first write', [c.openRemove, c.confirm, c.navigateAway, c.step]],
  [
    'close attempts while the first write is pending',
    [
      c.openRemove,
      c.confirm,
      c.step,
      c['tryClose-escape'],
      c['tryClose-backdrop'],
      c['tryClose-button'],
      c.step,
      c.step,
    ],
  ],
  [
    'offline run completes',
    [c.openRemove, c.goOffline, c.confirm, c.step, c.step, c.step, c.step, c.step, c.step],
  ],
  [
    'offline then logout mid-run',
    [c.openRemove, c.goOffline, c.confirm, c.step, c.step, c.logout, c.step],
  ],
  [
    'direct role change overlapping a run',
    [
      c.directRoleChange,
      c.openRemove,
      c.confirm,
      c.step,
      c['tryClose-escape'],
      c.step,
      c['tryClose-backdrop'],
      c.step,
      c['tryClose-button'],
    ],
  ],
  [
    'authority failure mid-run',
    [c.openRemove, c.confirm, c.step, c.failAuthority, c.step, c.step, c.step],
  ],
  [
    'pre-flight authority failure after close',
    [c.failAuthority, c.openChangeRole, c['tryClose-button'], c.step, c.step],
  ],
  [
    'authority failure on a direct folder grant mid change-role',
    [c.openChangeRole, c.step, c.step, c.confirm, c.failAuthority, c.step, c.step, c.step],
  ],
  [
    'late 401 of a direct folder grant after the team switch',
    [
      c.openChangeRole,
      c.step,
      c.step,
      c.confirm,
      c.failAuthority,
      c.step,
      c.switchMain,
      c.publishSwitch,
      c.step,
    ],
  ],
  [
    'session IPC failure mid-run',
    [c.openChangeRole, c.step, c.step, c.confirm, c.step, c.failSession, c.step, c.step],
  ],
  [
    'clean back-to-back runs',
    [
      c.openRemove,
      c.confirm,
      c.step,
      c.step,
      c.step,
      c.step,
      c.step,
      c.step,
      c.step,
      c.openChangeRole,
      c.step,
      c.step,
      c.confirm,
    ],
  ],
]

const SEQUENCES_WITHOUT_RUN = new Set(['direct role change overlapping a run'])
const DISRUPTION_SEQUENCES = new Set([
  'latch: revoke + retry mid-write',
  'purge + retry mid-write',
  'main switches after the first remove write',
  'main switches mid change-role',
  'offline then logout mid-run',
  'authority failure mid-run',
  'authority failure on a direct folder grant mid change-role',
  'late 401 of a direct folder grant after the team switch',
  'session IPC failure mid-run',
])

const OWNER_TITLES: Record<ParentUpdateOwner, string> = {
  files: 'FilesPage owner',
  host: 'action host owner',
}

/** Registers the oracle's suite for one owner of the Share dialog. */
export function describeParentUpdateOracle(owner: ParentUpdateOwner) {
  afterEach(() => {
    cleanup()
    onlineManager.setOnline(true)
  })
  const emptyCoverage = (): OracleCoverage => ({
    executedKinds: new Set(),
    runs: 0,
    writes: 0,
    disturbedRuns: 0,
  })
  describe(`parent-folder confirmation oracle (${OWNER_TITLES[owner]})`, () => {
    for (const [name, sequence] of keySequences) {
      it(`holds S1–S4, L1–L3 and K1 for: ${name}`, async () => {
        const coverage = emptyCoverage()
        await fc.assert(
          fc.asyncProperty(fc.scheduler(), async scheduler =>
            runSequence(owner, coverage, scheduler, sequence, sequence.includes(c.retryAccess))
          ),
          { numRuns: 3, seed: SEED, endOnFailure: true }
        )
        // A Confirm that never finds an enabled button is a no-op, and the
        // invariants then hold over nothing: each sequence that confirms must
        // start a run. The direct role change keeps Remove disabled while it
        // is pending, so that sequence pins that no run starts.
        const expectsRun = sequence.includes(c.confirm) && !SEQUENCES_WITHOUT_RUN.has(name)
        expect(coverage.runs > 0, `${name}: runs confirmed (${coverage.runs})`).toBe(expectsRun)
        // A disruption whose command stopped applying would leave its run
        // undisturbed and the scenario green: each one must disturb its run.
        expect(
          coverage.disturbedRuns > 0,
          `${name}: disturbed runs (${coverage.disturbedRuns})`
        ).toBe(DISRUPTION_SEQUENCES.has(name))
      }, 30_000)
    }

    // A fuzz over the reachable prefix: at this size the generator rarely
    // opens the confirmation and enables it, so it is not asserted to reach
    // Confirm or Step. The scenario sequences above carry that coverage, each
    // asserting the run it starts.
    it('holds S1–S4, L1–L3 and K1 over generated sequences', async () => {
      const coverage = emptyCoverage()
      await fc.assert(
        fc.asyncProperty(
          fc.scheduler(),
          fc.commands([fc.constantFrom(...allCommands)], { maxCommands: 18 }),
          async (scheduler, sequence) => runSequence(owner, coverage, scheduler, sequence)
        ),
        { numRuns: RUNS, seed: SEED, endOnFailure: true }
      )
      console.info('parent-update oracle coverage', {
        owner,
        seed: SEED,
        numRuns: RUNS,
        runs: coverage.runs,
        writes: coverage.writes,
        disturbedRuns: coverage.disturbedRuns,
      })
    }, 120_000)
  })
}
