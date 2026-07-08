import { notFound } from 'next/navigation'
import { type SecretScope, SecretsPageContent } from '../SecretsPageContent'

interface SecretsScopePageProps {
  params: Promise<{ scope: string }>
}

export default async function SecretsScopePage({ params }: SecretsScopePageProps) {
  const { scope } = await params
  if (scope !== 'mcp' && scope !== 'recipe') notFound()

  return <SecretsPageContent activeScope={scope as SecretScope} />
}
