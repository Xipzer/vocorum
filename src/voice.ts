// Voice channels, as on Discord: a person joins a voice channel (type 2) by
// opening a WebSocket at /client/voice?channel=<id> and leaves by closing it.
// Audio is Opus, one 20 ms frame per message, relayed as it arrives to
// everyone else in the channel: other people's sockets and bots connected to
// the twin's voice server (whose frames come back the same way). Nothing is
// recorded. Speaking indicators come from the audio itself.
//
// Client to hub: text {op:'state', self_mute, self_deaf}; binary: one byte
// format (0: an Opus packet, 48 kHz mono 20 ms; 1: 20 ms of PCM s16le 48 kHz
// mono, which the hub encodes), then the payload.
// Hub to client: text {op:'speaking', user_id, speaking} and {op:'error',
// message}; binary: one byte length of the speaker's user id, the id in
// ASCII, then one Opus packet.

import fs from 'node:fs'
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { HttpError } from './auth.ts'
import { P } from './access.ts'
import type { Hub } from './hub.ts'

const VOICE_CHANNEL = 2
const OPUS_MAX = 1275
const PCM_FRAME = 960 * 2
const SPEAKING_HOLD_MS = 300
// A socket that cannot keep up drops frames instead of building a backlog.
const BACKLOG = 64 * 1024

type Connection = {
  ws: WebSocket
  userId: string
  deviceId: string
  guildId: string
  channelId: string
  selfMute: boolean
  selfDeaf: boolean
  canSpeak: boolean
  encoder: { encode(pcm: Buffer, frameSize: number): Buffer; delete(): void } | null
  toldNoSpeak: boolean
}

export type VoiceState = { guild_id: string; channel_id: string | null; user_id: string; self_mute: boolean; self_deaf: boolean }

