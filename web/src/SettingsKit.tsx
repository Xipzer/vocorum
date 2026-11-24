// Building blocks for the settings layers: pages, groups, rows, fields, switches,
// radios and confirms, in one look.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { HubState } from './api.ts'
import { Icon } from './icons.tsx'
import { store } from './store.ts'

const PENDING = 'Coming with the hub update'
const HOUR = 3_600_000

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function ago(value: number | string | null) {
  if (value === null) return 'never'
  const ms = Date.now() - new Date(value).getTime()
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  if (m < 60 * 24) return `${Math.round(m / 60)} h ago`
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function mutedText(until: number | null) {
  if (!until || until <= Date.now()) return null
  return until > Date.now() + 365 * 24 * HOUR ? 'Muted' : `Muted until ${new Date(until).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
}

export const hex = (color: number) => `#${color.toString(16).padStart(6, '0')}`

// The server the sidebar shows: the one picked last, else the primary.
export function currentGuild(state: HubState) {
  const picked = localStorage.getItem('guild')
  return store.guilds().find((g) => g.id === picked) ?? store.guilds()[0] ?? { ...state.guild, icon: null }
}


export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h2 className="settings-title">{title}</h2>
      {children}
    </>
  )
}

export function Group({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-group">
      {title && <h3 className="settings-heading">{title}</h3>}
      {note && <p className="settings-note">{note}</p>}
      {children}
    </section>
  )
}

// One setting: what it is on the left, its control on the right.
export function Item({ label, note, children, stack }: { label: ReactNode; note?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={`settings-item${stack ? ' stack' : ''}`}>
      <div className="settings-item-text">
        <div className="settings-label">{label}</div>
        {note && <div className="settings-item-note">{note}</div>}
      </div>
      {children && <div className="settings-item-control">{children}</div>}
    </div>
  )
}

export function Pending() {
  return (
    <p className="settings-pending">
      <Icon name="info" size={16} />
      {PENDING}
    </p>
  )
}

export function Feedback({ text }: { text: { ok: boolean; text: string } | null }) {
  if (!text) return null
  return (
    <p className={`settings-feedback${text.ok ? '' : ' bad'}`} role={text.ok ? 'status' : 'alert'}>
      {text.text}
    </p>
  )
}

export function useFeedback() {
  const [text, setText] = useState<{ ok: boolean; text: string } | null>(null)
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setText(null)
    try {
      await fn()
      if (done) setText({ ok: true, text: done })
      return true
    } catch (e) {
      setText({ ok: false, text: message(e) })
      return false
    }
  }
  return { text, run, set: setText }
}

export function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange?: (on: boolean) => void }) {
  return <button type="button" className={`settings-switch${checked ? ' on' : ''}`} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange?.(!checked)} />
}

export function Radios<T extends string>({ name, label, value, options, onChange, disabled }: { name: string; label: string; value: T | null; options: Array<{ id: T; label: string; note?: string; swatch?: string }>; onChange?: (id: T) => void; disabled?: boolean }) {
  return (
    <div className="settings-radios" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <label key={o.id} className={`settings-radio${value === o.id ? ' on' : ''}${disabled ? ' disabled' : ''}`}>
          <input type="radio" name={name} value={o.id} checked={value === o.id} disabled={disabled} onChange={() => onChange?.(o.id)} />
          <i className="settings-dot" aria-hidden="true" />
          {o.swatch && <i className="settings-swatch" style={{ background: o.swatch }} aria-hidden="true" />}
          <span className="settings-radio-text">
            <span>{o.label}</span>
            {o.note && <small>{o.note}</small>}
          </span>
        </label>
      ))}
    </div>
  )
}

// A text value with its own Save: Enter saves, Esc-free (Esc closes settings).
export function TextSetting({ label, note, value, max, placeholder, allowEmpty, multiline, disabled, onSave }: { label: string; note?: ReactNode; value: string; max: number; placeholder?: string; allowEmpty?: boolean; multiline?: boolean; disabled?: boolean; onSave: (value: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  const feedback = useFeedback()
  const id = useRef(`settings-${Math.random().toString(36).slice(2)}`).current
  useEffect(() => setDraft(value), [value])
  const changed = draft.trim() !== value.trim()
  const valid = allowEmpty || draft.trim().length > 0
  const save = async () => {
    if (!changed || !valid || busy) return
    setBusy(true)
    await feedback.run(() => onSave(draft.trim()))
    setBusy(false)
  }
  const props = { id, value: draft, maxLength: max, placeholder, disabled, className: 'settings-input', onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value) }
  return (
    <div className="settings-field">
      <label className="settings-label" htmlFor={id}>
        {label}
      </label>
      {note && <div className="settings-item-note">{note}</div>}
      <div className="settings-field-row">
        {multiline ? (
          <textarea {...props} rows={3} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && void save()} />
        ) : (
          <input {...props} onKeyDown={(e) => e.key === 'Enter' && void save()} />
        )}
        {changed && (
          <button className="button primary" disabled={!valid || busy} onClick={() => void save()}>
            Save
          </button>
        )}
      </div>
      <Feedback text={feedback.text} />
    </div>
  )
}

export function Confirm({ text, action, onConfirm, onCancel }: { text: string; action: string; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <div className="settings-confirm" role="alertdialog" aria-label={action}>
      <span>{text}</span>
      <div className="settings-actions">
        <button ref={ref} className="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="button danger-fill" onClick={onConfirm}>
          {action}
        </button>
      </div>
    </div>
  )
}

export function ImagePicker({ label, onPick, disabled }: { label: string; onPick: (file: File) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button className="button" disabled={disabled} onClick={() => input.current?.click()}>
        {label}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) onPick(file)
        }}
      />
    </>
  )
}
