// What a message carries besides its text, laid out like Discord's: attachment mosaics with a
// lightbox, video and audio players, text-file previews, file cards, embeds (rich cards, link
// previews, video and gif embeds), forwards, stickers and polls.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Attachment, Embed, EmbedMedia, Poll, Snapshot, StickerItem } from './api.ts'
import { highlight } from './highlight.tsx'
import { Icon } from './icons.tsx'
import { Markdown, type MarkdownContext } from './markdown.tsx'
import { clock, leave } from './text.ts'
import { native } from './native.ts'

const IS_VOICE = 1 << 13
const IS_SPOILER = 1 << 3

export function bytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(2)} KB` : `${(n / 1048576).toFixed(2)} MB`
}

// "Today at 15:45", "Yesterday at 09:10", "24/11/2026 15:45": Discord's footer timestamps.
export function stamp(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const day = d.toDateString()
  if (day === new Date().toDateString()) return `Today at ${clock(iso)}`
  if (day === new Date(Date.now() - 86_400_000).toDateString()) return `Yesterday at ${clock(iso)}`
  return `${d.toLocaleDateString()} ${clock(iso)}`
}

const web = (url: unknown): string | undefined => (typeof url === 'string' && /^(https?:\/\/|\/)/i.test(url) ? url : undefined)
// Picture sources may also be inline images.
const pic = (url: unknown): string | undefined => web(url) ?? (typeof url === 'string' && /^data:image\/(png|jpe?g|gif|webp);/i.test(url) ? url : undefined)
const ext = (name: string) => /\.([a-z0-9]+)$/i.exec(name.split('?')[0]!)?.[1]?.toLowerCase() ?? ''
const kindOf = (a: Attachment): 'image' | 'video' | 'audio' | 'text' | 'file' => {
  const type = a.content_type ?? ''
  const e = ext(a.filename)
  if (type.startsWith('image/') || /^(png|jpe?g|gif|webp|avif|bmp)$/.test(e)) return 'image'
  if (type.startsWith('video/') || /^(mp4|webm|mov|m4v)$/.test(e)) return 'video'
  if (type.startsWith('audio/') || /^(mp3|ogg|oga|opus|wav|m4a|flac|aac)$/.test(e)) return 'audio'
  if (a.size <= 100_000 && (type.startsWith('text/') || /json|javascript|typescript|xml|yaml|toml/.test(type) || TEXT_LANG[e] !== undefined)) return 'text'
  return 'file'
}
const TEXT_LANG: Record<string, string> = { txt: '', log: '', md: 'md', markdown: 'md', json: 'json', jsonl: 'json', ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', py: 'py', rs: 'rust', go: 'go', sh: 'sh', bash: 'sh', zsh: 'sh', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: '', conf: '', cfg: '', csv: '', tsv: '', sql: 'sql', css: 'css', html: 'html', xml: 'xml', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', swift: 'swift', diff: 'diff', patch: 'diff', lua: 'lua', sol: 'solidity', env: '' }
export const isSpoiler = (a: Attachment) => a.filename.startsWith('SPOILER_') || ((a.flags ?? 0) & IS_SPOILER) !== 0 || Boolean(a.spoiler)

// --- lightbox

export type Viewable = { url: string; name: string; size?: number; width?: number | null; height?: number | null; video?: boolean }

export function Lightbox({ items, start, onClose: closed }: { items: Viewable[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start)
  const layer = useRef<HTMLDivElement>(null)
  const onClose = () => leave(layer.current, closed, 130, true)
  const [zoom, setZoom] = useState<{ x: number; y: number; width: number; clientX: number; clientY: number } | null>(null)
  const picture = useRef<HTMLImageElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const item = items[index] ?? items[0]!
  const step = (by: number) => setIndex((i) => (i + by + items.length) % items.length)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    close.current?.focus({ preventScroll: true, focusVisible: false } as FocusOptions)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && items.length > 1) step(-1)
      else if (e.key === 'ArrowRight' && items.length > 1) step(1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      before?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length])
  useEffect(() => setZoom(null), [index])
  // Zoom keeps the clicked point under the pointer.
  useLayoutEffect(() => {
    const el = stage.current
    if (!el || !zoom) return
    const r = picture.current?.getBoundingClientRect()
    if (!r) return
    el.scrollLeft += r.left + zoom.x * r.width - zoom.clientX
    el.scrollTop += r.top + zoom.y * r.height - zoom.clientY
  }, [zoom])
  const magnify = (x?: number, y?: number) => {
    const r = picture.current?.getBoundingClientRect()
    if (!r) return
    const clientX = x ?? r.left + r.width / 2, clientY = y ?? r.top + r.height / 2
    setZoom(zoom ? null : { x: (clientX-r.left)/r.width, y: (clientY-r.top)/r.height, width: r.width * 2, clientX, clientY })
  }
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
  return createPortal(
    <div ref={layer} className="lightbox" role="dialog" aria-modal="true" aria-label={item.name} onClick={onClose}>
      <div className="lightbox-bar" onClick={stop}>
        <span className="lightbox-name">{item.name}</span>
        <span className="lightbox-meta num">
          {items.length > 1 && `${index + 1} of ${items.length}`}
          {items.length > 1 && item.size != null && ' · '}
          {item.size != null && bytes(item.size)}
        </span>
        {!item.video && <button className="viewer-action" onClick={() => magnify()}>{zoom ? 'Fit' : 'Zoom in'}</button>}
        <a className="viewer-action" href={item.url} download={item.name} aria-label="Download" title="Download">
          <Icon name="download" size={22} /> Download
        </a>
        <button ref={close} className="icon-button" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="close" size={24} />
        </button>
      </div>
      <div ref={stage} className={`lightbox-stage${zoom ? ' zoomed' : ''}`}>
        {item.video ? (
          <video key={item.url} src={item.url} controls autoPlay onClick={stop} />
        ) : (
          <img
            key={item.url}
            ref={picture}
            style={zoom ? { width: zoom.width, height: 'auto' } : undefined}
            src={item.url}
            alt={item.name}
            onClick={(e) => {
              e.stopPropagation()
              magnify(e.clientX, e.clientY)
            }}
          />
        )}
      </div>
      {items.length > 1 && (
        <>
          <button className="lightbox-nav prev" onClick={(e) => (stop(e), step(-1))} aria-label="Previous" title="Previous">
            <Icon name="back" size={24} />
          </button>
          <button className="lightbox-nav next" onClick={(e) => (stop(e), step(1))} aria-label="Next" title="Next">
            <Icon name="chevron" size={24} />
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}

// --- images

// Message images ask the hub for a copy about as wide as they show: an original photo
// decodes to tens of megabytes. The lightbox still opens the original.
function previewUrl(url: string, width: number | null | undefined, shownWidth: number) {
  const want = Math.ceil(shownWidth * Math.min(window.devicePixelRatio || 1, 2))
  if (!url.startsWith('/attachments/') || (width && width <= want)) return url
  return `${url}${url.includes('?') ? '&' : '?'}width=${want}`
}

function MediaCell({ item, spoiler, onOpen, fit }: { item: Viewable; spoiler?: boolean; onOpen: () => void; fit?: { maxW: number; maxH: number } }) {
  const [shown, setShown] = useState(!spoiler)
  const [failed, setFailed] = useState(false)
  // A lone image keeps its shape inside Discord's box; known sizes reserve the space.
  let style: CSSProperties | undefined
  if (fit && item.width && item.height) {
    const scale = Math.min(1, fit.maxW / item.width, fit.maxH / item.height)
    style = { width: Math.round(item.width * scale), aspectRatio: `${item.width} / ${item.height}` }
  }
  // A mosaic cell has a fixed shape. A picture smaller than its cell keeps its own size,
  // centred: stretching a small screenshot to fill the cell only blurs it.
  const [loaded, setLoaded] = useState<{ width: number; height: number } | null>(null)
  const own = item.width && item.height ? { width: item.width, height: item.height } : loaded
  const cap: CSSProperties | undefined = !fit && own ? { maxWidth: own.width, maxHeight: own.height } : undefined
  if (failed)
    return (
      <a className="media-cell failed" href={item.url} target="_blank" rel="noreferrer noopener" style={style} title={item.name}>
        <Icon name="image" size={28} />
        <span>{item.name}</span>
      </a>
    )
  return (
    <div className={`media-cell${fit ? ' single' : ''}${shown ? '' : ' spoiler'}`} style={style}>
      <button className="media-open" onClick={() => (shown ? onOpen() : setShown(true))} aria-label={shown ? `Open ${item.name}` : 'Show spoiler'}>
        {item.video ? <video src={`${item.url}#t=0.1`} muted playsInline preload="metadata" /> : <img src={previewUrl(item.url, item.width, typeof style?.width === 'number' ? style.width : 400)} alt={item.name} loading="lazy" decoding="async" style={cap} onLoad={fit || own ? undefined : (e) => setLoaded({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })} onError={() => setFailed(true)} />}
        {item.video && shown && (
          <span className="media-play">
            <Icon name="play" size={20} />
          </span>
        )}
      </button>
      {!shown && <span className="spoiler-pill">Spoiler</span>}
    </div>
  )
}

