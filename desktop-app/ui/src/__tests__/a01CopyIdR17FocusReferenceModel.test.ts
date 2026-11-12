import { describe, expect, it } from 'vitest'
import fc, { type AsyncCommand, type Scheduler } from 'fast-check'
import { type A01A4Input, evaluateA01A4 } from '../test-utils/a01CopyIdR17A4Oracle'

type FocusTarget = 'body' | 'opener' | 'toggle' | 'new-user-target'
type Permission = 'pending' | 'allowed' | 'revoked'
type Binding =
  | 'same'
  | 'metadata-only'
  | 'different-id'
  | 'different-uri'
  | 'different-kind'
  | 'different-parent'
  | 'missing'

type FocusModel = {
  requestId: number
  latestRequestId: number
  clickedUri: string
  capturedSession: number
  session: number
  capturedNavigation: number
  navigation: number
  capturedOwner: number
  owner: number
  inputEpoch: number
  capturedInputEpoch: number
  permission: Permission
  binding: Binding
  openerConnected: boolean
  parentConnected: boolean
  ancestorConnected: boolean
  toggleConnected: boolean
  sidebarMounted: boolean
  tokenOpen: boolean
  terminal: boolean
  d2: boolean
  query: 'idle' | 'pending' | 'resolved' | 'rejected' | 'never'
  menuTimerPending: boolean
  focus: FocusTarget
  writes: string[]
  invalidations: number
  staleError: boolean
  clipboardSettled: boolean
}

function startFocusModel(): FocusModel {
  return {
    requestId: 0,
    latestRequestId: 0,
    clickedUri: 'gfs://main/clicked-canonical-id',
    capturedSession: 1,
    session: 1,
    capturedNavigation: 1,
    navigation: 1,
    capturedOwner: 1,
    owner: 1,
    inputEpoch: 0,
    capturedInputEpoch: 0,
    permission: 'allowed',
    binding: 'same',
    openerConnected: true,
    parentConnected: true,
    ancestorConnected: true,
    toggleConnected: true,
    sidebarMounted: true,
    tokenOpen: false,
    terminal: false,
    d2: false,
    query: 'idle',
    menuTimerPending: false,
    focus: 'body',
    writes: [],
    invalidations: 0,
    staleError: false,
    clipboardSettled: false,
  }
}

function ownsFocusRecovery(model: FocusModel) {
  return (
    model.tokenOpen &&
    model.sidebarMounted &&
    model.session === model.capturedSession &&
    model.navigation === model.capturedNavigation &&
    model.owner === model.capturedOwner &&
    model.inputEpoch === model.capturedInputEpoch &&
    model.requestId === model.latestRequestId
  )
}

function closeToken(model: FocusModel) {
  model.tokenOpen = false
}

function finishIfAuthorized(model: FocusModel) {
  if (model.requestId !== model.latestRequestId || model.terminal) return
  if (
    model.session !== model.capturedSession ||
    model.navigation !== model.capturedNavigation ||
    model.owner !== model.capturedOwner
  ) {
    model.terminal = true
    closeToken(model)
    return
  }
  if (model.binding !== 'same' && model.binding !== 'metadata-only') {
    model.terminal = true
    model.d2 = true
    model.staleError = true
    model.invalidations += 1
    if (ownsFocusRecovery(model) && model.toggleConnected) {
      model.focus = 'toggle'
      closeToken(model)
    }
    model.query = 'pending'
    return
  }
  if (model.permission === 'pending') return
  model.terminal = true
  if (model.permission === 'revoked') {
    closeToken(model)
    return
  }
  model.writes.push(model.clickedUri)
  closeToken(model)
}

function completeCopyRequest(
  model: FocusModel,
  requestId: number,
  permission: Permission,
  binding: Binding
) {
  if (requestId !== model.latestRequestId || model.terminal) return
  model.permission = permission
  model.binding = binding
  finishIfAuthorized(model)
}

