import { approvalParametersWithinNotificationLimit } from '../../agent/approvalNotificationLimit'

export interface ShellCardDescriptor {
  channelCommandOffered: boolean
  desktopCommandOffered: boolean
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
