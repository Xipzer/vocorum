// Voice channels: joining one opens a WebSocket to the hub that carries Opus both ways
// (WebCodecs; plain PCM where the browser has no Opus encoder or decoder). Everyone else's
// audio is mixed in Web Audio and played through one <audio> element, so the browser's echo
// cancellation hears it and the output device can be chosen.

import { useSyncExternalStore } from 'react'

export type NoiseMode = 'standard' | 'none'
export type VoiceUi = {
  channelId: string | null
  status: 'idle' | 'connecting' | 'connected'
  error: string | null
  mute: boolean
  deaf: boolean
  // Who is speaking now, this device included (by user id).
  speaking: Record<string, boolean>
  noise: NoiseMode
  output: string
  // The microphone could not be opened: listening only.
  listenOnly: boolean
}

const saved = (key: string, fallback: string) => localStorage.getItem(`voice:${key}`) ?? fallback
let ui: VoiceUi = {
  channelId: null,
  status: 'idle',
  error: null,
  mute: saved('mute', '0') === '1',
  deaf: saved('deaf', '0') === '1',
  speaking: {},
  noise: saved('noise', 'standard') as NoiseMode,
  output: saved('output', ''),
  listenOnly: false,
}
const listeners = new Set<() => void>()
const set = (patch: Partial<VoiceUi>) => {
  ui = { ...ui, ...patch }
  for (const l of listeners) l()
}
export const useVoice = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => ui,
  )

const hasEncoder = typeof window !== 'undefined' && 'AudioEncoder' in window
const hasDecoder = typeof window !== 'undefined' && 'AudioDecoder' in window
const SPEAKING_LEVEL = 0.02

type Peer = { decoder: AudioDecoder | null; next: number }
type Session = {
  ws: WebSocket
  ctx: AudioContext
  mix: GainNode
  player: HTMLAudioElement
  stream: MediaStream | null
  capture: AudioWorkletNode | null
  encoder: AudioEncoder | null
  peers: Map<string, Peer>
  timestamp: number
  quietFrames: number
  meId: string
}
let session: Session | null = null
// Why the hub ended the call.
const CLOSED: Record<number, string> = {
  4000: 'You joined voice on another device or channel, so this one left.',
  4003: 'You no longer have access to this voice channel.',
}

function sendState() {
  if (session?.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify({ op: 'state', self_mute: ui.mute || ui.listenOnly, self_deaf: ui.deaf }))
}

export function setMute(mute: boolean) {
  localStorage.setItem('voice:mute', mute ? '1' : '0')
  // Unmuting while deafened undeafens too, as in Discord.
  set({ mute, ...(!mute && ui.deaf && { deaf: false }) })
  if (!mute) localStorage.setItem('voice:deaf', '0')
  if (session) session.mix.gain.value = ui.deaf ? 0 : 1
  sendState()
}

export function setDeaf(deaf: boolean) {
  localStorage.setItem('voice:deaf', deaf ? '1' : '0')
  set({ deaf })
  if (session) session.mix.gain.value = deaf ? 0 : 1
  sendState()
}

export async function setNoise(noise: NoiseMode) {
  localStorage.setItem('voice:noise', noise)
  set({ noise })
  const track = session?.stream?.getAudioTracks()[0]
  await track?.applyConstraints({ noiseSuppression: noise === 'standard', echoCancellation: true, autoGainControl: true }).catch(() => {})
}

export const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
export async function setOutput(deviceId: string) {
  localStorage.setItem('voice:output', deviceId)
  set({ output: deviceId })
  await (session?.player as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | undefined)?.setSinkId?.(deviceId).catch(() => {})
}
export async function outputs() {
  const devices = await navigator.mediaDevices?.enumerateDevices().catch(() => [])
  return (devices ?? []).filter((d) => d.kind === 'audiooutput')
}

export function leave() {
  const s = session
  session = null
  if (s) {
    s.ws.onclose = null
    s.ws.close()
    s.stream?.getTracks().forEach((t) => t.stop())
    s.encoder?.close()
    for (const p of s.peers.values()) if (p.decoder?.state !== 'closed') p.decoder?.close()
    s.player.pause()
    void s.ctx.close()
  }
  set({ channelId: null, status: 'idle', speaking: {}, listenOnly: false })
}

