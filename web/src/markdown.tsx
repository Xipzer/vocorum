// Discord's markdown subset, rendered to React (never HTML strings):
// headings, -# subtext, quotes (> and >>>), lists, code blocks, inline code,
// bold/italic/underline/strike/spoiler, links, mentions, timestamps, emoji.

import { highlight } from './highlight.tsx'
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './icons.tsx'
import { usePress } from './Sheet.tsx'
import { plain } from './text.ts'
import { CustomEmoji, emojify } from './emoji.tsx'
import { footerModel, ModelBadge } from './ModelBadge.tsx'

export type MarkdownContext = {
  userName: (id: string) => string | null
  channelName: (id: string) => string | null
  openChannel?: (id: string) => void
  openMessage?: (channelId: string, messageId: string) => void
  // The hub thread of a Kimaki session ID, when known.
  sessionThread?: (sessionId: string) => string | null
  isThread?: (id: string) => boolean
  // A role mention's name and colour.
  role?: (id: string) => { name: string; color: number } | null
  // Long press or right click on a link: the link sheet.
  linkMenu?: (link: { url: string; channelId?: string }, at: { x: number; y: number }) => void
  // Set by Markdown for emoji-only messages: emoji render large.
  jumbo?: boolean
  // Choices for user (5), role (6), mentionable (7) and channel (8) menus.
  selectOptions?: (type: number, channelTypes?: number[]) => Array<{ label: string; value: string; description?: string }>
}

const INLINE =
  /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)|<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?*_~|])|<@!?(\d+)>|<@&(\d+)>|<#(\d+)>|<t:(-?\d+)(?::([tTdDfFR]))?>|<a?:(\w+):(\d+)>|\*\*([\s\S]+?)\*\*(?!\*)|__([\s\S]+?)__(?!_)|\*([^\s*](?:[\s\S]*?[^\s\\])?)\*(?!\*)|\b_([^\s_](?:[\s\S]*?[^\s_])?)_\b|~~([\s\S]+?)~~|\|\|([\s\S]+?)\|\||\\([^\w\s])|\b(ses_[A-Za-z0-9]{24,28})\b|<\/([\w-]+(?: [\w-]+){0,2}):(\d+)>|<id:(customize|browse|guide|linked-roles)>|(?<![\w@])@(everyone|here)\b/

const GUILD_NAV: Record<string, string> = { customize: 'Channels & Roles', browse: 'Browse Channels', guide: 'Server Guide', 'linked-roles': 'Linked Roles' }

// <t:…:R> stays current; every style shows the full date on hover, as in Discord.
function TimeMention({ seconds, style }: { seconds: number; style: string | undefined }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (style !== 'R') return
    const id = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [style])
  return (
    <time className="timestamp-mention" dateTime={new Date(seconds * 1000).toISOString()} title={formatTimestamp(seconds, 'F')}>
      {formatTimestamp(seconds, style)}
    </time>
  )
}

function formatTimestamp(seconds: number, style = 'f'): string {
  const date = new Date(seconds * 1000)
  if (style === 'R') {
    const diff = (date.getTime() - Date.now()) / 1000
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
      ['year', 31536000],
      ['month', 2592000],
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60],
      ['second', 1],
    ]
    const [unit, size] = units.find(([, s]) => Math.abs(diff) >= s) ?? ['second', 1]
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(diff / size), unit)
  }
  const options: Record<string, Intl.DateTimeFormatOptions> = {
    t: { timeStyle: 'short' },
    T: { timeStyle: 'medium' },
    d: { dateStyle: 'short' },
    D: { dateStyle: 'long' },
    f: { dateStyle: 'long', timeStyle: 'short' },
    F: { dateStyle: 'full', timeStyle: 'short' },
  }
  return date.toLocaleString(undefined, options[style] ?? options['f'])
}

// The link's own sheet, not the message's: right clicks stop here.
function useLinkPress(ctx: MarkdownContext, link: { url: string; channelId?: string }) {
  const press = usePress((at) => ctx.linkMenu?.(link, at))
  if (!ctx.linkMenu) return {}
  return {
    ...press,
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
      e.stopPropagation()
      press.onContextMenu(e)
    },
  }
}