export class VoiceRooms {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 })
  private connections = new Set<Connection>()
  private byUser = new Map<string, Connection>()
  private speaking = new Map<string, { channelId: string; timer: NodeJS.Timeout }>()
  private check: NodeJS.Timeout | null = null

  constructor(private readonly hub: Hub) {}

  start() {
    const voice = this.hub.twin.voice
    if (voice) {
      // A bot on this machine trusts exactly this certificate (it changes on every start).
      const file = this.hub.options.paths.voiceCert
      fs.writeFileSync(`${file}.tmp`, voice.certificate, { mode: 0o600 })
      fs.renameSync(`${file}.tmp`, file)
      voice.record = false
      voice.onAudio = (frame) => this.relay(frame.userId, frame.guildId, frame.channelId, frame.opus, { fromBot: true })
    }
    // Someone who lost access to a voice channel (removed, role taken) leaves it.
    this.check = setInterval(() => void this.recheck().catch((error) => console.error('[voice]', error)), 30_000)
    this.check.unref()
  }

  stop() {
    if (this.check) clearInterval(this.check)
    for (const c of this.connections) c.ws.terminate()
    this.connections.clear()
    this.byUser.clear()
    for (const s of this.speaking.values()) clearTimeout(s.timer)
    this.speaking.clear()
    this.wss.close()
  }

  // Everyone in voice that this person may see: people and bots.
  async statesFor(userId: string): Promise<VoiceState[]> {
    const out: VoiceState[] = []
    for (const s of this.hub.twin.voiceStates()) {
      if (!s.guild_id || !s.channel_id || !(await this.hub.access.can(userId, s.channel_id, 0n))) continue
      out.push({ guild_id: s.guild_id, channel_id: s.channel_id, user_id: s.user_id, self_mute: s.self_mute, self_deaf: s.self_deaf })
    }
    return out
  }

  async upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    try {
      await this.hub.checkHuman(req, '/client/voice')
      this.hub.auth.checkCsrf(req)
      const device = await this.hub.auth.requireDevice(req)
      const userId = this.hub.userOf(device)
      this.hub.checkIdentity(req, userId)
      const channelId = new URL(req.url ?? '/', 'http://x').searchParams.get('channel') ?? ''
      if (!/^\d{1,20}$/.test(channelId)) throw new HttpError(400, 'channel is required')
      const channel = await this.hub.twin.prisma.channel.findUnique({ where: { id: channelId } })
      if (!channel?.guildId || channel.type !== VOICE_CHANNEL || !(await this.hub.access.can(userId, channelId, 0n))) throw new HttpError(404, 'Unknown voice channel')
      if (!(await this.hub.access.can(userId, channelId, P.CONNECT))) throw new HttpError(403, 'You cannot join this voice channel')
      const canSpeak = await this.hub.access.can(userId, channelId, P.SPEAK)
      const guildId = channel.guildId
      this.wss.handleUpgrade(req, socket, head, (ws) => this.join({ ws, userId, deviceId: device.id, guildId, channelId, selfMute: false, selfDeaf: false, canSpeak, encoder: null, toldNoSpeak: false }))
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 404 ? 'Not Found' : status === 400 ? 'Bad Request' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
  }

  private join(c: Connection) {
    // One voice channel per person: joining from anywhere moves them.
    const previous = this.byUser.get(c.userId)
    if (previous) {
      this.byUser.delete(c.userId)
      this.connections.delete(previous)
      previous.encoder?.delete()
      previous.ws.close(4000, 'Moved to another voice connection')
    }
    this.connections.add(c)
    this.byUser.set(c.userId, c)
    void this.publish(c)
    c.ws.on('error', () => c.ws.terminate())
    c.ws.on('close', () => this.leave(c))
    c.ws.on('message', (data, isBinary) => {
      if (!isBinary) return this.control(c, String(data))
      const frame = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[])
      this.audio(c, frame)
    })
  }

  private leave(c: Connection) {
    this.connections.delete(c)
    c.encoder?.delete()
    c.encoder = null
    if (this.byUser.get(c.userId) !== c) return
    this.byUser.delete(c.userId)
    this.setSpeaking(c.userId, c.channelId, false)
    void this.hub.twin.setUserVoiceChannel({ userId: c.userId, guildId: c.guildId, channelId: null }).catch(() => {})
  }

  private publish(c: Connection) {
    return this.hub.twin.setUserVoiceChannel({ userId: c.userId, guildId: c.guildId, channelId: c.channelId, selfMute: c.selfMute, selfDeaf: c.selfDeaf }).catch((error) => console.error('[voice]', error))
  }

  private control(c: Connection, text: string) {
    let message: { op?: unknown; self_mute?: unknown; self_deaf?: unknown }
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message.op !== 'state') return
    const selfMute = message.self_mute === true
    const selfDeaf = message.self_deaf === true
    if (selfMute === c.selfMute && selfDeaf === c.selfDeaf) return
    c.selfMute = selfMute
    c.selfDeaf = selfDeaf
    if (selfMute) this.setSpeaking(c.userId, c.channelId, false)
    void this.publish(c)
  }

  private audio(c: Connection, frame: Buffer) {
    if (this.byUser.get(c.userId) !== c || c.selfMute || frame.length < 2) return
    if (!c.canSpeak) {
      if (!c.toldNoSpeak) c.ws.send(JSON.stringify({ op: 'error', message: 'You cannot speak in this voice channel' }))
      c.toldNoSpeak = true
      return
    }
    let opus: Buffer
    if (frame[0] === 0) {
      if (frame.length - 1 > OPUS_MAX) return
      opus = frame.subarray(1)
    } else if (frame[0] === 1) {
      if (frame.length - 1 !== PCM_FRAME) return
      // The encoder loads on the first PCM frame (only browsers without AudioEncoder send PCM).
      if (!opusModule) return void loadOpus().catch((error) => console.error('[voice]', error))
      try {
        c.encoder ??= newEncoder()
        opus = c.encoder.encode(frame.subarray(1), 960)
      } catch {
        return
      }
    } else return
    this.relay(c.userId, c.guildId, c.channelId, opus, { fromBot: false })
  }

  // One frame from a speaker to everyone else in that channel.
  private relay(userId: string, guildId: string, channelId: string, opus: Buffer, { fromBot }: { fromBot: boolean }) {
    const id = Buffer.from(userId, 'ascii')
    const out = Buffer.concat([Buffer.from([id.length]), id, opus])
    for (const c of this.connections) {
      if (c.channelId !== channelId || c.userId === userId || c.selfDeaf || this.byUser.get(c.userId) !== c) continue
      if (c.ws.bufferedAmount > BACKLOG) continue
      c.ws.send(out)
    }
    // Bots in the channel hear people; a bot's own audio is not sent back to bots.
    if (!fromBot) this.hub.twin.voice?.sendFrame({ guildId, channelId, userId, opus })
    this.setSpeaking(userId, channelId, true)
  }

  private setSpeaking(userId: string, channelId: string, on: boolean) {
    const current = this.speaking.get(userId)
    if (on) {
      if (current) {
        current.timer.refresh()
        return
      }
      const timer = setTimeout(() => this.setSpeaking(userId, channelId, false), SPEAKING_HOLD_MS)
      timer.unref()
      this.speaking.set(userId, { channelId, timer })
    } else {
      if (!current) return
      clearTimeout(current.timer)
      this.speaking.delete(userId)
      channelId = current.channelId
    }
    const message = JSON.stringify({ op: 'speaking', user_id: userId, speaking: on })
    for (const c of this.connections) if (c.channelId === channelId && this.byUser.get(c.userId) === c) c.ws.send(message)
  }

  private async recheck() {
    for (const c of [...this.connections]) {
      if (!(await this.hub.access.can(c.userId, c.channelId, P.CONNECT))) c.ws.close(4003, 'No longer allowed in this voice channel')
      else c.canSpeak = await this.hub.access.can(c.userId, c.channelId, P.SPEAK)
    }
  }
}

// opusscript is plain JavaScript (no native build).
let opusModule: { default: any } | null = null
let loading: Promise<void> | null = null
function loadOpus() {
  loading ??= import('opusscript').then((m) => {
    opusModule = m as { default: any }
  })
  return loading
}

function newEncoder() {
  const OpusScript = opusModule!.default
  return new OpusScript(48000, 1, OpusScript.Application.VOIP) as { encode(pcm: Buffer, frameSize: number): Buffer; delete(): void }
}
