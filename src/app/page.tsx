'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import Peer, { DataConnection, MediaConnection } from 'peerjs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Video, Radio, Eye, Copy, Check, MonitorPlay,
  Shield, Clock, Users, CircleAlert, CircleStop,
  Download, ArrowLeft, Maximize2, Minimize2,
  Loader2, Settings, RefreshCw, Volume2, VolumeX,
} from 'lucide-react'

type ViewMode = 'landing' | 'broadcast' | 'watch'
type VideoQuality = '720p' | '1080p' | '4K'

interface QualityOption { label: string; value: VideoQuality; width: number; height: number; description: string }

const QUALITY_OPTIONS: QualityOption[] = [
  { label: '720p', value: '720p', width: 1280, height: 720, description: 'HD - Buena calidad, bajo consumo' },
  { label: '1080p', value: '1080p', width: 1920, height: 1080, description: 'Full HD - Calidad alta recomendada' },
  { label: '4K', value: '4K', width: 3840, height: 2160, description: 'Ultra HD - Maxima calidad' },
]

const PEER_PREFIX = 'camaraml-'
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
]

export default function CamaraML() {
  const [viewMode, setViewMode] = useState<ViewMode>('landing')
  const [peerStatus, setPeerStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected')
  const [selectedQuality, setSelectedQuality] = useState<VideoQuality>('1080p')
  const [roomId, setRoomId] = useState('')
  const [joinRoomInput, setJoinRoomInput] = useState('')
  const [copied, setCopied] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const [viewerCount, setViewerCount] = useState(0)
  const [cameraError, setCameraError] = useState('')
  const [streamActive, setStreamActive] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isMuted, setIsMuted] = useState(true)
  const [statusText, setStatusText] = useState('')

  const localStreamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeCallsRef = useRef<Map<string, MediaConnection>>(new Map())
  const activeDataConnsRef = useRef<Map<string, DataConnection>>(new Map())
  const peerRef = useRef<Peer | null>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const dynRemoteVideoRef = useRef<HTMLVideoElement | null>(null)

  const isReady = peerStatus === 'connected'

  const addLog = useCallback((msg: string) => {
    console.log('[CamaraML]', msg)
  }, [])

  useEffect(() => {
    const peer = new Peer(undefined, { debug: 0 })
    peerRef.current = peer
    peer.on('open', () => { setPeerStatus('connected'); addLog('Peer OK') })
    peer.on('disconnected', () => setPeerStatus('disconnected'))
    peer.on('error', (e) => addLog('Peer err: ' + e.type))
    return () => { peer.destroy(); peerRef.current = null }
  }, [addLog])

  const generateRoomId = (): string => {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let r = ''
    for (let i = 0; i < 6; i++) r += c.charAt(Math.floor(Math.random() * c.length))
    return r
  }

  // =============================================
  // BROADCAST: Camera → viewer (broadcaster CALLS viewer)
  // =============================================
  const startBroadcasting = async () => {
    setCameraError('')
    addLog('=== TRANSMISION ===')
    const qc = QUALITY_OPTIONS.find(q => q.value === selectedQuality) || QUALITY_OPTIONS[1]
    let stream: MediaStream | null = null

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: qc.width }, height: { ideal: qc.height }, facingMode: { ideal: 'environment' } },
        audio: true,
      })
    } catch {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: qc.width }, height: { ideal: qc.height } },
          audio: true,
        })
      } catch (e: any) {
        setCameraError('No se pudo acceder a la camara.')
        return
      }
    }

    if (!stream) { setCameraError('Error desconocido.'); return }
    localStreamRef.current = stream

    const v = localVideoRef.current
    if (!v) { setCameraError('Error.'); stream.getTracks().forEach(t => t.stop()); localStreamRef.current = null; return }
    v.srcObject = stream
    try { await v.play() } catch { setCameraError('No reprodujo.'); stream.getTracks().forEach(t => t.stop()); localStreamRef.current = null; return }

    setViewMode('broadcast')

    if (peerRef.current) peerRef.current.destroy()
    const newRoomId = generateRoomId()
    setRoomId(newRoomId)

    const peer = new Peer(`${PEER_PREFIX}${newRoomId}`, {
      debug: 1,
      config: { iceServers: ICE_SERVERS },
    })
    peerRef.current = peer

    peer.on('open', () => addLog('Broadcaster listo: ' + peer.id))

    // *** KEY CHANGE: When a viewer connects via data, BROADCASTER calls the viewer ***
    peer.on('connection', (conn) => {
      addLog('Viewer conectado (data): ' + conn.peer)
      activeDataConnsRef.current.set(conn.peer, conn)

      conn.on('data', (data) => {
        addLog('Mensaje del viewer: ' + JSON.stringify(data))
        // Viewer says "join" with their peer ID — call them with our stream!
        if (data && data.type === 'join') {
          addLog('Llamando al viewer ' + conn.peer + ' con stream...')
          try {
            const call = peer.call(conn.peer, stream)
            if (call) {
              addLog('Call creada hacia ' + conn.peer)
              activeCallsRef.current.set(conn.peer, call)
              setViewerCount(activeCallsRef.current.size)

              call.on('close', () => { activeCallsRef.current.delete(conn.peer); setViewerCount(activeCallsRef.current.size) })
              call.on('error', (err) => { addLog('Call error: ' + err); activeCallsRef.current.delete(conn.peer); setViewerCount(activeCallsRef.current.size) })

              // Monitor ICE
              const pc = call.peerConnection
              if (pc) {
                pc.oniceconnectionstatechange = () => {
                  addLog('Broadcaster ICE: ' + pc.iceConnectionState)
                }
              }
            } else {
              addLog('ERROR: peer.call devolvio NULL')
            }
          } catch (e: any) {
            addLog('ERROR llamando viewer: ' + e.message)
          }
        }
      })

      conn.on('close', () => { activeDataConnsRef.current.delete(conn.peer); setViewerCount(Math.max(0, activeCallsRef.current.size - 1)) })
      conn.on('error', () => { activeDataConnsRef.current.delete(conn.peer) })
    })

    // Also handle legacy direct calls (backward compat)
    peer.on('call', (call) => {
      addLog('Llamada directa recibida de: ' + call.peer)
      call.answer(stream)
      activeCallsRef.current.set(call.peer, call)
      setViewerCount(activeCallsRef.current.size)
      call.on('stream', () => {})
      call.on('close', () => { activeCallsRef.current.delete(call.peer); setViewerCount(activeCallsRef.current.size) })
      call.on('error', () => { activeCallsRef.current.delete(call.peer); setViewerCount(activeCallsRef.current.size) })
    })

    peer.on('error', (err) => {
      addLog('Peer error: ' + err.type)
      if (err.type === 'unavailable-id') { stream.getTracks().forEach(t => t.stop()); localStreamRef.current = null; alert('Sala en uso.'); setViewMode('landing') }
    })
    peer.on('disconnected', () => { setPeerStatus('disconnected'); peer.reconnect() })
  }

  // =============================================
  // VIEWER: Connects via data, receives call from broadcaster
  // =============================================
  const joinAsViewer = () => {
    const code = joinRoomInput.trim().toUpperCase()
    if (code.length < 4) return
    setRoomId(code)
    setViewMode('watch')
    setConnectionError('')
    setStreamActive(false)
    setIsMuted(true)
    setStatusText('Conectando...')
    addLog('Viewer uniendose a: ' + code)

    if (peerRef.current) peerRef.current.destroy()
    const peer = new Peer(undefined, {
      debug: 1,
      config: { iceServers: ICE_SERVERS },
    })
    peerRef.current = peer
    setPeerStatus('connecting')

    peer.on('open', () => {
      addLog('Viewer peer listo: ' + peer.id)
      setPeerStatus('connected')
      setStatusText('Peer listo, conectando con emisor...')

      const pid = `${PEER_PREFIX}${code}`

      // Step 1: Open data connection to broadcaster
      setStatusText('Abriendo canal de datos...')
      const dataConn = peer.connect(pid, { reliable: true })

      dataConn.on('open', () => {
        addLog('Data connection ABIERTA')
        setStatusText('Canal abierto, solicitando video...')

        // Step 2: Tell broadcaster our peer ID so they can call us
        dataConn.send({ type: 'join', peerId: peer.id })
        setStatusText('Solicitando video, esperando llamada...')
      })

      dataConn.on('error', (err) => {
        addLog('Data conn error: ' + err)
        setStatusText('Error en canal de datos')
        setConnectionError('Error de conexion de datos.')
      })

      dataConn.on('close', () => {
        addLog('Data conn cerrada')
        setStreamActive(false)
      })

      // Timeout: if no stream in 15s
      setTimeout(() => {
        if (!streamActive) {
          addLog('TIMEOUT 15s sin stream')
          setStatusText('Tiempo agotado. Reintentando...')
          setConnectionError('No se recibio video. Verifica que el emisor esta activo.')
        }
      }, 15000)
    })

    // Step 3: Broadcaster will call us — receive the call and get the stream
    peer.on('call', (call) => {
      addLog('!!! LLAMADA RECIBIDA del emisor: ' + call.peer)
      setStatusText('Llamada recibida! Estableciendo video...')

      // Answer the call (we don't need to send any stream back)
      // But some browsers need at least an empty stream to answer
      const emptyStream = new MediaStream()
      call.answer(emptyStream)

      // Monitor ICE
      const pc = call.peerConnection
      if (pc) {
        pc.oniceconnectionstatechange = () => {
          const s = pc.iceConnectionState
          addLog('Viewer ICE: ' + s)
          setStatusText('ICE: ' + s)
          if (s === 'failed') {
            setConnectionError('La conexion ICE fallo. Intenta con ambos dispositivos en WiFi.')
            setStatusText('Fallo ICE')
          }
          if (s === 'connected' || s === 'completed') {
            setStatusText('Conectado! Esperando video...')
          }
        }
        pc.onicecandidate = (e) => {
          if (e.candidate) {
            addLog('ICE candidate: ' + e.candidate.type + ' ' + (e.candidate.address || ''))
          } else {
            addLog('ICE candidates completados')
            setStatusText('Negociacion completada, esperando video...')
          }
        }
      }

      call.on('stream', (remoteStream) => {
        addLog('!!! STREAM RECIBIDO del emisor !!!')
        const tracks = remoteStream.getTracks()
        addLog(tracks.length + ' tracks: ' + tracks.map(t => t.kind + ' ' + t.readyState).join(', '))
        setStatusText('Stream recibido! ' + tracks.length + ' tracks')

        // Create video in DOM
        const container = videoContainerRef.current
        if (!container) {
          addLog('container NULL')
          setStatusText('Error: contenedor no encontrado')
          return
        }

        // Remove old
        if (dynRemoteVideoRef.current && dynRemoteVideoRef.current.parentNode) {
          dynRemoteVideoRef.current.parentNode.removeChild(dynRemoteVideoRef.current)
        }

        const video = document.createElement('video')
        video.autoplay = true
        video.muted = true
        video.playsInline = true
        video.setAttribute('playsinline', '')
        video.setAttribute('autoplay', '')
        video.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;z-index:1;background:#000;'
        video.srcObject = remoteStream
        dynRemoteVideoRef.current = video
        container.appendChild(video)

        addLog('Video creado en DOM')

        const tryPlay = () => {
          video.play().then(() => {
            addLog('play() OK vw=' + video.videoWidth + ' vh=' + video.videoHeight)
            setStatusText('Reproduciendo: ' + video.videoWidth + 'x' + video.videoHeight)
          }).catch(e => {
            addLog('play fail: ' + e.message)
          })
        }

        video.onloadedmetadata = () => {
          addLog('metadata: ' + video.videoWidth + 'x' + video.videoHeight)
          setStatusText('Metadata cargada: ' + video.videoWidth + 'x' + video.videoHeight)
          tryPlay()
        }

        video.onloadeddata = () => {
          addLog('data: ' + video.videoWidth + 'x' + video.videoHeight)
          if (video.videoWidth > 0) {
            setStreamActive(true)
            setConnectionError('')
            setStatusText('TRANSMISION ACTIVA')
            addLog('=== VIDEO FUNCIONANDO ===')
            // Unmute after a moment
            setTimeout(() => { video.muted = false; setIsMuted(false) }, 1000)
          }
        }

        video.onresize = () => {
          if (video.videoWidth > 0) {
            setStreamActive(true)
            setConnectionError('')
            setStatusText('TRANSMISION ACTIVA ' + video.videoWidth + 'x' + video.videoHeight)
          }
        }

        video.onpause = () => { tryPlay() }
        video.onerror = (e) => {
          const err = (e.target as HTMLVideoElement).error
          addLog('VIDEO ERR: ' + (err ? err.code + ' ' + err.message : '?'))
          setStatusText('Error de video: ' + (err ? err.message : ''))
        }

        tracks.forEach(track => {
          track.onended = () => { addLog('Track ended: ' + track.kind); setStreamActive(false) }
          track.onmute = () => addLog('Track muted: ' + track.kind)
          track.onunmute = () => addLog('Track unmute: ' + track.kind)
        })

        tryPlay()

        // Retry play if no video after delays
        setTimeout(() => { if (video.videoWidth === 0 && video.srcObject) tryPlay() }, 1000)
        setTimeout(() => { if (video.videoWidth === 0 && video.srcObject) tryPlay() }, 3000)
        setTimeout(() => {
          if (video.videoWidth === 0) {
            addLog('SIN VIDEO tras 8s. Tracks:')
            remoteStream.getTracks().forEach(t => addLog('  ' + t.kind + ' ready=' + t.readyState + ' en=' + t.enabled))
            setStatusText('Track recibida pero sin frames. Ready=' + (tracks[0]?.readyState || '?'))
          }
        }, 8000)
      })

      call.on('close', () => {
        addLog('Call cerrada')
        setStreamActive(false)
        setConnectionError('El emisor cerro la transmision.')
        setStatusText('Transmision terminada')
      })

      call.on('error', (err) => {
        addLog('Call error: ' + err)
        setStreamActive(false)
        setConnectionError('Error en la llamada.')
        setStatusText('Error en llamada')
      })
    })

    peer.on('error', (err) => {
      addLog('Viewer peer err: ' + err.type)
      if (err.type === 'peer-unavailable') {
        setConnectionError('Sala no encontrada. Verifica el codigo.')
        setStatusText('Sala no encontrada')
      } else {
        setConnectionError('Error: ' + err.type)
        setStatusText('Error: ' + err.type)
      }
    })

    peer.on('disconnected', () => {
      setPeerStatus('disconnected')
      setStreamActive(false)
      setConnectionError('Desconectado.')
      setStatusText('Desconectado del servidor')
      peer.reconnect()
    })
  }

  // ============ RECORDING ============
  const toggleRecording = () => {
    const s = localStreamRef.current; if (!s) return
    if (!isRecording) {
      let mime = 'video/webm'
      if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) mime = 'video/webm;codecs=vp9,opus'
      else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) mime = 'video/webm;codecs=vp8,opus'
      const rec = new MediaRecorder(s, { mimeType: mime }); recordedChunksRef.current = []
      rec.ondataavailable = e => { if (e.data.size > 0) recordedChunksRef.current.push(e.data) }
      rec.onstop = () => {
        const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a'); a.href = url
        a.download = `CamaraML_${roomId}_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url)
        recordedChunksRef.current = []
      }
      rec.start(1000); mediaRecorderRef.current = rec; setIsRecording(true); setRecordingTime(0)
      recordingIntervalRef.current = setInterval(() => setRecordingTime(p => p + 1), 1000)
    } else {
      mediaRecorderRef.current?.stop(); setIsRecording(false)
      if (recordingIntervalRef.current) { clearInterval(recordingIntervalRef.current); recordingIntervalRef.current = null }
      setRecordingTime(0)
    }
  }

  // ============ CLEANUP ============
  const cleanup = () => {
    activeCallsRef.current.forEach(c => c.close()); activeCallsRef.current.clear()
    activeDataConnsRef.current.forEach(c => c.close()); activeDataConnsRef.current.clear()
    if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null }
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t => t.stop()); localStreamRef.current = null }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop()
    setIsRecording(false)
    if (recordingIntervalRef.current) { clearInterval(recordingIntervalRef.current); recordingIntervalRef.current = null }
    if (localVideoRef.current) { localVideoRef.current.srcObject = null; localVideoRef.current.load() }
    if (dynRemoteVideoRef.current && dynRemoteVideoRef.current.parentNode) {
      dynRemoteVideoRef.current.parentNode.removeChild(dynRemoteVideoRef.current)
      dynRemoteVideoRef.current = null
    }
    setStreamActive(false); setViewerCount(0); setConnectionError(''); setRoomId('')
    setViewMode('landing'); setRecordingTime(0); setPeerStatus('disconnected'); setCameraError('')
    setIsMuted(true); setStatusText('')
    const peer = new Peer(undefined, { debug: 0 }); peerRef.current = peer
    peer.on('open', () => setPeerStatus('connected'))
    peer.on('disconnected', () => setPeerStatus('disconnected'))
    peer.on('error', () => setPeerStatus('disconnected'))
  }

  const retryConnection = () => { const id = roomId; cleanup(); setTimeout(() => { setJoinRoomInput(id); joinAsViewer() }, 500) }
  const retryCamera = () => { cleanup(); setTimeout(() => startBroadcasting(), 500) }
  const copyRoomId = () => { navigator.clipboard.writeText(roomId); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  const toggleFullscreen = () => {
    if (!videoContainerRef.current) return
    if (!document.fullscreenElement) { videoContainerRef.current.requestFullscreen(); setIsFullscreen(true) }
    else { document.exitFullscreen(); setIsFullscreen(false) }
  }
  const toggleMute = () => {
    if (dynRemoteVideoRef.current) {
      dynRemoteVideoRef.current.muted = !dynRemoteVideoRef.current.muted
      setIsMuted(dynRemoteVideoRef.current.muted)
    }
  }
  const formatTime = (s: number) => {
    const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60
    return h > 0 ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
  }

  // ============ RENDER ============
  return (
    <div className="min-h-screen flex flex-col">

      {viewMode !== 'landing' && (
        <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-30">
          <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={cleanup}><ArrowLeft className="w-5 h-5" /></Button>
              {viewMode === 'broadcast' ? (
                <div className="flex items-center gap-2"><Video className="w-5 h-5 text-red-500" /><span className="font-bold text-lg"><span className="text-red-500">Camara</span>ML</span></div>
              ) : (
                <div className="flex items-center gap-2"><Eye className="w-5 h-5 text-emerald-500" /><span className="font-bold text-lg"><span className="text-emerald-500">Viendo</span> Camara</span></div>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {roomId && (
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted border">
                  <span className="text-xs text-muted-foreground hidden sm:inline">Sala:</span>
                  <span className="font-mono font-bold tracking-wider text-sm">{roomId}</span>
                  {viewMode === 'broadcast' && (
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={copyRoomId}>
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                    </Button>
                  )}
                </div>
              )}
              {viewMode === 'broadcast' && (
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted border">
                  <Users className="w-4 h-4" /><span className="text-sm font-medium">{viewerCount}</span>
                </div>
              )}
              {localStreamRef.current && viewMode === 'broadcast' && (
                <Badge variant="destructive" className="animate-pulse">EN VIVO</Badge>
              )}
              {streamActive && viewMode === 'watch' && (
                <Badge variant="destructive" className="animate-pulse">EN VIVO</Badge>
              )}
            </div>
          </div>
        </header>
      )}

      <div className="w-full max-w-5xl mx-auto px-4 pt-4" style={{ display: viewMode !== 'landing' ? 'block' : 'none' }}>
        <div
          ref={videoContainerRef}
          className="relative bg-black rounded-xl overflow-hidden border border-border"
          style={{ width: '100%', height: '65vh', minHeight: '250px' }}
        >
          <video
            ref={localVideoRef}
            autoPlay muted playsInline
            style={{
              display: viewMode === 'broadcast' ? 'block' : 'none',
              width: '100%', height: '100%', objectFit: 'contain',
              position: 'absolute', top: 0, left: 0, zIndex: 1, background: '#000',
            }}
          />

          {viewMode === 'watch' && !streamActive && !connectionError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80" style={{ zIndex: 10 }}>
              <Loader2 className="w-12 h-12 text-emerald-500 animate-spin mb-4" />
              <p className="text-white text-sm">Conectando con el emisor...</p>
              {statusText && <p className="text-white/60 text-xs mt-2">{statusText}</p>}
              <p className="text-white/30 text-[10px] mt-4">La consola (F12) muestra mas detalle con [CamaraML]</p>
            </div>
          )}

          {viewMode === 'watch' && connectionError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80" style={{ zIndex: 10 }}>
              <CircleAlert className="w-12 h-12 text-amber-500 mb-4" />
              <p className="text-white font-medium text-center px-4">{connectionError}</p>
              {statusText && <p className="text-white/50 text-xs mt-2">{statusText}</p>}
              <div className="flex gap-2 mt-4">
                <Button variant="outline" onClick={retryConnection}><RefreshCw className="w-4 h-4 mr-2" />Reintentar</Button>
                <Button variant="outline" onClick={cleanup}>Volver</Button>
              </div>
            </div>
          )}

          {viewMode === 'broadcast' && !localStreamRef.current && !cameraError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80" style={{ zIndex: 10 }}>
              <Loader2 className="w-12 h-12 text-red-500 animate-spin mb-4" />
              <p className="text-white text-sm">Iniciando camara...</p>
            </div>
          )}

          {viewMode === 'broadcast' && cameraError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80" style={{ zIndex: 10 }}>
              <CircleAlert className="w-12 h-12 text-amber-500 mb-4" />
              <p className="text-white font-medium text-center px-4">{cameraError}</p>
              <div className="flex gap-2 mt-4">
                <Button variant="outline" onClick={retryCamera}><RefreshCw className="w-4 h-4 mr-2" />Reintentar</Button>
                <Button variant="outline" onClick={cleanup}>Volver</Button>
              </div>
            </div>
          )}

          {viewMode === 'broadcast' && isRecording && localStreamRef.current && (
            <div className="absolute top-4 left-4 flex items-center gap-2 bg-black/70 backdrop-blur-sm rounded-full px-3 py-1.5" style={{ zIndex: 10 }}>
              <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
              <span className="text-white text-sm font-medium">REC {formatTime(recordingTime)}</span>
            </div>
          )}

          {viewMode === 'broadcast' && localStreamRef.current && (
            <div className="absolute top-4 right-4 flex items-center gap-2" style={{ zIndex: 10 }}>
              <Badge variant="destructive" className="bg-red-600">LIVE</Badge>
              <Badge variant="outline" className="bg-black/70 text-white border-white/20 text-xs font-mono">{selectedQuality}</Badge>
            </div>
          )}

          {viewMode === 'watch' && streamActive && (
            <div className="absolute top-4 right-4 flex items-center gap-2" style={{ zIndex: 10 }}>
              <Badge variant="destructive" className="bg-red-600">LIVE</Badge>
              <button onClick={toggleMute} className="bg-black/60 hover:bg-black/80 text-white rounded-full p-2">
                {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
            </div>
          )}

          <button onClick={toggleFullscreen} className="absolute bottom-4 right-4 bg-black/50 hover:bg-black/70 text-white rounded-full p-2" style={{ zIndex: 10 }}>
            {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {viewMode === 'landing' && (
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <div className="w-full max-w-lg space-y-8">
            <div className="text-center space-y-3">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-red-600/20 border border-red-600/30 mb-2">
                <Video className="w-10 h-10 text-red-500" />
              </div>
              <h1 className="text-4xl font-bold tracking-tight">
                <span className="text-red-500">Camara</span><span className="text-foreground">ML</span>
              </h1>
              <p className="text-muted-foreground text-sm max-w-md mx-auto">
                Vigilancia inteligente en tiempo real. Transmite video desde tu dispositivo y permite
                que multiples espectadores lo vean desde cualquier lugar.
              </p>
            </div>

            <div className="flex justify-center">
              <Badge variant={isReady ? 'default' : 'destructive'} className="text-xs">
                {isReady ? (
                  <><span className="w-2 h-2 rounded-full bg-emerald-500 mr-1.5 inline-block" />Servidor conectado</>
                ) : (
                  <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Conectando...</>
                )}
              </Badge>
            </div>

            <div className="grid gap-4">
              <Card className="hover:border-red-600/50 transition-all duration-300">
                <CardContent className="p-6 space-y-4">
                  <div className="flex items-center gap-4">
                    <div className="flex-shrink-0 w-14 h-14 rounded-xl bg-red-600/15 border border-red-600/20 flex items-center justify-center">
                      <Radio className="w-7 h-7 text-red-500" />
                    </div>
                    <div className="flex-1">
                      <h3 className="font-semibold text-lg">Iniciar Transmision</h3>
                      <p className="text-muted-foreground text-sm">Activa tu camara para emitir en tiempo real</p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground font-medium flex items-center gap-1"><Settings className="w-3 h-3" /> Calidad de video</p>
                    <div className="grid grid-cols-3 gap-2">
                      {QUALITY_OPTIONS.map(q => {
                        const sel = selectedQuality === q.value
                        return (
                          <button key={q.value} onClick={() => setSelectedQuality(q.value)}
                            className={`relative flex flex-col items-center p-3 rounded-lg border-2 transition-all ${sel ? 'border-red-500 bg-red-600/10' : 'border-border bg-muted/50 hover:border-red-500/40'}`}>
                            {sel && <div className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 flex items-center justify-center"><Check className="w-2.5 h-2.5 text-white" /></div>}
                            <span className={`font-bold text-sm ${sel ? 'text-red-500' : 'text-muted-foreground'}`}>{q.label}</span>
                            <span className="text-[10px] mt-0.5 opacity-70">{q.width}x{q.height}</span>
                          </button>
                        )
                      })}
                    </div>
                    <p className="text-[11px] text-muted-foreground/70 text-center">{QUALITY_OPTIONS.find(q => q.value === selectedQuality)?.description}</p>
                  </div>
                  <Button onClick={startBroadcasting} disabled={!isReady} className="w-full bg-red-600 hover:bg-red-700 text-white">
                    <Radio className="w-4 h-4 mr-2" /> Comenzar a emitir ({selectedQuality})
                  </Button>
                </CardContent>
              </Card>

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
                    <Input placeholder="Codigo de sala" value={joinRoomInput}
                      onChange={e => setJoinRoomInput(e.target.value.toUpperCase())}
                      onKeyDown={e => e.key === 'Enter' && joinAsViewer()}
                      maxLength={6} className="font-mono text-center text-lg tracking-widest uppercase" disabled={!isReady} />
                    <Button onClick={joinAsViewer} disabled={!isReady || joinRoomInput.trim().length < 4}
                      className="bg-emerald-600 hover:bg-emerald-700 text-white px-6">
                      <MonitorPlay className="w-4 h-4 mr-2" /> Ver
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="p-3 rounded-lg bg-muted/50"><Shield className="w-5 h-5 mx-auto mb-1 text-muted-foreground" /><p className="text-xs text-muted-foreground">Conexion segura</p></div>
              <div className="p-3 rounded-lg bg-muted/50"><Users className="w-5 h-5 mx-auto mb-1 text-muted-foreground" /><p className="text-xs text-muted-foreground">Multi-espectador</p></div>
              <div className="p-3 rounded-lg bg-muted/50"><Download className="w-5 h-5 mx-auto mb-1 text-muted-foreground" /><p className="text-xs text-muted-foreground">Grabacion local</p></div>
            </div>
          </div>
        </div>
      )}

      {viewMode === 'broadcast' && (
        <div className="max-w-5xl mx-auto w-full px-4 pb-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={toggleRecording} variant={isRecording ? 'destructive' : 'default'} size="lg" disabled={!localStreamRef.current}>
              {isRecording ? <><CircleStop className="w-5 h-5 mr-2" />Detener Grabacion</> : <><div className="w-4 h-4 rounded-full border-2 border-current mr-2" />Iniciar Grabacion</>}
            </Button>
            {isRecording && <div className="flex items-center gap-2 text-muted-foreground text-sm"><Clock className="w-4 h-4" /><span className="font-mono">{formatTime(recordingTime)}</span></div>}
          </div>
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <span className={`w-2.5 h-2.5 rounded-full inline-block ${localStreamRef.current ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                  <span>{localStreamRef.current ? 'Camara activa' : 'Iniciando...'}</span>
                </div>
                <Badge variant="outline" className="text-xs font-mono">{selectedQuality}</Badge>
                <div className="flex items-center gap-2"><Users className="w-4 h-4" /><span>{viewerCount} espectador{viewerCount !== 1 ? 'es' : ''}</span></div>
                {roomId && <span>Codigo: <span className="font-mono font-bold text-foreground">{roomId}</span></span>}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {viewMode === 'watch' && (
        <div className="max-w-5xl mx-auto w-full px-4 pb-4 space-y-4">
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
                {statusText && <span className="text-xs text-muted-foreground/60">{statusText}</span>}
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MonitorPlay className="w-4 h-4" />
                  <span>Sala: <span className="font-mono font-bold text-foreground">{roomId}</span></span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

    </div>
  )
}