import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { normalizeGfsResourceUri } from '@clerum/desktop-app-links'
import type { PendingSandboxUiDeepLink } from '@/App.types'
import {
  classifyGfsDeepLinkActivation,
  derivePendingGfsDeepLinkConfirmation,
  isGfsDeepLinkAcceptable,
} from './gfsDeepLinkState'
import type { GfsResourceNavigationRequest } from './gfsResourceNavigationIntent'

// Each `old*` function below wraps, verbatim, the expression App.tsx evaluated
// inline before the extraction. They are the oracle: do not edit them to match
// the module.

type PendingGfsDeepLink = {
  envelope: { id: number; uri: string }
  uri: string
  receivedIdentity: string | null
  request: GfsResourceNavigationRequest | null
}

type Ref<T> = { current: T }

function oldPendingGfsDeepLinkConfirmation(
  pendingSandboxUiConfirmation: PendingSandboxUiDeepLink | null,
  failedSandboxUiDeepLink: PendingSandboxUiDeepLink | null | undefined,
  hasConfirmedSandboxUiDeepLink: boolean,
  processingSandboxUiDeepLinkIdRef: Ref<number | null>,
  bootSplashLoading: boolean,
  vm: { isAuthenticated: boolean; authenticatedPrincipalIdentity: string | null },
  sessionInvalidation: object | null,
  gfsDeepLinkAcceptingRef: Ref<boolean>,
  processingGfsDeepLinkIdRef: Ref<number | null>,
  activeGfsDeepLink: GfsResourceNavigationRequest | null,
  firstPendingGfsDeepLink: PendingGfsDeepLink | undefined
) {
  const pendingGfsDeepLinkConfirmation =
    !pendingSandboxUiConfirmation &&
    !failedSandboxUiDeepLink &&
    !hasConfirmedSandboxUiDeepLink &&
    processingSandboxUiDeepLinkIdRef.current === null &&
    !bootSplashLoading &&
    vm.isAuthenticated &&
    !!vm.authenticatedPrincipalIdentity &&
    !sessionInvalidation &&
    gfsDeepLinkAcceptingRef.current &&
    processingGfsDeepLinkIdRef.current === null &&
    activeGfsDeepLink === null &&
    firstPendingGfsDeepLink?.request === null &&
    (firstPendingGfsDeepLink.receivedIdentity === null ||
      firstPendingGfsDeepLink.receivedIdentity === vm.authenticatedPrincipalIdentity)
      ? firstPendingGfsDeepLink
      : null
  return pendingGfsDeepLinkConfirmation
}

function oldEnqueueFilterAccepts(
  value: { id: number },
  gfsDeepLinkAcceptingRef: Ref<boolean>,
  gfsDeepLinkMinimumIdRef: Ref<number>,
  acknowledgedGfsDeepLinkIdsRef: Ref<Set<number>>,
  pendingGfsDeepLinksRef: Ref<PendingGfsDeepLink[]>
): boolean {
  if (!gfsDeepLinkAcceptingRef.current || value.id < gfsDeepLinkMinimumIdRef.current) return false
  if (acknowledgedGfsDeepLinkIdsRef.current.has(value.id)) return false
  if (pendingGfsDeepLinksRef.current.some(item => item.envelope.id === value.id)) return false
  return true
}

type Effect = readonly ['ack', number] | readonly ['toast'] | readonly ['activate', number]

function oldActivationEffects(
  activeGfsDeepLinkRef: Ref<GfsResourceNavigationRequest | null>,
  pendingGfsDeepLinksRef: Ref<PendingGfsDeepLink[]>,
  gfsDeepLinkGenerationRef: Ref<number>,
  processingGfsDeepLinkIdRef: Ref<number | null>,
  bootSplashLoading: boolean,
  vm: {
    isNavigationIntentCurrent: (sequence: number) => boolean
    isAuthenticated: boolean
    authenticatedPrincipalIdentity: string | null
  }
): Effect[] {
  const effects: Effect[] = []
  const acknowledgeGfsDeepLink = (id: number) => effects.push(['ack', id])
  const toast = () => effects.push(['toast'])
  ;(() => {
    const active = activeGfsDeepLinkRef.current
    if (
      active &&
      (active.principalGeneration !== gfsDeepLinkGenerationRef.current ||
        !vm.isNavigationIntentCurrent(active.intentSequence))
    ) {
      void acknowledgeGfsDeepLink(active.id)
      return
    }

    const pending = pendingGfsDeepLinksRef.current.find(item => item.request !== null)?.request
    if (
      pending &&
      (pending.principalGeneration !== gfsDeepLinkGenerationRef.current ||
        !vm.isNavigationIntentCurrent(pending.intentSequence))
    ) {
      void acknowledgeGfsDeepLink(pending.id)
      return
    }

    if (
      bootSplashLoading ||
      !vm.isAuthenticated ||
      !vm.authenticatedPrincipalIdentity ||
      processingGfsDeepLinkIdRef.current !== null
    ) {
      return
    }
    if (!pending) return
    const uri = normalizeGfsResourceUri(pending.uri)
    if (!uri) {
      void acknowledgeGfsDeepLink(pending.id)
      toast()
      return
    }
    effects.push(['activate', pending.id])
  })()
  return effects
}

