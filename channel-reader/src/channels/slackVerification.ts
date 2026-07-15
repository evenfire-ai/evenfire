import type { ProviderTargetIdentity } from '../types'

export type SlackVerificationClient = {
  confirmSlackLinkSession(params: {
    nonce: string
    providerUserId: string
    providerWorkspaceId: string
    providerChannelId: string
    providerChannelType?: string | null
    providerChannelTitle?: string | null
    providerTarget: ProviderTargetIdentity
  }): Promise<{ ok: true; account?: unknown } | { ok: false; error: string }>
}

const SLACK_APP_MENTION_RE = String.raw`(?:<@[A-Z0-9]+>\s*)?`
const VERIFY_COMMAND_RE = new RegExp(`^${SLACK_APP_MENTION_RE}/?verify(?:\\s+(\\d{6}))?\\s*$`, 'i')
const VERIFY_PREFIX_RE = new RegExp(`^${SLACK_APP_MENTION_RE}/?verify(?:\\s|$)`, 'i')

export function isSlackVerifyCommand(text: string): boolean {
  return VERIFY_PREFIX_RE.test(text.trim())
}

export function parseSlackVerifyCommand(text: string): string | null {
  const match = text.trim().match(VERIFY_COMMAND_RE)
  return match?.[1] ?? null
}

export function redactSlackVerificationText(text: string): string {
  return isSlackVerifyCommand(text) ? 'verify [redacted]' : text
}

export async function handleSlackVerificationCommand(params: {
  channelId: string
  nonce: string | null
  providerUserId: string | null
  providerWorkspaceId: string | null
  providerChannelType?: string | null
  providerChannelTitle?: string | null
  providerTarget: ProviderTargetIdentity | null
  verificationClient: SlackVerificationClient | null
  sendReply: (content: string) => Promise<void>
}): Promise<boolean> {
  if (!params.channelId) return false
  if (!params.nonce) {
    await params.sendReply('Send verify followed by your setup code.')
    return false
  }
  if (!params.providerUserId || !params.providerWorkspaceId) {
    await params.sendReply(
      'Slack verification failed. Check that the code is active and try again.'
    )
    return false
  }
  if (!params.providerTarget || !params.verificationClient) {
    await params.sendReply('Slack verification is not available.')
    return false
  }

  try {
    const result = await params.verificationClient.confirmSlackLinkSession({
      nonce: params.nonce,
      providerUserId: params.providerUserId,
      providerWorkspaceId: params.providerWorkspaceId,
      providerChannelId: params.channelId,
      providerChannelType: params.providerChannelType ?? null,
      providerChannelTitle: params.providerChannelTitle ?? null,
      providerTarget: params.providerTarget,
    })
    await params.sendReply(
      result.ok
        ? 'Slack identity confirmed.'
        : 'Slack verification failed. Check that the code is active and try again.'
    )
    return result.ok
  } catch (err) {
    console.warn(
      '[Slack] Verification link-session confirmation failed:',
      err instanceof Error ? err.message : err
    )
    await params.sendReply(
      'Slack verification failed. Check that the code is active and try again.'
    )
    return false
  }
}
