import { describe, expect, it } from 'vitest'
import {
  CyclicDependencyError,
  type StepNode,
  UnknownDependencyError,
  buildExecutionGroups,
  getDependents,
} from '../../../src/workflow/stepDependencyGraph'

describe('buildExecutionGroups', () => {
  it('returns single group for independent steps', () => {
    const steps: StepNode[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: [] },
      { id: 'c', dependsOn: [] },
    ]
    const groups = buildExecutionGroups(steps)
    expect(groups).toHaveLength(1)
    expect(groups[0].steps).toEqual(['a', 'b', 'c'])
  })

  it('returns ordered groups for linear chain A→B→C', () => {
    const steps: StepNode[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
    ]
    const groups = buildExecutionGroups(steps)
    expect(groups).toHaveLength(3)
    expect(groups[0].steps).toEqual(['a'])
    expect(groups[1].steps).toEqual(['b'])
    expect(groups[2].steps).toEqual(['c'])
  })

  it('returns correct groups for diamond DAG A→B, A→C, B→D, C→D', () => {
    const steps: StepNode[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b', 'c'] },
    ]
    const groups = buildExecutionGroups(steps)
    expect(groups).toHaveLength(3)
    expect(groups[0].steps).toEqual(['a'])
    expect(groups[1].steps).toEqual(['b', 'c'])
    expect(groups[2].steps).toEqual(['d'])
  })

  it('returns fan-out: A→B, A→C, A→D as one group after A', () => {
    const steps: StepNode[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['a'] },
    ]
    const groups = buildExecutionGroups(steps)
    expect(groups).toHaveLength(2)
    expect(groups[0].steps).toEqual(['a'])
    expect(groups[1].steps).toEqual(['b', 'c', 'd'])
  })

  it('returns fan-in: A, B, C → D as D in final group', () => {
    const steps: StepNode[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: [] },
      { id: 'c', dependsOn: [] },
      { id: 'd', dependsOn: ['a', 'b', 'c'] },
    ]
    const groups = buildExecutionGroups(steps)
    expect(groups).toHaveLength(2)
    expect(groups[0].steps).toEqual(['a', 'b', 'c'])
    expect(groups[1].steps).toEqual(['d'])
  })

  it('throws CyclicDependencyError for A→B→A', () => {
    const steps: StepNode[] = [
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
    ]
    expect(() => buildExecutionGroups(steps)).toThrow(CyclicDependencyError)
  })

  it('throws CyclicDependencyError and includes cycle in error.cycle', () => {
    const steps: StepNode[] = [
      { id: 'a', dependsOn: ['c'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
    ]
    try {
      buildExecutionGroups(steps)
      expect.fail('Should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CyclicDependencyError)
      expect((err as CyclicDependencyError).cycle.length).toBeGreaterThanOrEqual(2)
    }
  })

  it('throws CyclicDependencyError for self-referencing step A→A', () => {
    const steps: StepNode[] = [{ id: 'a', dependsOn: ['a'] }]
    expect(() => buildExecutionGroups(steps)).toThrow(CyclicDependencyError)
  })

  it('throws UnknownDependencyError when dependsOn references non-existent step', () => {
    const steps: StepNode[] = [{ id: 'a', dependsOn: ['z'] }]
    expect(() => buildExecutionGroups(steps)).toThrow(UnknownDependencyError)
    try {
      buildExecutionGroups(steps)
    } catch (err) {
      expect((err as UnknownDependencyError).stepId).toBe('a')
      expect((err as UnknownDependencyError).unknownDependency).toBe('z')
    }
  })

  it('handles empty steps array — returns empty groups', () => {
    expect(buildExecutionGroups([])).toEqual([])
  })

  it('handles single step with no dependencies — returns one group', () => {
    const steps: StepNode[] = [{ id: 'solo', dependsOn: [] }]
    const groups = buildExecutionGroups(steps)
    expect(groups).toHaveLength(1)
    expect(groups[0].steps).toEqual(['solo'])
  })

  it('handles disconnected graph (two independent chains)', () => {
    const steps: StepNode[] = [
      { id: 'a1', dependsOn: [] },
      { id: 'a2', dependsOn: ['a1'] },
      { id: 'b1', dependsOn: [] },
      { id: 'b2', dependsOn: ['b1'] },
    ]
    const groups = buildExecutionGroups(steps)
    expect(groups).toHaveLength(2)
    expect(groups[0].steps).toEqual(['a1', 'b1'])
    expect(groups[1].steps).toEqual(['a2', 'b2'])
  })

  it('preserves stable order within a group (alphabetical by step id)', () => {
    const steps: StepNode[] = [
      { id: 'z', dependsOn: [] },
      { id: 'a', dependsOn: [] },
      { id: 'm', dependsOn: [] },
    ]
    const groups = buildExecutionGroups(steps)
    expect(groups[0].steps).toEqual(['a', 'm', 'z'])
  })
})

describe('getDependents', () => {
  it('returns direct dependents of a step', () => {
    const steps: StepNode[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
    ]
    expect(getDependents('a', steps)).toEqual(['b', 'c'])
  })

  it('returns transitive dependents', () => {
    const steps: StepNode[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['b'] },
    ]
    expect(getDependents('a', steps)).toEqual(['b', 'c'])
  })

  it('returns empty array when no step depends on given id', () => {
    const steps: StepNode[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: [] },
    ]
    expect(getDependents('a', steps)).toEqual([])
  })

  it('handles diamond: returns all three dependent steps', () => {
    const steps: StepNode[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
      { id: 'd', dependsOn: ['b', 'c'] },
    ]
    expect(getDependents('a', steps)).toEqual(['b', 'c', 'd'])
  })

  it('does not include the step itself', () => {
    const steps: StepNode[] = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
    ]
    expect(getDependents('a', steps)).not.toContain('a')
  })

  it('returns empty array for unknown stepId', () => {
    const steps: StepNode[] = [{ id: 'a', dependsOn: [] }]
    expect(getDependents('unknown', steps)).toEqual([])
  })

  it('handles deep chain of 10 steps correctly', () => {
    const steps: StepNode[] = []
    for (let i = 0; i < 10; i++) {
      steps.push({ id: `s${i}`, dependsOn: i > 0 ? [`s${i - 1}`] : [] })
    }
    const deps = getDependents('s0', steps)
    expect(deps).toHaveLength(9)
    expect(deps).toContain('s9')
  })
})
