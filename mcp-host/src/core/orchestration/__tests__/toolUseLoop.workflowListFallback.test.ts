import { describe, expect, it } from 'vitest'
import type { ToolResult } from '../../types'
import { buildWorkflowListFallbackWhenResponseOmitsNames } from '../toolUseLoopWorkflowFallbacks'

function workflowListResult(content: unknown): ToolResult {
  return {
    tool_call_id: 'workflow-list-1',
    name: 'workflow_list',
    content: JSON.stringify(content),
    is_error: false,
  }
}

describe('workflow_list deterministic fallback', () => {
  it('falls back when model output names the workflow but omits returned input fields', () => {
    const fallback = buildWorkflowListFallbackWhenResponseOmitsNames(
      [
        'You can run this workflow recipe:',
        'e2e-agent-due-diligence-123',
        'Required information before running: None',
      ].join('\n'),
      [
        workflowListResult({
          items: [
            {
              name: 'e2e-agent-due-diligence-123',
              targets: [{ kind: 'user', label: 'Personal' }],
              requiresInput: true,
              inputs: [
                { name: 'company', required: true, description: 'Target company.' },
                { name: 'depth', required: false, default: 'full' },
              ],
            },
          ],
          count: 1,
        }),
      ]
    )

    expect(fallback).toContain('e2e-agent-due-diligence-123')
    expect(fallback).toContain('Required business inputs: company')
    expect(fallback).toContain('company')
    expect(fallback).toContain('depth')
  })

  it('accepts model output that includes workflow names and input fields', () => {
    const fallback = buildWorkflowListFallbackWhenResponseOmitsNames(
      'e2e-agent-due-diligence-123 requires company and optional depth.',
      [
        workflowListResult({
          items: [
            {
              name: 'e2e-agent-due-diligence-123',
              requiresInput: true,
              inputs: [
                { name: 'company', required: true },
                { name: 'depth', required: false },
              ],
            },
          ],
          count: 1,
        }),
      ]
    )

    expect(fallback).toBeNull()
  })
})
