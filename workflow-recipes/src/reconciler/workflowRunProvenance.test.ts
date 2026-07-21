import { describe, expect, it } from 'vitest'
import { buildDbRunChildName } from '../workflow/childRecipeFactory'
import {
  type WorkflowRunProvenanceRow,
  classifyWorkflowRunProvenance,
} from './workflowRecipeReconciler'

const expected = {
  runId: '00000000-0000-4000-8000-000000000123',
  parentNamespace: 'sandbox-recipes',
  parentName: 'research-summary',
  childNamespace: 'sandbox-recipes',
  childName: 'research-summary-child',
}

function row(overrides: Partial<WorkflowRunProvenanceRow> = {}): WorkflowRunProvenanceRow {
  return {
    phase: 'Running',
    recipe_namespace: expected.parentNamespace,
    recipe_name: expected.parentName,
    child_recipe_namespace: expected.childNamespace,
    child_recipe_name: expected.childName,
    ...overrides,
  }
}

describe('classifyWorkflowRunProvenance', () => {
  it('verifies only the exact durable parent and child binding', () => {
    expect(classifyWorkflowRunProvenance(row(), expected)).toBe('verified')
    expect(
      classifyWorkflowRunProvenance(row({ child_recipe_name: 'different-child' }), expected)
    ).toBe('invalid')
    expect(classifyWorkflowRunProvenance(row({ recipe_name: 'different-parent' }), expected)).toBe(
      'invalid'
    )
  })

  it('classifies an exact deterministic child with an unbound Pending row as pending', () => {
    const pendingExpected = {
      ...expected,
      childName: buildDbRunChildName(expected.parentName, expected.runId),
    }
    expect(
      classifyWorkflowRunProvenance(
        row({
          phase: 'Pending',
          child_recipe_namespace: null,
          child_recipe_name: null,
        }),
        pendingExpected
      )
    ).toBe('pending')
  })

  it('rejects a non-deterministic observed child even while the row is Pending', () => {
    expect(
      classifyWorkflowRunProvenance(
        row({
          phase: 'Pending',
          child_recipe_namespace: null,
          child_recipe_name: null,
        }),
        expected
      )
    ).toBe('invalid')
  })

  it('rejects missing rows and partially attached child bindings', () => {
    expect(classifyWorkflowRunProvenance(undefined, expected)).toBe('invalid')
    expect(
      classifyWorkflowRunProvenance(
        row({ phase: 'Pending', child_recipe_namespace: null }),
        expected
      )
    ).toBe('invalid')
  })
})
