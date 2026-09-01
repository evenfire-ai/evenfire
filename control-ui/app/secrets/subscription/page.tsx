import { redirect } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'

export default function LegacySubscriptionSecretsPage() {
  redirect(CONTROL_ROUTES.secrets.llmSubscriptions)
}
