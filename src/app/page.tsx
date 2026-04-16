'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import Peer, { DataConnection, MediaConnection } from 'peerjs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Video,
  Radio,
  Eye,
  Copy,
  Check,
  MonitorPlay,
  Shield,
  Clock,
  Users,
  CircleAlert,
  CircleStop,
  Download,
  ArrowLeft,
  Webcam,
  Maximize2,
  Minimize2,
  Loader2,
  Settings,
  RefreshCw,
} from 'lucide-react'

// ============ TYPES ============
type ViewMode = 'landing' | 'broadcast' | 'watch'
type VideoQuality = '720p' | '1080p' | '4K'

interface QualityOption {
  label: string
  value: VideoQuality
  width: number
  height: number
  description: string
}

const QUALITY_OPTIONS: QualityOption[] = [
  { label: '720p', value: '720p', width: 1280, height: 720, description: 'HD - Buena calidad, bajo consumo' },
  { label: '1080p', value: '1080p', width: 1920, height: 1080, description: 'Full HD - Calidad alta recomendada' },
  { label: '4K', value: '4K', width: 3840, height: 2160, description: 'Ultra HD - Maxima calidad (requiere dispositivo compatible)' },
]

// Room ID prefix to avoid collisions on PeerJS cloud
const PEER_PREFIX = 'camaraml-'

