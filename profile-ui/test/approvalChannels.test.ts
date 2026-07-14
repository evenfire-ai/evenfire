import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  ApprovalChannelTarget,
  WorkflowApprovalMediumAccount,
} from '../app/types/approvalChannels'
import {
  activeApprovalAccounts,
  approvalAccountAssociationLabel,
  approvalAccountBotLabel,
  approvalAccountChannelName,
  approvalAccountConversationTypeLabel,
  approvalAccountDetailLabels,
  approvalAccountDisplayName,
  approvalAccountStatusLabel,
  autoSelectedTargetId,
  challengeCountdownLabel,
  challengeExpirationLabel,
  challengeRemainingSeconds,
  preferredAccountOptionLabel,
  slackVerificationCommand,
  targetDisplayName,
  telegramVerificationCommand,
} from '../lib/approvalChannels'

const target: ApprovalChannelTarget = {
  id: 'telegram:target',
  medium: 'telegram',
  agentName: 'chatllm',
  channelName: 'chatllm-telegram',
  channelNamespace: 'channels',
  botLabel: '@clerum_bot',
  botUsername: 'clerum_bot',
  botDeepLink: 'https://t.me/clerum_bot',
  status: 'ready',
}

test('targetDisplayName uses the communication channel name', () => {
  assert.equal(targetDisplayName(target), 'chatllm-telegram')
})

test('autoSelectedTargetId selects only when a single target exists', () => {
  assert.equal(autoSelectedTargetId([]), '')
  assert.equal(autoSelectedTargetId([target]), 'telegram:target')
  assert.equal(autoSelectedTargetId([target, { ...target, id: 'telegram:other' }]), '')
})

test('approvalAccountDisplayName prefers the communication channel name', () => {
  const account: WorkflowApprovalMediumAccount = {
    id: 'account-1',
    userId: 'user-1',
    medium: 'telegram',
    providerUserId: '123456789',
    providerWorkspaceId: null,
    providerChannelId: '987654321',
    targets: [target],
  }

  assert.equal(approvalAccountDisplayName(account), 'chatllm-telegram')
  assert.equal(approvalAccountChannelName(account), 'chatllm-telegram')
  assert.equal(approvalAccountConversationTypeLabel(account), 'Telegram chat')
  assert.equal(approvalAccountBotLabel(account), '@clerum_bot')
  assert.deepEqual(approvalAccountDetailLabels(account), [
    'Telegram',
    'Telegram chat',
    '@clerum_bot',
  ])
})

test('approval account helpers expose disconnected state without targets', () => {
  const account: WorkflowApprovalMediumAccount = {
    id: 'account-1',
    userId: 'user-1',
    medium: 'telegram',
    providerUserId: '123456789',
    providerWorkspaceId: null,
    providerChannelId: '987654321',
    disabledAt: '2026-06-05T18:00:00.000Z',
    targets: [target],
  }

  assert.equal(approvalAccountStatusLabel(account), 'Disconnected')
  assert.equal(approvalAccountAssociationLabel(account), 'Disconnected verification record')
})

test('approval account helpers expose active target associations', () => {
  const account: WorkflowApprovalMediumAccount = {
    id: 'account-1',
    userId: 'user-1',
    medium: 'telegram',
    providerUserId: '123456789',
    providerWorkspaceId: null,
    providerChannelId: '987654321',
    targets: [target],
  }

  assert.equal(approvalAccountStatusLabel(account), 'Verified')
  assert.equal(approvalAccountAssociationLabel(account), 'Telegram · Agent chatllm · @clerum_bot')
})

test('telegramVerificationCommand renders only when the challenge includes a code', () => {
  assert.equal(telegramVerificationCommand({ code: '123456' }), '/verify 123456')
  assert.equal(telegramVerificationCommand({}), null)
})

test('slackVerificationCommand avoids Slack slash command interception', () => {
  assert.equal(slackVerificationCommand({ nonce: '123456' }), 'verify 123456')
  assert.equal(slackVerificationCommand({ nonce: '' }), null)
})

test('activeApprovalAccounts excludes disabled accounts', () => {
  const active: WorkflowApprovalMediumAccount = {
    id: 'active-1',
    userId: 'user-1',
    medium: 'telegram',
    providerUserId: '123456789',
    providerWorkspaceId: null,
    providerChannelId: '987654321',
  }
  const disabled: WorkflowApprovalMediumAccount = {
    ...active,
    id: 'disabled-1',
    disabledAt: '2026-06-05T18:00:00.000Z',
  }

  assert.deepEqual(activeApprovalAccounts([active, disabled]), [active])
})

