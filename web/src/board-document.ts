// The hub already authorised this thread and read the bot's local attachment.
// No document body is written to browser storage or fetched from an attachment URL.
export type BoardVersion = { v: number; title: string; markdown: string; updated_at: string }
export type BoardPage = { board: { thread_id: string; message_id: string; machine: string | null; versions: BoardVersion[] } | null; seen_version: number | null }
export type BoardSection = { heading: string; blocks: string[] }

// Keep tables, fences, and nested lists intact for the existing markdown renderer.
// Headings inside a code sample are text, not sections. Empty headings are omitted.
export function boardSections(source: string): BoardSection[] {
  const sections: BoardSection[] = []
  let section: BoardSection = { heading: '', blocks: [] }, lines: string[] = [], fence = ''
  const flush = () => { if (lines.length) section.blocks.push(lines.join('\n')); lines = [] }
  const end = () => { flush(); if (section.blocks.length) sections.push(section) }
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      lines.push(line)
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) { fence = ''; flush() }
    } else if (marker) { flush(); fence = marker[1]!; lines.push(line) }
    else {
      const heading = /^ {0,3}#{1,6}\s+(.+?)\s*$/.exec(line)
      if (heading) { end(); section = { heading: heading[1]!.replace(/\s+#+$/, ''), blocks: [] } }
      else if (!line.trim()) flush()
      else {
        if (/^(?:[-*+] |\d+[.)] )/.test(line)) flush()
        lines.push(line)
      }
    }
  }
  end(); return sections
}

// Compare occurrences within their section. Duplicate lines count individually;
// losing a fact counts even when the next version adds no text to highlight.
export function boardChanges(before: BoardSection[], after: BoardSection[]) {
  const count = new Map<string, number>(), changed = new Set<string>()
  const linesOf = (s: BoardSection, i: number) => s.blocks[i]!.split('\n').map(l => l.trim()).filter(Boolean).map(l => `${s.heading}\0${l}`)
  for (const s of before) s.blocks.forEach((_, i) => { for (const key of linesOf(s, i)) count.set(key, (count.get(key) ?? 0) + 1) })
  let added = 0
  after.forEach((s, si) => s.blocks.forEach((_, bi) => {
    for (const key of linesOf(s, bi)) {
      const n = count.get(key) ?? 0
      if (n) count.set(key, n - 1)
      else { added++; changed.add(`${si}:${bi}`) }
    }
  }))
  return { added, removed: [...count.values()].reduce((a, n) => a + n, 0), changed }
}

export type BoardCorrection = { thread: string; v: number; quote: string }
export const BOARD_CORRECT = 'vocorum:board-correction'
export const BOARD_UPDATED = 'vocorum:board-update'

// Public todowrite uses [ ] with a suffix for an in-progress item and [-]
// for a cancelled one. A cancelled item must never look active.
export function boardTask(line: string) {
  const m = /^\s*[-*] \[([ xX>~-])\]\s+([\s\S]+)$/.exec(line)
  if (!m) return null
  const text = m[2]!, mark = m[1]!.toLowerCase()
  const state = mark === 'x' ? 'Done' : mark === '-' ? 'Cancelled' : mark === '>' || mark === '~' || / \(in progress\)$/.test(text) ? 'In progress' : 'Pending'
  return { state, text }
}

// Respect the normal chat limit and the person's existing unsent text. The
// receiver either takes the whole quote or leaves the existing draft untouched.
export function correctedDraft(existing: string, { v, quote }: BoardCorrection) {
  const next = `${existing}${existing ? '\n\n' : ''}Board v${v}:\n${quote.trim().split('\n').map(line => `> ${line}`).join('\n')}\n\nCorrection: `
  return next.length <= 2000 ? next : null
}
