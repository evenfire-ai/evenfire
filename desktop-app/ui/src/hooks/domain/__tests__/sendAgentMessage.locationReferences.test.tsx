// @vitest-environment jsdom
/**
 * The folder a composer names travels as a structured LocationReference v1 in
 * `locationReferences`, next to a `Folders:` line that names it without its URI.
 * The Host's ack says whether it received the folder.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, waitFor } from '@testing-library/react'
import { COMPOSER_MAX_NON_IMAGE_BODY_BYTES } from '@constants/attachments'
import { composerNonImageShareBytes } from '@lib/composerFileAdmission'
import { buildComposerFileReferences } from '@lib/composerFileReferences'
import { buildComposerLocationReferences } from '@lib/composerLocationReferences'
import { buildComposerRequestContent } from '@lib/composerReferencesPrompt'
import type { GfsResourceView } from '../../../../../src/gfs/uriHandler'
import type { ComposerGlobalFolderReference, ComposerReferenceAttachment } from '../../../uiTypes'
import {
  fileView,
  folderView,
  pickedReferences,
  suggestedFolderCandidate,
} from '../../__tests__/__fixtures__/tabReferenceSuggestionFixtures'
import { renderController } from './__fixtures__/controllerHarness'
import { type HostDispatch, hostAdmissionAck } from './__fixtures__/hostAdmissionAck'
import { type MockClerum, installMockClerum, uninstallMockClerum } from './__fixtures__/mockClerum'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NOT_RECEIVED = "This agent can't use folder references yet"
const SENT_TOAST = ['Message sent to agent-x.', 'success'] as const
const SYNC: HostDispatch = { success: true, response: 'done' }
const ASYNC: HostDispatch = { success: true, taskId: 'task-folder', status: 'pending' }

let clerum: MockClerum
let reportsView: GfsResourceView
let reports: ComposerGlobalFolderReference
let invoices: ComposerGlobalFolderReference
let reportFile: ComposerReferenceAttachment
let reportFileView: GfsResourceView

beforeAll(async () => {
  reportsView = await folderView(1, 'Reports')
  reports = await suggestedFolderCandidate(reportsView)
  invoices = await suggestedFolderCandidate(await folderView(2, 'Invoices'))
  reportFileView = await fileView(1, 'report.md')
  const picked = await pickedReferences(hookMock.useGfsBrowserController, [reportFileView])
  reportFile = picked[0]!
})

beforeEach(() => {
  clerum = installMockClerum()
})

afterEach(() => {
  vi.restoreAllMocks()
  uninstallMockClerum()
})

async function mounted() {
  const rendered = renderController()
  await waitFor(() => expect(clerum.chat.getIndex).toHaveBeenCalled())
  return rendered
}

function sentRequests(): Array<Record<string, unknown>> {
  return clerum.rpc.invokeHostMessage.mock.calls.map(call => call[1] as Record<string, unknown>)
}

async function send(
  rendered: Awaited<ReturnType<typeof mounted>>,
  references: ComposerReferenceAttachment[],
  text = 'Create a summary in this folder'
) {
  act(() => rendered.result.current.handleAddComposerReferenceAttachments(references))
  await act(async () => {
    await rendered.result.current.handleSendAgentMessage(text)
  })
}

/** The Host answers with its own admission of the request desktop sent. */
function hostAnswers(dispatch: HostDispatch, options: { dropLocations?: boolean } = {}) {
  clerum.rpc.invokeHostMessage.mockImplementation(
    async (_host: string, request: Record<string, unknown>) => {
      // An rpc-proxy or Host that predates the field forwards the rest.
      const { locationReferences, ...rest } = request
      const received = options.dropLocations ? rest : { ...rest, locationReferences }
      return hostAdmissionAck(received, [reportsView, reportFileView], dispatch, {
        async: 'taskId' in dispatch,
      })
    }
  )
}

