// Contract oracle for r10 A4. Deliberately stores user-visible facts, not React state setters.
export const initial = (): any => ({
  resource: null,
  rowMounted: false,
  menu: 'closed',
  view: 'main',
  panels: [],
  rect: null,
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

const mainItems = ['Share', 'Rename', 'Move to', 'Download', 'Replace file']
const shareItems = ['Back', 'Share', 'Copy link', 'Copy ID']

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
      n.panels = [`panel:${e.request}`]
    }
    n.focus = `${e.resource}:first-enabled`
  } else if (e.type === 'share' && s.menu === 'open' && e.resource === s.resource) {
    n.view = 'share'
    n.focus = `${s.resource}:share-first-enabled`
    n.activeItem = 0
  } else if (e.type === 'back' && s.menu === 'open' && s.view === 'share') {
    n.view = 'main'
    n.focus = `${s.resource}:share-trigger`
  } else if (e.type === 'escape' && s.menu === 'open') {
    if (s.view === 'share') {
      n.view = 'main'
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
  const rect = s.rect,
    box = s.sidebar
  return {
    onePanel: open ? s.panels.length === 1 : s.panels.length === 0,
    correctView: open ? ['main', 'share'].includes(s.view) : true,
    geometryContained:
      open && rect
        ? rect.left >= box.left &&
          rect.right <= box.right &&
          rect.top >= box.top &&
          rect.bottom <= box.bottom
        : !open,
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
