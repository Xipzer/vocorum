// A modal a bot opened (interaction response type 9): text inputs, file
// uploads and text displays, submitted back as a modal interaction.

import { useState } from 'react'
import { api, type Component } from './api.ts'
import { Markdown, type MarkdownContext } from './markdown.tsx'
import { Icon } from './icons.tsx'

export type OpenModal = { channelId: string; messageId?: string; data: { custom_id: string; title: string; components: Component[] } }

type Field = { kind: 'text'; customId: string; label: string; style: number; placeholder?: string; required: boolean; min?: number; max?: number; value: string; description?: string } | { kind: 'file'; customId: string; label: string; max: number; required: boolean; description?: string } | { kind: 'display'; content: string }

function fields(components: Component[]): Field[] {
  return components.flatMap((c): Field[] => {
    if (c.type === 1) return fields(c['components'] ?? [])
    if (c.type === 10) return [{ kind: 'display', content: c['content'] ?? '' }]
    const inner = c.type === 18 ? c['component'] : c
    const label = c.type === 18 ? c['label'] : inner?.['label']
    const description = c.type === 18 ? c['description'] : undefined
    if (inner?.type === 4)
      return [{ kind: 'text', customId: inner['custom_id'], label: label ?? '', style: inner['style'] ?? 1, placeholder: inner['placeholder'], required: inner['required'] ?? true, min: inner['min_length'], max: inner['max_length'], value: inner['value'] ?? '', description }]
    if (inner?.type === 19) return [{ kind: 'file', customId: inner['custom_id'], label: label ?? 'Files', max: inner['max_values'] ?? 1, required: inner['required'] ?? true, description }]
    return []
  })
}

export function ModalDialog({ modal, ctx, onClose, onResult }: { modal: OpenModal; ctx: MarkdownContext; onClose: () => void; onResult: (result: Awaited<ReturnType<typeof api.interaction>>) => void }) {
  const list = fields(modal.data.components)
  const [values, setValues] = useState<Record<string, string>>(Object.fromEntries(list.flatMap((f) => (f.kind === 'text' ? [[f.customId, f.value]] : []))))
  const [files, setFiles] = useState<Record<string, File[]>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const uploads = []
      for (const field of list) {
        if (field.kind !== 'file') continue
        const ids = []
        for (const file of files[field.customId] ?? []) ids.push((await api.upload(file, file.name)).id)
        uploads.push({ customId: field.customId, attachmentIds: ids })
      }
      const result = await api.interaction({
        type: 'modal',
        channelId: modal.channelId,
        messageId: modal.messageId,
        customId: modal.data.custom_id,
        fields: Object.entries(values).map(([customId, value]) => ({ customId, value })),
        files: uploads,
      })
      onClose()
      onResult(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const invalid = list.some((f) => (f.kind === 'text' ? f.required && !values[f.customId]?.trim() : f.kind === 'file' ? f.required && !(files[f.customId]?.length ?? 0) : false))

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
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
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">
          {list.map((field, index) => {
            if (field.kind === 'display') return <Markdown key={index} text={field.content} ctx={ctx} />
            if (field.kind === 'file')
              return (
                <label key={field.customId} className="field">
                  <span className="field-label">
                    {field.label}
                    {field.required && <span className="required">*</span>}
                  </span>
                  {field.description && <span className="field-description">{field.description}</span>}
                  <input type="file" multiple={field.max > 1} onChange={(e) => setFiles({ ...files, [field.customId]: [...(e.target.files ?? [])].slice(0, field.max) })} />
                </label>
              )
            return (
              <label key={field.customId} className="field">
                <span className="field-label">
                  {field.label}
                  {field.required && <span className="required">*</span>}
                </span>
                {field.description && <span className="field-description">{field.description}</span>}
                {field.style === 2 ? (
                  <textarea rows={4} value={values[field.customId] ?? ''} placeholder={field.placeholder} maxLength={field.max} autoFocus={index === 0} onChange={(e) => setValues({ ...values, [field.customId]: e.target.value })} />
                ) : (
                  <input value={values[field.customId] ?? ''} placeholder={field.placeholder} maxLength={field.max} autoFocus={index === 0} onChange={(e) => setValues({ ...values, [field.customId]: e.target.value })} />
                )}
              </label>
            )
          })}
          {error && <div className="error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy || invalid}>
            {busy ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </form>
    </div>
  )
}
