import { describe, expect, it } from 'vitest'
import {
  buildTraceExplorationUrl,
  clearTraceFilters,
  parseTraceExplorationState,
  traceActiveFilterCount,
  traceApiQuery,
  withTraceFilter,
  withoutTraceFilter,
} from '../governedTraceFilters'

describe('governed trace exploration filters', () => {
  it('restores only the family allowlist and normalizes repeated values', () => {
    const state = parseTraceExplorationState(
      new URLSearchParams({
        window: '7d',
        hostRef: ' chatllm,chatllm-stateless ',
        outcome: 'failed,succeeded,failed',
        targetUserId: 'must-be-ignored-for-sessions',
        cursor: 'must-never-be-shareable',
      }),
      'sessions'
    )

    expect(state).toEqual({
      window: '7d',
      from: null,
      to: null,
      filters: {
        hostRef: ['chatllm', 'chatllm-stateless'],
        outcome: ['failed', 'succeeded'],
      },
    })
    expect(buildTraceExplorationUrl('/traces', state)).toBe(
      '/traces?window=7d&hostRef=chatllm%2Cchatllm-stateless&outcome=failed%2Csucceeded'
    )
  })

  it('derives a stable bounded server query for a preset window', () => {
    const capturedNow = new Date('2026-07-14T12:00:00.000Z')
    const result = traceApiQuery(
      {
        window: '24h',
        from: null,
        to: null,
        filters: { approvalState: ['denied', 'approved', 'denied'] },
      },
      capturedNow
    )

    expect(result).toEqual({
      error: null,
      query: {
        occurredFrom: '2026-07-13T12:00:00.000Z',
        occurredTo: '2026-07-14T12:00:00.000Z',
        approvalState: 'approved,denied',
      },
    })
  })

  it('keeps the administrative target team filter shareable and server-backed', () => {
    const state = parseTraceExplorationState(
      new URLSearchParams({ window: '24h', teamId: 'team-1', hostRef: 'ignored' }),
      'administrative'
    )

    expect(state.filters).toEqual({ teamId: ['team-1'] })
    expect(traceApiQuery(state, new Date('2026-07-14T12:00:00.000Z')).query).toMatchObject({
      teamId: 'team-1',
    })
  })

  it('accepts a 30-day custom UTC range and rejects wider or invalid ranges', () => {
    const accepted = traceApiQuery({
      window: 'custom',
      from: '2026-06-14T00:00:00.000Z',
      to: '2026-07-14T00:00:00.000Z',
      filters: {},
    })
    expect(accepted.error).toBeNull()

    expect(
      traceApiQuery({
        window: 'custom',
        from: '2026-06-13T23:59:59.999Z',
        to: '2026-07-14T00:00:00.000Z',
        filters: {},
      }).error
    ).toBe('The custom UTC range cannot exceed 30 days.')
    expect(traceApiQuery({ window: 'custom', from: null, to: null, filters: {} }).error).toBe(
      'Choose both start and end values for the custom UTC range.'
    )
    expect(
      traceApiQuery({
        window: 'custom',
        from: '2026-07-14T00:00:00.000Z',
        to: '2026-07-13T00:00:00.000Z',
        filters: {},
      }).error
    ).toBe('The custom UTC start must be earlier than the end.')
  })

  it('adds, removes, counts, and clears column filters without mutating the input', () => {
    const initial = { window: '24h' as const, from: null, to: null, filters: {} }
    const withHost = withTraceFilter(initial, 'hostRef', [' chatllm ', 'chatllm'])
    const withOutcome = withTraceFilter(withHost, 'outcome', ['failed'])

    expect(initial.filters).toEqual({})
    expect(withOutcome.filters).toEqual({ hostRef: ['chatllm'], outcome: ['failed'] })
    expect(traceActiveFilterCount(withOutcome)).toBe(2)
    expect(withoutTraceFilter(withOutcome, 'hostRef').filters).toEqual({ outcome: ['failed'] })
    expect(clearTraceFilters(withOutcome).filters).toEqual({})
  })
})
