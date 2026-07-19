import Link from 'next/link'
import { CONTROL_ROUTES } from '@constants/routes'
import type { SessionDecisionActorProps } from './types'

export function SessionDecisionActor({ actorSub, fallback, human }: SessionDecisionActorProps) {
  if (!actorSub) return fallback

  const matchesSessionHuman = actorSub === human.subject || actorSub === human.userId
  if (!matchesSessionHuman || !human.userId) return actorSub

  const label = human.displayName ? `${human.displayName} · ${actorSub}` : actorSub
  return (
    <Link className="cu-trace-link" href={CONTROL_ROUTES.usersAndTeams.user(human.userId)}>
      {label}
    </Link>
  )
}