function assertFocusModel(model: FocusModel) {
  expect(model.invalidations).toBeLessThanOrEqual(1)
  expect(model.writes.length).toBeLessThanOrEqual(model.requestId)
  expect(model.writes.every(uri => uri === model.clickedUri)).toBe(true)
  if (!model.sidebarMounted) expect(model.tokenOpen).toBe(false)
  if (model.d2) expect(model.writes).toHaveLength(0)
  if (
    model.d2 &&
    model.session === model.capturedSession &&
    model.navigation === model.capturedNavigation &&
    model.owner === model.capturedOwner &&
    model.inputEpoch === model.capturedInputEpoch &&
    model.sidebarMounted &&
    model.toggleConnected
  )
    expect(model.focus).toBe('toggle')
}

type FocusReal = { trace: string[]; scheduler?: Scheduler }

class ActivateKeyboardCopy implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.sidebarMounted && (model.requestId === 0 || model.terminal)
  }
  async run(model: FocusModel, real: FocusReal) {
    model.requestId += 1
    model.latestRequestId = model.requestId
    model.capturedSession = model.session
    model.capturedNavigation = model.navigation
    model.capturedOwner = model.owner
    model.capturedInputEpoch = model.inputEpoch
    model.permission = 'pending'
    model.binding = 'same'
    model.terminal = false
    model.d2 = false
    model.staleError = false
    model.query = 'idle'
    model.invalidations = 0
    model.writes = []
    model.clipboardSettled = false
    model.menuTimerPending = true
    model.tokenOpen = true
    model.focus = 'body'
    real.trace.push('activate')
    assertFocusModel(model)
  }
  toString() {
    return 'keyboard Copy ID captures URI, owner, session, navigation, and input epochs'
  }
}

class ChangeMetadata implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.requestId > 0 && !model.terminal
  }
  async run(model: FocusModel, real: FocusReal) {
    model.binding = 'metadata-only'
    real.trace.push('metadata-name-version-refresh')
    finishIfAuthorized(model)
    assertFocusModel(model)
  }
  toString() {
    return 'rename or version refresh preserves canonical URI identity'
  }
}

class ChangeIdentity implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.requestId > 0 && !model.terminal
  }
  async run(model: FocusModel, real: FocusReal) {
    model.binding = 'different-uri'
    real.trace.push(`binding:${model.binding}`)
    finishIfAuthorized(model)
    assertFocusModel(model)
  }
  toString() {
    return 'change resource ID, canonical URI, kind, or availability'
  }
}

class GrantPermission implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.requestId > 0 && !model.terminal
  }
  async run(model: FocusModel, real: FocusReal) {
    model.permission = 'allowed'
    real.trace.push('permission-granted')
    finishIfAuthorized(model)
    assertFocusModel(model)
  }
  toString() {
    return 'permission producer resolves with read authorization'
  }
}

class RevokePermission implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.requestId > 0 && !model.terminal
  }
  async run(model: FocusModel, real: FocusReal) {
    model.permission = 'revoked'
    real.trace.push('permission-revoked')
    finishIfAuthorized(model)
    assertFocusModel(model)
  }
  toString() {
    return 'permission producer rejects or loses read authorization'
  }
}

class SettlePermissionAfterTerminal implements AsyncCommand<FocusModel, FocusReal> {
  constructor(private readonly outcome: 'allowed' | 'revoked') {}
  check(model: Readonly<FocusModel>) {
    return model.terminal && model.permission === 'pending'
  }
  async run(model: FocusModel, real: FocusReal) {
    const before = structuredClone(model)
    model.permission = this.outcome
    real.trace.push(`permission-settles-after-terminal:${this.outcome}`)
    expect(model.focus).toBe(before.focus)
    expect(model.writes).toEqual(before.writes)
    expect(model.invalidations).toBe(before.invalidations)
    assertFocusModel(model)
  }
  toString() {
    return `permission resolves ${this.outcome} after D2 or ownership terminality`
  }
}