// ============ MAIN COMPONENT ============
export default function CamaraML() {
  // --- View State ---
  const [viewMode, setViewMode] = useState<ViewMode>('landing')
  const [peerStatus, setPeerStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected')

  // --- Quality State ---
  const [selectedQuality, setSelectedQuality] = useState<VideoQuality>('1080p')

  // --- Room State ---
  const [roomId, setRoomId] = useState('')
  const [joinRoomInput, setJoinRoomInput] = useState('')
  const [copied, setCopied] = useState(false)

  // --- Broadcaster State ---
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const [viewerCount, setViewerCount] = useState(0)
  const localStreamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeCallsRef = useRef<Map<string, MediaConnection>>(new Map())
  const activeDataConnsRef = useRef<Map<string, DataConnection>>(new Map())

  // --- Viewer State ---
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const [streamActive, setStreamActive] = useState(false)
  const [connectionError, setConnectionError] = useState('')

  // --- Peer ---
  const peerRef = useRef<Peer | null>(null)

  // --- Fullscreen ---
  const [isFullscreen, setIsFullscreen] = useState(false)
  const videoContainerRef = useRef<HTMLDivElement>(null)

  // ============ PEER LIFECYCLE ============
  // Create a lightweight peer on mount just for connection status
  useEffect(() => {
    const peer = new Peer(undefined, {
      debug: 0,
    })

    peerRef.current = peer

    peer.on('open', () => setPeerStatus('connected'))
    peer.on('disconnected', () => setPeerStatus('disconnected'))
    peer.on('error', () => setPeerStatus('disconnected'))

    return () => {
      peer.destroy()
      peerRef.current = null
    }
  }, [])

  // ============ HELPER: Generate Room ID ============
  const generateRoomId = (): string => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let result = ''
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return result
  }

  // ============ START BROADCASTING ============
  const startBroadcasting = async () => {
    try {
      const qualityConfig = QUALITY_OPTIONS.find(q => q.value === selectedQuality) || QUALITY_OPTIONS[1]
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: qualityConfig.width }, height: { ideal: qualityConfig.height }, facingMode: 'environment' },
        audio: true,
      })

      localStreamRef.current = stream
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }

      // Destroy the idle peer and create a new one with the room ID
      if (peerRef.current) {
        peerRef.current.destroy()
      }

      const newRoomId = generateRoomId()
      setRoomId(newRoomId)

      const peer = new Peer(`${PEER_PREFIX}${newRoomId}`, {
        debug: 0,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            {
              urls: 'turn:openrelay.metered.ca:80',
              username: 'openrelayproject',
              credential: 'openrelayproject',
            },
            {
              urls: 'turn:openrelay.metered.ca:443',
              username: 'openrelayproject',
              credential: 'openrelayproject',
            },
          ],
        },
      })
      peerRef.current = peer

      peer.on('open', () => {
        setPeerStatus('connected')
        setViewMode('broadcast')
      })

      // Handle incoming media calls from viewers
      peer.on('call', (call) => {
        call.answer(stream) // Send our stream back to the viewer

        activeCallsRef.current.set(call.peer, call)

        setViewerCount(activeCallsRef.current.size)

        // We don't need the viewer's (empty) stream
        call.on('stream', () => {})

        call.on('close', () => {
          activeCallsRef.current.delete(call.peer)
          setViewerCount(activeCallsRef.current.size)
        })

        call.on('error', () => {
          activeCallsRef.current.delete(call.peer)
          setViewerCount(activeCallsRef.current.size)
        })
      })

      // Handle incoming data connections (for viewer metadata)
      peer.on('connection', (conn) => {
        activeDataConnsRef.current.set(conn.peer, conn)
        setViewerCount(Math.max(activeCallsRef.current.size, activeDataConnsRef.current.size))

        conn.on('close', () => {
          activeDataConnsRef.current.delete(conn.peer)
        })

        conn.on('error', () => {
          activeDataConnsRef.current.delete(conn.peer)
        })
      })

      peer.on('error', (err) => {
        console.error('[CamaraML] Peer error:', err)
        // If peer ID taken, retry
        if (err.type === 'unavailable-id') {
          stream.getTracks().forEach((t) => t.stop())
          localStreamRef.current = null
          alert('El codigo de sala ya esta en uso. Intenta de nuevo.')
          setViewMode('landing')
        }
      })

      peer.on('disconnected', () => {
        setPeerStatus('disconnected')
        // Try to reconnect
        peer.reconnect()
      })

    } catch (err) {
      console.error('[CamaraML] Camera access error:', err)
      alert('No se pudo acceder a la camara. Asegurate de conceder permisos de camara y microfono.')
    }
  }

  // ============ JOIN AS VIEWER ============
  const joinAsViewer = () => {
    const code = joinRoomInput.trim().toUpperCase()
    if (code.length < 4) return

    setRoomId(code)
    setViewMode('watch')
    setConnectionError('')

    // Destroy the idle peer and create a new one
    if (peerRef.current) {
      peerRef.current.destroy()
    }

    const peer = new Peer(undefined, {
      debug: 0,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
        ],
      },
    })
    peerRef.current = peer

    setPeerStatus('connecting')

    peer.on('open', () => {
      setPeerStatus('connected')
      // Now that we have our peer ID, call the broadcaster
      connectToBroadcaster(peer, code)
    })

    peer.on('error', (err) => {
      console.error('[CamaraML] Viewer peer error:', err)
      if (err.type === 'peer-unavailable') {
        setConnectionError('No se encontro la sala. Verifica el codigo y que el emisor este activo.')
      } else {
        setConnectionError('Error de conexion. Intenta de nuevo.')
      }
    })

    peer.on('disconnected', () => {
      setPeerStatus('disconnected')
      setStreamActive(false)
      setConnectionError('Conexion perdida. Reconectando...')
      peer.reconnect()
    })
  }

  // ============ CONNECT TO BROADCASTER ============
  const connectToBroadcaster = (peer: Peer, broadcasterId: string) => {
    const broadcasterPeerId = `${PEER_PREFIX}${broadcasterId}`

    // Create a data connection first for metadata
    const dataConn = peer.connect(broadcasterPeerId, { reliable: true })
    dataConn.on('open', () => {
      console.log('[VIEWER] Data connection established')
    })
    dataConn.on('error', () => {
      console.error('[VIEWER] Data connection error')
    })

    // Create a media call with an empty stream (we only want to receive)
    const emptyStream = new MediaStream()
    const call = peer.call(broadcasterPeerId, emptyStream)

    if (!call) {
      setConnectionError('No se pudo establecer la conexion de video.')
      return
    }

    setConnectionError('Conectando con la camara...')

    call.on('stream', (remoteStream) => {
      console.log('[VIEWER] Received remote stream')
      setStreamActive(true)
      setConnectionError('')
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream
      }
    })

    call.on('close', () => {
      console.log('[VIEWER] Call closed')
      setStreamActive(false)
      setConnectionError('El emisor ha cerrado la conexion.')
    })

    call.on('error', (err) => {
      console.error('[VIEWER] Call error:', err)
      setStreamActive(false)
      setConnectionError('Error en la conexion de video.')
    })
  }

  // ============ RECORDING ============
  const toggleRecording = () => {
    const stream = localStreamRef.current
    if (!stream) return

    if (!isRecording) {
      let mimeType = 'video/webm'
      if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) mimeType = 'video/webm;codecs=vp9,opus'
      else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) mimeType = 'video/webm;codecs=vp8,opus'

      const recorder = new MediaRecorder(stream, { mimeType })
      recordedChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data)
      }

      recorder.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `CamaraML_${roomId}_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        recordedChunksRef.current = []
      }

      recorder.start(1000)
      mediaRecorderRef.current = recorder
      setIsRecording(true)
      setRecordingTime(0)
      recordingIntervalRef.current = setInterval(() => setRecordingTime((p) => p + 1), 1000)
    } else {
      mediaRecorderRef.current?.stop()
      setIsRecording(false)
      if (recordingIntervalRef.current) {
        clearInterval(recordingIntervalRef.current)
        recordingIntervalRef.current = null
      }
      setRecordingTime(0)
    }
  }

  // ============ CLEANUP ============
  const cleanup = () => {
    // Close all calls
    activeCallsRef.current.forEach((call) => call.close())
    activeCallsRef.current.clear()
    activeDataConnsRef.current.forEach((conn) => conn.close())
    activeDataConnsRef.current.clear()

    // Destroy peer
    if (peerRef.current) {
      peerRef.current.destroy()
      peerRef.current = null
    }

    // Stop local stream
    localStreamRef.current?.getTracks().forEach((t) => t.stop())
    localStreamRef.current = null

    // Stop recording
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
    setIsRecording(false)
    if (recordingIntervalRef.current) {
      clearInterval(recordingIntervalRef.current)
      recordingIntervalRef.current = null
    }

    // Reset video elements
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null
    if (localVideoRef.current) localVideoRef.current.srcObject = null

    // Reset state
    setStreamActive(false)
    setViewerCount(0)
    setConnectionError('')
    setRoomId('')
    setViewMode('landing')
    setRecordingTime(0)
    setPeerStatus('disconnected')

    // Recreate idle peer
    const peer = new Peer(undefined, { debug: 0 })
    peerRef.current = peer
    peer.on('open', () => setPeerStatus('connected'))
    peer.on('disconnected', () => setPeerStatus('disconnected'))
    peer.on('error', () => setPeerStatus('disconnected'))
  }

  // ============ RETRY CONNECTION (Viewer) ============
  const retryConnection = () => {
    cleanup()
    setTimeout(() => {
      setJoinRoomInput(roomId)
      joinAsViewer()
    }, 500)
  }

  // ============ UTILS ============
  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const toggleFullscreen = () => {
    if (!videoContainerRef.current) return
    if (!document.fullscreenElement) {
      videoContainerRef.current.requestFullscreen()
      setIsFullscreen(true)
    } else {
      document.exitFullscreen()
      setIsFullscreen(false)
    }
  }

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const sec = seconds % 60
    if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  const isReady = peerStatus === 'connected'

  // ============ LANDING VIEW ============
  if (viewMode === 'landing') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-lg space-y-8">
          {/* Logo & Title */}
          <div className="text-center space-y-3">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-red-600/20 border border-red-600/30 mb-2">
              <Video className="w-10 h-10 text-red-500" />
            </div>
            <h1 className="text-4xl font-bold tracking-tight">
              <span className="text-red-500">Camara</span>
              <span className="text-foreground">ML</span>
            </h1>
            <p className="text-muted-foreground text-sm max-w-md mx-auto">
              Vigilancia inteligente en tiempo real. Transmite video desde tu dispositivo y permite
              que multiples espectadores lo vean desde cualquier lugar.
            </p>
          </div>

          {/* Connection Status */}
          <div className="flex justify-center">
            <Badge variant={isReady ? 'default' : 'destructive'} className="text-xs">
              {isReady ? (
                <><span className="w-2 h-2 rounded-full bg-emerald-500 mr-1.5 inline-block" />Servidor conectado</>
              ) : (
                <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Conectando...</>
              )}
            </Badge>
          </div>

          {/* Action Cards */}
          <div className="grid gap-4">
            {/* Broadcast Card */}
            <Card className="hover:border-red-600/50 transition-all duration-300">
              <CardContent className="p-6 space-y-4">
                <div className="flex items-center gap-4">
                  <div className="flex-shrink-0 w-14 h-14 rounded-xl bg-red-600/15 border border-red-600/20 flex items-center justify-center">
                    <Radio className="w-7 h-7 text-red-500" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-lg">Iniciar Transmision</h3>
                    <p className="text-muted-foreground text-sm">Activa tu camara para emitir en tiempo real a otros dispositivos</p>
                  </div>
                </div>

                {/* Quality Selector */}
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground font-medium flex items-center gap-1">
                    <Settings className="w-3 h-3" />
                    Calidad de video
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {QUALITY_OPTIONS.map((q) => {
                      const isSelected = selectedQuality === q.value
                      return (
                        <button
                          key={q.value}
                          onClick={() => setSelectedQuality(q.value)}
                          className={`relative flex flex-col items-center p-3 rounded-lg border-2 transition-all duration-200 ${
                            isSelected
                              ? 'border-red-500 bg-red-600/10 text-foreground'
                              : 'border-border bg-muted/50 text-muted-foreground hover:border-red-500/40 hover:bg-red-600/5'
                          }`}
                        >
                          {isSelected && (
                            <div className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 flex items-center justify-center">
                              <Check className="w-2.5 h-2.5 text-white" />
                            </div>
                          )}
                          <span className={`font-bold text-sm ${isSelected ? 'text-red-500' : ''}`}>{q.label}</span>
                          <span className="text-[10px] mt-0.5 opacity-70">{q.width}x{q.height}</span>
                        </button>
                      )
                    })}
                  </div>
                  <p className="text-[11px] text-muted-foreground/70 text-center">
                    {QUALITY_OPTIONS.find(q => q.value === selectedQuality)?.description}
                  </p>
                </div>

                <Button
                  onClick={startBroadcasting}
                  disabled={!isReady}
                  className="w-full bg-red-600 hover:bg-red-700 text-white"
                >
                  <Radio className="w-4 h-4 mr-2" />
                  Comenzar a emitir ({selectedQuality})
                </Button>
              </CardContent>
            </Card>

            {/* Watch Card */}
            <Card className="hover:border-emerald-600/50 transition-all duration-300">
              <CardContent className="p-6 space-y-4">
                <div className="flex items-center gap-4">
                  <div className="flex-shrink-0 w-14 h-14 rounded-xl bg-emerald-600/15 border border-emerald-600/20 flex items-center justify-center">
                    <Eye className="w-7 h-7 text-emerald-500" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-lg">Ver Transmision</h3>
                    <p className="text-muted-foreground text-sm">Ingresa el codigo de sala para ver la camara en vivo</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="Codigo de sala (ej: ABC123)"
                    value={joinRoomInput}
                    onChange={(e) => setJoinRoomInput(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === 'Enter' && joinAsViewer()}
                    maxLength={6}
                    className="font-mono text-center text-lg tracking-widest uppercase"
                    disabled={!isReady}
                  />
                  <Button
                    onClick={joinAsViewer}
                    disabled={!isReady || joinRoomInput.trim().length < 4}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white px-6"
                  >
                    <MonitorPlay className="w-4 h-4 mr-2" />
                    Ver
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Features */}
          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="p-3 rounded-lg bg-muted/50">
              <Shield className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Conexion segura</p>
            </div>
            <div className="p-3 rounded-lg bg-muted/50">
              <Users className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Multi-espectador</p>
            </div>
            <div className="p-3 rounded-lg bg-muted/50">
              <Download className="w-5 h-5 mx-auto mb-1 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">Grabacion local</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ============ BROADCAST VIEW ============
  if (viewMode === 'broadcast') {
    return (
      <div className="min-h-screen flex flex-col">
        {/* Header */}
        <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-10">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={cleanup} className="text-muted-foreground hover:text-foreground">
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <div className="flex items-center gap-2">
                <Video className="w-5 h-5 text-red-500" />
                <span className="font-bold text-lg"><span className="text-red-500">Camara</span>ML</span>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Room Code */}
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted border">
                <span className="text-xs text-muted-foreground hidden sm:inline">Sala:</span>
                <span className="font-mono font-bold tracking-wider text-sm">{roomId}</span>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={copyRoomId}>
                  {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                </Button>
              </div>
              {/* Viewers */}
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted border">
                <Users className="w-4 h-4 text-muted-foreground" />
                <span className="text-sm font-medium">{viewerCount}</span>
                <span className="text-xs text-muted-foreground hidden sm:inline">espectador{viewerCount !== 1 ? 'es' : ''}</span>
              </div>
              {/* Live Badge */}
              <Badge variant="destructive" className="animate-pulse">
                <CircleAlert className="w-3 h-3 mr-1" />
                EN VIVO
              </Badge>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="flex-1 max-w-6xl mx-auto w-full p-4 space-y-4">
          {/* Video */}
          <div ref={videoContainerRef} className="relative bg-black rounded-xl overflow-hidden border border-border aspect-video max-h-[70vh]">
            <video ref={localVideoRef} autoPlay muted playsInline className="w-full h-full object-contain" />

            {/* REC overlay */}
            {isRecording && (
              <div className="absolute top-4 left-4 flex items-center gap-2 bg-black/70 backdrop-blur-sm rounded-full px-3 py-1.5">
                <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
                <span className="text-white text-sm font-medium">REC {formatTime(recordingTime)}</span>
              </div>
            )}

            {/* LIVE + Quality overlay */}
            <div className="absolute top-4 right-4 flex items-center gap-2">
              <Badge variant="destructive" className="bg-red-600">LIVE</Badge>
              <Badge variant="outline" className="bg-black/70 text-white border-white/20 text-xs font-mono">{selectedQuality}</Badge>
            </div>

            {/* Fullscreen */}
            <button onClick={toggleFullscreen} className="absolute bottom-4 right-4 bg-black/50 hover:bg-black/70 text-white rounded-full p-2 transition-colors">
              {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
            </button>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={toggleRecording} variant={isRecording ? 'destructive' : 'default'} size="lg">
              {isRecording ? (
                <><CircleStop className="w-5 h-5 mr-2" />Detener Grabacion</>
              ) : (
                <><div className="w-4 h-4 rounded-full border-2 border-current mr-2" />Iniciar Grabacion</>
              )}
            </Button>
            {isRecording && (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Clock className="w-4 h-4" />
                <span className="font-mono">{formatTime(recordingTime)}</span>
              </div>
            )}
          </div>

          {/* Info Bar */}
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-2"><Webcam className="w-4 h-4" /><span>Camara activa</span></div>
                <div className="flex items-center gap-2"><Badge variant="outline" className="text-xs font-mono">{selectedQuality}</Badge></div>
                <div className="flex items-center gap-2"><Users className="w-4 h-4" /><span>{viewerCount} espectador{viewerCount !== 1 ? 'es' : ''}</span></div>
                <div className="flex items-center gap-2"><Copy className="w-4 h-4" /><span>Codigo: <span className="font-mono font-bold text-foreground">{roomId}</span></span></div>
              </div>
            </CardContent>
          </Card>
        </main>
      </div>
    )
  }

  // ============ WATCH VIEW ============
  if (viewMode === 'watch') {
    return (
      <div className="min-h-screen flex flex-col">
        {/* Header */}
        <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-10">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={cleanup} className="text-muted-foreground hover:text-foreground">
                <ArrowLeft className="w-5 h-5" />
              </Button>
              <div className="flex items-center gap-2">
                <Eye className="w-5 h-5 text-emerald-500" />
                <span className="font-bold text-lg"><span className="text-emerald-500">Viendo</span> Camara</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted border">
                <span className="text-xs text-muted-foreground hidden sm:inline">Sala:</span>
                <span className="font-mono font-bold tracking-wider text-sm">{roomId}</span>
              </div>
              {streamActive && (
                <Badge variant="destructive" className="animate-pulse"><CircleAlert className="w-3 h-3 mr-1" />EN VIVO</Badge>
              )}
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="flex-1 max-w-6xl mx-auto w-full p-4 space-y-4">
          {/* Video */}
          <div ref={videoContainerRef} className="relative bg-black rounded-xl overflow-hidden border border-border aspect-video max-h-[70vh]">
            <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-contain" />

            {/* Loading State */}
            {!streamActive && !connectionError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80">
                <Loader2 className="w-12 h-12 text-emerald-500 animate-spin mb-4" />
                <p className="text-muted-foreground text-sm">Esperando transmision...</p>
                <p className="text-muted-foreground/60 text-xs mt-1">La camara se conectara automaticamente</p>
              </div>
            )}

            {/* Error State */}
            {connectionError && !streamActive && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80">
                <CircleAlert className="w-12 h-12 text-amber-500 mb-4" />
                <p className="text-foreground font-medium text-center px-4">{connectionError}</p>
                <div className="flex gap-2 mt-4">
                  <Button variant="outline" onClick={retryConnection}>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Reintentar
                  </Button>
                  <Button variant="outline" onClick={cleanup}>Volver al inicio</Button>
                </div>
              </div>
            )}

            {/* Live badge */}
            {streamActive && (
              <div className="absolute top-4 right-4">
                <Badge variant="destructive" className="bg-red-600"><CircleAlert className="w-3 h-3 mr-1" />LIVE</Badge>
              </div>
            )}

            {/* Fullscreen */}
            <button onClick={toggleFullscreen} className="absolute bottom-4 right-4 bg-black/50 hover:bg-black/70 text-white rounded-full p-2 transition-colors">
              {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
            </button>
          </div>

          {/* Status */}
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-4 text-sm">
                <div className="flex items-center gap-2">
                  {streamActive ? (
                    <><span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse inline-block" /><span className="text-emerald-500 font-medium">Transmision activa</span></>
                  ) : connectionError ? (
                    <><span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" /><span className="text-amber-500 font-medium">Sin conexion</span></>
                  ) : (
                    <><span className="w-2.5 h-2.5 rounded-full bg-muted-foreground animate-pulse inline-block" /><span className="text-muted-foreground">Conectando...</span></>
                  )}
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MonitorPlay className="w-4 h-4" />
                  <span>Sala: <span className="font-mono font-bold text-foreground">{roomId}</span></span>
                </div>
              </div>
            </CardContent>
          </Card>
        </main>
      </div>
    )
  }

  return null
}
