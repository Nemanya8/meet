'use client'

import { Suspense, useEffect, useRef, useState, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import { CallsProvider, type LogType, generatePeerId } from '@/packages/calls/src'
import { createAccountsProvider, hostApi, type ProductAccountId } from '@novasamatech/product-sdk'

type CallStatus = 'connecting' | 'waiting' | 'connected' | 'error' | 'no-account'

interface Participant {
  odpeerId: string
  username?: string
  stream: MediaStream | null
  isConnected: boolean
  isMuted?: boolean
  isVideoOff?: boolean
}

// Validate room ID format: xxx-xxx-xxx (3 groups of 3 alphanumeric characters)
function isValidRoomId(roomId: string): boolean {
  return /^[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/i.test(roomId)
}

const accountsProvider = createAccountsProvider()

function MeetingRoomContent() {
  const searchParams = useSearchParams()
  const roomId = searchParams.get('id') || ''
  const router = useRouter()

  const [callStatus, setCallStatus] = useState<CallStatus>('connecting')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [isMuted, setIsMuted] = useState(false)
  const [isVideoOff, setIsVideoOff] = useState(false)
  const [participants, setParticipants] = useState<Map<string, Participant>>(new Map())
  const [showSidebar, setShowSidebar] = useState(false)
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [raisedHands, setRaisedHands] = useState<string[]>([])
  const [isHandRaised, setIsHandRaised] = useState(false)
  const [showReactionPicker, setShowReactionPicker] = useState(false)
  const [activeReactions, setActiveReactions] = useState<{ id: string; peerId: string; emoji: string; left: number }[]>([])
  const [myUsername, setMyUsername] = useState<string>('')
  const [chatMessages, setChatMessages] = useState<{ peerId: string; username: string; message: string; timestamp: number }[]>([])
  const [chatInput, setChatInput] = useState('')
  const [sidebarView, setSidebarView] = useState<'people' | 'chat'>('people')
  const [unreadCount, setUnreadCount] = useState(0)
  const [isScreenSharing, setIsScreenSharing] = useState(false)
  const [screenSharer, setScreenSharer] = useState<{ peerId: string; username?: string } | null>(null)
  const [remoteScreenStream, setRemoteScreenStream] = useState<MediaStream | null>(null)
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null)
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null)

  // Device selection state
  const [showSettings, setShowSettings] = useState(false)
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([])
  const [videoInputDevices, setVideoInputDevices] = useState<MediaDeviceInfo[]>([])
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedAudioInput, setSelectedAudioInput] = useState<string>('')
  const [selectedVideoInput, setSelectedVideoInput] = useState<string>('')
  const [selectedAudioOutput, setSelectedAudioOutput] = useState<string>('')

  // Screen share menu state
  const [showScreenShareMenu, setShowScreenShareMenu] = useState(false)


  const localStreamRef = useRef<MediaStream | null>(null)
  const audioContextsRef = useRef<Map<string, { context: AudioContext; analyser: AnalyserNode }>>(new Map())
  const remoteVideoRefs = useRef<Map<string, HTMLVideoElement>>(new Map())
  const isHandRaisedRef = useRef(false)
  const chatMessagesEndRef = useRef<HTMLDivElement>(null)
  const screenShareVideoRef = useRef<HTMLVideoElement>(null)
  const localScreenShareVideoRef = useRef<HTMLVideoElement>(null)

  const providerRef = useRef<CallsProvider | null>(null)
  const peerId = useRef<string>('')

  const addLog = useCallback((message: string, type: LogType) => {
    const prefix = type === 'error' ? '❌' : type === 'success' ? '✅' : type === 'blockchain' ? '⛓️' : type === 'warning' ? '⚠️' : 'ℹ️'
    console.log(`[${type.toUpperCase()}] ${prefix} ${message}`)
  }, [])

  const addParticipant = useCallback((odpeerId: string, username?: string) => {
    setParticipants((prev) => {
      const newMap = new Map(prev)
      if (!newMap.has(odpeerId)) {
        newMap.set(odpeerId, { odpeerId, username, stream: null, isConnected: false })
      } else if (username) {
        const existing = newMap.get(odpeerId)!
        newMap.set(odpeerId, { ...existing, username })
      }
      return newMap
    })
  }, [])

  const updateParticipantStream = useCallback((odpeerId: string, stream: MediaStream) => {
    setParticipants((prev) => {
      const newMap = new Map(prev)
      const participant = newMap.get(odpeerId)
      if (participant) {
        newMap.set(odpeerId, { ...participant, stream, isConnected: true })
      } else {
        newMap.set(odpeerId, { odpeerId, stream, isConnected: true })
      }
      return newMap
    })
    setCallStatus('connected')
  }, [])

  const removeParticipant = useCallback((odpeerId: string) => {
    setParticipants((prev) => {
      const newMap = new Map(prev)
      newMap.delete(odpeerId)
      if (newMap.size === 0) {
        setCallStatus('waiting')
      }
      return newMap
    })
  }, [])

  // Play a pleasant two-tone "pop" sound when someone joins
  const playJoinSound = useCallback(() => {
    const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()

    // First tone (lower)
    const osc1 = audioContext.createOscillator()
    const gain1 = audioContext.createGain()
    osc1.connect(gain1)
    gain1.connect(audioContext.destination)
    osc1.frequency.value = 440
    osc1.type = 'sine'
    gain1.gain.setValueAtTime(0.2, audioContext.currentTime)
    gain1.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15)
    osc1.start(audioContext.currentTime)
    osc1.stop(audioContext.currentTime + 0.15)

    // Second tone (higher) - delayed slightly
    const osc2 = audioContext.createOscillator()
    const gain2 = audioContext.createGain()
    osc2.connect(gain2)
    gain2.connect(audioContext.destination)
    osc2.frequency.value = 554.37
    osc2.type = 'sine'
    gain2.gain.setValueAtTime(0, audioContext.currentTime + 0.08)
    gain2.gain.linearRampToValueAtTime(0.25, audioContext.currentTime + 0.1)
    gain2.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.25)
    osc2.start(audioContext.currentTime + 0.08)
    osc2.stop(audioContext.currentTime + 0.25)
  }, [])

  useEffect(() => {
    let mounted = true

    const init = async () => {
      try {
        // Check for accounts
        let accounts: Awaited<ReturnType<typeof accountsProvider.getNonProductAccounts>> extends { match: (ok: infer O, err: infer _E) => void } ? (O extends (accs: infer A) => void ? A : never) : never
        const result = await accountsProvider.getNonProductAccounts()
        result.match(
          (accs) => { accounts = accs },
          (err) => { throw new Error(`Failed to get accounts: ${err}`) }
        )

        if (!accounts! || accounts!.length === 0) {
          setCallStatus('no-account')
          return
        }

        const accountId: ProductAccountId = ['meet.dot', 0]
        const displayName = accounts![0].name || 'User'
        setMyUsername(displayName)

        peerId.current = generatePeerId()

        // Request permissions from host before accessing media
        const requestDevice = async (perm: 'Camera' | 'Microphone') => {
          try {
            const r = await hostApi.devicePermission({ tag: 'v1', value: perm })
            r.match(
              (res) => addLog(`${perm} permission: ${res.value ? 'granted' : 'denied'}`, res.value ? 'info' : 'warning'),
              (err) => addLog(`${perm} permission error: ${JSON.stringify(err)}`, 'warning')
            )
          } catch (e) { addLog(`${perm} permission error: ${e}`, 'warning') }
        }

        const requestNetwork = async (domain: string) => {
          try {
            const r = await hostApi.permission({ tag: 'v1', value: {
              tag: 'ExternalRequest',
              value: `https://${domain}`
            }})
            r.match(
              (res) => addLog(`Network ${domain}: ${res.value ? 'granted' : 'denied'}`, res.value ? 'info' : 'warning'),
              (err) => addLog(`Network ${domain} error: ${JSON.stringify(err)}`, 'warning')
            )
          } catch (e) { addLog(`Network ${domain} error: ${e}`, 'warning') }
        }

        await Promise.all([
          requestDevice('Camera'),
          requestDevice('Microphone'),
          requestNetwork('turn.cloudflare.com'),
          requestNetwork('stun.cloudflare.com'),
          requestNetwork('stun.l.google.com'),
          requestNetwork('rtc.live.cloudflare.com')
        ])

        let stream: MediaStream | null = null
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          })
        } catch (mediaErr) {
          addLog(`Media permission denied: ${mediaErr}. Joining without camera/mic.`, 'warning')
          // Continue without media — user can still see others and use chat
        }

        if (!mounted) {
          stream?.getTracks().forEach((t) => t.stop())
          return
        }

        if (stream) {
          localStreamRef.current = stream
          setLocalStream(stream)
        }

        // Enumerate available devices after getting permission
        if (stream) {
          const devices = await navigator.mediaDevices.enumerateDevices()
          const audioInputs = devices.filter(d => d.kind === 'audioinput')
          const videoInputs = devices.filter(d => d.kind === 'videoinput')
          const audioOutputs = devices.filter(d => d.kind === 'audiooutput')
          setAudioInputDevices(audioInputs)
          setVideoInputDevices(videoInputs)
          setAudioOutputDevices(audioOutputs)

          // Set initial selected devices from current stream
          const audioTrack = stream.getAudioTracks()[0]
          const videoTrack = stream.getVideoTracks()[0]
          if (audioTrack?.getSettings().deviceId) {
            setSelectedAudioInput(audioTrack.getSettings().deviceId!)
          }
          if (videoTrack?.getSettings().deviceId) {
            setSelectedVideoInput(videoTrack.getSettings().deviceId!)
          }
          if (audioOutputs.length > 0) {
            setSelectedAudioOutput(audioOutputs[0].deviceId)
          }
        }

        // Create CallsProvider
        const provider = new CallsProvider(roomId, {
          accountId,
          peerId: peerId.current,
          username: displayName,
          turnKeyId: process.env.NEXT_PUBLIC_TURN_KEY_ID,
          turnApiToken: process.env.NEXT_PUBLIC_TURN_API_TOKEN,
          forceRelay: false,
          onLog: addLog,
          onPeerConnect: (remotePeerId: string) => {
            addLog(`Peer ${remotePeerId} connected`, 'success')
            addParticipant(remotePeerId)
            playJoinSound()

            // Send current hand state to newly connected peer
            if (isHandRaisedRef.current) {
              provider.send(remotePeerId, JSON.stringify({ type: 'hand-raise', peerId: peerId.current, raised: true }))
            }

            // Send current mute/video state to newly connected peer
            const audioTrack = localStreamRef.current?.getAudioTracks()[0]
            if (audioTrack && !audioTrack.enabled) {
              provider.send(remotePeerId, JSON.stringify({ type: 'mute-state', peerId: peerId.current, muted: true }))
            }
            const videoTrack = localStreamRef.current?.getVideoTracks()[0]
            if (videoTrack && !videoTrack.enabled) {
              provider.send(remotePeerId, JSON.stringify({ type: 'video-state', peerId: peerId.current, videoOff: true }))
            }
          },
          onPeerDisconnect: (remotePeerId: string) => {
            addLog(`Peer ${remotePeerId} disconnected`, 'warning')
            removeParticipant(remotePeerId)
            // Remove from raised hands when peer disconnects
            setRaisedHands((prev) => prev.filter((id) => id !== remotePeerId))
          },
          onData: (_remotePeerId, data) => {
            try {
              const message = JSON.parse(new TextDecoder().decode(data))
              if (message.type === 'hand-raise') {
                setRaisedHands((prev) => {
                  if (message.raised) {
                    if (!prev.includes(message.peerId)) {
                      playDingSound()
                      return [...prev, message.peerId]
                    }
                  } else {
                    return prev.filter((id) => id !== message.peerId)
                  }
                  return prev
                })
              } else if (message.type === 'reaction') {
                const reactionId = `${message.peerId}-${Date.now()}`
                const randomLeft = Math.random() * 200
                setActiveReactions((prev) => [...prev, { id: reactionId, peerId: message.peerId, emoji: message.emoji, left: randomLeft }])
                setTimeout(() => {
                  setActiveReactions((prev) => prev.filter((r) => r.id !== reactionId))
                }, 3000)
              } else if (message.type === 'mute-state') {
                setParticipants((prev) => {
                  const newMap = new Map(prev)
                  const participant = newMap.get(message.peerId)
                  if (participant) {
                    newMap.set(message.peerId, { ...participant, isMuted: message.muted })
                  }
                  return newMap
                })
              } else if (message.type === 'video-state') {
                setParticipants((prev) => {
                  const newMap = new Map(prev)
                  const participant = newMap.get(message.peerId)
                  if (participant) {
                    newMap.set(message.peerId, { ...participant, isVideoOff: message.videoOff })
                  }
                  return newMap
                })
              } else if (message.type === 'chat') {
                setChatMessages((prev) => [...prev, {
                  peerId: message.peerId,
                  username: message.username || message.peerId,
                  message: message.message,
                  timestamp: message.timestamp
                }])
                setSidebarView((currentView) => {
                  if (currentView !== 'chat') {
                    setUnreadCount((prev) => prev + 1)
                  }
                  return currentView
                })
              }
            } catch {
              // Ignore non-JSON messages
            }
          },
          onStream: (remotePeerId, remoteStream) => {
            const trackInfo = remoteStream.getTracks().map(t => `${t.kind}:${t.readyState}:${t.enabled}`).join(', ')
            addLog(`Received stream from ${remotePeerId}, tracks: [${trackInfo}]`, 'success')

            remoteStream.getTracks().forEach(track => {
              track.onended = () => {
                addLog(`Track ${track.kind} ended for ${remotePeerId}`, 'warning')
              }
              track.onmute = () => {
                addLog(`Track ${track.kind} muted for ${remotePeerId}`, 'warning')
              }
              track.onunmute = () => {
                addLog(`Track ${track.kind} unmuted for ${remotePeerId}`, 'info')
              }
            })

            updateParticipantStream(remotePeerId, remoteStream)
          },
          onScreenShare: (remotePeerId, stream) => {
            addLog(`Screen share ${stream ? 'started' : 'stopped'} from ${remotePeerId}`, 'info')
            setRemoteScreenStream(stream)
          },
          onScreenShareStateChange: (sharerPeerId, sharerUsername) => {
            if (sharerPeerId) {
              addLog(`${sharerUsername || sharerPeerId} started screen sharing`, 'info')
              setScreenSharer({ peerId: sharerPeerId, username: sharerUsername })
            } else {
              addLog('Screen sharing stopped', 'info')
              setScreenSharer(null)
              setRemoteScreenStream(null)
              setLocalScreenStream(null)
              setIsScreenSharing(false)
            }
          },
        })

        providerRef.current = provider

        // Set local stream for media exchange
        provider.setLocalStream(stream)

        // Connect to the network
        await provider.connect()

        setCallStatus('waiting')
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        setErrorMessage(message)
        setCallStatus('error')
      }
    }

    init()

    return () => {
      mounted = false
      localStreamRef.current?.getTracks().forEach((track) => track.stop())
      providerRef.current?.disconnect()
    }
  }, [roomId, addLog, addParticipant, updateParticipantStream, removeParticipant, playJoinSound])

  // Callback ref for local video to ensure stream is set when element mounts
  const setLocalVideoRef = useCallback((el: HTMLVideoElement | null) => {
    if (el && localStream) {
      el.srcObject = localStream
      el.play().catch(() => {
        // Autoplay may be blocked, user interaction needed
      })
    }
  }, [localStream])

  // Attach streams to video elements when participants change or layout changes
  useEffect(() => {
    const timeout = setTimeout(() => {
      participants.forEach((participant, odpeerId) => {
        const videoEl = remoteVideoRefs.current.get(odpeerId)
        if (videoEl && participant.stream && videoEl.srcObject !== participant.stream) {
          videoEl.srcObject = participant.stream
          addLog(`Set stream on video element for ${odpeerId}, tracks: ${participant.stream.getTracks().map(t => `${t.kind}:${t.readyState}`).join(', ')}`, 'info')
          videoEl.play().catch((err) => {
            addLog(`Failed to play video for ${odpeerId}: ${err.message}`, 'error')
          })
        }
      })
    }, 50)
    return () => clearTimeout(timeout)
  }, [participants, addLog, screenSharer])

  // Handle screen share video stream
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (screenShareVideoRef.current && remoteScreenStream) {
        screenShareVideoRef.current.srcObject = remoteScreenStream
        screenShareVideoRef.current.play().catch((err) => {
          addLog(`Failed to play screen share video: ${err.message}`, 'error')
        })
      }
    }, 50)
    return () => clearTimeout(timeout)
  }, [remoteScreenStream, addLog, screenSharer])

  // Handle local screen share preview
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (localScreenShareVideoRef.current && localScreenStream) {
        localScreenShareVideoRef.current.srcObject = localScreenStream
        localScreenShareVideoRef.current.play().catch(() => {
          // Ignore autoplay errors for local preview
        })
      }
    }, 50)
    return () => clearTimeout(timeout)
  }, [localScreenStream, screenSharer])

  // Active speaker detection using audio levels
  useEffect(() => {
    const SPEAKING_THRESHOLD = 10
    const SILENCE_TIMEOUT = 1500
    let silenceTimer: ReturnType<typeof setTimeout> | null = null
    let animationFrameId: number | null = null

    const setupAudioAnalysis = (peerId: string, stream: MediaStream) => {
      if (audioContextsRef.current.has(peerId)) return
      const audioTracks = stream.getAudioTracks()
      if (audioTracks.length === 0) return

      try {
        const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.5

        const source = audioContext.createMediaStreamSource(stream)
        source.connect(analyser)

        audioContextsRef.current.set(peerId, { context: audioContext, analyser })
      } catch {
        // Ignore audio context errors
      }
    }

    const cleanupAudioAnalysis = (peerId: string) => {
      const entry = audioContextsRef.current.get(peerId)
      if (entry) {
        entry.context.close().catch(() => {})
        audioContextsRef.current.delete(peerId)
      }
    }

    const detectActiveSpeaker = () => {
      let maxLevel = 0
      let loudestPeer: string | null = null

      audioContextsRef.current.forEach((entry, peerId) => {
        const dataArray = new Uint8Array(entry.analyser.frequencyBinCount)
        entry.analyser.getByteFrequencyData(dataArray)

        const sum = dataArray.reduce((acc, val) => acc + val, 0)
        const avgLevel = sum / dataArray.length

        if (avgLevel > maxLevel && avgLevel > SPEAKING_THRESHOLD) {
          maxLevel = avgLevel
          loudestPeer = peerId
        }
      })

      if (loudestPeer) {
        if (silenceTimer) {
          clearTimeout(silenceTimer)
          silenceTimer = null
        }
        setActiveSpeaker(loudestPeer)
      } else if (!silenceTimer) {
        silenceTimer = setTimeout(() => {
          setActiveSpeaker(null)
        }, SILENCE_TIMEOUT)
      }

      animationFrameId = requestAnimationFrame(detectActiveSpeaker)
    }

    // Set up audio analysis for local stream
    if (localStream) {
      setupAudioAnalysis(peerId.current, localStream)
    }

    // Set up audio analysis for all participants
    participants.forEach((participant, odpeerId) => {
      if (participant.stream) {
        setupAudioAnalysis(odpeerId, participant.stream)
      }
    })

    // Start detection loop
    animationFrameId = requestAnimationFrame(detectActiveSpeaker)

    // Cleanup
    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId)
      }
      if (silenceTimer) {
        clearTimeout(silenceTimer)
      }
      const currentPeerIds = new Set([peerId.current, ...participants.keys()])
      audioContextsRef.current.forEach((_, key) => {
        if (!currentPeerIds.has(key)) {
          cleanupAudioAnalysis(key)
        }
      })
    }
  }, [localStream, participants])

  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0]
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled
        const newMutedState = !audioTrack.enabled
        setIsMuted(newMutedState)

        const message = JSON.stringify({ type: 'mute-state', peerId: peerId.current, muted: newMutedState })
        providerRef.current?.broadcast(message)
      }
    }
  }

  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0]
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled
        const newVideoOffState = !videoTrack.enabled
        setIsVideoOff(newVideoOffState)

        const message = JSON.stringify({ type: 'video-state', peerId: peerId.current, videoOff: newVideoOffState })
        providerRef.current?.broadcast(message)
      }
    }
  }

  // Device enumeration and switching
  const enumerateDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const audioInputs = devices.filter(d => d.kind === 'audioinput')
      const videoInputs = devices.filter(d => d.kind === 'videoinput')
      const audioOutputs = devices.filter(d => d.kind === 'audiooutput')

      setAudioInputDevices(audioInputs)
      setVideoInputDevices(videoInputs)
      setAudioOutputDevices(audioOutputs)

      if (localStreamRef.current) {
        const audioTrack = localStreamRef.current.getAudioTracks()[0]
        const videoTrack = localStreamRef.current.getVideoTracks()[0]
        if (audioTrack) {
          const settings = audioTrack.getSettings()
          if (settings.deviceId) setSelectedAudioInput(settings.deviceId)
        }
        if (videoTrack) {
          const settings = videoTrack.getSettings()
          if (settings.deviceId) setSelectedVideoInput(settings.deviceId)
        }
      }

      if (audioOutputs.length > 0 && !selectedAudioOutput) {
        setSelectedAudioOutput(audioOutputs[0].deviceId)
      }
    } catch (err) {
      console.error('Failed to enumerate devices:', err)
    }
  }, [selectedAudioOutput])

  const switchAudioInput = useCallback(async (deviceId: string) => {
    if (!localStreamRef.current || !providerRef.current) return

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: deviceId },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })

      const newAudioTrack = newStream.getAudioTracks()[0]
      const oldAudioTrack = localStreamRef.current.getAudioTracks()[0]

      if (oldAudioTrack) {
        newAudioTrack.enabled = oldAudioTrack.enabled
        oldAudioTrack.stop()
        localStreamRef.current.removeTrack(oldAudioTrack)
      }

      localStreamRef.current.addTrack(newAudioTrack)
      setSelectedAudioInput(deviceId)

      await providerRef.current.setLocalStream(localStreamRef.current)
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()))

      addLog('Switched microphone', 'success')
    } catch (err) {
      console.error('Failed to switch audio input:', err)
      addLog('Failed to switch microphone', 'error')
    }
  }, [addLog])

  const switchVideoInput = useCallback(async (deviceId: string) => {
    if (!localStreamRef.current || !providerRef.current) return

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } },
      })

      const newVideoTrack = newStream.getVideoTracks()[0]
      const oldVideoTrack = localStreamRef.current.getVideoTracks()[0]

      if (oldVideoTrack) {
        newVideoTrack.enabled = oldVideoTrack.enabled
        oldVideoTrack.stop()
        localStreamRef.current.removeTrack(oldVideoTrack)
      }

      localStreamRef.current.addTrack(newVideoTrack)
      setSelectedVideoInput(deviceId)

      await providerRef.current.setLocalStream(localStreamRef.current)
      setLocalStream(new MediaStream(localStreamRef.current.getTracks()))

      addLog('Switched camera', 'success')
    } catch (err) {
      console.error('Failed to switch video input:', err)
      addLog('Failed to switch camera', 'error')
    }
  }, [addLog])

  const switchAudioOutput = useCallback(async (deviceId: string) => {
    setSelectedAudioOutput(deviceId)

    remoteVideoRefs.current.forEach(async (videoElement) => {
      try {
        if ('setSinkId' in videoElement) {
          await (videoElement as HTMLVideoElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(deviceId)
        }
      } catch (err) {
        console.error('Failed to set audio output:', err)
      }
    })

    addLog('Switched speaker', 'success')
  }, [addLog])

  const leaveMeeting = () => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    providerRef.current?.disconnect()
    router.push('/')
  }

  const toggleScreenShare = async () => {
    if (!providerRef.current) return

    if (isScreenSharing) {
      await providerRef.current.stopScreenShare()
      setIsScreenSharing(false)
      setLocalScreenStream(null)
    } else {
      // Check and clear stale screen share state (if sharer disconnected)
      providerRef.current.clearScreenShareState()

      // Check if someone else is sharing (after clearing stale state)
      const currentSharer = providerRef.current.getScreenSharer()
      if (currentSharer && currentSharer.peerId !== peerId.current) {
        addLog(`Cannot share: ${currentSharer.username || currentSharer.peerId} is already sharing`, 'warning')
        return
      }
      // Start sharing
      const stream = await providerRef.current.startScreenShare()
      if (stream) {
        setIsScreenSharing(true)
        setLocalScreenStream(stream)
      }
    }
  }

  const playDingSound = useCallback(() => {
    const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    const oscillator = audioContext.createOscillator()
    const gainNode = audioContext.createGain()

    oscillator.connect(gainNode)
    gainNode.connect(audioContext.destination)

    oscillator.frequency.value = 880
    oscillator.type = 'sine'

    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime)
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3)

    oscillator.start(audioContext.currentTime)
    oscillator.stop(audioContext.currentTime + 0.3)
  }, [])

  const toggleRaiseHand = () => {
    const myId = peerId.current
    const newRaisedState = !isHandRaised

    if (isHandRaised) {
      setRaisedHands((prev) => prev.filter((id) => id !== myId))
      setIsHandRaised(false)
      isHandRaisedRef.current = false
    } else {
      setRaisedHands((prev) => [...prev, myId])
      setIsHandRaised(true)
      isHandRaisedRef.current = true
      playDingSound()
    }

    const message = JSON.stringify({ type: 'hand-raise', peerId: myId, raised: newRaisedState })
    providerRef.current?.broadcast(message)
  }

  const sendReaction = (emoji: string) => {
    const myId = peerId.current
    const reactionId = `${myId}-${Date.now()}`
    const randomLeft = Math.random() * 200

    setActiveReactions((prev) => [...prev, { id: reactionId, peerId: myId, emoji, left: randomLeft }])
    setTimeout(() => {
      setActiveReactions((prev) => prev.filter((r) => r.id !== reactionId))
    }, 3000)

    const message = JSON.stringify({ type: 'reaction', peerId: myId, emoji })
    providerRef.current?.broadcast(message)
  }

  const sendChatMessage = () => {
    if (!chatInput.trim()) return

    const myId = peerId.current
    const chatMessage = {
      type: 'chat',
      peerId: myId,
      username: myUsername || myId,
      message: chatInput,
      timestamp: Date.now()
    }

    setChatMessages((prev) => [...prev, {
      peerId: myId,
      username: myUsername || myId,
      message: chatInput,
      timestamp: Date.now()
    }])

    providerRef.current?.broadcast(JSON.stringify(chatMessage))

    setChatInput('')
  }

  // Convert URLs in text to clickable links
  const linkifyText = (text: string) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g
    const parts = text.split(urlRegex)

    return parts.map((part, idx) => {
      if (part.match(urlRegex)) {
        return (
          <a
            key={idx}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#8ab4f8] hover:underline"
          >
            {part}
          </a>
        )
      }
      return part
    })
  }

  // Auto-scroll chat to bottom when new messages arrive
  useEffect(() => {
    if (sidebarView === 'chat' && chatMessagesEndRef.current) {
      chatMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chatMessages, sidebarView])

  const participantCount = participants.size + 1
  const connectedParticipants = Array.from(participants.values()).filter(p => p.isConnected)
  const allVideoParticipants = connectedParticipants.length + 1

  // Calculate grid layout based on participant count (Google Meet style)
  const getGridLayout = () => {
    if (allVideoParticipants === 1) return { cols: 1, rows: 1 }
    if (allVideoParticipants === 2) return { cols: 2, rows: 1 }
    if (allVideoParticipants <= 4) return { cols: 2, rows: 2 }
    if (allVideoParticipants <= 6) return { cols: 3, rows: 2 }
    if (allVideoParticipants <= 9) return { cols: 3, rows: 3 }
    if (allVideoParticipants <= 12) return { cols: 4, rows: 3 }
    return { cols: 4, rows: 4 }
  }

  const layout = getGridLayout()

  const getDisplayName = (odpeerId: string, username?: string) => {
    if (odpeerId === peerId.current) return myUsername || 'You'
    if (username) return username
    const participant = participants.get(odpeerId)
    if (participant?.username) return participant.username
    return odpeerId
  }

  const getReactionSenderName = (odpeerId: string) => {
    if (odpeerId === peerId.current) return myUsername || 'You'
    const participant = participants.get(odpeerId)
    return participant?.username || odpeerId
  }

  const isValidRoom = isValidRoomId(roomId)

  if (!isValidRoom) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#202124] text-white">
        <div className="text-center max-w-md px-6">
          <div className="text-8xl mb-6">404</div>
          <h1 className="text-2xl font-medium mb-3">Room not found</h1>
          <p className="text-[#9aa0a6] mb-8">
            The room code &quot;{roomId}&quot; is invalid. Room codes should be in the format xxx-xxx-xxx (e.g., abc-123-xyz).
          </p>
          <button
            onClick={() => router.push('/')}
            className="rounded-full bg-[#8ab4f8] text-[#202124] px-6 py-3 font-medium hover:bg-[#aecbfa] transition-colors"
          >
            Go to Home
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-[#202124] text-white overflow-hidden">
      {/* Floating reactions container */}
      <div className="fixed bottom-24 left-0 z-50 pointer-events-none" style={{ width: '250px', height: '300px' }}>
        {activeReactions.map((reaction) => (
          <div
            key={reaction.id}
            className="absolute bottom-0 flex flex-col items-center"
            style={{
              left: `${reaction.left + 16}px`,
              animation: 'reactionFloat 3s ease-out forwards'
            }}
          >
            <span className="text-5xl">{reaction.emoji}</span>
            <span className="text-xs text-white/80 bg-[#3c4043]/80 px-2 py-0.5 rounded mt-1">
              {getReactionSenderName(reaction.peerId)}
            </span>
          </div>
        ))}
      </div>

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Video grid area - smooth transition when sidebar opens */}
        <main className={`flex-1 flex flex-col overflow-hidden transition-all duration-300 ease-in-out ${showSidebar ? 'mr-80' : 'mr-0'}`}>
          {/* Video grid container - fixed aspect ratio like Google Meet */}
          <div className="flex-1 flex items-center justify-center p-3 overflow-hidden">
            {callStatus === 'no-account' ? (
              <div className="text-center">
                <p className="text-[#9aa0a6] mb-4">No account found. Please connect via the host app.</p>
                <button
                  onClick={() => router.push('/')}
                  className="rounded-full bg-[#8ab4f8] text-[#202124] px-6 py-3 font-medium hover:bg-[#aecbfa] transition-colors"
                >
                  Go to Home
                </button>
              </div>
            ) : callStatus === 'error' ? (
              <div className="text-center">
                <p className="text-red-400 mb-4">{errorMessage}</p>
                <button
                  onClick={() => window.location.reload()}
                  className="rounded-full bg-[#3c4043] px-6 py-2 text-sm hover:bg-[#4a4d51] transition-colors"
                >
                  Try Again
                </button>
              </div>
            ) : callStatus === 'connecting' ? (
              <div className="text-center">
                <div className="h-10 w-10 mx-auto mb-4 animate-spin rounded-full border-2 border-[#3c4043] border-t-white" />
                <p className="text-[#9aa0a6]">Joining meeting...</p>
              </div>
            ) : screenSharer ? (
              /* Screen Share Presentation Layout */
              <div className="w-full h-full flex gap-3">
                {/* Main screen share area - takes most of the space */}
                <div className="flex-1 flex flex-col min-w-0">
                  <div className="relative flex-1 bg-[#1a1a1a] rounded-lg overflow-hidden">
                    {/* Screen share video */}
                    {screenSharer.peerId === peerId.current ? (
                      /* We are sharing - show local screen share preview */
                      localScreenStream ? (
                        <video
                          ref={localScreenShareVideoRef}
                          autoPlay
                          playsInline
                          muted
                          className="absolute inset-0 h-full w-full object-contain bg-black"
                        />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center bg-[#1a1a1a]">
                          <div className="text-center">
                            <ScreenShareIcon className="h-16 w-16 mx-auto mb-4 text-[#8ab4f8]" />
                            <p className="text-lg text-white">You are presenting</p>
                            <p className="text-sm text-[#9aa0a6] mt-2">Others can see your screen</p>
                          </div>
                        </div>
                      )
                    ) : remoteScreenStream ? (
                      <video
                        ref={screenShareVideoRef}
                        autoPlay
                        playsInline
                        className="absolute inset-0 h-full w-full object-contain bg-black"
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="text-center">
                          <div className="h-10 w-10 mx-auto mb-4 animate-spin rounded-full border-2 border-[#3c4043] border-t-[#8ab4f8]" />
                          <p className="text-sm text-[#9aa0a6]">Loading screen share...</p>
                        </div>
                      </div>
                    )}
                    {/* Presenter label */}
                    <div className="absolute top-3 left-3 px-3 py-1.5 bg-[#202124]/80 rounded-lg flex items-center gap-2">
                      <ScreenShareIcon className="h-4 w-4 text-[#8ab4f8]" />
                      <span className="text-sm font-medium">
                        {screenSharer.peerId === peerId.current
                          ? 'Your screen'
                          : `${screenSharer.username || screenSharer.peerId}'s screen`}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Participants filmstrip on the right */}
                <div className="w-48 flex flex-col gap-2 overflow-y-auto">
                  {/* Local video thumbnail */}
                  <div className={`relative bg-[#3c4043] rounded-lg overflow-hidden aspect-video flex-shrink-0 transition-all duration-200 ${
                    activeSpeaker === peerId.current ? 'ring-2 ring-[#8ab4f8]' : ''
                  }`}>
                    <video
                      ref={setLocalVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className={`absolute inset-0 h-full w-full object-cover -scale-x-100 ${isVideoOff ? 'hidden' : ''}`}
                    />
                    {isVideoOff && (
                      <div className="absolute inset-0 flex items-center justify-center bg-[#3c4043]">
                        <div className="h-12 w-12 rounded-full bg-[#5f6368] flex items-center justify-center">
                          <span className="text-lg font-medium">{myUsername ? myUsername.charAt(0).toUpperCase() : 'Y'}</span>
                        </div>
                      </div>
                    )}
                    <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-[#202124]/70 rounded text-[10px] truncate max-w-[80%]">
                      You
                    </div>
                    {isMuted && (
                      <div className="absolute bottom-1 right-1 p-1 bg-red-500 rounded-full">
                        <MicOffIcon className="h-2.5 w-2.5" />
                      </div>
                    )}
                  </div>

                  {/* Remote participants thumbnails */}
                  {connectedParticipants.map((participant) => (
                    <div
                      key={participant.odpeerId}
                      className={`relative bg-[#3c4043] rounded-lg overflow-hidden aspect-video flex-shrink-0 transition-all duration-200 ${
                        activeSpeaker === participant.odpeerId ? 'ring-2 ring-[#8ab4f8]' : ''
                      }`}
                    >
                      <video
                        ref={(el) => {
                          if (el) remoteVideoRefs.current.set(participant.odpeerId, el)
                          else remoteVideoRefs.current.delete(participant.odpeerId)
                        }}
                        autoPlay
                        playsInline
                        className={`absolute inset-0 h-full w-full object-cover ${participant.isVideoOff ? 'hidden' : ''}`}
                      />
                      {(!participant.stream || participant.isVideoOff) && (
                        <div className="absolute inset-0 flex items-center justify-center bg-[#3c4043]">
                          <div className="h-12 w-12 rounded-full bg-[#5f6368] flex items-center justify-center">
                            <span className="text-lg font-medium">
                              {(participant.username || participant.odpeerId).charAt(0).toUpperCase()}
                            </span>
                          </div>
                        </div>
                      )}
                      <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-[#202124]/70 rounded text-[10px] truncate max-w-[80%]">
                        {getDisplayName(participant.odpeerId, participant.username)}
                      </div>
                      {participant.isMuted && (
                        <div className="absolute bottom-1 right-1 p-1 bg-red-500 rounded-full">
                          <MicOffIcon className="h-2.5 w-2.5" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              /* Normal Grid Layout */
              <div
                className="w-full h-full grid gap-2"
                style={{
                  gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
                  gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
                  maxHeight: '100%',
                }}
              >
                {/* Local video */}
                <div className={`relative bg-[#3c4043] rounded-lg overflow-hidden transition-all duration-200 ${
                  activeSpeaker === peerId.current ? 'ring-4 ring-[#8ab4f8]' : ''
                }`}>
                  <video
                    ref={setLocalVideoRef}
                    autoPlay
                    playsInline
                    muted
                    className={`absolute inset-0 h-full w-full object-cover -scale-x-100 ${isVideoOff ? 'hidden' : ''}`}
                  />
                  {isVideoOff && (
                    <div className="absolute inset-0 flex items-center justify-center bg-[#3c4043]">
                      <div className="h-20 w-20 rounded-full bg-[#5f6368] flex items-center justify-center">
                        <span className="text-3xl font-medium">{myUsername ? myUsername.charAt(0).toUpperCase() : 'Y'}</span>
                      </div>
                    </div>
                  )}
                  <div className="absolute bottom-2 left-2 px-2 py-1 bg-[#202124]/70 rounded text-xs truncate max-w-[80%]">
                    {myUsername || 'You'} (You)
                  </div>
                  {isMuted && (
                    <div className="absolute bottom-2 right-2 p-1.5 bg-red-500 rounded-full">
                      <MicOffIcon className="h-3 w-3" />
                    </div>
                  )}
                  {isHandRaised && (
                    <div
                      className="absolute top-2 right-2 flex items-center gap-2 px-3 py-2 bg-[#f9ab00] rounded-full text-[#202124]"
                      style={{ animation: 'slideInRight 0.3s ease-out' }}
                    >
                      <HandRaisedIcon className="h-5 w-5" />
                      <span className="text-sm font-medium whitespace-nowrap">Hand raised</span>
                    </div>
                  )}
                </div>

                {/* Remote participants */}
                {connectedParticipants.map((participant) => (
                  <div
                    key={participant.odpeerId}
                    className={`relative bg-[#3c4043] rounded-lg overflow-hidden transition-all duration-200 ${
                      activeSpeaker === participant.odpeerId ? 'ring-4 ring-[#8ab4f8]' : ''
                    }`}
                  >
                    <video
                      ref={(el) => {
                        if (el) remoteVideoRefs.current.set(participant.odpeerId, el)
                        else remoteVideoRefs.current.delete(participant.odpeerId)
                      }}
                      autoPlay
                      playsInline
                      className={`absolute inset-0 h-full w-full object-cover ${participant.isVideoOff ? 'hidden' : ''}`}
                    />
                    {(!participant.stream || participant.isVideoOff) && (
                      <div className="absolute inset-0 flex items-center justify-center bg-[#3c4043]">
                        <div className="h-20 w-20 rounded-full bg-[#5f6368] flex items-center justify-center">
                          <span className="text-2xl font-medium">
                            {(participant.username || participant.odpeerId).charAt(0).toUpperCase()}
                          </span>
                        </div>
                      </div>
                    )}
                    <div className="absolute bottom-2 left-2 px-2 py-1 bg-[#202124]/70 rounded text-xs truncate max-w-[80%]">
                      {getDisplayName(participant.odpeerId, participant.username)}
                    </div>
                    {participant.isMuted && (
                      <div className="absolute bottom-2 right-2 p-1.5 bg-red-500 rounded-full">
                        <MicOffIcon className="h-3 w-3" />
                      </div>
                    )}
                    {raisedHands.includes(participant.odpeerId) && (
                      <div
                        className="absolute top-2 right-2 flex items-center gap-2 px-3 py-2 bg-[#f9ab00] rounded-full text-[#202124]"
                        style={{ animation: 'slideInRight 0.3s ease-out' }}
                      >
                        <HandRaisedIcon className="h-5 w-5" />
                        <span className="text-sm font-medium whitespace-nowrap">Hand raised</span>
                      </div>
                    )}
                  </div>
                ))}

                {/* Connecting participants */}
                {Array.from(participants.values())
                  .filter(p => !p.isConnected)
                  .map((participant) => (
                    <div
                      key={participant.odpeerId}
                      className="relative bg-[#3c4043] rounded-lg overflow-hidden flex items-center justify-center"
                    >
                      <div className="text-center">
                        <div className="h-20 w-20 mx-auto rounded-full bg-[#5f6368] flex items-center justify-center mb-3">
                          <span className="text-2xl font-medium">
                            {(participant.username || participant.odpeerId).charAt(0).toUpperCase()}
                          </span>
                        </div>
                        <p className="text-xs text-[#9aa0a6]">Connecting...</p>
                        <p className="text-xs text-[#8ab4f8] mt-1">{participant.username || participant.odpeerId}</p>
                      </div>
                    </div>
                  ))}

              </div>
            )}
          </div>

          {/* Bottom controls bar - Google Meet style */}
          <div className="h-20 flex items-center justify-between px-4 bg-[#202124]">
            {/* Left - Meeting info */}
            <div className="flex items-center gap-3 w-80">
              <div className="text-sm flex items-center">
                <span className="text-[#9aa0a6]">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <span className="mx-2 text-[#5f6368]">|</span>
                <span className="text-[#9aa0a6] font-mono">{roomId}</span>
                <span className="mx-2 text-[#5f6368]">|</span>
                <span className="text-[#8ab4f8]" title={`Peer ID: ${peerId.current}`}>{myUsername}</span>
              </div>
            </div>

            {/* Center - Main controls */}
            <div className="flex items-center gap-3">
              {/* Reactions button */}
              <div className="relative">
                <button
                  onClick={() => setShowReactionPicker(!showReactionPicker)}
                  className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
                    showReactionPicker
                      ? 'bg-[#8ab4f8] text-[#202124] hover:bg-[#aecbfa]'
                      : 'bg-[#3c4043] hover:bg-[#4a4d51]'
                  }`}
                  title="Send reaction"
                >
                  <ReactionIcon className="h-5 w-5" />
                </button>
                {showReactionPicker && (
                  <div className="absolute bottom-14 left-1/2 -translate-x-1/2 bg-[#3c4043] rounded-full px-2 py-1 flex gap-1 shadow-lg">
                    {['👍', '👏', '🎉', '❤️', '😂', '😮'].map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => sendReaction(emoji)}
                        className="text-2xl hover:scale-125 transition-transform p-1"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={toggleRaiseHand}
                className={`relative flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
                  isHandRaised
                    ? 'bg-[#8ab4f8] text-[#202124] hover:bg-[#aecbfa]'
                    : 'bg-[#3c4043] hover:bg-[#4a4d51]'
                }`}
                title={isHandRaised ? 'Lower hand' : 'Raise hand'}
              >
                <HandRaisedIcon className="h-5 w-5" />
                {raisedHands.length > 1 && (
                  <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-[#f9ab00] text-[#202124] text-xs font-medium flex items-center justify-center">
                    {raisedHands.length}
                  </span>
                )}
              </button>

              <button
                onClick={toggleMute}
                className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
                  isMuted
                    ? 'bg-red-500 hover:bg-red-600'
                    : 'bg-[#3c4043] hover:bg-[#4a4d51]'
                }`}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? <MicOffIcon className="h-5 w-5" /> : <MicIcon className="h-5 w-5" />}
              </button>

              <button
                onClick={toggleVideo}
                className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
                  isVideoOff
                    ? 'bg-red-500 hover:bg-red-600'
                    : 'bg-[#3c4043] hover:bg-[#4a4d51]'
                }`}
                title={isVideoOff ? 'Turn on camera' : 'Turn off camera'}
              >
                {isVideoOff ? <VideoOffIcon className="h-5 w-5" /> : <VideoIcon className="h-5 w-5" />}
              </button>

              {/* Screen share button with menu */}
              <div className="relative">
                <button
                  onClick={() => {
                    if (isScreenSharing) {
                      setShowScreenShareMenu(!showScreenShareMenu)
                    } else {
                      toggleScreenShare()
                    }
                  }}
                  className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
                    isScreenSharing
                      ? 'bg-[#8ab4f8] text-[#202124]'
                      : 'bg-[#3c4043] hover:bg-[#4a4d51]'
                  }`}
                  title={
                    isScreenSharing
                      ? 'Click for options'
                      : screenSharer && screenSharer.peerId !== peerId.current
                      ? `${screenSharer.username || 'Someone'} is sharing`
                      : 'Share screen'
                  }
                >
                  <ScreenShareIcon className="h-5 w-5" />
                </button>
                {showScreenShareMenu && isScreenSharing && (
                  <div className="absolute bottom-14 left-1/2 -translate-x-1/2 bg-[#3c4043] rounded-lg py-1 shadow-lg min-w-[160px]">
                    <button
                      onClick={async () => {
                        setShowScreenShareMenu(false)
                        await toggleScreenShare()
                        await toggleScreenShare()
                      }}
                      className="w-full px-4 py-2 text-sm text-left hover:bg-[#4a4d51] flex items-center gap-2"
                    >
                      <ScreenShareIcon className="h-4 w-4" />
                      Change window
                    </button>
                    <button
                      onClick={() => {
                        setShowScreenShareMenu(false)
                        toggleScreenShare()
                      }}
                      className="w-full px-4 py-2 text-sm text-left hover:bg-[#4a4d51] text-red-400 flex items-center gap-2"
                    >
                      <StopIcon className="h-4 w-4" />
                      Stop sharing
                    </button>
                  </div>
                )}
              </div>

              {/* Settings button */}
              <div className="relative">
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className={`flex h-12 w-12 items-center justify-center rounded-full transition-colors ${
                    showSettings
                      ? 'bg-[#8ab4f8] text-[#202124]'
                      : 'bg-[#3c4043] hover:bg-[#4a4d51]'
                  }`}
                  title="Settings"
                >
                  <SettingsIcon className="h-5 w-5" />
                </button>
                {showSettings && (
                  <div className="absolute bottom-14 right-0 bg-[#3c4043] rounded-lg py-3 px-4 shadow-lg min-w-[280px]">
                    <h3 className="text-sm font-medium mb-3">Settings</h3>

                    {/* Microphone selection */}
                    <div className="mb-3">
                      <label className="text-xs text-[#9aa0a6] mb-1 block">Microphone</label>
                      <select
                        value={selectedAudioInput}
                        onChange={(e) => switchAudioInput(e.target.value)}
                        className="w-full bg-[#202124] border border-[#5f6368] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#8ab4f8]"
                      >
                        {audioInputDevices.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Microphone ${device.deviceId.slice(0, 5)}`}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Camera selection */}
                    <div className="mb-3">
                      <label className="text-xs text-[#9aa0a6] mb-1 block">Camera</label>
                      <select
                        value={selectedVideoInput}
                        onChange={(e) => switchVideoInput(e.target.value)}
                        className="w-full bg-[#202124] border border-[#5f6368] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#8ab4f8]"
                      >
                        {videoInputDevices.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Camera ${device.deviceId.slice(0, 5)}`}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Speaker selection */}
                    <div>
                      <label className="text-xs text-[#9aa0a6] mb-1 block">Speaker</label>
                      <select
                        value={selectedAudioOutput}
                        onChange={(e) => switchAudioOutput(e.target.value)}
                        className="w-full bg-[#202124] border border-[#5f6368] rounded px-2 py-1.5 text-sm focus:outline-none focus:border-[#8ab4f8]"
                        disabled={audioOutputDevices.length === 0}
                      >
                        {audioOutputDevices.length === 0 ? (
                          <option>Default speaker</option>
                        ) : (
                          audioOutputDevices.map((device) => (
                            <option key={device.deviceId} value={device.deviceId}>
                              {device.label || `Speaker ${device.deviceId.slice(0, 5)}`}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                  </div>
                )}
              </div>

              <button
                onClick={leaveMeeting}
                className="flex h-12 px-4 items-center justify-center rounded-full bg-red-500 hover:bg-red-600 transition-colors"
                title="Leave call"
              >
                <PhoneOffIcon className="h-5 w-5" />
              </button>
            </div>

            {/* Right - Additional controls */}
            <div className="flex items-center gap-2 w-64 justify-end">
              <button
                onClick={() => {
                  setSidebarView('chat')
                  setShowSidebar(true)
                  setUnreadCount(0)
                }}
                className={`relative flex h-10 w-10 items-center justify-center rounded-full transition-colors ${
                  showSidebar && sidebarView === 'chat' ? 'bg-[#8ab4f8] text-[#202124]' : 'bg-[#3c4043] hover:bg-[#4a4d51]'
                }`}
                title="Chat"
              >
                <ChatIcon className="h-5 w-5" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-red-500 text-white text-xs flex items-center justify-center">
                    {unreadCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => {
                  setSidebarView('people')
                  setShowSidebar(true)
                }}
                className={`relative flex h-10 w-10 items-center justify-center rounded-full transition-colors ${
                  showSidebar && sidebarView === 'people' ? 'bg-[#8ab4f8] text-[#202124]' : 'bg-[#3c4043] hover:bg-[#4a4d51]'
                }`}
                title="People"
              >
                <UsersIcon className="h-5 w-5" />
                {participantCount > 1 && (
                  <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-[#8ab4f8] text-[#202124] text-xs flex items-center justify-center">
                    {participantCount}
                  </span>
                )}
              </button>
            </div>
          </div>
        </main>

        {/* Sidebar - People/Chat panel with slide animation */}
        <aside className={`fixed right-0 top-0 h-full w-80 border-l border-[#3c4043] bg-[#202124] flex flex-col transform transition-transform duration-300 ease-in-out ${showSidebar ? 'translate-x-0' : 'translate-x-full'}`}>
          <div className="flex items-center justify-between border-b border-[#3c4043]">
            <div className="flex flex-1">
              <button
                onClick={() => {
                  setSidebarView('people')
                }}
                className={`flex-1 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  sidebarView === 'people'
                    ? 'border-[#8ab4f8] text-white'
                    : 'border-transparent text-[#9aa0a6] hover:text-white'
                }`}
              >
                People ({participantCount})
              </button>
              <button
                onClick={() => {
                  setSidebarView('chat')
                  setUnreadCount(0)
                }}
                className={`flex-1 px-4 py-3 text-sm font-medium border-b-2 transition-colors relative ${
                  sidebarView === 'chat'
                    ? 'border-[#8ab4f8] text-white'
                    : 'border-transparent text-[#9aa0a6] hover:text-white'
                }`}
              >
                Chat
                {unreadCount > 0 && sidebarView !== 'chat' && (
                  <span className="absolute top-2 right-2 h-4 w-4 rounded-full bg-red-500 text-white text-xs flex items-center justify-center">
                    {unreadCount}
                  </span>
                )}
              </button>
            </div>
            <button
              onClick={() => setShowSidebar(false)}
              className="p-3 hover:bg-[#3c4043]"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
          {sidebarView === 'people' ? (
            <div className="flex-1 overflow-y-auto p-4">
              {/* Self */}
              <div className="flex items-center gap-3 p-3 rounded-lg hover:bg-[#3c4043]/50">
                <div className="h-10 w-10 rounded-full bg-[#8ab4f8] flex items-center justify-center text-[#202124] font-medium">
                  {myUsername ? myUsername.charAt(0).toUpperCase() : 'Y'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{myUsername || 'You'}</p>
                  <p className="text-xs text-[#9aa0a6]">You</p>
                </div>
                <div className="flex gap-1">
                  {isMuted && <MicOffIcon className="h-4 w-4 text-[#9aa0a6]" />}
                  {isVideoOff && <VideoOffIcon className="h-4 w-4 text-[#9aa0a6]" />}
                </div>
              </div>

              {/* Other participants */}
              {Array.from(participants.values()).map((participant) => (
                <div
                  key={participant.odpeerId}
                  className="flex items-center gap-3 p-3 rounded-lg hover:bg-[#3c4043]/50"
                >
                  <div className={`h-10 w-10 rounded-full flex items-center justify-center font-medium ${
                    participant.isConnected ? 'bg-green-600' : 'bg-[#5f6368]'
                  }`}>
                    {(participant.username || participant.odpeerId).charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{getDisplayName(participant.odpeerId, participant.username)}</p>
                    <p className="text-xs text-[#9aa0a6]">
                      {participant.isConnected ? 'In call' : 'Connecting...'}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    {participant.isMuted && <MicOffIcon className="h-4 w-4 text-[#9aa0a6]" />}
                    {participant.isVideoOff && <VideoOffIcon className="h-4 w-4 text-[#9aa0a6]" />}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              {/* Chat messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {chatMessages.length === 0 ? (
                  <div className="text-center text-[#9aa0a6] text-sm mt-8">
                    No messages yet. Start the conversation!
                  </div>
                ) : (
                  <>
                    {chatMessages.map((msg, idx) => (
                      <div key={idx} className="flex gap-2">
                        <div className="h-8 w-8 rounded-full bg-[#5f6368] flex items-center justify-center text-xs font-medium flex-shrink-0">
                          {msg.username.charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2">
                            <span className="text-sm font-medium">{msg.username}</span>
                            <span className="text-xs text-[#9aa0a6]">
                              {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                          <p className="text-sm text-[#e8eaed] mt-0.5 break-words">{linkifyText(msg.message)}</p>
                        </div>
                      </div>
                    ))}
                    <div ref={chatMessagesEndRef} />
                  </>
                )}
              </div>
              {/* Chat input */}
              <div className="p-4 border-t border-[#3c4043]">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        sendChatMessage()
                      }
                    }}
                    placeholder="Send a message"
                    className="flex-1 bg-[#3c4043] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#8ab4f8]"
                  />
                  <button
                    onClick={sendChatMessage}
                    disabled={!chatInput.trim()}
                    className="px-4 py-2 bg-[#8ab4f8] text-[#202124] rounded-lg text-sm font-medium hover:bg-[#aecbfa] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    Send
                  </button>
                </div>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

// Icons
function MicIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
    </svg>
  )
}

function MicOffIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M1 1l22 22M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23M12 19v4M8 23h8" />
    </svg>
  )
}

function VideoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M23 7l-7 5 7 5V7zM14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" />
    </svg>
  )
}

function VideoOffIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10M1 1l22 22" />
    </svg>
  )
}

function PhoneOffIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}

function ScreenShareIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v4m0 0l-2-2m2 2l2-2" />
    </svg>
  )
}

function HandRaisedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 1 1 3 0m-3 6a1.5 1.5 0 0 0-3 0v2a7.5 7.5 0 0 0 15 0v-5a1.5 1.5 0 0 0-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 0 1 3 0v1m0 0V11m0-5.5a1.5 1.5 0 0 1 3 0v3m0 0V11" />
    </svg>
  )
}

function ReactionIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="10" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 14s1.5 2 4 2 4-2 4-2" />
      <line x1="9" y1="9" x2="9.01" y2="9" strokeWidth={3} />
      <line x1="15" y1="9" x2="15.01" y2="9" strokeWidth={3} />
    </svg>
  )
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  )
}

function SettingsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

export default function MeetingRoom() {
  return (
    <Suspense
      fallback={
        <div className="h-screen w-screen flex items-center justify-center bg-[#202124]">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-[#3c4043] border-t-white" />
        </div>
      }
    >
      <MeetingRoomContent />
    </Suspense>
  )
}
