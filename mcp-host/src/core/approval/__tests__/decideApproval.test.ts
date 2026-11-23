import { describe, expect, it } from 'vitest'
import { approvalParametersWithinNotificationLimit } from '../../../agent/stateMachine'
import { projectGfsApproval } from '../../../visualInput/suspension'
import type { PendingApproval } from '../../types'
import type { ApprovalMode } from '../approvalMode'
import { type ModeDecision, decideApproval } from '../decideApproval'
import type { GateCause } from '../gateCause'
import { GRANT_COVERED_BY } from '../nativeApprovalCause'
import { shellCardDescriptor } from '../shellCard'
import type { ShellVerdict } from '../shellClassifier'

const SHELL = 'shell_exec'
const HTTP = 'http_request'
const CRON = 'cron_manage'
const OTHER = 'browser_open'
const MODES: ApprovalMode[] = ['manual', 'auto', 'allow_all']
const NON_CRON = [SHELL, HTTP, OTHER] as const
const M2_CAUSES: GateCause[] = ['cron_forced', 'live', 'denied', 'denials_active', 'guardrail_ask']
const A5_CAUSES: GateCause[] = ['admin_forced', 'live', 'denied', 'denials_active', 'guardrail_ask']
const X1_CAUSES: GateCause[] = [
  'ordinary',
  'admin_forced',
  'cron_forced',
  'live',
  'denied',
  'denials_active',
]

function grants(partial?: {
  task?: string[]
  always?: string[]
  wholeTool?: boolean
  commands?: string[]
}) {
  return {
    task: new Set(partial?.task ?? []),
    always: new Set(partial?.always ?? []),
    autoShell: {
      wholeTool: partial?.wholeTool === true,
      commands: new Set(partial?.commands ?? []),
    },
  }
}

function decide(input: {
  mode?: ApprovalMode
  toolName?: string
  cause?: GateCause
  command?: string
  classifierAvailable?: boolean
  verdict?: ShellVerdict
  task?: string[]
  always?: string[]
  wholeTool?: boolean
  commands?: string[]
}): ModeDecision {
  return decideApproval({
    mode: input.mode ?? 'manual',
    toolName: input.toolName ?? SHELL,
    cause: input.cause,
    grants: grants(input),
    ...(input.command !== undefined ? { command: input.command } : {}),
    classifierAvailable: input.classifierAvailable === true,
    ...(input.verdict ? { verdict: input.verdict } : {}),
  })
}

function parametersOfJsonLength(length: number): Record<string, unknown> {
  const prefix = '{"command":"'
  const suffix = '"}'
  const parameters = { command: 'x'.repeat(length - prefix.length - suffix.length) }
  if (JSON.stringify(parameters).length !== length) {
    throw new Error(`expected JSON length ${length}, got ${JSON.stringify(parameters).length}`)
  }
  return parameters
}

