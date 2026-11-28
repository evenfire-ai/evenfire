// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useInlineRename } from '../useInlineRename'

afterEach(cleanup)

// Independent executable specification: an editor is an object with ownership,
// not the hook's sequence/ref implementation. Pending operations retain their
// editor object. Only the most recent user intent may restore that object.
async function runTrace(trace: string[]) {
  const model: {
    owner: object | null
    editor: { key: string; draft: string; baseline: string; identity: object } | null
  } = { owner: null, editor: null }
  const pending: Array<{
    editor: NonNullable<typeof model.editor>
    resolve: () => void
    reject: () => void
    settled: boolean
  }> = []
  const onRejected = vi.fn()
  const onRename = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        if (!model.editor) throw new Error('model committed without an editor')
        pending.push({
          editor: { ...model.editor },
          resolve,
          reject: () => reject(new Error('fixture rejected')),
          settled: false,
        })
      })
  )
  const hook = renderHook(() => useInlineRename({ onRename, onRejected }))
  for (let index = 0; index < trace.length; index++) {
    const command = trace[index]!
    await act(async () => {
      if (command === 'A' || command === 'B') {
        const identity = {}
        model.owner = identity
        model.editor = {
          key: command,
          baseline: `${command} baseline`,
          draft: `${command} baseline`,
          identity,
        }
        hook.result.current.start(command, model.editor.draft)
      } else if (command === 'edit') {
        if (!model.editor) return
        model.editor.draft = `draft ${index}`
        hook.result.current.onChange({ target: { value: model.editor.draft } })
      } else if (command === 'cancel') {
        model.owner = null
        model.editor = null
        hook.result.current.cancel()
      } else if (command === 'commit') {
        hook.result.current.commit()
        model.editor = null
      } else {
        const available = pending.filter(item => !item.settled)
        const operation = command.endsWith('last') ? available.at(-1) : available[0]
        if (!operation) return
        operation.settled = true
        if (command.startsWith('reject')) {
          operation.reject()
          if (model.owner === operation.editor.identity) model.editor = { ...operation.editor }
        } else operation.resolve()
      }
    })
    expect(hook.result.current.editingKey, trace.slice(0, index + 1).join(' → ')).toBe(
      model.editor?.key ?? null
    )
    if (model.editor) expect(hook.result.current.value).toBe(model.editor.draft)
  }
  // Settle remaining promises after invalidating the editor; none may reopen it.
  await act(async () => {
    hook.result.current.cancel()
  })
  await act(async () => {
    for (const operation of pending) if (!operation.settled) operation.reject()
  })
  expect(hook.result.current.editingKey).toBeNull()
  hook.unmount()
}

describe('inline rename ownership: independent state model', () => {
  it.each([
    ['older rejection while B is active', ['A', 'edit', 'commit', 'B', 'edit', 'reject-first']],
    ['older success while B is active', ['A', 'edit', 'commit', 'B', 'edit', 'resolve-first']],
    [
      'multiple pending operations, oldest rejected first',
      ['A', 'edit', 'commit', 'B', 'edit', 'commit', 'reject-first', 'reject-last'],
    ],
    [
      'multiple pending operations, newest rejected first',
      ['A', 'edit', 'commit', 'B', 'edit', 'commit', 'reject-last', 'reject-first'],
    ],
    [
      'cancel while earlier operation is pending',
      ['A', 'edit', 'commit', 'cancel', 'reject-first'],
    ],
    [
      'repeated edits of the same conversation',
      ['A', 'edit', 'commit', 'A', 'edit', 'reject-first'],
    ],
  ])('%s', async (_name, trace) => {
    await runTrace(trace as string[])
  })

  it('matches the model across 128 deterministic concurrent traces', async () => {
    const commands = [
      'A',
      'B',
      'edit',
      'commit',
      'cancel',
      'resolve-first',
      'reject-first',
      'resolve-last',
      'reject-last',
    ]
    let seed = 1686
    for (let run = 0; run < 128; run++) {
      const trace = ['A', 'edit', 'commit']
      for (let step = 0; step < 24; step++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        trace.push(commands[seed % commands.length]!)
      }
      await runTrace(trace)
    }
  })

  it('does not restore an unmounted editor after rejection', async () => {
    let reject!: () => void
    const onRejected = vi.fn()
    const hook = renderHook(() =>
      useInlineRename({
        onRejected,
        onRename: () =>
          new Promise<void>((_, fail) => {
            reject = () => fail(new Error('fixture rejection'))
          }),
      })
    )
    act(() => hook.result.current.start('A', 'baseline'))
    act(() => hook.result.current.onChange({ target: { value: 'draft' } }))
    act(() => hook.result.current.commit())
    hook.unmount()
    await act(async () => {
      reject()
    })
    // Feedback is operation-scoped, but the unmounted editor cannot be restored.
    expect(onRejected).toHaveBeenCalledTimes(1)
  })
})
