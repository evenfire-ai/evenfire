'use client'

import { useEffect, useState } from 'react'
import {
  formatReleaseLabel,
  loadReleaseIdentity,
  readCachedReleaseIdentity,
  subscribeReleaseIdentity,
} from '@lib/releaseIdentity'
import type { ReleaseIdentityState, ReleaseLabelProps } from './types'

// The platform release the tenant is running, read from external-rest-api's
// release manifest. This is deliberately NOT profile-ui's package version: that
// number is a per-commit counter (scripts/precommit/bump-staged-package-versions.mjs)
// and is not a release coordinate, so it can never be matched to a tag, a
// release, or a docs page.
//
// The hook lives here rather than in lib/ because lib/ is React-free, and
// because a hook exported from its component's index.tsx is the established
// shape in this app (useAuth, useToast, useProfileAccess, useConfirmDialog).
export function useReleaseIdentity(): ReleaseIdentityState {
  const cached = readCachedReleaseIdentity()
  const [releaseId, setReleaseId] = useState<string | null>(cached?.releaseId ?? null)
  const [loading, setLoading] = useState(!cached)

  useEffect(() => {
    let active = true
    const apply = (identity: { releaseId: string } | null) => {
      if (!active) return
      setReleaseId(identity?.releaseId ?? null)
      setLoading(false)
    }

    // Subscribe before loading: a read resolved for any other mounted label,
    // or a refresh driven by the settings page, lands on this instance too.
    const unsubscribe = subscribeReleaseIdentity(apply)
    void loadReleaseIdentity().then(apply)

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return { releaseId, loading }
}

export function ReleaseLabel({ className }: ReleaseLabelProps) {
  const { releaseId, loading } = useReleaseIdentity()
  return <div className={className}>{formatReleaseLabel(releaseId, loading)}</div>
}
