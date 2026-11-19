import { describe, expect, it } from 'vitest'
import { canonicalWorkflowRunId } from '../src/services/access/workflowRunId.js'

const RUN_ID = '22222222-2222-4222-8222-22222222abcd'

describe('canonicalWorkflowRunId', () => {
  it('accepts the form run_id::text renders', () => {
    expect(canonicalWorkflowRunId(RUN_ID)).toBe(RUN_ID)
    expect(canonicalWorkflowRunId('00000000-0000-0000-0000-000000000000')).toBe(
      '00000000-0000-0000-0000-000000000000'
    )
  })

  it.each([
    ['uppercase', RUN_ID.toUpperCase()],
    ['braces', `{${RUN_ID}}`],
    ['no hyphens', RUN_ID.replaceAll('-', '')],
    ['a leading space', ` ${RUN_ID}`],
    ['a trailing space', `${RUN_ID} `],
    ['the empty string', ''],
    ['an artifact id', `${RUN_ID}/report.json`],
    ['a non-hex character', '22222222-2222-4222-8222-22222222abcg'],
    ['a short last group', '22222222-2222-4222-8222-22222222abc'],
    ['not a uuid', 'not-a-uuid'],
  ])('rejects %s', (_name, value) => {
    expect(canonicalWorkflowRunId(value)).toBeNull()
  })
})
