import { notFound } from 'next/navigation'
import OutputsPage from '../page'

interface OutputsTabPageProps {
  params: Promise<{ tab: string }>
}

export default async function OutputsTabPage({ params }: OutputsTabPageProps) {
  const { tab } = await params
  if (tab !== 'desktop') notFound()

  return <OutputsPage />
}