// Discord's mosaic: 1 large; 2 side by side; 3 = one large and two stacked; 4 = 2×2;
// more fill rows of three, any remainder (one or two) on top.
function rowsFor(n: number): number[] {
  if (n <= 2) return [n]
  if (n === 4) return [2, 2]
  const out = n % 3 ? [n % 3] : []
  for (let i = 0; i < Math.floor(n / 3); i++) out.push(3)
  return out
}

export function Mosaic({ items, spoilers, onOpen }: { items: Viewable[]; spoilers: boolean[]; onOpen: (index: number) => void }) {
  if (items.length === 1) return <MediaCell item={items[0]!} spoiler={spoilers[0]} onOpen={() => onOpen(0)} fit={{ maxW: 550, maxH: 350 }} />
  const cell = (i: number) => <MediaCell key={`${i}-${items[i]!.url}`} item={items[i]!} spoiler={spoilers[i]} onOpen={() => onOpen(i)} />
  if (items.length === 3)
    return (
      <div className="mosaic mosaic-3">
        {cell(0)}
        <div className="mosaic-stack">
          {cell(1)}
          {cell(2)}
        </div>
      </div>
    )
  let at = 0
  return (
    <div className="mosaic">
      {rowsFor(items.length).map((count, r) => {
        const start = at
        at += count
        return (
          <div key={r} className={`mosaic-row cols-${count}${items.length === 2 ? ' pair' : ''}`}>
            {Array.from({ length: count }, (_, i) => cell(start + i))}
          </div>
        )
      })}
    </div>
  )
}

