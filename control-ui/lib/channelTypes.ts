/**
 * Canonical CommunicationChannel transport union. Mirrors the server-side
 * CRD schema (`spec.telegram | .email | .slack | .teams`) and channel-reader's
 * adapter set. Every component-level `types.ts` that previously declared
 * this union must re-export from here so there is a single source of truth.
 */
export type ChannelType = 'telegram' | 'email' | 'slack' | 'teams'

/** Stable iteration order for UI lists (tabs, dropdowns). */
export const CHANNEL_TYPES: readonly ChannelType[] = [
  'telegram',
  'email',
  'slack',
  'teams',
] as const
