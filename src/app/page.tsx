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
  ZoomIn, ZoomOut, ChevronUp, ChevronDown, ChevronLeft, ChevronRight,
  Mic, MicOff, Bell, BellOff, Signal, CircleDot,
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
  // ===================== STATE =====================
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

  // New features state
  const [showTimestamp, setShowTimestamp] = useState(true)
  const [currentTime, setCurrentTime] = useState('')
  const [zoomLevel, setZoomLevel] = useState(1)
  const [isMicActive, setIsMicActive] = useState(false)
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [viewerRecording, setViewerRecording] = useState(false)
  const [viewerRecTime, setViewerRecTime] = useState(0)
  const [connStats, setConnStats] = useState({ rtt: 0, bitrate: 0, packetsLost: 0 })

  // ===================== REFS =====================
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

  // New feature refs
  const micStreamRef = useRef<MediaStream | null>(null)
  const outgoingCallRef = useRef<MediaConnection | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const viewerPcRef = useRef<RTCPeerConnection | null>(null)
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const prevBytesRef = useRef(0)
  const viewerAudioElementsRef = useRef<Map<string, HTMLAudioElement>>(new Map())
  const viewerMediaRecorderRef = useRef<MediaRecorder | null>(null)
  const viewerChunksRef = useRef<Blob[]>([])
  const viewerRecIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const zoomRef = useRef(1)
  const panXRef = useRef(0)
  const panYRef = useRef(0)
  const soundEnabledRef = useRef(true)

  const isReady = peerStatus === 'connected'

  // ===================== UTILITIES =====================
  const addLog = useCallback((msg: string) => {
    console.log('[CamaraML]', msg)
  }, [])

  const playSound = useCallback((type: 'in' | 'out') => {
    if (!soundEnabledRef.current) return
    try {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.frequency.value = type === 'in' ? 880 : 440
      osc.type = type === 'in' ? 'sine' : 'triangle'
      gain.gain.setValueAtTime(0.15, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.2)
    } catch {}
  }, [])

  const generateRoomId = (): string => {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let r = ''
    for (let i = 0; i < 6; i++) r += c.charAt(Math.floor(Math.random() * c.length))
    return r
  }

  const formatTime = (s: number) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
    return h > 0 ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  // ===================== EFFECTS =====================
  // Peer initialization
  useEffect(() => {
    const peer = new Peer(undefined, { debug: 0 })
    peerRef.current = peer
    peer.on('open', () => { setPeerStatus('connected'); addLog('Peer OK') })
    peer.on('disconnected', () => setPeerStatus('disconnected'))
    peer.on('error', (e) => addLog('Peer err: ' + e.type))
    return () => { peer.destroy(); peerRef.current = null }
  }, [addLog])

  // Timestamp updater - runs every second
  useEffect(() => {
    const update = () => {
      const now = new Date()
      setCurrentTime(now.toLocaleString('es-ES', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }))
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [])

  // Stats polling for viewer - starts when stream is active
  useEffect(() => {
    if (viewMode !== 'watch' || !streamActive) {
      if (statsIntervalRef.current) {
        clearInterval(statsIntervalRef.current)
        statsIntervalRef.current = null
      }
      return
    }

    prevBytesRef.current = 0
    statsIntervalRef.current = setInterval(async () => {
      const pc = viewerPcRef.current
      if (!pc) return
      try {
        const stats = await pc.getStats()
        let rtt = 0, packetsLost = 0, bytesReceived = 0
        stats.forEach((report: any) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            packetsLost = report.packetsLost || 0
            bytesReceived = report.bytesReceived || 0
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            rtt = report.currentRoundTripTime || 0
          }
        })
        const prev = prevBytesRef.current
        const bitrate = prev > 0 ? Math.round(((bytesReceived - prev) * 4) / 1000) : 0
        prevBytesRef.current = bytesReceived
        setConnStats({ rtt: Math.round(rtt * 1000), bitrate, packetsLost })
      } catch {}
    }, 2000)

    return () => {
      if (statsIntervalRef.current) {
        clearInterval(statsIntervalRef.current)
        statsIntervalRef.current = null
      }
    }
  }, [viewMode, streamActive])

  // ===================== ZOOM / PAN =====================
  const applyVideoTransform = useCallback(() => {
    const t = `translate(${panXRef.current}px, ${panYRef.current}px) scale(${zoomRef.current})`
    if (dynRemoteVideoRef.current) dynRemoteVideoRef.current.style.transform = t
    if (localVideoRef.current) localVideoRef.current.style.transform = t
  }, [])

  const handleZoomChange = useCallback((val: number) => {
    const newZoom = Math.max(1, Math.min(5, val))
    zoomRef.current = newZoom
    setZoomLevel(newZoom)
    applyVideoTransform()
  }, [applyVideoTransform])

  const handlePan = useCallback((dx: number, dy: number) => {
    panXRef.current -= dx * 25
    panYRef.current -= dy * 25
    applyVideoTransform()
  }, [applyVideoTransform])

  const resetView = useCallback(() => {
    zoomRef.current = 1
    panXRef.current = 0
    panYRef.current = 0
    setZoomLevel(1)
    applyVideoTransform()
  }, [applyVideoTransform])

  // ===================== MIC (viewer talks to broadcaster) =====================
  const toggleViewerMic = useCallback(async () => {
    if (isMicActive) {
      micStreamRef.current?.getTracks().forEach(t => t.stop())
      micStreamRef.current = null
      if (outgoingCallRef.current) {
        outgoingCallRef.current.close()
        outgoingCallRef.current = null
      }
      setIsMicActive(false)
      addLog('Mic desactivado')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      micStreamRef.current = stream
      const peer = peerRef.current
      if (!peer) { stream.getTracks().forEach(t => t.stop()); return }
      const call = peer.call(`${PEER_PREFIX}${roomId}`, stream)
      if (call) {
        outgoingCallRef.current = call
        setIsMicActive(true)
        addLog('Mic activado, enviando audio al emisor')
        call.on('close', () => {
          setIsMicActive(false)
          micStreamRef.current?.getTracks().forEach(t => t.stop())
          micStreamRef.current = null
          outgoingCallRef.current = null
          addLog('Mic call cerrada')
        })
        call.on('error', () => {
          setIsMicActive(false)
          micStreamRef.current?.getTracks().forEach(t => t.stop())
          micStreamRef.current = null
        })
      }
    } catch (e: any) {
      addLog('Mic error: ' + e.message)
    }
  }, [isMicActive, roomId, addLog])

  // ===================== VIEWER RECORDING =====================
  const toggleViewerRecording = useCallback(() => {
    const s = remoteStreamRef.current
    if (!s) { addLog('No hay stream para grabar'); return }
    if (!viewerRecording) {
      let mime = 'video/webm'
      if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) mime = 'video/webm;codecs=vp9,opus'
      else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) mime = 'video/webm;codecs=vp8,opus'
      const rec = new MediaRecorder(s, { mimeType: mime })
      viewerChunksRef.current = []
      rec.ondataavailable = e => { if (e.data.size > 0) viewerChunksRef.current.push(e.data) }
      rec.onstop = () => {
        const blob = new Blob(viewerChunksRef.current, { type: 'video/webm' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `CamaraML_viewer_${roomId}_${Date.now()}.webm`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
        viewerChunksRef.current = []
        addLog('Grabacion del espectador descargada')
      }
      rec.start(1000)
      viewerMediaRecorderRef.current = rec
      setViewerRecording(true)
      setViewerRecTime(0)
      viewerRecIntervalRef.current = setInterval(() => setViewerRecTime(p => p + 1), 1000)
      addLog('Grabacion del espectador iniciada')
    } else {
      viewerMediaRecorderRef.current?.stop()
      setViewerRecording(false)
      if (viewerRecIntervalRef.current) { clearInterval(viewerRecIntervalRef.current); viewerRecIntervalRef.current = null }
      setViewerRecTime(0)
    }
  }, [viewerRecording, roomId, addLog])

  // ===================== BROADCASTER =====================
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

    // When a viewer connects via data, broadcaster CALLS the viewer with video
    peer.on('connection', (conn) => {
      addLog('Viewer conectado (data): ' + conn.peer)
      activeDataConnsRef.current.set(conn.peer, conn)

      conn.on('open', () => {
        playSound('in')
      })

      conn.on('data', (data) => {
        if (data && data.type === 'join') {
          addLog('Llamando al viewer ' + conn.peer + ' con stream...')
          try {
            const call = peer.call(conn.peer, stream)
            if (call) {
              addLog('Call creada hacia ' + conn.peer)
              activeCallsRef.current.set(conn.peer, call)
              setViewerCount(activeCallsRef.current.size)

              call.on('close', () => {
                activeCallsRef.current.delete(conn.peer)
                setViewerCount(activeCallsRef.current.size)
                playSound('out')
              })
              call.on('error', (err) => {
                addLog('Call error: ' + err)
                activeCallsRef.current.delete(conn.peer)
                setViewerCount(activeCallsRef.current.size)
              })

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

      conn.on('close', () => {
        activeDataConnsRef.current.delete(conn.peer)
        setViewerCount(Math.max(0, activeCallsRef.current.size))
        playSound('out')
      })
      conn.on('error', () => { activeDataConnsRef.current.delete(conn.peer) })
    })

    // Handle incoming calls (mic from viewers, or legacy video calls)
    peer.on('call', (call) => {
      addLog('Llamada recibida de: ' + call.peer)
      call.answer(stream)

      call.on('stream', (remoteStream) => {
        const hasVideo = remoteStream.getVideoTracks().length > 0
        if (!hasVideo) {
          // This is a mic call from a viewer - play audio only
          addLog('Audio de mic recibido de viewer: ' + call.peer)
          const audio = new Audio()
          audio.srcObject = remoteStream
          audio.play().catch(() => {})
          viewerAudioElementsRef.current.set(call.peer, audio)
        }
      })

      activeCallsRef.current.set(call.peer, call)
      setViewerCount(activeCallsRef.current.size)

      call.on('stream', () => {})
      call.on('close', () => {
        // Stop viewer audio if any
        const audio = viewerAudioElementsRef.current.get(call.peer)
        if (audio) { audio.pause(); audio.srcObject = null; viewerAudioElementsRef.current.delete(call.peer) }
        activeCallsRef.current.delete(call.peer)
        setViewerCount(activeCallsRef.current.size)
        playSound('out')
      })
      call.on('error', () => {
        const audio = viewerAudioElementsRef.current.get(call.peer)
        if (audio) { audio.pause(); audio.srcObject = null; viewerAudioElementsRef.current.delete(call.peer) }
        activeCallsRef.current.delete(call.peer)
        setViewerCount(activeCallsRef.current.size)
      })
    })

    peer.on('error', (err) => {
      addLog('Peer error: ' + err.type)
      if (err.type === 'unavailable-id') { stream.getTracks().forEach(t => t.stop()); localStreamRef.current = null; alert('Sala en uso.'); setViewMode('landing') }
    })
    peer.on('disconnected', () => { setPeerStatus('disconnected'); peer.reconnect() })
  }

  // ===================== VIEWER =====================
  const joinAsViewer = () => {
    const code = joinRoomInput.trim().toUpperCase()
    if (code.length < 4) return
    setRoomId(code)
    setViewMode('watch')
    setConnectionError('')
    setStreamActive(false)
    setIsMuted(true)
    setStatusText('Conectando...')
    setConnStats({ rtt: 0, bitrate: 0, packetsLost: 0 })
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

      setStatusText('Abriendo canal de datos...')
      const dataConn = peer.connect(pid, { reliable: true })

      dataConn.on('open', () => {
        addLog('Data connection ABIERTA')
        setStatusText('Canal abierto, solicitando video...')
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

      setTimeout(() => {
        if (!streamActive) {
          addLog('TIMEOUT 15s sin stream')
          setStatusText('Tiempo agotado. Reintentando...')
          setConnectionError('No se recibio video. Verifica que el emisor esta activo.')
        }
      }, 15000)
    })

    // Broadcaster will call us - receive the call and get the stream
    peer.on('call', (call) => {
      addLog('!!! LLAMADA RECIBIDA del emisor: ' + call.peer)
      setStatusText('Llamada recibida! Estableciendo video...')

      // Check if it's our main video call (from broadcaster)
      const remotePeer = call.peer
      const isMainCall = remotePeer.startsWith(PEER_PREFIX)

      if (!isMainCall) {
        // Not the main broadcaster - answer with empty stream
        const emptyStream = new MediaStream()
        call.answer(emptyStream)
        call.on('stream', (s) => {
          const hasVideo = s.getVideoTracks().length > 0
          if (!hasVideo) {
            addLog('Audio recibido (non-main call)')
          }
        })
        return
      }

      const emptyStream = new MediaStream()
      call.answer(emptyStream)

      // Save PC ref for stats
      viewerPcRef.current = call.peerConnection

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

        // Save remote stream ref for recording
        remoteStreamRef.current = remoteStream

        // Create video in DOM
        const container = videoContainerRef.current
        if (!container) {
          addLog('container NULL')
          setStatusText('Error: contenedor no encontrado')
          return
        }

        // Remove old remote video
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
        // Apply current zoom/pan
        video.style.transform = `translate(${panXRef.current}px, ${panYRef.current}px) scale(${zoomRef.current})`
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
            playSound('in')
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

        setTimeout(() => { if (video.videoWidth === 0 && video.srcObject) tryPlay() }, 1000)
        setTimeout(() => { if (video.videoWidth === 0 && video.srcObject) tryPlay() }, 3000)
        setTimeout(() => {
          if (video.videoWidth === 0) {
            addLog('SIN VIDEO tras 8s. Tracks:')
            remoteStream.getTracks().forEach(t => addLog('  ' + t.kind + ' ready=' + t.readyState + ' en=' + t.enabled))
            setStatusText('Track recibida pero sin frames.')
          }
        }, 8000)
      })

      call.on('close', () => {
        addLog('Call cerrada')
        setStreamActive(false)
        setConnectionError('El emisor cerro la transmision.')
        setStatusText('Transmision terminada')
        playSound('out')
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

  // ===================== BROADCASTER RECORDING =====================
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

  // ===================== CLEANUP =====================
  const cleanup = () => {
    activeCallsRef.current.forEach(c => c.close()); activeCallsRef.current.clear()
    activeDataConnsRef.current.forEach(c => c.close()); activeDataConnsRef.current.clear()
    if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null }

    // Stop local stream
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t => t.stop()); localStreamRef.current = null }

    // Stop broadcaster recording
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop()
    setIsRecording(false)
    if (recordingIntervalRef.current) { clearInterval(recordingIntervalRef.current); recordingIntervalRef.current = null }

    // Stop viewer mic
    micStreamRef.current?.getTracks().forEach(t => t.stop())
    micStreamRef.current = null
    if (outgoingCallRef.current) { outgoingCallRef.current.close(); outgoingCallRef.current = null }
    setIsMicActive(false)

    // Stop viewer recording
    if (viewerMediaRecorderRef.current && viewerMediaRecorderRef.current.state !== 'inactive') viewerMediaRecorderRef.current.stop()
    if (viewerRecIntervalRef.current) { clearInterval(viewerRecIntervalRef.current); viewerRecIntervalRef.current = null }
    setViewerRecording(false)
    setViewerRecTime(0)

    // Stop stats polling
    if (statsIntervalRef.current) { clearInterval(statsIntervalRef.current); statsIntervalRef.current = null }

    // Clear viewer audio elements (broadcaster side)
    viewerAudioElementsRef.current.forEach(a => { a.pause(); a.srcObject = null })
    viewerAudioElementsRef.current.clear()

    // Clear video elements
    if (localVideoRef.current) { localVideoRef.current.srcObject = null; localVideoRef.current.load() }
    if (dynRemoteVideoRef.current && dynRemoteVideoRef.current.parentNode) {
      dynRemoteVideoRef.current.parentNode.removeChild(dynRemoteVideoRef.current)
      dynRemoteVideoRef.current = null
    }

    // Reset refs
    remoteStreamRef.current = null
    viewerPcRef.current = null
    prevBytesRef.current = 0

    // Reset zoom/pan
    zoomRef.current = 1
    panXRef.current = 0
    panYRef.current = 0
    setZoomLevel(1)

    // Reset states
    setStreamActive(false); setViewerCount(0); setConnectionError(''); setRoomId('')
    setViewMode('landing'); setRecordingTime(0); setPeerStatus('disconnected'); setCameraError('')
    setIsMuted(true); setStatusText('')
    setConnStats({ rtt: 0, bitrate: 0, packetsLost: 0 })

    // Recreate default peer
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

  // ===================== RENDER =====================
  return (
    <div className="min-h-screen flex flex-col">

      {/* ===== HEADER ===== */}
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
              {/* Sound toggle in header */}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => { soundEnabledRef.current = !soundEnabledRef.current; setSoundEnabled(soundEnabledRef.current) }}
                title={soundEnabled ? 'Desactivar sonidos' : 'Activar sonidos'}
              >
                {soundEnabled ? <Bell className="w-4 h-4 text-amber-500" /> : <BellOff className="w-4 h-4 text-muted-foreground" />}
              </Button>
            </div>
          </div>
        </header>
      )}

      {/* ===== VIDEO CONTAINER ===== */}
      <div className="w-full max-w-5xl mx-auto px-4 pt-4" style={{ display: viewMode !== 'landing' ? 'block' : 'none' }}>
        <div
          ref={videoContainerRef}
          className="relative bg-black rounded-xl overflow-hidden border border-border"
          style={{ width: '100%', height: '65vh', minHeight: '250px' }}
        >
          {/* Local video (broadcaster) */}
          <video
            ref={localVideoRef}
            autoPlay muted playsInline
            style={{
              display: viewMode === 'broadcast' ? 'block' : 'none',
              width: '100%', height: '100%', objectFit: 'contain',
              position: 'absolute', top: 0, left: 0, zIndex: 1, background: '#000',
            }}
          />

          {/* Viewer connecting overlay */}
          {viewMode === 'watch' && !streamActive && !connectionError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80" style={{ zIndex: 10 }}>
              <Loader2 className="w-12 h-12 text-emerald-500 animate-spin mb-4" />
              <p className="text-white text-sm">Conectando con el emisor...</p>
              {statusText && <p className="text-white/60 text-xs mt-2">{statusText}</p>}
            </div>
          )}

          {/* Viewer error overlay */}
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

          {/* Broadcaster loading overlay */}
          {viewMode === 'broadcast' && !localStreamRef.current && !cameraError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80" style={{ zIndex: 10 }}>
              <Loader2 className="w-12 h-12 text-red-500 animate-spin mb-4" />
              <p className="text-white text-sm">Iniciando camara...</p>
            </div>
          )}

          {/* Broadcaster error overlay */}
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

          {/* Timestamp overlay */}
          {showTimestamp && (viewMode === 'broadcast' || viewMode === 'watch') && currentTime && (
            <div
              className="absolute bottom-4 left-4 bg-black/70 backdrop-blur-sm text-white text-xs font-mono px-2.5 py-1 rounded"
              style={{ zIndex: 15 }}
            >
              {currentTime}
            </div>
          )}

          {/* Broadcaster recording indicator */}
          {viewMode === 'broadcast' && isRecording && localStreamRef.current && (
            <div className="absolute top-4 left-4 flex items-center gap-2 bg-black/70 backdrop-blur-sm rounded-full px-3 py-1.5" style={{ zIndex: 15 }}>
              <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
              <span className="text-white text-sm font-medium">REC {formatTime(recordingTime)}</span>
            </div>
          )}

          {/* Broadcaster LIVE badge */}
          {viewMode === 'broadcast' && localStreamRef.current && (
            <div className="absolute top-4 right-4 flex items-center gap-2" style={{ zIndex: 15 }}>
              <Badge variant="destructive" className="bg-red-600">LIVE</Badge>
              <Badge variant="outline" className="bg-black/70 text-white border-white/20 text-xs font-mono">{selectedQuality}</Badge>
            </div>
          )}

          {/* Viewer LIVE + controls overlay */}
          {viewMode === 'watch' && streamActive && (
            <div className="absolute top-4 right-4 flex items-center gap-2" style={{ zIndex: 15 }}>
              <Badge variant="destructive" className="bg-red-600">LIVE</Badge>
              {/* Viewer recording indicator on video */}
              {viewerRecording && (
                <div className="flex items-center gap-1.5 bg-red-600 rounded-full px-2.5 py-1">
                  <div className="w-2.5 h-2.5 rounded-full bg-white animate-pulse" />
                  <span className="text-white text-xs font-medium">REC {formatTime(viewerRecTime)}</span>
                </div>
              )}
              {/* Mic indicator on video */}
              {isMicActive && (
                <div className="flex items-center gap-1.5 bg-emerald-600 rounded-full px-2.5 py-1">
                  <Mic className="w-3 h-3 text-white" />
                  <span className="text-white text-xs font-medium">MIC</span>
                </div>
              )}
              <button onClick={toggleMute} className="bg-black/60 hover:bg-black/80 text-white rounded-full p-2" title={isMuted ? 'Activar sonido' : 'Silenciar'}>
                {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              </button>
            </div>
          )}

          {/* Connection stats overlay on video (viewer) */}
          {viewMode === 'watch' && streamActive && connStats.bitrate > 0 && (
            <div className="absolute bottom-4 right-4 flex items-center gap-3 bg-black/60 backdrop-blur-sm text-white text-[10px] font-mono px-2.5 py-1 rounded" style={{ zIndex: 15 }}>
              <div className="flex items-center gap-1"><Signal className="w-3 h-3 text-emerald-400" />{connStats.rtt}ms</div>
              <div>{connStats.bitrate} kbps</div>
            </div>
          )}

          {/* Fullscreen button */}
          <button onClick={toggleFullscreen} className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/50 hover:bg-black/70 text-white rounded-full p-2" style={{ zIndex: 15 }}>
            {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* ===== LANDING PAGE ===== */}
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

      {/* ===== BROADCASTER CONTROLS ===== */}
      {viewMode === 'broadcast' && (
        <div className="max-w-5xl mx-auto w-full px-4 pb-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={toggleRecording} variant={isRecording ? 'destructive' : 'default'} size="lg" disabled={!localStreamRef.current}>
              {isRecording ? <><CircleStop className="w-5 h-5 mr-2" />Detener Grabacion</> : <><div className="w-4 h-4 rounded-full border-2 border-current mr-2" />Iniciar Grabacion</>}
            </Button>
            {isRecording && <div className="flex items-center gap-2 text-muted-foreground text-sm"><Clock className="w-4 h-4" /><span className="font-mono">{formatTime(recordingTime)}</span></div>}
            {/* Timestamp toggle for broadcaster */}
            <Button
              variant={showTimestamp ? 'default' : 'outline'}
              size="sm"
              onClick={() => setShowTimestamp(!showTimestamp)}
            >
              <Clock className="w-4 h-4 mr-2" />
              {showTimestamp ? 'Ocultar hora' : 'Mostrar hora'}
            </Button>
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

      {/* ===== VIEWER CONTROLS ===== */}
      {viewMode === 'watch' && (
        <div className="max-w-5xl mx-auto w-full px-4 pb-4 space-y-3">

          {/* Zoom and Pan Controls */}
          <Card>
            <CardContent className="p-4 space-y-3">
              {/* Zoom slider */}
              <div className="flex items-center gap-3">
                <ZoomOut className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <input
                  type="range" min="1" max="5" step="0.25" value={zoomLevel}
                  onChange={e => handleZoomChange(parseFloat(e.target.value))}
                  className="flex-1 h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-emerald-500"
                />
                <ZoomIn className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                <span className="text-xs font-mono text-muted-foreground w-12 text-right">{zoomLevel.toFixed(2)}x</span>
                <Button variant="ghost" size="sm" onClick={resetView} className="text-xs h-7 px-2">
                  Reset
                </Button>
              </div>

              {/* Direction pad */}
              <div className="flex items-center gap-4">
                <div className="grid grid-cols-3 gap-1" style={{ gridTemplateRows: 'auto auto auto' }}>
                  <div />
                  <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => handlePan(0, -1)}>
                    <ChevronUp className="w-4 h-4" />
                  </Button>
                  <div />
                  <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => handlePan(-1, 0)}>
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => handlePan(0, 1)}>
                    <ChevronDown className="w-4 h-4" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => handlePan(1, 0)}>
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
                <span className="text-[10px] text-muted-foreground/70">Mover camara</span>
              </div>
            </CardContent>
          </Card>

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-2">
            {/* Mic toggle */}
            <Button
              variant={isMicActive ? 'default' : 'outline'}
              size="sm"
              onClick={toggleViewerMic}
              className={isMicActive ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}
            >
              {isMicActive ? <><MicOff className="w-4 h-4 mr-2" />Desactivar Mic</> : <><Mic className="w-4 h-4 mr-2" />Activar Mic</>}
            </Button>

            {/* Viewer recording */}
            <Button
              variant={viewerRecording ? 'destructive' : 'outline'}
              size="sm"
              onClick={toggleViewerRecording}
              disabled={!streamActive}
            >
              {viewerRecording
                ? <><CircleStop className="w-4 h-4 mr-2" />Detener ({formatTime(viewerRecTime)})</>
                : <><CircleDot className="w-4 h-4 mr-2" />Grabar transmision</>
              }
            </Button>

            {/* Timestamp toggle */}
            <Button
              variant={showTimestamp ? 'default' : 'outline'}
              size="sm"
              onClick={() => setShowTimestamp(!showTimestamp)}
            >
              <Clock className="w-4 h-4 mr-2" />
              {showTimestamp ? 'Ocultar hora' : 'Mostrar hora'}
            </Button>

            {/* Sound toggle */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => { soundEnabledRef.current = !soundEnabledRef.current; setSoundEnabled(soundEnabledRef.current) }}
            >
              {soundEnabled ? <><Bell className="w-4 h-4 mr-2 text-amber-500" />Sonido On</> : <><BellOff className="w-4 h-4 mr-2" />Sonido Off</>}
            </Button>
          </div>

          {/* Connection Quality Stats */}
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

              {/* Detailed stats */}
              {streamActive && (
                <div className="flex flex-wrap items-center gap-4 mt-3 pt-3 border-t text-xs text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <Signal className="w-3.5 h-3.5" />
                    <span>RTT: <span className="font-mono text-foreground">{connStats.rtt}ms</span></span>
                  </div>
                  <div>
                    <span>Bitrate: <span className="font-mono text-foreground">{connStats.bitrate > 0 ? connStats.bitrate + ' kbps' : 'calculando...'}</span></span>
                  </div>
                  <div>
                    <span>Packets lost: <span className="font-mono text-foreground">{connStats.packetsLost}</span></span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

    </div>
  )
}