import { describe, expect, it } from 'vitest'
import type { BindingDef, WorkloadDef } from '../types'
import { filterByIncludeWhen } from './includeWhenFilter'

function makeWorkload(overrides: Partial<WorkloadDef> & { id: string }): WorkloadDef {
  return {
    type: 'deployment',
    image: 'nginx:1.30.1-alpine',
    ...overrides,
  } as WorkloadDef
}

describe('filterByIncludeWhen', () => {
  it('includes workload when includeWhen resolves to true (boolean)', () => {
    const workloads = [makeWorkload({ id: 'cache', includeWhen: '{{inputs.cacheEnabled}}' })]
    const result = filterByIncludeWhen(workloads, undefined, undefined, {
      cacheEnabled: true,
    })
    expect(result.workloads).toHaveLength(1)
    expect(result.workloads[0].id).toBe('cache')
  })

  it('excludes workload when includeWhen resolves to false (boolean)', () => {
    const workloads = [makeWorkload({ id: 'cache', includeWhen: '{{inputs.cacheEnabled}}' })]
    const result = filterByIncludeWhen(workloads, undefined, undefined, {
      cacheEnabled: false,
    })
    expect(result.workloads).toHaveLength(0)
  })

  it("includes workload when includeWhen resolves to truthy string 'true'", () => {
    const workloads = [makeWorkload({ id: 'cache', includeWhen: '{{inputs.cacheEnabled}}' })]
    const result = filterByIncludeWhen(workloads, undefined, undefined, {
      cacheEnabled: 'true',
    })
    expect(result.workloads).toHaveLength(1)
  })

  it('excludes workload when includeWhen input is undefined (key missing)', () => {
    const workloads = [makeWorkload({ id: 'cache', includeWhen: '{{inputs.cacheEnabled}}' })]
    const result = filterByIncludeWhen(workloads, undefined, undefined, {})
    expect(result.workloads).toHaveLength(0)
  })

  it('excludes workload when includeWhen input is empty string', () => {
    const workloads = [makeWorkload({ id: 'cache', includeWhen: '{{inputs.cacheEnabled}}' })]
    const result = filterByIncludeWhen(workloads, undefined, undefined, {
      cacheEnabled: '',
    })
    expect(result.workloads).toHaveLength(0)
  })

  it('always includes workload without includeWhen', () => {
    const workloads = [
      makeWorkload({ id: 'app' }),
      makeWorkload({ id: 'cache', includeWhen: '{{inputs.cacheEnabled}}' }),
    ]
    const result = filterByIncludeWhen(workloads, undefined, undefined, {
      cacheEnabled: false,
    })
    expect(result.workloads).toHaveLength(1)
    expect(result.workloads[0].id).toBe('app')
  })

  it("drops bindings referencing excluded workload in 'from'", () => {
    const workloads = [
      makeWorkload({ id: 'app' }),
      makeWorkload({ id: 'cache', includeWhen: '{{inputs.cacheEnabled}}' }),
    ]
    const bindings: BindingDef[] = [
      { from: 'cache', to: 'app', port: 6379 },
      { from: 'app', to: 'app', port: 8080 },
    ]
    const result = filterByIncludeWhen(workloads, undefined, bindings, {
      cacheEnabled: false,
    })
    expect(result.bindings).toHaveLength(1)
    expect(result.bindings[0].from).toBe('app')
  })

  it("drops bindings referencing excluded workload in 'to'", () => {
    const workloads = [
      makeWorkload({ id: 'app' }),
      makeWorkload({ id: 'cache', includeWhen: '{{inputs.cacheEnabled}}' }),
    ]
    const bindings: BindingDef[] = [{ from: 'app', to: 'cache', port: 6379 }]
    const result = filterByIncludeWhen(workloads, undefined, bindings, {
      cacheEnabled: false,
    })
    expect(result.bindings).toHaveLength(0)
  })

  it('cleans dependsOn referencing excluded workload', () => {
    const workloads = [
      makeWorkload({ id: 'app', dependsOn: ['cache', 'db'] }),
      makeWorkload({ id: 'db' }),
      makeWorkload({ id: 'cache', includeWhen: '{{inputs.cacheEnabled}}' }),
    ]
    const result = filterByIncludeWhen(workloads, undefined, undefined, {
      cacheEnabled: false,
    })
    expect(result.workloads).toHaveLength(2)
    const app = result.workloads.find(w => w.id === 'app')!
    expect(app.dependsOn).toEqual(['db'])
  })

  it('sets dependsOn to undefined when all deps are excluded', () => {
    const workloads = [
      makeWorkload({ id: 'app', dependsOn: ['cache'] }),
      makeWorkload({ id: 'cache', includeWhen: '{{inputs.cacheEnabled}}' }),
    ]
    const result = filterByIncludeWhen(workloads, undefined, undefined, {
      cacheEnabled: false,
    })
    const app = result.workloads.find(w => w.id === 'app')!
    expect(app.dependsOn).toBeUndefined()
  })

  it('passes resources through unchanged', () => {
    const resources = [{ id: 'data-pvc', type: 'pvc' as const, size: '10Gi' }]
    const result = filterByIncludeWhen([], resources, undefined, {})
    expect(result.resources).toEqual(resources)
  })

  it('returns empty arrays for undefined resources and bindings', () => {
    const result = filterByIncludeWhen([], undefined, undefined, {})
    expect(result.resources).toEqual([])
    expect(result.bindings).toEqual([])
  })

  it('handles includeWhen with whitespace in template', () => {
    const workloads = [makeWorkload({ id: 'cache', includeWhen: '{{ inputs.cacheEnabled }}' })]
    const result = filterByIncludeWhen(workloads, undefined, undefined, {
      cacheEnabled: true,
    })
    expect(result.workloads).toHaveLength(1)
  })

  it("excludes workload when includeWhen is string 'false'", () => {
    const workloads = [makeWorkload({ id: 'cache', includeWhen: '{{inputs.flag}}' })]
    const result = filterByIncludeWhen(workloads, undefined, undefined, {
      flag: 'false',
    })
    expect(result.workloads).toHaveLength(0)
  })

  it('includes workload when includeWhen resolves to non-zero number', () => {
    const workloads = [makeWorkload({ id: 'cache', includeWhen: '{{inputs.count}}' })]
    const result = filterByIncludeWhen(workloads, undefined, undefined, {
      count: 3,
    })
    expect(result.workloads).toHaveLength(1)
  })

  it('excludes workload when includeWhen resolves to zero', () => {
    const workloads = [makeWorkload({ id: 'cache', includeWhen: '{{inputs.count}}' })]
    const result = filterByIncludeWhen(workloads, undefined, undefined, {
      count: 0,
    })
    expect(result.workloads).toHaveLength(0)
  })
})