describe('sendAgentMessage — the folder as a location', () => {
  it('sends the folder as a LocationReference v1 and names it without its URI', async () => {
    hostAnswers(SYNC)
    const rendered = await mounted()
    await send(rendered, [reports])
    const [request] = sentRequests()
    expect(request?.locationReferences).toEqual(buildComposerLocationReferences([reports]))
    expect(request).not.toHaveProperty('fileReferences')
    expect(request?.content).toContain(
      'Folders: "Reports". The user pointed at this folder as the place for this request; use the referenced_folder of the turn context. If none is listed, ask the user where to work instead of choosing a place by name.'
    )
    // S9: the folder's URI travels only in the structured reference.
    expect(request?.content).not.toContain('gfs://')
  })

  it('sends no locationReferences field without a folder', async () => {
    hostAnswers(SYNC)
    const rendered = await mounted()
    await send(rendered, [reportFile])
    const [request] = sentRequests()
    expect(request?.fileReferences).toEqual(buildComposerFileReferences([reportFile]))
    expect(request).not.toHaveProperty('locationReferences')
  })

  it('S7: refuses two folders before anything is cleared, with the reason on screen', async () => {
    const rendered = await mounted()
    // Only a direct add can hold two: the chip and the restore cap folders at one.
    await send(rendered, [reports, invoices])
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    expect(rendered.result.current.agentError).toBe('Only one folder per message.')
    expect(rendered.spies.pushToast).toHaveBeenCalledWith('Only one folder per message.', 'error')
    expect(rendered.result.current.composerReferenceAttachments.map(item => item.id)).toEqual([
      reports.id,
      invoices.id,
    ])
  })

  it('counts the folder against the text share at send', async () => {
    const references = [reports]
    const folderJsonBytes = new TextEncoder().encode(
      JSON.stringify(buildComposerLocationReferences(references))
    ).length
    // The share with everything but the structured folder, for an empty text.
    const shareWithout = (text: string) =>
      composerNonImageShareBytes({
        content: buildComposerRequestContent(text, references),
        fileReferences: [],
        locationReferences: [],
        hostRef: 'agent-x',
        files: [],
        images: [],
      })
    const base = shareWithout('x')
    // One byte over the share only once the structured folder is counted.
    const length = COMPOSER_MAX_NON_IMAGE_BODY_BYTES - base - folderJsonBytes + 2
    expect(shareWithout('x'.repeat(length))).toBeLessThanOrEqual(COMPOSER_MAX_NON_IMAGE_BODY_BYTES)
    const rendered = await mounted()
    await send(rendered, references, 'x'.repeat(length))
    expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
    expect(rendered.result.current.agentError).toContain('The message text and attachment details')
    expect(rendered.result.current.composerReferenceAttachments.map(item => item.id)).toEqual([
      reports.id,
    ])
  })
})

describe('sendAgentMessage — a Host that did not receive the folder', () => {
  it('S-F6: warns once, shows no success, and does not resend', async () => {
    hostAnswers(SYNC, { dropLocations: true })
    const rendered = await mounted()
    await send(rendered, [reports])
    expect(sentRequests()).toHaveLength(1)
    expect(rendered.result.current.agentError).toBe(NOT_RECEIVED)
    expect(rendered.spies.pushToast.mock.calls.filter(([, kind]) => kind === 'error')).toEqual([
      [NOT_RECEIVED, 'error'],
    ])
    expect(rendered.spies.pushToast).not.toHaveBeenCalledWith(...SENT_TOAST)
    expect(rendered.result.current.failedAgentSend).toBeNull()
  })

  it('S-F6: an async ack without the folder warns too', async () => {
    hostAnswers(ASYNC, { dropLocations: true })
    const rendered = await mounted()
    await send(rendered, [reports])
    expect(rendered.result.current.agentError).toBe(NOT_RECEIVED)
    expect(sentRequests()).toHaveLength(1)
  })

  it('S-F7: an ack that lists the folder shows no warning and the success', async () => {
    hostAnswers(SYNC)
    const rendered = await mounted()
    await send(rendered, [reports, reportFile])
    expect(rendered.result.current.agentError).toBeNull()
    expect(rendered.spies.pushToast).not.toHaveBeenCalledWith(NOT_RECEIVED, 'error')
    expect(rendered.spies.pushToast).toHaveBeenCalledWith(...SENT_TOAST)
  })

  it('S-F7: an async ack that lists the folder shows no warning', async () => {
    hostAnswers(ASYNC)
    const rendered = await mounted()
    await send(rendered, [reports])
    await waitFor(() =>
      expect(clerum.chat.upsertMessages).toHaveBeenCalledWith(
        'agent-x',
        expect.any(String),
        expect.arrayContaining([expect.objectContaining({ task_id: 'task-folder' })])
      )
    )
    expect(rendered.result.current.agentError).toBeNull()
    expect(rendered.spies.pushToast).not.toHaveBeenCalledWith(NOT_RECEIVED, 'error')
  })
})
