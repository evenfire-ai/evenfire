import { notFound } from 'next/navigation'
import { GUARDRAIL_DETAIL_TABS } from '../../../constants/guardrailDetails'
import GuardrailDetailPage from '../page'

interface GuardrailTabPageProps {
  params: Promise<{ tab: string }>
}

export default async function GuardrailTabPage({ params }: GuardrailTabPageProps) {
  const { tab } = await params
  if (!GUARDRAIL_DETAIL_TABS.some(value => value === tab)) {
    notFound()
  }

  return <GuardrailDetailPage />
}
