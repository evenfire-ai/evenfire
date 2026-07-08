import {
  WORKFLOW_RECIPE_DEFAULT_ALLOWED_CAPABILITIES,
  isWorkflowRecipeDefaultAllowedCapability,
} from '@clerum/workflow-recipe-capability-policy'
import { SecurityIsolationLevel, WorkloadSecurityOverrides } from '../types'

export interface K8sContainerSecurityContext {
  runAsNonRoot: boolean
  allowPrivilegeEscalation: boolean
  readOnlyRootFilesystem: boolean
  capabilities: { drop: string[]; add?: string[] }
  seccompProfile?: { type: string }
}

export interface K8sPodSecurityContext {
  runAsUser?: number
  runAsGroup?: number
  fsGroup?: number
}

export interface K8sPodSpec {
  automountServiceAccountToken?: boolean
}

export interface K8sPodSecurityLabels {
  'pod-security.kubernetes.io/enforce'?: string
  'pod-security.kubernetes.io/enforce-version'?: string
}

export interface SecurityContextResult {
  container: K8sContainerSecurityContext
  podSecurityContext?: K8sPodSecurityContext
  podSpec?: K8sPodSpec
  podLabels?: K8sPodSecurityLabels
}

/**
 * Build K8s SecurityContext from isolation level.
 *
 * Levels (additive):
 * - minimal: allows running as root (for compatibility), drop ALL caps, no privilege escalation, seccomp RuntimeDefault
 * - standard: minimal + runAsNonRoot enforcement + readOnlyRootFilesystem
 * - strict: standard + runAsUser:65534 + fsGroup:65534 + automountServiceAccountToken:false + PodSecurity "restricted"
 *
 * L0 complement: The security context builder works alongside the L0 deny-all
 * NetworkPolicy. While L0 controls network-level isolation (no ingress/egress),
 * securityContext controls container-level isolation (no privilege escalation,
 * dropped capabilities). Together they form the defense-in-depth
 * baseline for all runtime workloads.
 */
function build(level: SecurityIsolationLevel): SecurityContextResult {
  // Base: minimal (allows running as root for compatibility with standard images)
  const container: K8sContainerSecurityContext = {
    runAsNonRoot: false, // minimal allows root (for images like mongo, nginx, redis)
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: false,
    capabilities: { drop: ['ALL'] },
    seccompProfile: { type: 'RuntimeDefault' },
  }

  if (level === 'minimal') {
    return { container }
  }

  // Standard: enforces runAsNonRoot + adds read-only FS
  container.runAsNonRoot = true // enforce non-root for production workloads
  container.readOnlyRootFilesystem = true

  if (level === 'standard') {
    return { container }
  }

  // Strict: adds pod-level security, SA restriction, PodSecurity labels
  if (level === 'strict') {
    return {
      container,
      podSecurityContext: {
        runAsUser: 65534,
        runAsGroup: 65534,
        fsGroup: 65534,
      },
      podSpec: {
        automountServiceAccountToken: false,
      },
      podLabels: {
        'pod-security.kubernetes.io/enforce': 'restricted',
        'pod-security.kubernetes.io/enforce-version': 'latest',
      },
    }
  }

  throw new Error(`Unknown isolation level: ${level}`)
}

/**
 * Build K8s SecurityContext with per-workload overrides.
 *
 * Wraps `build()` and applies optional overrides for runAsUser, runAsGroup, fsGroup.
 * When runAsUser is set, runAsNonRoot is forced to true as a safety measure.
 *
 * This enables images like PostgreSQL (UID 70) or MongoDB (UID 999) to run
 * under their expected user while maintaining the base isolation model.
 */
export function buildWithOverrides(
  level: SecurityIsolationLevel,
  overrides?: WorkloadSecurityOverrides
): SecurityContextResult {
  const base = build(level)
  if (!overrides) return base

  if (overrides.runAsUser) {
    base.container.runAsNonRoot = true
    if (!base.podSecurityContext) {
      base.podSecurityContext = {}
    }
    base.podSecurityContext.runAsUser = overrides.runAsUser
  }

  if (overrides.runAsGroup) {
    if (!base.podSecurityContext) {
      base.podSecurityContext = {}
    }
    base.podSecurityContext.runAsGroup = overrides.runAsGroup
  }

  if (overrides.fsGroup) {
    if (!base.podSecurityContext) {
      base.podSecurityContext = {}
    }
    base.podSecurityContext.fsGroup = overrides.fsGroup
  }

  if (overrides.addCapabilities && overrides.addCapabilities.length > 0) {
    const rejected = overrides.addCapabilities.filter(
      c => !isWorkflowRecipeDefaultAllowedCapability(c)
    )
    if (rejected.length > 0) {
      throw new Error(
        `Disallowed Linux capabilities: ${rejected.join(', ')}. Allowed: ${WORKFLOW_RECIPE_DEFAULT_ALLOWED_CAPABILITIES.join(', ')}`
      )
    }
    base.container.capabilities.add = overrides.addCapabilities
  }

  return base
}
