// Workspace panel, phase 1: everything a thread has made
// and everything it is waiting on, derived from messages the hub already has. Board on top
// (Now, Waiting on you, Outputs, Linked, Services); an output opens in Look, at full size,
// with its versions and a side-by-side compare. No agent or server change needed.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Attachment, Component, Message } from './api.ts'
import { highlight } from './highlight.tsx'
import { Icon } from './icons.tsx'
import { Markdown, type MarkdownContext } from './markdown.tsx'
import { bytes, Lightbox } from './Media.tsx'
import { snowflakeGt, store, useStore } from './store.ts'
import { plain } from './text.ts'

export type Jump = (channelId: string, messageId: string) => void

type Kind = 'image' | 'video' | 'audio' | 'markdown' | 'table' | 'code' | 'pdf' | 'file'
type Version = { attachment: Attachment; message: Message }
type Output = { key: string; name: string; kind: Kind; versions: Version[] }

const MAX_PAGES = 12
const FOOTER = /^(-#|>) \*?[^\n]*⋅[^\n]*\d+%[^\n]*?\*?(\s*<@!?\d+>)?\s*$/m

function kindOf(a: Attachment): Kind {
  const name = a.filename.toLowerCase()
  const type = a.content_type ?? ''
  if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif)$/.test(name)) return 'image'
  if (type.startsWith('video/') || /\.(mp4|webm|mov)$/.test(name)) return 'video'
  if (type.startsWith('audio/') || /\.(mp3|ogg|wav|m4a|opus)$/.test(name)) return 'audio'
  if (/\.(md|markdown)$/.test(name)) return 'markdown'
  if (/\.(csv|tsv)$/.test(name)) return 'table'
  if (/\.pdf$/.test(name)) return 'pdf'
  if (/\.(txt|log|json|ya?ml|toml|ts|tsx|js|py|sh|sql|html|css|diff|patch|rs|go)$/.test(name)) return 'code'
  return 'file'
}

// hero.png, hero-2.png, hero (1).png and hero-v3.png are versions of one output.
const stem = (name: string) =>
  name
    .toLowerCase()
    .replace(/^spoiler_/, '')
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/(?:[-_ ](?:v?\d{1,3}|copy|final|new)|\s\(\d+\))+$/, '')

function hasOpen(components: Component[] | undefined): boolean {
  return (components ?? []).some((c) => ((c.type === 2 && c['style'] !== 5) || (c.type >= 3 && c.type <= 8 && c.type !== 4) ? !c['disabled'] : hasOpen(c['components'])))
}

