// @vitest-environment jsdom
/**
 * A send the server rejects, on the real coordinator and the real IPC error
 * producers. A generic rejection (a 401, or a 403 whose follow-up read does not
 * deny the agent) returns the input to the composer with no message, keeps the
 * agent selected and withdraws the rejected turn. A loss of access holds or
 * revokes the agent as before; the input waits for the user in the composer, or
 * behind Recover input when the send carried attachments. Where the input waits
 * behind Recover input, the composer shows the sentence for the failure's kind
 * and keeps the raw error under Technical details.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, waitFor } from '@testing-library/react'
import {
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
} from '@lib/composerDraftStore'
import {
  installAppControllerClerum,
  renderAppController,
} from '../domain/__tests__/__fixtures__/appControllerHarness'
import {
  ipcGenericForbidden,
  ipcHostAccessDenied,
  ipcHostAccessRevoked,
  ipcHttpError,
} from '../domain/__tests__/__fixtures__/ipcErrors'
import { type MockClerum, uninstallMockClerum } from '../domain/__tests__/__fixtures__/mockClerum'

const AGENT = 'agent-x'
const REFERENCE = {
  id: 'plugin-ref',
  type: 'plugin',
  namespace: 'ns',
  name: 'helper',
  label: 'helper plugin',
} as const

type App = ReturnType<typeof renderAppController>
type SendError = () => Promise<Error>

const networkError: SendError = async () => new Error('network down')
const http401: SendError = () =>
  ipcHttpError('rpc:invokeHostMessage', 401, 'Unauthorized', { error: 'expired' })

// The alert a send kept behind Recover input shows for its kind.
const AUTH_ALERT =
  'Access issue while sending to this agent. You may not have access to this agent anymore. Sign in again or ask an admin for access.'
const NETWORK_ALERT =
  'Temporary connection issue while sending to the agent. Temporary connectivity issue. Retry in a few seconds or check backend health.'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// The follow-up read the send makes after a 403 asks for one session.
const isFollowUpRead = (query: unknown) => (query as { limit?: number } | undefined)?.limit === 1

function serverTurn(number: number, userInput: string, response: string) {
  return {
    number,
    user_input: userInput,
    response,
    started_at: new Date(Date.UTC(2026, 0, 1, 0, number)).toISOString(),
    completed_at: new Date(Date.UTC(2026, 0, 1, 0, number, 30)).toISOString(),
  }
}

describe('useAppController: a send the server rejects', () => {
  let unmount: (() => void) | undefined

  afterEach(() => {
    cleanup()
    unmount?.()
    unmount = undefined
    vi.restoreAllMocks()
    uninstallMockClerum()
    resetComposerDraftStore()
  })

  async function boot() {
    const { clerum, handle } = installAppControllerClerum({ agentNames: [AGENT, 'agent-y'] })
    // The harness default answers a fixed empty index; read the real store's.
    clerum.chat.getIndex.mockImplementation((agentRef: string) => clerum.readIndex(agentRef))
    const app = renderAppController()
    unmount = app.unmount
    await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
    act(() => {
      app.result.current.handleSelectChatAgent(AGENT, { selectLatest: false })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(AGENT))
    return { app, clerum, handle }
  }

  async function createChat(app: App): Promise<string> {
    await act(async () => {
      await app.result.current.handleCreateChat()
    })
    await waitFor(() => expect(app.result.current.activeChatId).not.toBeNull())
    return app.result.current.activeChatId as string
  }

  /** A chat whose transcript already holds server turn 1, visible and stored. */
  async function createChatWithServerTurn(app: App, clerum: MockClerum): Promise<string> {
    const chatId = await createChat(app)
    const first = serverTurn(1, 'first question', 'first answer')
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: AGENT,
      chatId,
      state: 'idle',
      totalTurns: 1,
      turns: [first],
    })
    await act(async () => {
      await app.result.current.handleSelectChat(chatId)
    })
    await waitFor(() =>
      expect(app.result.current.chatMessages.map(message => message.content)).toEqual([
        'first question',
        'first answer',
      ])
    )
    return chatId
  }

  async function addReference(app: App) {
    act(() => app.result.current.handleAddComposerReferenceAttachments([REFERENCE] as never))
    await waitFor(() => expect(app.result.current.composerReferenceAttachments).toHaveLength(1))
  }

  async function addDocument(app: App, text: string) {
    const note = new File(['rejected send attachment'], 'notes.txt', { type: 'text/plain' })
    act(() => app.result.current.handleAddComposerFiles([note], text))
    await waitFor(() =>
      expect(app.result.current.composerFileAttachments.map(file => file.status)).toEqual(['ready'])
    )
  }

  async function send(app: App, text: string) {
    await act(async () => {
      await app.result.current.handleSendAgentMessage(text)
    })
  }

  const visibleUserTurns = (app: App, text: string) =>
    app.result.current.chatMessages.filter(
      message => message.role === 'user' && message.content === text
    )

  const storedUserTurns = async (clerum: MockClerum, chatId: string, text: string) =>
    (await clerum.persistedMessages(AGENT, chatId)).filter(
      message => message.role === 'user' && message.content === text
    )

  /** The id of the optimistic user turn the send wrote for `text`. */
  function writtenTurnId(clerum: MockClerum, chatId: string, text: string): string {
    const call = clerum.chat.upsertMessages.mock.calls.find(
      ([agentRef, callChatId, messages]) =>
        agentRef === AGENT &&
        callChatId === chatId &&
        (messages as Array<{ role: string; content: string }>).some(
          message => message.role === 'user' && message.content === text
        )
    )
    const message = (
      call?.[2] as Array<{ id: string; role: string; content: string }> | undefined
    )?.find(candidate => candidate.role === 'user' && candidate.content === text)
    if (!message) throw new Error(`No user turn with "${text}" was written to chat ${chatId}`)
    return message.id
  }

  async function reselect(app: App, clerum: MockClerum, chatId: string) {
    clerum.rpc.listSessions.mockReset()
    clerum.rpc.listSessions.mockResolvedValue({ items: [] })
    clerum.rpc.loadSessionMessages.mockReset()
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: AGENT,
      chatId,
      state: 'idle',
      totalTurns: 0,
      turns: [],
    })
    act(() => {
      app.result.current.handleSelectChatAgent(AGENT, { selectLatest: true })
    })
    await waitFor(() => expect(app.result.current.selectedAgent).toBe(AGENT))
    await waitFor(() => expect(app.result.current.activeChatId).toBe(chatId))
  }

  /** Starts a send whose POST stays pending until the returned `post` settles. */
  async function sendHeldAtPost(app: App, clerum: MockClerum, text: string) {
    const post = deferred<never>()
    const callsBefore = clerum.rpc.invokeHostMessage.mock.calls.length
    clerum.rpc.invokeHostMessage.mockImplementationOnce(() => post.promise)
    let pendingSend!: Promise<void>
    act(() => {
      pendingSend = app.result.current.handleSendAgentMessage(text)
    })
    await waitFor(() => expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(callsBefore + 1))
    return { post, pendingSend }
  }

  /** Another path holds the agent: a read of the chat's transcript is denied. */
  async function holdByDeniedRead(app: App, clerum: MockClerum, chatId: string, denial: Error) {
    clerum.rpc.loadSessionMessages.mockRejectedValue(denial)
    await act(async () => {
      await app.result.current.handleSelectChat(chatId)
    })
    await waitFor(() => expect(app.result.current.isHostAccessBlocked(AGENT)).toBe(true))
  }

  /** After access returns: the text is in the draft and the turn is gone. */
  async function expectInputReturnedAfterReselect(
    app: App,
    clerum: MockClerum,
    chatId: string,
    text: string
  ) {
    await reselect(app, clerum, chatId)
    expect.soft(getComposerDraft(chatId, AGENT), 'draft').toBe(text)
    expect.soft(await storedUserTurns(clerum, chatId, text), 'stored turn').toHaveLength(0)
    expect.soft(visibleUserTurns(app, text), 'visible turn').toHaveLength(0)
  }

  describe('T-A1: a generic rejection returns the input and keeps the agent', () => {
    const rows: Array<{
      label: string
      sendError: SendError
      readError: SendError | null
      chat: 'existing' | 'created by the send'
      document: boolean
    }> = [
      { label: '401', sendError: http401, readError: null, chat: 'existing', document: false },
      {
        label: '401',
        sendError: http401,
        readError: null,
        chat: 'created by the send',
        document: false,
      },
      {
        label: 'generic 403 with a readable read',
        sendError: () => ipcGenericForbidden('rpc:invokeHostMessage'),
        readError: null,
        chat: 'existing',
        document: true,
      },
      {
        label: 'generic 403 with a readable read',
        sendError: () => ipcGenericForbidden('rpc:invokeHostMessage'),
        readError: null,
        chat: 'created by the send',
        document: false,
      },
      {
        label: 'generic 403 with a read that fails 503',
        sendError: () => ipcGenericForbidden('rpc:invokeHostMessage'),
        readError: () =>
          ipcHttpError('rpc:listSessions', 503, 'Service Unavailable', { error: 'unavailable' }),
        chat: 'existing',
        document: false,
      },
      {
        label: 'generic 403 with a read that fails 503',
        sendError: () => ipcGenericForbidden('rpc:invokeHostMessage'),
        readError: () =>
          ipcHttpError('rpc:listSessions', 503, 'Service Unavailable', { error: 'unavailable' }),
        chat: 'created by the send',
        document: false,
      },
    ]

    it.each(rows)(
      '$label, chat $chat, document $document',
      async ({ sendError, readError, chat, document }) => {
        const { app, clerum } = await boot()
        if (chat === 'existing') await createChat(app)
        const text = 'text the server rejects'
        await addReference(app)
        if (document) await addDocument(app, text)
        const sendFailure = await sendError()
        const readFailure = readError ? await readError() : null
        clerum.rpc.invokeHostMessage.mockImplementationOnce(async () => {
          if (readFailure) {
            clerum.rpc.listSessions.mockImplementation(async (_hostRef, _hostRefs, query) => {
              if (isFollowUpRead(query)) throw readFailure
              return { items: [] }
            })
          }
          throw sendFailure
        })
        const toastsBefore = app.result.current.toasts.length

        await send(app, text)

        // Step 1, the liveness witness for every step below.
        expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
        const chatId = app.result.current.activeChatId as string
        expect(chatId).not.toBeNull()
        // Step 2.
        expect.soft(app.result.current.selectedAgent, 'step 2: selected agent').toBe(AGENT)
        expect.soft(app.result.current.isHostAccessBlocked(AGENT), 'step 2: blocked').toBe(false)
        // Step 3.
        expect.soft(getComposerDraft(chatId, AGENT), 'step 3: draft').toBe(text)
        expect
          .soft(
            app.result.current.composerReferenceAttachments.map(reference => reference.id),
            'step 3: references'
          )
          .toEqual([REFERENCE.id])
        if (document) {
          expect
            .soft(
              app.result.current.composerFileAttachments.map(file => file.filename),
              'step 3: documents'
            )
            .toEqual(['notes.txt'])
        }
        // Step 4. Witnesses for these negatives: steps 1 and 3.
        expect.soft(app.result.current.agentError, 'step 4: agent error').toBeNull()
        expect.soft(app.result.current.failedAgentSend, 'step 4: failed send').toBeNull()
        expect.soft(app.result.current.toasts.slice(toastsBefore), 'step 4: toasts').toEqual([])
        // Step 5. Witness: the turn was written before the POST.
        expect(() => writtenTurnId(clerum, chatId, text)).not.toThrow()
        await waitFor(async () => {
          expect.soft(visibleUserTurns(app, text), 'step 5: visible turn').toHaveLength(0)
          expect
            .soft(await storedUserTurns(clerum, chatId, text), 'step 5: stored turn')
            .toHaveLength(0)
        })

        // Step 6: a second send is accepted.
        clerum.rpc.listSessions.mockReset()
        clerum.rpc.listSessions.mockResolvedValue({ items: [] })
        await send(app, text)
        expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(2)
        await waitFor(async () =>
          expect(await storedUserTurns(clerum, chatId, text)).not.toHaveLength(0)
        )
        expect.soft(visibleUserTurns(app, text), 'step 6: visible turns').toHaveLength(1)
        expect
          .soft(await storedUserTurns(clerum, chatId, text), 'step 6: stored turns')
          .toHaveLength(1)
      }
    )
  })

  describe('T-A2: a loss of access holds the agent and keeps the input', () => {
    const rows: Array<{ label: string; sendError: SendError; readError: SendError | null }> = [
      {
        label: 'host_access_revoked on the send',
        sendError: () => ipcHostAccessRevoked('rpc:invokeHostMessage'),
        readError: null,
      },
      {
        label: 'generic 403 with the read answering host_access_revoked',
        sendError: () => ipcGenericForbidden('rpc:invokeHostMessage'),
        readError: () => ipcHostAccessRevoked('rpc:listSessions'),
      },
      {
        label: 'host_access_denied with a denied read',
        sendError: () => ipcHostAccessDenied('rpc:invokeHostMessage'),
        readError: () => ipcHostAccessDenied('rpc:listSessions'),
      },
    ]
    const payloads = [
      { payload: 'text only', withReference: false },
      { payload: 'text and a reference', withReference: true },
    ] as const

    it.each(rows.flatMap(row => payloads.map(payload => ({ ...row, ...payload }))))(
      '$label, $payload',
      async ({ sendError, readError, withReference }) => {
        const { app, clerum } = await boot()
        const chatId = await createChat(app)
        const text = 'text sent as access is lost'
        if (withReference) await addReference(app)
        const sendFailure = await sendError()
        const readFailure = readError ? await readError() : null
        clerum.rpc.invokeHostMessage.mockImplementationOnce(async () => {
          if (readFailure) clerum.rpc.listSessions.mockRejectedValue(readFailure)
          throw sendFailure
        })
        const toastsBefore = app.result.current.toasts.length

        await send(app, text)

        // Step 1.
        expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
        // Step 2: the hold is as today.
        await waitFor(() => expect(app.result.current.selectedAgent).toBeNull())
        expect.soft(app.result.current.isHostAccessBlocked(AGENT), 'step 2: blocked').toBe(true)
        expect.soft(app.result.current.toasts.slice(toastsBefore), 'step 2: toasts').toEqual([])

        // Step 3: the read answers again and the agent is reselected.
        await reselect(app, clerum, chatId)
        expect
          .soft(await storedUserTurns(clerum, chatId, text), 'step 3: stored turn')
          .toHaveLength(0)
        expect.soft(visibleUserTurns(app, text), 'step 3: visible turn').toHaveLength(0)
        if (!withReference) {
          expect.soft(getComposerDraft(chatId, AGENT), 'step 3: draft').toBe(text)
          expect.soft(app.result.current.failedAgentSend, 'step 3: failed send').toBeNull()
          return
        }
        // Step 4: text and reference wait together behind Recover input.
        expect.soft(getComposerDraft(chatId, AGENT), 'step 4: draft').toBe('')
        await waitFor(() => expect(app.result.current.failedAgentSend).not.toBeNull())
        expect.soft(app.result.current.failedAgentSend?.content, 'step 4: retained text').toBe(text)
        expect
          .soft(
            app.result.current.failedAgentSend?.references.map(reference => reference.id),
            'step 4: retained reference'
          )
          .toEqual([REFERENCE.id])
        act(() => {
          app.result.current.handleRecoverFailedAgentSend()
        })
        expect.soft(getComposerDraft(chatId, AGENT), 'step 4: recovered draft').toBe(text)
        expect
          .soft(
            app.result.current.composerReferenceAttachments.map(reference => reference.id),
            'step 4: recovered reference'
          )
          .toEqual([REFERENCE.id])
      }
    )
  })

  describe("T-A3: a failure that is not a rejection keeps today's error (control)", () => {
    it.each([
      { label: 'a network error', sendError: networkError },
      {
        label: 'a 503',
        sendError: () =>
          ipcHttpError('rpc:invokeHostMessage', 503, 'Service Unavailable', { error: 'down' }),
      },
      {
        label: 'a 404',
        sendError: () => ipcHttpError('rpc:invokeHostMessage', 404, 'Not Found', { error: 'gone' }),
      },
      {
        label: 'a 413',
        sendError: () =>
          ipcHttpError('rpc:invokeHostMessage', 413, 'Payload Too Large', {
            error: 'request entity too large',
          }),
      },
    ])('$label', async ({ sendError }) => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const text = 'text that fails to send'
      clerum.rpc.invokeHostMessage.mockRejectedValueOnce(await sendError())
      const toastsBefore = app.result.current.toasts.length

      await send(app, text)

      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(app.result.current.failedAgentSend).not.toBeNull())
      expect(app.result.current.agentError).not.toBeNull()
      expect(app.result.current.failedAgentSend?.content).toBe(text)
      const kind = app.result.current.failedAgentSend?.kind
      expect(app.result.current.toasts.slice(toastsBefore).map(toast => toast.text)).toContain(
        kind === 'waking'
          ? 'Agent is waking up — message not sent yet.'
          : `Message failed (${kind}).`
      )
      expect(getComposerDraft(chatId, AGENT)).toBe('')
      await waitFor(async () =>
        expect(await storedUserTurns(clerum, chatId, text)).toEqual([
          expect.objectContaining({ preserveLocal: true }),
        ])
      )
      // Witness for this negative: the send ran and recorded its failure above.
      expect(clerum.chat.removeMessages).not.toHaveBeenCalled()
    })
  })

  describe('T-A5: an agent held by another path', () => {
    it.each<[string, SendError]>([
      [
        'held by a denied transcript read while the POST is pending, then the POST is denied',
        () => ipcHostAccessRevoked('rpc:invokeHostMessage'),
      ],
    ])('%s', async (_label, postError) => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const text = 'text for the held agent'
      const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)
      await holdByDeniedRead(
        app,
        clerum,
        chatId,
        await ipcHostAccessRevoked('rpc:loadSessionMessages')
      )
      const failure = await postError()
      await act(async () => {
        post.reject(failure)
        await pendingSend
      })

      await expectInputReturnedAfterReselect(app, clerum, chatId, text)
    })

    it('held while the send waits for the activity stream, before the POST', async () => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const text = 'text held before the POST'
      const activity = deferred<() => Promise<void>>()
      const activityCallsBefore = clerum.rpc.subscribeHostActivity.mock.calls.length
      clerum.rpc.subscribeHostActivity.mockImplementationOnce(() => activity.promise)
      let pendingSend!: Promise<void>
      act(() => {
        pendingSend = app.result.current.handleSendAgentMessage(text)
      })
      await waitFor(() =>
        expect(clerum.rpc.subscribeHostActivity.mock.calls.length).toBeGreaterThan(
          activityCallsBefore
        )
      )
      await holdByDeniedRead(
        app,
        clerum,
        chatId,
        await ipcHostAccessRevoked('rpc:loadSessionMessages')
      )
      await act(async () => {
        activity.resolve(async () => undefined)
        await pendingSend
      })
      // Witness: the send stopped before its POST.
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()

      await expectInputReturnedAfterReselect(app, clerum, chatId, text)
    })

    it.each<[string, SendError]>([
      ['a network error', networkError],
      [
        'a 504',
        () =>
          ipcHttpError('rpc:invokeHostMessage', 504, 'Gateway Timeout', {
            error: 'upstream timeout',
          }),
      ],
      ['a 404', () => ipcHttpError('rpc:invokeHostMessage', 404, 'Not Found', { error: 'gone' })],
    ])(
      'held while the POST is pending, then the POST fails without a rejection: %s keeps the turn and offers the input back',
      async (_label, postError) => {
        const { app, clerum } = await boot()
        const chatId = await createChat(app)
        const text = 'text for the held agent'
        const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)
        await holdByDeniedRead(
          app,
          clerum,
          chatId,
          await ipcHostAccessRevoked('rpc:loadSessionMessages')
        )
        const failure = await postError()
        await act(async () => {
          post.reject(failure)
          await pendingSend
        })
        await reselect(app, clerum, chatId)
        const stored = await storedUserTurns(clerum, chatId, text)

        // Witness: the send reached the Host once, and its failure was retained.
        expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
        expect(app.result.current.failedAgentSend).not.toBeNull()
        expect
          .soft(stored, 'stored turn')
          .toEqual([expect.objectContaining({ preserveLocal: true })])
        expect.soft(visibleUserTurns(app, text), 'visible turn').toHaveLength(1)
        expect.soft(getComposerDraft(chatId, AGENT), 'draft').toBe('')
        expect.soft(app.result.current.failedAgentSend?.content, 'retained input').toBe(text)
        expect.soft(clerum.chat.removeMessages, 'removal').not.toHaveBeenCalled()
      }
    )

    it('held while the POST is pending, with a reference, then a network error: the kept send shows the network sentence', async () => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const text = 'text with a reference for the held agent'
      await addReference(app)
      const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)
      await holdByDeniedRead(
        app,
        clerum,
        chatId,
        await ipcHostAccessRevoked('rpc:loadSessionMessages')
      )
      const failure = await networkError()
      await act(async () => {
        post.reject(failure)
        await pendingSend
      })
      await reselect(app, clerum, chatId)
      await waitFor(() => expect(app.result.current.failedAgentSend?.content).toBe(text))
      const stored = await storedUserTurns(clerum, chatId, text)

      // Witness: the send was posted once.
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
      expect.soft(stored, 'stored turn').toEqual([expect.objectContaining({ preserveLocal: true })])
      expect.soft(clerum.chat.removeMessages, 'removal').not.toHaveBeenCalled()
      expect.soft(app.result.current.failedAgentSend?.kind, 'kind').toBe('network')
      expect.soft(app.result.current.failedAgentSend?.references, 'references').toHaveLength(1)
      expect.soft(app.result.current.agentError, 'alert').toBe(NETWORK_ALERT)
    })

    /** Starts a send whose activity subscription stays pending. */
    async function sendHeldAtStream(app: App, clerum: MockClerum, text: string) {
      const activity = deferred<() => Promise<void>>()
      const activityCallsBefore = clerum.rpc.subscribeHostActivity.mock.calls.length
      clerum.rpc.subscribeHostActivity.mockImplementationOnce(() => activity.promise)
      let pendingSend!: Promise<void>
      act(() => {
        pendingSend = app.result.current.handleSendAgentMessage(text)
      })
      // Witness: the send reached the subscription, inside the try.
      await waitFor(() =>
        expect(clerum.rpc.subscribeHostActivity.mock.calls.length).toBeGreaterThan(
          activityCallsBefore
        )
      )
      return { activity, pendingSend }
    }

    it.each<[string, SendError]>([
      ['a network error', networkError],
      ['a 403', () => ipcGenericForbidden('rpc:invokeHostMessage')],
    ])(
      'held while the activity stream opens, then the stream fails with %s: the send was never posted, so the turn is withdrawn and the text returns',
      async (_label, streamError) => {
        const { app, clerum } = await boot()
        const chatId = await createChat(app)
        const text = 'text whose stream fails while the agent is held'
        const { activity, pendingSend } = await sendHeldAtStream(app, clerum, text)
        await holdByDeniedRead(
          app,
          clerum,
          chatId,
          await ipcHostAccessRevoked('rpc:loadSessionMessages')
        )
        const failure = await streamError()
        await act(async () => {
          activity.reject(failure)
          await pendingSend
        })
        await reselect(app, clerum, chatId)
        const stored = await storedUserTurns(clerum, chatId, text)

        // Witness: nothing was posted, and the withdrawal ran.
        expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
        expect.soft(clerum.chat.removeMessages, 'removal').toHaveBeenCalledTimes(1)
        expect.soft(stored, 'stored turn').toHaveLength(0)
        expect.soft(visibleUserTurns(app, text), 'visible turn').toHaveLength(0)
        expect.soft(getComposerDraft(chatId, AGENT), 'draft').toBe(text)
        expect.soft(app.result.current.failedAgentSend, 'retained failure').toBeNull()
      }
    )

    it('held while the activity stream opens, with a reference, then the stream fails: the input waits behind Recover input under the network sentence', async () => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const text = 'text with a reference whose stream fails while held'
      await addReference(app)
      const { activity, pendingSend } = await sendHeldAtStream(app, clerum, text)
      await holdByDeniedRead(
        app,
        clerum,
        chatId,
        await ipcHostAccessRevoked('rpc:loadSessionMessages')
      )
      await act(async () => {
        activity.reject(new Error('network down'))
        await pendingSend
      })
      await reselect(app, clerum, chatId)
      await waitFor(() => expect(app.result.current.failedAgentSend?.content).toBe(text))
      const stored = await storedUserTurns(clerum, chatId, text)

      // Witness: nothing was posted.
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      expect.soft(clerum.chat.removeMessages, 'removal').toHaveBeenCalledTimes(1)
      expect.soft(stored, 'stored turn').toHaveLength(0)
      expect.soft(getComposerDraft(chatId, AGENT), 'draft').toBe('')
      expect.soft(app.result.current.failedAgentSend?.references, 'references').toHaveLength(1)
      expect.soft(app.result.current.failedAgentSend?.kind, 'kind').toBe('network')
      expect.soft(app.result.current.failedAgentSend?.message, 'detail').toBe('network down')
      expect.soft(app.result.current.agentError, 'alert').toBe(NETWORK_ALERT)
    })
  })

  describe('T-A6: the composer changed while the POST was pending', () => {
    it("a new draft in the send's chat stays, and the rejected input is retained", async () => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const text = 'text rejected after a new draft'
      const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)
      act(() => {
        setComposerDraft(chatId, 'a newer draft', AGENT)
      })
      const rejection = await ipcGenericForbidden('rpc:invokeHostMessage')
      await act(async () => {
        post.reject(rejection)
        await pendingSend
      })

      expect.soft(getComposerDraft(chatId, AGENT), 'draft').toBe('a newer draft')
      await waitFor(() => expect(app.result.current.failedAgentSend?.content).toBe(text))
      const toastsBefore = app.result.current.toasts.length
      act(() => {
        app.result.current.handleRecoverFailedAgentSend()
      })
      expect(app.result.current.toasts.slice(toastsBefore).map(toast => toast.text)).toEqual([
        'Keep or clear the current draft before recovering the earlier input.',
      ])
    })

    it.each([
      { payload: 'text and a reference', withReference: true },
      { payload: 'text only', withReference: false },
    ])(
      'a send from chat A rejected while chat B of the same agent is shown: $payload',
      async ({ withReference }) => {
        const { app, clerum } = await boot()
        const chatB = await createChat(app)
        const chatA = await createChat(app)
        expect(chatA).not.toBe(chatB)
        const text = 'text from chat A'
        if (withReference) await addReference(app)
        const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)
        await act(async () => {
          await app.result.current.handleSelectChat(chatB)
        })
        await waitFor(() => expect(app.result.current.activeChatId).toBe(chatB))
        const referencesOnB = app.result.current.composerReferenceAttachments.map(
          reference => reference.id
        )
        const rejection = await ipcGenericForbidden('rpc:invokeHostMessage')
        await act(async () => {
          post.reject(rejection)
          await pendingSend
        })

        expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
        expect
          .soft(
            app.result.current.composerReferenceAttachments.map(reference => reference.id),
            'composer on chat B'
          )
          .toEqual(referencesOnB)
        if (!withReference) {
          expect.soft(getComposerDraft(chatA, AGENT), 'draft of chat A').toBe(text)
          await act(async () => {
            await app.result.current.handleSelectChat(chatA)
          })
          await waitFor(() => expect(app.result.current.activeChatId).toBe(chatA))
          expect.soft(app.result.current.failedAgentSend, 'nothing retained').toBeNull()
          return
        }
        expect.soft(getComposerDraft(chatA, AGENT), 'draft of chat A').toBe('')
        await act(async () => {
          await app.result.current.handleSelectChat(chatA)
        })
        await waitFor(() => expect(app.result.current.activeChatId).toBe(chatA))
        // Witness: the reference is in the retained failure.
        await waitFor(() => expect(app.result.current.failedAgentSend?.content).toBe(text))
        expect(
          app.result.current.failedAgentSend?.references.map(reference => reference.id)
        ).toEqual([REFERENCE.id])
      }
    )
  })

  describe('T-A7: a Retry answered with a 401', () => {
    it.each([
      { composer: 'empty', draft: '' },
      { composer: 'with a draft', draft: 'a draft typed after the failure' },
    ])('composer $composer', async ({ draft }) => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const text = 'text retried after a network failure'
      clerum.rpc.invokeHostMessage.mockRejectedValueOnce(await networkError())
      await send(app, text)
      await waitFor(() => expect(app.result.current.failedAgentSend?.content).toBe(text))
      if (draft) {
        act(() => {
          setComposerDraft(chatId, draft, AGENT)
        })
      }
      clerum.rpc.invokeHostMessage.mockRejectedValueOnce(await http401())
      await act(async () => {
        await app.result.current.handleRetryFailedAgentSend()
      })

      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(2)
      expect.soft(app.result.current.selectedAgent, 'selected agent').toBe(AGENT)
      if (!draft) {
        expect.soft(getComposerDraft(chatId, AGENT), 'draft').toBe(text)
        expect.soft(app.result.current.failedAgentSend, 'failed send').toBeNull()
        return
      }
      expect.soft(getComposerDraft(chatId, AGENT), 'draft').toBe(draft)
      await waitFor(() => expect(app.result.current.failedAgentSend?.content).toBe(text))
    })
  })

  it('T-A8: a removal the store refuses fails loud and keeps the turn, also through a later reconcile', async () => {
    const { app, clerum } = await boot()
    const chatId = await createChatWithServerTurn(app, clerum)
    const text = 'text whose withdrawal is refused'
    const warn = vi.spyOn(console, 'warn')
    const storeFault = new Error('local chat store unavailable')
    clerum.chat.removeMessages.mockRejectedValueOnce(storeFault)
    let streamOpenAtPost = false
    clerum.rpc.invokeHostMessage.mockImplementationOnce(async () => {
      streamOpenAtPost = clerum.hasActivityHandler(AGENT)
      throw await ipcGenericForbidden('rpc:invokeHostMessage')
    })
    const toastsBefore = app.result.current.toasts.length

    await send(app, text)

    // Witness: the removal was asked for.
    expect(clerum.chat.removeMessages).toHaveBeenCalledTimes(1)
    const turnId = writtenTurnId(clerum, chatId, text)
    expect.soft(getComposerDraft(chatId, AGENT), 'draft').toBe(text)
    expect.soft(visibleUserTurns(app, text), 'visible turn').toHaveLength(1)
    expect.soft(await storedUserTurns(clerum, chatId, text), 'stored turn').toHaveLength(1)
    const activity = app.result.current.activityByMessageId as Record<string, { status: string }>
    expect.soft(activity[turnId]?.status, 'activity entry').toBe('error')
    expect.soft(streamOpenAtPost, 'stream open during the send').toBe(true)
    await waitFor(() => expect(clerum.hasActivityHandler(AGENT)).toBe(false))
    const added = app.result.current.toasts.slice(toastsBefore)
    expect.soft(added, 'toasts').toHaveLength(1)
    expect.soft(added[0]?.tone, 'toast tone').toBe('error')
    const warning = warn.mock.calls.find(
      ([label]) => label === '[chat-history] failed to withdraw a rejected message'
    )
    expect.soft(warning?.[1], 'warning').toEqual({ agentRef: AGENT, chatId, error: storeFault })
    expect.soft(JSON.stringify(warning?.[1] ?? null), 'warning text').not.toContain(text)

    // A later reconcile with new server turns keeps the refused turn visible.
    const replaceCallsBefore = clerum.chat.replaceMessages.mock.calls.length
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: AGENT,
      chatId,
      state: 'idle',
      totalTurns: 2,
      turns: [
        serverTurn(1, 'first question', 'first answer'),
        serverTurn(2, 'second question', 'second answer'),
      ],
    })
    await act(async () => {
      await app.result.current.handleSelectChat(chatId)
    })
    await waitFor(() =>
      expect(app.result.current.chatMessages.map(message => message.content)).toContain(
        'second answer'
      )
    )
    // Witness: the reconcile wrote its list.
    expect(clerum.chat.replaceMessages.mock.calls.length).toBeGreaterThan(replaceCallsBefore)
    expect.soft(visibleUserTurns(app, text), 'visible turn after the reconcile').toHaveLength(1)
  })

  it('T-A9: a loss of access answered after the chat was deleted', async () => {
    const { app, clerum } = await boot()
    const chatId = await createChat(app)
    const text = 'text for a chat deleted during the send'
    const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)
    const deletion = await app.result.current.captureChatDeleteFence(AGENT)
    await act(async () => {
      await app.result.current.handleDeleteChatForAgent(AGENT, chatId, deletion)
    })
    expect(clerum.chat.delete).toHaveBeenCalledTimes(1)
    const denial = await ipcHostAccessRevoked('rpc:invokeHostMessage')
    await act(async () => {
      post.reject(denial)
      await pendingSend
    })

    // Witness: the revoke ran.
    await waitFor(() => expect(app.result.current.isHostAccessBlocked(AGENT)).toBe(true))
    expect.soft(getComposerDraft(chatId, AGENT), 'draft of the deleted chat').toBe('')
    expect.soft(clerum.chat.removeMessages, 'removal').not.toHaveBeenCalled()
  })

  describe('T-A15: a send whose chat was deleted releases the activity stream', () => {
    async function deleteChat(app: App, chatId: string) {
      const deletion = await app.result.current.captureChatDeleteFence(AGENT)
      await act(async () => {
        await app.result.current.handleDeleteChatForAgent(AGENT, chatId, deletion)
      })
    }

    it.each<[string, SendError | null]>([
      ['a 401', http401],
      ['a 403 whose read is not denied', () => ipcGenericForbidden('rpc:invokeHostMessage')],
      ['a network error', networkError],
      ['an accepted POST', null],
    ])('%s', async (_label, postError) => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const text = 'text for a chat deleted during the send'
      const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)
      // Witness: the send opened the stream.
      expect(clerum.hasActivityHandler(AGENT)).toBe(true)
      await deleteChat(app, chatId)
      expect(clerum.chat.delete).toHaveBeenCalledTimes(1)
      const failure = postError ? await postError() : null
      await act(async () => {
        if (failure) post.reject(failure)
        else (post.resolve as (value: unknown) => void)({ taskId: 'task-after-delete' })
        await pendingSend
      })

      await waitFor(() => expect(clerum.hasActivityHandler(AGENT)).toBe(false))
      expect.soft(app.result.current.isHostAccessBlocked(AGENT), 'blocked').toBe(false)
    })

    it('deleted while the send waits for the activity stream, before the POST', async () => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const activity = deferred<() => Promise<void>>()
      const activityCallsBefore = clerum.rpc.subscribeHostActivity.mock.calls.length
      clerum.rpc.subscribeHostActivity.mockImplementationOnce(() => activity.promise)
      let pendingSend!: Promise<void>
      act(() => {
        pendingSend = app.result.current.handleSendAgentMessage('text deleted before the POST')
      })
      await waitFor(() =>
        expect(clerum.rpc.subscribeHostActivity.mock.calls.length).toBeGreaterThan(
          activityCallsBefore
        )
      )
      await deleteChat(app, chatId)
      let streamOpen = true
      await act(async () => {
        activity.resolve(async () => {
          streamOpen = false
        })
        await pendingSend
      })

      // Witness: the send stopped before its POST.
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      await waitFor(() => expect(streamOpen).toBe(false))
    })

    it('a send accepted as a task keeps the activity stream open (control)', async () => {
      const { app, clerum } = await boot()
      await createChat(app)
      clerum.rpc.invokeHostMessage.mockResolvedValueOnce({ taskId: 'task-running' })
      await send(app, 'text for a running task')
      // Witness: the task is tracked.
      await waitFor(() => expect(clerum.hasProgressHandler('task-running')).toBe(true))
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(clerum.hasActivityHandler(AGENT)).toBe(true)
    })
  })

  it('T-A10: a rejection that persists returns the text on every send', async () => {
    const { app, clerum } = await boot()
    const chatId = await createChat(app)
    const text = 'text the server keeps rejecting'
    const toastsBefore = app.result.current.toasts.length
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      clerum.rpc.invokeHostMessage.mockRejectedValueOnce(
        await ipcGenericForbidden('rpc:invokeHostMessage')
      )
      await send(app, text)
      expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(attempt)
      expect.soft(getComposerDraft(chatId, AGENT), `attempt ${attempt}: draft`).toBe(text)
      await waitFor(async () =>
        expect
          .soft(await storedUserTurns(clerum, chatId, text), `attempt ${attempt}: stored turn`)
          .toHaveLength(0)
      )
      expect.soft(visibleUserTurns(app, text), `attempt ${attempt}: visible turn`).toHaveLength(0)
      expect.soft(app.result.current.selectedAgent, `attempt ${attempt}: agent`).toBe(AGENT)
      expect.soft(app.result.current.failedAgentSend, `attempt ${attempt}: failed`).toBeNull()
      expect.soft(app.result.current.agentError, `attempt ${attempt}: error`).toBeNull()
    }
    expect.soft(app.result.current.toasts.slice(toastsBefore), 'toasts').toEqual([])
  })

  describe('T-A11: the scope changes while the removal is pending', () => {
    it('a 401 followed by a logout', async () => {
      const { app, clerum, handle } = await boot()
      const signedInState = handle.getSessionState.getMockImplementation() as
        | (() => Promise<unknown>)
        | undefined
      if (!signedInState) throw new Error('The harness session state producer is unavailable')
      let signedIn = true
      handle.getSessionState.mockImplementation(async () =>
        signedIn ? signedInState() : { authenticated: false, me: null }
      )
      handle.logout.mockImplementation(async () => {
        signedIn = false
        return { ok: true, sessionGeneration: 2 }
      })
      const chatId = await createChat(app)
      const text = 'text rejected before a logout'
      const removal = deferred<number>()
      clerum.chat.removeMessages.mockImplementationOnce(() => removal.promise)
      clerum.rpc.invokeHostMessage.mockRejectedValueOnce(await http401())
      let pendingSend!: Promise<void>
      act(() => {
        pendingSend = app.result.current.handleSendAgentMessage(text)
      })
      await waitFor(() => expect(clerum.chat.removeMessages).toHaveBeenCalledTimes(1))
      await act(async () => app.result.current.handleLogout())
      await waitFor(() => expect(app.result.current.isAuthenticated).toBe(false))
      const toastsBefore = app.result.current.toasts.length
      const messagesBefore = app.result.current.chatMessages
      await act(async () => {
        removal.resolve(1)
        await pendingSend
      })

      // Witness: the removal was asked for and has settled.
      expect(clerum.chat.removeMessages).toHaveBeenCalledTimes(1)
      expect.soft(getComposerDraft(chatId, AGENT), 'draft').toBe('')
      expect.soft(app.result.current.isHostAccessBlocked(AGENT), 'blocked').toBe(false)
      expect.soft(app.result.current.toasts.slice(toastsBefore), 'toasts').toEqual([])
      expect.soft(app.result.current.chatMessages, 'messages').toBe(messagesBefore)
    })

    it('host_access_revoked followed by a team switch', async () => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const text = 'text revoked before a team switch'
      const removal = deferred<number>()
      clerum.chat.removeMessages.mockImplementationOnce(() => removal.promise)
      clerum.rpc.invokeHostMessage.mockRejectedValueOnce(
        await ipcHostAccessRevoked('rpc:invokeHostMessage')
      )
      let pendingSend!: Promise<void>
      act(() => {
        pendingSend = app.result.current.handleSendAgentMessage(text)
      })
      await waitFor(() => expect(clerum.chat.removeMessages).toHaveBeenCalledTimes(1))
      const draftBeforeSwitch = getComposerDraft(chatId, AGENT)
      await act(async () => {
        await app.result.current.handleEnsureTeamContext({ teamId: 'team-2' })
      })
      await waitFor(() => expect(app.result.current.isHostAccessBlocked(AGENT)).toBe(false))
      const toastsBefore = app.result.current.toasts.length
      const messagesBefore = app.result.current.chatMessages
      await act(async () => {
        removal.resolve(1)
        await pendingSend
      })

      // Witness: the removal was asked for and has settled.
      expect(clerum.chat.removeMessages).toHaveBeenCalledTimes(1)
      expect.soft(getComposerDraft(chatId, AGENT), 'draft').toBe(draftBeforeSwitch)
      expect.soft(app.result.current.isHostAccessBlocked(AGENT), 'blocked').toBe(false)
      expect.soft(app.result.current.toasts.slice(toastsBefore), 'toasts').toEqual([])
      expect.soft(app.result.current.chatMessages, 'messages').toBe(messagesBefore)
    })

    it('a 401 whose removal is refused after a logout', async () => {
      const { app, clerum, handle } = await boot()
      const signedInState = handle.getSessionState.getMockImplementation() as
        | (() => Promise<unknown>)
        | undefined
      if (!signedInState) throw new Error('The harness session state producer is unavailable')
      let signedIn = true
      handle.getSessionState.mockImplementation(async () =>
        signedIn ? signedInState() : { authenticated: false, me: null }
      )
      handle.logout.mockImplementation(async () => {
        signedIn = false
        return { ok: true, sessionGeneration: 2 }
      })
      await createChat(app)
      const text = 'text whose withdrawal is refused after a logout'
      const warn = vi.spyOn(console, 'warn')
      const removal = deferred<number>()
      clerum.chat.removeMessages.mockImplementationOnce(() => removal.promise)
      clerum.rpc.invokeHostMessage.mockRejectedValueOnce(await http401())
      let pendingSend!: Promise<void>
      act(() => {
        pendingSend = app.result.current.handleSendAgentMessage(text)
      })
      await waitFor(() => expect(clerum.chat.removeMessages).toHaveBeenCalledTimes(1))
      await act(async () => app.result.current.handleLogout())
      await waitFor(() => expect(app.result.current.isAuthenticated).toBe(false))
      const toastsBefore = app.result.current.toasts.length
      await act(async () => {
        removal.reject(new Error('local chat store unavailable'))
        await pendingSend
      })

      // Witness: the refusal was handled (its warning was logged).
      expect(
        warn.mock.calls.filter(
          ([label]) => label === '[chat-history] failed to withdraw a rejected message'
        )
      ).toHaveLength(1)
      expect(app.result.current.toasts.slice(toastsBefore)).toEqual([])
    })
  })

  describe('T-A12: a reconcile in flight at the rejection', () => {
    const secondWindow = {
      agent: AGENT,
      state: 'idle',
      totalTurns: 2,
      turns: [
        serverTurn(1, 'first question', 'first answer'),
        serverTurn(2, 'second question', 'second answer'),
      ],
    }

    it.each([
      { order: 'the reconcile writes after the rejection', writeFirst: false },
      { order: 'the reconcile writes before the rejection', writeFirst: true },
    ])('$order', async ({ writeFirst }) => {
      const { app, clerum } = await boot()
      const chatId = await createChatWithServerTurn(app, clerum)
      clerum.chat.replaceMessages.mockImplementation(clerum.replaceStoredMessages)
      const text = 'text rejected during a reconcile'
      const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)

      // The reconcile response is delivered while the POST is pending, and the
      // hydrate is held where it creates the chat before writing.
      const create = deferred<void>()
      const createChat = clerum.chat.create.getMockImplementation()!
      clerum.chat.create.mockImplementationOnce(async (agentRef: string, id: string) => {
        await create.promise
        return createChat(agentRef, id)
      })
      clerum.rpc.loadSessionMessages.mockResolvedValue({ ...secondWindow, chatId })
      const createCallsBefore = clerum.chat.create.mock.calls.length
      let reconcile!: Promise<void>
      act(() => {
        reconcile = app.result.current.handleSelectChat(chatId) as Promise<void>
      })
      await waitFor(() =>
        expect(clerum.chat.create.mock.calls.length).toBeGreaterThan(createCallsBefore)
      )
      const replaceCallsBefore = clerum.chat.replaceMessages.mock.calls.length
      if (writeFirst) {
        await act(async () => {
          create.resolve()
          await reconcile
        })
        // The reconcile stored the pending turn before numbered server turns.
        expect(
          (await clerum.persistedMessages(AGENT, chatId)).map(message =>
            message.role === 'user' && message.content === text ? 'pending' : message.id
          )
        ).toEqual(['turn-1-user', 'turn-1-assistant', 'pending', 'turn-2-user', 'turn-2-assistant'])
      }
      const rejection = await ipcGenericForbidden('rpc:invokeHostMessage')
      await act(async () => {
        post.reject(rejection)
        await pendingSend
      })
      if (!writeFirst) {
        await act(async () => {
          create.resolve()
          await reconcile
        })
      }

      // Witness: the reconcile wrote a list holding the server turns.
      const replaceCalls = clerum.chat.replaceMessages.mock.calls.slice(
        writeFirst ? replaceCallsBefore - 1 : replaceCallsBefore
      )
      expect(
        replaceCalls.some(([, , messages]) =>
          (messages as Array<{ id: string }>).some(message => message.id === 'turn-2-assistant')
        )
      ).toBe(true)
      await expectTurnWithdrawnAndServerTurnsKept(app, clerum, chatId, text)
      expect
        .soft(
          app.result.current.chatMessages.map(message => message.content),
          'visible server turns'
        )
        .toEqual(['first question', 'first answer', 'second question', 'second answer'])
    })

    async function expectTurnWithdrawnAndServerTurnsKept(
      app: App,
      clerum: MockClerum,
      chatId: string,
      text: string
    ) {
      expect.soft(getComposerDraft(chatId, AGENT), 'draft').toBe(text)
      await waitFor(() =>
        expect(app.result.current.chatMessages.map(message => message.content)).toContain(
          'second answer'
        )
      )
      expect.soft(visibleUserTurns(app, text), 'visible turn').toHaveLength(0)
      expect.soft(await storedUserTurns(clerum, chatId, text), 'stored turn').toHaveLength(0)
      expect
        .soft(
          (await clerum.persistedMessages(AGENT, chatId)).map(message => message.id),
          'stored server turns'
        )
        .toEqual(['turn-1-user', 'turn-1-assistant', 'turn-2-user', 'turn-2-assistant'])
    }

    it('the rejection lands after the hydrate read the local page and before it merged', async () => {
      const { app, clerum } = await boot()
      const chatId = await createChatWithServerTurn(app, clerum)
      clerum.chat.replaceMessages.mockImplementation(clerum.replaceStoredMessages)
      const text = 'text rejected while the hydrate reads'
      const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)

      // The hydrate's own read of the local page (the first one after the
      // server window arrives) returns what the store held when it was read,
      // which still includes the pending turn, but only once the gate opens.
      const localRead = deferred<void>()
      let localPageRead = false
      let serverWindowSent = false
      const loadLocal = clerum.chat.loadMessages.getMockImplementation()!
      clerum.chat.loadMessages.mockImplementation(async (...args: unknown[]) => {
        const page = await loadLocal(...args)
        if (!serverWindowSent || localPageRead) return page
        localPageRead = true
        await localRead.promise
        return page
      })
      clerum.rpc.loadSessionMessages.mockImplementation(async () => {
        serverWindowSent = true
        return { ...secondWindow, chatId }
      })
      let reconcile!: Promise<void>
      act(() => {
        reconcile = app.result.current.handleSelectChat(chatId) as Promise<void>
      })
      await waitFor(() => expect(localPageRead).toBe(true))
      const rejection = await ipcGenericForbidden('rpc:invokeHostMessage')
      await act(async () => {
        post.reject(rejection)
        await pendingSend
      })
      // Witness: the withdrawal finished before the hydrate merged.
      expect(await storedUserTurns(clerum, chatId, text)).toHaveLength(0)
      const replaceCallsBefore = clerum.chat.replaceMessages.mock.calls.length
      await act(async () => {
        localRead.resolve()
        await reconcile
      })

      // Witness: the hydrate wrote its merged list.
      expect(clerum.chat.replaceMessages.mock.calls.length).toBeGreaterThan(replaceCallsBefore)
      await expectTurnWithdrawnAndServerTurnsKept(app, clerum, chatId, text)
    })

    it('the hydrate writes while the removal is still pending in the renderer', async () => {
      const { app, clerum } = await boot()
      const chatId = await createChatWithServerTurn(app, clerum)
      clerum.chat.replaceMessages.mockImplementation(clerum.replaceStoredMessages)
      const text = 'text rejected while its removal is pending'
      const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)

      // The server window is requested first and held, so the switch has read
      // its local page before the rejection.
      const serverWindow = deferred<void>()
      clerum.rpc.loadSessionMessages.mockImplementation(async () => {
        await serverWindow.promise
        return { ...secondWindow, chatId }
      })
      const windowCallsBefore = clerum.rpc.loadSessionMessages.mock.calls.length
      let reconcile!: Promise<void>
      act(() => {
        reconcile = app.result.current.handleSelectChat(chatId) as Promise<void>
      })
      await waitFor(() =>
        expect(clerum.rpc.loadSessionMessages.mock.calls.length).toBeGreaterThan(windowCallsBefore)
      )

      // Main applies the removal, but its reply has not reached the renderer.
      const removalReply = deferred<void>()
      const removeStored = clerum.chat.removeMessages.getMockImplementation()!
      clerum.chat.removeMessages.mockImplementationOnce(async (...args: unknown[]) => {
        const removed = await removeStored(...args)
        await removalReply.promise
        return removed
      })
      const rejection = await ipcGenericForbidden('rpc:invokeHostMessage')
      let rejectionHandled!: Promise<void>
      act(() => {
        post.reject(rejection)
        rejectionHandled = pendingSend
      })
      await waitFor(() => expect(clerum.chat.removeMessages).toHaveBeenCalledTimes(1))
      await waitFor(async () => expect(await storedUserTurns(clerum, chatId, text)).toHaveLength(0))
      const replaceCallsBefore = clerum.chat.replaceMessages.mock.calls.length
      await act(async () => {
        serverWindow.resolve()
        await reconcile
      })
      // Witness: the hydrate wrote while the removal reply was still pending.
      expect(clerum.chat.replaceMessages.mock.calls.length).toBeGreaterThan(replaceCallsBefore)
      await act(async () => {
        removalReply.resolve()
        await rejectionHandled
      })

      await expectTurnWithdrawnAndServerTurnsKept(app, clerum, chatId, text)
    })
  })

  it('T-A13: held by another path during the follow-up read', async () => {
    const { app, clerum } = await boot()
    const chatId = await createChat(app)
    const text = 'text whose follow-up read is overtaken'
    const followUp = deferred<{ items: never[] }>()
    clerum.rpc.listSessions.mockImplementation(async (_hostRef, _hostRefs, query) =>
      isFollowUpRead(query) ? followUp.promise : { items: [] }
    )
    clerum.rpc.invokeHostMessage.mockRejectedValueOnce(
      await ipcGenericForbidden('rpc:invokeHostMessage')
    )
    let pendingSend!: Promise<void>
    act(() => {
      pendingSend = app.result.current.handleSendAgentMessage(text)
    })
    await waitFor(() =>
      expect(clerum.rpc.listSessions.mock.calls.some(([, , query]) => isFollowUpRead(query))).toBe(
        true
      )
    )
    await holdByDeniedRead(
      app,
      clerum,
      chatId,
      await ipcHostAccessDenied('rpc:loadSessionMessages')
    )
    await act(async () => {
      followUp.resolve({ items: [] })
      await pendingSend
    })

    // Witness: the send was answered once and made its follow-up read.
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    await expectInputReturnedAfterReselect(app, clerum, chatId, text)
  })

  describe('T-A14: the alert of a send kept behind Recover input', () => {
    it('a loss of access with a reference', async () => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const text = 'text sent as access is lost'
      await addReference(app)
      clerum.rpc.invokeHostMessage.mockRejectedValueOnce(
        await ipcHostAccessRevoked('rpc:invokeHostMessage')
      )
      await send(app, text)
      await waitFor(() => expect(app.result.current.selectedAgent).toBeNull())
      await reselect(app, clerum, chatId)
      // Witness: the retained failure is the visible one and keeps the raw detail.
      await waitFor(() => expect(app.result.current.failedAgentSend?.content).toBe(text))
      expect
        .soft(app.result.current.failedAgentSend?.message, 'technical detail')
        .toContain('host_access_revoked')
      expect.soft(app.result.current.agentError, 'alert').toBe(AUTH_ALERT)
    })

    it('a generic rejection after the draft changed', async () => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const text = 'text rejected after a new draft'
      const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)
      act(() => {
        setComposerDraft(chatId, 'a newer draft', AGENT)
      })
      const rejection = await ipcGenericForbidden('rpc:invokeHostMessage')
      await act(async () => {
        post.reject(rejection)
        await pendingSend
      })
      // Witness: the retained failure is the visible one.
      await waitFor(() => expect(app.result.current.failedAgentSend?.content).toBe(text))
      expect.soft(app.result.current.failedAgentSend?.message, 'technical detail').toContain('403')
      expect.soft(app.result.current.agentError, 'alert').toBe(AUTH_ALERT)
    })

    it('an agent held before the POST, with a reference', async () => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const text = 'text held before the POST'
      await addReference(app)
      const activity = deferred<() => Promise<void>>()
      const activityCallsBefore = clerum.rpc.subscribeHostActivity.mock.calls.length
      clerum.rpc.subscribeHostActivity.mockImplementationOnce(() => activity.promise)
      let pendingSend!: Promise<void>
      act(() => {
        pendingSend = app.result.current.handleSendAgentMessage(text)
      })
      await waitFor(() =>
        expect(clerum.rpc.subscribeHostActivity.mock.calls.length).toBeGreaterThan(
          activityCallsBefore
        )
      )
      await holdByDeniedRead(
        app,
        clerum,
        chatId,
        await ipcHostAccessRevoked('rpc:loadSessionMessages')
      )
      await act(async () => {
        activity.resolve(async () => undefined)
        await pendingSend
      })
      // Witness: the send stopped before its POST, and its input is the visible failure.
      expect(clerum.rpc.invokeHostMessage).not.toHaveBeenCalled()
      await reselect(app, clerum, chatId)
      await waitFor(() => expect(app.result.current.failedAgentSend?.content).toBe(text))
      expect.soft(app.result.current.agentError, 'alert').toBe(AUTH_ALERT)
    })

    it('a network failure, after the user resumed typing', async () => {
      const { app, clerum } = await boot()
      await createChat(app)
      const text = 'text that fails to send'
      clerum.rpc.invokeHostMessage.mockRejectedValueOnce(await networkError())
      await send(app, text)
      await waitFor(() => expect(app.result.current.failedAgentSend?.content).toBe(text))
      expect.soft(app.result.current.agentError, 'alert at the failure').toBe(NETWORK_ALERT)
      act(() => app.result.current.clearComposerSendError())
      // Witness: the retained failure is still the visible one.
      expect(app.result.current.failedAgentSend?.content).toBe(text)
      expect.soft(app.result.current.agentError, 'alert after typing').toBe(NETWORK_ALERT)
    })

    it('a synchronous error envelope keeps the text the Host sent (control)', async () => {
      const { app, clerum } = await boot()
      await createChat(app)
      const text = 'text the Host answers with an error'
      clerum.rpc.invokeHostMessage.mockResolvedValueOnce({
        error: { message: 'The model is overloaded.', code: 'LLM_MODEL_OVERLOADED' },
      })
      await send(app, text)
      // Witness: the retained failure is the visible one.
      await waitFor(() => expect(app.result.current.failedAgentSend?.content).toBe(text))
      expect(app.result.current.agentError).toBe('The model is overloaded.')
    })
  })

  it('T-A16:an older page loaded while the removal is pending does not write the turn back', async () => {
    const { app, clerum } = await boot()
    const chatId = await createChat(app)
    // The newest window holds turns 2 and 3, so turn 1 is an older page.
    clerum.rpc.loadSessionMessages.mockResolvedValue({
      agent: AGENT,
      chatId,
      state: 'idle',
      totalTurns: 3,
      turns: [
        serverTurn(2, 'second question', 'second answer'),
        serverTurn(3, 'third question', 'third answer'),
      ],
    })
    await act(async () => {
      await app.result.current.handleSelectChat(chatId)
    })
    await waitFor(() =>
      expect(app.result.current.chatMessages.map(message => message.content)).toEqual([
        'second question',
        'second answer',
        'third question',
        'third answer',
      ])
    )
    await waitFor(() => expect(app.result.current.hasOlderMessages).toBe(true))
    clerum.chat.replaceMessages.mockImplementation(clerum.replaceStoredMessages)
    const text = 'text rejected while an older page loads'
    const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)

    // The older page is requested and held.
    const olderPage = deferred<void>()
    const hasBeforeTurn = (args: unknown[]) =>
      args.some(arg => typeof arg === 'object' && arg !== null && 'beforeTurn' in arg)
    clerum.rpc.loadSessionMessages.mockImplementation(async (...args: unknown[]) => {
      if (!hasBeforeTurn(args)) {
        return { agent: AGENT, chatId, state: 'idle', totalTurns: 3, turns: [] }
      }
      await olderPage.promise
      return {
        agent: AGENT,
        chatId,
        state: 'idle',
        totalTurns: 3,
        turns: [serverTurn(1, 'first question', 'first answer')],
      }
    })
    let backfill!: Promise<void>
    act(() => {
      backfill = app.result.current.handleLoadOlderMessages() as Promise<void>
    })
    await waitFor(() =>
      expect(clerum.rpc.loadSessionMessages.mock.calls.some(call => hasBeforeTurn(call))).toBe(true)
    )

    // Main applies the removal, but its reply has not reached the renderer.
    const removalReply = deferred<void>()
    const removeStored = clerum.chat.removeMessages.getMockImplementation()!
    clerum.chat.removeMessages.mockImplementationOnce(async (...args: unknown[]) => {
      const removed = await removeStored(...args)
      await removalReply.promise
      return removed
    })
    const rejection = await ipcGenericForbidden('rpc:invokeHostMessage')
    let rejectionHandled!: Promise<void>
    act(() => {
      post.reject(rejection)
      rejectionHandled = pendingSend
    })
    await waitFor(() => expect(clerum.chat.removeMessages).toHaveBeenCalledTimes(1))
    await waitFor(async () => expect(await storedUserTurns(clerum, chatId, text)).toHaveLength(0))
    // Witness: the turn is still in the visible list the backfill merges onto.
    expect(visibleUserTurns(app, text)).toHaveLength(1)
    const replaceCallsBefore = clerum.chat.replaceMessages.mock.calls.length
    await act(async () => {
      olderPage.resolve()
      await backfill
    })
    // Witness: the backfill wrote a list holding the older turn.
    const backfillWrites = clerum.chat.replaceMessages.mock.calls.slice(replaceCallsBefore)
    expect(
      backfillWrites.some(([, , messages]) =>
        (messages as Array<{ id: string }>).some(message => message.id === 'turn-1-user')
      )
    ).toBe(true)
    await act(async () => {
      removalReply.resolve()
      await rejectionHandled
    })

    expect.soft(await storedUserTurns(clerum, chatId, text), 'stored turn').toHaveLength(0)
    expect.soft(visibleUserTurns(app, text), 'visible turn').toHaveLength(0)
    expect.soft(getComposerDraft(chatId, AGENT), 'draft').toBe(text)
  })

  it('T-A17: a turn withdrawn while its chat is hidden does not come back from memory', async () => {
    const { app, clerum } = await boot()
    const chatB = await createChat(app)
    const chatA = await createChat(app)
    const text = 'text from chat A'
    const warn = vi.spyOn(console, 'warn')
    const localReadFailures = () =>
      warn.mock.calls.filter(([label]) => label === '[chat-history] failed to load local messages')
        .length
    const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)
    await waitFor(() => expect(visibleUserTurns(app, text)).toHaveLength(1))
    const selectChat = async (chatId: string) => {
      await act(async () => {
        await app.result.current.handleSelectChat(chatId)
      })
      await waitFor(() => expect(app.result.current.activeChatId).toBe(chatId))
    }
    const loadLocal = clerum.chat.loadMessages.getMockImplementation()!
    const failNextLocalReadOf = (chatId: string) => {
      let failed = false
      clerum.chat.loadMessages.mockImplementation(async (...args: unknown[]) => {
        if (!failed && args[1] === chatId) {
          failed = true
          throw new Error('local chat store unavailable')
        }
        return loadLocal(...args)
      })
    }

    // Witness: with a failed local read, the remembered transcript is what is
    // shown. The pending turn comes back from memory while the send is pending.
    await selectChat(chatB)
    failNextLocalReadOf(chatA)
    await selectChat(chatA)
    expect(localReadFailures()).toBe(1)
    expect(visibleUserTurns(app, text), 'remembered while pending').toHaveLength(1)
    clerum.chat.loadMessages.mockImplementation(loadLocal)

    await selectChat(chatB)
    const rejection = await ipcGenericForbidden('rpc:invokeHostMessage')
    await act(async () => {
      post.reject(rejection)
      await pendingSend
    })
    // Witness: the turn was withdrawn while chat B was shown.
    expect(clerum.chat.removeMessages).toHaveBeenCalledTimes(1)
    expect(await storedUserTurns(clerum, chatA, text)).toHaveLength(0)

    // The server window stays pending, so only the first paint is observed.
    const serverWindow = deferred<never>()
    clerum.rpc.loadSessionMessages.mockImplementation(() => serverWindow.promise)
    failNextLocalReadOf(chatA)
    act(() => {
      void app.result.current.handleSelectChat(chatA)
    })
    await waitFor(() => expect(app.result.current.activeChatId).toBe(chatA))
    await waitFor(() => expect(localReadFailures()).toBe(2))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(visibleUserTurns(app, text), 'visible turn on return').toHaveLength(0)
    clerum.chat.loadMessages.mockImplementation(loadLocal)
  })

  it('T-A18: a logout during the follow-up read leaves the draft store and the turn alone', async () => {
    const { app, clerum, handle } = await boot()
    const signedInState = handle.getSessionState.getMockImplementation() as
      | (() => Promise<unknown>)
      | undefined
    if (!signedInState) throw new Error('The harness session state producer is unavailable')
    let signedIn = true
    handle.getSessionState.mockImplementation(async () =>
      signedIn ? signedInState() : { authenticated: false, me: null }
    )
    handle.logout.mockImplementation(async () => {
      signedIn = false
      return { ok: true, sessionGeneration: 2 }
    })
    const chatId = await createChat(app)
    const text = 'text rejected before a logout during the read'
    const followUp = deferred<{ items: never[] }>()
    clerum.rpc.listSessions.mockImplementation(async (_hostRef, _hostRefs, query) =>
      isFollowUpRead(query) ? followUp.promise : { items: [] }
    )
    clerum.rpc.invokeHostMessage.mockRejectedValueOnce(
      await ipcGenericForbidden('rpc:invokeHostMessage')
    )
    let pendingSend!: Promise<void>
    act(() => {
      pendingSend = app.result.current.handleSendAgentMessage(text)
    })
    await waitFor(() =>
      expect(clerum.rpc.listSessions.mock.calls.some(([, , query]) => isFollowUpRead(query))).toBe(
        true
      )
    )
    await act(async () => app.result.current.handleLogout())
    await waitFor(() => expect(app.result.current.isAuthenticated).toBe(false))
    // Witness: the logout cleared the draft store.
    expect(getComposerDraft(chatId, AGENT)).toBe('')
    await act(async () => {
      followUp.resolve({ items: [] })
      await pendingSend
    })

    // Witness: the send was answered once and its follow-up read settled.
    expect(clerum.rpc.invokeHostMessage).toHaveBeenCalledTimes(1)
    expect.soft(getComposerDraft(chatId, AGENT), 'draft').toBe('')
    expect.soft(clerum.chat.removeMessages, 'removal').not.toHaveBeenCalled()
  })

  describe('the composer attachments while a rejected send was pending', () => {
    it('U1: a text-only send rejected after a document was attached keeps that document', async () => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const text = 'text-only send'
      const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)
      const note = new File(['attached during the POST'], 'later.txt', { type: 'text/plain' })
      act(() => app.result.current.handleAddComposerFiles([note], ''))
      await waitFor(() =>
        expect(app.result.current.composerFileAttachments.map(file => file.status)).toEqual([
          'ready',
        ])
      )
      const rejection = await http401()
      await act(async () => {
        post.reject(rejection)
        await pendingSend
      })

      // Witness: the put-back ran.
      expect(getComposerDraft(chatId, AGENT)).toBe(text)
      expect(app.result.current.composerFileAttachments.map(file => file.filename)).toEqual([
        'later.txt',
      ])
    })

    it('U2: a send with a reference rejected after the attachments changed is retained', async () => {
      const { app, clerum } = await boot()
      const chatId = await createChat(app)
      const text = 'send with a reference'
      await addReference(app)
      const { post, pendingSend } = await sendHeldAtPost(app, clerum, text)
      await waitFor(() => expect(app.result.current.composerReferenceAttachments).toHaveLength(0))
      const laterReference = { ...REFERENCE, id: 'later-ref', name: 'later' }
      act(() => app.result.current.handleAddComposerReferenceAttachments([laterReference] as never))
      await waitFor(() => expect(app.result.current.composerReferenceAttachments).toHaveLength(1))
      const rejection = await http401()
      await act(async () => {
        post.reject(rejection)
        await pendingSend
      })

      // Witness: the send ended and kept its payload.
      await waitFor(() => expect(app.result.current.failedAgentSend?.content).toBe(text))
      expect(app.result.current.failedAgentSend?.references.map(reference => reference.id)).toEqual(
        [REFERENCE.id]
      )
      expect(getComposerDraft(chatId, AGENT)).toBe('')
      expect(app.result.current.composerReferenceAttachments.map(item => item.id)).toEqual([
        'later-ref',
      ])
    })
  })
})
