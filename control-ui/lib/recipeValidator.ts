import { MAX_EGRESS_BINDINGS } from './egressModel'
import type {
  OperatorDefaults,
  ValidationIssue,
  ValidationResult,
  WorkflowRecipeResource,
  WorkloadType,
} from './recipeTypes'
import { ALLOWED_WORKLOAD_TYPES } from './recipeTypes'

// RFC1123 DNS label: lowercase alphanumeric + hyphens, start/end alphanumeric, 1-63 chars
const RFC1123_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const SECRET_KEY_RE = /^[-._a-zA-Z0-9]+$/
export const WORKFLOW_RECIPE_UI_LIMITS = {
  maxSteps: 100,
  stepDependsOnMaxItems: 100,
  stepAllowedToolsMaxItems: 50,
  stepMcpServersMaxItems: 20,
} as const
export const DEFAULT_STEP_OUTPUT_PREVIEW_MAX_CHARS = 32 * 1024
export const KUBERNETES_OBJECT_BUDGET_BYTES = 1.5 * 1024 * 1024

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const STEP_RUN_KEYS = new Set(['type', 'language', 'code', 'capabilities'])
const SENSITIVE_ENV_NAME_RE = /(PASSWORD|TOKEN|SECRET|API_KEY|CREDENTIAL|PRIVATE_KEY)/i
const TEMPLATE_INPUT_REF_RE = /\{\{\s*inputs\.([A-Za-z0-9_.-]+)\s*\}\}/g
const SENSITIVE_INPUT_NAME_RE =
  /(password|passwd|pwd|token|secret|credential|api[_-]?key|apikey|private[_-]?key|privatekey)/i
const JWT_LIKE_RE = /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}$/
const SECRET_LIKE_VALUE_RE = /^(sk-[A-Za-z0-9_-]{8,}|pat[A-Za-z0-9_-]{8,})$/
const URL_WITH_PASSWORD_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^@\s]+)@/i
const INPUT_TEMPLATE_ONLY_RE = /^\{\{\s*inputs\.[A-Za-z0-9_.-]+\s*\}\}$/

function validateWorkflowSecretName(name: unknown): string | null {
  if (typeof name !== 'string' || !RFC1123_RE.test(name)) {
    return 'secretRef.name must be a lowercase RFC1123 label (letters, digits, hyphens; max 63 chars)'
  }
  if (name.startsWith('wf-')) {
    return `Secret "${name}" is platform-managed and cannot be used by WorkflowRecipe configuration.`
  }
  return null
}

function validateWorkflowSecretKey(key: unknown): string | null {
  if (typeof key !== 'string' || key.length === 0 || !SECRET_KEY_RE.test(key)) {
    return 'secret key must contain only letters, digits, dot, dash, or underscore'
  }
  return null
}

function sensitiveInputRefsInEnvValue(value: unknown): string[] {
  if (typeof value !== 'string' || !value.includes('{{')) return []

  const refs = new Set<string>()
  for (const match of value.matchAll(TEMPLATE_INPUT_REF_RE)) {
    const inputName = match[1]
    if (SENSITIVE_INPUT_NAME_RE.test(inputName)) {
      refs.add(`{{inputs.${inputName}}}`)
    }
  }
  return [...refs]
}

function parsePvcSizeGi(size: string): number {
  const m = size.match(/^(\d+(?:\.\d+)?)(Gi|Mi|G|M|Ti|T)$/)
  if (!m) return 0
  const num = parseFloat(m[1])
  const unit = m[2]
  if (unit === 'Ti' || unit === 'T') return num * 1024
  if (unit === 'Mi' || unit === 'M') return num / 1024
  return num // Gi or G
}

function inlineEnvSecretReason(name: unknown, value: unknown): string | null {
  const envName = typeof name === 'string' ? name.trim() : ''
  if (value === undefined || value === null || value === '') return null
  const envValue = typeof value === 'string' ? value.trim() : String(value)
  const urlPassword = envValue.match(URL_WITH_PASSWORD_RE)?.[1]
  const hasSensitiveInputTemplate = sensitiveInputRefsInEnvValue(envValue).length > 0
  if (
    JWT_LIKE_RE.test(envValue) ||
    SECRET_LIKE_VALUE_RE.test(envValue) ||
    (urlPassword !== undefined && !INPUT_TEMPLATE_ONLY_RE.test(urlPassword)) ||
    envValue.includes('-----BEGIN ')
  ) {
    return 'env value looks sensitive'
  }
  if (SENSITIVE_ENV_NAME_RE.test(envName) && !hasSensitiveInputTemplate) {
    return 'env name looks sensitive'
  }
  return null
}

/**
 * 3-phase client-side validation for WorkflowRecipe JSON.
 *
 * Phase 1 — Parse: JSON.parse the raw string.
 * Phase 2 — Schema: apiVersion, kind, metadata.name, workloads structure.
 * Phase 3 — Security: runAsUser >= 1, capabilities allowlist, PVC size limits.
 *
 * Returns `valid: false` if any error-severity issue exists.
 */
