// Inside the Vocorum app (Tauri) the page is the same, but the hub is reached
// from Rust: requests to /client/* and /attachments/* go through the app's own
// origin with a pinned CA and a device key, and the event socket is held by the
// app so alerts arrive with the window closed. In a browser none of this loads.

type Frame = { t: string; d: any }
type Info = { version: string; platform: string; paired: boolean; signedOut: boolean; origin: string | null; device: string | null; pendingLink: string | null }

export const native = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const core = () => import('@tauri-apps/api/core')

// WebKitGTK paints in software (the app turns its GPU path off), so looping
// animations step at a few frames a second there instead of sixty.
if (native && /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)) document.documentElement.dataset['lowfps'] = ''

export async function invoke<T = void>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await core()
  return invoke<T>(cmd, args)
}

let info: Info | null = null
export async function appInfo(): Promise<Info> {
  info = (await (await fetch('/app/info', { cache: 'no-store' })).json()) as Info
  return info
}
if (native) void appInfo().catch(() => {})

// Links people share point at the hub's own address, not the app's internal one.
export function shareOrigin(): string {
  return (native && info?.origin) || location.origin
}

export function connectNativeEvents(onEvent: (t: string, d: any) => void, onOpen: () => void, onStatus: (online: boolean) => void): () => void {
  let closed = false
  void core().then(({ Channel, invoke }) => {
    if (closed) return
    const channel = new Channel<Frame>()
    channel.onmessage = ({ t, d }) => {
      if (closed) return
      if (t === 'HELLO') {
        onStatus(true)
        onOpen()
      } else if (t === 'CLOSED') onStatus(false)
      else onEvent(t, d)
    }
    void invoke('events_subscribe', { channel })
  })
  return () => {
    closed = true
    void invoke('events_unsubscribe').catch(() => {})
  }
}

export function sendNativeFocus(focus: { channel_id: string | null; visible: boolean }) {
  void invoke('set_focus', { focus }).catch(() => {})
}

export const setNativeAlerts = (on: boolean) => invoke<string>('set_alerts', { on })
export const pairApp = (link: string) => invoke('pair', { link })
export const signInApp = () => invoke('sign_in')
export const approveInApp = (id: string) => invoke('approve_request', { id })