const time = (id: string) => Number((BigInt(id) >> 22n) + 1420070400000n)
function ago(id: string) {
  const m = Math.round((Date.now() - time(id)) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m`
  if (m < 1440) return `${Math.round(m / 60)}h`
  return new Date(time(id)).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

// First real paragraph of a message, for the Now line.
function gist(m: Message) {
  const line = m.content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('-#') && !l.startsWith('┣') && !l.startsWith('```') && !/^<\/?callout/.test(l))
  return line?.replace(/^#+\s*/, '').replace(/^⬥\s*/, '') ?? ''
}

export function useOutputs(channelId: string) {
  const entry = useStore((d) => d.messages[channelId])
  // Load history in the background so outputs from earlier in the thread count too.
  const [pages, setPages] = useState(0)
  useEffect(() => {
    if (!entry || entry.loading || !entry.hasMore || pages >= MAX_PAGES) return
    const id = window.setTimeout(() => {
      setPages((n) => n + 1)
      void store.loadMessages(channelId, { older: true }).catch(() => {})
    }, 120)
    return () => window.clearTimeout(id)
  }, [channelId, entry, pages])
  const list = useMemo(() => entry?.list ?? [], [entry])
  const outputs = useMemo(() => {
    const groups = new Map<string, Output>()
    for (const message of list) {
      for (const attachment of message.attachments) {
        if (attachment.waveform || attachment.missing || !attachment.url) continue
        const kind = kindOf(attachment)
        const key = `${kind}:${stem(attachment.filename)}`
        const group = groups.get(key) ?? { key, name: attachment.filename.replace(/^SPOILER_/, ''), kind, versions: [] }
        group.versions.push({ attachment, message })
        group.name = attachment.filename.replace(/^SPOILER_/, '')
        groups.set(key, group)
      }
    }
    return [...groups.values()].sort((a, b) => (snowflakeGt(a.versions.at(-1)!.message.id, b.versions.at(-1)!.message.id) ? -1 : 1))
  }, [list])
  return { list, outputs, loading: Boolean(entry?.hasMore && pages < MAX_PAGES) }
}

export function WorkspacePanel({ channelId, ctx, onClose, onJump, onOpen, onServices }: { channelId: string; ctx: MarkdownContext; onClose: () => void; onJump: Jump; onOpen: (id: string) => void; onServices: () => void }) {
  const state = useStore((d) => d.state)
  const links = useStore((d) => d.linked[channelId])
  const services = useStore((d) => d.services)
  const sessions = useStore((d) => d.sessions)
  const { list, outputs, loading } = useOutputs(channelId)
  const [look, setLook] = useState<{ key: string; v: number } | null>(null)
  useEffect(() => {
    void store.loadLinks(channelId).catch(() => {})
  }, [channelId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.sheet-layer, .overlay, .lightbox')) return
      if (look) setLook(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [look, onClose])

  const me = state?.me.id
  const waiting = list.filter((m) => m.author.bot && (hasOpen(m.components) || (me && m.content.includes(`<@${me}>`) && !FOOTER.test(m.content)))).reverse()
  const pinned = [...list].reverse().find((m) => m.pinned && m.author.bot)
  const latest = [...list].reverse().find((m) => m.author.bot && gist(m))
  const session = sessions[channelId]
  const threadServices = (services ?? []).filter((s) => s.threads.includes(channelId))
  const open = look ? outputs.find((o) => o.key === look.key) : null
  const thread = state?.threads.find((t) => t.id === channelId) ?? state?.channels.find((c) => c.id === channelId)

  if (open) return <Look output={open} v={look!.v} ctx={ctx} onV={(v) => setLook({ key: open.key, v })} onBack={() => setLook(null)} onClose={onClose} onJump={(m) => onJump(channelId, m.id)} />

  const images = outputs.filter((o) => o.kind === 'image')
  const docs = outputs.filter((o) => o.kind !== 'image')
  return (
    <aside className="side-panel workspace" role="complementary" aria-label="Workspace">
      <header className="panel-head">
        <button className="icon-button panel-back" onClick={onClose} aria-label="Close panel">
          <Icon name="back" size={22} />
        </button>
        <Icon name="sidebar" size={20} className="panel-icon" />
        <div className="panel-title">Workspace</div>
        <button className="icon-button panel-close" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="panel-body ws-body">
        <Section title="Now">
          <div className="ws-now">
            {session && <i className={`st ${session.state}`} />}
            <div className="ws-now-text">
              {pinned ? (
                <button className="ws-link" onClick={() => onJump(channelId, pinned.id)}>
                  <span className="ws-now-line">{plain(gist(pinned))}</span>
                  <span className="ws-meta">Pinned · {ago(pinned.id)}</span>
                </button>
              ) : latest ? (
                <button className="ws-link" onClick={() => onJump(channelId, latest.id)}>
                  <span className="ws-now-line">{plain(gist(latest))}</span>
                  <span className="ws-meta">
                    {latest.author.global_name ?? latest.author.username} · {ago(latest.id)}
                  </span>
                </button>
              ) : (
                <span className="ws-meta">{thread ? plain(thread.name ?? '') : ''}</span>
              )}
            </div>
          </div>
        </Section>
        {waiting.length > 0 && (
          <Section title="Waiting on you" count={waiting.length}>
            {waiting.slice(0, 6).map((m) => (
              <button key={m.id} className="ws-row ws-waiting" onClick={() => onJump(channelId, m.id)}>
                <span className="ws-row-text">{plain(gist(m)) || 'A choice to make'}</span>
                <span className="ws-meta num">{ago(m.id)}</span>
              </button>
            ))}
          </Section>
        )}
        {(outputs.length > 0 || loading) && (
          <Section title="Outputs" count={outputs.length}>
            {images.length > 0 && (
              <div className="ws-shots">
                {images.slice(0, 9).map((o) => {
                  const last = o.versions.at(-1)!
                  return (
                    <button key={o.key} className="ws-shot" onClick={() => setLook({ key: o.key, v: o.versions.length - 1 })} title={o.name}>
                      <img src={last.attachment.proxy_url ?? last.attachment.url} alt={o.name} loading="lazy" />
                      {o.versions.length > 1 && <span className="ws-badge num">{o.versions.length}</span>}
                    </button>
                  )
                })}
              </div>
            )}
            {docs.slice(0, 12).map((o) => {
              const last = o.versions.at(-1)!
              return (
                <button key={o.key} className="ws-row" onClick={() => setLook({ key: o.key, v: o.versions.length - 1 })}>
                  <Icon name="file" size={18} />
                  <span className="ws-row-text">{o.name}</span>
                  {o.versions.length > 1 && <span className="ws-versions num">v{o.versions.length}</span>}
                  <span className="ws-meta num">{ago(last.message.id)}</span>
                </button>
              )
            })}
            {loading && <div className="ws-meta ws-pad">Reading older messages…</div>}
          </Section>
        )}
        {links && links.length > 0 && (
          <Section title="Linked" count={links.length}>
            {links.slice(0, 6).map((link) => {
              const t = state?.threads.find((x) => x.id === link.id)
              const s = sessions[link.id]
              return (
                <button key={link.id} className="ws-row" onClick={() => onOpen(link.id)}>
                  <i className={`st ${s?.state ?? 'idle'}`} />
                  <span className="ws-row-text">{t ? plain(t.name ?? '') : 'A thread not on this hub'}</span>
                  <span className="ws-meta">{s?.machine ?? ''}</span>
                </button>
              )
            })}
          </Section>
        )}
        {threadServices.length > 0 && (
          <Section title="Services" count={threadServices.length}>
            {threadServices.slice(0, 5).map((s) => (
              <button key={s.unit} className="ws-row" onClick={onServices}>
                <i className={`st ${s.status === 'running' ? 'ok' : s.status === 'failed' || s.status === 'restarting' ? 'failed' : 'idle'}`} />
                <span className="ws-row-text mono">{s.unit.replace(/\.(service|timer)$/, '')}</span>
                <span className="ws-meta">{s.status}</span>
              </button>
            ))}
          </Section>
        )}
        {!loading && outputs.length === 0 && waiting.length === 0 && !links?.length && !threadServices.length && <div className="ws-meta ws-pad">Nothing made here yet.</div>}
      </div>
    </aside>
  )
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="ws-section">
      <h3 className="ws-label">
        {title}
        {count ? <span className="num">{count}</span> : null}
      </h3>
      {children}
    </section>
  )
}

function useText(url: string | null) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    setText(null)
    if (!url) return
    let live = true
    void fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((t) => live && setText(t.length > 400_000 ? `${t.slice(0, 400_000)}\n…` : t))
      .catch(() => live && setText(''))
    return () => {
      live = false
    }
  }, [url])
  return text
}

