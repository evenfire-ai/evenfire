// @vitest-environment jsdom
/**
 * Issue #678 — the composer's document state machine: a picked file is
 * `reading` at once, then `ready` (or `failed` with a reason); the user can
 * remove it at any point, and a removed file never comes back.
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

  it('shows a file over the size limit as failed with the reason and never reads it', () => {
    const { result } = render()
    const huge = textFile('huge.bin', 'x')
    Object.defineProperty(huge, 'size', { configurable: true, value: COMPOSER_MAX_FILE_BYTES + 1 })
    const read = vi.spyOn(huge, 'arrayBuffer')

    act(() => {
      result.current.handleAddComposerFiles([huge], 0)
    })

    const [failed] = result.current.composerFileAttachments
    expect(failed?.status).toBe('failed')
    expect(failed?.status === 'failed' && failed.error).toMatch(/^huge\.bin is .* at most 3\.0 MiB/)
    // Witness for "never reads it": the chip exists, and the reader was not called.
    expect(read).not.toHaveBeenCalled()
  })

  it('shows the 21st attachment as failed and keeps the first 20', async () => {
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
    const last = result.current.composerFileAttachments.at(-1)
    expect(last?.status).toBe('failed')
    expect(last?.status === 'failed' && last.error).toBe(
      `A message can carry at most ${COMPOSER_MAX_ATTACHMENTS} attachments.`
    )
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

  it('removes a failed file so the composer can send again', () => {
    const { result } = render()
    const bad = textFile('bad/name.txt', 'x')

    act(() => {
      result.current.handleAddComposerFiles([bad], 0)
    })
    expect(statuses(result)).toEqual(['failed'])

    act(() => {
      result.current.handleRemoveComposerFileAttachment(
        result.current.composerFileAttachments[0]!.id
      )
    })
    expect(result.current.composerFileAttachments).toEqual([])
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
