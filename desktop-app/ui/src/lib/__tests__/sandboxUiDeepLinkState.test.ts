import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import type { SandboxUiConversationOrigin } from '@pages/SandboxUiPage.types'
import type { PendingSandboxUiDeepLink, SandboxUiDeepLinkEnvelope } from '@/App.types'
import { SandboxUiDeepLinkQueue } from '../../../../src/sandboxUiDeepLinkQueue.js'
import {
  MAX_PENDING_SANDBOX_UI_DEEP_LINKS,
  MAX_SANDBOX_UI_DEEP_LINK_RETRY_ATTEMPTS,
  clearSandboxUiDeepLinkProcessingOwner,
  confirmPendingSandboxUiDeepLink,
  deferPendingSandboxUiDeepLink,
  dismissPendingSandboxUiDeepLinkFailure,
  enqueuePendingSandboxUiDeepLink,
  failPendingSandboxUiDeepLink,
  findPendingSandboxUiDeepLinkAwaitingConfirmation,
  getSandboxUiDeepLinkMetadataIdsToPrune,
  isPendingSandboxUiDeepLinkAwaitingConfirmation,
  isPendingSandboxUiDeepLinkStale,
  isSandboxUiDeepLinkProcessingOwner,
  nextSandboxUiDeepLinkRetryDelayMs,
  removePendingSandboxUiDeepLink,
  resetPendingSandboxUiDeepLinkFailure,
  shouldPurgeSandboxUiDeepLinks,
} from '../sandboxUiDeepLinkState'

type LinkOperation = {
  conversationOrigin: SandboxUiConversationOrigin | null
  link: SandboxUiDeepLinkEnvelope
  receivedIdentity: string | null
}

type TargetParts = {
  name: string
  path?: string
  teamId?: string
}

const lowerAlpha = [...'abcdefghijklmnopqrstuvwxyz']
const lowerAlphaNumericDash = [...'abcdefghijklmnopqrstuvwxyz0123456789-']

const segmentArb = fc
  .tuple(
    fc.constantFrom(...lowerAlpha),
    fc.array(fc.constantFrom(...lowerAlphaNumericDash), { maxLength: 10 })
  )
  .map(([first, rest]) => `${first}${rest.join('')}`)

const routePathArb = fc.oneof(
  fc.constant(undefined),
  fc.constant('/'),
  fc.array(segmentArb, { minLength: 1, maxLength: 4 }).map(segments => `/${segments.join('/')}`)
)

const teamIdArb = fc.oneof(
  fc.constant(undefined),
  segmentArb.map(segment => `team-${segment}`)
)

const targetPartsArb: fc.Arbitrary<TargetParts> = fc.record({
  name: segmentArb,
  path: routePathArb,
  teamId: teamIdArb,
})

const conversationOriginArb: fc.Arbitrary<SandboxUiConversationOrigin | null> = fc.oneof(
  fc.constant(null),
  fc.record({
    agentName: segmentArb,
    chatId: segmentArb.map(segment => `chat-${segment}`),
    teamId: fc.oneof(
      fc.constant(undefined),
      segmentArb.map(segment => `team-${segment}`)
    ),
    title: segmentArb,
  })
)

const receivedIdentityArb = fc.constantFrom<string | null>(null, 'user-a', 'user-b', 'user-c')

function producerEnvelopes(parts: TargetParts[]): SandboxUiDeepLinkEnvelope[] {
  const queue = new SandboxUiDeepLinkQueue(parts.length + 1)
  return parts.map((part, index) =>
    queue.enqueue({
      appRef: `sandbox-recipes/${part.name}-${index}`,
      path: part.path,
      teamId: part.teamId,
    })
  )
}

function linkOperationArb(): fc.Arbitrary<LinkOperation> {
  return fc
    .tuple(targetPartsArb, conversationOriginArb, receivedIdentityArb)
    .map(([parts, conversationOrigin, receivedIdentity]) => ({
      conversationOrigin,
      link: producerEnvelopes([parts])[0]!,
      receivedIdentity,
    }))
}

function producerBackedInterleavingsArb(): fc.Arbitrary<LinkOperation[]> {
  return fc
    .array(targetPartsArb, { minLength: 1, maxLength: MAX_PENDING_SANDBOX_UI_DEEP_LINKS + 15 })
    .chain(parts => {
      const envelopes = producerEnvelopes(parts)
      return fc
        .array(
          fc.record({
            conversationOrigin: conversationOriginArb,
            envelopeIndex: fc.integer({ min: 0, max: envelopes.length - 1 }),
            receivedIdentity: receivedIdentityArb,
          }),
          { maxLength: MAX_PENDING_SANDBOX_UI_DEEP_LINKS + 30 }
        )
        .map(records =>
          records.map(record => ({
            conversationOrigin: record.conversationOrigin,
            link: envelopes[record.envelopeIndex]!,
            receivedIdentity: record.receivedIdentity,
          }))
        )
    })
}