function Link({ url, ctx, title, children }: { url: string; ctx: MarkdownContext; title?: string; children: ReactNode }) {
  const press = useLinkPress(ctx, { url })
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" title={title} {...press}>
      {children}
    </a>
  )
}

// A link to a channel or thread on this hub, or a Kimaki session ID: shown by name, opens in place.
function ChannelChip({ id, name, url, ctx, title, message }: { id: string; name: string; url: string; ctx: MarkdownContext; title?: string; message?: string }) {
  const press = useLinkPress(ctx, { url, channelId: id })
  return (
    <a
      href={`#/c/${id}${message ? `/${message}` : ''}`}
      className="mention channel-chip"
      title={title ?? url}
      onClick={(e) => {
        e.preventDefault()
        if (message && ctx.openMessage) ctx.openMessage(id, message)
        else ctx.openChannel?.(id)
      }}
      {...press}
    >
      <Icon name={ctx.isThread?.(id) ? 'thread' : 'hash'} size={14} />
      <span>{plain(name)}</span>
      {message && (
        <>
          <Icon name="chevron" size={12} />
          <Icon name="chat" size={14} />
        </>
      )}
    </a>
  )
}

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false)
  return (
    <span className={`spoiler${shown ? ' shown' : ''}`} onClick={() => setShown(true)}>
      {children}
    </span>
  )
}

// Machine tokens in agent prose, coloured by what they are (like a terminal's grey ids):
// session ids, snowflakes and hashes dim and monospace; paths monospace; durations,
// sizes, percentages and token counts with even figures; key= in key=value dim.
const SEMANTIC = /(\bses_[A-Za-z0-9]{12,}\b|\b\d{17,20}\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,12}\b)|((?:~|\.{1,2})?\/[\w.@~-]+(?:\/[\w.@~-]+)+\/?|\b[\w-]+(?:[\/.][\w-]+)*\.(?:tsx?|jsx?|mjs|cjs|py|rs|go|md|json|css|ya?ml|toml|sh|html|sql|lock)\b)|(\b\d+m \d+s\b|\b\d+(?:[.,]\d+)*\s?(?:ms|s|m|h|%|KB|MB|GB|tokens?|lines?)(?![\w]))|(\b[a-z_][\w.-]*=)(?=\S)/gi
function semantic(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  for (const m of text.matchAll(SEMANTIC)) {
    if (m.index! > last) out.push(...emojify(text.slice(last, m.index), `${key}e${n}`))
    const cls = m[1] ? 'sem-id' : m[2] ? 'sem-path' : m[3] ? 'sem-num' : 'sem-key'
    out.push(<span key={`${key}s${n++}`} className={cls}>{m[0]}</span>)
    last = m.index! + m[0].length
  }
  if (last === 0) return emojify(text, `${key}e`)
  if (last < text.length) out.push(...emojify(text.slice(last), `${key}e${n}`))
  return out
}

