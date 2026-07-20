import { notFound } from 'next/navigation'
import {
  WORKFLOW_RECIPE_DETAIL_TABS,
  type WorkflowRecipeDetailTab,
} from '@constants/workflowRecipeDetails'
import WorkflowRecipeDetailPage from '../page'

interface WorkflowRecipeTabPageProps {
  params: Promise<{ tab: string }>
}

export default async function WorkflowRecipeTabPage({ params }: WorkflowRecipeTabPageProps) {
  const { tab } = await params
  if (!WORKFLOW_RECIPE_DETAIL_TABS.includes(tab as WorkflowRecipeDetailTab)) {
    notFound()
  }

  return <WorkflowRecipeDetailPage />
}
