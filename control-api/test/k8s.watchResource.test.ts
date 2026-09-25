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
  it('does not start a watch for an already-aborted request', async () => {
    mocks.watch.mockImplementation(() => new Promise(() => undefined))
    const gateway = Object.create(K8sGateway.prototype) as K8sGateway
    Object.defineProperties(gateway, {
      resources: {
        value: { assertNamespaceAllowed: vi.fn() },
      },
      kc: { value: {} },
    })
    const controller = new AbortController()
    controller.abort()

    await expect(
      Promise.race([
        gateway.watchResource('hosts', 'mcp-host', '42', controller.signal, vi.fn()),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('watch did not settle')), 250)
        ),
      ])
    ).resolves.toBeUndefined()
    expect(mocks.watch).not.toHaveBeenCalled()
  })

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

  it('aborts instead of accumulating an unbounded watch-event backlog', async () => {
    const controller = { abort: vi.fn() }
    let releaseFirstEvent: (() => void) | undefined
    const firstEventBlocked = new Promise<void>(resolve => {
      releaseFirstEvent = resolve
    })
    mocks.watch.mockImplementation(
      async (
        _path: string,
        _options: unknown,
        onEvent: (phase: string, object: unknown) => void
      ) => {
        onEvent('ADDED', { metadata: { name: 'host-0' } })
        await Promise.resolve()
        for (let index = 1; index <= 3; index += 1) {
          onEvent('ADDED', { metadata: { name: `host-${index}` } })
        }
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
      async () => firstEventBlocked,
      { maxPendingEvents: 3, maxPendingBytes: 1_024, maxObjectBytes: 512 }
    )

    await vi.waitFor(() => expect(controller.abort).toHaveBeenCalledOnce(), { timeout: 250 })
    releaseFirstEvent?.()
    await expect(work).rejects.toThrow('watch event budget exceeded')
  })
})