// Kimaki starts each text part with ⬥: drawn as a small accent diamond (the character
// stays in the text, so copying is unchanged, and no font is needed to show it).
const TEXT_MARK = /^⬥\s/
export function inline(text: string, ctx: MarkdownContext, key = 'i'): ReactNode[] {
  if (TEXT_MARK.test(text)) return [<span key={`${key}-mark`} className="text-mark">⬥</span>, ' ', ...inline(text.slice(2), ctx, key)]
  const out: ReactNode[] = []
  let rest = text
  let n = 0
  while (rest) {
    const m = INLINE.exec(rest)
    if (!m) {
      out.push(...semantic(rest, `${key}-t${n}`))
      break
    }
    if (m.index > 0) out.push(...semantic(rest.slice(0, m.index), `${key}-t${n}`))
    const k = `${key}-${n++}`
    const [, ticks, code, linkText, linkUrl, angleUrl, bareUrl, user, role, channel, ts, tsStyle, emojiName, emojiId, bold, underline, italic, italic2, strike, spoiler, escaped, sessionId, command, commandId, guildNav, everyone] = m
    const url = linkUrl ?? angleUrl ?? bareUrl
    const internalMatch = url ? /^https:\/\/(?:\w+\.)?discord(?:app)?\.com\/channels\/\d+\/(\d+)(?:\/(\d+))?\/?$/.exec(url) : null
    const internal = internalMatch?.[1]
    const roleInfo = role ? ctx.role?.(role) : null
    const internalName = internal ? ctx.channelName(internal) : null
    const sessionChannel = sessionId ? ctx.sessionThread?.(sessionId) : null
    if (ticks) out.push(<code key={k}>{code!.replace(/^ (.*) $/s, '$1')}</code>)
    else if (internal && internalName) out.push(<ChannelChip key={k} id={internal} name={ctx.openMessage && linkText ? linkText : internalName} url={url!} ctx={ctx} message={internalMatch?.[2]} />)
    else if (sessionId) out.push(sessionChannel && ctx.channelName(sessionChannel) ? <ChannelChip key={k} id={sessionChannel} name={ctx.channelName(sessionChannel)!} url={`${location.origin}/#/c/${sessionChannel}`} ctx={ctx} title={sessionId} /> : <span key={k} className="sem-id">{sessionId}</span>)
    else if (url) out.push(<Link key={k} url={url} ctx={ctx} title={linkText ? url : undefined}>{linkText ? inline(linkText, ctx, k) : url}</Link>)
    else if (user) out.push(<span key={k} className="mention">@{ctx.userName(user) ?? 'unknown-user'}</span>)
    else if (role) {
      const rgb = roleInfo?.color ? `${(roleInfo.color >> 16) & 255} ${(roleInfo.color >> 8) & 255} ${roleInfo.color & 255}` : null
      out.push(<span key={k} className={`mention${rgb ? ' role-mention' : ''}`} style={rgb ? ({ '--role': rgb } as React.CSSProperties) : undefined}>@{roleInfo?.name ?? 'unknown-role'}</span>)
    } else if (channel) out.push(ctx.channelName(channel) ? <ChannelChip key={k} id={channel} name={ctx.channelName(channel)!} url={`${location.origin}/#/c/${channel}`} ctx={ctx} /> : <span key={k} className="mention muted-mention">#unknown</span>)
    else if (ts) out.push(<TimeMention key={k} seconds={Number(ts)} style={tsStyle} />)
    else if (emojiName) out.push(<CustomEmoji key={k} name={emojiName} id={emojiId!} jumbo={ctx.jumbo} />)
    else if (command) out.push(<span key={k} className="mention command-mention" title={`/${command}`}>/{command}</span>)
    else if (guildNav) out.push(<span key={k} className="mention">{GUILD_NAV[guildNav]}</span>)
    else if (everyone) out.push(<span key={k} className="mention">@{everyone}</span>)
    else if (bold !== undefined) out.push(<strong key={k}>{inline(bold, ctx, k)}</strong>)
    else if (underline !== undefined) out.push(<u key={k}>{inline(underline, ctx, k)}</u>)
    else if (italic !== undefined || italic2 !== undefined) out.push(<em key={k}>{inline((italic ?? italic2)!, ctx, k)}</em>)
    else if (strike !== undefined) out.push(<s key={k}>{inline(strike, ctx, k)}</s>)
    else if (spoiler !== undefined) out.push(<Spoiler key={k}>{inline(spoiler, ctx, k)}</Spoiler>)
    else if (escaped) out.push(escaped)
    rest = rest.slice(m.index + m[0].length)
  }
  return out
}

// Discord's code block (wrapped, hairline card), plus a language tag, a copy icon and,
// past 24 lines, a fold so a long paste doesn't bury the conversation.
const FOLD = 24
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const lines = code.split('\n').length
  const [open, setOpen] = useState(lines <= FOLD)
  return (
    <div className={`codeblock${open ? '' : ' folded'}`}>
      <div className="codeblock-tools">
        {lang && <span className="codeblock-lang">{lang}</span>}
        <button
          className="codeblock-copy"
          aria-label={copied ? 'Copied' : 'Copy code'}
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={16} />
        </button>
      </div>
      <pre>
        <code>{highlight(lang, code)}</code>
      </pre>
      {lines > FOLD && (
        <button className="codeblock-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `${lines - FOLD} more lines`}
        </button>
      )}
    </div>
  )
}

