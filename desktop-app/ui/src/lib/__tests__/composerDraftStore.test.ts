import { afterEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import {
  cancelPendingResourceComposerPrefill,
  claimPendingResourceComposerPrefill,
  clearAllComposerDrafts,
  clearComposerDraft,
  getComposerDraft,
  getComposerDraftOwnerConflict,
  getComposerDraftRevision,
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

  it('preserves the first pending resource prefill when requests repeat for one tab', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 16 }), { minLength: 2, maxLength: 6 }),
        suffixes => {
          resetComposerDraftStore()
          const requests = suffixes.map((suffix, index) => `gfs://main/${index}-${suffix}`)
          const first = requests[0]
          if (first === undefined) throw new Error('the generated request list must be non-empty')
          const retries = requests.slice(1)

          expect(setResourceComposerPrefill('tab-a', first, null)).toBe(true)
          for (const retry of retries) {
            expect(setResourceComposerPrefill('tab-a', retry, null)).toBe(false)
          }

          claimPendingResourceComposerPrefill('tab-a', 'agent-a')
          expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe(first)
          expect(getComposerDraft(null, 'agent-a', 'tab-b')).toBe('')
        }
      ),
      { numRuns: 100 }
    )
  })

  it('keeps an existing tab draft when a pending resource prefill is claimed', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 24 }), suffix => {
        resetComposerDraftStore()
        const existing = `existing draft:${suffix}`
        const pending = `gfs://main/pending-${suffix}`

        expect(setResourceComposerPrefill('tab-a', existing, 'agent-a')).toBe(true)
        expect(setResourceComposerPrefill('tab-a', pending, null)).toBe(true)
        expect(setResourceComposerPrefill('tab-b', 'gfs://main/sibling', 'agent-a')).toBe(true)

        claimPendingResourceComposerPrefill('tab-a', 'agent-a')

        expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe(existing)
        expect(getComposerDraft(null, 'agent-a', 'tab-b')).toBe('gfs://main/sibling')
        expect(getComposerDraft(null, undefined, 'tab-a')).toBe('')
      }),
      { numRuns: 100 }
    )
  })

  it('preserves a legacy agent draft beside its new tab resource prefill', () => {
    setComposerDraft(null, 'existing draft', 'agent-a')
    expect(setResourceComposerPrefill('tab-a', 'gfs://main/resource', 'agent-a')).toBe(true)

    expect(getComposerDraft(null, 'agent-a')).toBe('existing draft')
    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('gfs://main/resource')
  })

  it('keeps different agent drafts and prefill revisions independent within one reused tab', () => {
    expect(setResourceComposerPrefill('reused-tab', 'gfs://main/agent-a', 'agent-a')).toBe(true)
    const revisionA = getComposerDraftRevision(null, 'agent-a', 'reused-tab')

    expect(setComposerDraft(null, 'draft for agent B', 'agent-b', 'reused-tab')).toBe(true)

    expect(getComposerDraft(null, 'agent-a', 'reused-tab')).toBe('gfs://main/agent-a')
    expect(getComposerDraft(null, 'agent-b', 'reused-tab')).toBe('draft for agent B')
    expect(getComposerDraftRevision(null, 'agent-a', 'reused-tab')).toBe(revisionA)
    expect(getComposerDraftRevision(null, 'agent-b', 'reused-tab')).toBeGreaterThan(revisionA)

    expect(clearComposerDraft(null, 'agent-a', 'reused-tab')).toBe(true)
    expect(getComposerDraft(null, 'agent-a', 'reused-tab')).toBe('')
    expect(getComposerDraft(null, 'agent-b', 'reused-tab')).toBe('draft for agent B')
  })

  it('keeps the legacy draft out of a workspace tab until that tab claims the key', () => {
    setComposerDraft(null, 'legacy draft', 'agent-a')

    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('')
    expect(setComposerDraft(null, 'workspace draft', 'agent-a', 'tab-a')).toBe(true)
    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('workspace draft')
    expect(getComposerDraft(null, 'agent-a')).toBe('legacy draft')

    expect(clearComposerDraft(null, 'agent-a', 'tab-a')).toBe(true)
    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('')
    expect(getComposerDraft(null, 'agent-a')).toBe('legacy draft')
  })

  it('isolates resource drafts for two blank tabs using the same agent', () => {
    expect(setResourceComposerPrefill('tab-a', 'gfs://main/a', 'agent-a')).toBe(true)
    expect(setResourceComposerPrefill('tab-b', 'gfs://main/b', 'agent-a')).toBe(true)

    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('gfs://main/a')
    expect(getComposerDraft(null, 'agent-a', 'tab-b')).toBe('gfs://main/b')
    expect(setComposerDraft(null, 'edited A', 'agent-a', 'tab-a')).toBe(true)
    setComposerDraft(null, 'edited B', 'agent-a', 'tab-b')
    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('edited A')
    expect(getComposerDraft(null, 'agent-a', 'tab-b')).toBe('edited B')
    clearComposerDraft(null, 'agent-a', 'tab-b')
    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('edited A')
    expect(getComposerDraft(null, 'agent-a', 'tab-b')).toBe('')
    clearComposerDraft(null, 'agent-a', 'tab-a')
    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('')
  })

  it('keeps a tabless legacy write independent from another tab resource draft', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string().map(value => `replacement:${value}`),
        (ownerSuffix, replacement) => {
          resetComposerDraftStore()
          const ownerTabId = `owner-${ownerSuffix}`
          const resourceUri = `gfs://main/${'a'.repeat(32)}`
          expect(setResourceComposerPrefill(ownerTabId, resourceUri, 'agent-a')).toBe(true)

          // A caller without a workspace identity reads and writes only the
          // separate legacy slot; it cannot access the tab-owned prefill.
          expect(getComposerDraft(null, 'agent-a')).toBe('')
          const accepted = setComposerDraft(null, replacement, 'agent-a')
          expect(accepted).toBe(true)
          expect(getComposerDraft(null, 'agent-a')).toBe(replacement)
          expect(getComposerDraft(null, 'agent-a', ownerTabId)).toBe(resourceUri)
        }
      )
    )
  })

  it('allows an explicit legacy key beside an unrelated pending prefill', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string().map(value => `recovered:${value}`),
        (ownerSuffix, recoveryText) => {
          resetComposerDraftStore()
          const ownerTabId = `pending-owner-${ownerSuffix}`
          const resourceUri = `gfs://main/${'b'.repeat(32)}`
          expect(setResourceComposerPrefill(ownerTabId, resourceUri, null)).toBe(true)

          // A pending request has no draft key until its owning tab claims an agent.
          expect(setComposerDraft(null, recoveryText, 'agent-a')).toBe(true)
          expect(getComposerDraft(null, 'agent-a', ownerTabId)).toBe(resourceUri)
          expect(getComposerDraft(null, 'agent-a')).toBe(recoveryText)

          claimPendingResourceComposerPrefill(ownerTabId, 'agent-a')
          expect(getComposerDraft(null, 'agent-a', ownerTabId)).toBe(resourceUri)
          expect(getComposerDraft(null, 'agent-a')).toBe(recoveryText)
        }
      )
    )
  })

  it('clears an explicit legacy key without canceling an unrelated pending prefill', () => {
    setResourceComposerPrefill('pending-owner', `gfs://main/${'c'.repeat(32)}`, null)

    expect(clearComposerDraft(null, 'agent-a')).toBe(true)
    expect(getComposerDraft(null, 'agent-a', 'pending-owner')).toBe(`gfs://main/${'c'.repeat(32)}`)
    claimPendingResourceComposerPrefill('pending-owner', 'agent-a')
    expect(getComposerDraft(null, 'agent-a', 'pending-owner')).toBe(`gfs://main/${'c'.repeat(32)}`)
  })

  it('allows a second workspace tab to edit an independent same-agent draft', () => {
    const resourceUri = `gfs://main/${'d'.repeat(32)}`
    expect(setResourceComposerPrefill('owner-tab', resourceUri, 'agent-a')).toBe(true)

    expect(setComposerDraft(null, 'tab B text', 'agent-a', 'other-tab')).toBe(true)
    expect(getComposerDraft(null, 'agent-a', 'other-tab')).toBe('tab B text')
    expect(clearComposerDraft(null, 'agent-a', 'other-tab')).toBe(true)
    expect(getComposerDraft(null, 'agent-a', 'owner-tab')).toBe(resourceUri)
    expect(getComposerDraft(null, 'agent-a', 'other-tab')).toBe('')
  })

  it('keeps tabless clears confined to the legacy slot', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), ownerSuffix => {
        resetComposerDraftStore()
        const ownerTabId = `owner-${ownerSuffix}`
        const resourceUri = `gfs://main/${'a'.repeat(32)}`
        expect(setResourceComposerPrefill(ownerTabId, resourceUri, 'agent-a')).toBe(true)

        const cleared = clearComposerDraft(null, 'agent-a')
        expect(cleared).toBe(true)
        expect(getComposerDraft(null, 'agent-a', ownerTabId)).toBe(resourceUri)
      })
    )
  })

  it('releases only the closing tab’s claimed and pending resource drafts', () => {
    setResourceComposerPrefill('tab-a', 'gfs://main/a', 'agent-a')
    setComposerDraft(null, 'agent B draft', 'agent-b', 'tab-a')
    setResourceComposerPrefill('tab-b', 'gfs://main/b', 'agent-a')
    setResourceComposerPrefill('tab-pending', 'gfs://main/pending', null)

    releaseComposerDraftForWorkspaceTab('tab-a')

    expect(getComposerDraft(null, 'agent-a', 'tab-a')).toBe('')
    expect(getComposerDraft(null, 'agent-b', 'tab-a')).toBe('')
    expect(getComposerDraft(null, 'agent-a', 'tab-b')).toBe('gfs://main/b')
    expect(getComposerDraft(null, undefined, 'tab-pending')).toBe('gfs://main/pending')

    releaseComposerDraftForWorkspaceTab('tab-pending')
    expect(getComposerDraft(null, undefined, 'tab-pending')).toBe('')
  })

  it('preserves independent slots through generated write, clear, and release sequences', () => {
    const commandArbitrary = fc.record({
      actor: fc.constantFrom('tab-a' as const, 'tab-b' as const, 'legacy' as const),
      action: fc.constantFrom('write' as const, 'clear' as const, 'release' as const),
      value: fc.string({ maxLength: 24 }),
    })

    fc.assert(
      fc.property(fc.array(commandArbitrary, { maxLength: 40 }), commands => {
        resetComposerDraftStore()
        const key = 'agent-a'
        let legacyValue = 'legacy baseline'
        const tabDrafts = new Map<'tab-a' | 'tab-b', string>()

        expect(setComposerDraft(null, legacyValue, key)).toBe(true)
        expect(setResourceComposerPrefill('tab-a', 'gfs://main/a', key)).toBe(true)
        expect(setResourceComposerPrefill('tab-b', 'gfs://main/b', key)).toBe(true)
        tabDrafts.set('tab-a', 'gfs://main/a')
        tabDrafts.set('tab-b', 'gfs://main/b')

        for (const command of commands) {
          if (command.actor === 'legacy') {
            if (command.action === 'release') continue
            const accepted =
              command.action === 'write'
                ? setComposerDraft(null, command.value, key)
                : clearComposerDraft(null, key)
            expect(accepted).toBe(true)
            legacyValue = command.action === 'write' ? command.value : ''
          } else if (command.action === 'release') {
            releaseComposerDraftForWorkspaceTab(command.actor)
            tabDrafts.delete(command.actor)
          } else if (command.action === 'write') {
            const accepted = setComposerDraft(null, command.value, key, command.actor)
            expect(accepted).toBe(true)
            if (command.value) tabDrafts.set(command.actor, command.value)
            else tabDrafts.delete(command.actor)
          } else {
            const accepted = clearComposerDraft(null, key, command.actor)
            expect(accepted).toBe(true)
            tabDrafts.delete(command.actor)
          }

          expect(getComposerDraft(null, key, 'tab-a')).toBe(tabDrafts.get('tab-a') ?? '')
          expect(getComposerDraft(null, key, 'tab-b')).toBe(tabDrafts.get('tab-b') ?? '')
          expect(getComposerDraft(null, key)).toBe(legacyValue)
          expect(getComposerDraftOwnerConflict(null, key)).toBeNull()
        }
      })
    )
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

  it('clears every agent draft for each workspace tab on principal cleanup', () => {
    setComposerDraft(null, 'agent A draft', 'agent-a', 'tab-shared')
    setComposerDraft(null, 'agent B draft', 'agent-b', 'tab-shared')
    setComposerDraft(null, 'other tab draft', 'agent-a', 'tab-other')
    setResourceComposerPrefill('tab-pending', 'gfs://main/pending', null)

    clearAllComposerDrafts()

    expect(getComposerDraft(null, 'agent-a', 'tab-shared')).toBe('')
    expect(getComposerDraft(null, 'agent-b', 'tab-shared')).toBe('')
    expect(getComposerDraft(null, 'agent-a', 'tab-other')).toBe('')
    expect(getComposerDraft(null, undefined, 'tab-pending')).toBe('')
  })
})
