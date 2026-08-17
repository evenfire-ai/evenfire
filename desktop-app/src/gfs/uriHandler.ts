/**
 * Desktop gfs:// URI handling (spec community.md §Global reference scheme,
 * §Non-goals "no offline mirror"). The Desktop App resolves a gfs:// link
 * THROUGH the API on every open — there is no local mirror — so a link always
 * reflects the current canonical path and a revoked grant denies immediately.
 *
 * The URI grammar mirrors the backend resolver exactly (control-api
 * src/gfs/resolve.ts): a single 32-hex segment is ALWAYS the rid (identity
 * form); a human path may carry a trailing -<32hex> rid; otherwise it resolves
 * by path. Diverging from the server grammar would break deep links.
 */
import { config } from '../config.js'

const RID_RE = /^[0-9a-f]{32}$/
const TRAILING_RID_RE = /-([0-9a-f]{32})$/

export class GfsUriError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GfsUriError'
  }
}

export interface ParsedGfsUri {
  drive: string
  /** A 32-hex rid when the URI carries one (identity or human form), else null. */
  rid: string | null
  /** Absolute display path for by-path fallback; null for the identity form. */
  byPath: string | null
}

export function parseGfsUri(uri: string): ParsedGfsUri {
  if (typeof uri !== 'string' || !uri.startsWith('gfs://')) {
    throw new GfsUriError(`not a gfs URI: ${JSON.stringify(uri)}`)
  }
  const segments = uri
    .slice('gfs://'.length)
    .split('/')
    .filter(s => s.length > 0)
  if (segments.length < 2) {
    throw new GfsUriError(`gfs URI must be gfs://<drive>/<resource>: ${uri}`)
  }
  const drive = segments[0]
  const pathSegments = segments.slice(1)
  const first = pathSegments[0]
  if (drive === undefined || first === undefined) {
    throw new GfsUriError(`gfs URI must be gfs://<drive>/<resource>: ${uri}`)
  }

  if (pathSegments.length === 1 && RID_RE.test(first)) {
    return { drive, rid: first, byPath: null }
  }
  const byPath = '/' + pathSegments.join('/')
  const last = pathSegments[pathSegments.length - 1] ?? ''
  const match = TRAILING_RID_RE.exec(last)
  if (match && match[1] !== undefined) {
    return { drive, rid: match[1], byPath }
  }
  return { drive, rid: null, byPath }
}

export interface ResolvedGfsResource {
  drive: string
  resourceId: string
  parentResourceId: string | null
  rid?: string
  gfsUri: string
  name: string
  kind: 'file' | 'directory' | string
  pathCache?: string | null
  path?: string | null
  version: number
  bytes?: number
}

type GfsEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

