import type { ApprovalMode } from './approvalMode'
import type { GateCause } from './gateCause'
import type { ShellVerdict } from './shellClassifier'

export type CellId =
  | 'N1'
  | 'C1'
  | 'M1'
  | 'M2'
  | 'A1'
  | 'A2'
  | 'A3'
  | 'A4'
  | 'A5'
  | 'A6'
  | 'X1'
  | 'U1'

export type ModeDecision =
  | { kind: 'run'; cell: CellId }
  | { kind: 'card'; cell: CellId; scope: 'exact_invocation' | 'as_produced'; shellCard?: true }
  | { kind: 'classify'; cell: 'A3' }
  | { kind: 'stop'; cell: 'A4' }

const MANUAL_GRANT_CAUSES = new Set<GateCause>(['ordinary', 'admin_forced'])
const EXACT_CARD_CAUSES = new Set<GateCause>([
  'cron_forced',
  'live',
  'denied',
  'denials_active',
  'guardrail_ask',
])
const AUTO_EXACT_CAUSES = new Set<GateCause>([
  'admin_forced',
  'live',
  'denied',
  'denials_active',
  'guardrail_ask',
])

function toolClass(toolName: string): 'shell' | 'http' | 'cron' | 'other' {
  if (toolName === 'shell_exec') return 'shell'
  if (toolName === 'http_request') return 'http'
  if (toolName === 'cron_manage') return 'cron'
  return 'other'
}

function nameGranted(input: {
  toolName: string
  grants: { task: ReadonlySet<string>; always: ReadonlySet<string> }
}): boolean {
  return input.grants.task.has(input.toolName) || input.grants.always.has(input.toolName)
}

/** Manual column. Cron always reports `C1`; other tools report `M1` or `M2`. */
function manualColumn(
  input: {
    toolName: string
    cause: GateCause | undefined
    grants: { task: ReadonlySet<string>; always: ReadonlySet<string> }
  },
  cron: boolean
): ModeDecision {
  if (input.cause !== undefined && EXACT_CARD_CAUSES.has(input.cause)) {
    return { kind: 'card', cell: cron ? 'C1' : 'M2', scope: 'exact_invocation' }
  }
  if (input.cause !== undefined && MANUAL_GRANT_CAUSES.has(input.cause) && nameGranted(input)) {
    return { kind: 'run', cell: cron ? 'C1' : 'M1' }
  }
  if (input.cause !== undefined && MANUAL_GRANT_CAUSES.has(input.cause)) {
    return { kind: 'card', cell: cron ? 'C1' : 'M1', scope: 'as_produced' }
  }
  return { kind: 'card', cell: 'U1', scope: 'exact_invocation' }
}

const shellCard: ModeDecision = {
  kind: 'card',
  cell: 'A3',
  scope: 'exact_invocation',
  shellCard: true,
}

/**
 * Pure decision table. `CANCELLED` is `A4` before any other cell, including a
 * second read that would be manual or `admin_forced`. Any other verdict is
 * used only when this call is still `A3`.
 */
export function decideApproval(input: {
  mode: ApprovalMode
  toolName: string
  cause: GateCause | undefined
  grants: {
    task: ReadonlySet<string>
    always: ReadonlySet<string>
    autoShell: { wholeTool: boolean; commands: ReadonlySet<string> }
  }
  command?: string
  classifierAvailable: boolean
  verdict?: ShellVerdict
}): ModeDecision {
  if (input.verdict === 'CANCELLED') return { kind: 'stop', cell: 'A4' }
  if (input.cause === undefined) {
    return { kind: 'card', cell: 'U1', scope: 'exact_invocation' }
  }
  if (input.cause === 'none') return { kind: 'run', cell: 'N1' }

  const tool = toolClass(input.toolName)
  if (tool === 'cron') return manualColumn(input, true)
  if (input.mode === 'manual') return manualColumn(input, false)
  if (input.mode === 'allow_all') return { kind: 'run', cell: 'X1' }

  if (AUTO_EXACT_CAUSES.has(input.cause) || input.cause !== 'ordinary') {
    return { kind: 'card', cell: 'A5', scope: 'exact_invocation' }
  }
  if (tool === 'http') return { kind: 'run', cell: 'A2' }
  if (tool === 'other') return { kind: 'card', cell: 'A6', scope: 'exact_invocation' }

  const shell = input.grants.autoShell
  if (shell.wholeTool || (input.command !== undefined && shell.commands.has(input.command))) {
    return { kind: 'run', cell: 'A1' }
  }
  if (input.verdict === 'APPROVE') return { kind: 'run', cell: 'A3' }
  if (input.verdict === 'ESCALATE' || !input.classifierAvailable) return shellCard
  return { kind: 'classify', cell: 'A3' }
}
