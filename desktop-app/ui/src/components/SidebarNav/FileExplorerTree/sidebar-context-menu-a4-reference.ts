// Contract oracle for r28 A4. Deliberately stores user-visible facts, not React state setters.
export const initial = (): any => ({
  resource: null,
  rowMounted: false,
  menu: 'closed',
  view: 'main',
  panels: [],
  rect: null,
  rects: [],
  sidebar: { left: 0, top: 0, right: 0, bottom: 0 },
  focus: null,
  activeItem: 0,
  permission: new Map(),
  session: 1,
  request: 0,
  navigationGeneration: 0,
  latestExplicitNavigation: null,
  effects: { replace: 0, download: 0, copyLink: 0, copyId: 0, mutations: 0 },
  actionIds: new Set(),
  effectTargets: [],
  pending: new Set(),
  timers: new Set(),
  observers: new Set(),
  chooser: null,
  terminal: null,
})

export function transition(s: any, e: any): any {
  const n = structuredClone(s)
  if (e.type === 'open') {
    n.request = e.request
    n.resource = e.resource
    n.rowMounted = true
    if (s.menu === 'open' && s.resource === e.resource) {
      // Same owner refresh preserves its deliberately selected Share view and panel identity.
      n.panels = s.panels
      n.view = s.view
    } else {
      n.menu = 'open'
      n.view = 'main'
      n.panels = [`main:${e.request}`]
    }
    n.focus = `${e.resource}:first-enabled`
  } else if (e.type === 'share' && s.menu === 'open' && e.resource === s.resource) {
    n.view = 'share'
    n.panels = s.panels.includes(`share:${s.request}`)
      ? s.panels
      : [...s.panels, `share:${s.request}`]
    if (e.modality === 'keyboard' || e.modality === 'touch') {
      n.focus = `${s.resource}:share-first-enabled`
      n.activeItem = 0
    }
  } else if (e.type === 'back' && s.menu === 'open' && s.view === 'share') {
    n.view = 'main'
    n.panels = s.panels.filter((panel: string) => !panel.startsWith('share:'))
    n.focus = `${s.resource}:share-trigger`
  } else if (e.type === 'escape' && s.menu === 'open') {
    if (s.view === 'share') {
      n.view = 'main'
      n.panels = s.panels.filter((panel: string) => !panel.startsWith('share:'))
      n.focus = `${s.resource}:share-trigger`
    } else {
      n.menu = 'closed'
      n.panels = []
      n.focus = e.restoreConnected ? 'row' : null
    }
  } else if (e.type === 'dismiss') {
    n.menu = 'closed'
    n.view = 'main'
    n.panels = []
    n.focus = e.restoreConnected ? 'row' : null
  } else if (e.type === 'permission-start') {
    n.permission.set(e.resource, 'pending')
    n.pending.add(`permission:${e.id}`)
  } else if (e.type === 'permission-settle') {
    n.pending.delete(`permission:${e.id}`)
    // Result belongs to its request/resource/session; stale results cannot retarget the owner.
    if (e.session === s.session) n.permission.set(e.resource, e.result)
  } else if (e.type === 'explicit-navigation') {
    n.navigationGeneration = s.navigationGeneration + 1
    n.latestExplicitNavigation = e.resource
    n.resource = e.resource
    n.menu = 'closed'
    n.panels = []
    n.view = 'main'
    n.focus = null
  } else if (e.type === 'late-navigation' && e.generation < s.navigationGeneration) {
    // Fault injection only: models an older continuation incorrectly restoring its target.
    n.resource = e.resource
  } else if (
    e.type === 'action' &&
    s.menu === 'open' &&
    e.resource === s.resource &&
    (e.target === undefined || e.target === s.resource) &&
    e.enabled &&
    !s.actionIds.has(e.id)
  ) {
    n.actionIds.add(e.id)
    if (e.action === 'replace') {
      n.chooser = { resource: e.resource, request: s.request, session: s.session, actionId: e.id }
    } else if (e.action in n.effects) {
      n.effects[e.action] += 1
      n.effectTargets.push({
        id: e.id,
        owner: s.resource,
        resource: e.target ?? e.resource,
        session: s.session,
      })
    }
    n.menu = 'closed'
    n.panels = []
    n.view = 'main'
    n.focus = e.restoreConnected ? 'row' : null
  } else if (e.type === 'chooser-select' && s.chooser) {
    if (
      e.resource === s.chooser.resource &&
      e.request === s.chooser.request &&
      e.session === s.session &&
      e.visible
    ) {
      n.effects.replace += 1
      n.effectTargets.push({
        id: s.chooser.actionId,
        owner: s.chooser.resource,
        resource: e.resource,
        session: s.session,
      })
    }
    n.chooser = null
  } else if (e.type === 'chooser-cancel') {
    n.chooser = null
  } else if (
    e.type === 'supersede' ||
    e.type === 'hide' ||
    e.type === 'unmount' ||
    e.type === 'session'
  ) {
    if (e.type === 'session') n.session = e.session
    n.menu = 'closed'
    n.view = 'main'
    n.panels = []
    n.focus = null
    n.chooser = null
    if (e.type === 'hide' || e.type === 'unmount' || e.type === 'session')
      n.rowMounted = e.type !== 'unmount'
  } else if (e.type === 'geometry') {
    n.sidebar = e.sidebar
    n.rect = e.rect
    n.rects = e.rects ?? (e.rect ? [e.rect] : [])
    n.pending.delete(`observer:${e.id}`)
  } else if (e.type === 'schedule') {
    ;(e.kind === 'timer' ? n.timers : n.observers).add(e.id)
  } else if (e.type === 'settled') {
    n.pending.clear()
    n.timers.clear()
    n.observers.clear()
  } else if (e.type === 'failure') {
    n.terminal = e.message
    n.chooser = null
  }
  return n
}

