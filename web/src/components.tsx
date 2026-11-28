// Discord message components: action rows, buttons, string selects and the
// Components V2 layout (Container with accent, TextDisplay, Section,
// Separator, MediaGallery, File, Thumbnail).

import { useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { Attachment, Component } from './api.ts'
import { Markdown, inline, keyValueBlock, type MarkdownContext } from './markdown.tsx'
import { Icon, type IconName } from './icons.tsx'
import { emojify } from './emoji.tsx'
import { below, Sheet } from './Sheet.tsx'
import { Lightbox } from './Media.tsx'

export type Interact = (body: { type: 'button' | 'select'; customId: string; values?: string[] }) => Promise<void | false>

const BUTTON_STYLES: Record<number, string> = { 1: 'primary', 2: 'secondary', 3: 'success', 4: 'danger', 5: 'link', 6: 'primary' }

export function accentColor(value: number | null | undefined) {
  return value == null ? undefined : `#${value.toString(16).padStart(6, '0')}`
}

function emojiLabel(emoji: { name?: string } | undefined) {
  return emoji?.name && !/^\w+$/.test(emoji.name) ? <>{emojify(emoji.name)} </> : null
}

// Links from bots (embeds, buttons, media, files) open only http(s) URLs, or
// paths on this hub (attachments), like markdown links.
export function safeUrl(url: unknown): string | undefined {
  return typeof url === 'string' && (/^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url)) ? url : undefined
}

// Buttons keep the style the bot gave them, as in Discord: primary (accent), secondary
// (neutral), success (green), danger (red); link buttons open the URL.
function Button({ c, interact, disabled, first }: { c: Component; interact: Interact; disabled: boolean; first: boolean }) {
  const [busy, setBusy] = useState(false)
  const style = BUTTON_STYLES[c['style']] ?? 'secondary'
  if (style === 'link')
    return (
      <a className="button" href={safeUrl(c['url'])} target="_blank" rel="noreferrer noopener">
        {emojiLabel(c['emoji'])}
        {c['label']} <Icon name="external" size={14} />
      </a>
    )
  void first
  const kind = style === 'secondary' ? '' : style
  return (
    <button
      className={`button ${kind}${busy ? ' busy' : ''}`}
      disabled={disabled || c['disabled'] || busy}
      onClick={async () => {
        // One request in flight per button: a double click must not answer twice.
        if (busy) return
        setBusy(true)
        await interact({ type: 'button', customId: c['custom_id'] }).finally(() => setBusy(false))
      }}
    >
      {emojiLabel(c['emoji'])}
      {c['label']}
    </button>
  )
}

export type Option = { label: string; value: string; description?: string; default?: boolean; emoji?: { name?: string } }

function Select({ c, interact, disabled }: { c: Component; interact: Interact; disabled: boolean }) {
  const options: Option[] = c['options'] ?? []
  const [picked, setPicked] = useState<string[]>(options.filter((o) => o.default).map((o) => o.value))
  const [busy, setBusy] = useState(false)
  const submit = async (values: string[]) => {
    setBusy(true)
    try {
      if (await interact({ type: 'select', customId: c['custom_id'], values }) !== false) setPicked(values)
    } finally { setBusy(false) }
  }
  return <SelectMenu options={options} min={c['min_values'] ?? 1} max={c['max_values'] ?? 1} placeholder={c['placeholder']} picked={picked} busy={busy} disabled={disabled || c['disabled']} onPick={(values) => void submit(values)} />
}

/** A select's trigger and its field-anchored list (a sheet on phones). A modal's optional
 *  select may be left empty: picking its one value again clears it, and Done takes none. */