// Mirrors how App.tsx turns each decision into effects; the malformed branch
// acknowledges before it toasts.
function newActivationEffects(
  decision: ReturnType<typeof classifyGfsDeepLinkActivation>
): Effect[] {
  if (decision.kind === 'acknowledge') return [['ack', decision.id]]
  if (decision.kind === 'wait') return []
  if (decision.kind === 'malformed') return [['ack', decision.id], ['toast']]
  return [['activate', decision.request.id]]
}

const VALID_URI = 'gfs://main/0123456789abcdef0123456789abcdef'
const VALID_URIS = [VALID_URI, 'gfs://main/abababababababababababababababab']
const MALFORMED_URIS = ['', 'not-a-gfs-uri', 'gfs://', 'https://example.test/file']

// Biases an input toward the value that keeps the decision on its most
// permissive path, so the properties reach the rare outcomes (the dialog
// opening, an activation) and each one-input deviation from them.
function mostly<A, B>(eligible: fc.Arbitrary<A>, other: fc.Arbitrary<B>): fc.Arbitrary<A | B> {
  return fc.oneof({ weight: 9, arbitrary: eligible }, { weight: 1, arbitrary: other })
}

const identity = fc.constantFrom<string | null>(null, '', 'user-a', 'user-b')
const smallId = fc.integer({ min: 1, max: 6 })

const request: fc.Arbitrary<GfsResourceNavigationRequest> = fc.record({
  id: smallId,
  uri: fc.constantFrom(...VALID_URIS, ...MALFORMED_URIS),
  ownerTabId: fc.constant('files-1'),
  intentSequence: fc.integer({ min: 0, max: 3 }),
  principalGeneration: fc.integer({ min: 0, max: 2 }),
  userNavigationGenerationAtActivation: fc.integer({ min: 0, max: 2 }),
  createDestination: fc.boolean(),
})

// The activation property's generation is 0 and its current intent is 1.
const currentRequest: fc.Arbitrary<GfsResourceNavigationRequest> = fc.record({
  id: smallId,
  uri: mostly(fc.constantFrom(...VALID_URIS), fc.constantFrom(...MALFORMED_URIS)),
  ownerTabId: fc.constant('files-1'),
  intentSequence: mostly(fc.constant(1), fc.integer({ min: 0, max: 3 })),
  principalGeneration: mostly(fc.constant(0), fc.integer({ min: 0, max: 2 })),
  userNavigationGenerationAtActivation: fc.integer({ min: 0, max: 2 }),
  createDestination: fc.boolean(),
})

const pendingEntryWith = (
  entryRequest: fc.Arbitrary<GfsResourceNavigationRequest>
): fc.Arbitrary<PendingGfsDeepLink> =>
  fc
    .record({
      id: smallId,
      uri: fc.constantFrom(...VALID_URIS),
      receivedIdentity: identity,
      request: fc.option(entryRequest, { nil: null }),
    })
    .map(({ id, uri, receivedIdentity, request: generatedRequest }) => ({
      envelope: { id, uri },
      uri,
      receivedIdentity,
      request: generatedRequest,
    }))

const pendingEntry = pendingEntryWith(request)

const sandboxLink = fc.constantFrom(
  { link: { id: 101 } } as unknown as PendingSandboxUiDeepLink,
  { link: { id: 102 } } as unknown as PendingSandboxUiDeepLink
)

