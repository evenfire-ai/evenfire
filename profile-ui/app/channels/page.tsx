import { redirect } from 'next/navigation'
import { PROFILE_ROUTES } from '@constants/routes'

export default function ChannelsPage() {
  redirect(PROFILE_ROUTES.channels.channel('telegram'))
}