export async function join(channelId: string, meId: string) {
  if (ui.channelId === channelId && ui.status !== 'idle') return
  leave()
  set({ channelId, status: 'connecting', error: null })
  // Must start inside the click: iPhone only plays audio started by a tap.
  const ctx = new AudioContext({ sampleRate: 48000 })
  const mix = ctx.createGain()
  mix.gain.value = ui.deaf ? 0 : 1
  const out = ctx.createMediaStreamDestination()
  mix.connect(out)
  const player = new Audio()
  player.srcObject = out.stream
  void player.play().catch(() => {})
  if (ui.output) void (player as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(ui.output).catch(() => {})

  let stream: MediaStream | null = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: ui.noise === 'standard', echoCancellation: true, autoGainControl: true, channelCount: 1 } })
  } catch {
    set({ listenOnly: true, error: 'No microphone access, so you can listen but not talk. Allow the microphone for this site, then join again.' })
  }
  if (ui.channelId !== channelId) {
    stream?.getTracks().forEach((t) => t.stop())
    void ctx.close()
    return
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${proto}//${location.host}/client/voice?channel=${encodeURIComponent(channelId)}${hasDecoder ? '' : '&format=pcm'}`)
  ws.binaryType = 'arraybuffer'
  const s: Session = { ws, ctx, mix, player, stream, capture: null, encoder: null, peers: new Map(), timestamp: 0, quietFrames: 0, meId }
  session = s

  ws.onopen = () => {
    set({ status: 'connected' })
    sendState()
  }
  ws.onclose = (e) => {
    if (session !== s) return
    leave()
    set({ error: CLOSED[e.code] ?? (e.code === 1000 ? null : e.reason || 'Voice disconnected. Join again to reconnect.') })
  }
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data) as { op: string; user_id?: string; speaking?: boolean; message?: string }
      if (msg.op === 'speaking' && msg.user_id) set({ speaking: { ...ui.speaking, [msg.user_id]: Boolean(msg.speaking) } })
      if (msg.op === 'error') set({ error: msg.message ?? 'Voice error' })
      return
    }
    receive(s, new Uint8Array(e.data as ArrayBuffer))
  }

  if (stream) await startCapture(s, stream)
}

async function startCapture(s: Session, stream: MediaStream) {
  await s.ctx.audioWorklet.addModule('/voice-worklet.js')
  if (session !== s) return
  const source = s.ctx.createMediaStreamSource(stream)
  const capture = new AudioWorkletNode(s.ctx, 'voice-capture')
  s.capture = capture
  source.connect(capture)
  if (hasEncoder) {
    s.encoder = new AudioEncoder({
      output: (chunk) => {
        const frame = new Uint8Array(chunk.byteLength + 1)
        chunk.copyTo(frame.subarray(1))
        if (s.ws.readyState === WebSocket.OPEN) s.ws.send(frame)
      },
      error: () => {
        s.encoder = null
      },
    })
    s.encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 32000, opus: { frameDuration: 20000 } } as AudioEncoderConfig)
  }
  capture.port.onmessage = (e: MessageEvent<{ pcm: Float32Array<ArrayBuffer>; level: number }>) => {
    if (session !== s) return
    const talking = !ui.mute && !ui.listenOnly && e.data.level > SPEAKING_LEVEL
    s.quietFrames = talking ? 0 : s.quietFrames + 1
    // The ring stays on through short pauses between words (300 ms).
    const speaking = talking || (Boolean(ui.speaking[s.meId]) && s.quietFrames < 15)
    if (speaking !== Boolean(ui.speaking[s.meId])) set({ speaking: { ...ui.speaking, [s.meId]: speaking } })
    if (ui.mute || ui.listenOnly || !speaking || s.ws.readyState !== WebSocket.OPEN) return
    const pcm = e.data.pcm
    if (s.encoder) {
      s.encoder.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: 960, numberOfChannels: 1, timestamp: s.timestamp, data: pcm }))
      s.timestamp += 20000
    } else {
      const frame = new Uint8Array(1 + 960 * 2)
      frame[0] = 1
      const view = new DataView(frame.buffer)
      for (let i = 0; i < 960; i++) view.setInt16(1 + i * 2, Math.max(-1, Math.min(1, pcm[i]!)) * 0x7fff, true)
      s.ws.send(frame)
    }
  }
}

// One packet of someone else's audio: [id length][user id][Opus, or PCM s16 when asked for].
function receive(s: Session, data: Uint8Array) {
  const idLength = data[0]!
  const userId = new TextDecoder().decode(data.subarray(1, 1 + idLength))
  const payload = data.subarray(1 + idLength)
  let peer = s.peers.get(userId)
  if (!peer) {
    peer = { decoder: null, next: 0 }
    if (hasDecoder) {
      const p = peer
      p.decoder = new AudioDecoder({ output: (audio) => play(s, p, audio), error: () => (p.decoder = null) })
      p.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 })
    }
    s.peers.set(userId, peer)
  }
  if (peer.decoder) {
    peer.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: 0, data: payload }))
    return
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  const samples = new Float32Array(payload.byteLength / 2)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000
  schedule(s, peer, samples)
}

function play(s: Session, peer: Peer, audio: AudioData) {
  const samples = new Float32Array(audio.numberOfFrames)
  audio.copyTo(samples, { planeIndex: 0, format: 'f32-planar' })
  audio.close()
  schedule(s, peer, samples)
}

// A small jitter buffer per speaker: 60 ms behind live, played back to back.
function schedule(s: Session, peer: Peer, samples: Float32Array<ArrayBuffer>) {
  if (!samples.length) return
  const buffer = s.ctx.createBuffer(1, samples.length, 48000)
  buffer.copyToChannel(samples, 0)
  const source = s.ctx.createBufferSource()
  source.buffer = buffer
  source.connect(s.mix)
  const now = s.ctx.currentTime
  if (peer.next < now || peer.next > now + 0.5) peer.next = now + 0.06
  source.start(peer.next)
  peer.next += buffer.duration
}