export function a4(s: any) {
  const open = s.menu === 'open'
  const box = s.sidebar
  return {
    onePanel: open
      ? s.panels.length === (s.view === 'share' ? 2 : 1) &&
        s.panels.filter((panel: string) => panel.startsWith('main:')).length === 1 &&
        s.panels.filter((panel: string) => panel.startsWith('share:')).length ===
          (s.view === 'share' ? 1 : 0)
      : s.panels.length === 0,
    correctView: open ? ['main', 'share'].includes(s.view) : true,
    geometryContained: open
      ? s.rects.length > 0 &&
        s.rects.every(
          (panel: any) =>
            panel.left >= box.left &&
            panel.right <= box.right &&
            panel.top >= box.top &&
            panel.bottom <= box.bottom
        )
      : s.rects.length === 0,
    focusOwned: open
      ? typeof s.focus === 'string' && s.focus.startsWith(`${s.resource}:`)
      : s.focus === null || s.focus === 'row',
    noPendingAtQuiescence: s.pending.size === 0 && s.timers.size === 0 && s.observers.size === 0,
    noChooserAtQuiescence: s.chooser === null,
    boundedEffects: (Object.values(s.effects) as number[]).every(count => count >= 0),
    noDuplicateActionId:
      s.effectTargets.length === new Set(s.effectTargets.map((effect: any) => effect.id)).size,
    effectTargetsCurrent: s.effectTargets.every((effect: any) => effect.resource === effect.owner),
    noUnownedEffects:
      (Object.values(s.effects) as number[]).reduce((total, count) => total + count, 0) ===
      s.effectTargets.length,
    newerExplicitNavigationWins:
      s.latestExplicitNavigation === null || s.resource === s.latestExplicitNavigation,
  }
}

export function isQuiescent(s: any) {
  return s.pending.size === 0 && s.timers.size === 0 && s.observers.size === 0 && s.chooser === null
}

export function assertA4(s: any) {
  if (!isQuiescent(s)) throw new Error('not quiescent: effect-capable work remains')
  const checks = a4(s)
  for (const [name, pass] of Object.entries(checks))
    if (!pass) throw new Error(`A4 violation: ${name}`)
  return checks
}

// Product-level D5b oracle: a version-sensitive action is admitted only for the
// exact captured resource location, identity, kind, parent, and version. It
// describes the required observable decision without modeling the UI guard.
export type D5bTargetSnapshot = {
  resourceId: string
  gfsUri: string
  kind: string
  parentResourceId: string | null
  version: number
}

