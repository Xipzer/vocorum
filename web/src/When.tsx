// Picking a time that isn't on the menu: a date and a time in this device's time zone,
// and for a scheduled message how often it repeats. One host in the app shell.

import { useEffect, useState } from 'react'
import { Icon } from './icons.tsx'
import { cronFor, remindTime, whenPicker, type Repeat, type WhenSpec } from './remind.ts'

const pad = (n: number) => String(n).padStart(2, '0')
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const timeValue = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

export function WhenHost() {
  const [spec, setSpec] = useState<WhenSpec | null>(null)
  useEffect(() => {
    whenPicker.open = setSpec
    return () => {
      whenPicker.open = undefined
    }
  }, [])
  return spec ? <WhenDialog key={spec.title + spec.action} spec={spec} onClose={() => setSpec(null)} /> : null
}

function WhenDialog({ spec, onClose }: { spec: WhenSpec; onClose: () => void }) {
  // An hour from now, on the next whole quarter hour.
  const start = new Date(Math.ceil((Date.now() + 3_600_000) / 900_000) * 900_000)
  const [date, setDate] = useState(dateValue(start))
  const [time, setTime] = useState(timeValue(start))
  const [repeat, setRepeat] = useState<Repeat>('once')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const at = new Date(`${date}T${time}`)
  const valid = !Number.isNaN(at.getTime()) && (repeat !== 'once' || at.getTime() > Date.now())
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const weekday = Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString(undefined, { weekday: 'long' })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const submit = async () => {
    if (!valid) return setError(repeat === 'once' ? 'Pick a time in the future.' : 'Pick a date and a time.')
    setBusy(true)
    setError(null)
    try {
      await spec.onPick(repeat === 'once' ? { at: at.getTime() } : { cron: cronFor(at, repeat), at: at.getTime() })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal when"
        role="dialog"
        aria-label={spec.title}
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="grab" />
        <div className="modal-header">
          <h2>{spec.title}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">
          <div className="when-row">
            <label className="field">
              <span className="field-label">Date</span>
              <input type="date" value={date} min={dateValue(new Date())} onChange={(e) => setDate(e.target.value)} required />
            </label>
            <label className="field">
              <span className="field-label">Time</span>
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
            </label>
          </div>
          {spec.repeat && (
            <label className="field">
              <span className="field-label">Repeat</span>
              <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
                <option value="once">Once</option>
                <option value="daily">Every day</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Every {weekday || 'week'}</option>
              </select>
            </label>
          )}
          <span className="field-description">
            {valid ? (repeat === 'once' ? `${remindTime(at.getTime())}, ` : '') : ''}
            {zone.replace(/_/g, ' ')} time.{repeat !== 'once' ? ' Repeats keep to UTC, so the hour can move when the clocks change.' : ''}
          </span>
          {error && <div className="error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="button medium" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button medium primary" disabled={busy}>
            {spec.action}
          </button>
        </div>
      </form>
    </div>
  )
}
