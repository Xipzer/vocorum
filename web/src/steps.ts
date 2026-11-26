// Kimaki's tool lines, which the chat folds into "N steps". Kimaki writes them as subtext
// ("-# ┣ shell …", "-# ◼︎ edit …", "-# thinking"); before September 2026 it wrote the same
// lines without "-# " ("┣ bash …"). A failed tool is "⨯ shell …" in either form.

import type { Message } from './api.ts'
import { plain } from './text.ts'

const MARK = /^(┣|◼︎|◼|■|⨯)\s*/
const TOOL_LINE = /^(-# (.*(┣|◼︎|◼|■)|\s*⨯\s|\*?_?thinking\b)|(┣|◼︎|◼|■|⨯)\s)/

// A bot message made only of tool lines.
export function isToolOnly(m: Message) {
  if (!m.author.bot || m.attachments.length || m.components?.length || m.embeds.length || !m.content) return false
  const lines = m.content.split('\n').filter((l) => l.trim())
  return lines.length > 0 && lines.every((l) => TOOL_LINE.test(l))
}

// The tool lines of a run, all as subtext so older lines look like current ones.
export function stepLines(messages: Message[]) {
  return messages.flatMap((m) => m.content.split('\n').filter((l) => l.trim())).map((l) => (l.startsWith('-# ') ? l : `-# ${l}`))
}

// A tool line without its subtext marker and glyph: "shell _Build the docs_".
export function stepText(line: string) {
  return plain(line.replace(/^-#\s*/, '').replace(MARK, ''))
}
