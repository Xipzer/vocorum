import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, call } from './api.ts'
import { BOARD_CORRECT, BOARD_UPDATED, boardChanges, boardSections, boardTask, type BoardCorrection, type BoardPage } from './board-document.ts'
import { Icon } from './icons.tsx'
import { Markdown, type MarkdownContext } from './markdown.tsx'
import { useStore } from './store.ts'
import './agent-board.css'

type Board = NonNullable<BoardPage['board']>

export function AgentBoard({ thread, ctx, writable, onCorrect, onCarrier, children }: { thread: string; ctx: MarkdownContext; writable: boolean; onCorrect: () => void; onCarrier: (id: string | null) => void; children: ReactNode }) {
  const [page, setPage] = useState<BoardPage | null>(null), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const online = useStore(d => d.online)
  const carrier = page?.board?.message_id ?? null
  useEffect(() => { onCarrier(carrier); return () => onCarrier(null) }, [carrier, onCarrier])
  useEffect(() => {
    const abort = new AbortController()
    let reading = false, dirty = false
    const load = async () => {
      if (reading) { dirty = true; return }
      reading = true
      do {
        dirty = false
        try {
          const p = await call<BoardPage>(`/client/threads/${thread}/panels`, { signal: abort.signal, cache: 'no-store' })
          if (abort.signal.aborted) return
          if (p.board && (p.board.thread_id !== thread || !p.board.versions.length)) throw new Error('Invalid board')
          setPage(p); setError('')
        } catch (e) {
          if (abort.signal.aborted) return
          setPage(null); setError(e instanceof ApiError && (e.status === 404 || e.status === 403) ? '' : 'The board could not be loaded.')
        }
      } while (dirty && !abort.signal.aborted)
      reading = false
    }
    const update = (e: Event) => { if ((e as CustomEvent<string>).detail === thread) void load() }
    window.addEventListener(BOARD_UPDATED, update); void load()
    return () => { abort.abort(); window.removeEventListener(BOARD_UPDATED, update) }
  }, [thread, online, retry])
  if (!page?.board) return <>{error && <div className="board-notice" role="status">{error} <button onClick={() => setRetry(n => n + 1)}>Retry</button></div>}{children}</>
  return <BoardDocument key={page.board.message_id} board={page.board} seen={page.seen_version} ctx={ctx} writable={writable} onCorrect={onCorrect}/>
}

function BoardDocument({ board, seen, ctx, writable, onCorrect }: { board: Board; seen: number | null; ctx: MarkdownContext; writable: boolean; onCorrect: () => void }) {
  const { versions, thread_id: thread } = board, latest = versions[versions.length - 1]!
  const [baseline] = useState(() => seen ?? latest.v)
  const [chosen, pick] = useState<number | null>(null), [notice, setNotice] = useState('')
  const selected = versions.find(v => v.v === chosen) ?? latest, i = versions.indexOf(selected), historical = selected.v !== latest.v
  const sections = useMemo(() => boardSections(selected.markdown), [selected.markdown])
  const prior = versions.find(v => v.v === baseline)
  const change = useMemo(() => !historical && prior && prior.v !== selected.v ? boardChanges(boardSections(prior.markdown), sections) : null, [historical, prior, selected.v, sections])
  const root = useRef<HTMLElement>(null), marked = useRef(seen ?? 0)
  useEffect(() => {
    const el = root.current
    if (!el || historical || marked.current >= selected.v) return
    let active = true, inflight = false, visible = !('IntersectionObserver' in window)
    const mark = () => {
      if (!active || inflight || !visible || document.visibilityState !== 'visible' || marked.current >= selected.v) return
      inflight = true
      void call(`/client/threads/${thread}/panels/board/seen`, { method: 'POST', json: { v: selected.v } }).then(() => { marked.current = Math.max(marked.current, selected.v) }, () => {}).finally(() => { inflight = false })
    }
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => { visible = entries.some(e => e.isIntersecting); mark() })
    observer?.observe(el); document.addEventListener('visibilitychange', mark); mark()
    return () => { active = false; observer?.disconnect(); document.removeEventListener('visibilitychange', mark) }
  }, [thread, selected.v, historical])
  const correct = useCallback((block: string, el: HTMLElement) => {
    const selection = window.getSelection()
    const quote = selection?.rangeCount && el.contains(selection.anchorNode) && el.contains(selection.focusNode) && selection.toString().trim() ? selection.toString() : block
    const accepted = !window.dispatchEvent(new CustomEvent<BoardCorrection>(BOARD_CORRECT, { cancelable: true, detail: { thread, v: selected.v, quote } }))
    setNotice(accepted ? 'Correction added to your draft.' : 'The draft was not changed. Select a shorter quote or finish the current edit.')
    if (accepted) onCorrect()
  }, [thread, selected.v, onCorrect])
  return <section ref={root} className="agent-board" aria-label="Agent board">
    <div className="board-heading"><div><span className="ws-label">Board</span><h2>{selected.title || 'Thread brief'}</h2></div>
      <div className="look-versions" role="group" aria-label="Board versions">
        <button className="icon-button" aria-label="Older board version" disabled={i === 0} onClick={() => { pick(versions[i - 1]!.v); setNotice('') }}><Icon name="chevron" size={16} className="flip"/></button>
        <span className="num">v{selected.v}</span>
        <button className="icon-button" aria-label="Newer board version" disabled={i === versions.length - 1} onClick={() => { pick(i === versions.length - 2 ? null : versions[i + 1]!.v); setNotice('') }}><Icon name="chevron" size={16}/></button>
      </div>
    </div>
    <div className="ws-meta board-byline">{[board.machine, Number.isFinite(Date.parse(selected.updated_at)) ? new Date(selected.updated_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null, historical ? 'Earlier version · Read only' : !writable ? 'Read only' : null].filter(Boolean).join(' · ')}</div>
    {!historical && baseline !== latest.v && <div className="board-changes" role="status">{change ? `Since v${baseline}: ${change.added} ${change.added === 1 ? 'line' : 'lines'} added, ${change.removed} removed.` : `Your last viewed version (v${baseline}) is no longer in history.`}</div>}
    {sections.map((section, si) => <section key={si} className="board-section" aria-label={section.heading || 'Brief'}>
      {section.heading && <h3 className="ws-label">{section.heading}</h3>}
      {section.blocks.map((text, bi) => {
        const task = boardTask(text), done = task?.state === 'Done' || task?.state === 'Cancelled'
        return <div key={bi} className="board-line" data-changed={change?.changed.has(`${si}:${bi}`) || undefined} data-done={done || undefined} data-wait={/^(waiting on you|decisions)$/i.test(section.heading) || undefined}>
          {task && <span className={`board-task ${task.state === 'In progress' ? 'current' : ''}`} role="img" aria-label={task.state}>{task.state === 'Done' ? <Icon name="check" size={16}/> : task.state === 'Cancelled' ? <Icon name="close" size={14}/> : task.state === 'In progress' ? '●' : '○'}</span>}
          <div className="board-prose"><Markdown text={task?.text ?? text} ctx={ctx}/></div>
          {!historical && writable && <button className="icon-button board-correct" title="Quote in a correction" aria-label={`Correct ${section.heading || 'brief'} line ${bi + 1}`} onMouseDown={e => e.preventDefault()} onClick={e => correct(text, e.currentTarget.parentElement!)}><Icon name="pencil" size={15}/></button>}
        </div>
      })}
    </section>)}
    {notice && <div className="board-notice" role="status">{notice}</div>}
  </section>
}