// --- files

function FileGlyph({ kind }: { kind: string }) {
  return (
    <span className={`file-glyph ${kind}`} aria-hidden="true">
      <svg width="30" height="40" viewBox="0 0 24 32" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round">
        <path d="M2.5 1.5h12l7 7v22h-19z" vectorEffect="non-scaling-stroke" />
        <path d="M14.5 1.5v7h7" vectorEffect="non-scaling-stroke" />
      </svg>
    </span>
  )
}

function FileRow({ a, kind = 'file', children }: { a: Attachment; kind?: string; children?: ReactNode }) {
  return (
    <div className="file-row">
      <FileGlyph kind={kind} />
      <div className="file-meta">
        <a className="file-link" href={a.url} target="_blank" rel="noreferrer noopener" title={a.filename}>
          {a.filename}
        </a>
        <span className="file-bytes num">{bytes(a.size)}</span>
      </div>
      {children}
      <a className="file-download" href={a.url} download={a.filename} aria-label={`Download ${a.filename}`} title="Download">
        <Icon name="download" size={20} />
      </a>
    </div>
  )
}

function AudioAttachment({ a }: { a: Attachment }) {
  return (
    <div className="file-box audio">
      <FileRow a={a} kind="audio" />
      <audio src={a.url} controls preload="none" />
    </div>
  )
}