describe('decideApproval', () => {
  it('treats an unknown mode as manual', () => {
    const decision = decide({
      mode: 'yolo' as ApprovalMode,
      toolName: HTTP,
      cause: 'ordinary',
    })
    expect(decision).toMatchObject({ kind: 'card', cell: 'M1' })
  })

  it.each(MODES.flatMap(mode => [SHELL, HTTP, CRON, OTHER].map(toolName => ({ mode, toolName }))))(
    'N1 $mode $toolName runs when the cause is none',
    ({ mode, toolName }) => {
      expect(decide({ mode, toolName, cause: 'none', wholeTool: true })).toEqual({
        kind: 'run',
        cell: 'N1',
      })
    }
  )

  it('U1 cards a missing cause for http in auto and for any tool in allow-all', () => {
    expect(decide({ mode: 'auto', toolName: HTTP })).toEqual({
      kind: 'card',
      cell: 'U1',
      scope: 'exact_invocation',
    })
    expect(decide({ mode: 'allow_all', toolName: SHELL, wholeTool: true })).toEqual({
      kind: 'card',
      cell: 'U1',
      scope: 'exact_invocation',
    })
    expect(decide({ mode: 'manual', toolName: CRON, task: [CRON] })).toEqual({
      kind: 'card',
      cell: 'U1',
      scope: 'exact_invocation',
    })
  })

  it.each([
    { mode: 'manual' as const, toolName: HTTP, cause: 'ordinary' as const },
    { mode: 'manual' as const, toolName: SHELL, cause: 'admin_forced' as const, wholeTool: true },
    { mode: 'allow_all' as const, toolName: OTHER, cause: 'ordinary' as const },
    { mode: 'auto' as const, toolName: SHELL, cause: 'admin_forced' as const, wholeTool: true },
  ])(
    'CANCELLED is A4 before the second cell ($mode $toolName $cause)',
    ({ mode, toolName, cause, wholeTool }) => {
      expect(
        decide({ mode, toolName, cause, wholeTool, verdict: 'CANCELLED', task: [toolName] })
      ).toEqual({ kind: 'stop', cell: 'A4' })
    }
  )

  it.each(
    NON_CRON.flatMap(toolName =>
      (['ordinary', 'admin_forced'] as const).map(cause => ({ toolName, cause }))
    )
  )(
    'M1 $toolName $cause runs on a name grant and otherwise keeps the producer scope',
    ({ toolName, cause }) => {
      expect(decide({ mode: 'manual', toolName, cause, task: [toolName] })).toEqual({
        kind: 'run',
        cell: 'M1',
      })
      expect(decide({ mode: 'manual', toolName, cause, always: [toolName] })).toEqual({
        kind: 'run',
        cell: 'M1',
      })
      expect(decide({ mode: 'manual', toolName, cause, wholeTool: true })).toEqual({
        kind: 'card',
        cell: 'M1',
        scope: 'as_produced',
      })
    }
  )

  it.each(NON_CRON.flatMap(toolName => M2_CAUSES.map(cause => ({ toolName, cause }))))(
    'M2 $toolName $cause is an exact card even with a name grant',
    ({ toolName, cause }) => {
      expect(
        decide({ mode: 'manual', toolName, cause, task: [toolName], always: [toolName] })
      ).toEqual({
        kind: 'card',
        cell: 'M2',
        scope: 'exact_invocation',
      })
    }
  )

  it.each(MODES)('C1 %s uses the manual column for cron and is not an allow-all run', mode => {
    expect(decide({ mode, toolName: CRON, cause: 'ordinary', task: [CRON] })).toEqual({
      kind: 'run',
      cell: 'C1',
    })
    expect(decide({ mode, toolName: CRON, cause: 'admin_forced', always: [CRON] })).toEqual({
      kind: 'run',
      cell: 'C1',
    })
    expect(decide({ mode, toolName: CRON, cause: 'ordinary' })).toEqual({
      kind: 'card',
      cell: 'C1',
      scope: 'as_produced',
    })
    for (const cause of M2_CAUSES) {
      expect(decide({ mode, toolName: CRON, cause, task: [CRON] })).toEqual({
        kind: 'card',
        cell: 'C1',
        scope: 'exact_invocation',
      })
    }
  })

  it('A1 runs an exact command or the whole tool and does not classify', () => {
    expect(
      decide({ mode: 'auto', toolName: SHELL, cause: 'ordinary', command: 'ls', commands: ['ls'] })
    ).toEqual({ kind: 'run', cell: 'A1' })
    expect(
      decide({
        mode: 'auto',
        toolName: SHELL,
        cause: 'ordinary',
        command: 'ls',
        wholeTool: true,
        classifierAvailable: false,
      })
    ).toEqual({ kind: 'run', cell: 'A1' })
    expect(
      decide({
        mode: 'auto',
        toolName: SHELL,
        cause: 'ordinary',
        command: 'ls',
        commands: ['ls'],
        verdict: 'ESCALATE',
        classifierAvailable: true,
      })
    ).toEqual({ kind: 'run', cell: 'A1' })
  })

  it('A2 runs ordinary HTTP without using a verdict or a grant', () => {
    expect(
      decide({
        mode: 'auto',
        toolName: HTTP,
        cause: 'ordinary',
        verdict: 'ESCALATE',
        classifierAvailable: true,
      })
    ).toEqual({ kind: 'run', cell: 'A2' })
  })

  it('A3 classifies, runs APPROVE, and cards ESCALATE or an unavailable classifier', () => {
    expect(
      decide({
        mode: 'auto',
        toolName: SHELL,
        cause: 'ordinary',
        command: 'pwd',
        commands: ['ls'],
        classifierAvailable: true,
      })
    ).toEqual({ kind: 'classify', cell: 'A3' })
    expect(
      decide({
        mode: 'auto',
        toolName: SHELL,
        cause: 'ordinary',
        command: 'pwd',
        classifierAvailable: true,
        verdict: 'APPROVE',
      })
    ).toEqual({ kind: 'run', cell: 'A3' })
    expect(
      decide({
        mode: 'auto',
        toolName: SHELL,
        cause: 'ordinary',
        command: 'pwd',
        classifierAvailable: true,
        verdict: 'ESCALATE',
      })
    ).toEqual({ kind: 'card', cell: 'A3', scope: 'exact_invocation', shellCard: true })
    expect(
      decide({
        mode: 'auto',
        toolName: SHELL,
        cause: 'ordinary',
        command: 'pwd',
        classifierAvailable: false,
      })
    ).toEqual({ kind: 'card', cell: 'A3', scope: 'exact_invocation', shellCard: true })
  })

  it('a verdict is ignored unless the second read is still A3', () => {
    expect(
      decide({
        mode: 'manual',
        toolName: SHELL,
        cause: 'ordinary',
        verdict: 'APPROVE',
        classifierAvailable: true,
      })
    ).toEqual({ kind: 'card', cell: 'M1', scope: 'as_produced' })
    expect(
      decide({
        mode: 'auto',
        toolName: SHELL,
        cause: 'admin_forced',
        verdict: 'APPROVE',
        wholeTool: true,
        classifierAvailable: true,
      })
    ).toEqual({ kind: 'card', cell: 'A5', scope: 'exact_invocation' })
    expect(
      decide({
        mode: 'allow_all',
        toolName: SHELL,
        cause: 'ordinary',
        verdict: 'ESCALATE',
        classifierAvailable: true,
      })
    ).toEqual({ kind: 'run', cell: 'X1' })
  })

  it.each(NON_CRON.flatMap(toolName => A5_CAUSES.map(cause => ({ toolName, cause }))))(
    'A5 $toolName $cause is an exact card with no shell shortcut',
    ({ toolName, cause }) => {
      expect(
        decide({
          mode: 'auto',
          toolName,
          cause,
          wholeTool: true,
          task: [toolName],
          always: [toolName],
          verdict: 'APPROVE',
          classifierAvailable: true,
          command: 'ls',
          commands: ['ls'],
        })
      ).toEqual({ kind: 'card', cell: 'A5', scope: 'exact_invocation' })
    }
  )

  it.each(['browser_open', 'workflow_trigger', 'acme__search'])(
    'A6 cards ordinary %s exactly, even with an Always grant',
    toolName => {
      expect(
        decide({ mode: 'auto', toolName, cause: 'ordinary', always: [toolName], task: [toolName] })
      ).toEqual({ kind: 'card', cell: 'A6', scope: 'exact_invocation' })
    }
  )

  it.each(NON_CRON.flatMap(toolName => X1_CAUSES.map(cause => ({ toolName, cause }))))(
    'X1 $toolName $cause runs in allow-all',
    ({ toolName, cause }) => {
      expect(
        decide({
          mode: 'allow_all',
          toolName,
          cause,
          classifierAvailable: false,
          verdict: 'ESCALATE',
          wholeTool: true,
        })
      ).toEqual({ kind: 'run', cell: 'X1' })
    }
  )

  it.each(NON_CRON)(
    'X2 %s guardrail_ask is an exact card in allow-all, even with every grant',
    toolName => {
      expect(
        decide({
          mode: 'allow_all',
          toolName,
          cause: 'guardrail_ask',
          classifierAvailable: true,
          verdict: 'APPROVE',
          wholeTool: true,
          task: [toolName],
          always: [toolName],
          command: 'ls',
          commands: ['ls'],
        })
      ).toEqual({ kind: 'card', cell: 'X2', scope: 'exact_invocation' })
    }
  )
})

