import { AuthGate } from '@components/AuthGate'
import { ApprovalChannelsContent } from '../ApprovalChannelsContent'

export default function ApprovalChannelsSettingsPage() {
  return (
    <AuthGate>
      <ApprovalChannelsContent />
    </AuthGate>
  )
}
