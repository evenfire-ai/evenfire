import type { IdentityFieldConfig, IdentityFieldKey, IdentityFields } from './types'

export const FIELD_MAX_BYTES = 64 * 1024

export const EMPTY_IDENTITY_FIELDS: IdentityFields = {
  agents: '',
  identity: '',
  soul: '',
  user: '',
}

export const IDENTITY_FIELD_ORDER: IdentityFieldKey[] = ['identity', 'soul', 'agents', 'user']

export const IDENTITY_FIELDS: IdentityFieldConfig[] = [
  {
    fileName: 'IDENTITY.md',
    help: "Appears under '## Identity' in the agent's system prompt.",
    key: 'identity',
    label: 'Identity',
    promptHeader: '## Identity',
  },
  {
    fileName: 'SOUL.md',
    help: "Appears under '## Core Values'.",
    key: 'soul',
    label: 'Soul',
    promptHeader: '## Core Values',
  },
  {
    fileName: 'AGENTS.md',
    help: "Appears under '## Agent Instructions'.",
    key: 'agents',
    label: 'Agent instructions',
    promptHeader: '## Agent Instructions',
  },
  {
    fileName: 'USER.md',
    help: "Appears under '## User Context'.",
    key: 'user',
    label: 'User context',
    promptHeader: '## User Context',
  },
]