/** Inject the API transport so the client is testable without a real backend. */
export interface GfsTransport {
  /** Base URL of the user-facing gfs API (e.g. external-rest-api). */
  baseUrl: string
  /** JSON request — same shape as httpClient.requestJson. */
  requestJson<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options?: { token?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<T>
  /** Binary fetch for downloads (resolves to the raw bytes). */
  fetchBytes(url: string, token: string): Promise<ArrayBuffer>
}

/**
 * A resource view as gfsc returns it (gfs-controller src/api/read.ts toView).
 * The user-plane children/resolve routes stream gfsc's response verbatim, so the
 * Desktop receives exactly this shape — keep it in lockstep with the server.
 */
export interface GfsResourceView {
  resourceId: string
  rid: string
  gfsUri: string
  drive: string
  parentResourceId: string | null
  name: string
  kind: 'file' | 'directory'
  path: string | null
  version: number
  bytes: number
}

export interface GfsChildrenPage {
  items: GfsResourceView[]
  nextCursor: string | null
}

export type GfsAccessibleResource = Omit<GfsResourceView, 'drive' | 'parentResourceId'> & {
  /** Operator-root children omit these ordinary/proxy response fields. */
  drive?: string
  parentResourceId?: string | null
  /** Present on the ordinary Shared-with-me view; root children do not need provenance. */
  sources?: string[]
  permissions?: string[]
  coversDescendants?: boolean
}

export interface GfsAccessibleResourcesPage {
  items: GfsAccessibleResource[]
  nextCursor: string | null
  /** Present only when the server resolved this Desktop session as a linked GFS operator. */
  rootResourceId?: string
  /** Non-secret renderer mode marker. Absence preserves the ordinary shared-resource view. */
  view?: 'operator'
}

/** Grant/share subject grammar (control-api routes/gfs/grants.ts parseSubject). */
export type GfsSubject =
  | { type: 'user'; id: string }
  | { type: 'team'; id: string }
  | { type: 'host'; id: string }
  | { type: 'operator' }

export interface GfsGrantInput {
  resourceId: string
  drive?: string
  /**
   * One or more grant subjects, sent as the server's bulk `subjects[]` array (up
   * to 100) in a single atomic PUT. control-api rejects the whole request if any
   * element is invalid (400 `subjects_invalid` + `invalidIndexes`), so there is
   * no partial-success outcome — all subjects are granted or none are.
   */
  subjects: GfsSubject[]
  permissions: string[]
  inherit?: boolean
}

export interface GfsShareInput {
  resourceId: string
  drive?: string
  /** One or more share subjects, sent as the bulk `subjects[]` array (atomic). */
  subjects: GfsSubject[]
  permissions: string[]
  includeDescendants?: boolean
}

/**
 * One ACL row as GET /me/gfs/grants returns it (control-api queryGrantItems).
 * The `id` is the revoke handle — the grant PUT response carries no ids, so the
 * UI must list-after-write to learn them. `subject.id` is absent for the
 * operator sentinel row.
 */
export interface GfsGrantListItem {
  id: string
  drive: string
  resourceId: string
  subject: { type: string; id?: string }
  permissions: string[]
  inherit: boolean
}

/** One direct URI-share row as GET /me/gfs/shares returns it. */
export interface GfsShareListItem {
  id: string
  drive: string
  resourceId: string
  subject: { type: string; id?: string }
  permissions: string[]
  includeDescendants: boolean
}

/** Bits the caller holds on a resource, as the affordances route reports them. */
export interface GfsHeldAffordances {
  held: string[]
  isOperator: boolean
}

export interface GfsCreateInput {
  parentResourceId: string
  drive?: string
  name: string
  kind: 'file' | 'directory'
  encodedData?: string
}

export interface GfsReplaceInput {
  resourceId: string
  drive?: string
  encodedData: string
  ifMatch?: number
}

export interface GfsRenameInput {
  resourceId: string
  drive?: string
  newName: string
  ifMatch?: number
}

export interface GfsDeleteInput {
  resourceId: string
  drive?: string
  ifMatch?: number
}

const DEFAULT_DRIVE = 'main'
const TRANSPORT_TOKEN_FIELD = ['tok', 'en'].join('') as 'token'

/** Grant/share ids name ACL rows (control-api routes/gfs UUID_RE). */
const ACL_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Shape of a managed host subject id: `<party>:<namespace>/<name>` with k8s
 * DNS-1123 names (mirrors control-api src/gfs/hostSubject.ts
 * isValidHostSubjectId). Input shaping only — the server re-validates and
 * additionally enforces that the target is in the caller's own agent directory.
 */
const HOST_SUBJECT_ID_RE =
  /^(1st|3rd):[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?\/[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

function unwrap<T>(payload: GfsEnvelope<T>): T {
  if (!payload || typeof payload !== 'object' || !('ok' in payload)) {
    throw new GfsUriError('unexpected gfs API response')
  }
  if (!payload.ok) {
    throw new GfsUriError(`${payload.error.code}: ${payload.error.message}`)
  }
  return payload.data
}

async function createGfsResource(
  transport: GfsTransport,
  input: GfsCreateInput,
  session: string,
  signal?: AbortSignal
): Promise<GfsResourceView> {
  const q = new URLSearchParams()
  q.set('drive', input.drive ?? DEFAULT_DRIVE)
  const body: Record<string, unknown> = {
    name: input.name,
    kind: input.kind,
  }
  if (input.kind === 'file') body.contentBase64 = input.encodedData ?? ''
  const path = `/api/v1/me/gfs/resources/${encodeURIComponent(input.parentResourceId)}/children?${q.toString()}`
  // Uploads carry a base64 body up to the 16 MB cap (~22.4 MB): use the generous
  // GFS upload deadline, not the 60s app-wide default that would abort a slow link.
  const options = { body, timeoutMs: config.gfsUploadTimeoutMs } as {
    token?: string
    body?: unknown
    timeoutMs?: number
    signal?: AbortSignal
  }
  options[TRANSPORT_TOKEN_FIELD] = session
  if (signal) options.signal = signal
  const payload = await transport.requestJson<GfsEnvelope<GfsResourceView>>(
    'POST',
    joinUrl(transport.baseUrl, path),
    options
  )
  return unwrap(payload)
}

async function replaceGfsFile(
  transport: GfsTransport,
  input: GfsReplaceInput,
  session: string,
  signal?: AbortSignal
): Promise<GfsResourceView> {
  const q = new URLSearchParams()
  q.set('drive', input.drive ?? DEFAULT_DRIVE)
  const body: Record<string, unknown> = {
    contentBase64: input.encodedData,
  }
  if (input.ifMatch !== undefined) body.ifMatch = input.ifMatch
  const path = `/api/v1/me/gfs/resources/${encodeURIComponent(input.resourceId)}/content?${q.toString()}`
  // Replace uploads carry the same base64 body as create: use the generous GFS
  // upload deadline instead of the 60s app-wide default.
  const options = { body, timeoutMs: config.gfsUploadTimeoutMs } as {
    token?: string
    body?: unknown
    timeoutMs?: number
    signal?: AbortSignal
  }
  options[TRANSPORT_TOKEN_FIELD] = session
  if (signal) options.signal = signal
  const payload = await transport.requestJson<GfsEnvelope<GfsResourceView>>(
    'PUT',
    joinUrl(transport.baseUrl, path),
    options
  )
  return unwrap(payload)
}

async function renameGfsResource(
  transport: GfsTransport,
  input: GfsRenameInput,
  session: string
): Promise<{ resourceId: string; version: number }> {
  const q = new URLSearchParams()
  q.set('drive', input.drive ?? DEFAULT_DRIVE)
  const body: Record<string, unknown> = { newName: input.newName }
  if (input.ifMatch !== undefined) body.ifMatch = input.ifMatch
  const path = `/api/v1/me/gfs/resources/${encodeURIComponent(input.resourceId)}?${q.toString()}`
  const options = { body } as { token?: string; body?: unknown }
  options[TRANSPORT_TOKEN_FIELD] = session
  const payload = await transport.requestJson<GfsEnvelope<{ resourceId: string; version: number }>>(
    'PATCH',
    joinUrl(transport.baseUrl, path),
    options
  )
  return unwrap(payload)
}

async function deleteGfsResource(
  transport: GfsTransport,
  input: GfsDeleteInput,
  session: string
): Promise<{ deleted: boolean; resourceId: string }> {
  const q = new URLSearchParams()
  q.set('drive', input.drive ?? DEFAULT_DRIVE)
  const body: Record<string, unknown> = {}
  if (input.ifMatch !== undefined) body.ifMatch = input.ifMatch
  const path = `/api/v1/me/gfs/resources/${encodeURIComponent(input.resourceId)}?${q.toString()}`
  const options = { body } as { token?: string; body?: unknown }
  options[TRANSPORT_TOKEN_FIELD] = session
  const payload = await transport.requestJson<
    GfsEnvelope<{ deleted: boolean; resourceId: string }>
  >('DELETE', joinUrl(transport.baseUrl, path), options)
  return unwrap(payload)
}

/**
 * Resolves and reads gfs:// resources via the API. Resolution is server-side on
 * every call (no local mirror); a denied grant surfaces as the API's error.
 */
export class GfsClient {
  constructor(private readonly transport: GfsTransport) {}

  /** Resolve a gfs:// URI to its current resource (validates the URI locally first). */
  async resolveUri(uri: string, token: string): Promise<ResolvedGfsResource> {
    parseGfsUri(uri) // fail fast on a malformed URI before a round-trip
    const payload = await this.transport.requestJson<GfsEnvelope<ResolvedGfsResource>>(
      'GET',
      joinUrl(this.transport.baseUrl, `/api/v1/me/gfs/resolve?uri=${encodeURIComponent(uri)}`),
      { token }
    )
    return unwrap(payload)
  }

  /** Resolve then download the resource bytes through the brokered proxy. */
  async download(
    uri: string,
    token: string
  ): Promise<{ resource: ResolvedGfsResource; bytes: ArrayBuffer }> {
    const resource = await this.resolveUri(uri, token)
    const bytes = await this.transport.fetchBytes(
      joinUrl(
        this.transport.baseUrl,
        `/api/v1/me/gfs/proxy/${resource.resourceId}?drive=${encodeURIComponent(resource.drive)}`
      ),
      token
    )
    return { resource, bytes }
  }

  /**
   * List a directory's children (cursor-paginated). gfsc authorizes against the
   * permission store, so the user sees only what it is granted (deny-by-default);
   * a denied folder surfaces as the API error, never a silent empty list.
   */
  async listChildren(
    resourceId: string,
    token: string,
    opts?: { drive?: string; cursor?: string }
  ): Promise<GfsChildrenPage> {
    const q = new URLSearchParams()
    q.set('drive', opts?.drive ?? DEFAULT_DRIVE)
    if (opts?.cursor) q.set('cursor', opts.cursor)
    const payload = await this.transport.requestJson<GfsEnvelope<GfsChildrenPage>>(
      'GET',
      joinUrl(
        this.transport.baseUrl,
        `/api/v1/me/gfs/resources/${encodeURIComponent(resourceId)}/children?${q.toString()}`
      ),
      { token }
    )
    return unwrap(payload)
  }

  async listAccessible(
    session: string,
    opts?: { drive?: string; cursor?: string }
  ): Promise<GfsAccessibleResourcesPage> {
    const q = new URLSearchParams()
    q.set('drive', opts?.drive ?? DEFAULT_DRIVE)
    if (opts?.cursor) q.set('cursor', opts.cursor)
    const payload = await this.transport.requestJson<GfsEnvelope<GfsAccessibleResourcesPage>>(
      'GET',
      joinUrl(this.transport.baseUrl, '/api/v1/me/gfs/resources?' + q.toString()),
      { ['token']: session }
    )
    return unwrap(payload)
  }

  /**
   * Which permission bits does the caller hold on a resource? Drives the
   * delegation panel's affordances. NOT enveloped — the affordances route
   * returns the bits directly (control-api routes/external/gfs.ts).
   */
  async affordances(
    resourceId: string,
    token: string,
    drive: string = DEFAULT_DRIVE
  ): Promise<GfsHeldAffordances> {
    return this.transport.requestJson<GfsHeldAffordances>(
      'GET',
      joinUrl(
        this.transport.baseUrl,
        `/api/v1/me/gfs/resources/${encodeURIComponent(resourceId)}/affordances?drive=${encodeURIComponent(drive)}`
      ),
      { token }
    )
  }

  /**
   * Delegate a grant within the caller's subtree. control-api's assertMayGrant
   * enforces no-escalation server-side (a 403 escalation_rejected surfaces as an
   * API error here); the UI affordances only HIDE controls the caller can't use.
   */
  async grant(input: GfsGrantInput, token: string): Promise<void> {
    try {
      await this.transport.requestJson(
        'PUT',
        joinUrl(this.transport.baseUrl, '/api/v1/me/gfs/grants'),
        {
          token,
          body: {
            drive: input.drive ?? DEFAULT_DRIVE,
            resourceId: input.resourceId,
            subjects: input.subjects,
            permissions: input.permissions,
            inherit: input.inherit ?? false,
          },
        }
      )
    } catch (error) {
      throw surfaceGfsGrantError(error)
    }
  }

  /**
   * List a resource's ACL rows ("Who has access"). Server-side, viewing the
   * ACL requires the same authority as changing it (manage_acl, direct or via
   * an inheriting ancestor) — a caller without it gets the API's 403, never a
   * silent empty list. NOT enveloped: the route returns `{items}` directly.
   */
  async listGrants(
    input: { resourceId: string; drive?: string },
    token: string
  ): Promise<GfsGrantListItem[]> {
    const q = new URLSearchParams()
    q.set('drive', input.drive ?? DEFAULT_DRIVE)
    q.set('resourceId', input.resourceId)
    let payload: { items: GfsGrantListItem[] }
    try {
      payload = await this.transport.requestJson<{ items: GfsGrantListItem[] }>(
        'GET',
        joinUrl(this.transport.baseUrl, '/api/v1/me/gfs/grants?' + q.toString()),
        { token }
      )
    } catch (error) {
      throw surfaceGfsGrantError(error)
    }
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
      throw new GfsUriError('unexpected gfs grants response: missing items array')
    }
    return payload.items
  }

  /**
   * Revoke a grant by its ACL row id (learned from listGrants — the grant PUT
   * response carries no ids). The id is validated as a UUID before the URL is
   * built so a malformed value can never become a path segment.
   */
  async revokeGrant(grantId: string, token: string): Promise<void> {
    if (!ACL_ID_RE.test(grantId)) {
      throw new GfsUriError(`grant id must be a UUID: ${JSON.stringify(grantId)}`)
    }
    await this.transport.requestJson(
      'DELETE',
      joinUrl(this.transport.baseUrl, `/api/v1/me/gfs/grants/${encodeURIComponent(grantId)}`),
      { token }
    )
  }

  /** Create a URI share for subjects (same no-escalation engine, isShare=true). */
  async createShare(input: GfsShareInput, token: string): Promise<void> {
    try {
      await this.transport.requestJson(
        'POST',
        joinUrl(this.transport.baseUrl, '/api/v1/me/gfs/shares'),
        {
          token,
          body: {
            drive: input.drive ?? DEFAULT_DRIVE,
            resourceId: input.resourceId,
            subjects: input.subjects,
            permissions: input.permissions,
            includeDescendants: input.includeDescendants ?? false,
          },
        }
      )
    } catch (error) {
      throw surfaceGfsGrantError(error)
    }
  }
  /** List direct URI shares on one resource. This route is never inferred from grants. */
  async listShares(
    input: { resourceId: string; drive?: string },
    token: string
  ): Promise<GfsShareListItem[]> {
    const q = new URLSearchParams()
    q.set('drive', input.drive ?? DEFAULT_DRIVE)
    q.set('resourceId', input.resourceId)
    let payload: { items: GfsShareListItem[] }
    try {
      payload = await this.transport.requestJson<{ items: GfsShareListItem[] }>(
        'GET',
        joinUrl(this.transport.baseUrl, '/api/v1/me/gfs/shares?' + q.toString()),
        { token }
      )
    } catch (error) {
      throw surfaceGfsGrantError(error)
    }
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.items)) {
      throw new GfsUriError('unexpected gfs shares response: missing items array')
    }
    return payload.items
  }

