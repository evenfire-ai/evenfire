import { redirect } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'

export default function ProfileAdminPage() {
  redirect(CONTROL_ROUTES.usersAndTeams.users)
}
