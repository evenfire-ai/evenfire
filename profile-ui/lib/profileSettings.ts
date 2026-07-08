import type {
  ProfileChannelDraft,
  ProfileChannelKey,
  ProfileChannelRow,
} from '../app/settings/types'
import type { WorkflowApprovalMediumAccount } from '../app/types/approvalChannels'
import type { Channels } from '../app/types/profile'

export const PROFILE_CHANNEL_KEYS: ProfileChannelKey[] = [
  'emails',
  'telegramHandles',
  'telegramIds',
  'slackUserNames',
  'discordUserNames',
  'whatsappNumbers',
]

export const EMPTY_PROFILE_CHANNELS: Channels = {
  emails: [],
  telegramHandles: [],
  slackUserNames: [],
  telegramIds: [],
  discordUserNames: [],
  whatsappNumbers: [],
}

function defaultRowId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `row-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function uniqueTrimmed(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of values) {
    const value = String(raw).trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function normalizeTelegramHandle(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  return value.startsWith('@') ? value : `@${value}`
}

function uniqueProfileChannelValues(key: ProfileChannelKey, values: unknown): string[] {
  const normalized =
    key === 'telegramHandles' && Array.isArray(values)
      ? values.map(value => normalizeTelegramHandle(String(value)))
      : values
  return uniqueTrimmed(normalized)
}

export function verifiedTelegramProfileValues(
  accounts: Array<
    Pick<
      WorkflowApprovalMediumAccount,
      'medium' | 'providerUserId' | 'providerChannelId' | 'disabledAt'
    >
  >
): { userIds: string[]; chatIds: string[] } {
  const telegramAccounts = accounts.filter(
    account => account.medium === 'telegram' && !account.disabledAt
  )
  return {
    userIds: uniqueTrimmed(telegramAccounts.map(account => account.providerUserId)),
    chatIds: uniqueTrimmed(telegramAccounts.map(account => account.providerChannelId)),
  }
}

export function normalizeProfileChannels(input: unknown): Channels {
  if (!input || typeof input !== 'object') return { ...EMPTY_PROFILE_CHANNELS }
  const value = input as Partial<Channels>
  return {
    emails: uniqueTrimmed(value.emails),
    telegramHandles: uniqueProfileChannelValues('telegramHandles', value.telegramHandles),
    slackUserNames: uniqueTrimmed(value.slackUserNames),
    telegramIds: uniqueTrimmed(value.telegramIds),
    discordUserNames: uniqueTrimmed(value.discordUserNames),
    whatsappNumbers: uniqueTrimmed(value.whatsappNumbers),
  }
}

export function createProfileChannelRow(value = '', idFactory = defaultRowId): ProfileChannelRow {
  return { id: idFactory(), value }
}

export function channelsToDraft(
  channelsInput: unknown,
  idFactory = defaultRowId
): ProfileChannelDraft {
  const channels = normalizeProfileChannels(channelsInput)
  return PROFILE_CHANNEL_KEYS.reduce((draft, key) => {
    draft[key] = channels[key].map(value => createProfileChannelRow(value, idFactory))
    return draft
  }, {} as ProfileChannelDraft)
}

export function draftToChannels(draft: ProfileChannelDraft): Channels {
  return PROFILE_CHANNEL_KEYS.reduce(
    (channels, key) => {
      channels[key] = uniqueProfileChannelValues(
        key,
        draft[key].map(row => row.value)
      )
      return channels
    },
    { ...EMPTY_PROFILE_CHANNELS }
  )
}

export function addDraftRow(
  draft: ProfileChannelDraft,
  key: ProfileChannelKey,
  idFactory = defaultRowId
): ProfileChannelDraft {
  return { ...draft, [key]: [...draft[key], createProfileChannelRow('', idFactory)] }
}

export function updateDraftRow(
  draft: ProfileChannelDraft,
  key: ProfileChannelKey,
  rowId: string,
  value: string
): ProfileChannelDraft {
  return {
    ...draft,
    [key]: draft[key].map(row => (row.id === rowId ? { ...row, value } : row)),
  }
}

export function removeDraftRow(
  draft: ProfileChannelDraft,
  key: ProfileChannelKey,
  rowId: string
): ProfileChannelDraft {
  return { ...draft, [key]: draft[key].filter(row => row.id !== rowId) }
}

export function appendDraftValue(
  draft: ProfileChannelDraft,
  key: ProfileChannelKey,
  rawValue: string,
  idFactory = defaultRowId
): ProfileChannelDraft {
  const value = key === 'telegramHandles' ? normalizeTelegramHandle(rawValue) : rawValue.trim()
  if (!value || draft[key].some(row => row.value.trim() === value)) return draft
  return { ...draft, [key]: [...draft[key], createProfileChannelRow(value, idFactory)] }
}
