// Your status, as Discord's: Online, Idle, Do Not Disturb and Invisible, picked from the
// user panel, and a custom status that clears itself after a while.

import { useRef, useState } from 'react'
import type { ChosenStatus, CustomStatus, HubState, PresenceStatus } from './api.ts'
import { Icon } from './icons.tsx'
import { store } from './store.ts'
import { leave } from './text.ts'

export const STATUS_TEXT: Record<PresenceStatus, string> = { online: 'Online', idle: 'Idle', dnd: 'Do Not Disturb', invisible: 'Invisible', offline: 'Offline' }
const STATUS_SUB: Partial<Record<ChosenStatus, string>> = { dnd: 'You will not receive desktop notifications', invisible: 'You will appear offline' }

export const liveCustom = (c: CustomStatus | null | undefined, now = Date.now()) => (c && (c.expires_at === null || c.expires_at > now) ? c : null)

// What you look like to yourself: the status you chose, Online turning Idle when away.
export function ownStatus(state: HubState): PresenceStatus {
  const chosen = state.user_status?.status ?? 'online'
  return chosen !== 'online' ? chosen : (state.presence?.[state.me.id]?.status ?? 'online')
}

const MINUTE = 60_000
const CLEAR_AFTER: Array<{ label: string; at: () => number | null }> = [
  { label: 'Today', at: () => new Date().setHours(24, 0, 0, 0) },
  { label: '4 hours', at: () => Date.now() + 240 * MINUTE },
  { label: '1 hour', at: () => Date.now() + 60 * MINUTE },
  { label: '30 minutes', at: () => Date.now() + 30 * MINUTE },
  { label: "Don't clear", at: () => null },
]

export function StatusItems({ state, onDone, onCustom }: { state: HubState; onDone: () => void; onCustom: () => void }) {
  const chosen = state.user_status?.status ?? 'online'
  const custom = liveCustom(state.user_status?.custom_status)
  const pick = (status: ChosenStatus) => {
    onDone()
    void store.setUserStatus({ status }).catch(() => {})
  }
  return (
    <>
      {(['online', 'idle', 'dnd', 'invisible'] as const).map((s) => (
        <button key={s} className="menu-item status-item" role="menuitemradio" aria-checked={chosen === s} onClick={() => pick(s)}>
          <i className={`status-icon ${s}`} />
          <span className="status-item-text">
            {STATUS_TEXT[s]}
            {STATUS_SUB[s] && <small>{STATUS_SUB[s]}</small>}
          </span>
        </button>
      ))}
      <div className="menu-rule" />
      <div className="status-custom">
        <button className="menu-item" onClick={() => (onDone(), onCustom())}>
          <Icon name="smile" size={20} />
          <span className="status-item-text">{custom ? custom.text : 'Set Custom Status'}</span>
        </button>
        {custom && (
          <button className="icon-button" aria-label="Clear Custom Status" title="Clear Custom Status" onClick={() => void store.setUserStatus({ custom_status: null }).catch(() => {})}>
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      <div className="menu-rule" />
    </>
  )
}

export function CustomStatusModal({ state, onClose }: { state: HubState; onClose: () => void }) {
  const current = liveCustom(state.user_status?.custom_status)
  const me = state.users.find((u) => u.id === state.me.id)
  const [text, setText] = useState(current?.text ?? '')
  const [after, setAfter] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const close = () => leave(overlay.current, onClose)
  const save = async () => {
    try {
      await store.setUserStatus({ custom_status: text.trim() ? { text: text.trim(), expires_at: CLEAR_AFTER[after]!.at() } : null })
      close()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div ref={overlay} className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form
        className="modal"
        role="dialog"
        aria-label="Set a custom status"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="grab" />
        <div className="modal-header">
          <h2>Set a custom status</h2>
          <button type="button" className="icon-button" onClick={close} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">
          <label className="field">
            <span className="field-label">What's cookin', {me?.global_name ?? me?.username ?? 'you'}?</span>
            <input value={text} maxLength={128} autoFocus placeholder="Support has arrived!" onChange={(e) => setText(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Clear after</span>
            <select value={after} onChange={(e) => setAfter(Number(e.target.value))}>
              {CLEAR_AFTER.map((c, i) => (
                <option key={c.label} value={i}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          {error && <div className="error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="button medium" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="button medium primary">
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
