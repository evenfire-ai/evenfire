import { redirect } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'

export default function PublisherApiKeysPage() {
  redirect(CONTROL_ROUTES.marketplace.keys)
}
