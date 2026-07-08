/**
 * Custom error for cyclic dependencies.
 */
export class CyclicDependencyError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Cyclic dependency detected: ${cycle.join(' → ')}`)
    this.name = 'CyclicDependencyError'
  }
}

export interface DependencyNode {
  id: string
  dependsOn: string[]
}

/**
 * Topological sort using Kahn's algorithm.
 *
 * Intent decomposition note: The dependency graph determines the materialization
 * order of intents. MCP Intent workloads that other Sandbox Intent workloads
 * depend on must be created first, so the HCC can sanitize and approve them
 * before dependent sandbox workloads start.
 *
 * @returns Sorted array (dependencies first, dependents last)
 * @throws CyclicDependencyError if a cycle exists
 * @throws Error if a dependency references a non-existent node
 */
export function sort(nodes: DependencyNode[]): string[] {
  if (nodes.length === 0) return []

  const graph = new Map<string, Set<string>>()
  const inDegree = new Map<string, number>()

  // Initialize all nodes
  for (const node of nodes) {
    graph.set(node.id, new Set())
    inDegree.set(node.id, 0)
  }

  // Build edges: dep → node (dep must come before node)
  for (const node of nodes) {
    const uniqueDeps = new Set(node.dependsOn)
    for (const dep of uniqueDeps) {
      if (!graph.has(dep)) {
        throw new Error(`Dependency "${dep}" not found in graph (referenced by "${node.id}")`)
      }
      graph.get(dep)!.add(node.id)
      inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1)
    }
  }

  // Kahn's algorithm: start with nodes that have no dependencies
  const queue: string[] = []
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id)
  }

  const sorted: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    sorted.push(current)

    for (const neighbor of graph.get(current) || []) {
      const newDegree = (inDegree.get(neighbor) || 0) - 1
      inDegree.set(neighbor, newDegree)
      if (newDegree === 0) queue.push(neighbor)
    }
  }

  // If not all nodes were sorted, a cycle exists
  if (sorted.length !== nodes.length) {
    const remaining = nodes.filter(n => !sorted.includes(n.id)).map(n => n.id)
    throw new CyclicDependencyError(remaining)
  }

  return sorted
}
