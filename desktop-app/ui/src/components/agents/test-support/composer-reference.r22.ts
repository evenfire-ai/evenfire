// Independently authored product oracle. No React, Query, DOM, production helper or lab imports.
// Inputs are user/owner actions and intended network responses, never observations of the SUT.
export type Page = { names: string[]; next: string | null }
export type Event =
  | { type: 'bind'; owner: string; query: string }
  | { type: 'retire'; subject: 'owner' | 'binding' | 'query' | 'session' }
  | { type: 'allow'; name: string; allowed: boolean }
  | { type: 'pause' | 'resume' }
  | { type: 'retry' }
  | {
      type: 'begin'
      id: number
      kind: 'full' | 'forward'
      target: number
      cursor: string | null
      query: string
      reason: 'bind' | 'independent' | 'user'
    }
  | { type: 'page'; id: number; page: Page }
  | { type: 'fail'; id: number; message: string }
  | { type: 'cancel'; id: number }
  | { type: 'manual' | 'flush' | 'clock' }

type Read = {
  id: number
  kind: 'full' | 'forward'
  target: number
  query: string
  began: number
  pages: Page[]
  done: boolean
  failed: boolean
  cancelled?: boolean
}

// A small specification as a fold over a chronological notebook. There is no operation receipt,
// retryer, WeakMap, cache reducer, Query status, metadata, production identity or DOM in this model.
export function expected(history: readonly Event[]) {
  let owner = '',
    query = '',
    boundAt = -1,
    live = false,
    paused = false
  let accepted: Page[] = [],
    error: string | null = null,
    failedFull = false,
    intent = false
  let current: Read | undefined
  const reads: Read[] = [],
    calls: Array<string | null> = [],
    allows = new Map<string, boolean>()
  for (const [at, e] of history.entries()) {
    if (e.type === 'bind') {
      owner = e.owner
      query = e.query
      boundAt = at
      live = true
      accepted = []
      error = null
      intent = false
      failedFull = false
      allows.clear()
    } else if (e.type === 'retire') {
      live = false
      intent = false
      accepted = []
      error = null
      failedFull = false
    } else if (e.type === 'allow') allows.set(e.name, e.allowed)
    else if (e.type === 'pause') {
      paused = true
      intent = false
    } else if (e.type === 'resume') paused = false
    else if (e.type === 'retry') {
      if (live && !paused && (error !== null || intent)) intent = true
    } else if (e.type === 'begin') {
      const read: Read = { ...e, began: at, pages: [], done: false, failed: false }
      reads.push(read)
      current = read
      calls.push(e.cursor)
    } else if (e.type === 'page' || e.type === 'fail' || e.type === 'cancel') {
      const read = reads.find(x => x.id === e.id)
      if (!read || read.done) throw new Error('Invalid external network history')
      if (e.type === 'cancel') {
        read.cancelled = true
        continue
      }
      if (e.type === 'fail') {
        read.done = true
        read.failed = true
      } else {
        read.pages.push(e.page)
        read.done =
          read.kind === 'forward' || read.pages.length === read.target || e.page.next === null
        if (!read.done) calls.push(e.page.next)
      }
      if (!read.done || read !== current || read.cancelled || read.query !== query || !live)
        continue
      if (read.failed) {
        error = e.type === 'fail' ? e.message : 'Listing failed'
        if (read.kind === 'full') {
          failedFull = true
          intent = false
        }
      } else if (read.kind === 'full') {
        // A newer binding cannot accept an older full, even if values/key match.
        if (read.began > boundAt) accepted = read.pages.slice()
        error = null
        failedFull = false
        intent = false
      } else if (accepted.length) {
        accepted = [...accepted, ...read.pages]
        if (!intent) error = null
      }
    }
  }
  const active = current && !current.done && !current.cancelled ? current : undefined
  const names = accepted.flatMap(p => p.names)
  const visible = live ? names.filter(name => allows.get(name) === true) : []
  return {
    owner,
    query,
    live,
    paused,
    accepted,
    names,
    visible,
    error,
    failedFull,
    intent,
    active,
    reads,
    calls,
    next: accepted.at(-1)?.next ?? null,
    retryRequired: live && error !== null,
    retryBusy: live && intent,
    forwardBlocked: !live || paused || failedFull || intent || active?.kind === 'full',
    owesFull: live && !paused && intent && !active,
    owesValidation:
      live &&
      !accepted.length &&
      current?.query === query &&
      current.began < boundAt &&
      current.done &&
      !current.failed,
    physicalPending: reads.filter(r => !r.done).length,
  }
}

// Executable A4 obligations. The driver supplies actual DOM/cost observations separately.
export type Observation = {
  names: string[]
  error: boolean
  retry: boolean
  retryBusy: boolean
  forwardDisabled: boolean
  calls: Array<string | null>
  inserted: number
  menu: boolean
}
export function violations(
  history: readonly Event[],
  actual: Observation,
  lane: 'common-baseline' | 'pre-role' | 'implemented',
  quiescent = false
): string[] {
  const m = expected(history),
    errors: string[] = []
  if (JSON.stringify(actual.names) !== JSON.stringify(m.visible)) errors.push('S3/S4/S13/S21 rows')
  if (actual.error !== (m.live && m.error !== null)) errors.push('S14/S16/S21 inline error')
  if (JSON.stringify(actual.calls) !== JSON.stringify(m.calls))
    errors.push('C19/C20/C21 physical cursors')
  if (actual.inserted !== 0) errors.push('S1 no implicit insertion')
  if (!m.live && actual.menu) errors.push('S4/S8 retired owner')
  if (lane === 'implemented') {
    if (actual.retry !== m.retryRequired) errors.push('S21 reachable Retry')
    if (m.retryRequired && actual.retryBusy !== m.retryBusy) errors.push('S18/S21 busy Retry')
  }
  if (
    lane !== 'common-baseline' &&
    m.next !== null &&
    m.forwardBlocked &&
    !actual.forwardDisabled
  ) {
    errors.push('S14/S18 forward gate')
  }
  if (quiescent && (m.physicalPending || m.active || m.owesFull || m.owesValidation || m.intent))
    errors.push('L10/L12 unsettled')
  return errors
}
