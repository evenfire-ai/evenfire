import { describe, expect, it } from 'vitest'
import { RecipeEventQueue } from './recipeEventQueue'

describe('RecipeEventQueue', () => {
  it('serializes events for the same recipe key', async () => {
    const queue = new RecipeEventQueue()
    const events: string[] = []
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve
    })
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })

    queue.enqueue('recipe-a', async () => {
      events.push('first:start')
      markFirstStarted()
      await firstGate
      events.push('first:end')
    })
    queue.enqueue('recipe-a', async () => {
      events.push('second')
    })

    await firstStarted
    expect(events).toEqual(['first:start'])

    releaseFirst()
    await queue.drain('recipe-a')

    expect(events).toEqual(['first:start', 'first:end', 'second'])
  })

  it('allows different recipe keys to proceed independently', async () => {
    const queue = new RecipeEventQueue()
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve
    })

    queue.enqueue('recipe-a', async () => {
      events.push('a:start')
      await firstGate
      events.push('a:end')
    })
    queue.enqueue('recipe-b', async () => {
      events.push('b')
    })

    await queue.drain('recipe-b')
    expect(events).toEqual(['a:start', 'b'])

    releaseFirst()
    await queue.drain('recipe-a')
    expect(events).toEqual(['a:start', 'b', 'a:end'])
  })

  it('continues later events after a failed event', async () => {
    const errors: Array<{ key: string; message: string }> = []
    const queue = new RecipeEventQueue((key, error) => {
      errors.push({ key, message: error instanceof Error ? error.message : String(error) })
    })
    const events: string[] = []

    queue.enqueue('recipe-a', async () => {
      throw new Error('boom')
    })
    queue.enqueue('recipe-a', async () => {
      events.push('after')
    })

    await queue.drain('recipe-a')

    expect(errors).toEqual([{ key: 'recipe-a', message: 'boom' }])
    expect(events).toEqual(['after'])
  })
})
