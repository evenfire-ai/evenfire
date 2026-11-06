// @vitest-environment jsdom
import { type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { describeGfsReadError, parseHttpStatus } from '@lib/gfsGrantErrors'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  affordancesFailureMessage,
  affordancesResult,
  affordancesTransportFailureMessage,
  heldAffordances,
} from '../__fixtures__/gfsProducerFixtures'
import { useGfsDragAdjudication } from '../dragAdjudication'
import type { GfsDragSource, GfsDropTargetFact } from '../dragSession.types'

const SCOPE = 'test:user-1:team-1'
const SESSION_GENERATION = 7

function dragSource(overrides: Partial<GfsDragSource> = {}): GfsDragSource {
  return {
    resourceId: 'src-1',
    gfsUri: 'gfs://main/src1',
    drive: 'main',
    kind: 'file',
    name: 'a.txt',
    version: 2,
    parentKnown: true,
    parentResourceId: 'parent-1',
    knownAncestorIds: ['parent-1'],
    origin: 'files',
    scope: SCOPE,
    generation: 1,
    ...overrides,
  }
}

function dropTarget(): GfsDropTargetFact {
  return {
    resourceId: 'dest-1',
    name: 'Reports',
    kind: 'directory',
    ancestorIds: ['root-1', null],
  }
}

type ProbeOutcome = { held: string[] } | { error: Error }

let probes: Record<string, ProbeOutcome>
let resolve: ReturnType<typeof vi.fn>

function installClerumGfsBridge() {
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        affordances: (resourceId: string, _drive?: string) => {
          const outcome = probes[resourceId]
          if (!outcome) {
            return Promise.reject(new Error(`no probe fixture for ${resourceId}`))
          }
          if ('error' in outcome) return Promise.reject(outcome.error)
          return Promise.resolve({
            ...outcome,
            canDelegate: false,
            grantableBits: [],
            canCreateShare: false,
          })
        },
      },
    },
  })
}

function renderAdjudication(
  handleAuthorityFailure?: (message: string, scope: string, generation: number) => boolean
) {
  const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const hook = renderHook(
    () =>
      useGfsDragAdjudication({
        scope: SCOPE,
        sessionGeneration: SESSION_GENERATION,
        drive: 'main',
        resolve: resolve as unknown as (gfsUri: string) => Promise<{
          resourceId: string
          parentResourceId: string | null
          name: string
          version: number
        }>,
        ...(handleAuthorityFailure ? { handleAuthorityFailure } : {}),
      }),
    { wrapper }
  )
  return { ...hook, queryClient }
}

async function grantedProbes(
  overrides: Record<string, ProbeOutcome> = {}
): Promise<Record<string, ProbeOutcome>> {
  return {
    'dest-1': { held: (await affordancesResult(heldAffordances(['write']))).held },
    'parent-1': { held: (await affordancesResult(heldAffordances(['write', 'delete']))).held },
    'src-1': { held: (await affordancesResult(heldAffordances(['write']))).held },
    ...overrides,
  }
}

beforeEach(() => {
  probes = {}
  resolve = vi.fn(async (gfsUri: string) => {
    throw new Error(`unexpected resolve of ${gfsUri}`)
  })
  installClerumGfsBridge()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useGfsDragAdjudication — unknown session generation', () => {
  it('does not resolve or read permission when published generation is unknown', async () => {
    const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
    const affordances = vi.fn(async () => ({ held: ['write', 'delete'] }))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: { gfs: { affordances } },
    })
    const unresolved = vi.fn(resolve) as unknown as (gfsUri: string) => Promise<{
      resourceId: string
      parentResourceId: string | null
      name: string
      version: number
    }>
    const hook = renderHook(
      () =>
        useGfsDragAdjudication({
          scope: SCOPE,
          sessionGeneration: null,
          drive: 'main',
          resolve: unresolved,
        }),
      { wrapper }
    )

    const decision = await hook.result.current.adjudicateDrop(dragSource(), dropTarget())

    expect(decision).toEqual({
      allowed: false,
      reason: 'unavailable',
      message: 'Could not verify permissions for this move.',
    })
    expect(unresolved).not.toHaveBeenCalled()
    expect(affordances).not.toHaveBeenCalled()
  })
})