describe('decideApproval: git_read', () => {
  const GIT = 'git_read'

  it('auto runs git_read as A9', () => {
    expect(decide({ mode: 'auto', toolName: GIT, cause: 'ordinary' })).toEqual({
      kind: 'run',
      cell: 'A9',
    })
    expect(
      decide({ mode: 'auto', toolName: GIT, cause: 'ordinary', classifierAvailable: true })
    ).toEqual({ kind: 'run', cell: 'A9' })
  })

  it('auto cards git_read as A5 for every exact cause and admin_forced', () => {
    for (const cause of A5_CAUSES) {
      expect(decide({ mode: 'auto', toolName: GIT, cause })).toEqual({
        kind: 'card',
        cell: 'A5',
        scope: 'exact_invocation',
      })
    }
  })

  it('manual cards git_read as M1 as_produced', () => {
    expect(decide({ mode: 'manual', toolName: GIT, cause: 'ordinary' })).toEqual({
      kind: 'card',
      cell: 'M1',
      scope: 'as_produced',
    })
  })

  it('a task shell_exec grant runs git_read in manual', () => {
    for (const cause of ['ordinary', 'admin_forced'] as const) {
      expect(decide({ mode: 'manual', toolName: GIT, cause, task: [SHELL] })).toEqual({
        kind: 'run',
        cell: 'M1',
      })
    }
  })

  it('an always shell_exec grant runs git_read in manual', () => {
    expect(decide({ mode: 'manual', toolName: GIT, cause: 'ordinary', always: [SHELL] })).toEqual({
      kind: 'run',
      cell: 'M1',
    })
  })

  it('only a shell_exec grant covers git_read: http_request and file_read grants do not', () => {
    expect(GRANT_COVERED_BY).toEqual({ git_read: ['shell_exec'] })
    for (const name of [HTTP, 'file_read', 'json_transform']) {
      expect(
        decide({
          mode: 'manual',
          toolName: 'git_read',
          cause: 'ordinary',
          task: [name],
          always: [name],
        })
      ).toEqual({ kind: 'card', cell: 'M1', scope: 'as_produced' })
    }
  })

  it('a git_read grant does not run shell_exec', () => {
    expect(
      decide({ mode: 'manual', toolName: SHELL, cause: 'ordinary', task: [GIT], always: [GIT] })
    ).toEqual({ kind: 'card', cell: 'M1', scope: 'as_produced' })
  })

  it('a shell_exec grant does not cover git_read under guardrail_ask or denied', () => {
    for (const cause of ['guardrail_ask', 'denied'] as const) {
      expect(
        decide({ mode: 'manual', toolName: GIT, cause, task: [SHELL], always: [SHELL, GIT] })
      ).toEqual({ kind: 'card', cell: 'M2', scope: 'exact_invocation' })
    }
  })

  it('allow_all runs git_read as X1 and cards a guardrail ask as X2', () => {
    expect(decide({ mode: 'allow_all', toolName: GIT, cause: 'ordinary' })).toEqual({
      kind: 'run',
      cell: 'X1',
    })
    expect(decide({ mode: 'allow_all', toolName: GIT, cause: 'guardrail_ask' })).toEqual({
      kind: 'card',
      cell: 'X2',
      scope: 'exact_invocation',
    })
  })

  it('a CRD false (cause none) runs git_read as N1 in every mode', () => {
    for (const mode of MODES) {
      expect(decide({ mode, toolName: GIT, cause: 'none' })).toEqual({ kind: 'run', cell: 'N1' })
    }
  })
})

