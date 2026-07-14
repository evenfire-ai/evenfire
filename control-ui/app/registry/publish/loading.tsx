import { CreateFlowLoadingScreen } from '@components/CreateFlowSkeleton'
import { CREATE_FLOW_LOADING } from '@constants/createFlowLoading'

export default function Loading() {
  return <CreateFlowLoadingScreen {...CREATE_FLOW_LOADING.publishRegistryEntry} />
}
