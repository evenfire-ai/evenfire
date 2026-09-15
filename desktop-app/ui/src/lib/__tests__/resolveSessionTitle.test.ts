import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  type PendingRename,
  type ResolveSessionTitleInput,
  resolveSessionTitle,
} from '@lib/resolveSessionTitle'

const PLACEHOLDER = 'Remote · abcdefgh'

describe('resolveSessionTitle — §2.2 decision table (cases A–D)', () => {
  it('case A: server-only + server title -> server (kills the placeholder)', () => {
    expect(
      resolveSessionTitle({
        inCache: false,
        serverTitle: 'Deploy the staging cluster',
        pendingRename: 'none',
        placeholder: PLACEHOLDER,
      })
    ).toEqual({ title: 'Deploy the staging cluster', source: 'server' })
  })

  it('case B: server-only + no server title -> placeholder', () => {
    expect(
      resolveSessionTitle({
        inCache: false,
        pendingRename: 'none',
        placeholder: PLACEHOLDER,
      })
    ).toEqual({ title: PLACEHOLDER, source: 'placeholder' })
  })

  it('case C: cached + server title -> server (A picks up B’s rename)', () => {
    expect(
      resolveSessionTitle({
        inCache: true,
        localTitle: 'old local name',
        serverTitle: 'renamed on device B',
        pendingRename: 'none',
        placeholder: PLACEHOLDER,
      })
    ).toEqual({ title: 'renamed on device B', source: 'server' })
  })

  it('case D: cached + no server title -> local fallback', () => {
    expect(
      resolveSessionTitle({
        inCache: true,
        localTitle: 'my local name',
        pendingRename: 'none',
        placeholder: PLACEHOLDER,
      })
    ).toEqual({ title: 'my local name', source: 'local' })
  })

  it('treats an empty/whitespace-stripped server title as absent (falls to local)', () => {
    expect(
      resolveSessionTitle({
        inCache: true,
        localTitle: 'keep me',
        serverTitle: '',
        pendingRename: 'none',
        placeholder: PLACEHOLDER,
      })
    ).toEqual({ title: 'keep me', source: 'local' })
  })
})

describe('resolveSessionTitle — Fase B branches reachable (cases E/F)', () => {
  it('a pending local rename wins over the server (in-flight / offline)', () => {
    for (const pendingRename of ['in-flight', 'offline'] as PendingRename[]) {
      expect(
        resolveSessionTitle({
          inCache: true,
          localTitle: 'optimistic name',
          serverTitle: 'stale server name',
          pendingRename,
          placeholder: PLACEHOLDER,
        })
      ).toEqual({ title: 'optimistic name', source: 'local' })
    }
  })
})

// ── Property-based (pr-discipline T2) ────────────────────────────────────────

const nonEmpty = fc.string({ minLength: 1 }).filter(s => s.length > 0)

const arbInput: fc.Arbitrary<ResolveSessionTitleInput> = fc.record({
  inCache: fc.boolean(),
  localTitle: fc.option(fc.string(), { nil: undefined }),
  serverTitle: fc.option(fc.string(), { nil: undefined }),
  pendingRename: fc.constantFrom<PendingRename>('none', 'in-flight', 'offline'),
  placeholder: nonEmpty,
})

describe('resolveSessionTitle — properties (T2)', () => {
  it('is deterministic', () => {
    fc.assert(
      fc.property(arbInput, input => {
        expect(resolveSessionTitle(input)).toEqual(resolveSessionTitle(input))
      })
    )
  })

  it('server title (non-empty) + no pending rename => source is server', () => {
    fc.assert(
      fc.property(arbInput, nonEmpty, (input, serverTitle) => {
        const result = resolveSessionTitle({
          ...input,
          serverTitle,
          pendingRename: 'none',
        })
        expect(result).toEqual({ title: serverTitle, source: 'server' })
      })
    )
  })

  it('no server title + a non-empty local cache => never a placeholder (case D)', () => {
    fc.assert(
      fc.property(
        nonEmpty,
        nonEmpty,
        fc.constantFrom<PendingRename>('none', 'offline', 'in-flight'),
        (localTitle, placeholder, pendingRename) => {
          const result = resolveSessionTitle({
            inCache: true,
            localTitle,
            serverTitle: undefined,
            pendingRename,
            placeholder,
          })
          expect(result.source).toBe('local')
          expect(result.title).toBe(localTitle)
        }
      )
    )
  })

  it('server-only + no server title => placeholder (case B)', () => {
    fc.assert(
      fc.property(
        nonEmpty,
        fc.constantFrom<PendingRename>('none', 'offline', 'in-flight'),
        (placeholder, pendingRename) => {
          const result = resolveSessionTitle({
            inCache: false,
            serverTitle: undefined,
            pendingRename,
            placeholder,
          })
          expect(result).toEqual({ title: placeholder, source: 'placeholder' })
        }
      )
    )
  })

  it('is idempotent: feeding the resolved title back as the local cache is stable', () => {
    fc.assert(
      fc.property(arbInput, input => {
        const first = resolveSessionTitle(input)
        // Model the catalog merge applied twice: the resolved chat is now cached
        // with the resolved title, while the server input and the pending state
        // are unchanged. Re-resolving must not drift the shown title.
        const second = resolveSessionTitle({
          ...input,
          inCache: true,
          localTitle: first.title,
        })
        expect(second.title).toBe(first.title)
      })
    )
  })
})
