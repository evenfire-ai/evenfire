import { ControlSettingsPanel } from '@components/ControlSettingsPanel'

interface SettingsAccountPageProps {
  searchParams: Promise<{ emailConfirmation?: string }>
}

export default async function SettingsAccountPage({ searchParams }: SettingsAccountPageProps) {
  const params = await searchParams

  return (
    <ControlSettingsPanel
      section="account"
      emailConfirmationStatus={params.emailConfirmation || null}
    />
  )
}