// One gutter row. Tool rows push a trailing "(694 ms)" to the right, like a log's timing column.
function StatusRow({ tone, text, ctx, id }: { tone: Tone; text: string; ctx: MarkdownContext; id: string }) {
  const timing = tone === 'tool' ? /\s*\((\d+(?:[.,]\d+)?\s?(?:ms|s|m))\)[_*]*\s*$/.exec(text) : null
  const body = timing ? text.slice(0, timing.index) : text
  // Kimaki's "┣ bash _cd …_" lines: the tool name as a quiet mono label, then what it did.
  const named = tone === 'tool' ? /^([a-z][\w-]{1,24})\s+(.+)$/.exec(body) : null
  return (
    <div className={`status-row ${tone}`}>
      <i aria-label={TONE_LABEL[tone]} />
      <span className="status-text">
        {named ? (
          <>
            <span className="tool-name">{named[1]}</span> {inline(named[2]!, ctx, id)}
          </>
        ) : (
          inline(body, ctx, id)
        )}
      </span>
      {timing && <span className="status-time num">{timing[1]}</span>}
    </div>
  )
}

type Block =
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'quote'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'subtext'; text: string }
  | { kind: 'relay'; lines: string[] }
  | { kind: 'meta'; items: string[]; mention?: string }
  | { kind: 'gap' }
  | { kind: 'step'; glyph: string; tool: string; rest: string }
  | { kind: 'table'; head: string[]; align: Array<'left' | 'right' | 'center'>; rows: string[][] }
  | { kind: 'callout'; accent: string | null; text: string }
  | { kind: 'kv'; title: string | null; rows: Array<[string, string]> }
  | { kind: 'list'; ordered: boolean; start: number; items: Array<{ depth: number; text: string; n: number | null }> }
  | { kind: 'text'; text: string }
  | { kind: 'status'; rows: Array<{ tone: Tone; text: string }> }

type Tone = 'ok' | 'warn' | 'bad' | 'tool' | 'think' | 'say' | 'info'
// Status lines agents write ("✅ **API**: up", "- ⚠️ stale"): shown as rows with a coloured dot.
// Status lines agents write with emoji become one gutter column, like a terminal log:
// ● ok, ▲ warning, ■ problem, a tool mark for tool calls, quiet marks for thinking,
// speech and notices. One glyph and one colour per kind instead of mixed emoji.
const STATUS = /^\s*(?:[-*] )?(✅|☑️|✔️|🟢|⚠️|⚠|🟡|🟠|❌|🔴|🚨|⛔|🛑|🔧|🛠️|🛠|💭|🗣️|🗣|✋|🤚|↩️|⤵️|🔁|🔄|👋|ℹ️|🎙️|🎙|×|✗)\uFE0F?\s+(.+)$/u
const TONE: Record<string, Tone> = { '✅': 'ok', '☑️': 'ok', '✔️': 'ok', '🟢': 'ok', '⚠️': 'warn', '⚠': 'warn', '🟡': 'warn', '🟠': 'warn', '❌': 'bad', '🔴': 'bad', '🚨': 'bad', '⛔': 'bad', '🛑': 'bad', '×': 'bad', '✗': 'bad', '🔧': 'tool', '🛠️': 'tool', '🛠': 'tool', '💭': 'think', '🗣️': 'say', '🗣': 'say', '✋': 'info', '🤚': 'info', '↩️': 'info', '⤵️': 'info', '🔁': 'info', '🔄': 'info', '👋': 'info', 'ℹ️': 'info', '🎙️': 'say', '🎙': 'say' }
const TONE_LABEL: Record<Tone, string> = { ok: 'Done', warn: 'Warning', bad: 'Problem', tool: 'Tool', think: 'Thinking', say: 'Said', info: 'Note' }

