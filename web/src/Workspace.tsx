// The agent-maintained thread brief, decisions, outputs and links. A hub with no
// published board still shows Now from its pinned or latest bot message.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AgentBoard } from './AgentBoard.tsx'
import { can, P } from './perms.ts'
import type { Attachment, Component, Message } from './api.ts'
import { highlight } from './highlight.tsx'
import { Icon } from './icons.tsx'
import { Markdown, type MarkdownContext } from './markdown.tsx'
import { bytes, Lightbox } from './Media.tsx'
import { machineName, snowflakeGt, store, useStore } from './store.ts'
import { plain } from './text.ts'
import { reasoningShown, showReasoning, useThoughts } from './reasoning.ts'
import { Switch } from './SettingsKit.tsx'

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

export function useOutputs(channelId: string, boardMessage: string | null = null) {
  const entry = useStore((d) => d.messages[channelId])
  // Scan older outputs in bounded batches on request. Opening the Board
  // should not page hundreds of unrelated messages into the active chat.
  const [pages, setPages] = useState(0)
  useEffect(() => {
    if (!entry || entry.loading || !entry.hasMore || pages <= 0) return
    const id = window.setTimeout(() => {
      setPages((n) => n - 1)
      void store.loadMessages(channelId, { older: true }).catch(() => {})
    }, 120)
    return () => window.clearTimeout(id)
  }, [channelId, entry, pages])
  const list = useMemo(() => entry?.list ?? [], [entry])
  const outputs = useMemo(() => {
    const groups = new Map<string, Output>()
    for (const message of list) {
      for (const attachment of message.attachments) {
        if (message.id === boardMessage && attachment.filename === 'board.panel.md') continue
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
  }, [list, boardMessage])
  return { list, outputs, loading: Boolean(entry?.hasMore && pages > 0), more: Boolean(entry?.hasMore), loadEarlier: () => setPages(MAX_PAGES) }
}

export function WorkspacePanel({ channelId, ctx, onClose, onJump, onOpen, onServices }: { channelId: string; ctx: MarkdownContext; onClose: () => void; onJump: Jump; onOpen: (id: string) => void; onServices: () => void }) {
  const state = useStore((d) => d.state)
  const links = useStore((d) => d.linked[channelId])
  const services = useStore((d) => d.services)
  const sessions = useStore((d) => d.sessions)
  const [boardMessage, setBoardMessage] = useState<string | null>(null)
  const { list, outputs, loading, more, loadEarlier } = useOutputs(channelId, boardMessage)
  const outputOnly = useStore(d => d.output[channelId])
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
  const derivedNow = <Section title="Now">
    <div className="ws-now">{session && <i className={`st ${session.state}`} />}<div className="ws-now-text">
      {pinned || latest ? <button className="ws-link" onClick={() => onJump(channelId, (pinned ?? latest)!.id)}>
        <span className="ws-now-line">{plain(gist((pinned ?? latest)!))}</span>
        <span className="ws-meta">{pinned ? 'Pinned' : latest!.author.global_name ?? latest!.author.username} · {ago((pinned ?? latest)!.id)}</span>
      </button> : <span className="ws-meta">{thread ? plain(thread.name ?? '') : ''}</span>}
    </div></div>
  </Section>
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
        {thread && [10, 11, 12].includes(thread.type) && can(P.READ_MESSAGE_HISTORY, thread) ? <AgentBoard key={channelId} thread={channelId} ctx={{ ...ctx, openMessage: onJump }} writable={!outputOnly && !thread.thread_metadata?.archived && !thread.thread_metadata?.locked && can(P.SEND_MESSAGES_IN_THREADS, thread)} onCarrier={setBoardMessage} onCorrect={() => { if (window.matchMedia('(max-width: 767px)').matches) onClose() }}>{derivedNow}</AgentBoard> : derivedNow}
        {thread && [10, 11, 12].includes(thread.type) && <Reasoning channelId={channelId} />}
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
        {(outputs.length > 0 || more) && (
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
            {loading ? <div className="ws-meta ws-pad">Reading older messages…</div> : more && <button className="ws-row" onClick={loadEarlier}>Find earlier outputs</button>}
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
                  <span className="ws-meta">{s?.machine ? machineName(s.machine) : ''}</span>
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
      </div>
    </aside>
  )
}

// Opt-in: the agent's thinking headlines as Kimaki streams them. Off by default,
// because it is a running commentary, not a result.
function Reasoning({ channelId }: { channelId: string }) {
  const thoughts = useThoughts(channelId)
  const on = reasoningShown()
  const live = thoughts.findLast((t) => t.live)
  return (
    <section className={`ws-section ws-reasoning${on ? ' on' : ''}`}>
      <div className="ws-reasoning-head">
        <h3 className="ws-label">Reasoning</h3>
        <Switch label="Show reasoning" checked={on} onChange={showReasoning} />
      </div>
      {!on ? (
        <div className="ws-meta ws-pad">{live ? `Thinking for ${live.seconds}s. ` : ''}Turn on to follow the agent's thinking headlines.</div>
      ) : thoughts.length === 0 ? (
        <div className="ws-meta ws-pad">Nothing yet. Kimaki shares a headline while the model thinks and removes it when the thought ends, so only what arrives while this page is open appears here.</div>
      ) : (
        <ol className="ws-thoughts">
          {[...thoughts].reverse().map((t) => (
            <li key={t.id} className={`ws-thought${t.live ? ' live' : ''}`}>
              <span className="ws-meta">{t.live ? `Thinking · ${t.seconds}s` : `Thought for ${t.seconds}s`} · {ago(t.id)}</span>
              {t.headlines.length ? (
                <ul>{t.headlines.map((h, i) => <li key={i} className={i === t.headlines.length - 1 ? 'latest' : undefined}>{h}</li>)}</ul>
              ) : <span className="ws-meta">No headline shared</span>}
            </li>
          ))}
        </ol>
      )}
    </section>
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
  return rows
}

function jsonRows(text: string): string[][] | null {
  const value = (() => { try { return JSON.parse(text) as unknown } catch { return null } })()
  if (!Array.isArray(value) || !value.length || value.length > 20_000 || !value.every(row => row && typeof row === 'object' && !Array.isArray(row))) return null
  const keys = new Set<string>()
  for (const row of value) for (const key of Object.keys(row)) { keys.add(key); if (keys.size > 64) return null }
  if (!keys.size || keys.size * value.length > 200_000) return null
  const head = [...keys]
  return [head, ...value.map(row => head.map(key => { const v = Object.hasOwn(row, key) ? row[key] : null; return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v) }))]
}

function Table({ rows }: { rows: string[][] }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null)
  const [query, setQuery] = useState('')
  const head = rows[0] ?? [], body = useMemo(() => rows.slice(1), [rows])
  const numeric = useMemo(() => head.map((_, j) => body.every(r => !r[j] || Number.isFinite(Number(r[j]!.replace(/[,%$£]/g, ''))))), [head, body])
  const visible = useMemo(() => { const q = query.trim().toLocaleLowerCase(); return q ? body.filter(row => row.some(cell => cell.toLocaleLowerCase().includes(q))) : body }, [body, query])
  const sorted = useMemo(() => sort ? [...visible].sort((a, b) => {
    const x = a[sort.col] ?? ''
    const y = b[sort.col] ?? ''
    if (!x || !y) return Number(!x) - Number(!y)
    return (numeric[sort.col] ? Number(x.replace(/[,%$£]/g, '')) - Number(y.replace(/[,%$£]/g, '')) : x.localeCompare(y)) * sort.dir
  }) : visible, [visible, sort, numeric])
  return (
    <>
    <div className="look-filter"><label><Icon name="search" size={16}/><input type="search" aria-label="Filter table rows" placeholder="Filter rows" value={query} onChange={e => setQuery(e.target.value)}/></label><span className="ws-meta num" role="status">{sorted.length > 500 ? `First 500 of ${sorted.length} rows` : `${sorted.length} of ${body.length} rows`}</span></div>
    <div className="ws-table-wrap">
      <table className="ws-table">
        <thead>
          <tr>
            {(head ?? []).map((h, j) => (
               <th key={j} className={numeric[j] ? 'n' : undefined} aria-sort={sort?.col === j ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                <button onClick={() => setSort(sort?.col === j ? { col: j, dir: sort.dir === 1 ? -1 : 1 } : { col: j, dir: 1 })}>
                  {h}
                  {sort?.col === j ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {!sorted.length && <tr><td colSpan={head.length || 1}>No matching rows.</td></tr>}
          {sorted.slice(0, 500).map((r, i) => (
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
    </>
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
  const rows = useMemo(() => text == null ? null : output.kind === 'table' ? parseCsv(text, ext === 'tsv' ? '\t' : ',') : ext === 'json' ? jsonRows(text) : null, [text, ext, output.kind])
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
        {(output.kind === 'markdown' || (ext === 'json' && rows)) && (
          <button className="icon-button" aria-pressed={source} onClick={() => setSource(!source)} aria-label={output.kind === 'markdown' ? 'Show the markdown source' : 'Show the JSON source'} title="Show source">
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
        {rows && (output.kind === 'table' || !source) && <Table key={attachment.id} rows={rows}/>}
        {text !== null && output.kind === 'code' && (!rows || source) && (
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