class RemoveOpener implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.requestId > 0 && model.openerConnected
  }
  async run(model: FocusModel, real: FocusReal) {
    model.openerConnected = false
    real.trace.push('react-commit-removes-opener')
    if (ownsFocusRecovery(model) && model.toggleConnected) {
      model.focus = 'toggle'
      closeToken(model)
    }
    assertFocusModel(model)
  }
  toString() {
    return 'React commit removes the exact opener before terminal permission'
  }
}

class RemoveParent implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.requestId > 0 && model.parentConnected
  }
  async run(model: FocusModel, real: FocusReal) {
    model.parentConnected = false
    model.openerConnected = false
    real.trace.push('react-commit-removes-parent-and-child')
    if (ownsFocusRecovery(model) && model.toggleConnected) {
      model.focus = 'toggle'
      closeToken(model)
    }
    assertFocusModel(model)
  }
  toString() {
    return 'parent removal commits while a matching query is unresolved'
  }
}

class RemoveAncestor implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.requestId > 0 && model.ancestorConnected
  }
  async run(model: FocusModel, real: FocusReal) {
    model.ancestorConnected = false
    model.parentConnected = false
    model.openerConnected = false
    real.trace.push('react-commit-removes-ancestor-parent-and-child')
    if (ownsFocusRecovery(model) && model.toggleConnected) {
      model.focus = 'toggle'
      closeToken(model)
    }
    assertFocusModel(model)
  }
  toString() {
    return 'ancestor removal commits while a matching query is unresolved'
  }
}

class NewerUserIntent implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.requestId > 0 && !model.terminal && model.tokenOpen
  }
  async run(model: FocusModel, real: FocusReal) {
    model.inputEpoch += 1
    model.focus = 'new-user-target'
    closeToken(model)
    real.trace.push(`newer-user-intent:${model.focus}`)
    assertFocusModel(model)
  }
  toString() {
    return 'newer pointer or keyboard intent supersedes old focus recovery'
  }
}

class UnfocusableInputIntent implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.requestId > 0 && !model.terminal && model.tokenOpen
  }
  async run(model: FocusModel, real: FocusReal) {
    model.inputEpoch += 1
    model.focus = 'body'
    closeToken(model)
    real.trace.push('newer-nonfocusable-input-keeps-body')
    assertFocusModel(model)
  }
  toString() {
    return 'newer input that does not focus a control invalidates old focus ownership'
  }
}

class SupersedeOwner implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.requestId > 0 && !model.terminal
  }
  async run(model: FocusModel, real: FocusReal) {
    model.session += 1
    model.navigation += 1
    model.owner += 1
    model.focus = 'new-user-target'
    closeToken(model)
    real.trace.push('session-navigation-owner-superseded')
    finishIfAuthorized(model)
    assertFocusModel(model)
  }
  toString() {
    return 'session, navigation intent, and owning tab supersede the request'
  }
}

class RepeatKeyboardCopy implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.requestId > 0 && !model.terminal && model.tokenOpen
  }
  async run(model: FocusModel, real: FocusReal) {
    const previousId = model.requestId
    model.requestId += 1
    model.latestRequestId = model.requestId
    model.clickedUri = `gfs://main/clicked-canonical-id-${model.requestId}`
    model.capturedSession = model.session
    model.capturedNavigation = model.navigation
    model.capturedOwner = model.owner
    model.capturedInputEpoch = model.inputEpoch
    model.permission = 'pending'
    model.binding = 'same'
    model.terminal = false
    model.d2 = false
    model.query = 'idle'
    model.invalidations = 0
    model.writes = []
    model.staleError = false
    model.clipboardSettled = false
    model.menuTimerPending = true
    model.tokenOpen = true
    real.trace.push(`repeat-request:${previousId}->${model.requestId}`)
    assertFocusModel(model)
  }
  toString() {
    return 'second keyboard Copy ID supersedes the older pending request'
  }
}