export function validateRecipe(input: string, defaults?: OperatorDefaults): ValidationResult {
  const issues: ValidationIssue[] = []

  // ── Phase 1: JSON Parse ──────────────────────────────────────────────────
  let parsed: WorkflowRecipeResource
  try {
    parsed = JSON.parse(input) as WorkflowRecipeResource
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      issues.push({
        phase: 'parse',
        severity: 'error',
        path: '',
        message: 'Root value must be a JSON object',
      })
      return { valid: false, issues }
    }
  } catch (e) {
    issues.push({
      phase: 'parse',
      severity: 'error',
      path: '',
      message: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    })
    return { valid: false, issues }
  }

  // ── Phase 2: Schema ──────────────────────────────────────────────────────
  if (parsed.apiVersion !== 'clerum.io/v1alpha1') {
    issues.push({
      phase: 'schema',
      severity: 'error',
      path: 'apiVersion',
      message: 'Must be "clerum.io/v1alpha1"',
    })
  }

  if (parsed.kind !== 'WorkflowRecipe') {
    issues.push({
      phase: 'schema',
      severity: 'error',
      path: 'kind',
      message: 'Must be "WorkflowRecipe"',
    })
  }

  const name = parsed.metadata?.name ?? ''
  if (!name) {
    issues.push({
      phase: 'schema',
      severity: 'error',
      path: 'metadata.name',
      message: 'name is required',
    })
  } else if (!RFC1123_RE.test(name)) {
    issues.push({
      phase: 'schema',
      severity: 'error',
      path: 'metadata.name',
      message:
        'Must match RFC1123 (lowercase alphanumeric and hyphens, 1-63 chars, start/end alphanumeric). Example: "my-recipe"',
    })
  }

  // Namespace is intentionally not validated from recipe YAML. The platform
  // always stores WorkflowRecipe CRDs in `sandbox-recipes`; control-api strips
  // any author-supplied metadata.namespace before create/update. Rendered
  // workload placement is still split by the WRC reconciler:
  //   MCP workloads (with transport) -> mcp-server
  //   non-MCP workloads / PVCs       -> sandbox-recipes

  const steps = parsed.spec?.steps
  const isWorkflow = Array.isArray(steps) && steps.length > 0
  const hasCustomCoordinator =
    typeof (parsed.spec as Record<string, unknown> | undefined)?.coordinatorImage === 'string' &&
    ((parsed.spec as Record<string, unknown>).coordinatorImage as string).trim() !== ''

  // ── Validate steps[] (agentic / snippet workflows) ─────────────────
  if (isWorkflow) {
    if (steps!.length > WORKFLOW_RECIPE_UI_LIMITS.maxSteps) {
      issues.push({
        phase: 'schema',
        severity: 'error',
        path: 'spec.steps',
        message: `Must contain at most ${WORKFLOW_RECIPE_UI_LIMITS.maxSteps} items`,
      })
    }
    const projectedStatusPreviewBytes = steps!.length * DEFAULT_STEP_OUTPUT_PREVIEW_MAX_CHARS
    if (projectedStatusPreviewBytes >= KUBERNETES_OBJECT_BUDGET_BYTES) {
      issues.push({
        phase: 'schema',
        severity: 'warning',
        path: 'spec.steps',
        message:
          `This recipe can store up to ${(projectedStatusPreviewBytes / 1024 / 1024).toFixed(1)}MiB ` +
          `of bounded step output previews in WorkflowRecipe CRD status with the default ` +
          `WRC_WORKFLOW_STEP_OUTPUT_PREVIEW_MAX_CHARS=${DEFAULT_STEP_OUTPUT_PREVIEW_MAX_CHARS}. ` +
          `This does not limit full run files: complete intermediate and final outputs should be written to /output artifacts on workflow storage and retained by the workflow retention policy. ` +
          `For large or complex workflows, declare explicit PVC-backed output/storage with an appropriate size instead of using status output as storage. ` +
          `Keep only status previews under the Kubernetes object budget.`,
      })
    }

    const stepIds = new Set<string>()
    const duplicateStepIds = new Set<string>()
    steps!.forEach((s, i) => {
      const prefix = `spec.steps[${i}]`
      if (!s.id) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: `${prefix}.id`,
          message: 'id is required',
        })
      } else if (stepIds.has(s.id)) {
        if (!duplicateStepIds.has(s.id)) {
          issues.push({
            phase: 'schema',
            severity: 'error',
            path: `${prefix}.id`,
            message: `Duplicate step id "${s.id}"`,
          })
          duplicateStepIds.add(s.id)
        }
      } else {
        stepIds.add(s.id)
      }
      const stepObj = s as Record<string, unknown>
      const hasInstruction = stepObj.instruction !== undefined
      const hasRun = stepObj.run !== undefined
      const stepDependsOn = stepObj.dependsOn
      if (
        Array.isArray(stepDependsOn) &&
        stepDependsOn.length > WORKFLOW_RECIPE_UI_LIMITS.stepDependsOnMaxItems
      ) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: `${prefix}.dependsOn`,
          message: `Must contain at most ${WORKFLOW_RECIPE_UI_LIMITS.stepDependsOnMaxItems} items`,
        })
      }
      const stepMcpServers = stepObj.mcpServers
      if (
        Array.isArray(stepMcpServers) &&
        stepMcpServers.length > WORKFLOW_RECIPE_UI_LIMITS.stepMcpServersMaxItems
      ) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: `${prefix}.mcpServers`,
          message: `Must contain at most ${WORKFLOW_RECIPE_UI_LIMITS.stepMcpServersMaxItems} items`,
        })
      }

      if (hasInstruction && hasRun) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: prefix,
          message: 'Step cannot declare both instruction and run',
        })
      } else if (!hasCustomCoordinator && hasInstruction === hasRun) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: prefix,
          message: 'Step must declare exactly one of instruction or run',
        })
      }
      if (
        hasInstruction &&
        (typeof stepObj.instruction !== 'string' || stepObj.instruction.trim() === '')
      ) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: `${prefix}.instruction`,
          message: 'instruction must be a non-empty plain string',
        })
      }
      if (hasRun) {
        const run = stepObj.run
        if (!isPlainObject(run)) {
          issues.push({
            phase: 'schema',
            severity: 'error',
            path: `${prefix}.run`,
            message: 'run must be an object',
          })
        } else {
          for (const key of Object.keys(run)) {
            if (!STEP_RUN_KEYS.has(key)) {
              issues.push({
                phase: 'schema',
                severity: 'error',
                path: `${prefix}.run.${key}`,
                message: 'unsupported run field',
              })
            }
          }
          if (run.type !== 'snippet') {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${prefix}.run.type`,
              message: 'run.type must be "snippet"',
            })
          }
          if (run.language !== 'typescript') {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${prefix}.run.language`,
              message: 'snippet language must be typescript',
            })
          }
          if (typeof run.code !== 'string' || run.code.trim() === '') {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${prefix}.run.code`,
              message: 'snippet code must be a non-empty string',
            })
          }
          if (run.capabilities !== undefined && !isPlainObject(run.capabilities)) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${prefix}.run.capabilities`,
              message: 'snippet capabilities must be an object',
            })
          } else if (isPlainObject(run.capabilities) && Array.isArray(run.capabilities.secrets)) {
            run.capabilities.secrets.forEach((entry, j) => {
              if (!isPlainObject(entry)) return
              const secretRef = isPlainObject(entry.secretRef) ? entry.secretRef : undefined
              if (!secretRef) return
              const secretNameError = validateWorkflowSecretName(secretRef.name)
              if (secretNameError) {
                issues.push({
                  phase: 'security',
                  severity: 'error',
                  path: `${prefix}.run.capabilities.secrets[${j}].secretRef.name`,
                  message: secretNameError,
                })
              }
              const secretKeyError = validateWorkflowSecretKey(secretRef.key)
              if (secretKeyError) {
                issues.push({
                  phase: 'security',
                  severity: 'error',
                  path: `${prefix}.run.capabilities.secrets[${j}].secretRef.key`,
                  message: secretKeyError,
                })
              }
            })
          }
        }
      }
      if (stepObj.maxIterations !== undefined) {
        const mi = Number(stepObj.maxIterations)
        if (!Number.isInteger(mi) || mi < 1 || mi > 100) {
          issues.push({
            phase: 'schema',
            severity: 'error',
            path: `${prefix}.maxIterations`,
            message: 'Must be an integer between 1 and 100',
          })
        }
      }

      // requiresApproval validation
      const ra = stepObj.requiresApproval as Record<string, unknown> | undefined
      if (ra !== undefined) {
        if (typeof ra !== 'object' || ra === null || Array.isArray(ra)) {
          issues.push({
            phase: 'schema',
            severity: 'error',
            path: `${prefix}.requiresApproval`,
            message: 'Must be an object',
          })
        } else {
          const target = ra.target as Record<string, unknown> | undefined
          const userId = typeof target?.userId === 'string' ? target.userId.trim() : ''
          const teamId = typeof target?.teamId === 'string' ? target.teamId.trim() : ''
          if (!target || (!userId && !teamId)) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${prefix}.requiresApproval.target`,
              message: 'target.userId or target.teamId is required',
            })
          } else if (userId && teamId) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${prefix}.requiresApproval.target`,
              message: 'Only one of target.userId or target.teamId may be set',
            })
          }
          const message = typeof ra.message === 'string' ? ra.message : ''
          if (!message.trim()) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${prefix}.requiresApproval.message`,
              message: 'message is required',
            })
          } else if (message.length > 2000) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${prefix}.requiresApproval.message`,
              message: 'message must be 2000 characters or fewer',
            })
          }
          if (ra.timeoutSeconds !== undefined) {
            const ts = Number(ra.timeoutSeconds)
            if (!Number.isInteger(ts) || ts < 30 || ts > 604800) {
              issues.push({
                phase: 'schema',
                severity: 'error',
                path: `${prefix}.requiresApproval.timeoutSeconds`,
                message: 'Must be an integer between 30 and 604800',
              })
            }
          }
        }
      }
    })
    steps!.forEach((s, i) => {
      ;(s.dependsOn ?? []).forEach((ref, j) => {
        if (!stepIds.has(ref)) {
          issues.push({
            phase: 'schema',
            severity: 'error',
            path: `spec.steps[${i}].dependsOn[${j}]`,
            message: `References unknown step id "${ref}"`,
          })
        }
      })
    })
  }

  // ── Validate spec.triggers ──────────────────────────────────────────────
  const triggers = (parsed.spec as Record<string, unknown> | undefined)?.triggers as
    | Record<string, unknown>
    | undefined
  if (isWorkflow && triggers === undefined) {
    issues.push({
      phase: 'schema',
      severity: 'error',
      path: 'spec.triggers',
      message:
        'Workflow recipes with steps must declare spec.triggers.onDemand or spec.triggers.schedule',
    })
  }
  if (triggers !== undefined) {
    if (!isPlainObject(triggers)) {
      issues.push({
        phase: 'schema',
        severity: 'error',
        path: 'spec.triggers',
        message: 'Must be an object',
      })
    } else {
      const onDemand = triggers.onDemand as Record<string, unknown> | undefined
      const schedule = triggers.schedule as Record<string, unknown> | undefined
      if (!onDemand && !schedule) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: 'spec.triggers',
          message: 'Must declare at least one of onDemand or schedule',
        })
      }
      if (onDemand && isPlainObject(onDemand)) {
        const actors = onDemand.allowedActors
        if (Array.isArray(actors)) {
          const valid = new Set(['user', 'autonomous', 'scheduled'])
          actors.forEach((a, j) => {
            if (!valid.has(a as string)) {
              issues.push({
                phase: 'schema',
                severity: 'error',
                path: `spec.triggers.onDemand.allowedActors[${j}]`,
                message: `Must be one of: user, autonomous, scheduled`,
              })
            }
          })
        }
      }
      if (schedule && isPlainObject(schedule)) {
        const cron = typeof schedule.cron === 'string' ? schedule.cron.trim() : ''
        if (!cron) {
          issues.push({
            phase: 'schema',
            severity: 'error',
            path: 'spec.triggers.schedule.cron',
            message: 'cron is required',
          })
        } else if (!/^(\S+\s+){4}\S+$/.test(cron)) {
          issues.push({
            phase: 'schema',
            severity: 'error',
            path: 'spec.triggers.schedule.cron',
            message: 'Must be a valid five-field cron expression (e.g. "0 */6 * * *")',
          })
        }
        const cp = schedule.concurrencyPolicy
        if (cp !== undefined && !['Forbid', 'Replace', 'Allow'].includes(cp as string)) {
          issues.push({
            phase: 'schema',
            severity: 'error',
            path: 'spec.triggers.schedule.concurrencyPolicy',
            message: 'Must be one of: Forbid, Replace, Allow',
          })
        }
      }
    }
    if (triggers && !isWorkflow) {
      issues.push({
        phase: 'schema',
        severity: 'error',
        path: 'spec.triggers',
        message: 'triggers requires spec.steps to be non-empty',
      })
    }
  }

  // ── Validate spec.runRetention ────────────────────────────────────────
  const runRetention = (parsed.spec as Record<string, unknown> | undefined)?.runRetention as
    | Record<string, unknown>
    | undefined
  if (runRetention !== undefined && isPlainObject(runRetention)) {
    const shl = runRetention.successfulHistoryLimit
    if (shl !== undefined) {
      const n = Number(shl)
      if (!Number.isInteger(n) || n < 0 || n > 50) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: 'spec.runRetention.successfulHistoryLimit',
          message: 'Must be an integer between 0 and 50',
        })
      }
    }
    const fhl = runRetention.failedHistoryLimit
    if (fhl !== undefined) {
      const n = Number(fhl)
      if (!Number.isInteger(n) || n < 0 || n > 100) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: 'spec.runRetention.failedHistoryLimit',
          message: 'Must be an integer between 0 and 100',
        })
      }
    }
    const ttl = runRetention.ttlSecondsAfterFinished
    if (ttl !== undefined) {
      const n = Number(ttl)
      if (!Number.isInteger(n) || n < 0 || n > 2_592_000) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: 'spec.runRetention.ttlSecondsAfterFinished',
          message: 'Must be an integer between 0 and 2592000 (30 days)',
        })
      }
    }
    const maxRunDuration = runRetention.maxRunDurationSeconds
    if (maxRunDuration !== undefined) {
      const n = Number(maxRunDuration)
      if (!Number.isInteger(n) || n < 1) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: 'spec.runRetention.maxRunDurationSeconds',
          message: 'Must be a positive integer',
        })
      }
    }
  }

  // ── Validate output.destination enum ────────────────────────────────────
  const outputDest = (parsed.spec as Record<string, unknown> | undefined)?.output as
    | Record<string, unknown>
    | undefined
  if (outputDest?.destination !== undefined) {
    const allowed = ['configmap', 'secret', 'stdout', 'pvc']
    if (!allowed.includes(outputDest.destination as string)) {
      issues.push({
        phase: 'schema',
        severity: 'error',
        path: 'spec.output.destination',
        message: `Unsupported value "${String(outputDest.destination)}" — must be one of: ${allowed.join(', ')}`,
      })
    }
  }

  // ── Validate mcpServers[] ────────────────────────────────────────────────
  // endpoint is auto-computed by WRC for workloads with transport — only required
  // for external connectors that don't have a matching workload.
  const mcpServers = parsed.spec?.mcpServers
  const transportWorkloadIds = new Set(
    (parsed.spec?.workloads ?? [])
      .filter(w => w.transport)
      .map(w => w.id)
      .filter(Boolean)
  )
  if (Array.isArray(mcpServers) && mcpServers.length > 0) {
    mcpServers.forEach((m, i) => {
      const prefix = `spec.mcpServers[${i}]`
      if (!m.id) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: `${prefix}.id`,
          message: 'id is required',
        })
      } else if (!m.endpoint && !transportWorkloadIds.has(m.id)) {
        // endpoint required only if there's no MCP workload in the recipe that
        // already provides the server identity via the current transport-backed path
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: `${prefix}.endpoint`,
          message:
            'endpoint is required for external connectors (not backed by an MCP workload declared in workloads[])',
        })
      }
    })
  }

  // ── Cross-validate: step mcpServer refs → workload IDs ────────────────────
  if (isWorkflow) {
    const mcpServerIds = Array.isArray(mcpServers) ? mcpServers.map(m => m.id).filter(Boolean) : []
    const validMcpIds = new Set(mcpServerIds)
    transportWorkloadIds.forEach(id => validMcpIds.add(id))
    ;(steps ?? []).forEach((s, i) => {
      const stepObj = s as Record<string, unknown>
      const stepMcpRefs = (stepObj.mcpServers as string[]) ?? []
      stepMcpRefs.forEach((ref, j) => {
        if (!validMcpIds.has(ref)) {
          issues.push({
            phase: 'schema',
            severity: 'error',
            path: `spec.steps[${i}].mcpServers[${j}]`,
            message: `References unknown connector "${ref}" — must match an MCP workload id in workloads[] or an mcpServers[].id entry`,
          })
        }
      })
      // Validate allowedTools: tool names must use serverName__toolName prefix
      // and the serverName must be one of the step's declared mcpServers —
      // EXCEPT for built-in prefixes (currently "clerum") which StepMcpRouter
      // registers automatically before MCP connect (see CLAUDE.md "Internal
      // Output Tools"). Built-ins do NOT need to appear in mcpServers.
      const BUILTIN_TOOL_PREFIXES = new Set(['clerum'])
      const allowed = (stepObj.allowedTools as { include?: string[] } | undefined)?.include
      if (Array.isArray(allowed) && allowed.length > 0) {
        if (allowed.length > WORKFLOW_RECIPE_UI_LIMITS.stepAllowedToolsMaxItems) {
          issues.push({
            phase: 'schema',
            severity: 'error',
            path: `spec.steps[${i}].allowedTools.include`,
            message: `Must contain at most ${WORKFLOW_RECIPE_UI_LIMITS.stepAllowedToolsMaxItems} items`,
          })
        }
        const stepServerSet = new Set(stepMcpRefs)
        allowed.forEach((toolName, j) => {
          if (!toolName.includes('__')) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `spec.steps[${i}].allowedTools.include[${j}]`,
              message: `Tool "${toolName}" must use serverName__toolName format (e.g. "web-search__search")`,
            })
          } else {
            const serverPrefix = toolName.split('__')[0]
            if (BUILTIN_TOOL_PREFIXES.has(serverPrefix)) {
              // built-in — no validation needed
              return
            }
            if (!stepServerSet.has(serverPrefix)) {
              issues.push({
                phase: 'schema',
                severity: 'warning',
                path: `spec.steps[${i}].allowedTools.include[${j}]`,
                message: `Tool "${toolName}" references server "${serverPrefix}" not listed in this step's mcpServers`,
              })
            }
          }
        })
      }
    })
  }

  const workloads = parsed.spec?.workloads
  if (!Array.isArray(workloads) || workloads.length === 0) {
    if (!isWorkflow) {
      issues.push({
        phase: 'schema',
        severity: 'error',
        path: 'spec.workloads',
        message: 'Must be a non-empty array',
      })
    }
  }
  // ── contextRef is OPTIONAL when workloads have transport ─────────────────
  //
  // When the recipe omits `spec.contextRef`, the WRC reconciler
  // (`mcpDelegation.ts::ensureRecipeContext`) auto-creates a per-recipe
  // Context named `wf-<recipeName>` with owner-reference to the recipe.
  // That private Context lists ONLY the recipe's connectors — no sharing
  // with first-party aggregated contexts like "context1".
  //
  // Historically this rule required contextRef as an error, which pushed
  // authors toward shared contexts by default (e.g. "context1"). The
  // auto-context is the secure default: private, garbage-collected with
  // the recipe, no cross-recipe first-party server exposure. An explicit
  // contextRef is only needed when the author WANTS to share servers
  // across recipes.
  //
  // We leave an INFO-level hint so authors who are new to the platform
  // understand what happens when they omit the field.
  const hasTransportWorkload = Array.isArray(workloads) && workloads.some(w => w.transport)
  if (hasTransportWorkload && !parsed.spec?.contextRef) {
    issues.push({
      phase: 'schema',
      severity: 'info',
      path: 'spec.contextRef',
      message:
        'Omitted — WRC will auto-create a private Context "wf-<recipeName>" for this recipe. Set explicitly only to share connectors with other recipes in the same namespace.',
    })
  }

  if (Array.isArray(workloads) && workloads.length > 0) {
    const seenIds = new Set<string>()

    workloads.forEach((w, i) => {
      const prefix = `spec.workloads[${i}]`
      const workloadObject = w as Record<string, unknown>

      if (!w.id) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: `${prefix}.id`,
          message: 'id is required',
        })
      } else if (seenIds.has(w.id)) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: `${prefix}.id`,
          message: `Duplicate workload id "${w.id}"`,
        })
      } else {
        seenIds.add(w.id)
      }

      if (!w.type) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: `${prefix}.type`,
          message: 'type is required',
        })
      } else if (!ALLOWED_WORKLOAD_TYPES.includes(w.type as WorkloadType)) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: `${prefix}.type`,
          message: `Must be one of: ${ALLOWED_WORKLOAD_TYPES.join(', ')}`,
        })
      }

      if (!w.image) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: `${prefix}.image`,
          message: 'image is required',
        })
      }

      const env = workloadObject.env
      if (Array.isArray(env)) {
        env.forEach((entry, j) => {
          if (!isPlainObject(entry)) return
          const reason = inlineEnvSecretReason(entry.name, entry.value)
          if (reason) {
            issues.push({
              phase: 'security',
              severity: 'error',
              path: `${prefix}.env[${j}].value`,
              message: `${reason}; move this value to envSecret`,
            })
          }
          const sensitiveInputRefs = sensitiveInputRefsInEnvValue(entry.value)
          if (sensitiveInputRefs.length > 0) {
            issues.push({
              phase: 'security',
              severity: 'warning',
              path: `${prefix}.env[${j}].value`,
              message:
                `env.value references sensitive input template(s) ${sensitiveInputRefs.join(', ')}; ` +
                'prefer envSecret or secretRef instead of storing secrets in spec.inputs',
            })
          }
        })
      }

      const envSecret = workloadObject.envSecret
      if (isPlainObject(envSecret)) {
        const secretNameError = validateWorkflowSecretName(envSecret.name)
        if (secretNameError) {
          issues.push({
            phase: 'security',
            severity: 'error',
            path: `${prefix}.envSecret.name`,
            message: secretNameError,
          })
        }
        if (Array.isArray(envSecret.keys)) {
          envSecret.keys.forEach((entry, j) => {
            if (!isPlainObject(entry)) return
            const secretKeyError = validateWorkflowSecretKey(entry.secretKey)
            if (secretKeyError) {
              issues.push({
                phase: 'security',
                severity: 'error',
                path: `${prefix}.envSecret.keys[${j}].secretKey`,
                message: secretKeyError,
              })
            }
          })
        }
      }

      const egressBindings = workloadObject.egressBindings
      if (Array.isArray(egressBindings)) {
        if (egressBindings.length > MAX_EGRESS_BINDINGS) {
          issues.push({
            phase: 'schema',
            severity: 'error',
            path: `${prefix}.egressBindings`,
            message: `egressBindings must contain at most ${MAX_EGRESS_BINDINGS} items`,
          })
        }
        egressBindings.forEach((binding, j) => {
          const bindingPath = `${prefix}.egressBindings[${j}]`
          if (!isPlainObject(binding)) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: bindingPath,
              message: 'Must be an object',
            })
            return
          }

          const egressClass = binding.egressClass ?? 'exact-host'
          if (
            egressClass !== 'exact-host' &&
            egressClass !== 'public-web' &&
            egressClass !== 'provider'
          ) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${bindingPath}.egressClass`,
              message: 'egressClass must be exact-host, public-web, or provider',
            })
          }

          if (Object.prototype.hasOwnProperty.call(binding, 'cidr')) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${bindingPath}.cidr`,
              message: 'cidr is not allowed on WorkflowRecipe egressBindings',
            })
          }

          const allowedKeys = new Set(['egressClass', 'dns', 'port', 'protocol', 'provider'])
          for (const key of Object.keys(binding)) {
            if (!allowedKeys.has(key)) {
              issues.push({
                phase: 'schema',
                severity: 'error',
                path: `${bindingPath}.${key}`,
                message: `"${key}" is not allowed on WorkflowRecipe egressBindings`,
              })
            }
          }

          if (egressClass === 'public-web') {
            const hasExactHostFields =
              Object.prototype.hasOwnProperty.call(binding, 'dns') ||
              Object.prototype.hasOwnProperty.call(binding, 'port') ||
              Object.prototype.hasOwnProperty.call(binding, 'protocol')
            if (hasExactHostFields) {
              issues.push({
                phase: 'schema',
                severity: 'error',
                path: bindingPath,
                message: 'public-web egressBindings must not declare dns, port, or protocol',
              })
            }
            if (!workloadObject.transport) {
              issues.push({
                phase: 'schema',
                severity: 'error',
                path: `${bindingPath}.egressClass`,
                message:
                  'public-web is only supported on MCP transport workloads; non-transport workloads must use exact-host egressBindings',
              })
            } else if (!hasExactHostFields) {
              issues.push({
                phase: 'security',
                severity: 'warning',
                path: `${bindingPath}.egressClass`,
                message:
                  'public-web allows public internet egress on TCP 80/443 with private, metadata, service, and reserved ranges blocked by NetworkPolicy',
              })
            }
            return
          }

          const port = binding.port
          if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${bindingPath}.port`,
              message: 'port must be an integer between 1 and 65535',
            })
          }

          // issue #299 Phase 2 — provider mode: validate the provider object shape
          // (name/categories are open strings, catalog-checked at reconcile). A
          // provider object on a non-provider binding is an error.
          if (egressClass === 'provider') {
            const provider = binding.provider
            if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) {
              issues.push({
                phase: 'schema',
                severity: 'error',
                path: `${bindingPath}.provider`,
                message: 'provider egressBindings must declare a provider object with name',
              })
            } else {
              const p = provider as { name?: unknown; categories?: unknown }
              if (typeof p.name !== 'string' || !/^[a-z0-9-]{1,63}$/.test(p.name)) {
                issues.push({
                  phase: 'schema',
                  severity: 'error',
                  path: `${bindingPath}.provider.name`,
                  message:
                    'provider.name must be a lowercase alphanumeric-dash string (1-63 chars)',
                })
              }
              if (
                p.categories !== undefined &&
                (!Array.isArray(p.categories) ||
                  p.categories.length > 10 ||
                  p.categories.some(c => typeof c !== 'string' || c.length < 1 || c.length > 63))
              ) {
                issues.push({
                  phase: 'schema',
                  severity: 'error',
                  path: `${bindingPath}.provider.categories`,
                  message: 'provider.categories must be an array of up to 10 non-empty strings',
                })
              }
            }
          } else if (Object.prototype.hasOwnProperty.call(binding, 'provider')) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${bindingPath}.provider`,
              message: 'provider declarations require egressClass "provider"',
            })
          }

          const dns = typeof binding.dns === 'string' ? binding.dns.trim() : ''
          if (!dns) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${bindingPath}.dns`,
              message: 'dns is required',
            })
          } else {
            if (dns.includes('/')) {
              issues.push({
                phase: 'schema',
                severity: 'error',
                path: `${bindingPath}.dns`,
                message: 'dns must not use CIDR notation',
              })
            }
            if (dns === '*' || dns.startsWith('*.')) {
              issues.push({
                phase: 'schema',
                severity: 'error',
                path: `${bindingPath}.dns`,
                message: 'wildcard dns values are not allowed',
              })
            }
          }
        })
      }
    })

    const runtimeEgress = (parsed.spec as Record<string, unknown> | undefined)?.runtimeEgress
    if (isPlainObject(runtimeEgress) && isPlainObject(runtimeEgress.http)) {
      const allowedHosts = runtimeEgress.http.allowedHosts
      if (Array.isArray(allowedHosts) && allowedHosts.length > MAX_EGRESS_BINDINGS) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: 'spec.runtimeEgress.http.allowedHosts',
          message: `allowedHosts must contain at most ${MAX_EGRESS_BINDINGS} items`,
        })
      }
    }

    const stepArray = Array.isArray(steps) ? (steps as Array<Record<string, unknown>>) : []
    stepArray.forEach((step, i) => {
      const run = isPlainObject(step.run) ? step.run : undefined
      const capabilities = isPlainObject(run?.capabilities) ? run.capabilities : undefined
      const http = isPlainObject(capabilities?.http) ? capabilities.http : undefined
      const allowedHosts = http?.allowedHosts
      if (Array.isArray(allowedHosts) && allowedHosts.length > MAX_EGRESS_BINDINGS) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: `spec.steps[${i}].run.capabilities.http.allowedHosts`,
          message: `allowedHosts must contain at most ${MAX_EGRESS_BINDINGS} items`,
        })
      }
    })

    // Validate dependsOn cross-references (after building seenIds)
    workloads.forEach((w, i) => {
      ;(w.dependsOn ?? []).forEach((ref, j) => {
        if (!seenIds.has(ref)) {
          issues.push({
            phase: 'schema',
            severity: 'error',
            path: `spec.workloads[${i}].dependsOn[${j}]`,
            message: `References unknown workload id "${ref}"`,
          })
        }
      })
    })

    const transportIds = new Set(
      workloads
        .filter(w => Boolean(w.transport))
        .map(w => w.id)
        .filter(Boolean)
    )
    const bindings = (parsed.spec as Record<string, unknown> | undefined)?.bindings
    if (bindings !== undefined) {
      if (!Array.isArray(bindings)) {
        issues.push({
          phase: 'schema',
          severity: 'error',
          path: 'spec.bindings',
          message: 'bindings must be an array',
        })
      } else {
        bindings.forEach((binding, i) => {
          const prefix = `spec.bindings[${i}]`
          if (!isPlainObject(binding)) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: prefix,
              message: 'Must be an object',
            })
            return
          }

          const from = typeof binding.from === 'string' ? binding.from.trim() : ''
          const to = typeof binding.to === 'string' ? binding.to.trim() : ''
          if (!from) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${prefix}.from`,
              message: 'from is required',
            })
          } else if (!seenIds.has(from)) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${prefix}.from`,
              message: `References unknown workload id "${from}"`,
            })
          }
          if (!to) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${prefix}.to`,
              message: 'to is required',
            })
          } else if (!seenIds.has(to)) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${prefix}.to`,
              message: `References unknown workload id "${to}"`,
            })
          }

          const port = Number(binding.port)
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${prefix}.port`,
              message: 'port must be an integer between 1 and 65535',
            })
          }
          if (
            binding.protocol !== undefined &&
            !['TCP', 'UDP'].includes(String(binding.protocol))
          ) {
            issues.push({
              phase: 'schema',
              severity: 'error',
              path: `${prefix}.protocol`,
              message: 'protocol must be one of: TCP, UDP',
            })
          }

          if (from && to && seenIds.has(from) && seenIds.has(to)) {
            const transportEndpoints = [from, to].filter(id => transportIds.has(id))
            if (transportEndpoints.length !== 1) {
              issues.push({
                phase: 'schema',
                severity: 'error',
                path: prefix,
                message:
                  'binding must connect exactly one MCP transport workload to one non-transport workload',
              })
            }
          }
        })
      }
    }
  }

  // ── Phase 3: Security Compliance ────────────────────────────────────────
  if (defaults && Array.isArray(workloads)) {
    workloads.forEach((w, i) => {
      const prefix = `spec.workloads[${i}]`
      const sec = w.security

      if (sec) {
        if (sec.runAsUser !== undefined && sec.runAsUser < 1) {
          issues.push({
            phase: 'security',
            severity: 'error',
            path: `${prefix}.security.runAsUser`,
            message: 'Must be >= 1 (UID 0 / root is rejected by policy)',
          })
        }

        ;(sec.addCapabilities ?? []).forEach((cap, j) => {
          if (!defaults.security.allowedCapabilities.includes(cap)) {
            issues.push({
              phase: 'security',
              severity: 'error',
              path: `${prefix}.security.addCapabilities[${j}]`,
              message: `"${cap}" is not in the operator's allowed capabilities list (${defaults.security.allowedCapabilities.join(', ')})`,
            })
          }
        })
      }

      ;(w.volumeClaimTemplates ?? []).forEach((vct, j) => {
        const sizeGi = parsePvcSizeGi(vct.size ?? '0')
        if (sizeGi > defaults.storage.maxPvcSizeGi) {
          issues.push({
            phase: 'security',
            severity: 'warning',
            path: `${prefix}.volumeClaimTemplates[${j}].size`,
            message: `${vct.size} exceeds operator max PVC size (${defaults.storage.maxPvcSizeGi}Gi)`,
          })
        }
      })
    })
  }

  const valid = !issues.some(issue => issue.severity === 'error')
  return { valid, issues, parsed }
}
