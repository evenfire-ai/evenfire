/**
 * Fake control-api for Control UI tests that stub `fetch`.
 *
 * It models control-api's HTTP contract for the Host routes of the agent page,
 * as Control UI reaches them through its `/control-api` proxy (`API_BASE` in
 * control-ui/lib/api.ts):
 *
 * - `GET /api/v1/admin/hosts/:name` answers the stored Host
 *   (control-api/src/routes/admin/resources.ts).
 * - `GET /api/v1/admin/hosts/:name/detail` answers the detail bundle: the stored
 *   Host and empty lists (control-api/src/routes/admin/hostsOverview.ts).
 * - `PUT /api/v1/admin/hosts/:name` replaces the spec (resources.ts Host PUT,
 *   control-api/src/services/resourceService.ts `updateResource`):
 *   - validation runs first. The one check modelled is the `spec.model`
 *     name/provider check of control-api/src/routes/admin/hostSpecValidation.ts,
 *     which needs no database; every other check passes;
 *   - a versioned PUT is one attempt: a version other than the stored one
 *     answers `409 { error: 'conflict', reason: 'resource_changed' }`;
 *   - a version-less PUT replaces whatever is stored (last write wins). With
 *     `versionRule`, one whose `spec.approval` differs from the stored block
 *     (key order ignored) answers
 *     `409 { error: 'conflict', reason: 'approval_requires_version' }`;
 *   - every accepted write moves the version, even with an unchanged spec,
 *     because control-api writes a fresh administrative-intent annotation;
 *   - an accepted write whose stored spec is unchanged moves the version a
 *     second time, after the answer is taken: the answer carries a version the
 *     store has already left (control-api's post-write generation patch, below);
 *   - `spec.approval` is pruned and defaulted by the chosen Host CRD, as the
 *     apiserver does (./hostCrdApproval);
 *   - the 200 body gains `warnings` when `spec.model` newly assigns a model
 *     listed in `staleModels`: one the stored spec does not reference in
 *     `spec.model`, `spec.allowedModels` or `spec.llmPolicy.fallbacks`
 *     (hostSpecValidation.ts `maybeWarnStale`; resources.ts answers
 *     `{ ...host, warnings }`).
 *
 * Any other request answers its `defaults` entry, or control-api's unknown-route
 * `404 { error: 'Not Found' }` (control-api/src/app.ts).
 *
 * Not modelled: the model allowlist (every model is accepted), warnings for
 * fallbacks and `allowedModels` entries, and other Host validation.
 *
 * control-api/test/routes.hostPut.fakeContract.test.ts pins this model to the
 * real routes.
 *
 * Each request passes three points, each awaited through `schedule`:
 * arrival (a read takes its answer from the store), apply (a write is applied),
 * and delivery (the answer reaches the client). A `hold` pauses one request
 * before its apply and before its delivery.
 *
 * Imported by control-ui and control-api tests through a relative path, so it
 * takes no npm package imports: Node builtins and ./hostCrdApproval only.
 */
import { randomUUID } from 'node:crypto'
import { STATUS_CODES } from 'node:http'
import {
  type HostCrdApprovalVersion,
  defaultApprovalBlock,
  loadHostCrdApprovalSchema,
  pruneApprovalBlock,
} from './hostCrdApproval'

export type HostObject = {
  metadata: {
    name: string
    namespace?: string
    resourceVersion?: string
    uid?: string
    generation?: number
    annotations?: Record<string, string>
    managedFields?: unknown[]
  }
  spec: Record<string, unknown>
  status?: unknown
}

export type FakePoint = 'arrival' | 'apply' | 'delivery'

/**
 * One request the fake received. `path` is the control-api path, without the
 * `/control-api` prefix and the query.
 *
 * - `arrived`: control-api received it.
 * - `applied`: a write was accepted at its apply point (a 2xx answer). A refused
 *   write and every read stay `false`.
 * - `delivered`: the client's `fetch` resolved. A dropped, hung or aborted
 *   request stays `false`.
 * - `response`: control-api's own answer once it has one, replaced by the answer
 *   given to `respondWith`.
 */
export type FakeLogEntry = {
  seq: number
  kind: 'read' | 'write'
  path: string
  method: string
  versionSent?: string
  body?: unknown
  arrived: boolean
  applied: boolean
  delivered: boolean
  response?: { status: number; body: unknown }
}

/**
 * Control over one held request. `deliverNow` applies first; `dropResponse`
 * applies, then rejects the client's `fetch` with `TypeError('Failed to fetch')`;
 * `hang` never delivers and leaves the apply to `applyNow`; `respondWith` answers
 * the client instead of the store without applying, and a later `applyNow` still
 * applies. Only one of these four may be used per hold.
 */
