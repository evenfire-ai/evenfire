import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fetchUsageSeries, fetchUsageTotals } from '@lib/api'
import { ToastProvider } from '@/components/Toast'
import { UsageDashboard } from '@/components/UsageDashboard'

const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8')

vi.mock('@lib/api', () => ({
  fetchUsageSeries: (...args: unknown[]) => mockFetchSeries(...args),
  fetchUsageTotals: (...args: unknown[]) => mockFetchTotals(...args),
  getAdminTeams: vi.fn().mockResolvedValue({ items: [] }),
  getAdminUsers: vi.fn().mockResolvedValue({ items: [] }),
}))

vi.mock('recharts', () => ({
  Area: () => null,
  AreaChart: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}))

const mockFetchSeries = vi.fn()
const mockFetchTotals = vi.fn()

function cssRuleBody(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'm'))
  if (!match) throw new Error(`Missing CSS rule for ${selector}`)
  return match[1]
}

// A selector can appear in several rules (alone and inside comma groups);
// assert on the first rule whose body carries the declaration.
function someRuleDeclares(selector: string, declaration: RegExp): boolean {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'gm'))].some(match =>
    declaration.test(match[1])
  )
}

// The /cost/usage shell locks scrolling: .cu-main is height:100vh with
// overflow:hidden, .cu-cost-layout is height:100% without overflow, and the
// viewport-fill card clips (.cu-card { overflow: hidden }). The usage body is
// the flexed child of that card (flex:1; min-height:0), so unless it scrolls
// itself, content past the fold is unreachable — the LLM Usage page could not
// scroll (BUG-134). Sibling cost pages scroll through .cu-table-wrap; the
// usage page has no table wrap, so its body owns the overflow.
//
// The stylesheet assertions below are what fails without the fix; the render
// assertion proves the component actually targets that pane, so together they
// pin both halves of the contract in one place.
describe('LLM Usage scroll contract', () => {
  beforeEach(() => {
    mockFetchSeries.mockReset()
    mockFetchSeries.mockResolvedValue({
      from: '',
      to: '',
      interval: '5min',
      groupBy: 'host_ref',
      rows: [],
    })
    mockFetchTotals.mockReset()
    mockFetchTotals.mockResolvedValue({
      from: '',
      to: '',
      interval: '5min',
      groupBy: 'team_id',
      rows: [],
    })
  })

  afterEach(cleanup)

  it('makes the flexed usage body the scroll container inside the height-capped shell', () => {
    expect(cssRuleBody('.cu-card--viewport-fill > .cu-card__body.cu-usage-body')).toMatch(
      /overflow:\s*auto/
    )
  })

  it('keeps the body a shrinkable flex child so it can actually overflow', () => {
    expect(someRuleDeclares('.cu-card--viewport-fill > .cu-card__body', /min-height:\s*0/)).toBe(
      true
    )
  })

  it('renders overflowing breakdown rows inside the pane the stylesheet scrolls', async () => {
    mockFetchTotals.mockResolvedValueOnce({
      from: '',
      to: '',
      interval: '5min',
      groupBy: 'team_id',
      rows: Array.from({ length: 10 }, (_, index) => ({
        group: `team-${index}`,
        input_tokens: 10,
        output_tokens: 10,
        total_tokens: 20,
        request_count: 2,
      })),
    })
    const { container } = render(
      <ToastProvider>
        <UsageDashboard />
      </ToastProvider>
    )
    fireEvent.change(screen.getByLabelText('Break down by'), { target: { value: 'team_id' } })
    expect(await screen.findByText(/team-9/)).toBeTruthy()
    const pane = container.querySelector('.cu-card--viewport-fill > .cu-card__body.cu-usage-body')
    expect(pane).not.toBeNull()
    expect(pane?.contains(screen.getByText(/team-9/))).toBe(true)
  })
})
