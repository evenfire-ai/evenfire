import { AuthGate } from '@components/AuthGate'
import { SettingsContent } from '../SettingsContent'

export default function ProfileSettingsPage() {
  return (
    <AuthGate>
      <SettingsContent />
    </AuthGate>
  )
}
