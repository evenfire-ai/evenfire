/**
 * Producer-derived answers of `window.clerum.gfs.resolveForNavigation` for
 * renderer tests.
 *
 * Two real producers stand behind each answer:
 *
 * - the resource view is gfs-controller's own `toView` (`api/read.ts`), run on a
 *   stored-resource record, so `resourceId` is the UUID, `rid` its 32-hex form
 *   and `gfsUri` the rid URI, exactly as the server projects them;
 * - the envelope is `AppService.resolveGfsUriForNavigation` with the real
 *   `GfsClient` underneath, and the result crosses a `structuredClone` like the
 *   IPC boundary.
 *
 * Only the record fed to `toView` and the HTTP transport are written here; the
 * transport is the seam `GfsClient` was built to be injected with.
 */
import type {
  GfsResourceView,
  GfsTransport,
  ResolvedGfsResource,
} from '../../../../src/gfs/uriHandler'

export type NavigationResolution = Awaited<
  ReturnType<Window['clerum']['gfs']['resolveForNavigation']>
>

/** The stored-resource fields gfs-controller's `toView` projects. */
export type GfscResourceRecord = {
  resourceId: string
  name: string
  version: number
  bytes: number
  kind?: 'file' | 'directory'
  drive?: string
  parentResourceId?: string | null
  pathCache?: string | null
}

/*
 * The real `toView`, loaded at runtime. A static import would put
 * gfs-controller's sources under the renderer's stricter typecheck
 * (`noUncheckedIndexedAccess`), which they were not written for.
 *
 * `read.ts` and everything it imports must stay free of npm dependencies: the
 * Desktop CI job installs only desktop-app's `node_modules`, so a package
 * imported there would not resolve here.
 *
 * Vite rewrites `new URL(…, import.meta.url)` to its dev-server URL; Node's
 * loader refuses the `http:` `href`, while the `/@fs/…` pathname is a specifier
 * Vite serves itself (the repository root is in `server.fs.allow`).
 */
const GFSC_READ_MODULE = new URL('../../../../../gfs-controller/src/api/read.ts', import.meta.url)
  .pathname

// Desktop's own declaration of the `toView` result, kept in step with the server.
type ToView = (resource: Record<string, unknown>) => GfsResourceView

let toViewPromise: Promise<ToView> | null = null

async function gfscToView(): Promise<ToView> {
  toViewPromise ??= import(/* @vite-ignore */ GFSC_READ_MODULE).then(module => {
    const toView = (module as { toView?: unknown }).toView
    if (typeof toView !== 'function') throw new Error('gfs-controller no longer exports toView')
    return toView as ToView
  })
  return toViewPromise
}

/** gfs-controller's public view of a stored resource. */
export async function gfscResourceView(record: GfscResourceRecord): Promise<GfsResourceView> {
  const toView = await gfscToView()
  return toView({
    resourceId: record.resourceId,
    drive: record.drive ?? 'main',
    parentResourceId: record.parentResourceId ?? null,
    name: record.name,
    kind: record.kind ?? 'file',
    pathCache: record.pathCache ?? `/${record.name}`,
    version: record.version,
    bytes: record.bytes,
    blobKey: null,
    contentSha256: null,
    deletedAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
}

type NavigationProducer = {
  sessionToken: string | null
  me: { id: string; teamId: string | null } | null
  gfsDispatchBlocked: boolean
  gfsClient: unknown
  resolveGfsUriForNavigation: (uri: string) => Promise<NavigationResolution>
}

async function navigationProducer(
  transport: Pick<GfsTransport, 'requestJson'>,
  signedIn: boolean
): Promise<NavigationProducer> {
  const [{ AppService }, { GfsClient }] = await Promise.all([
    import('../../../../src/appService'),
    import('../../../../src/gfs/uriHandler'),
  ])
  const service = new AppService() as unknown as NavigationProducer
  service.sessionToken = signedIn ? 'fixture-session-token' : null
  service.me = signedIn ? { id: 'user-1', teamId: null } : null
  service.gfsDispatchBlocked = false
  service.gfsClient = new GfsClient({
    baseUrl: 'https://gfs.fixture.test',
    requestJson: transport.requestJson,
    fetchBytes: async () => new ArrayBuffer(0),
  })
  return service
}

/** The navigation answer when gfs-controller returns `view` for `uri`. */
export async function resolvedNavigation(
  view: ResolvedGfsResource,
  uri: string = view.gfsUri
): Promise<NavigationResolution> {
  const service = await navigationProducer(
    { requestJson: async () => ({ ok: true, data: view }) as never },
    true
  )
  return structuredClone(await service.resolveGfsUriForNavigation(uri))
}

/** The navigation answer when the resolve request fails (429, 5xx, network). */
export async function unavailableNavigation(uri: string): Promise<NavigationResolution> {
  const service = await navigationProducer(
    {
      requestJson: async () => {
        throw new Error('503 Service Unavailable')
      },
    },
    true
  )
  const warn = console.warn
  console.warn = () => undefined
  try {
    return structuredClone(await service.resolveGfsUriForNavigation(uri))
  } finally {
    console.warn = warn
  }
}

/** The navigation answer when the session the request belonged to is gone. */
export async function supersededNavigation(uri: string): Promise<NavigationResolution> {
  const service = await navigationProducer(
    {
      requestJson: async () => {
        throw new Error('no request expected without a session')
      },
    },
    false
  )
  return structuredClone(await service.resolveGfsUriForNavigation(uri))
}
