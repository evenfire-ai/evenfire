import type { Signal, StepSpec, WorkflowRecipeSpec } from '../config-loader/types'
import { CycleDetectedError } from '../errors'

export interface StepContext {
  workflowName: string
  previousOutputs: Record<string, unknown>
  signals: Signal[]
}

export type StepExecutor = (step: StepSpec, context: StepContext) => Promise<unknown>

export interface RunWorkflowOptions {
  initialOutputs?: Record<string, unknown>
  completedStepIds?: Iterable<string>
}

export class StepCoordinator {
  private signals: Signal[] = []

  resolveOrder(steps: StepSpec[]): StepSpec[] {
    const stepMap = new Map<string, StepSpec>()
    const inDegree = new Map<string, number>()
    const adjacency = new Map<string, string[]>()

    for (const step of steps) {
      stepMap.set(step.id, step)
      inDegree.set(step.id, 0)
      adjacency.set(step.id, [])
    }

    for (const step of steps) {
      for (const dep of step.dependsOn ?? []) {
        if (!stepMap.has(dep)) {
          throw new Error(`Step "${step.id}" depends on unknown step "${dep}"`)
        }
        if (dep === step.id) {
          throw new CycleDetectedError([step.id, step.id])
        }
        adjacency.get(dep)!.push(step.id)
        inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1)
      }
    }

    // Kahn's algorithm
    const queue: string[] = []
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id)
    }

    const sorted: StepSpec[] = []
    while (queue.length > 0) {
      const current = queue.shift()!
      sorted.push(stepMap.get(current)!)
      for (const neighbor of adjacency.get(current) ?? []) {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1
        inDegree.set(neighbor, newDegree)
        if (newDegree === 0) queue.push(neighbor)
      }
    }

    if (sorted.length !== steps.length) {
      // Find cycle for error message
      const sortedIds = new Set(sorted.map(s => s.id))
      const remaining = steps.filter(s => !sortedIds.has(s.id)).map(s => s.id)
      throw new CycleDetectedError(remaining)
    }

    return sorted
  }

  private static readonly MAX_SIGNALS = 100

  injectSignal(signal: Signal): void {
    // Bound retained signals to avoid unbounded coordinator memory growth.
    if (this.signals.length >= StepCoordinator.MAX_SIGNALS) {
      this.signals.shift()
    }
    this.signals.push(signal)
  }

  async runWorkflow(
    spec: WorkflowRecipeSpec,
    executor: StepExecutor,
    options: RunWorkflowOptions = {}
  ): Promise<Record<string, unknown>> {
    const ordered = this.resolveOrder(spec.steps)
    const previousOutputs: Record<string, unknown> = { ...(options.initialOutputs ?? {}) }
    const completedStepIds = new Set(options.completedStepIds ?? [])

    for (const step of ordered) {
      if (completedStepIds.has(step.id)) continue

      // Check signals at step boundary
      if (this.signals.some(s => s.type === 'cancel')) {
        return previousOutputs
      }

      const context: StepContext = {
        workflowName: spec.name,
        previousOutputs: { ...previousOutputs },
        signals: [...this.signals],
      }

      const output = await executor(step, context)
      previousOutputs[step.id] = output
    }

    return previousOutputs
  }
}