describe('shellCardDescriptor', () => {
  it('offers the desktop command only when the preview is neither redacted nor truncated', () => {
    expect(shellCardDescriptor({ command: 'ls' }, { truncated: false, redacted: false })).toEqual({
      channelCommandOffered: true,
      desktopCommandOffered: true,
    })
    expect(shellCardDescriptor({ command: 'ls' }, { truncated: false, redacted: true })).toEqual({
      channelCommandOffered: true,
      desktopCommandOffered: false,
    })
    expect(shellCardDescriptor({ command: 'ls' }, { truncated: true, redacted: false })).toEqual({
      channelCommandOffered: true,
      desktopCommandOffered: false,
    })
  })

  it('drops the channel command at 201 characters of parameters', () => {
    const over = parametersOfJsonLength(201)
    const fit = parametersOfJsonLength(200)
    expect(approvalParametersWithinNotificationLimit(over)).toBe(false)
    expect(approvalParametersWithinNotificationLimit(fit)).toBe(true)
    expect(
      shellCardDescriptor(over, { truncated: false, redacted: false }).channelCommandOffered
    ).toBe(false)
    expect(
      shellCardDescriptor(fit, { truncated: false, redacted: false }).channelCommandOffered
    ).toBe(true)
  })

  it('keeps shellCard on the suspension allowlist', () => {
    const approval: PendingApproval = {
      request_id: 'req-shell',
      tool_name: SHELL,
      tool_call_id: 'tc-shell',
      description: 'run ls',
      parameters: { command: 'ls' },
      context_snapshot: [],
      shellCard: { channelCommandOffered: true, desktopCommandOffered: false },
    }
    const projected = projectGfsApproval(approval)
    expect(projected.shellCard).toEqual(approval.shellCard)
    expect(projectGfsApproval(projected)).toEqual(projected)
  })
})
