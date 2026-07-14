import { AuthGate } from '@components/AuthGate'
import { ControlSettingsPanel } from '@components/ControlSettingsPanel'
import { DashboardLayout } from '@components/DashboardLayout'

interface SettingsPageProps {
  searchParams: Promise<{ emailConfirmation?: string }>
}

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const params = await searchParams

  return (
    <AuthGate>
      <DashboardLayout>
        <ControlSettingsPanel emailConfirmationStatus={params.emailConfirmation || null} />
      </DashboardLayout>
    </AuthGate>
  )
}