function parseCsv(text: string, sep: string) {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === sep) row.push(cell), (cell = '')
    else if (c === '\n') row.push(cell), rows.push(row), (row = []), (cell = '')
    else if (c !== '\r') cell += c
  }
  if (cell || row.length) row.push(cell), rows.push(row)
  return rows.slice(0, 501)
}

function Table({ text, sep }: { text: string; sep: string }) {
  const rows = parseCsv(text, sep)
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null)
  const [head, ...body] = rows
  const numeric = (head ?? []).map((_, j) => body.every((r) => !r[j] || !Number.isNaN(Number(r[j]!.replace(/[,%$£]/g, '')))))
  const sorted = sort ? [...body].sort((a, b) => {
    const x = a[sort.col] ?? ''
    const y = b[sort.col] ?? ''
    return (numeric[sort.col] ? Number(x.replace(/[,%$£]/g, '')) - Number(y.replace(/[,%$£]/g, '')) : x.localeCompare(y)) * sort.dir
  }) : body
  return (
    <div className="ws-table-wrap">
      <table className="ws-table">
        <thead>
          <tr>
            {(head ?? []).map((h, j) => (
              <th key={j} className={numeric[j] ? 'n' : undefined}>
                <button onClick={() => setSort(sort?.col === j ? { col: j, dir: sort.dir === 1 ? -1 : 1 } : { col: j, dir: 1 })}>
                  {h}
                  {sort?.col === j ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={numeric[j] ? 'n num' : undefined}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Look({ output, v, ctx, onV, onBack, onClose, onJump }: { output: Output; v: number; ctx: MarkdownContext; onV: (v: number) => void; onBack: () => void; onClose: () => void; onJump: (m: Message) => void }) {
  const version = output.versions[Math.min(v, output.versions.length - 1)]!
  const { attachment, message } = version
  const url = attachment.url
  const [compare, setCompare] = useState(false)
  const [source, setSource] = useState(false)
  const [viewer, setViewer] = useState<number | null>(null)
  const textKinds: Kind[] = ['markdown', 'table', 'code']
  const text = useText(textKinds.includes(output.kind) ? url : null)
  const ext = attachment.filename.split('.').pop()?.toLowerCase() ?? ''
  const prev = v > 0 ? output.versions[v - 1]! : null
  const n = output.versions.length
  return (
    <aside className={`side-panel workspace look look-${output.kind}`} role="complementary" aria-label={output.name}>
      <header className="panel-head">
        <button className="icon-button look-back" onClick={onBack} aria-label="Back to workspace" title="Back">
          <Icon name="back" size={22} />
        </button>
        <div className="panel-title look-title">
          <span className="look-name">{output.name}</span>
          <span className="ws-meta num">
            {bytes(attachment.size)} · {ago(message.id)}
          </span>
        </div>
        {n > 1 && (
          <span className="look-versions" role="group" aria-label="Versions">
            <button className="icon-button" disabled={v === 0} onClick={() => onV(v - 1)} aria-label="Older version" title="Older version">
              <Icon name="chevron" size={16} className="flip" />
            </button>
            <span className="num">
              v{v + 1}/{n}
            </span>
            <button className="icon-button" disabled={v === n - 1} onClick={() => onV(v + 1)} aria-label="Newer version" title="Newer version">
              <Icon name="chevron" size={16} />
            </button>
          </span>
        )}
        {output.kind === 'image' && prev && (
          <button className="icon-button" aria-pressed={compare} onClick={() => setCompare(!compare)} aria-label="Compare with the previous version" title="Compare with the previous version">
            <Icon name="sidebar" size={20} />
          </button>
        )}
        {output.kind === 'markdown' && (
          <button className="icon-button" aria-pressed={source} onClick={() => setSource(!source)} aria-label="Show the markdown source" title="Show the markdown source">
            <Icon name="file" size={20} />
          </button>
        )}
        <button className="icon-button" onClick={() => onJump(message)} aria-label="Show in the thread" title="Show in the thread">
          <Icon name="chat" size={20} />
        </button>
        <a className="icon-button" href={url} download={attachment.filename} aria-label="Download" title="Download">
          <Icon name="download" size={20} />
        </a>
        <button className="icon-button panel-close" onClick={onClose} aria-label="Close">
          <Icon name="close" size={18} />
        </button>
      </header>
      <div className="look-body">
        {output.kind === 'image' &&
          (compare && prev ? (
            <div className="look-compare">
              {[prev, version].map((x, i) => (
                <figure key={x.attachment.id}>
                  <img src={x.attachment.url} alt="" onClick={() => setViewer(v - 1 + i)} />
                  <figcaption className="num">v{v + i}</figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <img className="look-image" src={url} alt={output.name} onClick={() => setViewer(v)} />
          ))}
        {output.kind === 'video' && <video className="look-media" src={url} controls preload="metadata" />}
        {output.kind === 'audio' && <audio className="look-audio" src={url} controls preload="metadata" />}
        {output.kind === 'pdf' && <object className="look-pdf" data={url} type="application/pdf" aria-label={output.name} />}
        {output.kind === 'file' && (
          <a className="look-file" href={url} download={attachment.filename}>
            <Icon name="file" size={28} />
            <span>{output.name}</span>
          </a>
        )}
        {text === null && textKinds.includes(output.kind) && <div className="ws-meta ws-pad">…</div>}
        {text !== null && output.kind === 'markdown' && source && (
          <pre className="look-code">
            <code>{highlight('md', text)}</code>
          </pre>
        )}
        {text !== null && output.kind === 'markdown' && !source && (
          <div className="look-doc">
            <Markdown text={text} ctx={ctx} />
          </div>
        )}
        {text !== null && output.kind === 'table' && <Table text={text} sep={ext === 'tsv' ? '\t' : ','} />}
        {text !== null && output.kind === 'code' && (
          <pre className="look-code">
            <code>{highlight(ext === 'log' || ext === 'txt' ? '' : ext, text)}</code>
          </pre>
        )}
      </div>
      {viewer !== null && <Lightbox items={output.versions.map((x) => ({ url: x.attachment.url, name: x.attachment.filename, size: x.attachment.size, width: x.attachment.width, height: x.attachment.height }))} start={viewer} onClose={() => setViewer(null)} />}
    </aside>
  )
}

export function workspaceWaiting(list: Message[] | undefined, me: string | undefined) {
  return (list ?? []).some((m) => m.author.bot && (hasOpen(m.components) || (me && m.content.includes(`<@${me}>`) && !FOOTER.test(m.content))))
}
