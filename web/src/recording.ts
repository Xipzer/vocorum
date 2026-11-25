import type { Message } from './api.ts'

export function recordingOf(m: Message) {
  if (!((m.flags ?? 0) & (1 << 13))) return
  const id = m.voice_note?.attachment_id
  // Older hubs did not emit voice_note, even for a mirrored voice message.
  // In that case only its unambiguous, signed local recording can play. An
  // explicit transcript-only note or an ID mismatch is never a fallback.
  const a = id ? m.attachments.find(a => a.id === id) : !m.voice_note && m.attachments.length === 1 ? m.attachments[0] : undefined
  if (!a || a.missing || !(a.size > 0) || !/^(audio\/[^;]+|application\/ogg)(;|$)/i.test(a.content_type ?? '')) return
  try {
    const url = new URL(a.url, location.origin)
    if (url.origin === location.origin && url.pathname === `/attachments/${a.id}/${encodeURIComponent(a.filename)}` && url.searchParams.get('hm') && url.searchParams.get('ex')) return a
  } catch { /* Invalid URLs are not playback sources. */ }
}