export function SelectMenu({ options, min, max, placeholder, picked, busy = false, disabled, optional = false, label, onPick }: { options: Option[]; min: number; max: number; placeholder?: string; picked: string[]; busy?: boolean; disabled?: boolean; optional?: boolean; label?: string; onPick: (values: string[]) => void }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<ReturnType<typeof below> | null>(null)
  const [draft, setDraft] = useState<string[]>([])
  const title = placeholder || 'Make a selection'
  const shown = options.filter((o) => picked.includes(o.value)).map((o) => o.label).join(', ')
  return (
    <div className={`select${at ? ' open' : ''}`}>
      <button type="button" ref={trigger} className="select-trigger" aria-haspopup="dialog" aria-expanded={Boolean(at)} aria-busy={busy} aria-label={label && `${label}: ${shown || title}`} disabled={disabled} onClick={(e) => {
        if (busy) return
        setDraft(picked)
        setAt(below(e.currentTarget, 'start'))
      }}>
        <span className={shown ? '' : 'muted'}>{shown || title}</span>
        <Icon name="down" size={16} />
      </button>
      {at && trigger.current && createPortal(<Sheet spec={{ title, groups: [], at, plain: true }} onClose={() => setAt(null)} picker={{ trigger: trigger.current, body: (finish, cancel) => <>
        <div className="sheet-group choice-options" role="listbox" aria-label={title} aria-multiselectable={max > 1 || undefined}>
          {options.map((option) => {
            const on = draft.includes(option.value)
            return (
              <button
                key={option.value}
                className={`sheet-item${option.description ? ' two-line' : ''}`} role="option" aria-selected={on} disabled={!on && max > 1 && draft.length >= max}
                onClick={() => {
                  if (max === 1) finish(() => onPick(on && optional ? [] : [option.value]))
                  else setDraft(on ? draft.filter((v) => v !== option.value) : [...draft, option.value])
                }}
              >
                <span className="sheet-item-text">
                  <span>{emojiLabel(option.emoji)}{option.label}</span>
                  {option.description && <span className="sheet-sub-label">{option.description}</span>}
                </span>
                {on && <Icon name="check" size={16} />}
              </button>
            )
          })}
          {!options.length && <span className="choice-empty">No options available</span>}
        </div>
        {max > 1 && <div className="choice-foot"><span className="num">{draft.length} of {max} selected</span><button className="button choice-cancel" onClick={cancel}>Cancel</button><button className="button primary" disabled={draft.length < min && !(optional && !draft.length)} onClick={() => finish(() => onPick(draft))}>Done</button></div>}
        {max === 1 && !options.length && <button className="button choice-cancel" onClick={cancel}>Close</button>}
      </> }} />, document.body)}
    </div>
  )
}

function Media({ url, description, spoiler }: { url: string; description?: string; spoiler?: boolean }) {
  const [open, setOpen] = useState(false)
  const [revealed, reveal] = useState(!spoiler)
  const path = url.split('?')[0]!.toLowerCase()
  if (/\.(mp4|webm|mov)$/.test(path)) return <video className="media" src={url} controls preload="metadata" />
  if (/\.(mp3|ogg|wav|m4a|opus)$/.test(path)) return <audio src={url} controls preload="metadata" />
  return (
    <><button type="button" onClick={() => revealed ? setOpen(true) : reveal(true)} aria-label={revealed ? `Preview ${description || 'image'}` : 'Show spoiler'} className={!revealed ? 'spoiler-media' : ''}>
      <img className="media" src={url} alt={description ?? ''} loading="lazy" />
    </button>{open && safeUrl(url) && <Lightbox items={[{ url, name: description || 'Image' }]} start={0} onClose={() => setOpen(false)} />}</>
  )
}

