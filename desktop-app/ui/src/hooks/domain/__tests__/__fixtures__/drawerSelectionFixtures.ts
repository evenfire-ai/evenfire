import { expect } from 'vitest'
import { act, waitFor as rtlWaitFor } from '@testing-library/react'
import { resolveGfsPreview } from '../../../../lib/gfsPreview'
import type { RenderAppControllerResult } from './appControllerHarness'
import { renderAppController } from './appControllerHarness'
import type { MockClerum } from './mockClerum'

/**
 * Shared steps for the app-controller suites that drive the chat drawer over a
 * non-chat workspace tab. Chats, indexes and last-active writes all go through
 * the real `ChatStore` behind `mockClerum`, and the preview tab is the one
 * `resolveGfsPreview` produces, so no fixture stands in for another layer.
 */

export type AppUnderTest = RenderAppControllerResult

export const messageIdFor = (chatId: string) => `${chatId}-message`

/** Routes `getIndex`/`setLastActive` through the real store instead of the inert defaults. */
export function routeIndexThroughStore(clerum: MockClerum) {
  clerum.chat.getIndex.mockImplementation((agent: string) => clerum.readIndex(agent))
  clerum.chat.setLastActive.mockImplementation((agent: string, chat: string) =>
    clerum.persistLastActive(agent, chat)
  )
}

/** Creates each chat with one persisted message, in order (the last one is the newest). */
export async function seedChats(clerum: MockClerum, agent: string, chatIds: string[]) {
  for (const chatId of chatIds) {
    await clerum.chat.create(agent, chatId)
    await clerum.chat.upsertMessages(agent, chatId, [
      { id: messageIdFor(chatId), role: 'user', content: `${chatId} history`, timestamp: 1 },
    ])
  }
}

export function gfsPreview(name = 'notes.md') {
  const preview = resolveGfsPreview({ gfsUri: `gfs://main/${name}`, name, bytes: 12 })
  if (!preview) throw new Error(`Expected ${name} to be previewable`)
  return preview
}

const ASYNC_WAIT_TIMEOUT_MS = 5_000

/** Real ChatStore-backed effects can exceed Testing Library's 1s default on CI runners. */
export function waitFor<T>(
  callback: () => T | Promise<T>,
  options?: Parameters<typeof rtlWaitFor>[1]
) {
  return rtlWaitFor(callback, { timeout: ASYNC_WAIT_TIMEOUT_MS, ...options })
}

export async function bootApp(): Promise<AppUnderTest> {
  const app = renderAppController()
  await waitFor(() => expect(app.result.current.isAuthenticated).toBe(true))
  await waitFor(() => expect(app.result.current.initialExperienceLoading).toBe(false))
  return app
}

/** The drawer gesture App fires for a chat row: keepNavItem, never a route change. */
export function selectInDrawer(
  app: AppUnderTest,
  agent: string,
  chatId?: string,
  options: { selectLatest?: boolean; title?: string } = {}
) {
  act(() => {
    app.result.current.handleSelectChatAgent(agent, {
      ...(chatId ? { chatId, selectLatest: false } : {}),
      ...options,
      keepNavItem: true,
    })
  })
}

export async function waitForSettled(app: AppUnderTest) {
  await waitFor(() => {
    expect(app.result.current.chatListLoading).toBe(false)
    expect(app.result.current.chatMessagesLoading).toBe(false)
  })
}

/** What the drawer shows: the active chat and the ids of its rendered messages. */
export function visibleConversation(app: AppUnderTest) {
  return {
    activeChatId: app.result.current.activeChatId,
    messageIds: app.result.current.activeMessages.map(message => message.id),
  }
}

export function errorToasts(app: AppUnderTest) {
  return app.result.current.toasts.filter(toast => toast.tone === 'error')
}

/** Opens a chat in the drawer over the Files tab and waits until its history shows. */
export async function openDrawerOverFiles(app: AppUnderTest, agent: string, chatId: string) {
  act(() => {
    app.result.current.openFilesSection(null)
  })
  selectInDrawer(app, agent, chatId)
  await waitFor(() =>
    expect(visibleConversation(app)).toEqual({
      activeChatId: chatId,
      messageIds: [messageIdFor(chatId)],
    })
  )
  await waitForSettled(app)
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