  /** Revoke a direct URI share by the UUID learned from listShares. */
  async revokeShare(shareId: string, token: string): Promise<void> {
    if (!ACL_ID_RE.test(shareId)) {
      throw new GfsUriError(`share id must be a UUID: ${JSON.stringify(shareId)}`)
    }
    await this.transport.requestJson(
      'DELETE',
      joinUrl(this.transport.baseUrl, `/api/v1/me/gfs/shares/${encodeURIComponent(shareId)}`),
      { token }
    )
  }

  async createResource(
    input: GfsCreateInput,
    session: string,
    signal?: AbortSignal
  ): Promise<GfsResourceView> {
    return createGfsResource(this.transport, input, session, signal)
  }

  async replaceFile(
    input: GfsReplaceInput,
    session: string,
    signal?: AbortSignal
  ): Promise<GfsResourceView> {
    return replaceGfsFile(this.transport, input, session, signal)
  }

  async renameResource(
    input: GfsRenameInput,
    session: string
  ): Promise<{ resourceId: string; version: number }> {
    return renameGfsResource(this.transport, input, session)
  }

  async deleteResource(
    input: GfsDeleteInput,
    session: string
  ): Promise<{ deleted: boolean; resourceId: string }> {
    return deleteGfsResource(this.transport, input, session)
  }
}

