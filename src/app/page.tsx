'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import Peer, { DataConnection, MediaConnection } from 'peerjs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Video, Radio, Eye, Copy, Check, MonitorPlay, Shield, Clock, Users,
  CircleAlert, CircleStop, Download, ArrowLeft, Webcam, Maximize2, Minimize2,
  Loader2, Settings, RefreshCw, Bug,
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
  const [debugLog, setDebugLog] = useState<string[]>([])
  const localStreamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordedChunksRef = useRef<Blob[]>([])
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeCallsRef = useRef<Map<string, MediaConnection>>(new Map())
  const activeDataConnsRef = useRef<Map<string, DataConnection>>(new Map())
  const peerRef = useRef<Peer | null>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const isReady = peerStatus === 'connected'

  const addLog = useCallback((msg: string) => {
    console.log('[CamaraML]', msg)
    setDebugLog(prev => [...prev.slice(-29), msg])
  }, [])

  useEffect(() => {
    const peer = new Peer(undefined, { debug: 0 })
    peerRef.current = peer
    peer.on('open', () => { setPeerStatus('connected'); addLog('Peer OK') })
    peer.on('disconnected', () => setPeerStatus('disconnected'))
    peer.on('error', (e) => addLog('Peer error: ' + e.type))
    return () => { peer.destroy(); peerRef.current = null }
  }, [addLog])

  const generateRoomId = () => {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let r = ''
    for (let i = 0; i < 6; i++) r += c.charAt(Math.floor(Math.random() * c.length))
    return r
  }

  const attachStream = useCallback((stream: MediaStream, el: HTMLVideoElement | null, label: string): boolean => {
    if (!el) { addLog(`${label}: videoEl NULL`); return false }
    try {
      el.srcObject = stream
      addLog(`${label}: srcObject OK (${stream.getTracks().length} tracks)`)
      const p = el.play()
      if (p && p.then) p.then(() => addLog(`${label}: play() OK`)).catch(err => {
        addLog(`${label}: play() fail: ${err.message}`)
        setTimeout(() => el.play().catch(e => addLog(`${label}: retry fail: ${e.message}`)), 500)
      })
      return true
    } catch (err: any) { addLog(`${label}: EX: ${err.message}`); return false }
  }, [addLog])

  const startBroadcasting = async () => {
    setCameraError(''); addLog('=== INICIANDO ===')
    const qc = QUALITY_OPTIONS.find(q => q.value === selectedQuality) || QUALITY_OPTIONS[1]
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: qc.width }, height: { ideal: qc.height }, facingMode: { ideal: 'environment' } }, audio: true })
      addLog('Camara OK')
    } catch (e1: any) {
      addLog('Env fail: ' + e1.name)
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: qc.width }, height: { ideal: qc.height } }, audio: true })
        addLog('Camara fallback OK')
      } catch (e2: any) { addLog('ALL fail: ' + e2.message); setCameraError('No se pudo acceder a la cámara.'); return }
    }
    if (!stream) { setCameraError('Error desconocido.'); return }
    localStreamRef.current = stream
    const tracks = stream.getTracks()
    addLog(`Tracks: ${tracks.map(t => `${t.kind}(${t.label}) ready=${t.readyState}`).join(', ')}`)
    const v = localVideoRef.current
    if (!v) { addLog('CRIT: ref null'); setCameraError('Error del navegador.'); stream.getTracks().forEach(t => t.stop()); localStreamRef.current = null; return }
    if (!attachStream(stream, v, 'LOCAL')) { setCameraError('No se pudo conectar.'); stream.getTracks().forEach(t => t.stop()); localStreamRef.current = null; return }
    setViewMode('broadcast'); addLog('Vista → broadcast')
    if (peerRef.current) peerRef.current.destroy()
    const newRoomId = generateRoomId(); setRoomId(newRoomId); addLog('Sala: ' + newRoomId)
    const peer = new Peer(`${PEER_PREFIX}${newRoomId}`, { debug: 0, config: { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    ] } })
    peerRef.current = peer
    peer.on('open', () => addLog('Peer open'))
    peer.on('call', call => { call.answer(stream); activeCallsRef.current.set(call.peer, call); setViewerCount(activeCallsRef.current.size); addLog('Viewer: ' + call.peer); call.on('stream', () => {}); call.on('close', () => { activeCallsRef.current.delete(call.peer); setViewerCount(activeCallsRef.current.size) }); call.on('error', () => { activeCallsRef.current.delete(call.peer); setViewerCount(activeCallsRef.current.size) }) })
    peer.on('connection', conn => { activeDataConnsRef.current.set(conn.peer, conn); setViewerCount(Math.max(activeCallsRef.current.size, activeDataConnsRef.current.size)); conn.on('close', () => activeDataConnsRef.current.delete(conn.peer)); conn.on('error', () => activeDataConnsRef.current.delete(conn.peer)) })
    peer.on('error', err => { addLog('Peer err: ' + err.type); if (err.type === 'unavailable-id') { stream.getTracks().forEach(t => t.stop()); localStreamRef.current = null; alert('Sala en uso.'); setViewMode('landing') } })
    peer.on('disconnected', () => { setPeerStatus('disconnected'); peer.reconnect() })
    setTimeout(() => { const vv = localVideoRef.current; if (vv && localStreamRef.current && (vv.paused || !vv.srcObject)) { addLog('SAFETY RETRY'); attachStream(localStreamRef.current!, vv, 'RETRY') } }, 2000)
  }

  const joinAsViewer = () => {
    const code = joinRoomInput.trim().toUpperCase(); if (code.length < 4) return
    setRoomId(code); setViewMode('watch'); setConnectionError(''); addLog('Viewer → ' + code)
    if (peerRef.current) peerRef.current.destroy()
    const peer = new Peer(undefined, { debug: 0, config: { iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
      { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    ] } })
    peerRef.current = peer; setPeerStatus('connecting')
    peer.on('open', () => { setPeerStatus('connected'); connectToBroadcaster(peer, code) })
    peer.on('error', err => { addLog('V.err: ' + err.type); setConnectionError(err.type === 'peer-unavailable' ? 'Sala no encontrada.' : 'Error conexion.') })
    peer.on('disconnected', () => { setPeerStatus('disconnected'); setStreamActive(false); setConnectionError('Perdida.'); peer.reconnect() })
  }

  const connectToBroadcaster = (peer: Peer, id: string) => {
    const pid = `${PEER_PREFIX}${id}`; addLog('Call → ' + pid)
    peer.connect(pid, { reliable: true })
    const call = peer.call(pid, new MediaStream())
    if (!call) { setConnectionError('No se pudo conectar.'); return }
    setConnectionError('Conectando...')
    call.on('stream', remote => { addLog('REMOTE! ' + remote.getTracks().length + ' tracks'); setStreamActive(true); setConnectionError(''); if (remoteVideoRef.current) attachStream(remote, remoteVideoRef.current, 'REMOTE'); else addLog('CRIT: remote ref null') })
    call.on('close', () => { setStreamActive(false); setConnectionError('Emisor cerró.') })
    call.on('error', err => { setStreamActive(false); setConnectionError('Error.'); addLog('Call err: ' + err) })
  }

  const toggleRecording = () => {
    const s = localStreamRef.current; if (!s) return
    if (!isRecording) {
      let mime = 'video/webm'
      if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) mime = 'video/webm;codecs=vp9,opus'
      else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) mime = 'video/webm;codecs=vp8,opus'
      const rec = new MediaRecorder(s, { mimeType: mime }); recordedChunksRef.current = []
      rec.ondataavailable = e => { if (e.data.size > 0) recordedChunksRef.current.push(e.data) }
      rec.onstop = () => { const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `CamaraML_${roomId}_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url); recordedChunksRef.current = [] }
      rec.start(1000); mediaRecorderRef.current = rec; setIsRecording(true); setRecordingTime(0)
      recordingIntervalRef.current = setInterval(() => setRecordingTime(p => p + 1), 1000)
    } else { mediaRecorderRef.current?.stop(); setIsRecording(false); if (recordingIntervalRef.current) { clearInterval(recordingIntervalRef.current); recordingIntervalRef.current = null } setRecordingTime(0) }
  }

  const cleanup = () => {
    activeCallsRef.current.forEach(c => c.close()); activeCallsRef.current.clear()
    activeDataConnsRef.current.forEach(c => c.close()); activeDataConnsRef.current.clear()
    if (peerRef.current) { peerRef.current.destroy(); peerRef.current = null }
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t => t.stop()); localStreamRef.current = null }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop()
    setIsRecording(false)
    if (recordingIntervalRef.current) { clearInterval(recordingIntervalRef.current); recordingIntervalRef.current = null }
    if (localVideoRef.current) { localVideoRef.current.srcObject = null; localVideoRef.current.load() }
    if (remoteVideoRef.current) { remoteVideoRef.current.srcObject = null; remoteVideoRef.current.load() }
    setStreamActive(false); setViewerCount(0); setConnectionError(''); setRoomId('')
    setViewMode('landing'); setRecordingTime(0); setPeerStatus('disconnected'); setCameraError('')
    const peer = new Peer(undefined, { debug: 0 }); peerRef.current = peer
    peer.on('open', () => setPeerStatus('connected'))
    peer.on('disconnected', () => setPeerStatus('disconnected'))
    peer.on('error', () => setPeerStatus('disconnected'))
    addLog('Cleanup OK')
  }

  const retryConnection = () => { const id = roomId; cleanup(); setTimeout(() => { setJoinRoomInput(id); joinAsViewer() }, 500) }
  const retryCamera = () => { cleanup(); setTimeout(() => startBroadcasting(), 500) }
  const copyRoomId = () => { navigator.clipboard.writeText(roomId); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  const toggleFullscreen = () => { if (!videoContainerRef.current) return; if (!document.fullscreenElement) { videoContainerRef.current.requestFullscreen(); setIsFullscreen(true) } else { document.exitFullscreen(); setIsFullscreen(false) } }
  const formatTime = (s: number) => { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60; return h > 0 ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` }

  return (
    <div className="min-h-screen flex flex-col">
      {(viewMode === 'broadcast' || viewMode === 'watch') && (
        <div className="flex-1 max-w-6xl mx-auto w-full p-4 pt-2">
          <div ref={videoContainerRef} className="relative bg-black rounded-xl overflow-hidden border border-border aspect-video max-h-[70vh]">
            <video ref={localVideoRef} autoPlay muted playsInline style={{ display: viewMode==='broadcast'?'block':'none', width:'100%', height:'100%', objectFit:'contain', position:'absolute', top:0, left:0 }} />
            <video ref={remoteVideoRef} autoPlay playsInline style={{ display: viewMode==='watch'?'block':'none', width:'100%', height:'100%', objectFit:'contain', position:'absolute', top:0, left:0 }} />
            {viewMode==='broadcast' && !localStreamRef.current && !cameraError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-10">
                <Loader2 className="w-12 h-12 text-red-500 animate-spin mb-4" /><p className="text-white text-sm">Iniciando camara...</p>
              </div>
            )}
            {viewMode==='broadcast' && cameraError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-10">
                <CircleAlert className="w-12 h-12 text-amber-500 mb-4" /><p className="text-white font-medium text-center px-4">{cameraError}</p>
                <div className="flex gap-2 mt-4"><Button variant="outline" onClick={retryCamera}><RefreshCw className="w-4 h-4 mr-2" />Reintentar</Button><Button variant="outline" onClick={cleanup}>Volver</Button></div>
              </div>
            )}
            {viewMode==='broadcast' && isRecording && localStreamRef.current && (
              <div className="absolute top-4 left-4 flex items-center gap-2 bg-black/70 backdrop-blur-sm rounded-full px-3 py-1.5 z-10">
                <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" /><span className="text-white text-sm font-medium">REC {formatTime(recordingTime)}</span>
              </div>
            )}
            {viewMode==='broadcast' && localStreamRef.current && (
              <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
                <Badge variant="destructive" className="bg-red-600">LIVE</Badge>
                <Badge variant="outline" className="bg-black/70 text-white border-white/20 text-xs font-mono">{selectedQuality}</Badge>
              </div>
            )}
            {viewMode==='watch' && !streamActive && !connectionError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-10">
                <Loader2 className="w-12 h-12 text-emerald-500 animate-spin mb-4" /><p className="text-muted-foreground text-sm">Esperando transmision...</p>
              </div>
            )}
            {viewMode==='watch' && connectionError && !streamActive && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-10">
                <CircleAlert className="w-12 h-12 text-amber-500 mb-4" /><p className="text-foreground font-medium text-center px-4">{connectionError}</p>
                <div className="flex gap-2 mt-4"><Button variant="outline" onClick={retryConnection}><RefreshCw className="w-4 h-4 mr-2" />Reintentar</Button><Button variant="outline" onClick={cleanup}>Volver</Button></div>
              </div>
            )}
            {viewMode==='watch' && streamActive && (<div className="absolute top-4 right-4 z-10"><Badge variant="destructive" className="bg-red-600"><CircleAlert className="w-3 h-3 mr-1" />LIVE</Badge></div>)}
            <button onClick={toggleFullscreen} className="absolute bottom-4 right-4 bg-black/50 hover:bg-black/70 text-white rounded-full p-2 z-10">
              {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
            </button>
          </div>
        </div>
      )}

      {viewMode==='landing' && (
        <div className="flex-1 flex flex-col items-center justify-center p-4">
          <div className="w-full max-w-lg space-y-8">
            <div className="text-center space-y-3">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-red-600/20 border border-red-600/30 mb-2"><Video className="w-10 h-10 text-red-500" /></div>
              <h1 className="text-4xl font-bold tracking-tight"><span className="text-red-500">Camara</span><span className="text-foreground">ML</span></h1>
              <p className="text-muted-foreground text-sm max-w-md mx-auto">Vigilancia inteligente en tiempo real. Transmite video desde tu dispositivo.</p>
            </div>
            <div className="flex justify-center">
              <Badge variant={isReady?'default':'destructive'} className="text-xs">
                {isReady?(<><span className="w-2 h-2 rounded-full bg-emerald-500 mr-1.5 inline-block" />Servidor conectado</>):(<><Loader2 className="w-3 h-3 mr-1.5 animate-spin" />Conectando...</>)}
              </Badge>
            </div>
            <div className="grid gap-4">
              <Card className="hover:border-red-600/50 transition-all"><CardContent className="p-6 space-y-4">
                <div className="flex items-center gap-4"><div className="flex-shrink-0 w-14 h-14 rounded-xl bg-red-600/15 border border-red-600/20 flex items-center justify-center"><Radio className="w-7 h-7 text-red-500" /></div><div className="flex-1"><h3 className="font-semibold text-lg">Iniciar Transmision</h3><p className="text-muted-foreground text-sm">Activa tu camara para emitir</p></div></div>
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground font-medium flex items-center gap-1"><Settings className="w-3 h-3" /> Calidad</p>
                  <div className="grid grid-cols-3 gap-2">{QUALITY_OPTIONS.map(q => { const s=selectedQuality===q.value; return(<button key={q.value} onClick={()=>setSelectedQuality(q.value)} className={`relative flex flex-col items-center p-3 rounded-lg border-2 transition-all ${s?'border-red-500 bg-red-600/10':'border-border bg-muted/50 hover:border-red-500/40'}`}>{s&&<div className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 flex items-center justify-center"><Check className="w-2.5 h-2.5 text-white" /></div>}<span className={`font-bold text-sm ${s?'text-red-500':'text-muted-foreground'}`}>{q.label}</span><span className="text-[10px] mt-0.5 opacity-70">{q.width}x{q.height}</span></button>) })}</div>
                </div>
                <Button onClick={startBroadcasting} disabled={!isReady} className="w-full bg-red-600 hover:bg-red-700 text-white"><Radio className="w-4 h-4 mr-2" /> Comenzar ({selectedQuality})</Button>
              </CardContent></Card>
              <Card className="hover:border-emerald-600/50 transition-all"><CardContent className="p-6 space-y-4">
                <div className="flex items-center gap-4"><div className="flex-shrink-0 w-14 h-14 rounded-xl bg-emerald-600/15 border border-emerald-600/20 flex items-center justify-center"><Eye className="w-7 h-7 text-emerald-500" /></div><div className="flex-1"><h3 className="font-semibold text-lg">Ver Transmision</h3><p className="text-muted-foreground text-sm">Ingresa codigo de sala</p></div></div>
                <div className="flex gap-2"><Input placeholder="Codigo de sala" value={joinRoomInput} onChange={e=>setJoinRoomInput(e.target.value.toUpperCase())} onKeyDown={e=>e.key==='Enter'&&joinAsViewer()} maxLength={6} className="font-mono text-center text-lg tracking-widest uppercase" disabled={!isReady} /><Button onClick={joinAsViewer} disabled={!isReady||joinRoomInput.trim().length<4} className="bg-emerald-600 hover:bg-emerald-700 text-white px-6"><MonitorPlay className="w-4 h-4 mr-2" /> Ver</Button></div>
              </CardContent></Card>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="p-3 rounded-lg bg-muted/50"><Shield className="w-5 h-5 mx-auto mb-1 text-muted-foreground" /><p className="text-xs text-muted-foreground">Segura</p></div>
              <div className="p-3 rounded-lg bg-muted/50"><Users className="w-5 h-5 mx-auto mb-1 text-muted-foreground" /><p className="text-xs text-muted-foreground">Multi-viewer</p></div>
              <div className="p-3 rounded-lg bg-muted/50"><Download className="w-5 h-5 mx-auto mb-1 text-muted-foreground" /><p className="text-xs text-muted-foreground">Grabacion</p></div>
            </div>
          </div>
        </div>
      )}

      {viewMode==='broadcast' && (
        <div className="max-w-6xl mx-auto w-full px-4 pb-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={toggleRecording} variant={isRecording?'destructive':'default'} size="lg" disabled={!localStreamRef.current}>
              {isRecording?(<><CircleStop className="w-5 h-5 mr-2" />Detener</>):(<><div className="w-4 h-4 rounded-full border-2 border-current mr-2" />Grabar</>)}
            </Button>
            {isRecording&&<div className="flex items-center gap-2 text-muted-foreground text-sm"><Clock className="w-4 h-4" /><span className="font-mono">{formatTime(recordingTime)}</span></div>}
          </div>
          <Card><CardContent className="p-4"><div className="flex flex-wrap items-center justify-between gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-2"><span className={`w-2.5 h-2.5 rounded-full inline-block ${localStreamRef.current?'bg-emerald-500 animate-pulse':'bg-amber-500'}`} /><span>{localStreamRef.current?'Camara activa':'Iniciando...'}</span></div>
            <Badge variant="outline" className="text-xs font-mono">{selectedQuality}</Badge>
            <div className="flex items-center gap-2"><Users className="w-4 h-4" /><span>{viewerCount} viewer{viewerCount!==1?'s':''}</span></div>
            {roomId&&<span>Codigo: <span className="font-mono font-bold text-foreground">{roomId}</span></span>}
          </div></CardContent></Card>
        </div>
      )}

      {viewMode==='watch' && (
        <div className="max-w-6xl mx-auto w-full px-4 pb-4"><Card><CardContent className="p-4"><div className="flex flex-wrap items-center justify-between gap-4 text-sm">
          <div className="flex items-center gap-2">{streamActive?(<><span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse inline-block" /><span className="text-emerald-500 font-medium">Activa</span></>):connectionError?(<><span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" /><span className="text-amber-500">Sin conexion</span></>):(<><span className="w-2.5 h-2.5 rounded-full bg-muted-foreground animate-pulse inline-block" /><span className="text-muted-foreground">Conectando...</span></>)}</div>
          <div className="flex items-center gap-2 text-muted-foreground"><MonitorPlay className="w-4 h-4" /><span>Sala: <span className="font-mono font-bold text-foreground">{roomId}</span></span></div>
        </div></CardContent></Card></div>
      )}

      {viewMode!=='landing' && (
        <header className="border-b bg-card/80 backdrop-blur-sm sticky top-0 z-20">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <Button variant="ghost" size="icon" onClick={cleanup}><ArrowLeft className="w-5 h-5" /></Button>
              {viewMode==='broadcast'?(<div className="flex items-center gap-2"><Video className="w-5 h-5 text-red-500" /><span className="font-bold text-lg"><span className="text-red-500">Camara</span>ML</span></div>):(<div className="flex items-center gap-2"><Eye className="w-5 h-5 text-emerald-500" /><span className="font-bold text-lg"><span className="text-emerald-500">Viendo</span></span></div>)}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {roomId&&(<div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-muted border"><span className="text-xs text-muted-foreground hidden sm:inline">Sala:</span><span className="font-mono font-bold tracking-wider text-sm">{roomId}</span>{viewMode==='broadcast'&&(<Button variant="ghost" size="icon" className="h-6 w-6" onClick={copyRoomId}>{copied?<Check className="w-3.5 h-3.5 text-emerald-500" />:<Copy className="w-3.5 h-3.5" />}</Button>)}</div>)}
              {viewMode==='broadcast'&&(<div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-muted border"><Users className="w-4 h-4" /><span className="text-sm font-medium">{viewerCount}</span></div>)}
              {localStreamRef.current&&viewMode==='broadcast'&&(<Badge variant="destructive" className="animate-pulse"><CircleAlert className="w-3 h-3 mr-1" />EN VIVO</Badge>)}
              {streamActive&&viewMode==='watch'&&(<Badge variant="destructive" className="animate-pulse"><CircleAlert className="w-3 h-3 mr-1" />EN VIVO</Badge>)}
            </div>
          </div>
        </header>
      )}

      {debugLog.length>0&&(
        <div className="fixed bottom-2 left-2 right-2 z-50 max-h-40 overflow-y-auto">
          <Card className="border-amber-500/30 bg-amber-950/90 backdrop-blur-sm"><CardContent className="p-2">
            <div className="flex items-center gap-2 mb-1 text-amber-400"><Bug className="w-3 h-3" /><span className="text-[10px] font-bold">DIAGNOSTICO</span><button onClick={()=>setDebugLog([])} className="text-[10px] text-amber-600 ml-auto">X</button></div>
            <div className="text-[9px] font-mono text-amber-200/80 space-y-px">{debugLog.map((l,i)=><div key={i}>{l}</div>)}</div>
          </CardContent></Card>
        </div>
      )}
    </div>
  )
}