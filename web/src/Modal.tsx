// A modal a bot opened (interaction response type 9): text inputs, file uploads,
// text displays, selects, radio groups and checkboxes, submitted back as a modal
// interaction.

import { useRef, useState } from 'react'
import { api, type Component } from './api.ts'
import { Markdown, type MarkdownContext } from './markdown.tsx'
import { Icon } from './icons.tsx'
import { leave } from './text.ts'
import { SelectMenu, type Option } from './components.tsx'
import { Radios } from './SettingsKit.tsx'

export type OpenModal = { channelId: string; messageId?: string; data: { custom_id: string; title: string; components: Component[] } }

type Labelled = { customId: string; label: string; description?: string; id?: number; parentId?: number; row?: boolean }
type Field =
  | (Labelled & { kind: 'text'; style: number; placeholder?: string; required: boolean; min?: number; max?: number; value: string })
  | (Labelled & { kind: 'file'; max: number; required: boolean })
  | (Labelled & { kind: 'select'; type: number; options: Option[]; channelTypes?: number[]; placeholder?: string; required: boolean; min: number; max: number; picked: string[] })
  | (Labelled & { kind: 'radio'; options: Option[]; required: boolean; picked: string[] })
  | (Labelled & { kind: 'checks'; options: Option[]; required: boolean; min: number; max: number; picked: string[] })
  | (Labelled & { kind: 'checkbox'; checked: boolean })
  | { kind: 'display'; content: string; id?: number }
type Choice = Extract<Field, { picked: string[] }>

const defaults = (options: Option[]) => options.filter((o) => o.default).map((o) => o.value)

// Discord numbers a modal's components it was given without an id, in order, skipping
// ids the bot used, and echoes them all on submit.
function numbered(components: Component[]): Component[] {
  const used = new Set<number>()
  const walk = (c: Component | undefined) => {
    if (!c) return
    if (Number.isInteger(c['id']) && c['id'] > 0) used.add(c['id'])
    ;(c['components'] ?? []).forEach(walk)
    walk(c['component'])
  }
  components.forEach(walk)
  let next = 1
  const number = (c: Component): Component => {
    while (used.has(next)) next++
    const id = Number.isInteger(c['id']) && c['id'] > 0 ? c['id'] : next++
    return { ...c, id, ...(c['components'] && { components: c['components'].map(number) }), ...(c['component'] && { component: number(c['component']) }) }
  }
  return components.map(number)
}

function fields(components: Component[], row?: Component): Field[] {
  return components.flatMap((c): Field[] => {
    if (c.type === 1) return fields(c['components'] ?? [], c)
    if (c.type === 10) return [{ kind: 'display', content: c['content'] ?? '', id: c['id'] }]
    const inner = c.type === 18 ? c['component'] : c
    if (!inner) return []
    const base: Labelled = { customId: inner['custom_id'], label: (c.type === 18 ? c['label'] : inner['label']) ?? '', description: c.type === 18 ? c['description'] : undefined, id: inner['id'], parentId: c.type === 18 ? c['id'] : row?.['id'], row: Boolean(row) }
    const required: boolean = inner['required'] ?? true
    const options: Option[] = inner['options'] ?? []
    if (inner.type === 4)
      return [{ ...base, kind: 'text', style: inner['style'] ?? 1, placeholder: inner['placeholder'], required, min: inner['min_length'], max: inner['max_length'], value: inner['value'] ?? '' }]
    if (inner.type === 19) return [{ ...base, label: base.label || 'Files', kind: 'file', max: inner['max_values'] ?? 1, required }]
    // Selects, radios and checkboxes exist in modals only inside a Label, as in Discord.
    if (c.type !== 18) return []
    if (inner.type === 3 || (inner.type >= 5 && inner.type <= 8)) {
      const picked = inner.type === 3 ? defaults(options) : (inner['default_values'] ?? []).map((d: { id: string }) => d.id)
      return [{ ...base, kind: 'select', type: inner.type, options, channelTypes: inner['channel_types'], placeholder: inner['placeholder'], required, min: inner['min_values'] ?? 1, max: inner['max_values'] ?? 1, picked }]
    }
    if (inner.type === 21) return [{ ...base, kind: 'radio', options, required, picked: defaults(options).slice(0, 1) }]
    if (inner.type === 22) return [{ ...base, kind: 'checks', options, required, min: inner['min_values'] ?? 1, max: inner['max_values'] ?? options.length, picked: defaults(options) }]
    if (inner.type === 23) return [{ ...base, kind: 'checkbox', checked: Boolean(inner['default']) }]
    return []
  })
}

// Discord's rule: an empty answer passes only when the field is optional; any answer
// must fall within min and max.
const answered = (field: Choice, count: number) => (count === 0 ? !field.required : count >= ('min' in field ? field.min : 1) && count <= ('max' in field ? field.max : 1))

