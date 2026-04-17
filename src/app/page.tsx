'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createAccountsProvider } from '@novasamatech/product-sdk'

function generateRoomId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz'
  const generateSegment = () =>
    Array.from({ length: 3 }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('')
  return `${generateSegment()}-${generateSegment()}-${generateSegment()}`
}

const accountsProvider = createAccountsProvider()

export default function Home() {
  const router = useRouter()
  const [displayName, setDisplayName] = useState<string>('')
  const [isReady, setIsReady] = useState(false)
  const [roomCode, setRoomCode] = useState('')

  const handleRoomCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/[^a-zA-Z]/g, '').toLowerCase().slice(0, 9)
    const parts = [raw.slice(0, 3), raw.slice(3, 6), raw.slice(6, 9)].filter(Boolean)
    setRoomCode(parts.join('-'))
  }

  useEffect(() => {
    const init = async () => {
      try {
        const result = await accountsProvider.getNonProductAccounts()
        result.match(
          (accounts) => {
            if (accounts.length > 0) {
              setDisplayName(accounts[0].name || 'User')
            }
          },
          () => {
            setDisplayName('Guest')
          }
        )
      } catch {
        setDisplayName('Guest')
      }
      setIsReady(true)
    }
    init()
  }, [])

  const startMeeting = () => {
    const roomId = generateRoomId()
    router.push(`/room/?id=${roomId}`)
  }

  const joinMeeting = () => {
    const code = roomCode.trim()
    if (code) {
      router.push(`/room/?id=${code}`)
    }
  }

  if (!isReady) {
    return (
      <div className='flex min-h-screen items-center justify-center'>
        <div className='h-10 w-10 animate-spin rounded-full border-2 border-surface-inverted-tertiary border-t-ring' />
      </div>
    )
  }

  return (
    <div className='min-h-screen'>
      <header className='flex items-center px-6 py-4'>
        <div className='flex items-center gap-2'>
          <svg className='h-10 w-10 text-ring' viewBox='0 0 24 24' fill='currentColor'>
            <path d='M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z' />
          </svg>
          <span className='text-xl font-medium'>Meet</span>
        </div>
      </header>

      <main className='flex min-h-[calc(100vh-80px)] items-center justify-center px-6'>
        <div className='flex w-full max-w-6xl flex-col items-center gap-16 lg:flex-row lg:justify-between'>
          <div className='flex max-w-lg flex-col items-center text-center lg:items-start lg:text-left'>
            <h1 className='text-4xl font-normal leading-tight sm:text-5xl'>
              Video calls and meetings
              <br />
              <span className='text-text-secondary'>for everyone</span>
            </h1>
            <p className='mt-6 text-lg text-text-secondary'>
              Connect, collaborate, and celebrate from anywhere with Meet. Secure peer-to-peer video
              calls powered by WebRTC.
            </p>

            <div className='mt-10 flex items-center gap-3'>
              <button
                onClick={startMeeting}
                className='flex items-center justify-center gap-2 rounded-md bg-ring px-6 py-3 font-medium text-white transition-colors hover:opacity-90'
              >
                <svg className='h-5 w-5' viewBox='0 0 24 24' fill='currentColor'>
                  <path d='M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z' />
                </svg>
                New meeting
              </button>
              <div className='flex items-center gap-2'>
                <input
                  type='text'
                  value={roomCode}
                  onChange={handleRoomCodeChange}
                  onKeyDown={(e) => e.key === 'Enter' && joinMeeting()}
                  placeholder='Enter a code'
                  className='rounded-md border border-surface-inverted-tertiary bg-secondary px-4 py-3 text-sm text-foreground placeholder-text-secondary outline-none focus:border-ring'
                />
                <button
                  onClick={joinMeeting}
                  disabled={!roomCode.trim()}
                  className='font-medium text-ring transition-colors hover:opacity-80 disabled:text-text-secondary disabled:opacity-50'
                >
                  Join
                </button>
              </div>
            </div>

            <div className='mt-10 border-t border-surface-inverted-tertiary pt-6'>
              <p className='text-sm text-text-secondary'>
                Decentralized signaling • Free forever
              </p>
            </div>
          </div>

          <div className='hidden lg:block'>
            <div className='relative h-80 w-96 rounded-xl bg-secondary p-6'>
              <div className='grid h-full grid-cols-2 gap-3'>
                <div className='flex items-center justify-center rounded-lg bg-surface-inverted-secondary'>
                  <div className='flex h-16 w-16 items-center justify-center rounded-full bg-ring text-2xl font-medium text-white'>
                    {displayName.charAt(0).toUpperCase()}
                  </div>
                </div>
                <div className='flex items-center justify-center rounded-lg bg-surface-inverted-secondary'>
                  <div className='flex h-16 w-16 items-center justify-center rounded-full bg-emerald-600 text-2xl font-medium text-white'>
                    M
                  </div>
                </div>
                <div className='flex items-center justify-center rounded-lg bg-surface-inverted-secondary'>
                  <div className='flex h-16 w-16 items-center justify-center rounded-full bg-purple-600 text-2xl font-medium text-white'>
                    A
                  </div>
                </div>
                <div className='flex items-center justify-center rounded-lg bg-surface-inverted-secondary'>
                  <div className='flex h-16 w-16 items-center justify-center rounded-full bg-orange-600 text-2xl font-medium text-white'>
                    K
                  </div>
                </div>
              </div>
              <div className='absolute bottom-0 left-1/2 flex -translate-x-1/2 translate-y-1/2 items-center gap-2 rounded-full bg-surface-inverted-secondary px-4 py-2 shadow-lg'>
                <div className='flex h-10 w-10 items-center justify-center rounded-full bg-surface-inverted-tertiary'>
                  <svg className='h-5 w-5' viewBox='0 0 24 24' fill='currentColor'>
                    <path d='M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z' />
                    <path d='M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z' />
                  </svg>
                </div>
                <div className='flex h-10 w-10 items-center justify-center rounded-full bg-surface-inverted-tertiary'>
                  <svg className='h-5 w-5' viewBox='0 0 24 24' fill='currentColor'>
                    <path d='M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z' />
                  </svg>
                </div>
                <div className='flex h-10 w-10 items-center justify-center rounded-full bg-destructive'>
                  <svg className='h-5 w-5' viewBox='0 0 24 24' fill='currentColor'>
                    <path d='M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.68-1.36-2.66-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z' />
                  </svg>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
