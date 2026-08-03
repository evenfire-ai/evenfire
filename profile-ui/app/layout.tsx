import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { AuthProvider } from '@components/AuthContext'
import { ProfileAppFrame } from '@components/ProfileAppFrame'
import { ToastProvider } from '@components/Toast'
import './globals.css'

export const metadata: Metadata = {
  title: 'Evenfire Profile UI',
  description: 'User profile and team membership management',
  icons: {
    icon: '/brand/logo.svg',
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
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
        <ToastProvider>
          <AuthProvider>
            <ProfileAppFrame>{children}</ProfileAppFrame>
          </AuthProvider>
        </ToastProvider>
      </body>
    </html>
  )
}