class LateOldRequestResult implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.requestId > 1 && !model.terminal
  }
  async run(model: FocusModel, real: FocusReal) {
    const oldRequestId = model.requestId - 1
    const before = structuredClone(model)
    real.trace.push('late-first-request-result-ignored')
    completeCopyRequest(model, oldRequestId, 'allowed', 'different-uri')
    expect(model.focus).toBe(before.focus)
    expect(model.writes).toEqual(before.writes)
    expect(model.invalidations).toBe(before.invalidations)
    expect(model.permission).toBe(before.permission)
    expect(model.binding).toBe(before.binding)
    expect(model.terminal).toBe(before.terminal)
    assertFocusModel(model)
  }
  toString() {
    return 'late first-request permission/query callback cannot affect newer ownership'
  }
}

class RunMenuTimer implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.menuTimerPending
  }
  async run(model: FocusModel, real: FocusReal) {
    model.menuTimerPending = false
    real.trace.push('menu-return-timer')
    if (
      ownsFocusRecovery(model) &&
      model.openerConnected &&
      model.focus === 'body' &&
      (!model.d2 || !model.terminal)
    )
      model.focus = 'opener'
    assertFocusModel(model)
  }
  toString() {
    return 'menu return timer runs before or after React row-removal commit'
  }
}

class StartParentQuery implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.d2 && model.query === 'pending'
  }
  async run(model: FocusModel, real: FocusReal) {
    model.query = 'never'
    real.trace.push('matching-parent-query-held-open')
    assertFocusModel(model)
  }
  toString() {
    return 'matching parent query is pending or never settles'
  }
}

class StartParentQueryAfterRecoveryClosed implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return (
      model.d2 &&
      model.terminal &&
      !model.tokenOpen &&
      (model.query === 'idle' || model.query === 'resolved' || model.query === 'rejected')
    )
  }
  async run(model: FocusModel, real: FocusReal) {
    model.query = 'pending'
    real.trace.push('matching-parent-query-started-after-recovery-closed')
    assertFocusModel(model)
  }
  toString() {
    return 'matching parent query starts after focus recovery has closed'
  }
}

class SettleParentQuery implements AsyncCommand<FocusModel, FocusReal> {
  constructor(private readonly outcome: 'resolved' | 'rejected') {}
  check(model: Readonly<FocusModel>) {
    return model.query === 'pending' || model.query === 'never'
  }
  async run(model: FocusModel, real: FocusReal) {
    const focusBeforeLateResult = model.focus
    model.query = this.outcome
    if (model.terminal) {
      model.openerConnected = false
      model.parentConnected = false
      model.ancestorConnected = false
    }
    expect(model.focus).toBe(focusBeforeLateResult)
    real.trace.push(`parent-query-${model.query}`)
    assertFocusModel(model)
  }
  toString() {
    return `parent query ${this.outcome} after recovery has closed`
  }
}

class UnmountSidebar implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.sidebarMounted
  }
  async run(model: FocusModel, real: FocusReal) {
    model.sidebarMounted = false
    closeToken(model)
    real.trace.push('sidebar-unmount')
    assertFocusModel(model)
  }
  toString() {
    return 'SidebarNav unmount closes its focus owner'
  }
}

class SettleClipboard implements AsyncCommand<FocusModel, FocusReal> {
  check(model: Readonly<FocusModel>) {
    return model.writes.length > 0 && !model.clipboardSettled
  }
  async run(model: FocusModel, real: FocusReal) {
    model.clipboardSettled = true
    real.trace.push('clipboard-fulfills-or-rejects-naturally')
    assertFocusModel(model)
  }
  toString() {
    return 'clipboard settles through the existing browser/OS lifecycle'
  }
}

