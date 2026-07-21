'use client'

import React from 'react'
import { useSelectedLayoutSegments } from 'next/navigation'
import { CostShell } from '@components/CostShell'

const SECTION_SEGMENTS = ['usage', 'llm-prices', 'token-budgets'] as const

export default function CostLayout({ children }: { children: React.ReactNode }) {
  const segments = useSelectedLayoutSegments()
  const [firstSegment] = segments
  const isSectionRoot = SECTION_SEGMENTS.some(segment => segment === firstSegment)

  // Section-root list pages (/cost/usage, /cost/llm-prices, /cost/token-budgets)
  // share the auth and dashboard shell. Deeper create/edit routes own their own create shell,
  // so render them untouched.
  if (segments.length > 1 || !isSectionRoot) {
    return <>{children}</>
  }

  return <CostShell>{children}</CostShell>
}