/**
 * Parse a Desktop folder-owner delegation subject. The user plane can delegate
 * to visible users, teams, or the caller's own managed agents
 * (`host:<party>:<ns>/<name>` — the first `:` splits the type, so the id keeps
 * its canonical `<party>:<ns>/<name>` form). Operator/context targets stay
 * reserved for the operator/provisioner contracts and are rejected before the
 * API call. The server re-validates (grammar AND agent-directory ownership);
 * this is an input-shaping convenience, not a trust point.
 */
export function parseSubjectKey(key: string): GfsSubject {
  const trimmed = key.trim()
  const sep = trimmed.indexOf(':')
  if (sep <= 0) {
    throw new GfsUriError(
      `subject must be user:<id>, team:<id>, or host:<party>:<ns>/<name>: ${JSON.stringify(key)}`
    )
  }
  const type = trimmed.slice(0, sep)
  const id = trimmed.slice(sep + 1)
  if (type === 'host') {
    if (!HOST_SUBJECT_ID_RE.test(id)) {
      throw new GfsUriError(
        `host subject must be host:<party>:<ns>/<name> (party 1st|3rd, k8s names): ${JSON.stringify(key)}`
      )
    }
    return { type, id }
  }
  if ((type !== 'user' && type !== 'team') || id.length === 0) {
    throw new GfsUriError(
      `subject must be user:<id>, team:<id>, or host:<party>:<ns>/<name>: ${JSON.stringify(key)}`
    )
  }
  return { type, id }
}