export interface FakeHold {
  arrived: Promise<void>
  applyNow(): void
  deliverNow(): void
  dropResponse(): void
  hang(): void
  respondWith(status: number, body: unknown): void
}

export interface FakeControlApi {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  log: FakeLogEntry[]
  /**
   * Moves the version without changing the spec: an HCC status write, a wake
   * annotation patch, or control-api's post-write generation patch (spec E6).
   * Control UI sees the same of each; `kind` names the one a test models.
   * Not a request, so not in `log`. A PUT with an unchanged spec already
   * applies its own post-write patch, so `'post-write'` stands for another
   * writer's; after such a PUT it would move the version once more.
   */
  bumpVersion(name: string, kind: 'status' | 'annotation' | 'post-write'): void
  /**
   * Another writer (an admin, kubectl, a manifest apply), stored like an accepted
   * PUT: pruned, defaulted and one new version, with no post-write patch even when
   * the spec is unchanged. Not a request, so not in `log`.
   */
  writeExternal(name: string, mutate: (spec: Record<string, unknown>) => void): void
  /**
   * Holds the `nth` (default 1) request matching `method` and `path`, counted from
   * this call. `path` may carry the `/control-api` prefix.
   */
  hold(match: { method: string; path: string; nth?: number }): FakeHold
  stored(name: string): HostObject
}

export type FakeControlApiOptions = {
  hosts: Record<string, HostObject>
  crd: HostCrdApprovalVersion
  versionRule: boolean
  /** Recorded answers keyed by control-api path, as in `FakeLogEntry.path`. */
  defaults?: Record<string, { status: number; body: unknown }>
  schedule?: (point: FakePoint, entry: FakeLogEntry) => Promise<void>
  /** Enabled models the allowlist marks stale; assigning one newly warns. */
  staleModels?: Array<{ provider: string; model: string }>
}

/** control-api's warning for a newly assigned stale model (staleModelWarning.ts). */
export type StaleModelWarning = {
  code: 'stale_model_assigned'
  provider: string
  model: string
  field: string
}

type Answer = { status: number; body: unknown }

type Route = { kind: 'host' | 'detail' | 'put'; name: string } | { kind: 'unmodelled' }

type Received = {
  method: string
  path: string
  route: Route
  body: unknown
  signal: AbortSignal | null | undefined
}

type Latch = { promise: Promise<void>; open: () => void }

type HoldState = {
  method: string
  path: string
  nth: number
  seen: number
  arrival: Latch
  apply: Latch
  delivery: Latch
  ending?: 'deliverNow' | 'dropResponse' | 'hang' | 'respondWith'
  injected?: Answer
}

type Client = { deliver(answer: Answer): void; fail(error: unknown): boolean }

// Control UI's proxy prefix for control-api (control-ui/lib/api.ts API_BASE).
const CONTROL_UI_PROXY_PREFIX = '/control-api'
// control-api's default Host namespace, named in its 404 (control-api/src/config.ts).
const HOSTS_NAMESPACE = 'mcp-host'
const HOST_ROUTE = /^\/api\/v1\/admin\/hosts\/([^/]+)(\/detail)?$/
// Resolves relative request URLs; nothing is ever sent to it.
const URL_BASE = 'http://control-ui.test'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A copy as it crosses the wire: JSON out, JSON in. */
function wireCopy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

/** Equality of JSON values; object key order is ignored, array order is not. */
function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    )
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
    )
  }
  return a === b
}

function notModelled(what: string, cause?: unknown): Error {
  return new Error(`fakeControlApi: ${what} is not modelled`, { cause })
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError')
}

function latch(): Latch {
  let open!: () => void
  const promise = new Promise<void>(resolve => {
    open = resolve
  })
  return { promise, open }
}

/** The control-api path a URL names: its pathname without Control UI's proxy prefix. */
function controlApiPath(url: string): string {
  const { pathname } = new URL(url, URL_BASE)
  return pathname.startsWith(`${CONTROL_UI_PROXY_PREFIX}/`)
    ? pathname.slice(CONTROL_UI_PROXY_PREFIX.length)
    : pathname
}

function routeOf(method: string, path: string): Route {
  const match = HOST_ROUTE.exec(path)
  if (!match) return { kind: 'unmodelled' }
  const name = decodeURIComponent(match[1])
  if (method === 'GET') return { kind: match[2] ? 'detail' : 'host', name }
  if (method === 'PUT' && !match[2]) return { kind: 'put', name }
  return { kind: 'unmodelled' }
}

