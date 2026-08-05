import React from 'react'
import type { Metadata } from 'next'
import '@uiw/react-markdown-preview/markdown.css'
import '@uiw/react-md-editor/markdown-editor.css'
import { AdminBridgeAlerts } from '../components/AdminBridgeAlerts'
import { AuthProvider } from '../components/AuthContext'
import { ControlAppFrame } from '../components/ControlAppFrame'
import { ThemeProvider } from '../components/ThemeContext'
import { ToastProvider } from '../components/Toast'
import './globals.css'

export const metadata: Metadata = {
  title: 'Evenfire Control UI',
  description: 'Internal dashboard for Evenfire resource management',
  icons: {
    icon: '/brand/logo.svg',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="cu-body">
        <ThemeProvider>
          <ToastProvider>
            <AuthProvider>
              <AdminBridgeAlerts />
              <ControlAppFrame>{children}</ControlAppFrame>
            </AuthProvider>
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
