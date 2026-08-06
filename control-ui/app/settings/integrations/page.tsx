import { redirect } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'

export default function SettingsIntegrationsPage() {
  redirect(CONTROL_ROUTES.settings.microsoft)
}
