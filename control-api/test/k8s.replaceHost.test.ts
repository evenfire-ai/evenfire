import { describe, expect, it, vi } from 'vitest'
import { K8sGateway } from '../src/k8s.js'

// NIT-1 (@claude PR #735 re-review): K8sGateway.replaceHost is a second,
// hand-rolled Host-replace path used only by the personalization PUT route.
// Before this fix it forwarded the caller's annotations map verbatim, so it was
// only SAFE by accident of the route's ALLOWED_PUT_KEYS excluding `annotations`.
// The AP-6 invariant (platform-owned clerum.io/* projections survive an admin
// replace) is now enforced AT THE CHOKE POINT: replaceHost reads the current
// server object and routes annotations through mergeAnnotationsForReplace, so a
// future annotations-bearing caller cannot silently drop the wake projection.

const WAKE = 'clerum.io/wake-requested'

function makeGateway(current: { metadata?: { annotations?: Record<string, string> } }) {
  const getNamespacedCustomObject = vi.fn().mockResolvedValue(current)
  const replaceNamespacedCustomObject = vi
    .fn()
    .mockResolvedValue({ metadata: { resourceVersion: '12' } })
  const customApi = { getNamespacedCustomObject, replaceNamespacedCustomObject }

  const gateway = Object.create(K8sGateway.prototype) as K8sGateway
  Object.defineProperty(gateway, 'customApi', { value: customApi })
  return { gateway, getNamespacedCustomObject, replaceNamespacedCustomObject }
}

function replacedAnnotations(replaceMock: ReturnType<typeof vi.fn>) {
  return replaceMock.mock.calls[0][0].body.metadata.annotations as
    | Record<string, string>
    | undefined
}

describe('K8sGateway.replaceHost — AP-6 platform annotation invariant', () => {
  it('preserves clerum.io/wake-requested on the current object even when the caller sends an annotations map that omits it', async () => {
    const { gateway, getNamespacedCustomObject, replaceNamespacedCustomObject } = makeGateway({
      metadata: { annotations: { [WAKE]: '7', team: 'blue' } },
    })

    await gateway.replaceHost({
      metadata: {
        // Caller sends a writable-annotations map that drops the platform key —
        // the future-caller scenario the nit guards against.
        annotations: { notes: 'hello' },
        labels: { 'app.kubernetes.io/managed-by': 'Helm' },
        name: 'foo',
        namespace: 'mcp-host',
        resourceVersion: '10',
      },
      spec: { contextRef: 'edited' },
    })

    // The current server object is read to harvest platform annotations.
    expect(getNamespacedCustomObject).toHaveBeenCalledTimes(1)
    // Caller-owned keys keep replace semantics (only `notes` survives from the
    // incoming map), but the platform-owned clerum.io/wake-requested is re-added.
    expect(replacedAnnotations(replaceNamespacedCustomObject)).toEqual({
      notes: 'hello',
      [WAKE]: '7',
    })
  })

  it("uses the caller's resourceVersion as the optimistic-concurrency precondition (internal read harvests annotations only)", async () => {
    const { gateway, replaceNamespacedCustomObject } = makeGateway({
      metadata: { annotations: { [WAKE]: '7' } },
    })

    await gateway.replaceHost({
      metadata: { name: 'foo', namespace: 'mcp-host', resourceVersion: '10' },
      spec: { contextRef: 'x' },
    })

    // Personalization's existing behavior is unchanged: the precondition is the
    // caller-supplied resourceVersion, not anything harvested from the read.
    expect(replaceNamespacedCustomObject.mock.calls[0][0].body.metadata.resourceVersion).toBe('10')
  })

  it('lets the caller win when it explicitly sets the exact platform key', async () => {
    const { gateway, replaceNamespacedCustomObject } = makeGateway({
      metadata: { annotations: { [WAKE]: '7' } },
    })

    await gateway.replaceHost({
      metadata: {
        annotations: { [WAKE]: '9' },
        name: 'foo',
        namespace: 'mcp-host',
        resourceVersion: '10',
      },
      spec: {},
    })

    expect(replacedAnnotations(replaceNamespacedCustomObject)).toEqual({ [WAKE]: '9' })
  })

  it('mirrors personalization: an undefined annotations map preserves the whole current map (route behavior unchanged)', async () => {
    // The personalization route reads the host and forwards its annotations
    // verbatim; when a host carries no platform key and the caller passes the
    // current map, the replaced map is identical — nothing changes for it today.
    const { gateway, replaceNamespacedCustomObject } = makeGateway({
      metadata: { annotations: { 'meta.helm.sh/release-name': 'clerum' } },
    })

    await gateway.replaceHost({
      metadata: { name: 'foo', namespace: 'mcp-host', resourceVersion: '10' },
      spec: {},
    })

    // No annotations map supplied → the current map survives verbatim (legacy).
    expect(replacedAnnotations(replaceNamespacedCustomObject)).toEqual({
      'meta.helm.sh/release-name': 'clerum',
    })
  })
})
