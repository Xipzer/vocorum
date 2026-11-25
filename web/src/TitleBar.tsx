// The desktop app's own title bar, as in Discord's app: one 32px strip across the window
// with where you are in the middle. On macOS the system's traffic lights sit in it on the
// left; on Windows our minimise, maximise and close sit on the right, drawn and sized like
// the system's own. On Linux, and in a browser, the window keeps its usual frame.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { invoke, native } from './native.ts'

export const chrome: 'mac' | 'windows' | null = !native ? null : /Mac OS X|Macintosh/.test(navigator.userAgent) ? 'mac' : /Windows/.test(navigator.userAgent) ? 'windows' : null
if (chrome) document.documentElement.dataset['chrome'] = chrome

// Where you are (the server, Direct messages, Overview), set by the app as you move.
let place = ''
const listeners = new Set<() => void>()
export function setPlace(text: string) {
  if (text === place) return
  place = text
  for (const f of listeners) f()
}
const subscribe = (f: () => void) => {
  listeners.add(f)
  return () => void listeners.delete(f)
}

type Action = 'minimize' | 'toggle_maximize' | 'close' | 'drag'
const act = (action: Action) => invoke('window_control', { action }).catch(() => {})

// The app window's own title follows the page's, for the taskbar and Alt+Tab.
if (native) {
  let last = ''
  const sync = () => {
    if (document.title === last) return
    last = document.title
    void invoke('window_title', { title: last }).catch(() => {})
  }
  const watch = () => {
    sync()
    new MutationObserver(sync).observe(document.head, { subtree: true, childList: true, characterData: true })
  }
  if (document.head) watch()
  else document.addEventListener('DOMContentLoaded', watch, { once: true })
}

export function TitleBar() {
  const text = useSyncExternalStore(subscribe, () => place)
  const [maximized, setMaximized] = useState(false)
  const [focused, setFocused] = useState(() => document.hasFocus())
  useEffect(() => {
    if (!chrome) return
    const sync = () => void invoke<boolean>('window_maximized').then(setMaximized, () => {})
    const focus = () => setFocused(true)
    const blur = () => setFocused(false)
    sync()
    window.addEventListener('resize', sync)
    window.addEventListener('focus', focus)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('focus', focus)
      window.removeEventListener('blur', blur)
    }
  }, [])
  if (!chrome) return null
  return (
    <div
      className={`titlebar${focused ? '' : ' blurred'}`}
      onMouseDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
        // A double click maximises (Windows) or zooms (macOS), as on the system's own bar.
        if (e.detail === 2) void act('toggle_maximize')
        else void act('drag')
      }}
    >
      <span className="titlebar-place">{text}</span>
      {chrome === 'windows' && (
        <div className="titlebar-controls">
          <button onClick={() => void act('minimize')} aria-label="Minimise" tabIndex={-1}>
            <svg viewBox="0 0 10 10" aria-hidden>
              <path d="M0 5.5h10" />
            </svg>
          </button>
          <button onClick={() => void act('toggle_maximize')} aria-label={maximized ? 'Restore' : 'Maximise'} tabIndex={-1}>
            <svg viewBox="0 0 10 10" aria-hidden>
              {maximized ? <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" /> : <path d="M.5.5h9v9h-9z" />}
            </svg>
          </button>
          <button className="close" onClick={() => void act('close')} aria-label="Close" tabIndex={-1}>
            <svg viewBox="0 0 10 10" aria-hidden>
              <path d="m0 0 10 10M10 0 0 10" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
