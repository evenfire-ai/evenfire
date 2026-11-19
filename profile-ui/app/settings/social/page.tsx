import { redirect } from 'next/navigation'
import { PROFILE_ROUTES } from '@constants/routes'

// Preserve bookmarks and links already delivered by other applications.
export default function LegacySocialPage() {
  redirect(PROFILE_ROUTES.channels.root)
}
