// Plain text for places that cannot render markdown: session titles, reply
// previews, sheet headers. Mentions become names, markdown marks go away.

export function plain(text: string, userName: (id: string) => string | null = () => null, channelName: (id: string) => string | null = () => null): string {
  return text
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${userName(id) ?? 'someone'}`)
    .replace(/<#(\d+)>/g, (_, id: string) => `#${channelName(id) ?? 'channel'}`)
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(-?\d+)(?::\w)?>/g, (_, s: string) => new Date(Number(s) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]\n]+)\]\(<?https?:\/\/[^\s)>]+>?\)/g, '$1')
    .replace(/^\s{0,3}(#{1,3}|-#|>{1,3}|[-*]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~|\|\||`)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\*\*|``?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// A project's wallpaper hue, from a fixed set that keeps clear of the status colours.
const HUES = ['0 210 255', '255 46 136', '64 224 160', '255 140 50', '120 140 255', '255 92 92', '230 200 60', '80 170 255']
export function wallHue(name: string): string {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return HUES[h % HUES.length]!
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

// Machine names as people say them: "desktop" reads "Desktop".
export const machineLabel = (name: string) => name.charAt(0).toUpperCase() + name.slice(1)

// How a person is shown: their display name, else their username.
export const displayName = (u: { username: string; global_name?: string | null } | undefined) => (u ? (u.global_name ?? u.username) : 'Someone')

// Scrolls glide unless the system asks for reduced motion.
export const motion = (): ScrollBehavior => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth')

// Discord's paging and Jump to present glide (60 fps captures): 580 ms, cubic-bezier(0.23, 0.04, 0.23, 1).
const GLIDE_MS = 580
const curve = (s: number, a: number, b: number) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3
const ease = (t: number) => {
  let lo = 0, hi = 1
  for (let i = 0; i < 20; i++) { const s = (lo + hi) / 2; if (curve(s, 0.23, 0.23) < t) lo = s; else hi = s }
  return curve((lo + hi) / 2, 0.04, 1)
}
export type Glide = { frame: number; to: number }
// Scrolls el to to() over GLIDE_MS; to() is read every frame so a growing list still lands at the end.
// Input stops a glide, so any other move of the scroll position on the way is the list keeping
// its reader in place (older history added above): the glide moves with it.
export function glide(el: HTMLElement, to: () => number, g: Glide, done?: () => void) {
  cancelAnimationFrame(g.frame)
  g.to = to()
  if (motion() === 'auto') { g.frame = 0; el.scrollTop = g.to; return done?.() }
  let from = el.scrollTop, shift = 0, last = from
  const start = performance.now(), fixed = g.to
  const step = (now: number) => {
    const t = Math.min(1, Math.max(0, (now - start) / GLIDE_MS))
    const moved = el.scrollTop - last
    if (Math.abs(moved) > 1) { shift += moved; from += moved }
    // A fixed target moves with the content; a live one (the end) is already where it should be.
    const target = to()
    g.to = target === fixed ? target + shift : target
    el.scrollTop = from + (g.to - from) * ease(t)
    last = el.scrollTop
    if (t < 1) g.frame = requestAnimationFrame(step)
    else { g.frame = 0; done?.() }
  }
  g.frame = requestAnimationFrame(step)
}
// The browser's (and Discord's) page step: 87.5% of the view.
export const pageStep = (el: HTMLElement) => el.clientHeight * 0.875

// Closes a dialog after its exit animation (Discord's modal and settings close).
// Phones close at once unless the same layer animates there too (`phones`).
export function leave(el: HTMLElement | null, done: () => void, ms = 100, phones = false) {
  if (!el || motion() === 'auto' || (!phones && !window.matchMedia('(min-width: 768px)').matches)) return done()
  if (el.dataset['leaving'] !== undefined) return
  // On its way out it is already gone for clicks, keys and assistive tech.
  el.dataset['leaving'] = ''
  el.inert = true
  el.setAttribute('aria-hidden', 'true')
  window.setTimeout(done, ms)
}
