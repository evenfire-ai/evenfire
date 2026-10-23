import { type ReactNode, useEffect } from 'react'
import { expect } from 'vitest'
import { AgentActivityProvider } from '@contexts/AgentActivityContext'
import { AgentChatProviders } from '@contexts/AgentChatProviders'
import { AgentTaskTrackerProvider } from '@contexts/AgentTaskTrackerContext'
import { AuthContext } from '@contexts/AuthContext'
import { McpRuntimeProvider } from '@contexts/McpRuntimeContext'
import { NavigationContext } from '@contexts/NavigationContext'
import { NotificationsContext } from '@contexts/NotificationsContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { ToastStack } from '@components/Common'
import { buildLoadedChatSemanticModels } from '@lib/chatMessageSemantics'
import { useAgentChatActionsValue } from '../../../useAgentChatActionsValue'
import { useAppController } from '../../../useAppController'

/** Mount the production action adapter and its actual app owner in one render tree. */
export async function renderChatActionConsumer(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let current: ReturnType<typeof useAppController> | undefined
  function Probe() {
    useEffect(() => () => queryClient.clear(), [])
    const vm = useAppController()
    current = vm
    const actions = useAgentChatActionsValue(vm)
    return (
      <AuthContext.Provider value={vm}>
        <NavigationContext.Provider value={vm}>
          <NotificationsContext.Provider value={vm}>
            <AgentActivityProvider value={vm}>
              <McpRuntimeProvider value={vm}>
                <AgentChatProviders
                  actions={actions}
                  chatList={vm}
                  composerState={{
                    ...vm,
                    activeMessageCount: vm.activeMessages.length,
                    composerFocusRequestId: 0,
                    requestComposerFocus: () => undefined,
                  }}
                  threadState={{
                    ...vm,
                    localSearchQuery: '',
                    localSearchCurrentMatch: null,
                    semanticModelsByMessageId: new Map(
                      buildLoadedChatSemanticModels(vm.activeMessages).map(model => [
                        model.messageId,
                        model,
                      ])
                    ),
                  }}
                >
                  {children}
                  <ToastStack items={vm.toasts} />
                </AgentChatProviders>
              </McpRuntimeProvider>
            </AgentActivityProvider>
          </NotificationsContext.Provider>
        </NavigationContext.Provider>
      </AuthContext.Provider>
    )
  }
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <AgentTaskTrackerProvider>
        <Probe />
      </AgentTaskTrackerProvider>
    </QueryClientProvider>
  )
  const getVm = () => {
    if (!current) throw new Error('App controller has not rendered')
    return current
  }
  await waitFor(() => {
    expect(getVm().isAuthenticated).toBe(true)
    expect(getVm().initialExperienceLoading).toBe(false)
  })
  return { ...utils, getVm, queryClient }
}
