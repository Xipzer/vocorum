const small = () => window.matchMedia('(max-width: 767px)').matches
const key = (account: string, thread: string) => `board-open:${account}:${thread}`

// Only navigation state is retained, never board content. An explicit Board
// link works on a phone; a bare thread link never reopens its panel there.
export function boardForLocation(account: string) {
  const m = /^#\/c\/(\d+)(?:\?([^#]*))?$/.exec(location.hash)
  if (!m) return null
  const id = m[1]!
  if (new URLSearchParams(m[2] ?? '').get('p') === 'board') return id
  if (small()) return null
  const nav = history.state?.vocorumBoard
  if (nav?.thread === id) return nav.open ? id : null
  return localStorage.getItem(key(account, id)) === 'open' ? id : null
}

export function setBoardLocation(account: string, thread: string, open: boolean, push = true) {
  if (!small()) {
    if (open) localStorage.setItem(key(account, thread), 'open')
    else localStorage.removeItem(key(account, thread))
  }
  const base = `#/c/${thread}`, url = open ? `${base}?p=board` : base
  // Returning Back to the entry preceding Open must really close the board,
  // even though opening it just set the desktop preference for this thread.
  if (push && location.hash !== url) {
    if (location.hash === base) history.replaceState({ ...history.state, vocorumBoard: { thread, open: false } }, '')
    history.pushState({ vocorumBoard: { thread, open } }, '', url)
  } else history.replaceState({ ...history.state, vocorumBoard: { thread, open } }, '', url)
  window.dispatchEvent(new Event('hashchange'))
}
