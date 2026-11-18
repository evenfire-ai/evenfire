import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ApprovalChannelTarget } from '@/app/types/approvalChannels'
import { TelegramVerificationPanel } from '../../channels/TelegramVerificationPanel'

vi.mock('@components/Toast', () => ({ useToast: () => ({ showToast: vi.fn() }) }))
afterEach(cleanup)

describe('Teams channel table', () => {
  it('labels every data column', () => {
    const target: ApprovalChannelTarget = {
      id: 'teams-target',
      medium: 'teams',
      agentName: 'agent-a',
      channelName: 'approvals',
      channelNamespace: 'channels',
      botLabel: 'Approvals bot',
      botUsername: null,
      botDeepLink: null,
      status: 'ready',
    }
    render(
      <TelegramVerificationPanel
        medium="teams"
        accounts={[]}
        targets={[target]}
        disabled={false}
        onAccountsRefresh={async () => []}
        onRemoveAccount={() => {}}
      />
    )
    for (const name of ['Name', 'Chat type', 'Bot handle', 'Status']) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument()
    }
  })
})
