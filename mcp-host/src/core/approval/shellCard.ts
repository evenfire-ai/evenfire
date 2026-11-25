import { approvalParametersWithinNotificationLimit } from '../../agent/approvalNotificationLimit'
import type { PendingApproval } from '../types'
import type { ApprovalMode } from './approvalMode'

export interface ShellCardDescriptor {
  channelCommandOffered: boolean
  desktopCommandOffered: boolean
}

export type ShellAction = 'once' | 'command' | 'shell'

/**
 * Shell-card answers. Null means the boolean path applies. Anything else is
 * the action that may store shell memory: `once` stores nothing.
 */
export function resolveShellAnswer(
  pending: Pick<PendingApproval, 'shellCard' | 'tool_name'>,
  answer: {
    shellAction?: ShellAction
    alwaysApprove: boolean
    effectiveMode: ApprovalMode
    surface: 'desktop' | 'channel'
  }
): ShellAction | null {
  if (!pending.shellCard || pending.tool_name !== 'shell_exec') return null
  if (answer.alwaysApprove) return 'once'
  if (answer.effectiveMode !== 'auto' || answer.shellAction === undefined) return 'once'
  if (answer.shellAction === 'command') {
    const offered =
      answer.surface === 'desktop'
        ? pending.shellCard.desktopCommandOffered
        : pending.shellCard.channelCommandOffered
    if (!offered) return 'once'
  }
  return answer.shellAction
}

/** Server projection of the shell card's command buttons. */
export function shellCardDescriptor(
  params: Record<string, unknown>,
  preview: { truncated: boolean; redacted: boolean }
): ShellCardDescriptor {
  return {
    channelCommandOffered: approvalParametersWithinNotificationLimit(params),
    desktopCommandOffered: !preview.truncated && !preview.redacted,
  }
}