function enqueueOperations(operations: LinkOperation[]): PendingSandboxUiDeepLink[] {
  return operations.reduce<PendingSandboxUiDeepLink[]>(
    (pending, operation) =>
      enqueuePendingSandboxUiDeepLink(
        pending,
        operation.link,
        operation.conversationOrigin,
        operation.receivedIdentity
      ),
    []
  )
}

function expectedRetainedOperations(operations: LinkOperation[]): LinkOperation[] {
  const firstById = new Map<number, LinkOperation>()
  operations.forEach(operation => {
    if (!firstById.has(operation.link.id)) {
      firstById.set(operation.link.id, operation)
    }
  })
  return [...firstById.values()]
    .sort((left, right) => left.link.id - right.link.id)
    .slice(-MAX_PENDING_SANDBOX_UI_DEEP_LINKS)
}

function comparablePending(pending: PendingSandboxUiDeepLink[]) {
  return pending.map(item => ({
    conversationOrigin: item.conversationOrigin,
    link: item.link,
    receivedIdentity: item.receivedIdentity,
  }))
}

function comparableOperations(operations: LinkOperation[]) {
  return operations.map(operation => ({
    conversationOrigin: operation.conversationOrigin,
    link: operation.link,
    receivedIdentity: operation.receivedIdentity,
  }))
}

describe('shouldPurgeSandboxUiDeepLinks', () => {
  it('keeps a cold-start link as pending user intent while the first user authenticates', () => {
    expect(shouldPurgeSandboxUiDeepLinks(undefined, null)).toBe(false)
    expect(shouldPurgeSandboxUiDeepLinks(null, 'user-a')).toBe(false)
  })

  it('purges links on logout or an authenticated identity change', () => {
    expect(shouldPurgeSandboxUiDeepLinks('user-a', null)).toBe(true)
    expect(shouldPurgeSandboxUiDeepLinks('user-a', 'user-b')).toBe(true)
  })

  it('keeps links while the same identity changes teams', () => {
    expect(shouldPurgeSandboxUiDeepLinks('user-a', 'user-a')).toBe(false)
  })
})

