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
    help: 'Who this agent is — name, role, and voice. The agent treats this as its self-description.',
    key: 'identity',
    label: 'Identity',
    placeholder: `# Name: Atrios
# Role: Senior code reviewer
# Voice: Direct, concise, cites file paths

You are Atrios, a senior code reviewer on the Platform team. You read every
file before suggesting a change, and you always quote the path you are
touching.`,
    promptHeader: '## Identity',
  },
  {
    fileName: 'SOUL.md',
    help: 'Non-negotiable values and guardrails. Short bullets the model should never violate.',
    key: 'soul',
    label: 'Soul',
    placeholder: `# Values
- Prefer correctness over speed — never ship a fix you have not verified
- Always cite the file path when changing code
- Never invent API endpoints, env vars, or config keys
- If unsure, ask instead of guessing`,
    promptHeader: '## Core Values',
  },
  {
    fileName: 'AGENTS.md',
    help: 'Standing rules the agent follows on every task — conventions, skills, and review habits.',
    key: 'agents',
    label: 'Agent instructions',
    placeholder: `# Workflow
- Read AGENTS.md and CLAUDE.md before any task
- Use pnpm for installs, never npm or yarn
- Run tests before reporting a task complete

# Code style
- Prefer composition over inheritance
- Keep functions under 40 lines
- No silent catches — log or rethrow`,
    promptHeader: '## Agent Instructions',
  },
  {
    fileName: 'USER.md',
    help: 'Background about who uses this agent — team, environment, conventions — so replies fit the audience.',
    key: 'user',
    label: 'User context',
    placeholder: `# Operating environment
- Team: Platform engineering
- Timezone: America/Mexico_City
- Preferred review style: PR-first, no live deploys

# Communication
- Default to Spanish when writing docs
- Reply in bullet points, not paragraphs`,
    promptHeader: '## User Context',
  },
]
