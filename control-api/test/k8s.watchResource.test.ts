import { describe, expect, it, vi } from 'vitest'
import { K8sGateway } from '../src/k8s.js'

const mocks = vi.hoisted(() => ({
  watch: vi.fn(),
}))

vi.mock('@kubernetes/client-node', async importOriginal => {
  const actual = await importOriginal<typeof import('@kubernetes/client-node')>()
  return {
    ...actual,
    Watch: class {
      watch = mocks.watch
    },
  }
})

describe('K8sGateway.watchResource', () => {
  it('rejects and aborts when an event handler fails before the controller resolves', async () => {
    const controller = { abort: vi.fn() }
    const handlerError = new Error('handler failed')
    mocks.watch.mockImplementation(
      async (
        _path: string,
        _options: unknown,
        onEvent: (phase: string, object: unknown) => void
      ) => {
        onEvent('ADDED', { metadata: { name: 'host-a' } })
        await Promise.resolve()
        return controller
      }
    )

    const gateway = Object.create(K8sGateway.prototype) as K8sGateway
    Object.defineProperties(gateway, {
      resources: {
        value: { assertNamespaceAllowed: vi.fn() },
      },
      kc: { value: {} },
    })

    const work = gateway.watchResource(
      'hosts',
      'mcp-host',
      '42',
      new AbortController().signal,
      async () => {
        throw handlerError
      }
    )

    await expect(
      Promise.race([
        work,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('watch did not settle')), 250)
        ),
      ])
    ).rejects.toBe(handlerError)
    expect(controller.abort).toHaveBeenCalledOnce()
  })
})
