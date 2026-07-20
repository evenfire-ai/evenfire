import { redirect } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'

export default function PublisherPage() {
  redirect(CONTROL_ROUTES.publisher.entries)
}
