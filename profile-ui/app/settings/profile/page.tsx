import { AuthGate } from '@components/AuthGate'
import { SettingsContent } from '../SettingsContent'

export default function ProfileSettingsPage() {
  return (
    <AuthGate>
      <SettingsContent activeSettingsTab="profile" activeSocialTab="telegram" />
    </AuthGate>
  )
}
