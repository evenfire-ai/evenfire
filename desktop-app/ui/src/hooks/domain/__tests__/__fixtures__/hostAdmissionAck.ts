/**
 * The ack mcp-host answers a desktop send with, produced by mcp-host's own
 * admission (`createIncomingAdmission`) on the request the composer really
 * sent. Its GFS double answers `resolve` with gfs-controller's own envelope
 * (`ok(toView(record))`), so the folder is resolved exactly as the Host would.
 *
 * Only the queue's answer (`dispatch`) is written here: the field under test,
 * `acceptedLocationReferenceIds`, is added by the admission around it.
 */
import type { GfsResourceView } from '../../../../../../src/gfs/uriHandler'

/*
 * Loaded at runtime, as the navigation fixtures load gfs-controller: a static
 * import would put mcp-host's sources under the renderer's stricter typecheck.
 * Vite serves the `/@fs/…` pathname itself (the repository root is allowed).
 */
const ADMISSION_MODULE = new URL(
  '../../../../../../../mcp-host/src/agent/incomingAdmission.ts',
  import.meta.url
).pathname
const ENVELOPE_MODULE = new URL(
  '../../../../../../../gfs-controller/src/api/envelope.ts',
  import.meta.url
).pathname

type HostAck = Record<string, unknown>
type Admit = (message: Record<string, unknown>, options?: { async?: boolean }) => Promise<HostAck>
type AdmissionModule = { createIncomingAdmission: (deps: Record<string, unknown>) => Admit }
type EnvelopeModule = { ok: (data: unknown) => unknown }

/** What the Host's queue answers once the message is admitted. */
export type HostDispatch =
  | { success: true; taskId: string; status: 'pending' }
  | { success: true; response: string }

async function loadProducers(): Promise<[AdmissionModule, EnvelopeModule]> {
  const [admission, envelope] = await Promise.all([
    import(/* @vite-ignore */ ADMISSION_MODULE),
    import(/* @vite-ignore */ ENVELOPE_MODULE),
  ])
  return [admission as AdmissionModule, envelope as EnvelopeModule]
}

/**
 * Admits `request` (as the composer posted it) the way mcp-host does, with gfsc
 * knowing `resources` by URI, and returns the Host's ack.
 */
export async function hostAdmissionAck(
  request: Record<string, unknown>,
  resources: GfsResourceView[],
  dispatch: HostDispatch,
  options: { async?: boolean; gfscTimesOut?: boolean } = {}
): Promise<HostAck> {
  // The admission stores a carried approval mode in its conversation store,
  // which this double does not model: without one the Host refuses the send,
  // so such an ack would be a refusal no real Host gives.
  if (request.approvalMode !== undefined) {
    throw new Error('hostAdmissionAck: a request carrying approvalMode is not modelled')
  }
  const [{ createIncomingAdmission }, { ok }] = await loadProducers()
  const byUri = new Map(resources.map(resource => [resource.gfsUri, resource]))
  const admit = createIncomingAdmission({
    limits: { maxCount: 4, maxBytes: 1_000_000, maxFileBytes: 1_000_000 },
    queueReady: () => true,
    degradedReason: () => null,
    hostProvider: () => 'zai',
    getConversationByKey: async () => undefined,
    resolveTaskModel: () => null,
    resolveImageInput: () => undefined,
    applySessionModelSelection: async () => ({ ok: true }),
    dispatch: () => dispatch,
    fileReferenceGfs: () => ({
      status: 'available',
      client: {
        resolve: async ({ uri }: { uri: string }) => {
          // What a gfsc call cut by `AbortSignal.timeout` rejects with; the
          // Host's own check classifies it and words the refusal.
          if (options.gfscTimesOut) {
            throw Object.assign(new Error('gfsc did not answer in time'), { name: 'TimeoutError' })
          }
          const resource = byUri.get(uri)
          if (!resource) throw new Error(`gfsc double: no resource at ${uri}`)
          return ok(resource)
        },
      },
    }),
    logger: { info: () => undefined, warn: () => undefined },
    approvalSnapshot: () => ({ effective: undefined, hostSpec: undefined }),
  })
  return admit(
    {
      ...request,
      sender: 'user-1',
      timestamp: '2026-11-21T10:00:00Z',
      messageId: 'msg-1',
      hostRef: String(request.channelId),
    },
    { async: options.async }
  )
}
