/**
 * Every tool schema is sent with every model request, so its size is paid on
 * each call and taken from small context windows. These ceilings keep the
 * schemas from growing unnoticed; raise one only for information a model needs.
 */
import { describe, expect, it } from 'vitest'
import { INTERNAL_TOOLS } from '../internalTools'

const BUDGET: Record<string, number> = {
  clerum__generate_markdown: 700,
  clerum__generate_pdf: 3800,
  clerum__generate_docx: 3200,
  clerum__generate_xlsx: 5400,
  clerum__generate_pptx: 16600,
  clerum__generate_chart: 4300,
  clerum__generate_dashboard: 14100,
  clerum__list_workflows: 500,
  clerum__read_workflow: 650,
  clerum__trigger_workflow: 1000,
  clerum__context_files_list: 650,
  clerum__context_files_read: 550,
}

const TOTAL_BUDGET = 51000

function size(tool: (typeof INTERNAL_TOOLS)[number]): number {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }).length
}

describe('internal tool schema size', () => {
  it.each(INTERNAL_TOOLS.map(t => [t.name, t] as const))(
    '%s stays within its budget',
    (name, tool) => {
      expect(BUDGET[name], `no budget set for ${name}`).toBeDefined()
      expect(size(tool)).toBeLessThanOrEqual(BUDGET[name])
    }
  )

  it('keeps all of them together within the total budget', () => {
    expect(INTERNAL_TOOLS.reduce((sum, tool) => sum + size(tool), 0)).toBeLessThanOrEqual(
      TOTAL_BUDGET
    )
  })
})