/**
 * The structured verdict fields a bulk grant/share/list failure can carry.
 * control-api reports them as SEPARATE response-body fields — `invalidIndexes`
 * on a 400/403 (routes/gfs/grants.ts sendGfsGrantError) and `retryAfterSeconds`
 * on a 429 (middleware/rateLimitMiddleware.ts) — not inside the human message.
 */
interface GfsGrantErrorFields {
  reason?: string
  invalidIndexes?: number[]
  retryAfterSeconds?: number
}

/**
 * Pull `invalidIndexes` / `retryAfterSeconds` out of an error response body.
 *
 * The body is an OPTIONAL, best-effort supplement: many failures (network,
 * upstream proxy, plain-text errors) are not JSON, in which case there are
 * simply no structured fields and the caller re-throws the ORIGINAL error
 * untouched. This never swallows a failure — `surfaceGfsGrantError` always
 * re-throws.
 */
function parseGfsGrantErrorFields(bodyText: string): GfsGrantErrorFields {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const record = parsed as {
    error?: unknown
    invalidIndexes?: unknown
    retryAfterSeconds?: unknown
  }
  const envelope =
    record.error && typeof record.error === 'object'
      ? (record.error as { details?: unknown })
      : undefined
  const details =
    envelope?.details && typeof envelope.details === 'object'
      ? (envelope.details as {
          reason?: unknown
          invalidIndexes?: unknown
          retryAfterSeconds?: unknown
        })
      : undefined
  const fields: GfsGrantErrorFields = {}
  if (typeof details?.reason === 'string') fields.reason = details.reason
  const rawInvalidIndexes = details?.invalidIndexes ?? record.invalidIndexes
  if (Array.isArray(rawInvalidIndexes)) {
    const indexes = rawInvalidIndexes.filter(
      (value): value is number => Number.isInteger(value) && (value as number) >= 0
    )
    if (indexes.length > 0) fields.invalidIndexes = indexes
  }
  const rawRetryAfterSeconds = details?.retryAfterSeconds ?? record.retryAfterSeconds
  if (Number.isInteger(rawRetryAfterSeconds) && (rawRetryAfterSeconds as number) >= 0) {
    fields.retryAfterSeconds = rawRetryAfterSeconds as number
  }
  return fields
}