function readBody(raw: BodyInit | null | undefined): unknown {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw notModelled('a request body that is not a string')
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw notModelled('a request body that is not JSON', error)
  }
}

/**
 * Control UI's Host PUTs carry `spec` and at most `metadata.resourceVersion`
 * (control-ui/app/hosts/[name]/page.tsx). Other bodies would make control-api
 * act in ways the fake does not model, so they fail the test: without `spec`,
 * today's route skips Host validation and replaces the object with no spec
 * (resources.ts guards on `body.spec`), and `updateResource` acts on
 * `metadata.labels`, `annotations` and `uid`.
 */
function checkHostPutBody(body: unknown): void {
  if (!isRecord(body) || !isRecord(body.spec)) throw notModelled('a Host PUT without a spec object')
  const metadata = isRecord(body.metadata) ? body.metadata : {}
  for (const key of ['labels', 'annotations', 'uid']) {
    if (Object.hasOwn(metadata, key)) throw notModelled(`metadata.${key} on a Host PUT`)
  }
}

function receive(input: RequestInfo | URL, init: RequestInit): Received {
  const request = typeof input === 'object' && 'method' in input ? input : undefined
  const method = (init.method ?? request?.method ?? 'GET').toUpperCase()
  const path = controlApiPath(request ? request.url : String(input))
  const route = routeOf(method, path)
  const body = readBody(init.body)
  if (route.kind === 'put') checkHostPutBody(body)
  return { method, path, route, body, signal: init.signal ?? request?.signal }
}

/** The version a write carries, read as control-api does (`resourceVersion || undefined`). */
function sentVersion(body: unknown): string | undefined {
  const version =
    isRecord(body) && isRecord(body.metadata) ? body.metadata.resourceVersion : undefined
  return version ? String(version) : undefined
}

function conflict(reason: 'resource_changed' | 'approval_requires_version'): Answer {
  return { status: 409, body: { error: 'conflict', reason } }
}

function invalid(field: string, message: string): Answer {
  return { status: 422, body: { errors: [{ field, message }] } }
}

/** clerumErrorHandler's 4xx body for getResource's K8sNotFoundError. */
function hostNotFound(name: string): Answer {
  return {
    status: 404,
    body: {
      error: `hosts/${name} not found in namespace ${HOSTS_NAMESPACE}`,
      correlationId: randomUUID(),
    },
  }
}

/** hostSpecValidation.ts's `spec.model` check, the one Host validation modelled. */
function hostSpecIssue(spec: Record<string, unknown>): Answer | null {
  const model = spec.model
  if (!isRecord(model) || !Object.hasOwn(model, 'name')) return null
  const name = typeof model.name === 'string' ? model.name.trim() : ''
  if (!name) return invalid('spec.model.name', 'spec.model.name must be a non-empty string')
  const provider = typeof model.provider === 'string' ? model.provider.trim() : ''
  if (!provider) {
    return invalid(
      'spec.model.provider',
      'spec.model.provider is required when spec.model.name is set'
    )
  }
  return null
}

/** The `(provider, model)` pairs a Host spec references (control-api hostModelReferences.ts). */
function modelReferences(spec: Record<string, unknown>): Set<string> {
  const pairs = new Set<string>()
  const add = (provider: unknown, model: unknown) => {
    const p = typeof provider === 'string' ? provider.trim() : ''
    const m = typeof model === 'string' ? model.trim() : ''
    if (p && m) pairs.add(JSON.stringify([p, m]))
  }
  if (isRecord(spec.model)) add(spec.model.provider, spec.model.name)
  for (const entry of Array.isArray(spec.allowedModels) ? spec.allowedModels : []) {
    if (isRecord(entry)) add(entry.provider, entry.model)
  }
  const policy = isRecord(spec.llmPolicy) ? spec.llmPolicy : {}
  for (const entry of Array.isArray(policy.fallbacks) ? policy.fallbacks : []) {
    if (isRecord(entry)) add(entry.provider, entry.model)
  }
  return pairs
}

/**
 * hostSpecValidation.ts `maybeWarnStale` for `spec.model`: a warning when it
 * names a stale model the stored spec does not reference yet.
 */
function staleModelWarnings(
  spec: Record<string, unknown>,
  stored: Record<string, unknown>,
  staleModels: ReadonlyArray<{ provider: string; model: string }>
): StaleModelWarning[] {
  if (!isRecord(spec.model)) return []
  const provider = typeof spec.model.provider === 'string' ? spec.model.provider.trim() : ''
  const model = typeof spec.model.name === 'string' ? spec.model.name.trim() : ''
  const stale = staleModels.some(entry => entry.provider === provider && entry.model === model)
  if (!stale || modelReferences(stored).has(JSON.stringify([provider, model]))) return []
  return [{ code: 'stale_model_assigned', provider, model, field: 'spec.model.name' }]
}