describe('useGfsDragAdjudication — required-probe drop admission (R1-H1)', () => {
  it('refuses the drop when the destination probe fails with 500', async () => {
    const message = await affordancesFailureMessage(500)
    expect(parseHttpStatus(message)).toBe(500)
    probes = await grantedProbes({ 'dest-1': { error: new Error(message) } })
    const { result } = renderAdjudication()

    const decision = await result.current.adjudicateDrop(dragSource(), dropTarget())

    expect(decision).toEqual({
      allowed: false,
      reason: 'unavailable',
      message: describeGfsReadError(new Error(message)).message,
    })
  })

  it('refuses the drop when the destination probe fails at the transport layer', async () => {
    const message = await affordancesTransportFailureMessage()
    expect(parseHttpStatus(message)).toBeNull()
    probes = await grantedProbes({ 'dest-1': { error: new Error(message) } })
    const { result } = renderAdjudication()

    const decision = await result.current.adjudicateDrop(dragSource(), dropTarget())

    expect(decision).toEqual({
      allowed: false,
      reason: 'unavailable',
      message: describeGfsReadError(new Error(message)).message,
    })
  })

  it('refuses the drop when the source-parent probe fails with 403', async () => {
    const message = await affordancesFailureMessage(403, {
      code: 'forbidden',
      message: 'not authorized to read affordances',
    })
    expect(parseHttpStatus(message)).toBe(403)
    probes = await grantedProbes({ 'parent-1': { error: new Error(message) } })
    const { result } = renderAdjudication()

    const decision = await result.current.adjudicateDrop(dragSource(), dropTarget())

    expect(decision).toEqual({
      allowed: false,
      reason: 'unavailable',
      message: describeGfsReadError(new Error(message)).message,
    })
  })

  it('refuses the drop when the source-parent probe fails with 500', async () => {
    const message = await affordancesFailureMessage(500)
    probes = await grantedProbes({ 'parent-1': { error: new Error(message) } })
    const { result } = renderAdjudication()

    const decision = await result.current.adjudicateDrop(dragSource(), dropTarget())

    expect(decision).toEqual({
      allowed: false,
      reason: 'unavailable',
      message: describeGfsReadError(new Error(message)).message,
    })
  })

  it('maps a destination 401 to session-lost (existing semantics preserved)', async () => {
    const message = await affordancesFailureMessage(401, {
      code: 'unauthorized',
      message: 'session expired',
    })
    probes = await grantedProbes({ 'dest-1': { error: new Error(message) } })
    const { result } = renderAdjudication()

    const decision = await result.current.adjudicateDrop(dragSource(), dropTarget())

    expect(decision).toEqual({ allowed: false, reason: 'session-lost' })
  })

  it('maps a destination 429 to rate-limited unavailable (existing semantics preserved)', async () => {
    const message = await affordancesFailureMessage(429, {
      code: 'rate_limited',
      message: 'too many requests',
    })
    probes = await grantedProbes({ 'dest-1': { error: new Error(message) } })
    const { result } = renderAdjudication()

    const decision = await result.current.adjudicateDrop(dragSource(), dropTarget())

    expect(decision).toEqual({
      allowed: false,
      reason: 'unavailable',
      message: describeGfsReadError(new Error(message)).message,
    })
  })

  it('maps a destination 404 to target-unavailable (existing semantics preserved)', async () => {
    const message = await affordancesFailureMessage(404, {
      code: 'not_found',
      message: 'resource gone',
    })
    probes = await grantedProbes({ 'dest-1': { error: new Error(message) } })
    const { result } = renderAdjudication()

    const decision = await result.current.adjudicateDrop(dragSource(), dropTarget())

    expect(decision).toEqual({
      allowed: false,
      reason: 'target-unavailable',
      message: 'This folder is no longer available.',
    })
  })

  it('admits a fully granted drop and never resolves the read plane', async () => {
    probes = await grantedProbes()
    const { result } = renderAdjudication()

    const decision = await result.current.adjudicateDrop(dragSource(), dropTarget())

    expect(decision.allowed).toBe(true)
    if (decision.allowed) {
      expect(decision.allowNumberedRename).toBe(true)
      expect(decision.authority.kind).toBe('observed-allowed')
    }
    expect(resolve).not.toHaveBeenCalled()
  })

  it('denies a destination without write and a source parent without delete', async () => {
    probes = await grantedProbes({
      'dest-1': { held: (await affordancesResult(heldAffordances(['read']))).held },
    })
    const first = renderAdjudication()
    const deniedDestination = await first.result.current.adjudicateDrop(dragSource(), dropTarget())
    expect(deniedDestination).toEqual({ allowed: false, reason: 'destination-write' })

    cleanup()
    probes = await grantedProbes({
      'parent-1': { held: (await affordancesResult(heldAffordances(['write']))).held },
    })
    const second = renderAdjudication()
    const deniedDelete = await second.result.current.adjudicateDrop(dragSource(), dropTarget())
    expect(deniedDelete).toEqual({ allowed: false, reason: 'source-delete' })
  })

  it('still admits an authorized move when the optional rename probe fails', async () => {
    const message = await affordancesFailureMessage(500)
    probes = await grantedProbes({ 'src-1': { error: new Error(message) } })
    const { result } = renderAdjudication()

    const decision = await result.current.adjudicateDrop(dragSource(), dropTarget())

    expect(decision.allowed).toBe(true)
    if (decision.allowed) {
      expect(decision.allowNumberedRename).toBe(false)
    }
  })

  it('refuses the drop when the OPTIONAL rename probe reports a session failure', async () => {
    // The rename probe is optional for the MOVE, so an ordinary failure only
    // withdraws the rename option. A session failure is not ordinary: the
    // session the move would be dispatched with is gone, so the drop must be
    // refused terminally instead of being dispatched into a dead session.
    const message = await affordancesFailureMessage(401)
    probes = await grantedProbes({ 'src-1': { error: new Error(message) } })
    const handleAuthorityFailure = vi.fn(() => true)
    const { result } = renderAdjudication(handleAuthorityFailure)

    const decision = await result.current.adjudicateDrop(dragSource(), dropTarget())

    expect(decision).toEqual({ allowed: false, reason: 'session-lost' })
    // The surface is told the session is gone, so it revokes instead of
    // leaving an active session over a dead one.
    expect(handleAuthorityFailure).toHaveBeenCalled()
  })
})

