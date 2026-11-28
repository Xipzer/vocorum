// "Share to…": what another app shared through the share sheet. The service worker keeps
// the shared text and files on this device (Cache Storage) until Send uploads them to the
// picked channel, thread or DM; Cancel deletes them. Rows match the quick switcher's.

import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Channel } from './api.ts'
import { Icon } from './icons.tsx'
import { can, P } from './perms.ts'
import { dmName, isDm, snowflakeGt, store, THREAD_TYPES, useStore } from './store.ts'
import { recentVisits, score } from './Switcher.tsx'
import { leave, plain } from './text.ts'

export const SHARE_CACHE = 'vocorum-share'
const LIMIT = 2000

export type Shared = { text: string; files: File[] }

// A page shared from a browser is a title and a URL; a note is text that may hold the URL.
export function sharedText(meta: { title?: string; text?: string; url?: string }) {
  const text = meta.text?.trim() ?? ''
  const url = meta.url?.trim() ?? ''
  const lines = [text ? '' : (meta.title?.trim() ?? ''), text, url && !text.includes(url) ? url : '']
  return lines.filter(Boolean).join('\n')
}

export async function readShare(): Promise<Shared | null> {
  if (!('caches' in window)) return null
  const cache = await caches.open(SHARE_CACHE)
  const meta = await cache.match('/share/meta')
  if (!meta) return null
  const info = (await meta.json()) as { title?: string; text?: string; url?: string; files?: number }
  const files: File[] = []
  for (let i = 0; i < (info.files ?? 0); i++) {
    const hit = await cache.match(`/share/file/${i}`)
    if (hit) files.push(new File([await hit.blob()], decodeURIComponent(hit.headers.get('x-name') ?? `file-${i + 1}`), { type: hit.headers.get('content-type') ?? '' }))
  }
  return { text: sharedText(info), files }
}

export const discardShare = () => ('caches' in window ? caches.delete(SHARE_CACHE).then(() => undefined) : Promise.resolve())

const writable = (c: Channel) => {
  if (THREAD_TYPES.has(c.type)) return !c.thread_metadata?.archived && !c.thread_metadata?.locked && can(P.SEND_MESSAGES_IN_THREADS, c)
  return (c.type === 0 || c.type === 5 || isDm(c)) && can(P.SEND_MESSAGES, c)
}

export function ShareDialog({ shared, onSent, onClose }: { shared: Shared; onSent: (channelId: string) => void; onClose: () => void }) {
  const state = useStore((d) => d.state)
  const seen = useStore((d) => d.seen)
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState<string | null>(null)
  const [text, setText] = useState(shared.text)
  const [files, setFiles] = useState(shared.files)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const close = () => leave(overlay.current, onClose)

  const rows = useMemo(() => {
    if (!state) return []
    const guilds = store.guilds()
    const q = query.trim().toLowerCase()
    const recent = recentVisits()
    const out = []
    for (const c of [...state.channels, ...state.threads]) {
      if (!writable(c)) continue
      const dm = isDm(c)
      const thread = THREAD_TYPES.has(c.type)
      const label = dm ? dmName(c, state.me.id) : plain(c.name ?? '', () => null, () => null) || 'untitled'
      const s = score(label, q)
      if (!s) continue
      const parent = thread ? state.channels.find((p) => p.id === c.parent_id) : state.channels.find((p) => p.id === c.parent_id && p.type === 4)
      const side = dm ? 'Direct message' : guilds.length > 1 ? (guilds.find((g) => g.id === c.guild_id)?.name ?? '') : ''
      const at = recent.indexOf(c.id)
      out.push({ c, label, sub: dm ? '' : (parent?.name ?? ''), side, icon: dm ? ('at' as const) : thread ? ('thread' as const) : ('hash' as const), unread: snowflakeGt(c.last_message_id, seen[c.id]), rank: s * 100 + (at >= 0 ? 60 - at : 0), last: c.last_message_id ?? '0' })
    }
    return out.sort((a, b) => b.rank - a.rank || (snowflakeGt(a.last, b.last) ? -1 : snowflakeGt(b.last, a.last) ? 1 : 0)).slice(0, 50)
  }, [state, seen, query])

  const previews = useMemo(() => files.map((f) => (/^image\//.test(f.type) ? URL.createObjectURL(f) : null)), [files])
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews])

  const long = text.length > LIMIT
  const send = async () => {
    if (!target || busy || long || (!text.trim() && !files.length)) return
    setBusy(true)
    setError(null)
    try {
      const ids = []
      for (const file of files) ids.push((await api.upload(file, file.name)).id)
      await api.send(target, { content: text.trim(), attachmentIds: ids })
      onSent(target)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div ref={overlay} className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), close())}>
      <div className="modal share" role="dialog" aria-label="Share to">
        <div className="grab" />
        <div className="modal-header">
          <h2>Share to…</h2>
          <button type="button" className="icon-button" onClick={close} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="share-search">
          <Icon name="search" size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search channels and DMs" spellCheck={false} />
        </div>
        <div className="switcher-list share-list" role="listbox" aria-label="Destinations">
          {rows.map((r) => (
            <button key={r.c.id} role="option" aria-selected={target === r.c.id} className={`switcher-item${target === r.c.id ? ' picked' : ''}${r.unread ? ' unread' : ''}`} onClick={() => setTarget(r.c.id)} onDoubleClick={() => void send()}>
              <Icon name={r.icon} size={16} />
              <span className="switcher-label">{r.label}</span>
              {r.sub && <span className="switcher-sub">{r.sub}</span>}
              <span className="switcher-gap" />
              {r.side && <span className="switcher-side">{r.side}</span>}
              {target === r.c.id && <Icon name="check" size={16} />}
            </button>
          ))}
          {rows.length === 0 && <div className="switcher-empty">Nothing matches.</div>}
        </div>
        <div className="share-message">
          {files.length > 0 && (
            <ul className="share-files" aria-label="Attachments">
              {files.map((f, i) => (
                <li key={`${i}${f.name}`} className="share-file" aria-label={f.name}>
                  {previews[i] ? <img src={previews[i]!} alt="" /> : <Icon name="file" size={16} />}
                  <span title={f.name}>{f.name}</span>
                  <button type="button" className="icon-button" aria-label={`Remove ${f.name}`} title="Remove attachment" onClick={() => setFiles(files.filter((_, n) => n !== i))}>
                    <Icon name="close" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea value={text} rows={3} placeholder="Add a message (optional)" aria-label="Message" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }} />
          {long && <span className="share-count num">{LIMIT - text.length}</span>}
        </div>
        {error && <div className="error share-error">{error}</div>}
        <div className="modal-footer">
          <button type="button" className="button medium" onClick={close}>
            Cancel
          </button>
          <button type="button" className="button medium primary" disabled={!target || busy || long || (!text.trim() && !files.length)} onClick={() => void send()}>
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
