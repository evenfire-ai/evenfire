// @vitest-environment jsdom
/**
 * Issue #666 — a Global Files selection is sent as a structured FileReference v1
 * in `fileReferences`, next to the prompt line that names it. The prompt no
 * longer tells the model how to read the file; the Host's turn context does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import type { ComposerGlobalFileReference } from '../../../uiTypes'
import { renderController } from './__fixtures__/controllerHarness'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

let clerum: MockClerum
let uuidCounter = 0

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RID = '0123456789abcdef0123456789abcdef'

const planFile: ComposerGlobalFileReference = {
  id: `global-file:${RID}`,
  type: 'global_file',
  resourceId: RID,
  drive: 'main',
  gfsUri: `gfs://main/${RID}`,
  label: 'plan.md',
  version: 4,
  bytes: 2048,
}

beforeEach(() => {
  uuidCounter = 0
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`
  )
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  uninstallMockClerum()
})

async function settleMount() {
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
}

function sentRequest(): Record<string, unknown> {
  expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
  return clerum.rpc.invokeHostMessage.mock.calls[0]?.[1] as Record<string, unknown>
}

describe('sendAgentMessage — structured Global Files references (#666)', () => {
  it('sends the selection as a FileReference v1', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'done' })
    const { result } = renderController()
    await settleMount()

    act(() => {
      result.current.handleAddComposerReferenceAttachments([planFile])
    })
    await act(async () => {
      await result.current.handleSendAgentMessage('Summarize the plan')
    })

    const request = sentRequest()
    expect(request.fileReferences).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        id: `gfs:main:${RID}@v4`,
        source: {
          kind: 'gfs',
          drive: 'main',
          resourceId: RID,
          gfsUri: `gfs://main/${RID}`,
          version: 4,
        },
        name: 'plan.md',
        class: 'markdown',
        byteLength: 2048,
      }),
    ])
    expect(request.content).toContain(
      `Global Files: plan.md (gfs://main/${RID}). These files were explicitly selected by the user.`
    )
    expect(request.content).not.toContain('clerum__gfs_read')
  })

  it('sends no fileReferences field without a Global Files selection', async () => {
    clerum.rpc.invokeHostMessage.mockResolvedValue({ response: 'done' })
    const { result } = renderController()
    await settleMount()

    await act(async () => {
      await result.current.handleSendAgentMessage('plain question')
    })

    // Witness: the message was sent with its content.
    const request = sentRequest()
    expect(request.content).toBe('plain question')
    expect(request).not.toHaveProperty('fileReferences')
  })
})
