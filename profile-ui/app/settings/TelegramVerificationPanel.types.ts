import type {
  ApprovalChannelTarget,
  WorkflowApprovalMediumAccount,
} from '@/app/types/approvalChannels'

export type TelegramVerificationPanelProps = {
  medium?: 'telegram' | 'slack' | 'teams'
  targets: ApprovalChannelTarget[]
  accounts: WorkflowApprovalMediumAccount[]
  disabled: boolean
  onAccountsRefresh: () => Promise<WorkflowApprovalMediumAccount[]>
  onRemoveAccount: (accountId: string, isDisconnected: boolean) => void
}
