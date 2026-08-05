import './globals.css'
import { ProfileNotFoundContent } from './not-found'

export default function GlobalNotFound() {
  return (
    <html lang="en" data-theme="dark">
      <body className="cu-body">
        <main className="cu-app cu-app--auth cu-not-found">
          <ProfileNotFoundContent />
        </main>
      </body>
    </html>
  )
}
