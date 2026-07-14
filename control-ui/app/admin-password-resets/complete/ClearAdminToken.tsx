'use client'

import { useEffect } from 'react'
import { clearAdminAuthToken } from '@lib/api'

export function ClearAdminToken() {
  useEffect(() => {
    clearAdminAuthToken()
  }, [])

  return null
}
