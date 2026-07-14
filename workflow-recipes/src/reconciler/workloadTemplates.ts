import type { ResourceDef, WorkflowRecipeCRD, WorkloadDef } from '../types'
import { resolveWorkloadRuntimeResourceName } from './resourceBuilder'
import {
  type TemplateContext,
  TemplateInjectionError,
  UnresolvedTemplateError,
  resolve as resolveTemplate,
} from './templateEngine'

type EnvLike = { name: string; value?: string; valueFrom?: unknown }

export interface ResolveWorkloadTemplatesOptions {
  recipe: WorkflowRecipeCRD
  workloads: WorkloadDef[]
  inputs: Record<string, unknown>
  computed?: Record<string, unknown>
  resolveNamespace: (workload: WorkloadDef) => string
}

export class WorkloadTemplateResolutionError extends Error {
  constructor(
    public readonly field: string,
    public readonly ref: string,
    cause: Error
  ) {
    super(`${field}: ${cause.message}`, { cause })
    this.name = 'WorkloadTemplateResolutionError'
  }
}

function buildResourceTemplateContext(
  resources?: ResourceDef[]
): Map<string, Record<string, string>> {
  const context = new Map<string, Record<string, string>>()
  for (const resource of resources ?? []) {
    if (resource.type === 'secret' || resource.type === 'configmap') {
      context.set(resource.id, resource.data ?? {})
    }
  }
  return context
}

function buildTemplateContext({
  recipe,
  workloads,
  inputs,
  computed,
  resolveNamespace,
}: ResolveWorkloadTemplatesOptions): TemplateContext {
  const workloadContext = new Map<string, { host: string; port: string }>()
  for (const workload of workloads) {
    if (!workload.port) continue
    const resourceName = resolveWorkloadRuntimeResourceName(recipe, workload)
    const namespace = resolveNamespace(workload)
    workloadContext.set(workload.id, {
      host: `${resourceName}.${namespace}.svc.cluster.local`,
      port: String(workload.port),
    })
  }
  return {
    inputs,
    computed,
    workloads: workloadContext,
    resources: buildResourceTemplateContext(recipe.spec.resources),
  }
}

function resolveField(value: string, field: string, context: TemplateContext): string {
  try {
    return resolveTemplate(value, context)
  } catch (error) {
    if (error instanceof UnresolvedTemplateError || error instanceof TemplateInjectionError) {
      throw new WorkloadTemplateResolutionError(field, error.ref, error)
    }
    throw error
  }
}

/**
 * Resolves workload env.value, command, and args templates in-place.
 */
export function resolveWorkloadTemplates(options: ResolveWorkloadTemplatesOptions): void {
  const context = buildTemplateContext(options)

  options.workloads.forEach((workload, workloadIndex) => {
    const prefix = `spec.workloads[${workloadIndex}]`

    if (workload.env) {
      ;(workload.env as EnvLike[]).forEach((envVar, envIndex) => {
        if (typeof envVar.value !== 'string') return
        const envPath = envVar.name
          ? `${prefix}.env[${envVar.name}].value`
          : `${prefix}.env[${envIndex}].value`
        envVar.value = resolveField(envVar.value, envPath, context)
      })
    }

    if (workload.command) {
      workload.command = workload.command.map((command, commandIndex) =>
        resolveField(command, `${prefix}.command[${commandIndex}]`, context)
      )
    }

    if (workload.args) {
      workload.args = workload.args.map((arg, argIndex) =>
        resolveField(arg, `${prefix}.args[${argIndex}]`, context)
      )
    }
  })
}