const focusCommands = [
  fc.constant(new ActivateKeyboardCopy()),
  fc.constant(new ChangeMetadata()),
  fc.constant(new ChangeIdentity()),
  fc.constant(new GrantPermission()),
  fc.constant(new RevokePermission()),
  fc.constant(new SettlePermissionAfterTerminal('allowed')),
  fc.constant(new SettlePermissionAfterTerminal('revoked')),
  fc.constant(new RemoveOpener()),
  fc.constant(new RemoveParent()),
  fc.constant(new RemoveAncestor()),
  fc.constant(new NewerUserIntent()),
  fc.constant(new UnfocusableInputIntent()),
  fc.constant(new SupersedeOwner()),
  fc.constant(new RepeatKeyboardCopy()),
  fc.constant(new LateOldRequestResult()),
  fc.constant(new RunMenuTimer()),
  fc.constant(new StartParentQuery()),
  fc.constant(new StartParentQueryAfterRecoveryClosed()),
  fc.constant(new SettleParentQuery('resolved')),
  fc.constant(new SettleParentQuery('rejected')),
  fc.constant(new UnmountSidebar()),
  fc.constant(new SettleClipboard()),
]

function isQuiescentFocusModel(model: FocusModel) {
  return (
    (model.requestId === 0 || model.terminal) &&
    !model.tokenOpen &&
    !model.menuTimerPending &&
    model.permission !== 'pending' &&
    model.query !== 'pending' &&
    model.query !== 'never' &&
    (model.writes.length === 0 || model.clipboardSettled)
  )
}