const PREVIEW_LINES = 6

function TextAttachment({ a }: { a: Attachment }) {
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let live = true
    fetch(a.url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => live && setText(t.replace(/\r\n/g, '\n').replace(/\n$/, '')))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [a.url])
  if (failed)
    return (
      <div className="file-box">
        <FileRow a={a} />
      </div>
    )
  const lines = text === null ? [] : text.split('\n')
  const more = lines.length > PREVIEW_LINES
  const shown = open || !more ? lines : lines.slice(0, PREVIEW_LINES)
  const lang = TEXT_LANG[ext(a.filename)] ?? ''
  return (
    <div className={`text-file${open ? ' open' : ''}`}>
      <pre className="text-file-body" style={text === null ? { minHeight: PREVIEW_LINES * 16 + 32 } : undefined}>
        <code>{text === null ? null : highlight(lang, shown.join('\n'))}</code>
      </pre>
      <div className="text-file-foot">
        {more && (
          <button className="icon-button text-file-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'} title={open ? 'Collapse' : `Expand (${lines.length} lines)`}>
            <Icon name="down" size={18} />
          </button>
        )}
        <span className="text-file-meta">
          <span className="text-file-name">{a.filename}</span>
          <span className="file-bytes num">
            {bytes(a.size)}
            {text !== null && ` · ${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`}
          </span>
        </span>
        <a className="icon-button" href={a.url} target="_blank" rel="noreferrer noopener" aria-label="View whole file" title="View whole file">
          <Icon name="external" size={24} />
        </a>
        <a className="icon-button" href={a.url} download={a.filename} aria-label={`Download ${a.filename}`} title="Download">
          <Icon name="download" size={24} />
        </a>
      </div>
    </div>
  )
}

function VideoAttachment({ a, onOpen }: { a: Attachment; onOpen: () => void }) {
  const [shown, setShown] = useState(!isSpoiler(a))
  const style: CSSProperties | undefined = a.width && a.height ? { width: Math.round(a.width * Math.min(1, 550 / a.width, 350 / a.height)), aspectRatio: `${a.width} / ${a.height}` } : undefined
  return (
    <div className={`video-attachment${shown ? '' : ' spoiler'}`} style={style}>
      {/* #t=0.1 asks for the first frame as the poster. */}
      <video src={`${a.url}#t=0.1`} controls={shown} preload="metadata" playsInline />
      {shown ? (
        <button className="video-expand icon-button" onClick={onOpen} aria-label="Open full screen" title="Open in viewer">
          <Icon name="external" size={16} />
        </button>
      ) : (
        <button className="spoiler-cover" onClick={() => setShown(true)} aria-label="Show spoiler">
          <span className="spoiler-pill">Spoiler</span>
        </button>
      )}
    </div>
  )
}

// A file Discord deleted before the hub could copy it: its name, kind and size, never a load.
function MissingFile({ a }: { a: Attachment }) {
  const kind = kindOf(a)
  const what = kind === 'image' ? 'Image' : kind === 'video' ? 'Video' : kind === 'audio' ? (a.waveform ? 'Voice message' : 'Audio') : 'File'
  return (
    <div className="missing-file" title={`${a.filename} was deleted from Discord before the hub copied it`}>
      <Icon name="file" size={20} />
      <span className="missing-name">{a.filename}</span>
      <span className="missing-note">
        {what} no longer available{a.size ? ` · ${bytes(a.size)}` : ''}
      </span>
    </div>
  )
}

