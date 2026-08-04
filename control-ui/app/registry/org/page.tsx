import { redirect } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'

export default function MarketplaceOrgPage() {
  redirect(CONTROL_ROUTES.marketplace.orgCredentials)
}
