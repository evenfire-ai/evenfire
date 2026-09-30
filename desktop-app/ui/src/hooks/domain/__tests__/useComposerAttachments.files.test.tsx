// @vitest-environment jsdom
/**
 * Issue #678 — the composer's document state machine: a picked file is
 * `reading` at once, then `ready`; the user can remove it at any point, and a
 * removed file never comes back. A refused or unreadable file leaves no chip,
 * only a notice that the next attach, a send or an agent change clears.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { COMPOSER_MAX_ATTACHMENTS, COMPOSER_MAX_FILE_BYTES } from '@constants/attachments'
import { useComposerAttachments } from '../useComposerAttachments'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  vi.restoreAllMocks()
})

function textFile(name: string, text: string): File {
  return new File([new TextEncoder().encode(text)], name, { type: 'text/plain' })
}

function render(selectedAgent: string | null = 'agent-x') {
  const clearSendError = vi.fn()
  const hook = renderHook(
    (props: { agent: string | null }) =>
      useComposerAttachments({ selectedAgent: props.agent, clearSendError }),
    { initialProps: { agent: selectedAgent } }
  )
  return { ...hook, clearSendError }
}

function statuses(result: ReturnType<typeof render>['result']): string[] {
  return result.current.composerFileAttachments.map(file => file.status)
}

describe('useComposerAttachments — documents (#678)', () => {
  it('shows a file as reading at once and as ready once it is read and hashed', async () => {
    const { result, clearSendError } = render()
    const file = textFile('notes.txt', 'hello')
    let release: (value: ArrayBuffer) => void = () => {}
    vi.spyOn(file, 'arrayBuffer').mockReturnValue(
      new Promise<ArrayBuffer>(resolve => {
        release = resolve
      })
    )

    act(() => {
      result.current.handleAddComposerFiles([file], 0)
    })
    // The chip exists before any byte is read.
    expect(statuses(result)).toEqual(['reading'])
    expect(clearSendError).toHaveBeenCalled()

    await act(async () => {
      release(new TextEncoder().encode('hello').buffer as ArrayBuffer)
    })
    await waitFor(() => expect(statuses(result)).toEqual(['ready']))
    const [ready] = result.current.composerFileAttachments
    expect(ready).toMatchObject({ filename: 'notes.txt', sizeBytes: 5 })
    expect(ready?.status === 'ready' && ready.digestHex).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    )
  })

  it('keeps the order in which files were added', async () => {
    const { result } = render()

    act(() => {
      result.current.handleAddComposerFiles([textFile('a.txt', 'a'), textFile('b.txt', 'b')], 0)
    })
    await waitFor(() => expect(statuses(result)).toEqual(['ready', 'ready']))

    expect(result.current.composerFileAttachments.map(file => file.filename)).toEqual([
      'a.txt',
      'b.txt',
    ])
    const orders = result.current.composerFileAttachments.map(file => file.addedOrder ?? 0)
    expect(orders[0]).toBeLessThan(orders[1]!)
  })

  it('drops a second copy of the same file instead of attaching it twice', async () => {
    const { result } = render()

    act(() => {
      result.current.handleAddComposerFiles([textFile('same.txt', 'same')], 0)
    })
    await waitFor(() => expect(statuses(result)).toEqual(['ready']))
    act(() => {
      result.current.handleAddComposerFiles([textFile('same.txt', 'same')], 0)
    })
    // Liveness witness: the second copy was admitted (reading) before it was dropped.
    expect(statuses(result)).toEqual(['ready', 'reading'])
    await waitFor(() => expect(statuses(result)).toEqual(['ready']))
  })

  it('keeps two files that share a name but not their bytes', async () => {
    const { result } = render()

    act(() => {
      result.current.handleAddComposerFiles(
        [textFile('same.txt', 'one'), textFile('same.txt', 'two')],
        0
      )
    })

    await waitFor(() => expect(statuses(result)).toEqual(['ready', 'ready']))
  })

  it('refuses a file over the size limit with a notice, adds no chip and never reads it', () => {
    const { result } = render()
    const huge = textFile('huge.bin', 'x')
    Object.defineProperty(huge, 'size', { configurable: true, value: COMPOSER_MAX_FILE_BYTES + 1 })
    const read = vi.spyOn(huge, 'arrayBuffer')

    act(() => {
      result.current.handleAddComposerFiles([huge], 0)
    })

    // Witness for the two negative checks below: the refusal names this file.
    expect(result.current.composerFileRefusals).toHaveLength(1)
    expect(result.current.composerFileRefusals[0]?.text).toMatch(
      /^huge\.bin is .* at most 11\.0 MiB/
    )
    expect(result.current.composerFileAttachments).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses the 21st attachment with a notice and keeps the first 20', async () => {
    const { result } = render()
    const files = Array.from({ length: COMPOSER_MAX_ATTACHMENTS + 1 }, (_, index) =>
      textFile(`f${index}.txt`, `content ${index}`)
    )

    act(() => {
      result.current.handleAddComposerFiles(files, 0)
    })

    await waitFor(() =>
      expect(statuses(result).filter(status => status === 'ready')).toHaveLength(
        COMPOSER_MAX_ATTACHMENTS
      )
    )
    expect(result.current.composerFileAttachments).toHaveLength(COMPOSER_MAX_ATTACHMENTS)
    expect(result.current.composerFileAttachments.map(file => file.filename)).not.toContain(
      `f${COMPOSER_MAX_ATTACHMENTS}.txt`
    )
    expect(result.current.composerFileRefusals.map(refusal => refusal.text)).toEqual([
      `A message can carry at most ${COMPOSER_MAX_ATTACHMENTS} attachments.`,
    ])
  })

  it('does not bring back a file removed while it was being read', async () => {
    const { result } = render()
    const file = textFile('gone.txt', 'gone')
    let release: (value: ArrayBuffer) => void = () => {}
    vi.spyOn(file, 'arrayBuffer').mockReturnValue(
      new Promise<ArrayBuffer>(resolve => {
        release = resolve
      })
    )
    act(() => {
      result.current.handleAddComposerFiles([file], 0)
    })
    const [reading] = result.current.composerFileAttachments
    expect(reading?.status).toBe('reading')

    act(() => {
      result.current.handleRemoveComposerFileAttachment(reading!.id)
    })
    expect(result.current.composerFileAttachments).toEqual([])
    await act(async () => {
      release(new TextEncoder().encode('gone').buffer as ArrayBuffer)
      // Let the read finish and its continuation run.
      await Promise.resolve()
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    expect(result.current.composerFileAttachments).toEqual([])
  })

  it('replaces the previous refusal when the user attaches again', async () => {
    const { result } = render()
    const bad = textFile('bad/name.txt', 'x')

    act(() => {
      result.current.handleAddComposerFiles([bad], 0)
    })
    // Twin: the refusal is on screen before the next attach.
    expect(result.current.composerFileRefusals).toHaveLength(1)
    expect(result.current.composerFileAttachments).toEqual([])

    act(() => {
      result.current.handleAddComposerFiles([textFile('good.txt', 'good')], 0)
    })
    await waitFor(() => expect(statuses(result)).toEqual(['ready']))
    expect(result.current.composerFileRefusals).toEqual([])
  })

  it('removes the chip of a file that cannot be read and shows why', async () => {
    const { result } = render()
    const file = textFile('locked.txt', 'locked')
    let fail: (reason: Error) => void = () => {}
    vi.spyOn(file, 'arrayBuffer').mockReturnValue(
      new Promise<ArrayBuffer>((_, reject) => {
        fail = reject
      })
    )
    act(() => {
      result.current.handleAddComposerFiles([file], 0)
    })
    // Witness: the chip existed while the file was being read.
    expect(statuses(result)).toEqual(['reading'])

    await act(async () => {
      fail(new Error('permission denied'))
    })

    await waitFor(() => expect(result.current.composerFileAttachments).toEqual([]))
    expect(result.current.composerFileRefusals.map(refusal => refusal.text)).toEqual([
      'locked.txt could not be read: permission denied',
    ])
  })

  it('shows no notice for a failed read whose chip was already removed', async () => {
    const { result } = render()
    const file = textFile('gone.txt', 'gone')
    let fail: (reason: Error) => void = () => {}
    vi.spyOn(file, 'arrayBuffer').mockReturnValue(
      new Promise<ArrayBuffer>((_, reject) => {
        fail = reject
      })
    )
    act(() => {
      result.current.handleAddComposerFiles([file], 0)
    })
    const [reading] = result.current.composerFileAttachments
    // Witness: the file was reading when the user removed it.
    expect(reading?.status).toBe('reading')
    act(() => {
      result.current.handleRemoveComposerFileAttachment(reading!.id)
    })

    await act(async () => {
      fail(new Error('permission denied'))
      await new Promise(resolve => setTimeout(resolve, 20))
    })

    expect(result.current.composerFileAttachments).toEqual([])
    expect(result.current.composerFileRefusals).toEqual([])
  })

  it.each([
    [
      'a send',
      (hook: ReturnType<typeof render>) => hook.result.current.clearComposerAfterSend(null),
    ],
    [
      'an agent change',
      (hook: ReturnType<typeof render>) => hook.rerender({ agent: 'agent-other' }),
    ],
    [
      'an image attach',
      (hook: ReturnType<typeof render>) =>
        hook.result.current.handleAddComposerImageAttachments([
          {
            id: 'img-1',
            name: 'a.png',
            mimeType: 'image/png',
            dataBase64: 'aGVsbG8=',
            sizeBytes: 5,
            previewDataUrl: 'data:image/png;base64,aGVsbG8=',
          },
        ]),
    ],
  ])('clears the refusal on %s', (_label, clear) => {
    const hook = render()
    act(() => {
      hook.result.current.handleAddComposerFiles([textFile('bad/name.txt', 'x')], 0)
    })
    // Twin: the refusal is on screen before the clearing action.
    expect(hook.result.current.composerFileRefusals).toHaveLength(1)

    act(() => {
      clear(hook)
    })

    expect(hook.result.current.composerFileRefusals).toEqual([])
  })

  it('clears the documents when the selected agent changes', async () => {
    const { result, rerender } = render('agent-x')
    act(() => {
      result.current.handleAddComposerFiles([textFile('a.txt', 'a')], 0)
    })
    await waitFor(() => expect(statuses(result)).toEqual(['ready']))

    rerender({ agent: 'agent-y' })

    await waitFor(() => expect(result.current.composerFileAttachments).toEqual([]))
  })

  it('puts back the files of a failed send exactly as they were', async () => {
    const { result } = render()
    act(() => {
      result.current.handleAddComposerFiles([textFile('a.txt', 'a')], 0)
    })
    await waitFor(() => expect(statuses(result)).toEqual(['ready']))
    const kept = result.current.composerFileAttachments
    act(() => {
      result.current.resetComposerAttachments()
    })
    expect(result.current.composerFileAttachments).toEqual([])

    act(() => {
      result.current.handleRestoreComposerFiles(kept)
    })

    expect(result.current.composerFileAttachments).toEqual(kept)
  })
})