export function FileCard({ url, name, size }: { url: string; name: string; size?: number }) {
  return (
    <a className="file-card" href={safeUrl(url)} target="_blank" rel="noreferrer noopener" download={name}>
      <Icon name="file" size={18} />
      <span className="file-name">{name}</span>
      {size != null && <span className="file-size">{size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`}</span>}
      <span className="file-open">Open</span>
    </a>
  )
}

// A container's accent shows as Discord's 4px bar on the left; grey or no accent, no bar.
function accentBar(accent: number | null | undefined): string | null {
  if (accent == null) return null
  const r = (accent >> 16) & 255
  const g = (accent >> 8) & 255
  const b = accent & 255
  if (Math.max(r, g, b) - Math.min(r, g, b) < 30) return null
  return `rgb(${r} ${g} ${b})`
}

// Groups of "**Label** value" lines split by separators, with the same labels in each
// group, read better side by side: one table instead of a tall stack (Discord shows the
// stack). Titled groups become rows; untitled groups become columns headed by their
// first value.
function comparison(children: Component[]): { head: string[]; rows: Array<[string, string[]]> } | null {
  const groups: Array<NonNullable<ReturnType<typeof keyValueBlock>>> = []
  for (const [i, c] of children.entries()) {
    if (i % 2 === 1) {
      if (c.type !== 14) return null
      continue
    }
    const kv = c.type === 10 ? keyValueBlock(c['content'] ?? '') : null
    if (!kv) return null
    groups.push(kv)
  }
  if (groups.length < 2 || children.length % 2 === 0) return null
  const labels = groups[0]!.rows.map(([label]) => label)
  if (groups.some((g) => g.rows.length !== labels.length || g.rows.some(([label], j) => label !== labels[j]))) return null
  const titled = groups.every((g) => g.title)
  if (titled) return { head: ['', ...labels], rows: groups.map((g) => [g.title!, g.rows.map(([, v]) => v)]) }
  if (groups.some((g) => g.title) || labels.length < 2 || groups.length > 4) return null
  return { head: [labels[0]!, ...groups.map((g) => g.rows[0]![1])], rows: labels.slice(1).map((label, j) => [label, groups.map((g) => g.rows[j + 1]![1])]) }
}

function Comparison({ table, ctx }: { table: NonNullable<ReturnType<typeof comparison>>; ctx: MarkdownContext }) {
  return (
    <div className="kv-table-wrap">
      <table className="kv-table">
        <thead>
          <tr>
            {table.head.map((h, j) => (
              <th key={j} scope="col">
                {inline(h, ctx, `h${j}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map(([label, values], r) => (
            <tr key={r}>
              <th scope="row">{inline(label, ctx, `r${r}`)}</th>
              {values.map((v, j) => (
                <td key={j}>{inline(v, ctx, `r${r}-${j}`)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Discord may supply both the attachment and a gallery entry for the same
// image. Keep the existing attachment preview; leave unrelated items alone.
export function uniqueGallery(components: Component[], attachments: Attachment[]): Component[] {
  const images = attachments.filter(a => !a.missing && a.url && (a.content_type?.startsWith('image/') || /\.(?:png|jpe?g|gif|webp|avif)$/i.test(a.filename)))
  if (!images.length) return components
  const same = (url: unknown, a: Attachment) => {
    if (typeof url !== 'string') return false
    if ([a.url,a.proxy_url,`attachment://${a.filename}`].includes(url)) return true
    try { const u = new URL(url,location.origin); return /^(https?:)$/.test(u.protocol) && u.pathname.split('/').at(-2) === a.id && u.pathname.includes('/attachments/') } catch { return false }
  }
  return components.flatMap(c => {
    if (c.type === 12) {
      const items = (c['items'] ?? []).filter((i: { media?: { url?: string; proxy_url?: string }; spoiler?: boolean; description?: string }) => i.spoiler || !images.some(a => (!i.description || i.description === a.description || i.description === a.filename) && (same(i.media?.url,a) || same(i.media?.proxy_url,a))))
      return items.length ? [{ ...c, items }] : []
    }
    return [Array.isArray(c['components']) ? { ...c, components: uniqueGallery(c['components'], images) } : c]
  })
}

export function Components({ components, ctx, interact, disabled = false }: { components: Component[]; ctx: MarkdownContext; interact: Interact; disabled?: boolean }) {
  return (
    <>
      {components.map((c, index) => (
        <ComponentView key={c['id'] ?? index} c={c} ctx={ctx} interact={interact} disabled={disabled} />
      ))}
    </>
  )
}

function ComponentView({ c, ctx, interact, disabled }: { c: Component; ctx: MarkdownContext; interact: Interact; disabled: boolean }) {
  switch (c.type) {
    case 1:
      return (
        <div className="action-row">
          {(c['components'] ?? []).map((child: Component, index: number) =>
            child.type === 2 ? (
              <Button key={child['custom_id'] ?? index} c={child} interact={interact} disabled={disabled} first={index === 0} />
            ) : (
              <ComponentView key={child['custom_id'] ?? index} c={child} ctx={ctx} interact={interact} disabled={disabled} />
            ),
          )}
        </div>
      )
    case 2:
      return <Button c={c} interact={interact} disabled={disabled} first={false} />
    case 3:
    case 5:
    case 6:
    case 7:
    case 8:
      // A bot may reuse the custom id for the next page or step. Its new options and
      // defaults own the trigger; don't carry a selection across an edited response.
      const options: Option[] = c.type === 3 ? c['options'] ?? [] : ctx.selectOptions?.(c.type, c['channel_types']) ?? []
      return <Select key={JSON.stringify([c['custom_id'], c['placeholder'], c['min_values'], c['max_values'], c['disabled'], options.map((o) => [o.value, o.default])])} c={{ ...c, options }} interact={interact} disabled={disabled} />
    case 9:
      return (
        <div className="section">
          <div className="section-body">
            <Components components={c['components'] ?? []} ctx={ctx} interact={interact} disabled={disabled} />
          </div>
          {c['accessory'] && (
            <div className="section-accessory">
              <ComponentView c={c['accessory']} ctx={ctx} interact={interact} disabled={disabled} />
            </div>
          )}
        </div>
      )
    case 10:
      return <Markdown text={c['content'] ?? ''} ctx={ctx} />
    case 11:
      return <img className="thumbnail" src={c['media']?.url} alt={c['description'] ?? ''} loading="lazy" />
    case 12:
      return (
        <div className={`gallery gallery-${Math.min((c['items'] ?? []).length, 4)}`}>
          {(c['items'] ?? []).map((item: { media: { url: string }; description?: string; spoiler?: boolean }, index: number) => (
            <Media key={index} url={item.media.url} description={item.description} spoiler={item.spoiler} />
          ))}
        </div>
      )
    case 13: {
      const url: string = c['file']?.url ?? ''
      return <FileCard url={url} name={c['name'] ?? decodeURIComponent(url.split('?')[0]!.split('/').pop() ?? 'file')} size={c['size']} />
    }
    case 14:
      return <div className={`separator${c['divider'] === false ? ' invisible' : ''}${c['spacing'] === 2 ? ' large' : ''}`} />
    case 17: {
      const bar = accentBar(c['accent_color'])
      const table = comparison(c['components'] ?? [])
      return (
        <div className={`container${bar ? ' accented' : ''}${c['spoiler'] ? ' spoiler-container' : ''}`} style={bar ? ({ '--bar': bar } as CSSProperties) : undefined}>
          {table ? <Comparison table={table} ctx={ctx} /> : <Components components={c['components'] ?? []} ctx={ctx} interact={interact} disabled={disabled} />}
        </div>
      )
    }
    default:
      return null
  }
}

// The loading mark: Vocorum's V draws itself, then flips left and right. No words.
export function LoadingMark({ size = 56, label = 'Loading' }: { size?: number; label?: string }) {
  return (
    <span className="loading-mark" role="status" aria-label={label} style={{ width: size, height: size }}>
      <svg className="mark" viewBox="0 0 48 48" aria-hidden="true">
        <path className="mark-v" d="M12 14 24 34 36 14" />
      </svg>
    </span>
  )
}
