import { AuthGate } from '@components/AuthGate'
import { DesktopSetupPanel } from '@components/DesktopSetupPanel'

export default function DesktopSetupPage() {
  return (
    <AuthGate returnTo="desktop-setup">
      <DesktopSetupPanel />
    </AuthGate>
  )
}