export function Attachments({ attachments: all, flags, voice: Voice }: { attachments: Attachment[]; flags?: number; voice?: (a: Attachment) => ReactNode }) {
  const [view, setView] = useState<{ items: Viewable[]; index: number } | null>(null)
  if (!all.length) return null
  const gone = all.filter((a) => a.missing || !a.url)
  const attachments = all.filter((a) => !(a.missing || !a.url))
  if (!attachments.length)
    return (
      <div className="attachments">
        {gone.map((a) => (
          <MissingFile key={a.id} a={a} />
        ))}
      </div>
    )
  const voice = ((flags ?? 0) & IS_VOICE) !== 0
  const kinds = attachments.map(kindOf)
  const images = attachments.filter((_, i) => kinds[i] === 'image')
  const videos = attachments.filter((_, i) => kinds[i] === 'video')
  const viewable = (a: Attachment, video = false): Viewable => ({ url: a.url, name: a.filename, size: a.size, width: a.width, height: a.height, video })
  const gallery = [...images.map((a) => viewable(a)), ...videos.map((a) => viewable(a, true))]
  return (
    <div className="attachments">
      {images.length > 0 && <Mosaic items={images.map((a) => viewable(a))} spoilers={images.map(isSpoiler)} onOpen={(index) => setView({ items: gallery, index })} />}
      {videos.map((a, i) => (
        <VideoAttachment key={a.id} a={a} onOpen={() => setView({ items: gallery, index: images.length + i })} />
      ))}
      {attachments.map((a, i) => {
        const kind = kinds[i]
        if (kind === 'audio') return voice && Voice ? <div key={a.id}>{Voice(a)}</div> : <AudioAttachment key={a.id} a={a} />
        if (kind === 'text') return <TextAttachment key={a.id} a={a} />
        if (kind === 'file')
          return (
            <div key={a.id} className="file-box">
              <FileRow a={a} />
            </div>
          )
        return null
      })}
      {gone.map((a) => (
        <MissingFile key={a.id} a={a} />
      ))}
      {view && <Lightbox items={view.items} start={view.index} onClose={() => setView(null)} />}
    </div>
  )
}

// --- embeds

