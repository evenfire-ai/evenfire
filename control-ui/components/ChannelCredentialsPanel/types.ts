import type { ChannelType } from '../../lib/channelTypes'

export type { ChannelType }

/**
 * Provider credential field shown in the ChannelCredentialsPanel.
 *
 * `key` matches the Secret data key consumed by channel-reader or related
 * provider integration workers.
 * `channelType` lets the panel filter fields by the CC's actually-configured
 * transports — no Slack token input when no Slack row exists on the CC.
 */
export type CredentialField = {
  channelType: ChannelType
  key: keyof CredentialDraft
  label: string
  placeholder?: string
  helpText?: string
}

/**
 * Free-form draft buffer. Keys match the Secret data keys accepted by the
 * per-CC credentials rotation route. Any subset of keys is valid — empty /
 * unset fields are filtered out before the PUT body is built so a partial
 * update (e.g. rotating just the Telegram token) does not clobber Slack or
 * Teams credentials.
 */
export type CredentialDraft = {
  'telegram-bot-token'?: string
  'slack-signing-secret'?: string
  'slack-bot-token'?: string
  'teams-app-password'?: string
  'email-username'?: string
  'email-password'?: string
}

export type ChannelCredentialsPanelProps = {
  /** CommunicationChannel resource name. The Secret is keyed by this value
   *  server-side (`cc-<ccName>-credentials` in the `channels` namespace). */
  ccName: string
  /** When the CC is being newly created (no existing CC yet), set this true
   *  so the panel buffers values via `onPendingChange` instead of calling
   *  the rotation API. The parent posts the buffered creds alongside the
   *  CC create call in the same request (the control-api handler atomically
   *  creates Secret + CC). */
  pending?: boolean
  /** Called whenever the draft changes in `pending` mode. The parent stores
   *  the buffer and forwards it as a `credentials` block on the CC POST. */
  onPendingChange?: (creds: CredentialDraft) => void
  /** Presentation style. Inline removes the panel heading and long storage copy
   *  so create flows can provide their own step labels. */
  presentation?: 'inline' | 'panel'
  /** Optional whitelist of channel types whose credential inputs should render.
   *  - `undefined` → render every credential field (back-compat for callers
   *    that don't track which transports are configured)
   *  - `[]` → render no fields
   *  - `['telegram', 'slack']` → render only those types
   *  When set, draft values for hidden types are pruned so they cannot leak
   *  into the POST body after a user removes the corresponding channel row. */
  visibleChannelTypes?: ChannelType[]
  /** True when the backing Secret exists. Values stay write-only and render masked. */
  hasStoredCredentials?: boolean
  /** Render masked provider fields without rotation/delete controls. */
  readOnly?: boolean
}
