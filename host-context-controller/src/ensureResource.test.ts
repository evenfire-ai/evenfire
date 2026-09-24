import { describe, expect, it, vi } from 'vitest'
import { ensureResource, replaceWithConflictRetry } from './utils'

const resource = (rv = '1') => ({
  kind: 'NetworkPolicy',
  metadata: { name: 'observed-policy', resourceVersion: rv },
})

describe('ensureResource', () => {
  it('does not count a resource that disappears during presence-path convergence', async () => {
    const read = vi.fn().mockResolvedValueOnce(resource()).mockRejectedValueOnce({ code: 404 })
    const create = vi.fn()
    const replace = vi.fn().mockRejectedValue({ code: 409 })
    const onSkipped = vi.fn()
    await ensureResource({
      read,
      create,
      onSkipped,
      converge: readOnce =>
        replaceWithConflictRetry({
          description: 'policy',
          logPrefix: '[Test]',
          body: resource(),
          read: readOnce,
          replace,
        }),
    })
    expect(read).toHaveBeenCalledTimes(2)
    expect(replace).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
    expect(onSkipped).not.toHaveBeenCalled()
  })

  it.each([{ code: 404 }, { response: { statusCode: 404 } }])(
    'creates only after an actual absence read (%j)',
    async absent => {
      const events: string[] = []
      const read = vi.fn(async () => {
        events.push('GET')
        throw absent
      })
      const create = vi.fn(async () => {
        events.push('POST')
        return resource()
      })
      const converge = vi.fn()
      const onSkipped = vi.fn()
      await ensureResource({ read, create, converge, onSkipped })
      expect(events).toEqual(['GET', 'POST'])
      expect(create).toHaveBeenCalledTimes(1)
      expect(converge).not.toHaveBeenCalled()
      expect(onSkipped).not.toHaveBeenCalled()
    }
  )

  it('consumes an observed object once, then reads fresh on a replace conflict', async () => {
    const first = resource('1')
    const second = resource('2')
    const read = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const create = vi.fn()
    const replace = vi.fn().mockRejectedValueOnce({ code: 409 }).mockResolvedValue(undefined)
    const onSkipped = vi.fn()
    const validated: unknown[] = []
    await ensureResource({
      read,
      create,
      onSkipped,
      converge: observedRead =>
        replaceWithConflictRetry({
          description: 'policy',
          logPrefix: '[Test]',
          body: resource(),
          read: observedRead,
          replace,
          validateExisting: value => {
            validated.push(value)
          },
        }),
    })
    expect(read).toHaveBeenCalledTimes(2)
    expect(validated).toEqual([first, second])
    expect(replace.mock.calls.map(([body]) => body.metadata.resourceVersion)).toEqual(['1', '2'])
    expect(create).not.toHaveBeenCalled()
    expect(onSkipped).toHaveBeenCalledTimes(1)
  })

  it('uses a supplied snapshot without an API read or a create', async () => {
    const existing = resource()
    const read = vi.fn()
    const create = vi.fn()
    const onSkipped = vi.fn()
    const converge = vi.fn(async (readOnce, observed) => {
      expect(observed).toBe(existing)
      expect(await readOnce()).toBe(existing)
    })
    await ensureResource({ existing, read, create, converge, onSkipped })
    expect(converge).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(onSkipped).toHaveBeenCalledTimes(1)
  })

  it('discards observed absence after POST409 and retains the retry budget', async () => {
    const read = vi.fn().mockResolvedValueOnce(resource('2')).mockResolvedValueOnce(resource('3'))
    const create = vi.fn().mockRejectedValue({ code: 409 })
    const lastConflict = { code: 409, message: 'conflict remains' }
    const replace = vi.fn().mockRejectedValue(lastConflict)
    const onSkipped = vi.fn()
    await expect(
      ensureResource({
        existing: null,
        read,
        create,
        onSkipped,
        converge: observedRead =>
          replaceWithConflictRetry({
            description: 'policy',
            logPrefix: '[Test]',
            body: resource(),
            read: observedRead,
            replace,
            maxAttempts: 2,
          }),
      })
    ).rejects.toBe(lastConflict)
    expect(create).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(2)
    expect(replace.mock.calls.map(([body]) => body.metadata.resourceVersion)).toEqual(['2', '3'])
    expect(onSkipped).not.toHaveBeenCalled()
  })

  it.each([403, 500, undefined])('propagates initial read failures (%s)', async code => {
    const error = { code, message: 'read failed' }
    const read = vi.fn().mockRejectedValue(error)
    const create = vi.fn()
    const converge = vi.fn()
    const onSkipped = vi.fn()
    await expect(ensureResource({ read, create, converge, onSkipped })).rejects.toBe(error)
    expect(read).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
    expect(converge).not.toHaveBeenCalled()
    expect(onSkipped).not.toHaveBeenCalled()
  })

  it.each([undefined, null, {}, { metadata: {} }, { metadata: { name: '' } }])(
    'rejects a resolved invalid read without interpreting it as absence (%j)',
    async value => {
      const read = vi.fn().mockResolvedValue(value)
      const create = vi.fn()
      const onSkipped = vi.fn()
      await expect(ensureResource({ read, create, converge: vi.fn(), onSkipped })).rejects.toThrow(
        'metadata.name'
      )
      expect(read).toHaveBeenCalledTimes(1)
      expect(create).not.toHaveBeenCalled()
      expect(onSkipped).not.toHaveBeenCalled()
    }
  )

  it('rechecks the fence after a GET404 and never counts cancellation as a skip', async () => {
    let current = true
    const read = vi.fn(async () => {
      current = false
      throw { code: 404 }
    })
    const create = vi.fn()
    const onSkipped = vi.fn()
    await ensureResource({
      read,
      create,
      converge: vi.fn(),
      onSkipped,
      mutationAllowed: () => current,
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(create).not.toHaveBeenCalled()
    expect(onSkipped).not.toHaveBeenCalled()
  })

  it('retains the initial fence, with a live allowed invocation as control', async () => {
    const read = vi.fn().mockResolvedValue(resource())
    const create = vi.fn()
    const converge = vi.fn().mockResolvedValue(undefined)
    const onSkipped = vi.fn()
    await ensureResource({ read, create, converge, onSkipped, mutationAllowed: () => false })
    expect(read).not.toHaveBeenCalled()
    await ensureResource({ read, create, converge, onSkipped, mutationAllowed: () => true })
    expect(read).toHaveBeenCalledTimes(1)
    expect(converge).toHaveBeenCalledTimes(1)
    expect(onSkipped).toHaveBeenCalledTimes(1)
  })

  it('keeps missingIsError scoped to disappearance during convergence', async () => {
    const read = vi.fn().mockRejectedValue({ code: 404 })
    const create = vi.fn().mockRejectedValue({ code: 409 })
    const replace = vi.fn()
    const onSkipped = vi.fn()
    const converge =
      (missingIsError: boolean) => (readFresh: () => Promise<ReturnType<typeof resource>>) =>
        replaceWithConflictRetry({
          description: 'policy',
          logPrefix: '[Test]',
          body: resource(),
          read: readFresh,
          replace,
          missingIsError,
        })
    await ensureResource({ read, create, converge: converge(false), onSkipped })
    await expect(
      ensureResource({ read, create, converge: converge(true), onSkipped })
    ).rejects.toEqual({ code: 404 })
    expect(create).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(4)
    expect(replace).not.toHaveBeenCalled()
    expect(onSkipped).not.toHaveBeenCalled()
  })

  it('does not count a rejected ownership check or retained failure as skipped', async () => {
    const read = vi.fn().mockResolvedValue(resource())
    const create = vi.fn()
    const onSkipped = vi.fn()
    const error = new Error('foreign ownership')
    const converge = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(false)
    await expect(ensureResource({ read, create, converge, onSkipped })).rejects.toBe(error)
    await ensureResource({ read, create, converge, onSkipped })
    expect(converge).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(2)
    expect(create).not.toHaveBeenCalled()
    expect(onSkipped).not.toHaveBeenCalled()
  })

  it('does not count convergence cancelled during async body reconstruction', async () => {
    let current = true
    const read = vi.fn().mockResolvedValue(resource())
    const replace = vi.fn()
    const create = vi.fn()
    const onSkipped = vi.fn()
    await ensureResource({
      read,
      create,
      onSkipped,
      mutationAllowed: () => current,
      converge: readOnce =>
        replaceWithConflictRetry({
          description: 'policy',
          logPrefix: '[Test]',
          body: resource(),
          read: readOnce,
          replace,
          resolveBody: async () => {
            current = false
            return resource()
          },
          mutationAllowed: () => current,
        }),
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(onSkipped).not.toHaveBeenCalled()
  })
})
