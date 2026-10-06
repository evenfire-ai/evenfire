// @vitest-environment jsdom
/**
 * Issue #678 — the composer's document state machine: a picked file is
 * `reading` at once, then `ready`; the user can remove it at any point, and a
 * removed file never comes back. A refused or unreadable file leaves no chip,
 * only a notice that the next attach, removing a file, a send or an agent
 * change clears.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { COMPOSER_MAX_ATTACHMENTS, COMPOSER_MAX_FILE_BYTES } from '@constants/attachments'
import { buildComposerFileReferences } from '@lib/composerFileReferences'
import { composerRequestBaseContent } from '@lib/composerHostRequest'
import { buildComposerRequestContent } from '@lib/composerReferencesPrompt'
import type { ComposerGlobalFileReference, ComposerImageAttachment } from '../../../uiTypes'
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

function refusalTexts(result: ReturnType<typeof render>['result']): string[] {
  return result.current.composerFileRefusals.map(refusal => refusal.text)
}

/** A prepared image whose bytes differ from every other index. */
function image(index: number): ComposerImageAttachment {
  const dataBase64 = btoa(`image ${index}`)
  return {
    id: `img-${index}`,
    name: `image-${index}.png`,
    mimeType: 'image/png',
    dataBase64,
    sizeBytes: `image ${index}`.length,
    previewDataUrl: `data:image/png;base64,${dataBase64}`,
  }
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
      result.current.handleAddComposerFiles([file], '')
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
      result.current.handleAddComposerFiles([textFile('a.txt', 'a'), textFile('b.txt', 'b')], '')
    })
    await waitFor(() => expect(statuses(result)).toEqual(['ready', 'ready']))

    expect(result.current.composerFileAttachments.map(file => file.filename)).toEqual([
      'a.txt',
      'b.txt',
    ])
    const orders = result.current.composerFileAttachments.map(file => file.addedOrder ?? 0)
    expect(orders[0]).toBeLessThan(orders[1]!)
  })

  it('drops a second copy of the same file and says it is already attached', async () => {
    const { result } = render()

    act(() => {
      result.current.handleAddComposerFiles([textFile('same.txt', 'same')], '')
    })
    await waitFor(() => expect(statuses(result)).toEqual(['ready']))
    act(() => {
      result.current.handleAddComposerFiles([textFile('same.txt', 'same')], '')
    })
    // Liveness witness: the second copy was admitted (reading) before it was dropped.
    expect(statuses(result)).toEqual(['ready', 'reading'])
    await waitFor(() => expect(statuses(result)).toEqual(['ready']))
    expect(refusalTexts(result)).toEqual(['"same.txt" is already attached.'])
  })

  it('attaches a file whose name the OS reports decomposed under its NFC name', async () => {
    const { result } = render()
    const decomposed = 'café.txt'
    // Twin: the name as picked is not NFC, which the Host refuses.
    expect(decomposed.normalize('NFC')).not.toBe(decomposed)

    act(() => {
      result.current.handleAddComposerFiles([textFile(decomposed, 'menu')], '')
    })

    await waitFor(() => expect(statuses(result)).toEqual(['ready']))
    expect(result.current.composerFileAttachments[0]?.filename).toBe('café.txt')
    expect(result.current.composerFileRefusals).toEqual([])
  })

  it('keeps two files that share a name but not their bytes', async () => {
    const { result } = render()

    act(() => {
      result.current.handleAddComposerFiles(
        [textFile('same.txt', 'one'), textFile('same.txt', 'two')],
        ''
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
      result.current.handleAddComposerFiles([huge], '')
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
      result.current.handleAddComposerFiles(files, '')
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

  it('clears the refusal when the user removes a file chip to make room', async () => {
    const { result } = render()
    const files = Array.from({ length: COMPOSER_MAX_ATTACHMENTS + 1 }, (_, index) =>
      textFile(`f${index}.txt`, `content ${index}`)
    )
    act(() => {
      result.current.handleAddComposerFiles(files, '')
    })
    await waitFor(() =>
      expect(statuses(result).filter(status => status === 'ready')).toHaveLength(
        COMPOSER_MAX_ATTACHMENTS
      )
    )
    // Witness: the refusal is on screen before the chip is removed.
    expect(refusalTexts(result)).toEqual([
      `A message can carry at most ${COMPOSER_MAX_ATTACHMENTS} attachments.`,
    ])
    const [first] = result.current.composerFileAttachments

    act(() => {
      result.current.handleRemoveComposerFileAttachment(first!.id)
    })

    expect(result.current.composerFileAttachments).toHaveLength(COMPOSER_MAX_ATTACHMENTS - 1)
    expect(result.current.composerFileAttachments.map(file => file.id)).not.toContain(first!.id)
    expect(refusalTexts(result)).toEqual([])
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
      result.current.handleAddComposerFiles([file], '')
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
      result.current.handleAddComposerFiles([bad], '')
    })
    // Twin: the refusal is on screen before the next attach.
    expect(result.current.composerFileRefusals).toHaveLength(1)
    expect(result.current.composerFileAttachments).toEqual([])

    act(() => {
      result.current.handleAddComposerFiles([textFile('good.txt', 'good')], '')
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
      result.current.handleAddComposerFiles([file], '')
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
      result.current.handleAddComposerFiles([file], '')
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
      'an attach with no documents',
      (hook: ReturnType<typeof render>) => hook.result.current.handleAddComposerFiles([], ''),
    ],
  ])('clears the refusal on %s', (_label, clear) => {
    const hook = render()
    act(() => {
      hook.result.current.handleAddComposerFiles([textFile('bad/name.txt', 'x')], '')
    })
    // Twin: the refusal is on screen before the clearing action.
    expect(hook.result.current.composerFileRefusals).toHaveLength(1)

    act(() => {
      clear(hook)
    })

    expect(hook.result.current.composerFileRefusals).toEqual([])
  })

  it('keeps the refusal of a document when the same gesture also attaches an image', () => {
    const { result } = render()
    const huge = textFile('huge.bin', 'x')
    Object.defineProperty(huge, 'size', { configurable: true, value: COMPOSER_MAX_FILE_BYTES + 1 })

    // One drop: the panel routes the documents first, then the images.
    act(() => {
      result.current.handleAddComposerFiles([huge], '')
      result.current.handleAddComposerImageAttachments([image(1)])
    })

    // Witness: the image of the same gesture was attached.
    expect(result.current.composerImageAttachments.map(item => item.id)).toEqual(['img-1'])
    expect(refusalTexts(result)).toHaveLength(1)
    expect(refusalTexts(result)[0]).toMatch(/^huge\.bin is .* at most 11\.0 MiB/)
  })

  it('refuses with a notice an image that arrives after the last free slot was taken', async () => {
    const { result } = render()
    act(() => {
      result.current.handleAddComposerImageAttachments(
        Array.from({ length: COMPOSER_MAX_ATTACHMENTS - 1 }, (_, index) => image(index))
      )
    })
    // Twin: 19 images are attached and one slot is free.
    expect(result.current.composerImageAttachments).toHaveLength(COMPOSER_MAX_ATTACHMENTS - 1)

    act(() => {
      result.current.handleAddComposerFiles([textFile('doc.txt', 'doc')], '')
      result.current.handleAddComposerImageAttachments([
        { ...image(COMPOSER_MAX_ATTACHMENTS), name: 'late.png' },
      ])
    })

    await waitFor(() => expect(statuses(result)).toEqual(['ready']))
    expect(result.current.composerImageAttachments).toHaveLength(COMPOSER_MAX_ATTACHMENTS - 1)
    expect(refusalTexts(result)).toEqual([
      `"late.png" was not attached: a message can carry at most ${COMPOSER_MAX_ATTACHMENTS} attachments.`,
    ])
  })

  it('clears the refusal when the user removes an image chip to make room', () => {
    const { result } = render()
    act(() => {
      result.current.handleAddComposerImageAttachments(
        Array.from({ length: COMPOSER_MAX_ATTACHMENTS + 1 }, (_, index) => image(index))
      )
    })
    // Witness: the twenty-first image was refused with a notice on screen.
    expect(result.current.composerImageAttachments).toHaveLength(COMPOSER_MAX_ATTACHMENTS)
    expect(refusalTexts(result)).toEqual([
      `"${image(COMPOSER_MAX_ATTACHMENTS).name}" was not attached: a message can carry at most ${COMPOSER_MAX_ATTACHMENTS} attachments.`,
    ])

    act(() => {
      result.current.handleRemoveComposerImageAttachment(image(0).id)
    })

    expect(result.current.composerImageAttachments).toHaveLength(COMPOSER_MAX_ATTACHMENTS - 1)
    expect(refusalTexts(result)).toEqual([])
  })

  it('clears the documents when the selected agent changes', async () => {
    const { result, rerender } = render('agent-x')
    act(() => {
      result.current.handleAddComposerFiles([textFile('a.txt', 'a')], '')
    })
    await waitFor(() => expect(statuses(result)).toEqual(['ready']))

    rerender({ agent: 'agent-y' })

    await waitFor(() => expect(result.current.composerFileAttachments).toEqual([]))
  })

  it('puts back the files of a failed send exactly as they were', async () => {
    const { result } = render()
    act(() => {
      result.current.handleAddComposerFiles([textFile('a.txt', 'a')], '')
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

  function globalReferences(count: number, label: (index: number) => string) {
    return Array.from({ length: count }, (_, index): ComposerGlobalFileReference => {
      const resourceId = index.toString(16).padStart(32, '0')
      return {
        id: `global-file:main:${resourceId}`,
        type: 'global_file',
        resourceId,
        drive: 'main',
        gfsUri: `gfs://main/${resourceId}`,
        label: label(index),
        version: 1,
        bytes: 2048,
      }
    })
  }

  it('counts the selected references and the agent against the 6 MiB share', () => {
    const { result } = render()
    const references = globalReferences(4, () => `${'文'.repeat(251)}.txt`)
    act(() => {
      result.current.handleAddComposerReferenceAttachments(references)
    })
    const doc = new File([new Uint8Array(1024)], 'doc.txt', { type: 'text/plain' })
    const utf8 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
    const contentBytes = (draft: string) =>
      utf8(buildComposerRequestContent(composerRequestBaseContent(draft, 0, 1), references))
    // Everything the share holds besides the draft, each part as the request
    // body carries it: envelope, fields rpc-proxy adds, the text with its
    // references section, the serialized references, the agent twice and the
    // file details.
    const referencesBytes = utf8(buildComposerFileReferences(references))
    const fixedBytes =
      4096 +
      2048 +
      (contentBytes('x') - 1) +
      referencesBytes +
      2 * utf8('agent-x') +
      utf8('doc.txt') +
      640
    const boundary = 6 * 1024 * 1024 - fixedBytes
    // The text grows one byte per draft character: the arithmetic above holds.
    expect(contentBytes('x'.repeat(boundary))).toBe(contentBytes('x') - 1 + boundary)
    // Leaving the references out would admit the refused draft below.
    expect(referencesBytes).toBeGreaterThan(1)

    act(() => {
      result.current.handleAddComposerFiles([doc], 'x'.repeat(boundary + 1))
    })
    expect(refusalTexts(result)).toEqual([
      'doc.txt does not fit: the text and attachment details can take at most 6.0 MiB per message once encoded.',
    ])
    expect(result.current.composerFileAttachments).toHaveLength(0)

    // Liveness witness: the draft that fills the share exactly is admitted.
    act(() => {
      result.current.handleAddComposerFiles([doc], 'x'.repeat(boundary))
    })
    expect(refusalTexts(result)).toEqual([])
    expect(statuses(result)).toEqual(['reading'])
  })

  it('refuses a file while no agent is selected, and admits it for an agent', () => {
    const doc = textFile('doc.txt', 'hello')
    const withoutAgent = render(null)
    act(() => {
      withoutAgent.result.current.handleAddComposerFiles([doc], '')
    })
    expect(refusalTexts(withoutAgent.result)).toEqual(['Select an agent before attaching files.'])
    expect(withoutAgent.result.current.composerFileAttachments).toHaveLength(0)

    const withAgent = render('agent-x')
    act(() => {
      withAgent.result.current.handleAddComposerFiles([doc], '')
    })
    expect(refusalTexts(withAgent.result)).toEqual([])
    expect(statuses(withAgent.result)).toEqual(['reading'])
  })

  it('refuses a file beside more than 10 Global Files references, and admits it beside 10', () => {
    const doc = textFile('doc.txt', 'hello')
    const eleven = render()
    act(() => {
      eleven.result.current.handleAddComposerReferenceAttachments(
        globalReferences(11, index => `file-${index}.md`)
      )
    })
    act(() => {
      eleven.result.current.handleAddComposerFiles([doc], '')
    })
    expect(refusalTexts(eleven.result)).toEqual(['A message can reference at most 10 files.'])
    expect(eleven.result.current.composerFileAttachments).toHaveLength(0)

    const ten = render()
    act(() => {
      ten.result.current.handleAddComposerReferenceAttachments(
        globalReferences(10, index => `file-${index}.md`)
      )
    })
    act(() => {
      ten.result.current.handleAddComposerFiles([doc], '')
    })
    expect(refusalTexts(ten.result)).toEqual([])
    expect(statuses(ten.result)).toEqual(['reading'])
  })
})