export function ModalDialog({ modal, ctx, onClose, onResult }: { modal: OpenModal; ctx: MarkdownContext; onClose: () => void; onResult: (result: Awaited<ReturnType<typeof api.interaction>>) => void }) {
  const [list] = useState(() => fields(numbered(modal.data.components)))
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(list.flatMap((f) => (f.kind === 'text' ? [[f.customId, f.value]] : []))))
  const [picks, setPicks] = useState<Record<string, string[]>>(Object.fromEntries(list.flatMap((f) => ('picked' in f ? [[f.customId, f.picked]] : []))))
  const [checks, setChecks] = useState<Record<string, boolean>>(Object.fromEntries(list.flatMap((f) => (f.kind === 'checkbox' ? [[f.customId, f.checked]] : []))))
  const [files, setFiles] = useState<Record<string, File[]>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const close = () => leave(overlay.current, onClose)
  const firstText = list.find((f) => f.kind === 'text')
  const pick = (customId: string, next: string[]) => setPicks({ ...picks, [customId]: next })

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const components = []
      for (const f of list) {
        if (f.kind === 'display') {
          components.push({ type: 10, id: f.id })
          continue
        }
        const ids = { customId: f.customId, id: f.id, parentId: f.parentId, row: f.row }
        if (f.kind === 'text') components.push({ ...ids, type: 4, value: values[f.customId] ?? '' })
        else if (f.kind === 'file') {
          const attachmentIds = []
          for (const file of files[f.customId] ?? []) attachmentIds.push((await api.upload(file, file.name)).id)
          components.push({ ...ids, type: 19, attachmentIds })
        } else if (f.kind === 'select') components.push({ ...ids, type: f.type, values: picks[f.customId] ?? [] })
        else if (f.kind === 'radio') components.push({ ...ids, type: 21, value: picks[f.customId]?.[0] ?? null })
        else if (f.kind === 'checks') components.push({ ...ids, type: 22, values: picks[f.customId] ?? [] })
        else components.push({ ...ids, type: 23, value: Boolean(checks[f.customId]) })
      }
      const result = await api.interaction({ type: 'modal', channelId: modal.channelId, messageId: modal.messageId, customId: modal.data.custom_id, components })
      onClose()
      onResult(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const invalid = list.some((f) => {
    if (f.kind === 'text') {
      const value = values[f.customId] ?? ''
      return value.trim() ? value.length < (f.min ?? 0) : f.required
    }
    if (f.kind === 'file') return f.required && !(files[f.customId]?.length ?? 0)
    if ('picked' in f) return !answered(f, picks[f.customId]?.length ?? 0)
    return false
  })

  const head = (field: Labelled & { required?: boolean }) => (
    <>
      <span className="field-label">
        {field.label}
        {field.required && <span className="required">*</span>}
      </span>
      {field.description && <span className="field-description">{field.description}</span>}
    </>
  )

  return (
    <div ref={overlay} className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="grab" />
        <div className="modal-header">
          <h2>{modal.data.title}</h2>
          <button type="button" className="icon-button" onClick={close} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">
          {list.map((field, index) => {
            if (field.kind === 'display') return <Markdown key={index} text={field.content} ctx={ctx} />
            if (field.kind === 'file')
              return (
                <label key={field.customId} className="field">
                  {head(field)}
                  <input type="file" multiple={field.max > 1} onChange={(e) => setFiles({ ...files, [field.customId]: [...(e.target.files ?? [])].slice(0, field.max) })} />
                </label>
              )
            if (field.kind === 'select') {
              const options = field.type === 3 ? field.options : ctx.selectOptions?.(field.type, field.channelTypes) ?? []
              return (
                <div key={field.customId} className="field">
                  {head(field)}
                  <SelectMenu options={options} min={field.min} max={field.max} placeholder={field.placeholder} picked={picks[field.customId] ?? []} optional={!field.required} label={field.label} onPick={(next) => pick(field.customId, next)} />
                </div>
              )
            }
            if (field.kind === 'radio')
              return (
                <div key={field.customId} className="field">
                  {head(field)}
                  <Radios name={field.customId} label={field.label} value={picks[field.customId]?.[0] ?? null} options={field.options.map((o) => ({ id: o.value, label: o.label, note: o.description }))} onChange={(value) => pick(field.customId, [value])} />
                </div>
              )
            if (field.kind === 'checks') {
              const picked = picks[field.customId] ?? []
              return (
                <div key={field.customId} className="field">
                  {head(field)}
                  <div className="settings-radios" role="group" aria-label={field.label}>
                    {field.options.map((o) => {
                      const on = picked.includes(o.value)
                      return <Check key={o.value} label={o.label} note={o.description} checked={on} disabled={!on && picked.length >= field.max} onChange={() => pick(field.customId, on ? picked.filter((v) => v !== o.value) : [...picked, o.value])} />
                    })}
                  </div>
                </div>
              )
            }
            if (field.kind === 'checkbox')
              return (
                <div key={field.customId} className="field">
                  <Check label={field.label} note={field.description} checked={Boolean(checks[field.customId])} onChange={() => setChecks({ ...checks, [field.customId]: !checks[field.customId] })} />
                </div>
              )
            return (
              <label key={field.customId} className="field">
                {head(field)}
                {field.style === 2 ? (
                  <textarea rows={4} value={values[field.customId] ?? ''} placeholder={field.placeholder} minLength={field.min} maxLength={field.max} autoFocus={field === firstText} onChange={(e) => setValues({ ...values, [field.customId]: e.target.value })} />
                ) : (
                  <input value={values[field.customId] ?? ''} placeholder={field.placeholder} minLength={field.min} maxLength={field.max} autoFocus={field === firstText} onChange={(e) => setValues({ ...values, [field.customId]: e.target.value })} />
                )}
              </label>
            )
          })}
          {error && <div className="error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="button medium" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="button medium primary" disabled={busy || invalid}>
            {busy ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </form>
    </div>
  )
}

function Check({ label, note, checked, disabled, onChange }: { label: string; note?: string; checked: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <label className={`settings-radio modal-check${checked ? ' on' : ''}${disabled ? ' disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      <i className="settings-dot" aria-hidden="true">{checked && <svg viewBox="0 0 16 16" width="14" height="14"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" /></svg>}</i>
      <span className="settings-radio-text">
        <span>{label}</span>
        {note && <small>{note}</small>}
      </span>
    </label>
  )
}
