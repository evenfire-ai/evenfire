import { redirect } from 'next/navigation'
import { PROFILE_ROUTES } from '@constants/routes'

export default function ApprovalChannelsPage() {
  redirect(PROFILE_ROUTES.settings.approvalChannels)
}
