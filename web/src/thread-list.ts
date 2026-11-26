import type { Channel } from './api.ts'

// Thread IDs carry their creation order, including ties in the same millisecond.
export function newestThreadFirst(a: { id: string }, b: { id: string }) {
  return b.id.length - a.id.length || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}

export const snowflakeTime = (id: string | null | undefined) => id ? Number((BigInt(id) >> 22n) + 1420070400000n) : 0

// Until when a thread stays in the list: its last activity plus its archive delay (0 once
// archived). Activity decides whether a thread is in the list, never where it appears.
export function listedUntil(thread: Channel) {
  const meta = thread.thread_metadata
  if (meta?.archived) return 0
  const last = Math.max(snowflakeTime(thread.id), snowflakeTime(thread.last_message_id), Date.parse(meta?.archive_timestamp ?? '') || 0)
  return last + (meta?.auto_archive_duration ?? 1440) * 60_000
}

export function indexThreads(threads: Channel[], now: number) {
  const byParent = new Map<string, Channel[]>()
  const visible = new Set<string>()
  let nextExpiry = Infinity
  for (const thread of threads) {
    if (!thread.parent_id) continue
    let siblings = byParent.get(thread.parent_id)
    if (!siblings) byParent.set(thread.parent_id, siblings = [])
    siblings.push(thread)
    const expires = listedUntil(thread)
    if (expires > now) {
      visible.add(thread.id)
      nextExpiry = Math.min(nextExpiry, expires)
    }
  }
  for (const siblings of byParent.values()) siblings.sort(newestThreadFirst)
  return { byParent, visible, nextExpiry }
}