describe('useGfsDragAdjudication — the rename probe reads a fresh observation (RP-023)', () => {
  it('re-probes the source instead of trusting a stale cached positive', async () => {
    // The numbered-rename option authorizes a mutation. A cached "write" from
    // an older observation used to answer the probe directly, so a member
    // whose write access had since been revoked was still offered the rename
    // — and the move was only refused later, by the server.
    const message = await affordancesFailureMessage(403, {
      code: 'manage_acl_required',
      message: 'write access was revoked',
    })
    probes = await grantedProbes({ 'src-1': { error: new Error(message) } })
    const { result, queryClient } = renderAdjudication()
    const key = desktopQueryKeys.gfsAffordances(SCOPE, 'src-1', 'main', SESSION_GENERATION)

    // A minute-old observation of "write": stale, so it may not decide.
    queryClient.setQueryData(key, { held: ['write'] }, { updatedAt: Date.now() - 60_000 })
    expect(await result.current.probeSourceWrite('src-1')).toBe(false)

    // A current observation still answers without a network read: the probe
    // fixture would fail if one were made.
    queryClient.setQueryData(key, { held: ['write'] })
    expect(await result.current.probeSourceWrite('src-1')).toBe(true)
  })
})

describe('useGfsDragAdjudication — probe 401 revokes the session', () => {
  it('reports a 401 from the affordances probe to the fail-closed classifier', async () => {
    const message = await affordancesFailureMessage(401, {
      code: 'unauthorized',
      message: 'session expired',
    })
    probes = await grantedProbes({ 'dest-1': { error: new Error(message) } })
    const handleAuthorityFailure = vi.fn(() => true)
    const { result } = renderAdjudication(handleAuthorityFailure)

    const decision = await result.current.adjudicateDrop(dragSource(), dropTarget())

    expect(decision).toEqual({ allowed: false, reason: 'session-lost' })
    expect(handleAuthorityFailure).toHaveBeenCalledWith(message, SCOPE, SESSION_GENERATION)
  })

  it('reports a 401 from the direct source resolve to the fail-closed classifier', async () => {
    // An unknown source parent forces the direct resolve of the source; a 401
    // there must revoke, not just refuse the drop.
    const message = 'Error invoking remote method: Error: 401 Unauthorized httpStatus=401'
    resolve = vi.fn(async () => {
      throw new Error(message)
    })
    probes = await grantedProbes()
    const handleAuthorityFailure = vi.fn(() => true)
    const { result } = renderAdjudication(handleAuthorityFailure)

    const decision = await result.current.adjudicateDrop(
      dragSource({ parentKnown: false, parentResourceId: null }),
      dropTarget()
    )

    expect(decision).toEqual({ allowed: false, reason: 'session-lost' })
    expect(handleAuthorityFailure).toHaveBeenCalledWith(message, SCOPE, SESSION_GENERATION)
  })

  it('reports a 401 from the ancestor resolve to the fail-closed classifier', async () => {
    const message = 'Error invoking remote method: Error: 401 Unauthorized httpStatus=401'
    resolve = vi.fn(async () => {
      throw new Error(message)
    })
    probes = await grantedProbes()
    const handleAuthorityFailure = vi.fn(() => true)
    const { result } = renderAdjudication(handleAuthorityFailure)

    const decision = await result.current.adjudicateDrop(
      dragSource({ kind: 'directory', knownAncestorIds: [] }),
      // An unproven chain (no root sentinel) forces the ancestor resolve.
      { ...dropTarget(), ancestorIds: ['root-1'] }
    )

    expect(handleAuthorityFailure).toHaveBeenCalledWith(message, SCOPE, SESSION_GENERATION)
    // A session failure is TERMINAL for the gesture: the ancestry read died
    // with the session, so the adjudication must not continue into the later
    // probes and answer "allowed" over a dead session (RP-002).
    expect(decision).toEqual({ allowed: false, reason: 'session-lost' })
    // The failed resolve is the LAST read: nothing after it ran.
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('leaves a policy verdict local: a 403 probe never reaches the classifier', async () => {
    const message = await affordancesFailureMessage(403, {
      code: 'forbidden',
      message: 'not authorized to read affordances',
    })
    probes = await grantedProbes({ 'dest-1': { error: new Error(message) } })
    const handleAuthorityFailure = vi.fn(() => true)
    const { result } = renderAdjudication(handleAuthorityFailure)

    const decision = await result.current.adjudicateDrop(dragSource(), dropTarget())

    expect(decision.allowed).toBe(false)
    expect(handleAuthorityFailure).not.toHaveBeenCalled()
  })
})