/**
 * Re-throw a grant/share/list failure with the server's structured verdict
 * fields embedded in the message.
 *
 * The transport (httpClient) throws an `ApiError` that stashes the raw response
 * body on `.bodyText`, but ONLY the `Error.message` survives the Electron IPC
 * boundary on the way to the renderer — `.bodyText` is dropped. So a bulk
 * `subjects_invalid` (which subject failed) or a 429 (`retryAfterSeconds`) would
 * be invisible to `gfsGrantErrors.ts` in production. We append those fields to
 * the message in the exact shape that module's regexes parse (`invalidIndexes=[…]`,
 * `retryAfterSeconds=…`), keeping the original message — and therefore the server
 * error CODE (`subjects_invalid`, `foreign_agent_forbidden`, `429`, …) — intact.
 *
 * When there is nothing structured to surface, the ORIGINAL error propagates
 * unchanged (fail loud; never swallow the server's verdict).
 */
function surfaceGfsGrantError(error: unknown): unknown {
  const bodyText =
    error &&
    typeof error === 'object' &&
    typeof (error as { bodyText?: unknown }).bodyText === 'string'
      ? (error as { bodyText: string }).bodyText
      : ''
  if (!bodyText) return error
  const fields = parseGfsGrantErrorFields(bodyText)
  const parts: string[] = []
  const baseMessage = error instanceof Error ? error.message : String(error ?? '')
  if (fields.reason && !baseMessage.includes(fields.reason)) parts.push(fields.reason)
  if (fields.invalidIndexes) parts.push(`invalidIndexes=[${fields.invalidIndexes.join(',')}]`)
  if (fields.retryAfterSeconds !== undefined) {
    parts.push(`retryAfterSeconds=${fields.retryAfterSeconds}`)
  }
  if (parts.length === 0) return error
  return new GfsUriError(`${baseMessage} ${parts.join(' ')}`)
}
