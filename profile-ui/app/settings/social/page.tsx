import { AuthGate } from '@components/AuthGate'
import { SettingsContent } from '../SettingsContent'

export default function SocialSettingsPage() {
  return (
    <AuthGate>
      <SettingsContent activeSettingsTab="social" activeSocialTab="telegram" />
    </AuthGate>
  )
}
