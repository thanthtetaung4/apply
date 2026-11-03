import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Auto Apply',
  description: 'Tailored resumes and job applications, reviewed by you.',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
