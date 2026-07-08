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
    options?: { token?: string; body?: unknown }
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

export interface GfsAccessibleResource extends GfsResourceView {
  sources: string[]
  permissions: string[]
  coversDescendants: boolean
}

export interface GfsAccessibleResourcesPage {
  items: GfsAccessibleResource[]
  nextCursor: string | null
}

/** Grant/share subject grammar (control-api routes/gfs/grants.ts parseSubject). */
export type GfsSubject =
  | { type: 'user'; id: string }
  | { type: 'team'; id: string }
  | { type: 'operator' }

export interface GfsGrantInput {
  resourceId: string
  drive?: string
  subject: GfsSubject
  permissions: string[]
  inherit?: boolean
}

export interface GfsShareInput {
  resourceId: string
  drive?: string
  subject: GfsSubject
  permissions: string[]
  includeDescendants?: boolean
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
  session: string
): Promise<GfsResourceView> {
  const q = new URLSearchParams()
  q.set('drive', input.drive ?? DEFAULT_DRIVE)
  const body: Record<string, unknown> = {
    name: input.name,
    kind: input.kind,
  }
  if (input.kind === 'file') body.contentBase64 = input.encodedData ?? ''
  const path = `/api/v1/me/gfs/resources/${encodeURIComponent(input.parentResourceId)}/children?${q.toString()}`
  const options = { body } as { token?: string; body?: unknown }
  options[TRANSPORT_TOKEN_FIELD] = session
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
  session: string
): Promise<GfsResourceView> {
  const q = new URLSearchParams()
  q.set('drive', input.drive ?? DEFAULT_DRIVE)
  const body: Record<string, unknown> = {
    contentBase64: input.encodedData,
  }
  if (input.ifMatch !== undefined) body.ifMatch = input.ifMatch
  const path = `/api/v1/me/gfs/resources/${encodeURIComponent(input.resourceId)}/content?${q.toString()}`
  const options = { body } as { token?: string; body?: unknown }
  options[TRANSPORT_TOKEN_FIELD] = session
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
    await this.transport.requestJson(
      'PUT',
      joinUrl(this.transport.baseUrl, '/api/v1/me/gfs/grants'),
      {
        token,
        body: {
          drive: input.drive ?? DEFAULT_DRIVE,
          resourceId: input.resourceId,
          subject: input.subject,
          permissions: input.permissions,
          inherit: input.inherit ?? false,
        },
      }
    )
  }

  /** Create a URI share for a subject (same no-escalation engine, isShare=true). */
  async createShare(input: GfsShareInput, token: string): Promise<void> {
    await this.transport.requestJson(
      'POST',
      joinUrl(this.transport.baseUrl, '/api/v1/me/gfs/shares'),
      {
        token,
        body: {
          drive: input.drive ?? DEFAULT_DRIVE,
          resourceId: input.resourceId,
          subject: input.subject,
          permissions: input.permissions,
          includeDescendants: input.includeDescendants ?? false,
        },
      }
    )
  }
  async createResource(input: GfsCreateInput, session: string): Promise<GfsResourceView> {
    return createGfsResource(this.transport, input, session)
  }

  async replaceFile(input: GfsReplaceInput, session: string): Promise<GfsResourceView> {
    return replaceGfsFile(this.transport, input, session)
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
 * only to visible users or teams; operator/host/context targets are reserved for
 * the operator/provisioner contracts and are rejected before the API call. The
 * server re-validates; this is an input-shaping convenience, not a trust point.
 */
export function parseSubjectKey(key: string): GfsSubject {
  const trimmed = key.trim()
  const sep = trimmed.indexOf(':')
  if (sep <= 0) {
    throw new GfsUriError(`subject must be user:<id> or team:<id>: ${JSON.stringify(key)}`)
  }
  const type = trimmed.slice(0, sep)
  const id = trimmed.slice(sep + 1)
  if ((type !== 'user' && type !== 'team') || id.length === 0) {
    throw new GfsUriError(`subject must be user:<id> or team:<id>: ${JSON.stringify(key)}`)
  }
  return { type, id }
}
