// A slide's layout and its content travel together in the types: a slide or a
// plan that lacks what its layout draws does not compile. The checks here run
// in `tsc --noEmit`, which CI runs over the tests; each @ts-expect-error fails
// the typecheck if the state it marks becomes expressible again.
import { describe, expect, it } from 'vitest'
import type { PptxSlide, PptxTable } from '../pptxInput'
import { type PlannedSlide, isPlanOf } from '../pptxLayout'

const table: PptxTable = { headers: ['a'], rows: [['1']] }
const body = { x: 0, y: 0, w: 1, h: 1 }

describe('slide types', () => {
  it('admit only slides that carry what their layout draws', () => {
    const slides: PptxSlide[] = [
      { layout: 'title-table', where: 'slides[0]', table },
      {
        layout: 'kpis',
        where: 'slides[1]',
        kpis: [{ where: 'k', value: '1' }],
        kpiStyle: 'people',
      },
      { layout: 'cover', where: 'slides[2]', title: 'T' },
      // An image that could not be embedded leaves the slide with its title.
      { layout: 'image', where: 'slides[3]', title: 'T' },
    ]
    // @ts-expect-error a table slide with no table
    const noTable: PptxSlide = { layout: 'title-table', where: 'slides[0]' }
    // @ts-expect-error a bullets slide with a table instead of bullets
    const wrongContent: PptxSlide = { layout: 'title-bullets', where: 'slides[0]', table }
    // @ts-expect-error people cards on a slide that has no cards
    const strayStyle: PptxSlide = { layout: 'title-table', where: 's', table, kpiStyle: 'people' }
    expect([noTable, wrongContent, strayStyle]).toHaveLength(3)
    expect(slides.map(s => s.layout)).toEqual(['title-table', 'kpis', 'cover', 'image'])
  })

  it('admit only plans that carry the part of their slide they draw', () => {
    const spec = { layout: 'title-table' as const, where: 'slides[0]', table }
    const layout = { pages: [], columnWidths: [], fontSize: 12 } as never
    const plan: PlannedSlide = { spec, body, table: { layout, page: 0 } }
    // @ts-expect-error a table plan with no page of the table
    const noPage: PlannedSlide = { spec, body }
    const cover: PlannedSlide = { spec: { layout: 'cover', where: 's', title: 'T' }, body }
    expect(isPlanOf(plan, 'title-table') && plan.table.page).toBe(0)
    expect(isPlanOf(cover, 'cover')).toBe(true)
    expect(isPlanOf(noPage, 'kpis')).toBe(false)
  })
})
