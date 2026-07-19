import { redirect } from 'next/navigation'
import { PROFILE_ROUTES } from '@constants/routes'

export default function SettingsPage() {
  redirect(PROFILE_ROUTES.settings.profile)
}
