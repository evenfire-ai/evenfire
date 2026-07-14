import type { EgressBindingDef, WorkflowRecipeCRD, WorkloadDef } from '../types'
import { parseClusterLocalFqdn, resolveWorkloadRuntimeResourceName } from './resourceBuilder'

export type InternalDependencyIssueReason = 'InvalidInternalDependency' | 'OwnershipConflict'

export interface InternalDependencyIssue {
  reason: InternalDependencyIssueReason
  message: string
  sourceWorkloadId?: string
  targetWorkloadId?: string
}

export interface InternalDependency {
  sourceWorkloadId: string
  sourceNamespace: string
  targetWorkloadId: string
  targetNamespace: string
  targetServiceName: string
  port: number
  protocol: 'TCP' | 'UDP'
  fields: string[]
}

export interface InternalDependencyEvaluation {
  dependencies: InternalDependency[]
  issues: InternalDependencyIssue[]
}

export interface EvaluateInternalDependenciesInput {
  recipe: WorkflowRecipeCRD
  workloads: WorkloadDef[]
  uiWorkloadId?: string
  strictUnknownTargetNamespaces: string[]
  resolveNamespace: (workload: WorkloadDef) => string
}

interface TargetCandidate {
  workload: WorkloadDef
  namespace: string
  serviceName: string
  fqdn: string
}

interface ClusterLocalHostReference {
  fqdn: string
  port?: number
}

const CLUSTER_LOCAL_HOST_REFERENCE_RE =
  /([a-z0-9](?:[-a-z0-9]*[a-z0-9])?\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?\.svc\.cluster\.local\.?)(?::([0-9]{1,5}))?/gi
const UNRESOLVED_WORKLOAD_TEMPLATE_RE = /\{\{\s*([^}:]+)\s*:\s*(host|port)\s*\}\}/g

function isStdioTransport(workload: WorkloadDef): boolean {
  return workload.transport?.type === 'stdio'
}

function isUiWorkload(workload: WorkloadDef, uiWorkloadId: string | undefined): boolean {
  return Boolean(uiWorkloadId && workload.id === uiWorkloadId)
}

function collectResolvedHostReferences(
  workload: WorkloadDef
): Array<{ value: string; field: string }> {
  const refs: Array<{ value: string; field: string }> = []
  for (const env of workload.env ?? []) {
    if (typeof env.value === 'string') refs.push({ value: env.value, field: `env.${env.name}` })
  }
  for (const [index, value] of (workload.command ?? []).entries()) {
    refs.push({ value, field: `command[${index}]` })
  }
  for (const [index, value] of (workload.args ?? []).entries()) {
    refs.push({ value, field: `args[${index}]` })
  }
  return refs
}

function extractClusterLocalHostReferences(value: string): ClusterLocalHostReference[] {
  return [...value.matchAll(CLUSTER_LOCAL_HOST_REFERENCE_RE)].map(match => ({
    fqdn: match[1].replace(/\.$/, '').toLowerCase(),
    port: match[2] ? Number(match[2]) : undefined,
  }))
}

function extractUnresolvedWorkloadTemplateReferences(
  value: string
): Array<{ workloadId: string; field: string }> {
  return [...value.matchAll(UNRESOLVED_WORKLOAD_TEMPLATE_RE)]
    .map(match => ({ workloadId: match[1].trim(), field: match[2] }))
    .filter(ref => Boolean(ref.workloadId))
}

function dependencyKey(dep: Omit<InternalDependency, 'fields'>): string {
  return [
    dep.sourceWorkloadId,
    dep.sourceNamespace,
    dep.targetWorkloadId,
    dep.targetNamespace,
    dep.port,
    dep.protocol,
  ].join('\0')
}

function addDependency(
  out: Map<string, InternalDependency>,
  dep: Omit<InternalDependency, 'fields'>,
  field: string
): void {
  const key = dependencyKey(dep)
  const existing = out.get(key)
  if (existing) {
    if (!existing.fields.includes(field)) existing.fields.push(field)
    return
  }
  out.set(key, { ...dep, fields: [field] })
}

function bindingField(binding: EgressBindingDef, index: number): string {
  const dns = binding.dns ? `:${binding.dns}` : ''
  return `egressBindings[${index}]${dns}`
}