export function d5bExpectedOutcome(
  requested: D5bTargetSnapshot,
  current: D5bTargetSnapshot | null
) {
  const normalizeId = (value: string) => value.replace(/-/g, '').toLowerCase()
  const sameTarget = Boolean(
    current &&
    normalizeId(current.resourceId) === normalizeId(requested.resourceId) &&
    current.gfsUri === requested.gfsUri &&
    current.kind === requested.kind &&
    (current.parentResourceId == null ? null : normalizeId(current.parentResourceId)) ===
      (requested.parentResourceId == null ? null : normalizeId(requested.parentResourceId)) &&
    current.version === requested.version
  )
  return sameTarget
    ? {
        disposition: 'admit' as const,
        mutationCount: 1,
        operationVersion: requested.version,
        staleFeedbackCount: 0,
      }
    : {
        disposition: 'reject' as const,
        mutationCount: 0,
        operationVersion: null,
        staleFeedbackCount: 1,
      }
}

export const commandAlphabet = Object.freeze([
  'open(resource,request)',
  'share',
  'back',
  'escape',
  'dismiss',
  'permission-start/settle',
  'action(enabled/disabled)',
  'chooser-select/cancel',
  'supersede',
  'hide',
  'unmount',
  'session',
  'geometry',
  'schedule/settled',
  'failure',
])

// Sensitivity controls demonstrate that each principal A4 safety predicate rejects a bad outcome.
export function sensitivityControls() {
  const base = initial()
  const open = transition(base, { type: 'open', resource: 'A', request: 1 })
  const duplicate = structuredClone(open)
  duplicate.panels.push('panel:extra')
  const outOfBounds = transition(open, {
    type: 'geometry',
    id: 1,
    sidebar: { left: 8, top: 10, right: 248, bottom: 300 },
    rect: { left: 10, top: 290, right: 230, bottom: 330 },
  })
  const delayed = transition(open, { type: 'schedule', kind: 'timer', id: 'late-replay' })
  const explicit = transition(open, { type: 'explicit-navigation', resource: 'G' })
  const stale = transition(explicit, { type: 'late-navigation', resource: 'A', generation: 0 })
  const wrongEffect = structuredClone(open)
  wrongEffect.effects.download = 1
  return {
    extraPanelRejected: !a4(duplicate).onePanel,
    outOfBoundsRejected: !a4(outOfBounds).geometryContained,
    delayedWorkNotQuiescent: !isQuiescent(delayed),
    staleNavigationRejected: !a4(stale).newerExplicitNavigationWins,
    unauthorizedEffectRejected: !a4(wrongEffect).noUnownedEffects,
  }
}

// Focused D5a oracle: a permission continuation may publish only while its
// existing request receipt still owns the action. This models observable
// ownership and effects, not React state or the production callback algorithm.
export const initialD5a = () => ({
  session: 1,
  access: 'active' as 'active' | 'revoked',
  revokeRevision: 0,
  currentRequest: null as null | {
    id: number
    resource: string
    session: number
    revokeRevision: number
  },
  pending: new Map<
    number,
    { requestId: number; resource: string; session: number; revokeRevision: number }
  >(),
  feedback: [] as Array<{
    requestId: number
    resource: string
    session: number
    revokeRevision: number
    result: 'denied' | 'error'
  }>,
  ui: [] as Array<{
    requestId: number
    resource: string
    session: number
    revokeRevision: number
  }>,
})

