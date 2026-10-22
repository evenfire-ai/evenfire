import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import {
  cancelPendingResourceComposerPrefill,
  claimPendingResourceComposerPrefill,
  clearComposerDraft,
  getComposerDraft,
  releaseComposerDraftForWorkspaceTab,
  resetComposerDraftStore,
  setComposerDraft,
  setResourceComposerPrefill,
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

  it('keeps a pending resource prefill visible and claimable only by its destination tab', () => {
    setResourceComposerPrefill('tab-a', 'gfs://main/resource', null)

    expect(getComposerDraft(null, undefined, 'tab-a')).toBe('gfs://main/resource')
    expect(getComposerDraft(null, 'agent-b', 'tab-b')).toBe('')
    claimPendingResourceComposerPrefill('tab-b', 'agent-b')
    expect(getComposerDraft(null, 'agent-b', 'tab-b')).toBe('')

    claimPendingResourceComposerPrefill('tab-a', 'agent-a')
    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('gfs://main/resource')
    expect(getComposerDraft(null, 'agent-a', 'tab-b')).toBe('')
  })

  it('preserves an existing agent draft when a target resource prefill is requested', () => {
    setComposerDraft(null, 'existing draft', 'agent-a')
    expect(setResourceComposerPrefill('tab-a', 'gfs://main/resource', 'agent-a')).toBe(false)

    expect(getComposerDraft(null, 'agent-a')).toBe('existing draft')
    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('existing draft')
  })

  it('isolates resource drafts for two blank tabs using the same agent', () => {
    expect(setResourceComposerPrefill('tab-a', 'gfs://main/a', 'agent-a')).toBe(true)
    expect(setResourceComposerPrefill('tab-b', 'gfs://main/b', 'agent-a')).toBe(true)

    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('gfs://main/a')
    expect(getComposerDraft(null, 'agent-a', 'tab-b')).toBe('gfs://main/b')
    setComposerDraft(null, 'edited B', 'agent-a', 'tab-b')
    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('gfs://main/a')
    expect(getComposerDraft(null, 'agent-a', 'tab-b')).toBe('edited B')
    clearComposerDraft(null, 'agent-a', 'tab-b')
    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('gfs://main/a')
    expect(getComposerDraft(null, 'agent-a', 'tab-b')).toBe('')
  })

  it('keeps tabless writes from replacing another tab resource draft', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string().map(value => `replacement:${value}`),
        (ownerSuffix, replacement) => {
          resetComposerDraftStore()
          const ownerTabId = `owner-${ownerSuffix}`
          const resourceUri = `gfs://main/${'a'.repeat(32)}`
          expect(setResourceComposerPrefill(ownerTabId, resourceUri, 'agent-a')).toBe(true)

          // A caller without a workspace identity cannot read the tab-owned
          // resource draft; it must not be allowed to overwrite or clear it.
          expect(getComposerDraft(null, 'agent-a')).toBe('')
          const accepted = setComposerDraft(null, replacement, 'agent-a')
          expect(getComposerDraft(null, 'agent-a', ownerTabId)).toBe(resourceUri)
          expect(accepted).toBe(false)
        }
      )
    )
  })

  it('keeps tabless writes from consuming an unclaimed tab-owned prefill', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string().map(value => `recovered:${value}`),
        (ownerSuffix, recoveryText) => {
          resetComposerDraftStore()
          const ownerTabId = `pending-owner-${ownerSuffix}`
          const resourceUri = `gfs://main/${'b'.repeat(32)}`
          expect(setResourceComposerPrefill(ownerTabId, resourceUri, null)).toBe(true)

          // A tab-less recovery cannot know which agent will claim this request.
          expect(setComposerDraft(null, recoveryText, 'agent-a')).toBe(false)
          expect(getComposerDraft(null, 'agent-a', ownerTabId)).toBe(resourceUri)

          claimPendingResourceComposerPrefill(ownerTabId, 'agent-a')
          expect(getComposerDraft(null, 'agent-a', ownerTabId)).toBe(resourceUri)
        }
      )
    )
  })

  it('keeps tabless clears from canceling an unclaimed tab-owned prefill', () => {
    setResourceComposerPrefill('pending-owner', `gfs://main/${'c'.repeat(32)}`, null)

    expect(clearComposerDraft(null, 'agent-a')).toBe(false)
    expect(getComposerDraft(null, 'agent-a', 'pending-owner')).toBe(`gfs://main/${'c'.repeat(32)}`)
    claimPendingResourceComposerPrefill('pending-owner', 'agent-a')
    expect(getComposerDraft(null, 'agent-a', 'pending-owner')).toBe(`gfs://main/${'c'.repeat(32)}`)
  })

  it('keeps tabless clears from deleting another tab resource draft', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), ownerSuffix => {
        resetComposerDraftStore()
        const ownerTabId = `owner-${ownerSuffix}`
        const resourceUri = `gfs://main/${'a'.repeat(32)}`
        expect(setResourceComposerPrefill(ownerTabId, resourceUri, 'agent-a')).toBe(true)

        const cleared = clearComposerDraft(null, 'agent-a')
        expect(getComposerDraft(null, 'agent-a', ownerTabId)).toBe(resourceUri)
        expect(cleared).toBe(false)
      })
    )
  })

  it('releases only the closing tab’s claimed and pending resource drafts', () => {
    setResourceComposerPrefill('tab-a', 'gfs://main/a', 'agent-a')
    setResourceComposerPrefill('tab-b', 'gfs://main/b', 'agent-a')
    setResourceComposerPrefill('tab-pending', 'gfs://main/pending', null)

    releaseComposerDraftForWorkspaceTab('tab-a')

    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('')
    expect(getComposerDraft(null, 'agent-a', 'tab-b')).toBe('gfs://main/b')
    expect(getComposerDraft(null, undefined, 'tab-pending')).toBe('gfs://main/pending')

    releaseComposerDraftForWorkspaceTab('tab-pending')
    expect(getComposerDraft(null, undefined, 'tab-pending')).toBe('')
  })

  it('notifies only the owning tab when a delayed resource prefill is added or canceled', () => {
    const ownerListener = vi.fn()
    const otherListener = vi.fn()
    subscribeComposerDraft(null, ownerListener, 'agent-a', 'tab-a')
    subscribeComposerDraft(null, otherListener, 'agent-b', 'tab-b')

    setResourceComposerPrefill('tab-a', 'gfs://main/resource', null)
    expect(ownerListener).toHaveBeenCalledOnce()
    expect(otherListener).not.toHaveBeenCalled()
    cancelPendingResourceComposerPrefill('tab-a')
    expect(ownerListener).toHaveBeenCalledTimes(2)
    expect(otherListener).not.toHaveBeenCalled()
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

  it('isolates no-chat drafts by agent while preserving the legacy unscoped bucket', () => {
    setComposerDraft(null, 'agent-a draft', 'agent-a')
    setComposerDraft(null, 'agent-b draft', 'agent-b')
    setComposerDraft(null, 'legacy draft')

    expect(getComposerDraft(null, 'agent-a')).toBe('agent-a draft')
    expect(getComposerDraft(null, 'agent-b')).toBe('agent-b draft')
    expect(getComposerDraft(null)).toBe('legacy draft')

    clearComposerDraft(null, 'agent-a')
    expect(getComposerDraft(null, 'agent-a')).toBe('')
    expect(getComposerDraft(null, 'agent-b')).toBe('agent-b draft')
    expect(getComposerDraft(null)).toBe('legacy draft')
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