describe('A01 r17 independent focus recovery model', () => {
  it('keeps a D2 mismatch terminal after a late matching row arrives', () => {
    const afterMismatch: A01A4Input = {
      clickedUri: 'gfs://main/clicked-canonical-id',
      requestCurrent: true,
      permissionGranted: true,
      binding: 'different-uri',
      d2Observed: true,
      sessionCurrent: true,
      navigationCurrent: true,
      ownerCurrent: true,
      newerFocus: null,
      newerFocusConnected: false,
      openerConnected: true,
      toggleConnected: true,
      surface: 'chat',
    }
    const terminalMismatch = evaluateA01A4(afterMismatch)
    const lateMatchingRow = evaluateA01A4({ ...afterMismatch, binding: 'same' })

    expect(terminalMismatch).toMatchObject({
      writes: [],
      staleError: true,
      exactParentInvalidations: 1,
    })
    expect(lateMatchingRow).toMatchObject({
      writes: [],
      staleError: true,
      exactParentInvalidations: 1,
    })
  })

  it('checks generated A2 command sequences and terminal invariants', async () => {
    const observed = new Set<string>()
    const checked = await fc.check(
      fc.asyncProperty(
        fc.commands(focusCommands, { maxCommands: 48, size: 'max' }),
        async generated => {
          const model = startFocusModel()
          const real: FocusReal = { trace: [] }
          await fc.asyncModelRun(() => ({ model, real }), [...generated])
          // Only traces whose generated producer/callback events reached quiescence
          // are evaluated. Never manufacture completion after the generated history.
          fc.pre(isQuiescentFocusModel(model))
          assertFocusModel(model)
          expect(model.invalidations).toBe(model.d2 ? 1 : 0)
          for (const transition of real.trace) observed.add(transition)
        }
      ),
      { numRuns: 1500, maxSkipsPerRun: 100000, seed: 17143, endOnFailure: true }
    )
    expect(checked.failed, String(checked.errorInstance ?? '')).toBe(false)
    expect(checked.numRuns).toBe(1500)
    expect(checked.numSkips).toBeGreaterThan(0)
    expect(observed).toContain('permission-granted')
    expect(observed).toContain('permission-revoked')
    expect(observed).toContain('react-commit-removes-opener')
    expect(observed).toContain('session-navigation-owner-superseded')
    expect(observed).toContain('matching-parent-query-held-open')
    expect(observed).toContain('clipboard-fulfills-or-rejects-naturally')
  })

  it('covers a matching parent query that starts after focus recovery closes', async () => {
    const model = startFocusModel()
    const real: FocusReal = { trace: [] }
    await fc.asyncModelRun(
      () => ({ model, real }),
      [
        new ActivateKeyboardCopy(),
        new RunMenuTimer(),
        new ChangeIdentity(),
        new SettlePermissionAfterTerminal('allowed'),
        new SettleParentQuery('resolved'),
        new StartParentQueryAfterRecoveryClosed(),
        new SettleParentQuery('rejected'),
      ]
    )

    expect(real.trace).toContain('matching-parent-query-started-after-recovery-closed')
    expect(isQuiescentFocusModel(model), JSON.stringify(model)).toBe(true)
    expect(model.focus).toBe('toggle')
  })

  it('checks scheduler-selected promise and focus callback orderings', async () => {
    const seen = new Set<string>()
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), async scheduler => {
        const model = startFocusModel()
        model.requestId = 1
        model.latestRequestId = 1
        model.tokenOpen = true
        model.menuTimerPending = true
        const eventOrder: string[] = []
        const tasks = [
          scheduler
            .schedule(Promise.resolve('react-removal'), 'React row-removal commit')
            .then(() => {
              eventOrder.push('react-removal')
              model.openerConnected = false
              if (ownsFocusRecovery(model) && model.toggleConnected) {
                model.focus = 'toggle'
                closeToken(model)
              }
            }),
          scheduler.schedule(Promise.resolve('menu-return'), 'menu return callback').then(() => {
            eventOrder.push('menu-return')
            if (model.menuTimerPending) {
              model.menuTimerPending = false
              if (ownsFocusRecovery(model) && model.openerConnected && model.focus === 'body') {
                model.focus = 'opener'
              }
            }
          }),
          scheduler
            .schedule(Promise.resolve('D2-terminal'), 'permission and D2 terminal')
            .then(() => {
              eventOrder.push('D2-terminal')
              model.permission = 'allowed'
              model.binding = 'different-uri'
              finishIfAuthorized(model)
              return scheduler
                .schedule(
                  Promise.resolve('query-start-after-close'),
                  'matching query starts near close checkpoint'
                )
                .then(() => {
                  eventOrder.push('query-start-after-close')
                  model.query = 'pending'
                  expect(model.tokenOpen).toBe(false)
                  expect(model.focus).toBe('toggle')
                  return scheduler
                    .schedule(
                      Promise.resolve('react-close-checkpoint'),
                      'post-D2 React close checkpoint'
                    )
                    .then(() => {
                      eventOrder.push('react-close-checkpoint')
                      const focusBeforeLateResult = model.focus
                      if (model.tokenOpen && !model.openerConnected && model.toggleConnected) {
                        model.focus = 'toggle'
                        closeToken(model)
                      }
                      expect(model.focus).toBe(focusBeforeLateResult)
                    })
                })
            }),
          scheduler.schedule(Promise.resolve('late-query'), 'late query completion').then(() => {
            eventOrder.push('late-query')
            if (model.query === 'pending') model.query = 'resolved'
          }),
        ]
        await scheduler.waitFor(Promise.all(tasks))
        await scheduler.waitIdle()
        seen.add(eventOrder.join('>'))
        assertFocusModel(model)
        expect(model.writes).toHaveLength(0)
        expect(model.invalidations).toBe(1)
        expect(model.focus).toBe('toggle')
        expect(model.tokenOpen).toBe(false)
      }),
      { numRuns: 1000, seed: 17144, endOnFailure: true }
    )
    const orderings = [...seen].map(value => value.split('>'))
    expect(
      orderings.some(order => order.indexOf('react-removal') < order.indexOf('menu-return'))
    ).toBe(true)
    expect(
      orderings.some(order => order.indexOf('menu-return') < order.indexOf('react-removal'))
    ).toBe(true)
    expect(
      orderings.some(order => order.indexOf('D2-terminal') < order.indexOf('late-query'))
    ).toBe(true)
    expect(
      orderings.some(order => order.indexOf('late-query') < order.indexOf('D2-terminal'))
    ).toBe(true)
    expect(
      orderings.some(
        order => order.indexOf('D2-terminal') < order.indexOf('query-start-after-close')
      )
    ).toBe(true)
    expect(
      orderings.some(
        order => order.indexOf('query-start-after-close') < order.indexOf('react-close-checkpoint')
      )
    ).toBe(true)
  })
})
