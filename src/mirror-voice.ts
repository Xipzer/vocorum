// A transcript and its audio are two representations of ONE explicitly flagged source message.
// Preserve the evidence across partial deliveries. A filename or transcript cannot set the flag.
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { MessageFlags } from 'discord-api-types/v10'
import { generateSnowflake } from 'discord-digital-twin/src'
import { safeFilename } from './attachments.ts'
import type { Hub } from './hub.ts'

export type MirrorFile = { id: string; filename: string; size?: number; url?: string; proxy_url?: string; content_type?: string; width?: number | null; height?: number | null; duration_secs?: number; waveform?: string; missing?: boolean; mirror_voice_source?: string }
export type MirrorVoiceNote = { duration_secs?: number; attachment_id?: string }
type Input = { id: string; flags?: number; content?: string; attachments?: MirrorFile[]; voice_note?: MirrorVoiceNote }
type Stored = { flags: number; content: string; attachments: string; extra: string | null }
export const isVoice = (flags?: number) => typeof flags === 'number' && (flags & MessageFlags.IsVoiceMessage) !== 0
const duration = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
const audioType = (a: MirrorFile) => {
  const mime = typeof a.content_type === 'string' ? a.content_type.split(';')[0]!.trim().toLowerCase() : ''
  return mime === 'application/ogg' ? 'audio/ogg' : /^audio\/[a-z0-9.+-]+$/.test(mime) ? mime : undefined
}
export function voiceSourceFile(files: MirrorFile[], id?: string) {
  if (id !== undefined) return files.find((a) => a.id === id)
  const candidates = files.filter(audioType)
  return candidates.length === 1 ? candidates[0] : undefined
}

// Only the previous row of this message can supply a cached copy. An incoming ID/URL alone
// must never be promoted into a signed link to some other message's file.
async function cachedAudio(hub: Hub, messageId: string, item?: MirrorFile): Promise<MirrorFile | undefined> {
  if (!item || item.missing || !item.url || !/^\d{1,20}$/.test(item.id)) return
  const row = await hub.store.getAttachment(item.id)
  if (!row || !row.size || row.filename !== safeFilename(row.filename)) return
  const mime = audioType({ ...item, content_type: row.contentType })
  if (!mime) return
  let url: URL
  try { url = new URL(item.url, hub.localUrl) } catch { return }
  if (url.pathname !== `/attachments/${row.id}/${encodeURIComponent(row.filename)}`) return
  const ex = url.searchParams.get('ex'), hm = url.searchParams.get('hm')
  // Older imports used the generic 'mirror' owner. Verify their original signature even if it
  // has since expired; only bytes already attached to this row can be re-signed here.
  if (row.uploadedBy !== `mirror-voice:${messageId}` && !(row.uploadedBy === 'mirror' && hub.attachments.verify(row.id, row.filename, ex, hm, 0))) return
  const disk = await stat(path.join(hub.options.paths.attachments, row.id, row.filename)).catch(() => null)
  if (!disk?.isFile() || disk.size !== row.size) return
  if (!hub.attachments.verify(row.id, row.filename, ex, hm)) url = new URL(hub.attachments.url(row.id, row.filename))
  const local = url.pathname + url.search
  return { id: row.id, filename: row.filename, size: row.size, content_type: mime, url: local, proxy_url: local, ...(row.waveform && { waveform: row.waveform }) }
}

export async function projectVoice(hub: Hub, m: Input, before: Stored | undefined | null, files: ReadonlyMap<string, Buffer>) {
  if (!isVoice(m.flags) && !isVoice(before?.flags)) return null
  const previous: MirrorFile[] = before ? JSON.parse(before.attachments) : []
  const previousNote: MirrorVoiceNote | undefined = before?.extra ? JSON.parse(before.extra).voice_note : undefined
  const incoming = m.attachments ?? []
  const source = voiceSourceFile(incoming, m.voice_note?.attachment_id)
  const sourceId = m.voice_note?.attachment_id ?? source?.id
  const old = previousNote ? previous.find((a) => a.id === previousNote.attachment_id || a.mirror_voice_source !== undefined)
    : isVoice(before?.flags) ? voiceSourceFile(previous) : previous.find((a) => a.id === sourceId)
  let copy = await cachedAudio(hub, m.id, old)
  const secs = duration(m.voice_note?.duration_secs) ?? duration(source?.duration_secs) ?? duration(previousNote?.duration_secs) ?? duration(old?.duration_secs)
  const timing = secs === undefined ? {} : { duration_secs: secs }
  const mime = source && audioType(source), bytes = source && files.get(source.id)
  if (!copy && source && mime && bytes?.length) {
    const free = /^\d{1,20}$/.test(source.id) && !(await hub.store.getAttachment(source.id))
    const waveform = typeof source.waveform === 'string' && source.waveform.length <= 1024 ? source.waveform : null
    const saved = await hub.attachments.save({ id: free ? source.id : generateSnowflake(), filename: source.filename, contentType: mime, data: bytes, uploadedBy: `mirror-voice:${m.id}`, durationSecs: secs, waveform })
    const url = new URL(saved.url), local = url.pathname + url.search
    copy = { id: saved.id, filename: saved.filename, size: saved.size, content_type: mime, url: local, proxy_url: local, ...(waveform && { waveform }) }
  }
  // A raw archive may supply the bytes in its subsequent attachment upload. Keep the descriptor
  // for that route, with no playable URL. A transcript-only prompt needs no placeholder.
  const pending = source ?? old
  const file: MirrorFile | undefined = copy ? { ...copy, ...timing, mirror_voice_source: old?.mirror_voice_source ?? sourceId ?? old?.id ?? copy.id } : pending && /^\d{1,20}$/.test(pending.id) && audioType(pending)
    ? { id: pending.id, filename: safeFilename(pending.filename), content_type: audioType(pending), url: '', proxy_url: '', missing: true, size: 0, ...timing,
        ...(typeof pending.waveform === 'string' && pending.waveform.length <= 1024 && { waveform: pending.waveform }), mirror_voice_source: pending.id } : undefined
  const others = m.attachments === undefined ? previous.filter((a) => a !== old) : incoming.filter((a) => a !== source && (!audioType(a) || files.has(a.id)))
  return {
    flags: (m.flags ?? before?.flags ?? 0) | MessageFlags.IsVoiceMessage,
    content: m.content || before?.content || '',
    note: { ...timing, ...(copy && { attachment_id: copy.id }) } satisfies MirrorVoiceNote,
    file, others,
  }
}
