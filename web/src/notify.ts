// Presence reporting, notification settings and Web Push on this device.

import { useEffect } from 'react'
import { api, reportFocus, type Channel, type HubState, type NotifyLevel } from './api.ts'
import type { SheetAction, SheetAt, SheetSpec } from './Sheet.tsx'
import { store } from './store.ts'
import { native, setNativeAlerts } from './native.ts'

// The app shows alerts itself from its own connection; the hub needs no push subscription.
async function nativeAlerts(on: boolean): Promise<string> {
  const text = await setNativeAlerts(on)
  store.setPushSubscribed(on)
  return text
}

const IDLE_MS = 5 * 60_000

// Tells the hub which channel this window shows and whether anyone is looking:
// hidden, or 5 minutes without input, counts as away (Discord's idle).
export function useFocusReporting(channelId: string | null) {
  useEffect(() => {
    let idle: ReturnType<typeof setTimeout>
    let away = false
    const send = () => reportFocus({ channel_id: channelId, visible: document.visibilityState === 'visible' && !away })
    const active = () => {
      clearTimeout(idle)
      if (away) {
        away = false
        send()
      }
      idle = setTimeout(() => {
        away = true
        send()
      }, IDLE_MS)
    }
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    for (const e of events) window.addEventListener(e, active, { passive: true })
    document.addEventListener('visibilitychange', send)
    active()
    send()
    return () => {
      clearTimeout(idle)
      for (const e of events) window.removeEventListener(e, active)
      document.removeEventListener('visibilitychange', send)
    }
  }, [channelId])
}

// A notification tapped while the app is open: go to its message.
export function useNotificationClicks(onOpen: (channelId: string, messageId: string | null) => void) {
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const channel = params.get('channel')
    if (channel) {
      history.replaceState(null, '', location.pathname + location.hash)
      onOpen(channel, params.get('message'))
    }
    if (!('serviceWorker' in navigator)) return
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; channel_id?: string; message_id?: string | null } | null
      if (d?.type === 'notification-click' && d.channel_id) onOpen(d.channel_id, d.message_id ?? null)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])
}

// The scopes a channel inherits from, nearest first: thread, channel, category, server.
function chain(state: HubState, channel: Channel): string[] {
  const all = [...state.channels, ...state.threads]
  const out: string[] = []
  let c: Channel | undefined = channel
  while (c) {
    out.push(c.id)
    c = c.parent_id ? all.find((x) => x.id === c!.parent_id) : undefined
  }
  out.push(channel.guild_id ?? state.guild.id)
  return out
}

export function effective(state: HubState, channel: Channel): { level: NotifyLevel; inherited: boolean; mutedUntil: number | null } {
  const n = state.notifications
  const scopes = chain(state, channel)
  const own = n?.settings[channel.id]
  const level = scopes.map((id) => n?.settings[id]?.level).find(Boolean) ?? n?.default_level ?? 'mentions'
  const now = Date.now()
  const muted = scopes.map((id) => n?.settings[id]?.muted_until ?? null).filter((t): t is number => t !== null && t > now)
  return { level, inherited: !own?.level, mutedUntil: muted.length ? Math.max(...muted) : null }
}

export const pushSupported = () => native || ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext)

const keyBytes = (b64: string) => {
  const raw = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0))
}

// Must run from a tap: iPhone only asks for permission in response to one.
export async function enablePush(): Promise<string> {
  if (native) return nativeAlerts(true)
  const key = store.data.state?.notifications?.vapid_public_key
  if (!pushSupported() || !key) return 'This browser can’t receive notifications. On iPhone, add Vocorum to the Home Screen first.'
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'Notifications are blocked for this site in the browser settings.'
  const reg = await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }))
  await api.pushSubscribe(sub.toJSON())
  store.setPushSubscribed(true)
  return 'Notifications are on for this device.'
}

export async function disablePush(): Promise<string> {
  if (native) return nativeAlerts(false)
  if (pushSupported()) await (await (await navigator.serviceWorker.ready).pushManager.getSubscription())?.unsubscribe()
  await api.pushUnsubscribe()
  store.setPushSubscribed(false)
  return 'Notifications are off for this device.'
}

const LEVEL_TEXT: Record<NotifyLevel, string> = { all: 'All messages', mentions: 'Only mentions', nothing: 'Nothing' }
const HOUR = 3_600_000

// The bell: this channel's level, mute, and push for this device.
export function bellSheet(state: HubState, channel: Channel, at: SheetAt, onDone: (text: string) => void): SheetSpec {
  const now = effective(state, channel)
  const set = (body: { level?: NotifyLevel | null; muted_until?: number | null }) => void store.setNotification(channel.id, body).catch((e: Error) => onDone(e.message))
  const own = state.notifications?.settings[channel.id]?.level ?? null
  const level = (l: NotifyLevel): SheetAction => ({ label: LEVEL_TEXT[l], radio: true, checked: own === l, run: () => set({ level: l }) })
  const subscribed = state.notifications?.push_subscribed
  const until = (t: number) => (t > Date.now() + 365 * 24 * HOUR ? 'until you turn it back on' : `until ${new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`)
  return {
    at,
    title: 'Notifications',
    subtitle: `${LEVEL_TEXT[now.level]}${now.inherited ? ' (default)' : ''}`,
    groups: [
      now.mutedUntil
        ? [{ label: 'Unmute', sub: `Muted ${until(now.mutedUntil)}`, run: () => set({ muted_until: null }) }]
        : [
            { label: 'Mute for 1 hour', run: () => set({ muted_until: Date.now() + HOUR }) },
            { label: 'Mute for 8 hours', run: () => set({ muted_until: Date.now() + 8 * HOUR }) },
            { label: 'Mute until I turn it back on', run: () => set({ muted_until: Date.now() + 100 * 365 * 24 * HOUR }) },
          ],
      [{ label: 'Use the default', sub: LEVEL_TEXT[effective(state, { ...channel, id: '__none__' } as Channel).level], radio: true, checked: own === null, run: () => set({ level: null }) }, level('all'), level('mentions'), level('nothing')],
      subscribed
        ? [
            { label: 'Send a test notification', run: () => void api.pushTest().then((r) => onDone(r.sent ? 'Test sent to this device.' : 'The test could not be delivered.'), (e: Error) => onDone(e.message)) },
            { label: 'Turn off notifications on this device', red: true, run: () => void disablePush().then(onDone, (e: Error) => onDone(e.message)) },
          ]
        : [{ label: 'Turn on notifications on this device', run: () => void enablePush().then(onDone, (e: Error) => onDone(e.message)) }],
    ],
  }
}