test('preferredAccountOptionLabel renders medium with a channel hint', () => {
  const telegram: WorkflowApprovalMediumAccount = {
    id: 'tg-1',
    userId: 'user-1',
    medium: 'telegram',
    providerUserId: '123456789',
    providerWorkspaceId: null,
    providerChannelId: '987654321',
  }
  const slackWithChannel: WorkflowApprovalMediumAccount = {
    id: 'sl-1',
    userId: 'user-1',
    medium: 'slack',
    providerUserId: 'U123',
    providerWorkspaceId: 'T123',
    providerChannelId: 'C456',
  }
  const slackUserOnly: WorkflowApprovalMediumAccount = {
    ...slackWithChannel,
    id: 'sl-2',
    providerChannelId: null,
  }
  const telegramNoChannel: WorkflowApprovalMediumAccount = {
    ...telegram,
    id: 'tg-2',
    providerChannelId: null,
  }

  assert.equal(
    preferredAccountOptionLabel(telegram),
    'Telegram conversation · Telegram · Telegram chat · Bot handle unavailable'
  )
  assert.equal(
    preferredAccountOptionLabel(telegramNoChannel),
    'Telegram conversation · Telegram · Telegram chat · Bot handle unavailable'
  )
  assert.equal(
    preferredAccountOptionLabel(slackWithChannel),
    'C456 · Slack · Slack conversation · Slack App unavailable'
  )
  assert.equal(
    preferredAccountOptionLabel(slackUserOnly),
    'Slack conversation · Slack · Slack App unavailable'
  )
})

test('challengeExpirationLabel exposes the challenge expiration', () => {
  assert.equal(
    challengeExpirationLabel({ expiresAt: '2026-06-03T10:30:00.000Z' }),
    'Expires at 2026-06-03T10:30:00.000Z'
  )
  assert.equal(challengeExpirationLabel({ expiresAt: '' }), 'Expiration unavailable')
})

test('challenge countdown rounds up and stops at zero', () => {
  const now = Date.parse('2026-06-03T10:30:00.000Z')

  assert.equal(challengeRemainingSeconds('2026-06-03T10:30:01.001Z', now), 2)
  assert.equal(challengeRemainingSeconds('2026-06-03T10:30:00.000Z', now), 0)
  assert.equal(challengeRemainingSeconds('invalid', now), 0)
  assert.equal(challengeCountdownLabel(125), '02:05')
  assert.equal(challengeCountdownLabel(0), '00:00')
})

// ── Preferred delivery account lifecycle (pure helpers) ──
//
// These mirror the four E2E lifecycle scenarios at the pure-helper level so the
// picker's option set (activeApprovalAccounts) and option label
// (preferredAccountOptionLabel) stay correct as accounts are enabled/disabled.

function telegramAccount(
  id: string,
  providerUserId: string,
  providerChannelId: string | null,
  overrides: Partial<WorkflowApprovalMediumAccount> = {}
): WorkflowApprovalMediumAccount {
  return {
    id,
    userId: 'user-1',
    medium: 'telegram',
    providerUserId,
    providerWorkspaceId: null,
    providerChannelId,
    ...overrides,
  }
}

test('lifecycle: one Telegram account stays selectable (scenario 1)', () => {
  const accountA = telegramAccount('tg-a', '424242', '424242')

  const active = activeApprovalAccounts([accountA])
  assert.deepEqual(active, [accountA])
  assert.equal(active.length, 1)
  assert.equal(
    preferredAccountOptionLabel(accountA),
    'Telegram conversation · Telegram · Telegram chat · Bot handle unavailable'
  )
})

test('lifecycle: two Telegram accounts both selectable (scenario 2)', () => {
  const accountA = telegramAccount('tg-a', '424242', '424242')
  const accountB = telegramAccount('tg-b', '424243', '424243')

  const active = activeApprovalAccounts([accountA, accountB])
  assert.deepEqual(active, [accountA, accountB])
  assert.equal(active.length, 2)
  assert.deepEqual(active.map(preferredAccountOptionLabel), [
    'Telegram conversation · Telegram · Telegram chat · Bot handle unavailable',
    'Telegram conversation · Telegram · Telegram chat · Bot handle unavailable',
  ])
})

test('lifecycle: disabling one of two accounts narrows the picker to one (scenario 3)', () => {
  const accountA = telegramAccount('tg-a', '424242', '424242', {
    disabledAt: '2026-06-05T18:00:00.000Z',
  })
  const accountB = telegramAccount('tg-b', '424243', '424243')

  const active = activeApprovalAccounts([accountA, accountB])
  assert.deepEqual(active, [accountB])
  assert.equal(active.length, 1)
  assert.deepEqual(
    active.map(account => account.id),
    ['tg-b']
  )
  // The disabled account A must no longer appear as a pickable option.
  assert.ok(!active.some(account => account.id === 'tg-a'))
})

test('lifecycle: disabling both accounts empties the picker (scenario 4)', () => {
  const accountA = telegramAccount('tg-a', '424242', '424242', {
    disabledAt: '2026-06-05T18:00:00.000Z',
  })
  const accountB = telegramAccount('tg-b', '424243', '424243', {
    disabledAt: '2026-06-05T18:05:00.000Z',
  })

  const active = activeApprovalAccounts([accountA, accountB])
  assert.deepEqual(active, [])
  assert.equal(active.length, 0)
})

test('lifecycle: preferredAccountOptionLabel handles telegram with and without a channel id', () => {
  const withChannel = telegramAccount('tg-a', '424242', '424242')
  const withoutChannel = telegramAccount('tg-b', '424243', null)

  assert.equal(
    preferredAccountOptionLabel(withChannel),
    'Telegram conversation · Telegram · Telegram chat · Bot handle unavailable'
  )
  assert.equal(
    preferredAccountOptionLabel(withoutChannel),
    'Telegram conversation · Telegram · Telegram chat · Bot handle unavailable'
  )
})
