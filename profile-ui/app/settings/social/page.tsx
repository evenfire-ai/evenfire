import { redirect } from 'next/navigation'
import { PROFILE_ROUTES } from '@constants/routes'

export default function SocialSettingsPage() {
  redirect(PROFILE_ROUTES.settings.social('telegram'))
}
