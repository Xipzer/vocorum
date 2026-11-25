// Reminders and scheduled messages: a short menu of times, a picker for any other, how a
// time reads, and repeats (the hub runs them in UTC; people pick them in local time).

import { api, toReminder, type Reminder } from './api.ts'
import type { SheetAt, SheetSpec } from './Sheet.tsx'
import { store } from './store.ts'

const at9 = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0, 0)
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes())

// "15:40", "Tomorrow 09:00", "Mon 09:00", "3 Dec 09:00": the time a reminder is for.
export function remindTime(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  const today = new Date(now)
  const days = Math.round((at9(d).getTime() - at9(today).getTime()) / 86_400_000)
  if (days === 0) return time
  if (days === 1) return `Tomorrow ${time}`
  if (days === -1) return `Yesterday ${time}`
  if (days > 1 && days < 7) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

export function remindOptions(now = new Date()): { label: string; at: number }[] {
  const tomorrow = at9(addDays(now, 1))
  const monday = at9(addDays(now, ((8 - now.getDay()) % 7) || 7))
  return [
    { label: 'In 20 minutes', at: now.getTime() + 20 * 60_000 },
    { label: 'In 1 hour', at: now.getTime() + 60 * 60_000 },
    { label: 'In 3 hours', at: now.getTime() + 3 * 60 * 60_000 },
    { label: 'Tomorrow', at: tomorrow.getTime() },
    { label: 'Next week', at: monday.getTime() },
  ]
}

// The menu: pick a time; for an existing reminder it moves (snooze), else one is made.
export function remindSheet(at: SheetAt, target: { channelId: string; messageId?: string } | { reminder: Reminder }, onError: (text: string) => void, onDone?: (r: Reminder) => void): SheetSpec {
  // Later on a fired reminder snoozes the same one.
  const set = (when: number) =>
    void ('reminder' in target ? api.snooze(target.reminder.id, when) : api.remind({ channel_id: target.channelId, ...(target.messageId && { message_id: target.messageId }), at: when }))
      .then((s) => {
        const r = toReminder(s)
        store.upsertReminder(r)
        onDone?.(r)
      })
      .catch((e: Error) => onError(e.message))
  return {
    at,
    title: 'reminder' in target ? 'Remind me again' : 'Remind me',
    // "Tomorrow" says only its hour under it; the rest say the time they land on.
  groups: [remindOptions().map((o) => ({ label: o.label, sub: remindTime(o.at).replace(/^Tomorrow /, ''), icon: 'bell' as const, run: () => set(o.at) }))],
  }
}

export const isDue = (r: Reminder) => r.due

export type Repeat = 'once' | 'daily' | 'weekdays' | 'weekly'

// The UTC cron for a local time that repeats. Moving to UTC can cross midnight, which
// moves the days with it.
export function cronFor(local: Date, repeat: Exclude<Repeat, 'once'>): string {
  const m = local.getUTCMinutes()
  const h = local.getUTCHours()
  const shift = (local.getUTCDay() - local.getDay() + 7) % 7
  const day = (d: number) => (d + shift) % 7
  if (repeat === 'daily') return `${m} ${h} * * *`
  if (repeat === 'weekly') return `${m} ${h} * * ${local.getUTCDay()}`
  return `${m} ${h} * * ${[1, 2, 3, 4, 5].map(day).sort((a, b) => a - b).join(',')}`
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
// A repeat in words, in local time: "Every day at 09:00", "Weekdays at 09:00", "Mondays at 09:00".
export function cronLabel(cron: string, nextAt: number | null): string {
  const [m, h, dom, mon, dow] = cron.split(/\s+/)
  if (!nextAt || dom !== '*' || mon !== '*' || !/^\d+$/.test(m ?? '') || !/^\d+$/.test(h ?? '')) return `Repeats (${cron}, UTC)`
  const next = new Date(nextAt)
  const time = next.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  if (dow === '*') return `Every day at ${time}`
  const days = (dow ?? '').split(',')
  if (days.length === 5) return `Weekdays at ${time}`
  if (days.length === 1) return `${DAYS[next.getDay()]}s at ${time}`
  return `Repeats (${cron}, UTC)`
}

// The picker for any other time, opened from a menu; the host lives in the app shell.
export type WhenSpec = { title: string; action: string; repeat: boolean; onPick: (when: { at: number } | { cron: string; at: number }) => Promise<void> }
export const whenPicker: { open?: (spec: WhenSpec) => void } = {}
