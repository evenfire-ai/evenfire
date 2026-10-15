// The table a dashboard shows when Chart.js is not inlined holds what the
// chart draws, not what was sent.
import { describe, expect, it } from 'vitest'
import { prepareDashboardChart } from '../dashboardCharts'

describe('the table shown in place of a chart', () => {
  it('shows the one value a gauge draws, not the ones it left out', () => {
    const prepared = prepareDashboardChart(
      { type: 'gauge', labels: ['CPU', 'RAM'], datasets: [{ label: 'Load', data: [40, 80] }] },
      'charts[0]'
    )
    expect(prepared.warnings.join(' ')).toContain('1 more in datasets[0].data was left out')
    expect(prepared.table).toEqual({
      labels: ['CPU', 'Max'],
      series: [{ label: 'Load', values: ['40', '100'] }],
    })
  })

  it('shows the reading a gauge prints when it is past the dial', () => {
    const prepared = prepareDashboardChart(
      { type: 'gauge', gaugeMax: 50, datasets: [{ data: [72.456] }] },
      'charts[0]'
    )
    expect(prepared.table?.series[0].values).toEqual(['72.46', '50'])
  })

  it("lists a funnel's stages in the order it draws them", () => {
    const prepared = prepareDashboardChart(
      {
        type: 'funnel',
        labels: ['Visit', 'Buy', 'Cart'],
        datasets: [{ label: 'Users', data: [100, 10, 40] }],
      },
      'charts[0]'
    )
    expect(prepared.table).toEqual({
      labels: ['Visit', 'Cart', 'Buy'],
      series: [{ label: 'Users', values: ['100', '40', '10'] }],
    })
  })

  it("lists a waterfall's changes as sent and the total it draws", () => {
    const prepared = prepareDashboardChart(
      {
        type: 'waterfall',
        labels: ['Start', 'Sales', 'Costs'],
        datasets: [{ label: 'Cash', data: [0.1, 0.2, -0.125] }],
      },
      'charts[0]'
    )
    expect(prepared.table).toEqual({
      labels: ['Start', 'Sales', 'Costs', 'Total'],
      series: [{ label: 'Cash', values: ['0.1', '0.2', '-0.125', '0.175'] }],
    })
  })

  it('reads the first number a gauge was sent, as the PNG gauge does', () => {
    const prepared = prepareDashboardChart(
      { type: 'gauge', labels: ['CPU'], datasets: [{ data: [null, 50] }] },
      'charts[0]'
    )
    expect(prepared.table?.series[0].values).toEqual(['50', '100'])
    expect(prepared.warnings.join(' ')).not.toContain('left out')
  })

  it('heads an unlabeled gauge with no made-up position', () => {
    const prepared = prepareDashboardChart(
      { type: 'gauge', datasets: [{ label: 'Load', data: [40] }] },
      'charts[0]'
    )
    expect(prepared.table?.labels).toEqual(['', 'Max'])
  })

  it('keeps every series of an ordinary chart', () => {
    const prepared = prepareDashboardChart(
      {
        type: 'bar',
        labels: ['a', 'b'],
        datasets: [
          { label: 'One', data: [1, null] },
          { label: 'Two', data: [3, 4] },
        ],
      },
      'charts[0]'
    )
    expect(prepared.table).toEqual({
      labels: ['a', 'b'],
      series: [
        { label: 'One', values: ['1', ''] },
        { label: 'Two', values: ['3', '4'] },
      ],
    })
  })
})
