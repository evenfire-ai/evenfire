import React from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './components/ArtifactsBadge.css'
import './components/ProgressStepper.css'
import { AgentTaskTrackerProvider } from './contexts/AgentTaskTrackerContext'
import { desktopQueryClient } from './lib/queryClient'
import './styles.css'
import './styles/tokens.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={desktopQueryClient}>
      <AgentTaskTrackerProvider>
        <App />
      </AgentTaskTrackerProvider>
    </QueryClientProvider>
  </React.StrictMode>
)
