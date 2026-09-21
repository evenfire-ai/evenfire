/**
 * Producer-backed GFS wire fixtures for renderer tests (pr-discipline T1).
 *
 * The renderer consumes `window.clerum.gfs.{listChildren,listAccessible,download}`.
 * That bridge is a pure pass-through: preload → `ipc.ts` handler →
 * `AppService.list*` → `GfsClient.*`. The ONLY shape transform along the way is
 * `GfsClient`'s envelope `unwrap`, and the ONLY serialization is Electron's
 * structured clone across the IPC boundary. So the truthful in-process producer
 * of the shape the tree/preview renders is `GfsClient` (desktop-app/src), not the
 * renderer `.d.ts`.
 *
 * A hand-written fixture typed against `window.clerum.gfs.*` (the `.d.ts`) proves
 * nothing: the `.d.ts` is a hand-maintained mirror, so a producer-contract change
 * (a renamed/dropped field, a change to `unwrap`) or an IPC-serialization change
 * would break production while such a test stayed green. These builders instead
 * run the caller-supplied resource views THROUGH the real `GfsClient` against its
 * designed transport seam ("Inject the API transport so the client is testable
 * without a real backend" — uriHandler.ts) and then through `structuredClone` to
 * model the IPC boundary. The output IS what the renderer receives in production.
 *
 * The inputs are typed as `GfsChildView` / `GfsAccessibleResource` /
 * `ResolvedGfsResource` — desktop-app's OWN declaration of the gfs-controller
 * `toView` contract (kept in lockstep with the server by those interfaces). We
 * cannot call gfs-controller (a separate service/repo) from here, so that HTTP
 * shape is asserted by those types, not by a live round-trip; the transport is
 * the honest boundary between this repo's producer and that service. Everything
 * below the transport is the real producer.
 *
 * The list* return types are the renderer boundary types
 * (`Awaited<ReturnType<typeof window.clerum.gfs.*>>`), so if the producer's
 * emitted page and the renderer `.d.ts` ever drift, this module fails to
 * typecheck — the compile-time half of the same guarantee. (download is bound to
 * the producer's own output instead; see the note on `DownloadResult` below.)
 *
 * H8 (fail-closed tests) reuses these builders — do not inline gfs wire shapes
 * in a new tree/preview test.
 */
import {
  type GfsAccessibleResource,
  type GfsChildView,
  GfsClient,
  type GfsTransport,
  type ResolvedGfsResource,
} from '../../../../src/gfs/uriHandler.js'

// listChildren/listAccessible bind cleanly to the renderer boundary types (the
// `.d.ts` the tree consumes), so a drift between the producer's emitted page and
// the renderer contract fails this module's typecheck.
type ListChildrenPage = Awaited<ReturnType<typeof window.clerum.gfs.listChildren>>
type ListAccessiblePage = Awaited<ReturnType<typeof window.clerum.gfs.listAccessible>>
// download binds to the PRODUCER's own output, not the renderer `.d.ts`: the
// `.d.ts` declares `download.resource.pathCache` as required while the producer's
// `ResolvedGfsResource` leaves it optional, so the mirror overstates the contract
// (a pre-existing `.d.ts` inaccuracy, out of scope for this fixture change). The
// tree's download consumer (`saveGfsFileToDisk`) reads only `bytes`.
type DownloadResult = Awaited<ReturnType<GfsClient['download']>>

/** A one-shot transport standing in for the gfs-controller HTTP boundary. It
 *  returns the given enveloped body for the JSON request and the given bytes for
 *  a proxy fetch — the seam `GfsClient` was built to be injected with. */
function stubTransport(jsonBody: unknown, bytes: ArrayBuffer = new ArrayBuffer(0)): GfsTransport {
  return {
    baseUrl: 'https://gfs.fixture.test',
    requestJson: async () => jsonBody as never,
    fetchBytes: async () => bytes,
  }
}

const SESSION_TOKEN = 'fixture-session-token'

/** A `GfsChildView` — the gfs-controller `toView` child shape as desktop-app
 *  declares it. Flows through the real producer below; never consumed directly. */
export function childView(
  resourceId: string,
  name: string,
  kind: 'file' | 'directory',
  overrides: Partial<GfsChildView> = {}
): GfsChildView {
  return {
    resourceId,
    rid: resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    drive: 'main',
    parentResourceId: null,
    name,
    kind,
    path: `/${name}`,
    version: 1,
    bytes: 4,
    ...overrides,
  }
}

