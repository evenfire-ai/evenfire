'use client'

import { useEffect, useState } from 'react'
import {
  formatReleaseLabel,
  loadReleaseIdentity,
  readCachedReleaseIdentity,
} from '@lib/releaseIdentity'
import type { ReleaseIdentityState, ReleaseLabelProps } from './types'

// The platform release the tenant is running, read from external-rest-api's
// release manifest. This is deliberately NOT profile-ui's package version: that
// number is a per-commit counter (scripts/precommit/bump-staged-package-versions.mjs)
// and is not a release coordinate, so it can never be matched to a tag, a
// release, or a docs page.
export function useReleaseIdentity(): ReleaseIdentityState {
  const cached = readCachedReleaseIdentity()
  const [releaseId, setReleaseId] = useState<string | null>(cached?.releaseId ?? null)
  const [loading, setLoading] = useState(!cached)

  useEffect(() => {
    let active = true
    void loadReleaseIdentity().then(identity => {
      if (!active) return
      setReleaseId(identity?.releaseId ?? null)
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [])

  return { releaseId, loading }
}

export function ReleaseLabel({ className }: ReleaseLabelProps) {
  const { releaseId, loading } = useReleaseIdentity()
  return <div className={className}>{formatReleaseLabel(releaseId, loading)}</div>
}
