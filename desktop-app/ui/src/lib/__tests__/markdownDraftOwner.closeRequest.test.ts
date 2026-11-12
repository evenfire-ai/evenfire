import { afterEach, describe, expect, it } from 'vitest'
import type { MarkdownDraftBinding } from '../markdownDraftOwner'
import { MarkdownDraftOwner } from '../markdownDraftOwner'

const binding: MarkdownDraftBinding = {
  principalOwner: 'principal-owner-close',
  scopeKey: 'principal-close/team-a/env-dev',
  tabId: 'close-tab',
  gfsUri: 'gfs://main/close.md',
}

const owners: MarkdownDraftOwner[] = []

function readyOwner() {
  const owner = new MarkdownDraftOwner()
  owners.push(owner)
  owner.open(binding, { sessionGeneration: 1 })
  const read = owner.beginStableRead(binding)!
  owner.completeStableRead(read, { content: 'saved', version: 1, stable: true })
  const capability = owner.beginCapabilityRefresh(binding)!
  owner.completeCapabilityRefresh(capability, true)
  owner.beginEdit(binding)
  owner.type(binding, 'dirty draft')
  return owner
}

afterEach(() => {
  for (const owner of owners.splice(0)) owner.quit()
})

describe('MarkdownDraftOwner exact close request recovery', () => {
  it('retains a dirty close reservation through same-session auth recovery and commits it once', () => {
    const owner = readyOwner()
    expect(owner.requestClose(binding.tabId)).toBe('confirm')
    expect(owner.resolveClose(binding.tabId, 'discard')).toBe(true)
    const identities = owner.reserveCloseRequest(binding.tabId, 'close-request-1')
    expect(identities).toHaveLength(1)

    const barrier = owner.beginAuthBarrier(binding.principalOwner, 1, false)!
    expect(owner.reserveAuthBarrierFromMain(barrier)).toBe(true)
    expect(owner.commitAuthNeutralSurface(barrier)).toBe(true)
    expect(owner.acknowledgeAuthNeutralSurface(barrier)).toBe(true)
    expect(owner.getVisibleRecord(binding)).toBeNull()
    expect(owner.get(binding)).toMatchObject({
      draft: 'dirty draft',
      closeReserved: true,
      closeAuthorizationPending: true,
      closeRequestId: 'close-request-1',
    })

    expect(owner.restoreAfterAuthBarrier(barrier, 1)).toBe(true)
    expect(owner.get(binding)?.draft).toBe('dirty draft')
    expect(owner.promoteCloseRequest('close-request-1')).toBe(true)
    expect(owner.commitCloseRequest('close-request-1')).toBe(true)
    expect(owner.get(binding)).toBeNull()
    expect(owner.commitCloseRequest('close-request-1')).toBe(false)
  })

  it('releases only the exact request after authoritative denial', () => {
    const owner = readyOwner()
    expect(owner.requestClose(binding.tabId)).toBe('confirm')
    expect(owner.resolveClose(binding.tabId, 'discard')).toBe(true)
    owner.reserveCloseRequest(binding.tabId, 'close-request-2')

    expect(owner.releaseCloseRequest('other-request')).toBe(false)
    expect(owner.get(binding)).toMatchObject({ closeReserved: true, draft: 'dirty draft' })
    expect(owner.releaseCloseRequest('close-request-2')).toBe(true)
    expect(owner.get(binding)).toMatchObject({
      closeReserved: false,
      closeAuthorizationPending: false,
      closeRequestId: null,
      draft: 'dirty draft',
    })
  })
})