/** A `GfsAccessibleResource` — the "Shared with me" root-item shape. */
export function accessibleResource(
  resourceId: string,
  name: string,
  kind: 'file' | 'directory',
  overrides: Partial<GfsAccessibleResource> = {}
): GfsAccessibleResource {
  return {
    resourceId,
    rid: resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    drive: 'main',
    parentResourceId: null,
    name,
    kind,
    path: `/${name}`,
    version: 1,
    bytes: 4,
    ...overrides,
  }
}

/** Run child views through the real `GfsClient.listChildren` (envelope unwrap)
 *  and the IPC structured-clone boundary — the exact value the renderer's
 *  `window.clerum.gfs.listChildren` resolves to in production. */
export async function listChildrenPage(
  items: GfsChildView[],
  nextCursor: string | null = null
): Promise<ListChildrenPage> {
  const client = new GfsClient(stubTransport({ ok: true, data: { items, nextCursor } }))
  const page = await client.listChildren('fixture-parent', SESSION_TOKEN, { drive: 'main' })
  return structuredClone(page)
}

/** Run accessible resources through the real `GfsClient.listAccessible`. */
export async function listAccessiblePage(
  items: GfsAccessibleResource[],
  nextCursor: string | null = null
): Promise<ListAccessiblePage> {
  const client = new GfsClient(stubTransport({ ok: true, data: { items, nextCursor } }))
  const page = await client.listAccessible(SESSION_TOKEN, { drive: 'main' })
  return structuredClone(page)
}

/** Run a resolve + byte fetch through the real `GfsClient.download` — the
 *  `{ resource, bytes }` shape the download consumer (`saveGfsFileToDisk`)
 *  reads. `bytes` survives the structured-clone IPC boundary as an ArrayBuffer. */
export async function downloadResult(
  resource: ResolvedGfsResource,
  bytes: ArrayBuffer = new ArrayBuffer(4)
): Promise<DownloadResult> {
  const client = new GfsClient(stubTransport({ ok: true, data: resource }, bytes))
  const out = await client.download(resource.gfsUri, SESSION_TOKEN)
  return structuredClone(out)
}

// The `onOpenGfsResource` payload the plugin SDK pushes across the preload
// boundary — bound to the renderer `.d.ts` callback arg, so a drift between what
// the runtime emits and what the renderer expects fails this module's typecheck.
type OpenGfsResourcePayload = Parameters<
  Parameters<typeof window.clerum.pluginSdk.onOpenGfsResource>[0]
>[0]

/**
 * The `onOpenGfsResource` wire payload as `pluginSdkRuntime.openGfsResource`
 * emits it: it resolves the URI with the user's session (the real
 * `GfsClient.resolveUri` below — envelope unwrap, the same seam `download` uses)
 * and then projects four fields onto the wire. That runtime imports `electron`
 * at module load, so it cannot be driven from a jsdom renderer test (the awkward
 * case T1 anticipates); the resolve half runs through this repo's REAL producer
 * and the runtime's four-field projection is mirrored here in ONE place —
 * `bytes` is coerced to `null` when the resolved resource omits it, exactly as
 * the runtime does — then structured-cloned to model the IPC boundary.
 */
export async function openGfsResourcePayload(
  resource: ResolvedGfsResource
): Promise<OpenGfsResourcePayload> {
  const client = new GfsClient(stubTransport({ ok: true, data: resource }))
  const resolved = await client.resolveUri(resource.gfsUri, SESSION_TOKEN)
  return structuredClone({
    gfsUri: resolved.gfsUri ?? resource.gfsUri,
    name: resolved.name,
    kind: resolved.kind,
    bytes: typeof resolved.bytes === 'number' ? resolved.bytes : null,
  })
}

/** A `ResolvedGfsResource` for a downloadable file, for `downloadResult`. */
export function resolvedFile(
  resourceId: string,
  name: string,
  overrides: Partial<ResolvedGfsResource> = {}
): ResolvedGfsResource {
  return {
    resourceId,
    rid: resourceId,
    gfsUri: `gfs://main/${resourceId}`,
    drive: 'main',
    parentResourceId: null,
    name,
    kind: 'file',
    path: `/${name}`,
    version: 1,
    bytes: 4,
    ...overrides,
  }
}
