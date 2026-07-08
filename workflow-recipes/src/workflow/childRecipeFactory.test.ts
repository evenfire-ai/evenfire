import { describe, expect, it } from 'vitest'
import { type ParentRecipe, buildChildRecipe } from './childRecipeFactory.js'

function makeParent(overrides: Partial<ParentRecipe['spec']> = {}): ParentRecipe {
  return {
    metadata: {
      name: 'agentic-workload-template-resolution',
      namespace: 'sandbox-recipes',
      uid: 'parent-uid-1',
    },
    spec: {
      inputContract: {
        properties: {
          db_name: { type: 'string', default: 'clerum' },
        },
      },
      computed: [{ name: 'db_mode', expression: "'readonly'" }],
      workloads: [
        {
          id: 'qa-api',
          env: [{ name: 'DB_MODE', value: '{{computed.db_mode}}' }],
        },
      ],
      steps: [{ id: 'verify-template-resolution' }],
      ...overrides,
    },
  }
}

describe('buildChildRecipe', () => {
  it('copies computed values into child WorkflowRecipes', () => {
    const child = buildChildRecipe(makeParent(), 0, new Date('2026-05-16T00:00:00Z'))

    expect((child.spec as Record<string, unknown>).computed).toEqual([
      { name: 'db_mode', expression: "'readonly'" },
    ])
  })

  it('deep-copies computed values inherited from the parent recipe', () => {
    const computed = [{ name: 'db_mode', expression: "'readonly'" }]
    const parent = makeParent({ computed })

    const child = buildChildRecipe(parent, 0, new Date('2026-05-16T00:00:00Z'))
    computed[0].expression = "'readwrite'"

    expect((child.spec as Record<string, unknown>).computed).toEqual([
      { name: 'db_mode', expression: "'readonly'" },
    ])
  })

  it('keeps computed inheritance separate from per-run input overrides', () => {
    const child = buildChildRecipe(
      makeParent({ inputs: { db_name: 'parent-db' } }),
      0,
      new Date(),
      {
        triggerKind: 'onDemand',
        inputs: { db_name: 'run-db' },
      }
    )
    const spec = child.spec as Record<string, unknown>

    expect(spec.inputs).toEqual({ db_name: 'run-db' })
    expect(spec.computed).toEqual([{ name: 'db_mode', expression: "'readonly'" }])
  })
})