describe('gfsDeepLinkState', () => {
  it('derives the confirmation dialog link exactly as the previous inline expression', () => {
    let opened = 0
    fc.assert(
      fc.property(
        fc.record({
          pendingSandboxUiConfirmation: mostly(fc.constant(null), sandboxLink),
          failedSandboxUiDeepLink: mostly(fc.constantFrom(null, undefined), sandboxLink),
          hasConfirmedSandboxUiDeepLink: mostly(fc.constant(false), fc.constant(true)),
          processingSandboxUiDeepLinkId: mostly(fc.constant(null), smallId),
          bootSplashLoading: mostly(fc.constant(false), fc.constant(true)),
          isAuthenticated: mostly(fc.constant(true), fc.constant(false)),
          authenticatedPrincipalIdentity: mostly(fc.constantFrom('user-a', 'user-b'), identity),
          sessionInvalidation: mostly(
            fc.constant(null),
            fc.constant({ sessionGeneration: 1, appDeepLinkMinimumId: 1, gfsDeepLinkMinimumId: 1 })
          ),
          gfsDeepLinkAccepting: mostly(fc.constant(true), fc.constant(false)),
          processingGfsDeepLinkId: mostly(fc.constant(null), smallId),
          activeGfsDeepLink: mostly(fc.constant(null), request),
          firstPendingGfsDeepLink: mostly(
            pendingEntry.map(entry => ({ ...entry, request: null })),
            fc.option(pendingEntry, { nil: undefined })
          ),
        }),
        input => {
          const expected = oldPendingGfsDeepLinkConfirmation(
            input.pendingSandboxUiConfirmation,
            input.failedSandboxUiDeepLink,
            input.hasConfirmedSandboxUiDeepLink,
            { current: input.processingSandboxUiDeepLinkId },
            input.bootSplashLoading,
            {
              isAuthenticated: input.isAuthenticated,
              authenticatedPrincipalIdentity: input.authenticatedPrincipalIdentity,
            },
            input.sessionInvalidation,
            { current: input.gfsDeepLinkAccepting },
            { current: input.processingGfsDeepLinkId },
            input.activeGfsDeepLink,
            input.firstPendingGfsDeepLink
          )
          const actual = derivePendingGfsDeepLinkConfirmation(input)
          expect(actual).toBe(expected)
          if (actual !== null) opened += 1
        }
      ),
      { numRuns: 20_000 }
    )
    expect(opened).toBeGreaterThan(1_000)
  })

  it('filters deliveries exactly as the previous enqueue guard, across repeated deliveries', () => {
    type Op =
      | { kind: 'deliver'; id: number }
      | { kind: 'acknowledge'; id: number }
      | { kind: 'accepting'; value: boolean }
      | { kind: 'minimum'; value: number }
    const op: fc.Arbitrary<Op> = fc.oneof(
      { weight: 6, arbitrary: smallId.map(id => ({ kind: 'deliver' as const, id })) },
      { weight: 2, arbitrary: smallId.map(id => ({ kind: 'acknowledge' as const, id })) },
      { weight: 1, arbitrary: fc.boolean().map(value => ({ kind: 'accepting' as const, value })) },
      {
        weight: 1,
        arbitrary: fc
          .integer({ min: 0, max: 7 })
          .map(value => ({ kind: 'minimum' as const, value })),
      }
    )

    let rejectedAsAcknowledged = 0
    let rejectedAsPending = 0
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.integer({ min: 0, max: 3 }),
        fc.array(op, { maxLength: 40 }),
        (initialAccepting, initialMinimum, ops) => {
          const accepting = { current: initialAccepting }
          const minimum = { current: initialMinimum }
          const acknowledged = { current: new Set<number>() }
          const pending: Ref<PendingGfsDeepLink[]> = { current: [] }

          for (const step of ops) {
            if (step.kind === 'accepting') accepting.current = step.value
            else if (step.kind === 'minimum') minimum.current = step.value
            else if (step.kind === 'acknowledge') {
              acknowledged.current.add(step.id)
              pending.current = pending.current.filter(item => item.envelope.id !== step.id)
            } else {
              const expected = oldEnqueueFilterAccepts(
                { id: step.id },
                accepting,
                minimum,
                acknowledged,
                pending
              )
              const actual = isGfsDeepLinkAcceptable(step.id, {
                accepting: accepting.current,
                minimumId: minimum.current,
                acknowledgedIds: acknowledged.current,
                pending: pending.current,
              })
              expect(actual).toBe(expected)
              if (accepting.current && step.id >= minimum.current) {
                if (acknowledged.current.has(step.id)) rejectedAsAcknowledged += 1
                else if (pending.current.some(item => item.envelope.id === step.id)) {
                  rejectedAsPending += 1
                }
              }
              if (actual) {
                const uri = VALID_URI
                pending.current = [
                  ...pending.current,
                  { envelope: { id: step.id, uri }, uri, receivedIdentity: null, request: null },
                ]
              }
            }
          }
        }
      ),
      { numRuns: 5_000 }
    )
    // Redeliveries of an id already queued or acknowledged must actually occur,
    // or the duplicate clauses are never exercised.
    expect(rejectedAsAcknowledged).toBeGreaterThan(100)
    expect(rejectedAsPending).toBeGreaterThan(100)
  })

  it('classifies the activation exactly as the previous inline effect', () => {
    const kinds = new Map<string, number>()
    fc.assert(
      fc.property(
        fc.record({
          active: mostly(fc.constant(null), currentRequest),
          pending: fc.array(pendingEntryWith(currentRequest), { maxLength: 4 }),
          principalGeneration: mostly(fc.constant(0), fc.integer({ min: 0, max: 2 })),
          currentIntents: mostly(
            fc.constant<number[]>([1]),
            fc.uniqueArray(fc.integer({ min: 0, max: 3 }), { maxLength: 4 })
          ),
          bootSplashLoading: mostly(fc.constant(false), fc.constant(true)),
          isAuthenticated: mostly(fc.constant(true), fc.constant(false)),
          authenticatedPrincipalIdentity: mostly(fc.constant('user-a'), identity),
          processingGfsDeepLinkId: mostly(fc.constant(null), smallId),
        }),
        input => {
          const oldCalls: number[] = []
          const newCalls: number[] = []
          const intentCheck = (calls: number[]) => (sequence: number) => {
            calls.push(sequence)
            return input.currentIntents.includes(sequence)
          }
          const expected = oldActivationEffects(
            { current: input.active },
            { current: input.pending },
            { current: input.principalGeneration },
            { current: input.processingGfsDeepLinkId },
            input.bootSplashLoading,
            {
              isNavigationIntentCurrent: intentCheck(oldCalls),
              isAuthenticated: input.isAuthenticated,
              authenticatedPrincipalIdentity: input.authenticatedPrincipalIdentity,
            }
          )
          const decision = classifyGfsDeepLinkActivation({
            active: input.active,
            pending: input.pending,
            principalGeneration: input.principalGeneration,
            isNavigationIntentCurrent: intentCheck(newCalls),
            bootSplashLoading: input.bootSplashLoading,
            isAuthenticated: input.isAuthenticated,
            authenticatedPrincipalIdentity: input.authenticatedPrincipalIdentity,
            processingGfsDeepLinkId: input.processingGfsDeepLinkId,
          })
          kinds.set(decision.kind, (kinds.get(decision.kind) ?? 0) + 1)
          expect(newActivationEffects(decision)).toEqual(expected)
          expect(newCalls).toEqual(oldCalls)
        }
      ),
      { numRuns: 20_000 }
    )
    for (const kind of ['acknowledge', 'wait', 'malformed', 'activate']) {
      expect(kinds.get(kind) ?? 0, kind).toBeGreaterThan(500)
    }
  })

  it('returns the activation request object itself, not a copy', () => {
    const pendingRequest: GfsResourceNavigationRequest = {
      id: 3,
      uri: VALID_URI,
      ownerTabId: 'files-1',
      intentSequence: 1,
      principalGeneration: 0,
      userNavigationGenerationAtActivation: 0,
      createDestination: false,
    }
    const decision = classifyGfsDeepLinkActivation({
      active: null,
      pending: [
        {
          envelope: { id: 3 },
          receivedIdentity: null,
          request: pendingRequest,
        },
      ],
      principalGeneration: 0,
      isNavigationIntentCurrent: sequence => sequence === 1,
      bootSplashLoading: false,
      isAuthenticated: true,
      authenticatedPrincipalIdentity: 'user-a',
      processingGfsDeepLinkId: null,
    })
    expect(decision).toEqual({ kind: 'activate', request: pendingRequest })
    expect(decision.kind === 'activate' && decision.request).toBe(pendingRequest)
  })
})
