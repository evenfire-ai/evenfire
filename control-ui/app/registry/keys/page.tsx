import { redirect } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'

export default function RegistryKeysPage() {
  redirect(CONTROL_ROUTES.publisher.apiKeys)
}