export function evaluateInternalDependencies({
  recipe,
  workloads,
  uiWorkloadId,
  strictUnknownTargetNamespaces,
  resolveNamespace,
}: EvaluateInternalDependenciesInput): InternalDependencyEvaluation {
  const issues: InternalDependencyIssue[] = []
  const deps = new Map<string, InternalDependency>()
  const candidates = new Map<string, TargetCandidate>()
  const candidatesByWorkloadId = new Map<string, TargetCandidate>()
  const strictUnknownTargetNamespaceSet = new Set(strictUnknownTargetNamespaces)

  for (const workload of workloads) {
    const namespace = resolveNamespace(workload)
    const serviceName = resolveWorkloadRuntimeResourceName(recipe, workload)
    const fqdn = `${serviceName}.${namespace}.svc.cluster.local`.toLowerCase()
    const candidate = { workload, namespace, serviceName, fqdn }
    candidates.set(fqdn, candidate)
    candidatesByWorkloadId.set(workload.id, candidate)
  }

  function resolveTarget(
    fqdn: string,
    source: WorkloadDef,
    field: string,
    failOnInvalid: boolean
  ): TargetCandidate | null {
    const parsed = parseClusterLocalFqdn(fqdn)
    if (!parsed) return null
    const normalized = `${parsed.service}.${parsed.namespace}.svc.cluster.local`
    const target = candidates.get(normalized)
    if (!target) {
      // WRC owns unresolved/unknown references in the recipe runtime namespace.
      // Shared MCP services in mcp-server may be HCC/control-api-owned and are
      // intentionally outside this inferred internal-dependency lane.
      if (failOnInvalid && strictUnknownTargetNamespaceSet.has(parsed.namespace)) {
        issues.push({
          reason: 'InvalidInternalDependency',
          sourceWorkloadId: source.id,
          message: `Workload "${source.id}" ${field} references cluster-local host "${fqdn}", but it is not an eligible runtime Service in WorkflowRecipe "${recipe.metadata.name}"`,
        })
      }
      return null
    }
    return target
  }

  function addResolvedDependency(
    source: WorkloadDef,
    target: TargetCandidate,
    field: string,
    port: number | undefined,
    protocol: 'TCP' | 'UDP',
    failOnInvalid: boolean
  ): void {
    if (isStdioTransport(source)) {
      issues.push({
        reason: 'OwnershipConflict',
        sourceWorkloadId: source.id,
        targetWorkloadId: target.workload.id,
        message: `Workload "${source.id}" is a stdio transport workload; HCC owns that selector family, so WRC will not create internal-dependency policies for ${field}`,
      })
      return
    }
    if (isUiWorkload(target.workload, uiWorkloadId)) {
      if (failOnInvalid) {
        issues.push({
          reason: 'InvalidInternalDependency',
          sourceWorkloadId: source.id,
          targetWorkloadId: target.workload.id,
          message: `Workload "${source.id}" ${field} references UI workload "${target.workload.id}", which is excluded from the WRC internal-dependency lane`,
        })
      }
      return
    }
    if (isStdioTransport(target.workload)) {
      issues.push({
        reason: 'OwnershipConflict',
        sourceWorkloadId: source.id,
        targetWorkloadId: target.workload.id,
        message: `Workload "${source.id}" ${field} references stdio transport workload "${target.workload.id}"; HCC owns that selector family`,
      })
      return
    }
    if (target.workload.port == null) {
      if (failOnInvalid) {
        issues.push({
          reason: 'InvalidInternalDependency',
          sourceWorkloadId: source.id,
          targetWorkloadId: target.workload.id,
          message: `Workload "${source.id}" ${field} references "${target.workload.id}", but the target workload has no port`,
        })
      }
      return
    }
    const targetPort = port ?? target.workload.port
    if (targetPort !== target.workload.port) {
      if (failOnInvalid) {
        issues.push({
          reason: 'InvalidInternalDependency',
          sourceWorkloadId: source.id,
          targetWorkloadId: target.workload.id,
          message: `Workload "${source.id}" ${field} references "${target.workload.id}" on port ${targetPort}, but the target workload declares port ${target.workload.port}`,
        })
      }
      return
    }
    addDependency(
      deps,
      {
        sourceWorkloadId: source.id,
        sourceNamespace: resolveNamespace(source),
        targetWorkloadId: target.workload.id,
        targetNamespace: target.namespace,
        targetServiceName: target.serviceName,
        port: targetPort,
        protocol,
      },
      field
    )
  }

  for (const source of workloads) {
    if (isUiWorkload(source, uiWorkloadId)) continue

    for (const ref of collectResolvedHostReferences(source)) {
      const unresolvedByTarget = new Map<string, { target: TargetCandidate; templates: string[] }>()
      for (const templateRef of extractUnresolvedWorkloadTemplateReferences(ref.value)) {
        const target = candidatesByWorkloadId.get(templateRef.workloadId)
        if (!target) continue
        const existing = unresolvedByTarget.get(target.workload.id) ?? {
          target,
          templates: [],
        }
        existing.templates.push(`{{${target.workload.id}:${templateRef.field}}}`)
        unresolvedByTarget.set(target.workload.id, existing)
      }
      for (const { target, templates } of unresolvedByTarget.values()) {
        issues.push({
          reason: 'InvalidInternalDependency',
          sourceWorkloadId: source.id,
          targetWorkloadId: target.workload.id,
          message: `Workload "${source.id}" ${ref.field} still contains unresolved workload template(s) ${templates.join(', ')}; WRC internal-dependency evaluation must run after workload template resolution`,
        })
      }
      if (unresolvedByTarget.size > 0) continue
      for (const hostRef of extractClusterLocalHostReferences(ref.value)) {
        const target = resolveTarget(hostRef.fqdn, source, ref.field, true)
        if (!target) continue
        addResolvedDependency(source, target, ref.field, hostRef.port, 'TCP', true)
      }
    }

    for (const [index, binding] of (source.egressBindings ?? []).entries()) {
      if (!binding.dns || binding.port == null) continue
      const target = resolveTarget(binding.dns, source, bindingField(binding, index), false)
      if (!target) continue
      addResolvedDependency(
        source,
        target,
        bindingField(binding, index),
        binding.port,
        binding.protocol ?? 'TCP',
        false
      )
    }
  }

  return {
    dependencies: [...deps.values()].sort((a, b) =>
      [
        a.sourceNamespace,
        a.sourceWorkloadId,
        a.targetNamespace,
        a.targetWorkloadId,
        String(a.port),
        a.protocol,
      ]
        .join('\0')
        .localeCompare(
          [
            b.sourceNamespace,
            b.sourceWorkloadId,
            b.targetNamespace,
            b.targetWorkloadId,
            String(b.port),
            b.protocol,
          ].join('\0')
        )
    ),
    issues,
  }
}