describe('pending sandbox UI deep-link state', () => {
  it('clears only the matching processing owner', () => {
    expect(clearSandboxUiDeepLinkProcessingOwner(1, 1)).toBeNull()
    expect(clearSandboxUiDeepLinkProcessingOwner(2, 1)).toBe(2)
    expect(clearSandboxUiDeepLinkProcessingOwner(null, 1)).toBeNull()
  })

  it('models accepted intent, admission, supersession, and exact settlement', () => {
    type Event =
      | { kind: 'confirm' | 'admit' | 'cancel' | 'settle'; linkId: number }
      | { kind: 'user-navigation' }
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({
              kind: fc.constantFrom<'confirm' | 'admit' | 'cancel' | 'settle'>(
                'confirm',
                'admit',
                'cancel',
                'settle'
              ),
              linkId: fc.integer({ min: 1, max: 8 }),
            }),
            fc.constant({ kind: 'user-navigation' } as const)
          ),
          { maxLength: 100 }
        ),
        events => {
          // Reference behavior follows the transaction contract, not App's
          // helper implementation: accepted intent determines eligibility;
          // admission takes an empty owner; supersession preserves an unsettled
          // owner's turn; and only that exact transaction can release it.
          const pendingLinks = new Set<number>()
          let latestIntentLinkId: number | null = null
          let actualOwner: number | null = null
          let expectedOwner: number | null = null

          for (const event of events) {
            switch (event.kind) {
              case 'confirm':
                pendingLinks.add(event.linkId)
                latestIntentLinkId = event.linkId
                break
              case 'user-navigation':
                latestIntentLinkId = null
                break
              case 'admit':
                if (
                  expectedOwner === null &&
                  pendingLinks.has(event.linkId) &&
                  latestIntentLinkId === event.linkId
                ) {
                  expectedOwner = event.linkId
                  actualOwner = event.linkId
                }
                break
              case 'cancel': {
                // A non-owner can be removed now. A canceled active link is
                // stale but still owns its unresolved asynchronous operation.
                const canceledOwnerIsActive =
                  actualOwner !== null &&
                  isSandboxUiDeepLinkProcessingOwner(actualOwner, event.linkId)
                if (!canceledOwnerIsActive) {
                  actualOwner = clearSandboxUiDeepLinkProcessingOwner(actualOwner, event.linkId)
                  pendingLinks.delete(event.linkId)
                  if (latestIntentLinkId === event.linkId) latestIntentLinkId = null
                }
                break
              }
              case 'settle':
                actualOwner = clearSandboxUiDeepLinkProcessingOwner(actualOwner, event.linkId)
                pendingLinks.delete(event.linkId)
                if (expectedOwner === event.linkId) expectedOwner = null
                if (latestIntentLinkId === event.linkId) latestIntentLinkId = null
                break
            }

            expect(actualOwner).toBe(expectedOwner)
          }
        }
      ),
      { numRuns: 5_000 }
    )
  })

  it('prunes only absent metadata that is not owned by the active processor', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 100 }), { maxLength: 50 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 100 }), { maxLength: 50 }),
        fc.option(fc.integer({ min: 1, max: 100 }), { nil: null }),
        (metadataIds, pendingIds, processingOwnerId) => {
          const pending = new Set(pendingIds)
          const expected = new Set<number>()
          for (const linkId of metadataIds) {
            if (pending.has(linkId) || linkId === processingOwnerId) continue
            expected.add(linkId)
          }

          const actual = getSandboxUiDeepLinkMetadataIdsToPrune(
            metadataIds,
            pendingIds,
            processingOwnerId
          )

          expect(new Set(actual)).toEqual(expected)
          expect(actual).toHaveLength(expected.size)
        }
      ),
      { numRuns: 10_000 }
    )
  })

  it('merges live and cold-start links in FIFO order', () => {
    let pending = enqueuePendingSandboxUiDeepLink([], { id: 2, appRef: 'ns/two' }, null, null)
    pending = enqueuePendingSandboxUiDeepLink(pending, { id: 1, appRef: 'ns/one' }, null, 'user-a')

    expect(pending.map(item => item.link.id)).toEqual([1, 2])
    expect(pending.map(item => item.receivedIdentity)).toEqual(['user-a', null])
  })

  it('re-adds a link that arrives during its acknowledgement window', () => {
    const link = { id: 1, appRef: 'ns/app' }
    let pending = enqueuePendingSandboxUiDeepLink([], link, null, 'user-a')
    pending = removePendingSandboxUiDeepLink(pending, link.id)
    pending = enqueuePendingSandboxUiDeepLink(pending, link, null, 'user-a')

    expect(pending).toHaveLength(1)
    expect(pending[0]?.link).toEqual(link)
  })

  it('mirrors the bounded main-process queue size', () => {
    let pending: PendingSandboxUiDeepLink[] = []
    for (let id = 1; id <= MAX_PENDING_SANDBOX_UI_DEEP_LINKS + 2; id += 1) {
      pending = enqueuePendingSandboxUiDeepLink(
        pending,
        { id, appRef: `ns/app-${id}` },
        null,
        'user-a'
      )
    }

    expect(pending).toHaveLength(MAX_PENDING_SANDBOX_UI_DEEP_LINKS)
    expect(pending[0]?.link.id).toBe(3)
  })

  it('requires post-login confirmation for links received without an identity', () => {
    const pending = enqueuePendingSandboxUiDeepLink([], { id: 1, appRef: 'ns/app' }, null, null)

    expect(isPendingSandboxUiDeepLinkAwaitingConfirmation(pending[0]!, 'user-a')).toBe(true)

    const confirmed = confirmPendingSandboxUiDeepLink(pending, 1, 'user-a')

    expect(isPendingSandboxUiDeepLinkAwaitingConfirmation(confirmed[0]!, 'user-a')).toBe(false)
    expect(isPendingSandboxUiDeepLinkStale(confirmed[0]!, 'user-b')).toBe(true)
  })

  it('requires confirmation for links received by the authenticated identity', () => {
    const pending = enqueuePendingSandboxUiDeepLink([], { id: 1, appRef: 'ns/app' }, null, 'user-a')

    expect(isPendingSandboxUiDeepLinkAwaitingConfirmation(pending[0]!, 'user-a')).toBe(true)
    expect(isPendingSandboxUiDeepLinkStale(pending[0]!, 'user-a')).toBe(false)

    const confirmed = confirmPendingSandboxUiDeepLink(pending, 1, 'user-a')

    expect(isPendingSandboxUiDeepLinkAwaitingConfirmation(confirmed[0]!, 'user-a')).toBe(false)
    expect(isPendingSandboxUiDeepLinkStale(confirmed[0]!, 'user-b')).toBe(true)
  })

  it('treats authenticated queued links as stale after an identity change', () => {
    const pending = enqueuePendingSandboxUiDeepLink([], { id: 1, appRef: 'ns/app' }, null, 'user-a')

    expect(isPendingSandboxUiDeepLinkStale(pending[0]!, 'user-a')).toBe(false)
    expect(isPendingSandboxUiDeepLinkStale(pending[0]!, 'user-b')).toBe(true)
  })

  it('selects confirmation links only for the current authenticated identity', () => {
    const userALink = enqueuePendingSandboxUiDeepLink(
      [],
      { id: 1, appRef: 'ns/user-a-app' },
      null,
      'user-a'
    )
    const withUserBLink = enqueuePendingSandboxUiDeepLink(
      userALink,
      { id: 2, appRef: 'ns/user-b-app' },
      null,
      'user-b'
    )

    expect(findPendingSandboxUiDeepLinkAwaitingConfirmation(userALink, 'user-b')).toBeUndefined()
    expect(
      findPendingSandboxUiDeepLinkAwaitingConfirmation(withUserBLink, 'user-b')?.link.appRef
    ).toBe('ns/user-b-app')
  })

  it('tracks bounded retry delays and explicit failed state', () => {
    let pending = enqueuePendingSandboxUiDeepLink([], { id: 1, appRef: 'ns/app' }, null, 'user-a')
    pending = deferPendingSandboxUiDeepLink(pending, 1, 10_000)

    expect(pending[0]?.retryCount).toBe(1)
    expect(pending[0]?.nextRetryAt).toBe(11_000)
    expect(
      [0, 1, 2, 3, 4, MAX_SANDBOX_UI_DEEP_LINK_RETRY_ATTEMPTS + 10].map(
        nextSandboxUiDeepLinkRetryDelayMs
      )
    ).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000])

    pending = failPendingSandboxUiDeepLink(pending, 1, 'native mount failed')
    expect(pending[0]?.failedMessage).toBe('native mount failed')
    expect(pending[0]?.nextRetryAt).toBeUndefined()

    pending = dismissPendingSandboxUiDeepLinkFailure(pending, 1)
    expect(pending[0]?.failedMessageDismissed).toBe(true)

    pending = resetPendingSandboxUiDeepLinkFailure(pending, 1)
    expect(pending[0]?.failedMessage).toBeUndefined()
    expect(pending[0]?.failedMessageDismissed).toBe(false)
    expect(pending[0]?.retryCount).toBe(0)
  })

  it('shows a new failure after a dismissed failure is replaced', () => {
    let pending = enqueuePendingSandboxUiDeepLink([], { id: 1, appRef: 'ns/app' }, null, 'user-a')
    pending = failPendingSandboxUiDeepLink(pending, 1, 'first failure')
    pending = dismissPendingSandboxUiDeepLinkFailure(pending, 1)

    pending = failPendingSandboxUiDeepLink(pending, 1, 'replacement failure')

    expect(pending[0]?.failedMessage).toBe('replacement failure')
    expect(pending[0]?.failedMessageDismissed).toBe(false)
  })

  it('matches the retention model for arbitrary producer-backed interleavings', () => {
    fc.assert(
      fc.property(producerBackedInterleavingsArb(), operations => {
        const pending = enqueueOperations(operations)
        const ids = pending.map(item => item.link.id)

        expect(ids).toEqual([...ids].sort((left, right) => left - right))
        expect(new Set(ids).size).toBe(ids.length)
        expect(pending.length).toBeLessThanOrEqual(MAX_PENDING_SANDBOX_UI_DEEP_LINKS)
        expect(comparablePending(pending)).toEqual(
          comparableOperations(expectedRetainedOperations(operations))
        )
      })
    )
  })

  it('is idempotent when the same producer-backed link is enqueued repeatedly', () => {
    fc.assert(
      fc.property(producerBackedInterleavingsArb(), linkOperationArb(), (operations, link) => {
        const current = enqueueOperations(operations)
        const once = enqueuePendingSandboxUiDeepLink(
          current,
          link.link,
          link.conversationOrigin,
          link.receivedIdentity
        )
        const twice = enqueuePendingSandboxUiDeepLink(
          once,
          link.link,
          link.conversationOrigin,
          link.receivedIdentity
        )

        expect(twice).toEqual(once)
      })
    )
  })

  it('retains the correct high-id suffix when more than MAX links are represented', () => {
    fc.assert(
      fc.property(
        fc.array(targetPartsArb, {
          minLength: MAX_PENDING_SANDBOX_UI_DEEP_LINKS + 1,
          maxLength: MAX_PENDING_SANDBOX_UI_DEEP_LINKS + 15,
        }),
        parts => {
          const envelopes = producerEnvelopes(parts)
          const operations = [...envelopes].reverse().map<LinkOperation>(link => ({
            conversationOrigin: null,
            link,
            receivedIdentity: 'user-a',
          }))
          const pending = enqueueOperations(operations)

          expect(pending.map(item => item.link.id)).toEqual(
            envelopes.slice(-MAX_PENDING_SANDBOX_UI_DEEP_LINKS).map(link => link.id)
          )
        }
      )
    )
  })
})
