import { redirect } from 'next/navigation'
import { CONTROL_ROUTES } from '@constants/routes'

export default function LlmModelsDiscoveryPage() {
  redirect(CONTROL_ROUTES.llmModels.root)
}
