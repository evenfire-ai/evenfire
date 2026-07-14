import { describe, expect, it } from 'vitest'
import { CyclicDependencyError, sort } from './dependencyGraph'

describe('dependencyGraph.sort', () => {
  it('should sort linear chain: C depends on B depends on A (2.7a)', () => {
    const result = sort([
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['B'] },
    ])
    expect(result.indexOf('A')).toBeLessThan(result.indexOf('B'))
    expect(result.indexOf('B')).toBeLessThan(result.indexOf('C'))
  })

  it('should sort diamond: D depends on B and C, both depend on A (2.7b)', () => {
    const result = sort([
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['A'] },
      { id: 'D', dependsOn: ['B', 'C'] },
    ])
    expect(result.indexOf('A')).toBeLessThan(result.indexOf('B'))
    expect(result.indexOf('A')).toBeLessThan(result.indexOf('C'))
    expect(result.indexOf('B')).toBeLessThan(result.indexOf('D'))
    expect(result.indexOf('C')).toBeLessThan(result.indexOf('D'))
  })

  it('should handle no dependencies (parallel) (2.7c)', () => {
    const result = sort([
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: [] },
      { id: 'C', dependsOn: [] },
    ])
    expect(result).toHaveLength(3)
    expect(result).toContain('A')
    expect(result).toContain('B')
    expect(result).toContain('C')
  })

  it('should detect simple cycle: A → B → A (CRITICAL) (2.7d)', () => {
    expect(() =>
      sort([
        { id: 'A', dependsOn: ['B'] },
        { id: 'B', dependsOn: ['A'] },
      ])
    ).toThrow(CyclicDependencyError)
  })

  it('should detect long cycle: A → B → C → A (2.7e)', () => {
    expect(() =>
      sort([
        { id: 'A', dependsOn: ['C'] },
        { id: 'B', dependsOn: ['A'] },
        { id: 'C', dependsOn: ['B'] },
      ])
    ).toThrow(CyclicDependencyError)
  })

  it('should return empty array for empty graph (2.7f)', () => {
    expect(sort([])).toEqual([])
  })

  it('should detect self-reference (2.7g)', () => {
    expect(() => sort([{ id: 'A', dependsOn: ['A'] }])).toThrow(CyclicDependencyError)
  })

  it('should throw for missing dependency node (2.7h)', () => {
    expect(() => sort([{ id: 'A', dependsOn: ['Z'] }])).toThrow('Dependency "Z" not found')
  })

  it('should handle single node with no dependencies', () => {
    expect(sort([{ id: 'A', dependsOn: [] }])).toEqual(['A'])
  })

  it('should handle duplicate dependency references gracefully', () => {
    const result = sort([
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A', 'A'] },
    ])
    expect(result.indexOf('A')).toBeLessThan(result.indexOf('B'))
  })

  it('should handle large graph (50 nodes linear chain)', () => {
    const nodes = Array.from({ length: 50 }, (_, i) => ({
      id: `N${i}`,
      dependsOn: i > 0 ? [`N${i - 1}`] : [],
    }))
    const result = sort(nodes)
    expect(result).toHaveLength(50)
    expect(result[0]).toBe('N0')
    expect(result[49]).toBe('N49')
  })

  it('CyclicDependencyError contains cycle nodes', () => {
    try {
      sort([
        { id: 'X', dependsOn: ['Y'] },
        { id: 'Y', dependsOn: ['X'] },
      ])
    } catch (e) {
      expect(e).toBeInstanceOf(CyclicDependencyError)
      const err = e as CyclicDependencyError
      expect(err.cycle).toContain('X')
      expect(err.cycle).toContain('Y')
    }
  })
})
