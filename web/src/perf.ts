// The stall log: how long the page stayed busy after each hub event, by event type.
// A chat app should spend well under a frame on an event; anything of 50 ms or more is a
// stall someone can feel. This keeps the evidence on the device so a stall can be traced
// to its cause instead of guessed at. It holds event names, durations and sizes only:
// no message text, no ids. Read it with `localStorage.perf` or copy(JSON.parse(...)).

const SLOW_MS = 50
const KEEP = 200

type Total = { n: number; ms: number; max: number; slow: number }
type Slow = { at: number; type: string; ms: number; script: number; batch: number; page: string; nodes: number; hidden: boolean; parts?: Record<string, number> }

const totals: Record<string, Total> = {}
// Render time by part of the app, in profiling builds only (see web/vite.config.ts).
const renders: Record<string, { n: number; ms: number; max: number }> = {}
let parts: Record<string, number> = {}
const slow: Slow[] = []
let since = Date.now()
let clock = () => performance.now()
let first: { type: string; start: number; script?: number } | null = null
let batch = 0
let dirty = false
let closed: Array<() => void> = []

// A message port's task runs after React has rendered and committed what the event
// changed, so the gap is the script time the event cost. Style, layout and paint follow it.
const port = typeof MessageChannel === 'undefined' ? null : new MessageChannel()
if (port)
  port.port1.onmessage = () => {
    if (!first) return
    const ms = clock() - first.start
    const total = (totals[first.type] ??= { n: 0, ms: 0, max: 0, slow: 0 })
    total.n++
    total.ms += ms
    if (ms > total.max) total.max = ms
    if (ms >= SLOW_MS) {
      total.slow++
      const route = typeof location === 'undefined' ? '' : location.hash
      const page = route.startsWith('#/c/') ? 'chat' : route.replace(/^#\/?/, '').split('/')[0] || 'home'
      const dom = typeof document === 'undefined' ? null : document
      const split = Object.keys(parts).length ? Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])) : undefined
      slow.push({ at: Date.now(), type: first.type, ms: Math.round(ms), script: Math.round(first.script ?? ms), batch, page, nodes: dom?.getElementsByTagName('*').length ?? 0, hidden: dom?.hidden ?? false, ...(split && { parts: split }) })
      if (slow.length > KEEP) slow.splice(0, slow.length - KEEP)
      dirty = true
    }
    first = null
    batch = 0
    parts = {}
    const waiting = closed
    closed = []
    for (const resolve of waiting) resolve()
  }

/** React Profiler callback: render time by part, also charged to the event being timed. */
export function rendered(id: string, _phase: string, actual: number) {
  const r = (renders[id] ??= { n: 0, ms: 0, max: 0 })
  r.n++
  r.ms += actual
  if (actual > r.max) r.max = actual
  if (first) parts[id] = (parts[id] ?? 0) + actual
  dirty = true
}

/**
 * Called when an event's store update is done. React renders it in a microtask queued during
 * that update, so a microtask queued now runs once the render is committed: the gap is the
 * script time alone. The task-to-task time above also counts layout and paint, and any
 * delay the browser adds to a hidden window's tasks, which is not work at all.
 */
export function eventSettled() {
  const timing = first
  if (!timing || timing.script !== undefined) return
  timing.script = -1
  queueMicrotask(() => {
    timing.script = clock() - timing.start
  })
}

/** Called as each hub event is applied. Events applied in one task are timed together under the first. */
export function eventApplied(type: string) {
  if (!port) return
  batch++
  if (first) return
  first = { type, start: clock() }
  port.port2.postMessage(0)
}

function save() {
  if (!dirty) return
  dirty = false
  const rounded = Object.fromEntries(Object.entries(totals).map(([type, t]) => [type, { n: t.n, ms: Math.round(t.ms), max: Math.round(t.max), slow: t.slow }]))
  try {
    const parts = Object.fromEntries(Object.entries(renders).map(([id, r]) => [id, { n: r.n, ms: Math.round(r.ms), max: Math.round(r.max) }]))
    localStorage.setItem('perf', JSON.stringify({ since, saved: Date.now(), slowMs: SLOW_MS, totals: rounded, renders: parts, slow }))
  } catch {
    // Storage full or unavailable: the log is a diagnostic, never a reason to fail.
  }
}

if (port && typeof window !== 'undefined') {
  window.setInterval(save, 15_000)
  window.addEventListener('pagehide', save)
}

/** For tests and the console. */
export const perfLog = () => ({ since, totals, slow })

/** For tests: resolves when the event being timed has been measured (its next task ran). */
export const measured = () => new Promise<void>((resolve) => (first ? closed.push(resolve) : resolve()))

/** For tests: measure with this clock instead of the page's. */
export function useClock(now: () => number) {
  clock = now
}
