'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'

export default function CodexSubscriptionProviderPage() {
  const router = useRouter()
  useEffect(() => {
    router.replace(CONTROL_ROUTES.agents.root)
  }, [router])
  return null
}