const media = (m?: EmbedMedia) => pic(m?.proxy_url) ?? pic(m?.url)
const hex = (color?: number) => (color == null ? undefined : `#${color.toString(16).padStart(6, '0')}`)
// Sites Discord plays in place; anything else opens in a new tab.
const PLAYABLE = /^https:\/\/(www\.)?(youtube(-nocookie)?\.com\/embed\/|player\.vimeo\.com\/|player\.twitch\.tv\/|clips\.twitch\.tv\/embed|open\.spotify\.com\/embed|w\.soundcloud\.com\/player)/i
const FILE_VIDEO = /\.(mp4|webm|mov|m4v)(\?|#|$)/i

// Inline fields share a row, three at most (two beside a thumbnail); others take the row.
function fieldColumns(fields: NonNullable<Embed['fields']>, thumb: boolean): string[] {
  const max = thumb ? 2 : 3
  const rows: number[][] = []
  fields.forEach((f, i) => {
    const row = rows.at(-1)
    if (f.inline && row && fields[row[0]!]!.inline && row.length < max) row.push(i)
    else rows.push([i])
  })
  const out: string[] = []
  for (const row of rows) {
    const span = 12 / row.length
    row.forEach((i, k) => (out[i] = fields[i]!.inline ? `${1 + k * span} / ${1 + (k + 1) * span}` : '1 / 13'))
  }
  return out
}

function EmbedVideo({ e, onOpen }: { e: Embed; onOpen: () => void }) {
  const [playing, setPlaying] = useState(false)
  const src = media(e.video)!
  const raw = web(e.video?.url) ?? src
  const poster = media(e.thumbnail)
  const w = e.video?.width ?? e.thumbnail?.width
  const h = e.video?.height ?? e.thumbnail?.height
  const style: CSSProperties = { aspectRatio: w && h ? `${w} / ${h}` : '16 / 9' }
  // The app loads no outside pages: players open in the browser instead.
  const iframe = PLAYABLE.test(raw) && !native
  if (playing)
    return (
      <div className="embed-video playing" style={style}>
        {iframe ? (
          <iframe src={`${raw}${raw.includes('?') ? '&' : '?'}autoplay=1&auto_play=1`} title={e.title ?? 'Video'} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
        ) : (
          <video src={src} controls autoPlay playsInline />
        )}
      </div>
    )
  const page = web(e.url) ?? raw
  return (
    <div className="embed-video" style={style}>
      {poster ? <img src={poster} alt="" loading="lazy" onClick={onOpen} /> : <span className="embed-video-blank" />}
      <div className="embed-video-actions">
        {iframe || FILE_VIDEO.test(src) || !poster ? (
          <button onClick={() => setPlaying(true)} aria-label="Play" title="Play">
            <Icon name="play" size={20} />
          </button>
        ) : null}
        <a href={page} target="_blank" rel="noreferrer noopener" aria-label="Open in browser" title="Open in browser">
          <Icon name="external" size={18} />
        </a>
      </div>
    </div>
  )
}

type Group = { embed: Embed; images: EmbedMedia[] }

// A thumbnail's box within 80×80, known before it loads.
function fit80(m?: EmbedMedia) {
  if (!m?.width || !m.height) return {}
  const scale = Math.min(1, 80 / m.width, 80 / m.height)
  return { width: Math.round(m.width * scale), height: Math.round(m.height * scale) }
}

// Embeds sharing a URL that only add an image are one embed with an image grid, as on Discord.
function group(embeds: Embed[]): Group[] {
  const out: Group[] = []
  for (const e of embeds) {
    const last = out.at(-1)
    if (last && e.url && last.embed.url === e.url && e.image && !e.title && !e.description && !e.fields?.length) last.images.push(e.image)
    else out.push({ embed: e, images: e.image ? [e.image] : [] })
  }
  return out
}

function EmbedCard({ g, ctx, open }: { g: Group; ctx: MarkdownContext; open: (items: Viewable[], index: number) => void }) {
  const e = g.embed
  const video = e.type === 'video' && media(e.video) ? e.video : undefined
  const thumbUrl = media(e.thumbnail)
  // A wide link-preview picture shows large; a small one sits on the right.
  const bigThumb = !video && !g.images.length && thumbUrl && (e.type === 'article' || e.type === 'link') && (e.thumbnail?.width ?? 0) >= 400
  const thumb = !video && !bigThumb ? thumbUrl : undefined
  const images: Viewable[] = (bigThumb ? [e.thumbnail!] : g.images).map((m) => ({ url: media(m)!, name: e.title ?? 'Image', width: m.width, height: m.height })).filter((v) => v.url)
  const cols = e.fields?.length ? fieldColumns(e.fields, Boolean(thumb)) : []
  const title = e.title && (web(e.url) ? <a href={web(e.url)} target="_blank" rel="noreferrer noopener">{e.title}</a> : e.title)
  const author = e.author?.name && (web(e.author.url) ? <a href={web(e.author.url)} target="_blank" rel="noreferrer noopener">{e.author.name}</a> : e.author.name)
  const authorIcon = pic(e.author?.proxy_icon_url) ?? pic(e.author?.icon_url)
  const footerIcon = pic(e.footer?.proxy_icon_url) ?? pic(e.footer?.icon_url)
  const when = e.timestamp ? stamp(e.timestamp) : ''
  return (
    <article className={`embed-card${thumb ? ' has-thumb' : ''}${video ? ' has-video' : ''}`} style={{ '--embed-color': hex(e.color) } as CSSProperties}>
      {e.provider?.name && <div className="embed-provider">{web(e.provider.url) ? <a href={web(e.provider.url)} target="_blank" rel="noreferrer noopener">{e.provider.name}</a> : e.provider.name}</div>}
      {author && (
        <div className="embed-author">
          {authorIcon && <img src={authorIcon} alt="" />}
          <span>{author}</span>
        </div>
      )}
      {title && <div className="embed-heading">{title}</div>}
      {e.description && (
        <div className="embed-description">
          <Markdown text={e.description} ctx={ctx} />
        </div>
      )}
      {e.fields?.length ? (
        <div className="embed-fields">
          {e.fields.map((f, i) => (
            <div key={i} className="embed-field" style={{ gridColumn: cols[i] }}>
              <div className="embed-field-label">{f.name}</div>
              <Markdown text={f.value} ctx={ctx} />
            </div>
          ))}
        </div>
      ) : null}
      {thumb && (
        <button className="embed-thumb" onClick={() => open([{ url: thumb, name: e.title ?? 'Thumbnail', width: e.thumbnail?.width, height: e.thumbnail?.height }], 0)} aria-label="Open thumbnail">
          <img src={thumb} alt="" loading="lazy" {...fit80(e.thumbnail)} />
        </button>
      )}
      {video ? (
        <div className="embed-media">
          <EmbedVideo e={e} onOpen={() => thumbUrl && open([{ url: thumbUrl, name: e.title ?? 'Video' }], 0)} />
        </div>
      ) : images.length ? (
        <div className="embed-media">
          {images.length === 1 ? <MediaCell item={images[0]!} onOpen={() => open(images, 0)} fit={{ maxW: 400, maxH: 300 }} /> : <Mosaic items={images} spoilers={images.map(() => false)} onOpen={(i) => open(images, i)} />}
        </div>
      ) : null}
      {(e.footer?.text || when) && (
        <div className="embed-footer">
          {footerIcon && <img src={footerIcon} alt="" />}
          <span>
            {e.footer?.text}
            {e.footer?.text && when && <span className="embed-dot"> • </span>}
            {when}
          </span>
        </div>
      )}
    </article>
  )
}

// An image or gif link shows bare, without the card; so does a plain video file.
function bare(e: Embed): boolean {
  if (e.type === 'image' || e.type === 'gifv') return Boolean(media(e.thumbnail) ?? media(e.video) ?? media(e.image))
  return e.type === 'video' && !e.title && !e.provider?.name && !e.author?.name && Boolean(media(e.video))
}

/** A message whose text is only the link its bare embed shows, as Discord hides it. */
export function onlyEmbedLink(content: string, embeds: Embed[]) {
  const text = content.trim()
  return Boolean(text) && !/\s/.test(text) && embeds.some((e) => bare(e) && e.url === text)
}

export function Embeds({ embeds, ctx }: { embeds: Embed[]; ctx: MarkdownContext }) {
  const [view, setView] = useState<{ items: Viewable[]; index: number } | null>(null)
  if (!embeds.length) return null
  const open = (items: Viewable[], index: number) => setView({ items, index })
  return (
    <div className="embeds">
      {group(embeds).map((g, i) => {
        const e = g.embed
        if (bare(e)) {
          if (e.type === 'gifv' && media(e.video))
            return (
              <video
                key={i}
                className="gifv"
                src={media(e.video)}
                poster={media(e.thumbnail)}
                autoPlay
                muted
                loop
                playsInline
                style={e.video?.width && e.video.height ? { width: Math.round(e.video.width * Math.min(1, 400 / e.video.width, 300 / e.video.height)), aspectRatio: `${e.video.width} / ${e.video.height}` } : undefined}
              />
            )
          if (e.type === 'video')
            return (
              <div key={i} className="video-attachment">
                <video src={media(e.video)} controls preload="metadata" playsInline />
              </div>
            )
          const m = e.thumbnail ?? e.image!
          const item: Viewable = { url: media(m)!, name: e.url?.split('/').pop()?.split('?')[0] || 'Image', width: m.width, height: m.height }
          return <MediaCell key={i} item={item} onOpen={() => open([item], 0)} fit={{ maxW: 550, maxH: 350 }} />
        }
        return <EmbedCard key={i} g={g} ctx={ctx} open={open} />
      })}
      {view && <Lightbox items={view.items} start={view.index} onClose={() => setView(null)} />}
    </div>
  )
}

// --- forwards, stickers, polls

export function Forwarded({ snapshot, source, onSource, ctx }: { snapshot: Snapshot; source: string | null; onSource?: () => void; ctx: MarkdownContext }) {
  return (
    <div className="forwarded">
      <div className="forwarded-label">
        <Icon name="forward" size={16} />
        Forwarded
      </div>
      <div className="forwarded-body">
        <Markdown text={snapshot.content} ctx={ctx} />
        <Embeds embeds={snapshot.embeds ?? []} ctx={ctx} />
        <Attachments attachments={snapshot.attachments ?? []} flags={snapshot.flags} />
        {snapshot.sticker_items?.length ? <Stickers items={snapshot.sticker_items} /> : null}
        <div className="forwarded-source">
          {source && (onSource ? <button className="link-button" onClick={onSource}>{source}</button> : <span>{source}</span>)}
          {source && <span className="embed-dot"> • </span>}
          <span className="num">{stamp(snapshot.timestamp)}</span>
        </div>
      </div>
    </div>
  )
}

function Sticker({ item }: { item: StickerItem }) {
  const [failed, setFailed] = useState(false)
  // Lottie stickers (format 3) need a player; they show by name, as when an image fails.
  if (failed || item.format_type === 3) return <span className="sticker missing" title={item.name}>{item.name}</span>
  const file = item.format_type === 4 ? 'gif' : 'png'
  return <img className="sticker" src={`https://media.discordapp.net/stickers/${item.id}.${file}?size=320`} alt={item.name} title={item.name} loading="lazy" onError={() => setFailed(true)} />
}

export function Stickers({ items }: { items: StickerItem[] }) {
  return (
    <div className="stickers">
      {items.map((s) => (
        <Sticker key={s.id} item={s} />
      ))}
    </div>
  )
}

function left(expiry: string | null): string {
  if (!expiry) return ''
  const s = Math.round((new Date(expiry).getTime() - Date.now()) / 1000)
  if (s <= 0) return 'Poll closed'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m left`
  if (s < 86_400) return `${Math.round(s / 3600)}h left`
  return `${Math.round(s / 86_400)}d left`
}

export function PollCard({ poll }: { poll: Poll }) {
  const counts = new Map((poll.results?.answer_counts ?? []).map((c) => [c.id, c]))
  const total = [...counts.values()].reduce((sum, c) => sum + c.count, 0)
  const closed = poll.results?.is_finalized || (poll.expiry != null && new Date(poll.expiry).getTime() <= Date.now())
  const top = Math.max(0, ...[...counts.values()].map((c) => c.count))
  return (
    <div className={`poll${closed ? ' closed' : ''}`}>
      <div className="poll-question">{poll.question.text}</div>
      <div className="poll-hint">{closed ? 'Final results' : poll.allow_multiselect ? 'Select one or more answers' : 'Select one answer'}</div>
      <div className="poll-answers">
        {poll.answers.map((a) => {
          const c = counts.get(a.answer_id)
          const pct = total ? Math.round(((c?.count ?? 0) / total) * 100) : 0
          return (
            <div key={a.answer_id} className={`poll-answer${c?.me_voted ? ' mine' : ''}${closed && top > 0 && c?.count === top ? ' winner' : ''}`} style={{ '--pct': `${pct}%` } as CSSProperties}>
              <span className="poll-fill" />
              {a.poll_media.emoji?.name && !a.poll_media.emoji.id && <span className="poll-emoji">{a.poll_media.emoji.name}</span>}
              <span className="poll-text">{a.poll_media.text}</span>
              {c?.me_voted && <Icon name="check" size={18} className="poll-mine" />}
              <span className="poll-count num">
                {c?.count ?? 0} {c?.count === 1 ? 'vote' : 'votes'} <b>{pct}%</b>
              </span>
            </div>
          )
        })}
      </div>
      <div className="poll-foot num">
        {total} {total === 1 ? 'vote' : 'votes'}
        {!closed && poll.expiry && <span className="embed-dot"> • </span>}
        {closed ? <span className="embed-dot"> • Poll closed</span> : left(poll.expiry)}
      </div>
    </div>
  )
}
