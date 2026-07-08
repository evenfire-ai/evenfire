/**
 * Step Dependency Graph — topological sort with Kahn's algorithm.
 *
 * Builds execution groups from step dependencies. Steps within a group
 * are independent and can execute in parallel; callers decide whether to
 * process each group sequentially or concurrently.
 * */

// ─── Types ──────────────────────────────────────────────────────────────

export interface StepNode {
  id: string
  dependsOn: string[]
}

export interface ExecutionGroup {
  groupIndex: number
  steps: string[]
}

export class CyclicDependencyError extends Error {
  cycle: string[]
  constructor(cycle: string[]) {
    super(`Cyclic dependency detected: ${cycle.join(' → ')}`)
    this.name = 'CyclicDependencyError'
    this.cycle = cycle
  }
}

export class UnknownDependencyError extends Error {
  stepId: string
  unknownDependency: string
  constructor(stepId: string, unknownDependency: string) {
    super(`Step '${stepId}' depends on unknown step '${unknownDependency}'`)
    this.name = 'UnknownDependencyError'
    this.stepId = stepId
    this.unknownDependency = unknownDependency
  }
}

// ─── Exported Functions ─────────────────────────────────────────────────

/**
 * Build execution groups via Kahn's algorithm (topological sort).
 * Steps within a group are independent of each other.
 * Throws CyclicDependencyError if any cycle exists.
 * Throws UnknownDependencyError if dependsOn references non-existent step.
 */
export function buildExecutionGroups(steps: StepNode[]): ExecutionGroup[] {
  if (steps.length === 0) return []

  const ids = new Set(steps.map(s => s.id))

  // Validate all dependencies reference existing steps
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) {
        throw new UnknownDependencyError(step.id, dep)
      }
    }
  }

  // Build adjacency and in-degree maps
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>() // dep → [steps that depend on dep]

  for (const step of steps) {
    inDegree.set(step.id, step.dependsOn.length)
    if (!dependents.has(step.id)) dependents.set(step.id, [])
    for (const dep of step.dependsOn) {
      if (!dependents.has(dep)) dependents.set(dep, [])
      dependents.get(dep)!.push(step.id)
    }
  }

  // Kahn's algorithm with level grouping
  const groups: ExecutionGroup[] = []
  let queue = [...ids].filter(id => inDegree.get(id) === 0).sort()
  let processed = 0

  while (queue.length > 0) {
    groups.push({
      groupIndex: groups.length,
      steps: [...queue], // already sorted
    })
    processed += queue.length

    const nextQueue: string[] = []
    for (const id of queue) {
      for (const dependent of dependents.get(id) ?? []) {
        const newDegree = inDegree.get(dependent)! - 1
        inDegree.set(dependent, newDegree)
        if (newDegree === 0) nextQueue.push(dependent)
      }
    }
    queue = nextQueue.sort() // stable alphabetical order within group
  }

  if (processed < steps.length) {
    // Remaining steps form a cycle — find it for the error message
    const remaining = steps.filter(s => !groups.some(g => g.steps.includes(s.id)))
    const cycle = findCycle(remaining)
    throw new CyclicDependencyError(cycle)
  }

  return groups
}

/**
 * Returns all step IDs that transitively depend on stepId.
 * Used by crash-resume to determine which steps would need re-execution.
 */
export function getDependents(stepId: string, steps: StepNode[]): string[] {
  const ids = new Set(steps.map(s => s.id))
  if (!ids.has(stepId)) return []

  const dependentsMap = new Map<string, string[]>()
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!dependentsMap.has(dep)) dependentsMap.set(dep, [])
      dependentsMap.get(dep)!.push(step.id)
    }
  }

  const visited = new Set<string>()
  const queue = [stepId]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const dep of dependentsMap.get(current) ?? []) {
      if (!visited.has(dep)) {
        visited.add(dep)
        queue.push(dep)
      }
    }
  }

  return [...visited].sort()
}

// ─── Internal ───────────────────────────────────────────────────────────

function findCycle(steps: StepNode[]): string[] {
  const visited = new Set<string>()
  const inStack = new Set<string>()
  const stepMap = new Map(steps.map(s => [s.id, s]))

  for (const step of steps) {
    const cycle = dfs(step.id, stepMap, visited, inStack, [])
    if (cycle) return cycle
  }

  // Fallback: return all remaining IDs
  return steps.map(s => s.id)
}

function dfs(
  id: string,
  stepMap: Map<string, StepNode>,
  visited: Set<string>,
  inStack: Set<string>,
  path: string[]
): string[] | null {
  if (inStack.has(id)) {
    const cycleStart = path.indexOf(id)
    return [...path.slice(cycleStart), id]
  }
  if (visited.has(id)) return null

  visited.add(id)
  inStack.add(id)
  path.push(id)

  const step = stepMap.get(id)
  if (step) {
    for (const dep of step.dependsOn) {
      const cycle = dfs(dep, stepMap, visited, inStack, path)
      if (cycle) return cycle
    }
  }

  inStack.delete(id)
  path.pop()
  return null
}
