'use client'

import React from 'react'
import { useSelectedLayoutSegments } from 'next/navigation'
import { CostShell } from '@components/CostShell'
import type { CostSegment } from '@components/CostShell/types'

const SECTION_SEGMENTS: readonly CostSegment[] = ['usage', 'llm-prices', 'token-budgets']

export default function CostLayout({ children }: { children: React.ReactNode }) {
  const segments = useSelectedLayoutSegments()
  const [firstSegment] = segments
  const activeSegment = SECTION_SEGMENTS.find(segment => segment === firstSegment)

  // Section-root list pages (/cost/usage, /cost/llm-prices, /cost/token-budgets)
  // share the tab shell. Deeper create/edit routes own their own create shell,
  // so render them untouched.
  if (segments.length > 1 || !activeSegment) {
    return <>{children}</>
  }

  return <CostShell activeSegment={activeSegment}>{children}</CostShell>
}