export function transitionD5a(s: ReturnType<typeof initialD5a>, e: any) {
  const n = structuredClone(s)
  if (e.type === 'request') {
    n.currentRequest = {
      id: e.id,
      resource: e.resource,
      session: e.session,
      revokeRevision: n.revokeRevision,
    }
  } else if (e.type === 'permission-start') {
    n.pending.set(e.id, {
      requestId: e.requestId,
      resource: e.resource,
      session: e.session,
      revokeRevision: n.revokeRevision,
    })
  } else if (e.type === 'permission-settle') {
    const pending = n.pending.get(e.id)
    n.pending.delete(e.id)
    if (e.result === 'session-authority') {
      n.access = 'revoked'
      n.revokeRevision += 1
      n.ui = []
      n.feedback = []
    } else if (
      pending &&
      n.access === 'active' &&
      (e.ignoreRevokeRevisionForSensitivity || pending.revokeRevision === n.revokeRevision) &&
      n.currentRequest?.id === pending.requestId &&
      n.currentRequest.session === pending.session &&
      n.session === pending.session
    ) {
      if (e.result === 'allowed')
        n.ui.push({
          requestId: pending.requestId,
          resource: pending.resource,
          session: pending.session,
          revokeRevision: pending.revokeRevision,
        })
      else
        n.feedback.push({
          requestId: pending.requestId,
          resource: pending.resource,
          session: pending.session,
          revokeRevision: pending.revokeRevision,
          result: e.result,
        })
    } else if (pending && e.ignoreReceiptForSensitivity) {
      n.feedback.push({
        requestId: pending.requestId,
        resource: pending.resource,
        session: pending.session,
        revokeRevision: pending.revokeRevision,
        result: e.result === 'allowed' ? 'error' : e.result,
      })
    }
  } else if (e.type === 'session') {
    n.session = e.session
  } else if (e.type === 'retry') {
    n.access = 'active'
  } else if (e.type === 'quiesce') {
    // Quiescence is asserted only after every controlled continuation settled.
  }
  return n
}

export function a4D5a(s: ReturnType<typeof initialD5a>) {
  return {
    revokedSurfaceHasNoActionUi:
      s.access !== 'revoked' || (s.ui.length === 0 && s.feedback.length === 0),
    noPendingContinuation: s.pending.size === 0,
    feedbackOwnedByCurrentRequest: s.feedback.every(
      item => item.requestId === s.currentRequest?.id && item.session === s.currentRequest.session
    ),
    oneCurrentTerminalFeedback:
      new Set(s.feedback.map(item => item.requestId)).size === s.feedback.length,
    uiOwnedByCurrentRequest: s.ui.every(
      item => item.requestId === s.currentRequest?.id && item.session === s.currentRequest.session
    ),
    effectsOwnedByCurrentRevision: [...s.ui, ...s.feedback].every(
      item => item.revokeRevision === s.revokeRevision
    ),
    noDuplicateUi: new Set(s.ui.map(item => item.requestId)).size === s.ui.length,
  }
}

export function assertD5a(s: ReturnType<typeof initialD5a>) {
  const checks = a4D5a(s)
  for (const [name, pass] of Object.entries(checks))
    if (!pass) throw new Error(`D5a A4 violation: ${name}`)
  return checks
}

export function d5aSensitivityControl() {
  let model = initialD5a()
  model = transitionD5a(model, { type: 'request', id: 1, resource: 'A', session: 1 })
  model = transitionD5a(model, {
    type: 'permission-start',
    id: 11,
    requestId: 1,
    resource: 'A',
    session: 1,
  })
  model = transitionD5a(model, { type: 'request', id: 2, resource: 'B', session: 1 })
  model = transitionD5a(model, {
    type: 'permission-settle',
    id: 11,
    result: 'denied',
    ignoreReceiptForSensitivity: true,
  })
  return !a4D5a(model).feedbackOwnedByCurrentRequest
}

export function d5aRevokeRetrySensitivityControl() {
  const setup = () => {
    let state = initialD5a()
    state = transitionD5a(state, { type: 'request', id: 1, resource: 'A', session: 1 })
    state = transitionD5a(state, {
      type: 'permission-start',
      id: 11,
      requestId: 1,
      resource: 'A',
      session: 1,
    })
    state = transitionD5a(state, { type: 'request', id: 2, resource: 'B', session: 1 })
    state = transitionD5a(state, {
      type: 'permission-start',
      id: 12,
      requestId: 2,
      resource: 'B',
      session: 1,
    })
    state = transitionD5a(state, { type: 'permission-settle', id: 11, result: 'session-authority' })
    return transitionD5a(state, { type: 'retry' })
  }
  const guarded = transitionD5a(setup(), { type: 'permission-settle', id: 12, result: 'allowed' })
  const mutant = transitionD5a(setup(), {
    type: 'permission-settle',
    id: 12,
    result: 'allowed',
    ignoreRevokeRevisionForSensitivity: true,
  })
  return (
    guarded.ui.length === 0 &&
    mutant.ui.some(item => item.requestId === 2 && item.resource === 'B') &&
    !a4D5a(mutant).effectsOwnedByCurrentRevision
  )
}
