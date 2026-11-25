// Discord message components: action rows, buttons, string selects and the
// Components V2 layout (Container with accent, TextDisplay, Section,
// Separator, MediaGallery, File, Thumbnail).

import { useState, type CSSProperties } from 'react'
import type { Component } from './api.ts'
import { Markdown, inline, keyValueBlock, type MarkdownContext } from './markdown.tsx'
import { Icon, type IconName } from './icons.tsx'
import { emojify } from './emoji.tsx'

export type Interact = (body: { type: 'button' | 'select'; customId: string; values?: string[] }) => Promise<void>

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

function Select({ c, interact, disabled }: { c: Component; interact: Interact; disabled: boolean }) {
  const options: Array<{ label: string; value: string; description?: string; default?: boolean; emoji?: { name?: string } }> = c['options'] ?? []
  const max = c['max_values'] ?? 1
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<string[]>(options.filter((o) => o.default).map((o) => o.value))
  const [busy, setBusy] = useState(false)
  const submit = async (values: string[]) => {
    setOpen(false)
    setBusy(true)
    await interact({ type: 'select', customId: c['custom_id'], values }).finally(() => setBusy(false))
  }
  const label = picked.length ? options.filter((o) => picked.includes(o.value)).map((o) => o.label).join(', ') : (c['placeholder'] ?? 'Make a selection')
  return (
    <div className={`select${open ? ' open' : ''}`}>
      <button className="select-trigger" disabled={disabled || c['disabled'] || busy} onClick={() => setOpen(!open)}>
        <span className={picked.length ? '' : 'muted'}>{label}</span>
        <Icon name="down" size={16} />
      </button>
      {open && (
        <div className="select-menu">
          {options.map((option) => {
            const on = picked.includes(option.value)
            return (
              <button
                key={option.value}
                className={`select-option${on ? ' on' : ''}`}
                onClick={() => {
                  if (max === 1) {
                    setPicked([option.value])
                    void submit([option.value])
                    return
                  }
                  setPicked(on ? picked.filter((v) => v !== option.value) : [...picked, option.value].slice(0, max))
                }}
              >
                {max > 1 && <Icon name={on ? 'check' : 'todo'} size={16} />}
                <span>
                  {emojiLabel(option.emoji)}
                  {option.label}
                  {option.description && <span className="option-description">{option.description}</span>}
                </span>
              </button>
            )
          })}
          {max > 1 && (
            <button className="button primary select-done" disabled={picked.length < (c['min_values'] ?? 1)} onClick={() => void submit(picked)}>
              Done
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function Media({ url, description, spoiler }: { url: string; description?: string; spoiler?: boolean }) {
  const path = url.split('?')[0]!.toLowerCase()
  if (/\.(mp4|webm|mov)$/.test(path)) return <video className="media" src={url} controls preload="metadata" />
  if (/\.(mp3|ogg|wav|m4a|opus)$/.test(path)) return <audio src={url} controls preload="metadata" />
  return (
    <a href={safeUrl(url)} target="_blank" rel="noreferrer noopener" className={spoiler ? 'spoiler-media' : ''}>
      <img className="media" src={url} alt={description ?? ''} loading="lazy" />
    </a>
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
      return <Select c={c.type === 3 ? c : { ...c, options: ctx.selectOptions?.(c.type, c['channel_types']) ?? [] }} interact={interact} disabled={disabled} />
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
