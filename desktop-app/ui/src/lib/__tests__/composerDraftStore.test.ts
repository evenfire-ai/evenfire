import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearComposerDraft,
  clearComposerDraftAfterSend,
  getComposerDraft,
  resetComposerDraftStore,
  setComposerDraft,
  subscribeComposerDraft,
} from '../composerDraftStore'

afterEach(() => {
  resetComposerDraftStore()
})

describe('composerDraftStore', () => {
  it('returns an empty string for a chat with no draft', () => {
    expect(getComposerDraft('chat-1')).toBe('')
    expect(getComposerDraft(null)).toBe('')
  })

  it('stores and reads drafts independently per chat', () => {
    setComposerDraft('chat-1', 'hello')
    setComposerDraft('chat-2', 'world')
    expect(getComposerDraft('chat-1')).toBe('hello')
    expect(getComposerDraft('chat-2')).toBe('world')
  })

  it('keys a null chatId under the shared no-chat bucket', () => {
    setComposerDraft(null, 'pending')
    expect(getComposerDraft(null)).toBe('pending')
  })

  it('clears (deletes) the draft when set to an empty string', () => {
    setComposerDraft('chat-1', 'hello')
    setComposerDraft('chat-1', '')
    expect(getComposerDraft('chat-1')).toBe('')
  })

  it('notifies only the listener subscribed to the changed chat key', () => {
    const listener1 = vi.fn()
    const listener2 = vi.fn()
    subscribeComposerDraft('chat-1', listener1)
    subscribeComposerDraft('chat-2', listener2)

    setComposerDraft('chat-1', 'hi')

    expect(listener1).toHaveBeenCalledTimes(1)
    expect(listener2).not.toHaveBeenCalled()
  })

  it('does not notify when the value is unchanged', () => {
    setComposerDraft('chat-1', 'hi')
    const listener = vi.fn()
    subscribeComposerDraft('chat-1', listener)

    setComposerDraft('chat-1', 'hi')

    expect(listener).not.toHaveBeenCalled()
  })

  it('emits when a non-empty draft is cleared so subscribers update', () => {
    setComposerDraft('chat-1', 'hi')
    const listener = vi.fn()
    subscribeComposerDraft('chat-1', listener)

    setComposerDraft('chat-1', '')

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeComposerDraft('chat-1', listener)

    setComposerDraft('chat-1', 'a')
    unsubscribe()
    setComposerDraft('chat-1', 'b')

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('clearComposerDraft removes a chat draft', () => {
    setComposerDraft('chat-1', 'hello')
    clearComposerDraft('chat-1')
    expect(getComposerDraft('chat-1')).toBe('')
  })

  it('clearComposerDraftAfterSend clears both the no-chat bucket and the target chat', () => {
    setComposerDraft(null, 'typed before a chat existed')
    setComposerDraft('chat-1', 'leftover')

    clearComposerDraftAfterSend('chat-1')

    expect(getComposerDraft(null)).toBe('')
    expect(getComposerDraft('chat-1')).toBe('')
  })

  it('resetComposerDraftStore wipes all drafts and listeners', () => {
    const listener = vi.fn()
    subscribeComposerDraft('chat-1', listener)
    setComposerDraft('chat-1', 'hello')

    resetComposerDraftStore()

    expect(getComposerDraft('chat-1')).toBe('')
    setComposerDraft('chat-1', 'again')
    expect(listener).toHaveBeenCalledTimes(1) // only the pre-reset write
  })
})