function toResponse(answer: Answer): Response {
  return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
    status: answer.status,
    statusText: STATUS_CODES[answer.status] ?? '',
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export function createFakeControlApi(options: FakeControlApiOptions): FakeControlApi {
  const schema = loadHostCrdApprovalSchema(options.crd)
  const log: FakeLogEntry[] = []
  const waitingHolds = new Set<HoldState>()
  const hosts = new Map<string, HostObject>()
  // Versions are opaque counter values, started above every numeric seed
  // version so that none repeats.
  let lastVersion = Math.max(
    0,
    ...Object.values(options.hosts)
      .map(host => Number(host.metadata.resourceVersion))
      .filter(Number.isSafeInteger)
  )
  const nextVersion = () => String((lastVersion += 1))
  for (const [name, seed] of Object.entries(options.hosts)) {
    const host = wireCopy(seed)
    if (!host.metadata.resourceVersion) host.metadata.resourceVersion = nextVersion()
    hosts.set(name, host)
  }

  function requireHost(name: string): HostObject {
    const host = hosts.get(name)
    if (!host) throw new Error(`fakeControlApi: no Host named ${name}`)
    return host
  }

  /** A new version for the stored Host; nothing else changes. */
  function moveVersion(name: string): void {
    const next = wireCopy(requireHost(name))
    next.metadata.resourceVersion = nextVersion()
    hosts.set(name, next)
  }

  /** An accepted write as the apiserver stores it: approval pruned and defaulted, a new version. */
  function storeSpec(name: string, current: HostObject, spec: Record<string, unknown>): HostObject {
    const next = wireCopy(current)
    next.spec = wireCopy(spec)
    if (isRecord(next.spec.approval)) {
      next.spec.approval = defaultApprovalBlock(
        pruneApprovalBlock(next.spec.approval, schema),
        schema
      )
    }
    next.metadata.resourceVersion = nextVersion()
    hosts.set(name, next)
    return next
  }

  /** The Host PUT at its apply point, checked in the order of the real route. */
  function applyHostPut(name: string, body: { spec: Record<string, unknown> }): Answer {
    const issue = hostSpecIssue(body.spec)
    if (issue) return issue
    const current = hosts.get(name)
    if (!current) return hostNotFound(name)
    const version = sentVersion(body)
    if (version !== undefined) {
      if (version !== current.metadata.resourceVersion) return conflict('resource_changed')
    } else if (options.versionRule && !sameJson(body.spec.approval, current.spec.approval)) {
      return conflict('approval_requires_version')
    }
    const warnings = staleModelWarnings(body.spec, current.spec, options.staleModels ?? [])
    const stored = wireCopy(storeSpec(name, current, body.spec))
    // control-api answers with the replace's own response. A replace that left
    // the stored spec as it was kept `metadata.generation`, so before answering,
    // reconcileAdministrativeIntentGeneration (resourceService.ts) patches the
    // intent annotation down to that generation, which moves the version again:
    // the answer carries a version the store has already left. Pinned by
    // control-api/test/routes.hostPut.fakeContract.test.ts.
    if (sameJson(stored.spec, current.spec)) moveVersion(name)
    return { status: 200, body: warnings.length > 0 ? { ...stored, warnings } : stored }
  }

  function unmodelled(path: string): Answer {
    const recorded = options.defaults?.[path]
    if (recorded) return { status: recorded.status, body: wireCopy(recorded.body) }
    return { status: 404, body: { error: 'Not Found' } }
  }

  function answerRead({ route, path }: Received): Answer {
    if (route.kind === 'unmodelled') return unmodelled(path)
    const host = hosts.get(route.name)
    if (!host) return hostNotFound(route.name)
    if (route.kind === 'host') return { status: 200, body: wireCopy(host) }
    return {
      status: 200,
      body: {
        host: wireCopy(host),
        contexts: [],
        secrets: [],
        users: [],
        teams: [],
        agentUsers: [],
        agentTeams: [],
      },
    }
  }

  function answerWrite({ route, path, body }: Received): Answer {
    if (route.kind === 'put')
      return applyHostPut(route.name, body as { spec: Record<string, unknown> })
    return unmodelled(path)
  }

  function claimHold(method: string, path: string): HoldState | undefined {
    let claimed: HoldState | undefined
    for (const hold of waitingHolds) {
      if (hold.method !== method || hold.path !== path) continue
      hold.seen += 1
      if (hold.seen < hold.nth) continue
      if (claimed) throw new Error(`fakeControlApi: two holds matched one ${method} ${path}`)
      claimed = hold
    }
    if (claimed) waitingHolds.delete(claimed)
    return claimed
  }

  const reach = (point: FakePoint, entry: FakeLogEntry) => options.schedule?.(point, entry)

  async function applyPoint(entry: FakeLogEntry, request: Received, hold?: HoldState) {
    await hold?.apply.promise
    await reach('apply', entry)
    if (entry.kind === 'read') return
    const answer = answerWrite(request)
    entry.applied = answer.status >= 200 && answer.status < 300
    if (!hold?.injected) entry.response = answer
  }

  async function serve(entry: FakeLogEntry, request: Received, client: Client, hold?: HoldState) {
    await reach('arrival', entry)
    if (entry.kind === 'read') entry.response = answerRead(request)
    entry.arrived = true
    hold?.arrival.open()
    const applying = applyPoint(entry, request, hold)
    await hold?.delivery.promise
    // A delivery follows the apply, except an answer given to respondWith.
    if (!hold?.injected) await applying
    await reach('delivery', entry)
    if (hold?.ending === 'dropResponse') {
      client.fail(new TypeError('Failed to fetch'))
    } else {
      if (hold?.injected) entry.response = hold.injected
      client.deliver(entry.response)
    }
    await applying
  }

  function respond(entry: FakeLogEntry, request: Received, hold?: HoldState): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const { signal } = request
      let settled = false
      const settle = (): boolean => {
        if (settled) return false
        settled = true
        signal?.removeEventListener('abort', onAbort)
        return true
      }
      // The client gives up; control-api still finishes what it received.
      const onAbort = () => {
        if (settle()) reject(abortError())
      }
      signal?.addEventListener('abort', onAbort)
      const client: Client = {
        deliver(answer) {
          // Built first, so an answer no Response can carry rejects this fetch.
          const response = toResponse(answer)
          if (!settle()) return
          entry.delivered = true
          resolve(response)
        },
        fail(error) {
          if (!settle()) return false
          reject(error)
          return true
        },
      }
      void serve(entry, request, client, hold).catch((error: unknown) => {
        // Nothing awaits this request any more (aborted, dropped or answered):
        // rethrow so that the test run reports the failure.
        if (!client.fail(error)) throw error
      })
    })
  }

  return {
    log,
    async fetch(input, init = {}) {
      const request = receive(input, init)
      // A signal aborted before the call sends nothing.
      if (request.signal?.aborted) throw abortError()
      const hold = claimHold(request.method, request.path)
      const kind = request.method === 'GET' ? 'read' : 'write'
      const versionSent = kind === 'write' ? sentVersion(request.body) : undefined
      const entry: FakeLogEntry = {
        seq: log.length + 1,
        kind,
        path: request.path,
        method: request.method,
        ...(versionSent === undefined ? {} : { versionSent }),
        ...(request.body === undefined ? {} : { body: wireCopy(request.body) }),
        arrived: false,
        applied: false,
        delivered: false,
      }
      log.push(entry)
      return respond(entry, request, hold)
    },
    bumpVersion(name) {
      moveVersion(name)
    },
    writeExternal(name, mutate) {
      const current = requireHost(name)
      const spec = wireCopy(current.spec)
      mutate(spec)
      storeSpec(name, current, spec)
    },
    hold(match) {
      const state: HoldState = {
        method: match.method.toUpperCase(),
        path: controlApiPath(match.path),
        nth: match.nth ?? 1,
        seen: 0,
        arrival: latch(),
        apply: latch(),
        delivery: latch(),
      }
      waitingHolds.add(state)
      const end = (action: NonNullable<HoldState['ending']>) => {
        if (state.ending) {
          throw new Error(`fakeControlApi: ${action} after ${state.ending} on the same hold`)
        }
        state.ending = action
      }
      return {
        arrived: state.arrival.promise,
        applyNow: () => state.apply.open(),
        deliverNow: () => {
          end('deliverNow')
          state.apply.open()
          state.delivery.open()
        },
        dropResponse: () => {
          end('dropResponse')
          state.apply.open()
          state.delivery.open()
        },
        hang: () => end('hang'),
        respondWith: (status, body) => {
          end('respondWith')
          state.injected = { status, body: wireCopy(body) }
          state.delivery.open()
        },
      }
    },
    stored: name => wireCopy(requireHost(name)),
  }
}