function blocks(source: string): Block[] {
  const out: Block[] = []
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let text: string[] = []
  // Discord keeps a blank line between blocks as one empty 22px line; inside a paragraph
  // pre-wrap keeps it already, so only blank lines at a paragraph's edge become gaps.
  const flush = () => {
    let blanks = 0
    while (text.length && !text.at(-1)!.trim()) text.pop(), blanks++
    if (text.length) out.push(metaLine(text) ?? keyValues(text) ?? { kind: 'text', text: text.join('\n') })
    for (let b = 0; b < blanks; b++) out.push({ kind: 'gap' })
    text = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^```(\S*)\s*(.*)$/.exec(line)
    if (fence) {
      // ```lang\n...\n``` or a one-line ```code```
      const sameLine = /^```(.*?)```\s*$/.exec(line)
      if (sameLine && line.length > 6) {
        flush()
        out.push({ kind: 'code', lang: '', code: sameLine[1]! })
        continue
      }
      const end = lines.findIndex((l, j) => j > i && /```\s*$/.test(l))
      if (end > i) {
        flush()
        const body = lines.slice(i + 1, end + 1)
        body[body.length - 1] = body[body.length - 1]!.replace(/```\s*$/, '')
        if (body[body.length - 1] === '') body.pop()
        const lang = fence[2] ? '' : fence[1]!
        if (fence[2]) body.unshift(fence[1] + (fence[1] ? ' ' : '') + fence[2])
        out.push({ kind: 'code', lang, code: body.join('\n') })
        i = end
        continue
      }
    }
    if (line.startsWith('>>> ')) {
      flush()
      out.push({ kind: 'quote', text: [line.slice(4), ...lines.slice(i + 1)].join('\n') })
      break
    }
    if (/^> ?/.test(line) && line.startsWith('>')) {
      flush()
      const quoted: string[] = []
      while (i < lines.length && /^>( |$)/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^> ?/, ''))
      i--
      out.push({ kind: 'quote', text: quoted.join('\n') })
      continue
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line)
    if (heading) {
      flush()
      while (out.at(-1)?.kind === 'gap') out.pop()
      out.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! })
      continue
    }
    // GitHub pipe tables, common in agents' reports (Discord shows them raw).
    const sep = lines[i + 1]
    if (/^\s*\|.*\|\s*$/.test(line) && sep && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(sep)) {
      flush()
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim())
      const head = cells(line)
      const align = cells(sep).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left') as 'left' | 'right' | 'center')
      const rows: string[][] = []
      i += 2
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(cells(lines[i++]!))
      i--
      out.push({ kind: 'table', head, align, rows })
      continue
    }
    // Raw <callout accent="#hex"> … </callout> that reached the text unconverted.
    const callout = /^<callout\b([^>]*)>\s*$/.exec(line)
    if (callout) {
      const end = lines.findIndex((l, j) => j > i && /^<\/callout>\s*$/.test(l))
      if (end > i) {
        flush()
        out.push({ kind: 'callout', accent: /#([0-9a-f]{6})\b/i.exec(callout[1]!)?.[1] ?? null, text: lines.slice(i + 1, end).join('\n') })
        i = end
        continue
      }
    }
    // Kimaki's step lines ("┣ shell _Deploy_", "■ write _file_ (12 lines)"): Discord shows
    // them as quiet small text with their glyph, and so do we.
    const step = /^(?:-# )?([┣■◼]\uFE0E?)(\s+)([\w-]+)(.*)$/.exec(line)
    if (step) {
      flush()
      out.push({ kind: 'step', glyph: step[1]! + step[2]!, tool: step[3]!, rest: step[4]! })
      continue
    }
    if (line.startsWith('-# ')) {
      const meta = metaLine([line.slice(3)])
      if (meta) {
        flush()
        out.push(meta)
        continue
      }
    }
    if (line.startsWith('-# » ')) {
      flush()
      const relay: string[] = []
      while (i < lines.length && lines[i]!.startsWith('-# ')) relay.push(lines[i++]!.slice(3))
      i--
      out.push({ kind: 'relay', lines: relay })
      continue
    }
    if (line.startsWith('-# ')) {
      flush()
      out.push({ kind: 'subtext', text: line.slice(3) })
      continue
    }
    if (STATUS.test(line)) {
      flush()
      const rows: Array<{ tone: Tone; text: string }> = []
      for (let m = STATUS.exec(lines[i] ?? ''); m && i < lines.length; m = STATUS.exec(lines[++i] ?? '')) rows.push({ tone: TONE[m[1]!] ?? 'warn', text: m[2]! })
      i--
      out.push({ kind: 'status', rows })
      continue
    }
    const item = /^(\s*)([-*]|(\d+)\.) (.*)$/.exec(line)
    if (item) {
      flush()
      const ordered = Boolean(item[3])
      const list: Block & { kind: 'list' } = { kind: 'list', ordered, start: Number(item[3] ?? 1), items: [] }
      while (i < lines.length) {
        const next = /^(\s*)([-*]|(\d+)\.) (.*)$/.exec(lines[i]!)
        if (!next) break
        // A top-level item of the other kind starts a new list, as in Discord.
        if (list.items.length && next[1]!.length < 2 && Boolean(next[3]) !== ordered) break
        list.items.push({ depth: Math.min(Math.floor(next[1]!.length / 2), 3), text: next[4]!, n: next[3] ? Number(next[3]) : null })
        i++
      }
      i--
      out.push(list)
      continue
    }
    if (!line.trim() && !text.length) {
      // A blank line right after a block (or at the start): a gap, except before a heading,
      // whose own 16px margin already stands in for it, as in Discord.
      if (out.length && !/^#{1,3} /.test(lines[i + 1] ?? '')) out.push({ kind: 'gap' })
      continue
    }
    text.push(line)
  }
  flush()
  while (out.at(-1)?.kind === 'gap') out.pop()
  return out
}

// Kimaki's step lines keep Discord's tree glyphs; the glyph and tool name take a colour
// by what the step does, so a run reads at a glance: shell, files, reading, web, agents.
function toolKind(tool: string) {
  const t = tool.toLowerCase()
  if (/^(bash|shell|sh|zsh|run|exec)$/.test(t)) return 'shell'
  if (/^(write|edit|apply_patch|patch|multiedit|create|delete|move)$/.test(t)) return 'write'
  if (/^(read|grep|glob|list|ls|find|search|view)$/.test(t)) return 'read'
  if (/^(webfetch|websearch|fetch|web|browse|curl)$/.test(t)) return 'web'
  if (/^(task|subagent|general|explore|agent|send)$/.test(t)) return 'agent'
  return 'other'
}

// Kimaki's run footer ("*project ⋅ branch ⋅ 7m 16s ⋅ 19% ⋅ model*"): a quiet meta line.
function metaLine(lines: string[]): (Block & { kind: 'meta' }) | null {
  if (lines.length !== 1) return null
  const m = /^\s*([*_])([^*\n]+)\1(?:\s+(<@!?\d+>))?\s*$/.exec(lines[0]!)
  if (!m) return null
  const items = m[2]!.split(/\s+[⋅·•]\s+/)
  if (items.length < 2 || (!items.every((x) => x.length <= 48) && !footerModel(items))) return null
  return { kind: 'meta', items, mention: m[3] }
}

// "**Label** value" lines (two or more, optionally under one plain title line) read as a
// label/value grid instead of a ragged stack. Kimaki writes stats this way.
const KV = /^\*{2,4}([^*\n]{1,40}?)\*{2,4}:?\s+(\S.*)$/
function keyValues(lines: string[]): (Block & { kind: 'kv' }) | null {
  const title = lines.length > 1 && !KV.test(lines[0]!) && lines[0]!.length <= 60 && !/[*`]/.test(lines[0]!) ? lines[0]! : null
  const body = title === null ? lines : lines.slice(1)
  if (body.length < (title === null ? 2 : 1)) return null
  const rows: Array<[string, string]> = []
  for (const line of body) {
    const m = KV.exec(line.trim())
    if (!m) return null
    rows.push([m[1]!.trim(), m[2]!])
  }
  return { kind: 'kv', title, rows }
}
export function keyValueBlock(text: string) {
  const all = blocks(text)
  return all.length === 1 && all[0]!.kind === 'kv' ? all[0] : null
}

// Measure the preview after wrapping. A short line on a wide screen needs no toggle.
const relayChecks = new WeakMap<Element, () => void>()
let relaySizes: ResizeObserver | undefined
function Relay({ lines, ctx, id }: { lines: string[]; ctx: MarkdownContext; id: string }) {
  const [open, setOpen] = useState(false)
  const [clipped, setClipped] = useState(false)
  const preview = useRef<HTMLDivElement>(null)
  const first = lines[0]!
  const moreLines = lines.length > 1
  useLayoutEffect(() => {
    const el = preview.current
    if (open || moreLines || !el) return
    const check = () => setClipped(el.scrollHeight > el.clientHeight + 1)
    check()
    relaySizes ??= new ResizeObserver(entries => { for (const e of entries) relayChecks.get(e.target)?.() })
    relayChecks.set(el, check)
    relaySizes.observe(el)
    void document.fonts.ready.then(() => { if (relayChecks.get(el) === check) check() })
    return () => { relaySizes?.unobserve(el); relayChecks.delete(el) }
  }, [open, moreLines, first])
  return (
    <div className={`relay${open ? ' open' : ''}`}>
      <div className="relay-text">
        {open ? <Markdown text={lines.join('\n')} ctx={ctx} /> : <div ref={preview} className="relay-preview">{inline(first, ctx, `${id}-0`)}</div>}
      </div>
      {(moreLines || clipped || open) && (
        <button className="relay-toggle" aria-expanded={open} aria-label={open ? 'Show less' : 'Show all'} onClick={() => setOpen(!open)}>
          <Icon name="chevron" size={14} />
        </button>
      )}
    </div>
  )
}

function KeyValues({ block, ctx, id }: { block: Block & { kind: 'kv' }; ctx: MarkdownContext; id: string }) {
  return (
    <div className="kv">
      {block.title && <div className="kv-title">{inline(block.title, ctx, `${id}-t`)}</div>}
      <dl>
        {block.rows.map(([label, value], j) => (
          <div key={j} className="kv-row">
            <dt>{inline(label, ctx, `${id}-${j}l`)}</dt>
            <dd>{inline(value, ctx, `${id}-${j}v`)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

// Numbered items before item j at its depth, back to its parent.
function siblingsBefore(items: Array<{ depth: number; n: number | null }>, j: number): number {
  let count = 0
  for (let i = j - 1; i >= 0 && items[i]!.depth >= items[j]!.depth; i--) if (items[i]!.depth === items[j]!.depth && items[i]!.n !== null) count++
  return count
}

// Messages of only emoji (up to 30) show them large, as Discord does.
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}\u200d\uFE0F\u20E3]|<a?:\w+:\d+>|\s)+$/u
function isJumbo(text: string) {
  if (!EMOJI_ONLY.test(text) || !/\p{Extended_Pictographic}|<a?:\w+:\d+>/u.test(text)) return false
  const custom = text.match(/<a?:\w+:\d+>/g)?.length ?? 0
  const rest = text.replace(/<a?:\w+:\d+>|\s/g, '')
  const unicode = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter().segment(rest)].length : rest.length
  return custom + unicode <= 30
}

export const Markdown = memo(function Markdown({ text, ctx, runFooter = false }: { text: string; ctx: MarkdownContext; runFooter?: boolean }) {
  if (!text) return null
  if (!ctx.jumbo && isJumbo(text.trim())) ctx = { ...ctx, jumbo: true }
  return (
    <div className={`markdown${ctx.jumbo ? ' jumbo' : ''}`}>
      {blocks(text).map((block, index) => {
        const key = `b${index}`
        switch (block.kind) {
          case 'code':
            return <CodeBlock key={key} lang={block.lang} code={block.code} />
          case 'quote':
            return (
              <blockquote key={key}>
                <Markdown text={block.text} ctx={ctx} />
              </blockquote>
            )
          case 'heading': {
            const Tag = `h${block.level}` as 'h1'
            return <Tag key={key}>{inline(block.text, ctx, key)}</Tag>
          }
          case 'table': {
            const numeric = block.head.map((_, j) => block.rows.length > 0 && block.rows.every((r) => !r[j] || /^[~≈<>+\-$£€]?[\d.,]+\s?(%|x|k|m|ms|s|kb|mb|gb)?\**$/i.test(r[j]!.replace(/\*\*/g, ''))))
            return (
              <div key={key} className="kv-table-wrap md-table-wrap">
                <table className="kv-table md-table">
                  <thead>
                    <tr>
                      {block.head.map((h, j) => (
                        <th key={j} scope="col" style={{ textAlign: numeric[j] ? 'right' : block.align[j] }}>
                          {inline(h, ctx, `${key}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((r, ri) => (
                      <tr key={ri}>
                        {block.head.map((_, j) => (
                          <td key={j} style={{ textAlign: numeric[j] ? 'right' : block.align[j] }}>
                            {inline(r[j] ?? '', ctx, `${key}-${ri}-${j}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
          case 'step':
            return (
              <div key={key} className={`subtext step-line tool-${toolKind(block.tool)}`}>
                <span className="step-glyph">{block.glyph}</span>
                <span className="step-tool">{block.tool}</span>
                {inline(block.rest, ctx, key)}
              </div>
            )
          case 'gap':
            return <div key={key} className="md-gap" aria-hidden="true" />
          case 'meta': {
            const model = runFooter ? footerModel(block.items) : null
            return (
              <div key={key} className="meta-line">
                {block.items.map((item, j) => (
                  <span key={j}>
                    {j > 0 && <span className="meta-sep"> ⋅ </span>}
                    {model?.at === j ? <ModelBadge {...model.model} /> : inline(item, ctx, `${key}-${j}`)}
                  </span>
                ))}
                {block.mention && <span>{inline(` ${block.mention}`, ctx, `${key}-mention`)}</span>}
              </div>
            )
          }
          case 'callout': {
            const hex = block.accent
            return (
              <div key={key} className={`container${hex ? ' accented' : ''}`} style={hex ? ({ '--bar': `#${hex}` } as React.CSSProperties) : undefined}>
                <Markdown text={block.text} ctx={ctx} />
              </div>
            )
          }
          case 'relay':
            return <Relay key={key} lines={block.lines} ctx={ctx} id={key} />
          case 'kv':
            return <KeyValues key={key} block={block} ctx={ctx} id={key} />
          case 'subtext':
            return (
              <div key={key} className="subtext">
                {inline(block.text, ctx, key)}
              </div>
            )
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul'
            return (
              <Tag key={key} start={block.ordered ? block.start : undefined}>
                {block.items.map((item, j) => (
                  // A bullet nested under a numbered item stays a bullet and does not take a number;
                  // numbered items count on from the list's start, per depth.
                  <li
                    key={j}
                    style={{ marginLeft: item.depth * 16, listStyleType: block.ordered && item.n === null ? 'disc' : undefined }}
                    value={block.ordered && item.n !== null ? (item.depth ? 1 : block.start) + siblingsBefore(block.items, j) : undefined}
                  >
                    {inline(item.text, ctx, `${key}-${j}`)}
                  </li>
                ))}
              </Tag>
            )
          }
          case 'status':
            return (
              <div key={key} className="status-rows">
                {block.rows.map((row, j) => (
                  <StatusRow key={j} tone={row.tone} text={row.text} ctx={ctx} id={`${key}-${j}`} />
                ))}
              </div>
            )
          case 'text':
            return (
              <div key={key} className="paragraph">
                {inline(block.text, ctx, key)}
              </div>
            )
        }
      })}
    </div>
  )
})
