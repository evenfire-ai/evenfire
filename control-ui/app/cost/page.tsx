import { redirect } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'

export default function CostPage() {
  redirect(CONTROL_ROUTES.costAndUsage.usage)
}
