// Attachment files on disk: <root>/attachments/<id>/<filename>. Message URLs
// are signed like Discord's CDN (`?ex=…&hm=…`), so Kimaki downloads them with
// a plain fetch while nobody can enumerate or guess them, and a leaked link
// stops working after URL_TTL_MS.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type http from 'node:http'
import type { AttachmentRow, HubStore } from './store.ts'

export function safeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(0, 120)
  return base || 'file'
}

// Width and height of a PNG, GIF, JPEG or WebP from its header, so clients can
// reserve the space before the image loads. Other files: null.
export function imageSize(data: Buffer): { width: number | null; height: number | null } {
  const none = { width: null, height: null }
  try {
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
    if (data.subarray(0, 4).toString('latin1') === 'GIF8') return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
    if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
      const kind = data.subarray(12, 16).toString('latin1')
      if (kind === 'VP8X') return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) }
      if (kind === 'VP8L') {
        const bits = data.readUInt32LE(21)
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
      }
      if (kind === 'VP8 ') return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff }
    }
    if (data[0] === 0xff && data[1] === 0xd8) {
      let offset = 2
      while (offset + 9 < data.length) {
        if (data[offset] !== 0xff) return none
        const marker = data[offset + 1]!
        const length = data.readUInt16BE(offset + 2)
        // Start-of-frame markers (not DHT 0xC4, JPG 0xC8, DAC 0xCC) carry the size.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) }
        offset += 2 + length
      }
    }
  } catch {}
  return none
}

export const URL_TTL_MS = 30 * 24 * 3600_000

export class AttachmentStore {
  constructor(
    private readonly dir: string,
    private readonly signingKey: string,
    private readonly store: HubStore,
    // Absolute base for URLs inside messages (Kimaki fetches them).
    private readonly baseUrl: () => string,
  ) {}

  // ex: expiry, seconds since the epoch in hex (Discord's format).
  private sign(id: string, filename: string, ex: string) {
    return crypto.createHmac('sha256', this.signingKey).update(`${id}/${filename}/${ex}`).digest('hex').slice(0, 32)
  }

  verify(id: string, filename: string, ex: string | null, signature: string | null, now = Date.now()): boolean {
    if (!signature || !ex || !/^[0-9a-f]{1,12}$/.test(ex) || parseInt(ex, 16) * 1000 < now) return false
    const expected = Buffer.from(this.sign(id, filename, ex))
    const given = Buffer.from(signature)
    return expected.length === given.length && crypto.timingSafeEqual(expected, given)
  }

  url(id: string, filename: string, now = Date.now()): string {
    const ex = Math.floor((now + URL_TTL_MS) / 1000).toString(16)
    return `${this.baseUrl()}/attachments/${id}/${encodeURIComponent(filename)}?ex=${ex}&hm=${this.sign(id, filename, ex)}`
  }

  async save(input: { id: string; filename: string; contentType: string; data: Buffer; uploadedBy: string; durationSecs?: number | null; waveform?: string | null }): Promise<AttachmentRow & { url: string }> {
    const filename = safeFilename(input.filename)
    const dir = path.join(this.dir, input.id)
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.promises.writeFile(path.join(dir, filename), input.data, { mode: 0o600 })
    const row: AttachmentRow = {
      id: input.id,
      filename,
      contentType: input.contentType || 'application/octet-stream',
      size: input.data.length,
      durationSecs: input.durationSecs ?? null,
      waveform: input.waveform ?? null,
      ...imageSize(input.data),
      uploadedBy: input.uploadedBy,
    }
    await this.store.addAttachment(row)
    return { ...row, url: this.url(row.id, row.filename) }
  }

  // GET /attachments/:id/:name. `authorized` = device session or bot token.
  async serve(req: http.IncomingMessage, res: http.ServerResponse, { authorized }: { authorized: boolean }): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const [, , id = '', rawName = ''] = url.pathname.split('/')
    const filename = decodeURIComponent(rawName)
    const row = /^\d+$/.test(id) ? await this.store.getAttachment(id) : null
    if (!row || row.filename !== filename || !(authorized || this.verify(id, filename, url.searchParams.get('ex'), url.searchParams.get('hm')))) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
      return
    }
    const file = path.join(this.dir, id, row.filename)
    const stat = await fs.promises.stat(file).catch(() => null)
    if (!stat) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
      return
    }
    // Inline only for media; everything else downloads. Never sniff into HTML.
    const inline = /^(image|audio|video)\//.test(row.contentType) && !row.contentType.includes('svg')
    res.writeHead(200, {
      // Never the uploader's type for anything else: a file must not become a script or page on this origin.
      'content-type': inline ? row.contentType : 'application/octet-stream',
      'content-length': stat.size,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, max-age=31536000, immutable',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    fs.createReadStream(file).pipe(res)
  }
}

let ffmpegPath: Promise<string | null> | null = null
function findFfmpeg(): Promise<string | null> {
  ffmpegPath ??= promisify(execFile)('ffmpeg', ['-version'], { timeout: 5000 })
    .then(() => 'ffmpeg')
    .catch(() => null)
  return ffmpegPath
}

// What browsers record, and the one ffmpeg demuxer each may be read with.
const RECORDED_FORMATS: Record<string, string> = { 'audio/webm': 'matroska', 'video/webm': 'matroska', 'audio/mp4': 'mov', 'audio/x-m4a': 'mov', 'video/mp4': 'mov' }

// Voice notes: browsers record webm (Chrome) or mp4 (iOS Safari). Discord's
// voice messages are ogg/opus, so convert when ffmpeg exists, else keep the
// original. ffmpeg only gets a known container and may not open anything else.
export async function toOggOpus(data: Buffer, contentType: string): Promise<{ data: Buffer; contentType: string; ext: string } | null> {
  const format = RECORDED_FORMATS[contentType.split(';')[0]!.trim().toLowerCase()]
  if (!format) return null
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) return null
  const dir = await fs.promises.mkdtemp(path.join((await import('node:os')).tmpdir(), 'hub-voice-'))
  try {
    const input = path.join(dir, 'in')
    const output = path.join(dir, 'out.ogg')
    await fs.promises.writeFile(input, data)
    await promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-f', format, '-i', input, '-vn', '-c:a', 'libopus', '-b:a', '32k', output], { timeout: 20_000 })
    return { data: await fs.promises.readFile(output), contentType: 'audio/ogg', ext: '.ogg' }
  } catch {
    return null
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true })
  }
}
