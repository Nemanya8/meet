import type { Metadata } from 'next'

import './globals.css'

export const metadata: Metadata = {
  title: 'Meet',
  description: 'Decentralized video conferencing'
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang='en' className='dark'>
      <body className='bg-surface text-foreground antialiased'>{children}</body>
    </html>
  )
}
